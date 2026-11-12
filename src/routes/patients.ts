import { z } from "zod";

import { config } from "../config.js";
import { isValidCpf, onlyDigits } from "../cpf.js";
import { isUniqueViolation, type Db, type Queryable } from "../db.js";
import { assertUuid, requireLink, requireMaster } from "../domain/access.js";
import { created, HttpError, noContent, type Router } from "../http.js";
import {
  generateInviteToken,
  generatePairingCode,
  hashCpf,
  hashInviteToken,
  hashPairingCode,
} from "../security.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "use AAAA-MM-DD")
  .transform((v) => v.slice(0, 10))
  .refine((v) => {
    const date = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(v);
  }, "data inválida")
  .refine((v) => v <= new Date().toISOString().slice(0, 10), "a data não pode ser futura")
  .refine((v) => v >= "1900-01-01", "data muito antiga");

const createPatientSchema = z.object({
  fullName: z.string().trim().min(2, "mínimo 2 letras").max(120),
  nickname: z.string().trim().max(60).default(""),
  birthDate: isoDate,
  cpf: z.string().transform(onlyDigits).refine(isValidCpf, "CPF inválido"),
  authorizationConfirmed: z.boolean().optional(),
});

const updatePatientSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  nickname: z.string().trim().max(60).default(""),
  birthDate: isoDate,
});

const inviteSchema = z.object({
  name: z.string().trim().min(2, "mínimo 2 letras").max(120),
  email: z.string().trim().toLowerCase().email("e-mail inválido").max(254),
});

const daysLeft = (expiresAt: Date | string) =>
  Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000));

const inviteLink = (token: string) => `${config.publicUrl}/convite/${token}`;

async function issuePairingCode(q: Queryable, patientId: string, userId: string) {
  await q.query(
    `update patient_pairing_codes set revoked_at = now()
     where patient_id = $1 and used_at is null and revoked_at is null`,
    [patientId],
  );

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePairingCode();
    try {
      await q.query("savepoint pairing_code");
      const { rows } = await q.query<{ expires_at: Date }>(
        `insert into patient_pairing_codes (patient_id, code_hash, created_by, expires_at)
         values ($1, $2, $3, now() + make_interval(hours => $4::int))
         returning expires_at`,
        [patientId, hashPairingCode(code), userId, config.pairingCodeValidHours],
      );
      return { code, expiresAt: new Date(rows[0].expires_at).toISOString() };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await q.query("rollback to savepoint pairing_code");
    }
  }
  throw new HttpError(503, "Não foi possível gerar o código. Tente novamente.");
}

export function patientRoutes(router: Router, db: Db) {
  router.get("/patients", { role: "caregiver" }, async (ctx) => {
    const { rows } = await db.query(
      `select p.id, p.full_name, pc.relationship, pc.is_master
       from patient_caregivers pc join patients p on p.id = pc.patient_id
       where pc.user_id = $1 order by pc.created_at, p.full_name`,
      [ctx.auth.id],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.full_name,
      ...(r.relationship ? { relationship: r.relationship } : {}),
      isMaster: r.is_master,
    }));
  });

  router.post("/patients", { role: "caregiver" }, async (ctx) => {
    const data = createPatientSchema.parse(ctx.body);
    if (data.authorizationConfirmed === false) {
      throw new HttpError(422, "Confirme que você tem autorização para cadastrar este paciente.");
    }

    try {
      return created(
        await db.tx(async (q) => {
          const { rows } = await q.query<{ id: string }>(
            `insert into patients (full_name, nickname, birth_date, cpf_hash, created_by)
             values ($1, $2, $3, $4, $5) returning id`,
            [data.fullName, data.nickname, data.birthDate, hashCpf(data.cpf), ctx.auth.id],
          );
          const patientId = rows[0].id;
          await q.query(
            "insert into patient_caregivers (patient_id, user_id, is_master) values ($1, $2, true)",
            [patientId, ctx.auth.id],
          );
          const pairing = await issuePairingCode(q, patientId, ctx.auth.id);
          return {
            patient: { id: patientId, name: data.fullName, isMaster: true },
            pairingCode: pairing.code,
            pairingCodeExpiresAt: pairing.expiresAt,
          };
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error, "patients_cpf_hash_key")) {
        throw new HttpError(409, "Já existe um paciente cadastrado com este CPF.");
      }
      throw error;
    }
  });

  router.get("/patients/:id", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    return getPatientDetails(db, ctx.params.id, ctx.auth.id);
  });

  router.patch("/patients/:id", { role: "caregiver" }, async (ctx) => {
    await requireMaster(db, ctx.auth.id, ctx.params.id);
    const data = updatePatientSchema.parse(ctx.body);
    await db.query(
      "update patients set full_name = $2, nickname = $3, birth_date = $4 where id = $1",
      [ctx.params.id, data.fullName, data.nickname, data.birthDate],
    );
    return getPatientDetails(db, ctx.params.id, ctx.auth.id);
  });

  router.delete("/patients/:id", { role: "caregiver" }, async (ctx) => {
    await requireMaster(db, ctx.auth.id, ctx.params.id);
    await db.query("delete from patients where id = $1", [ctx.params.id]);
    return noContent();
  });

  router.post("/patients/:id/pairing-codes", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    const pairing = await db.tx((q) => issuePairingCode(q, ctx.params.id, ctx.auth.id));
    return created({ pairingCode: pairing.code, pairingCodeExpiresAt: pairing.expiresAt });
  });

  router.post("/patients/:id/invites", { role: "caregiver" }, async (ctx) => {
    await requireMaster(db, ctx.auth.id, ctx.params.id);
    const { name, email } = inviteSchema.parse(ctx.body);

    const already = await db.query(
      `select 1 from patient_caregivers pc join users u on u.id = pc.user_id
       where pc.patient_id = $1 and lower(u.email) = $2`,
      [ctx.params.id, email],
    );
    if (already.rows.length > 0) {
      throw new HttpError(409, "Esta pessoa já cuida deste paciente.");
    }

    const token = generateInviteToken();
    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into caregiver_invites (patient_id, invited_by, name, email, token_hash, expires_at)
         values ($1, $2, $3, $4, $5, now() + make_interval(days => $6::int)) returning id`,
        [ctx.params.id, ctx.auth.id, name, email, hashInviteToken(token), config.inviteValidDays],
      );
      return created({
        caregiver: {
          id: rows[0].id,
          name,
          email,
          status: "pending",
          inviteExpiresInDays: config.inviteValidDays,
        },
        link: inviteLink(token),
      });
    } catch (error) {
      if (isUniqueViolation(error, "one_pending_invite_per_email")) {
        throw new HttpError(409, "Já existe um convite pendente para este e-mail.");
      }
      throw error;
    }
  });

  router.post("/patients/:id/invites/:inviteId/resend", { role: "caregiver" }, async (ctx) => {
    await requireMaster(db, ctx.auth.id, ctx.params.id);
    assertUuid(ctx.params.inviteId, "Convite não encontrado.");

    const token = generateInviteToken();
    const { rows } = await db.query<{ id: string; name: string; email: string }>(
      `update caregiver_invites
       set token_hash = $3, expires_at = now() + make_interval(days => $4::int), last_sent_at = now()
       where id = $2 and patient_id = $1 and status = 'pending'
       returning id, name, email`,
      [ctx.params.id, ctx.params.inviteId, hashInviteToken(token), config.inviteValidDays],
    );
    if (rows.length === 0) throw new HttpError(404, "Convite não encontrado.");

    return {
      caregiver: {
        id: rows[0].id,
        name: rows[0].name,
        email: rows[0].email,
        status: "pending",
        inviteExpiresInDays: config.inviteValidDays,
      },
      link: inviteLink(token),
    };
  });

  router.delete("/patients/:id/invites/:inviteId", { role: "caregiver" }, async (ctx) => {
    await requireMaster(db, ctx.auth.id, ctx.params.id);
    assertUuid(ctx.params.inviteId, "Convite não encontrado.");
    const { rows } = await db.query(
      `update caregiver_invites set status = 'canceled'
       where id = $2 and patient_id = $1 and status = 'pending' returning id`,
      [ctx.params.id, ctx.params.inviteId],
    );
    if (rows.length === 0) throw new HttpError(404, "Convite não encontrado.");
    return noContent();
  });

  router.get("/invites/:token", {}, async (ctx) => {
    const { rows } = await db.query(
      `select i.name, i.email, i.expires_at, p.nickname, p.full_name, u.name as invited_by
       from caregiver_invites i
       join patients p on p.id = i.patient_id
       join users u on u.id = i.invited_by
       where i.token_hash = $1 and i.status = 'pending'`,
      [hashInviteToken(ctx.params.token)],
    );
    const invite = rows[0];
    if (!invite || new Date(invite.expires_at) < new Date()) {
      throw new HttpError(410, "Este convite expirou ou foi cancelado.");
    }
    return {
      caregiverName: invite.name,
      email: invite.email,
      invitedBy: invite.invited_by,
      patientName: invite.nickname || invite.full_name.split(" ")[0],
    };
  });

  router.post("/invites/:token/accept", { role: "caregiver" }, async (ctx) => {
    return db.tx(async (q) => {
      const { rows } = await q.query(
        `select i.id, i.patient_id, i.email, i.expires_at, p.full_name
         from caregiver_invites i join patients p on p.id = i.patient_id
         where i.token_hash = $1 and i.status = 'pending' for update of i`,
        [hashInviteToken(ctx.params.token)],
      );
      const invite = rows[0];
      if (!invite || new Date(invite.expires_at) < new Date()) {
        throw new HttpError(410, "Este convite expirou ou foi cancelado.");
      }

      const me = await q.query<{ email: string }>("select email from users where id = $1", [ctx.auth.id]);
      if (me.rows[0]?.email.toLowerCase() !== String(invite.email).toLowerCase()) {
        throw new HttpError(403, "Este convite foi enviado para outro e-mail.");
      }

      await q.query(
        `insert into patient_caregivers (patient_id, user_id) values ($1, $2)
         on conflict do nothing`,
        [invite.patient_id, ctx.auth.id],
      );
      await q.query(
        "update caregiver_invites set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1",
        [invite.id, ctx.auth.id],
      );
      return { id: invite.patient_id, name: invite.full_name, isMaster: false };
    });
  });
}

async function getPatientDetails(q: Queryable, patientId: string, userId: string) {
  const patient = await q.query(
    `select p.id, p.full_name, p.nickname, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date,
            pc.relationship
     from patients p join patient_caregivers pc on pc.patient_id = p.id and pc.user_id = $2
     where p.id = $1`,
    [patientId, userId],
  );
  if (patient.rows.length === 0) throw new HttpError(404, "Paciente não encontrado.");

  const active = await q.query(
    `select u.id, u.name, u.email, u.phone, pc.is_master
     from patient_caregivers pc join users u on u.id = pc.user_id
     where pc.patient_id = $1 order by pc.is_master desc, pc.created_at`,
    [patientId],
  );
  const pending = await q.query(
    `select id, name, email, expires_at from caregiver_invites
     where patient_id = $1 and status = 'pending' order by created_at`,
    [patientId],
  );

  const p = patient.rows[0];
  return {
    id: p.id,
    name: p.full_name,
    ...(p.relationship ? { relationship: p.relationship } : {}),
    nickname: p.nickname,
    birthDate: p.birth_date,
    caregivers: [
      ...active.rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        ...(c.phone ? { phone: c.phone } : {}),
        status: "active" as const,
        isMaster: c.is_master,
      })),
      ...pending.rows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        status: "pending" as const,
        inviteExpiresInDays: daysLeft(c.expires_at),
      })),
    ],
  };
}
