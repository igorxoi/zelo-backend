import { z } from "zod";

import { config } from "../config.js";
import type { Db, Queryable } from "../db.js";
import { assertUuid, requireLink } from "../domain/access.js";
import { refreshDoses } from "../domain/doses.js";
import { notify } from "../domain/notifications.js";
import { HttpError, noContent, type Router } from "../http.js";

const SKIP_REASONS = ["feelingUnwell", "ranOut", "notNow", "other", "noAnswer"] as const;

const confirmSchema = z.object({
  status: z.enum(["onTime", "late", "missed"]),
  // "HH:mm" do horário em que tomou; vazio quando o status é "missed".
  time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal("")]).default(""),
  notes: z.string().trim().max(500).default(""),
});

const skipSchema = z.object({ reason: z.enum(SKIP_REASONS) });

type DoseRow = {
  id: string;
  patient_id: string;
  status: "pending" | "taken" | "taken_late" | "missed" | "skipped";
  name: string;
  dosage: string;
  hhmm: string;
};

/** Dose + medicamento, travando a linha para duas respostas não se atropelarem. */
async function lockDose(q: Queryable, doseId: string, where: { patientId?: string }) {
  const { rows } = await q.query<DoseRow>(
    `select d.id, d.patient_id, d.status, m.name, m.dosage,
            to_char(d.scheduled_at at time zone $3, 'HH24:MI') as hhmm
     from doses d join medications m on m.id = d.medication_id
     where d.id = $1 and ($2::uuid is null or d.patient_id = $2::uuid)
     for update of d`,
    [doseId, where.patientId ?? null, config.timezone],
  );
  if (rows.length === 0) throw new HttpError(404, "Dose não encontrada.");
  return rows[0];
}

/** Só doses sem resposta (pendentes ou já marcadas como não tomadas) aceitam resposta. */
function assertOpen(dose: DoseRow) {
  if (dose.status !== "pending" && dose.status !== "missed") {
    throw new HttpError(409, "Esta dose já foi respondida.");
  }
}

/** O cuidador também pode corrigir uma dose que o paciente marcou como "não tomei". */
function assertCaregiverCanEdit(dose: DoseRow) {
  if (dose.status !== "pending" && dose.status !== "missed" && dose.status !== "skipped") {
    throw new HttpError(409, "Esta dose já foi respondida.");
  }
}

export function doseRoutes(router: Router, db: Db) {
  // -------------------------------------------------------------------------
  // Cuidador
  // -------------------------------------------------------------------------

  /**
   * Doses que pedem atenção do cuidador (getMissedDoses), das últimas 24 horas:
   *   - "pending": chegou o horário e o paciente ainda não confirmou;
   *   - "missed": passou do prazo sem resposta;
   *   - "skipped": o paciente marcou "não tomei".
   * Cada uma sai da lista quando um cuidador confirma ou dá como "não tomou".
   * Alimenta o DoseAlert da home. O `id` devolvido é o ID DA DOSE, e é ele
   * que o app deve mandar em confirmDose (campo `medicationId` do payload).
   */
  router.get("/patients/:id/doses/missed", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    await refreshDoses(db, [ctx.params.id]);
    const { rows } = await db.query(
      `select d.id, d.status::text as status, m.name, m.dosage,
              to_char(d.scheduled_at at time zone $2, 'HH24:MI') as hhmm
       from doses d join medications m on m.id = d.medication_id
       where d.patient_id = $1 and d.status in ('pending', 'missed', 'skipped')
         and d.confirmed_by_type is distinct from 'caregiver'
         and d.scheduled_at <= now()
         and d.scheduled_at > now() - interval '24 hours'
       order by d.scheduled_at`,
      [ctx.params.id, config.timezone],
    );
    return rows.map((r) => ({
      id: r.id,
      name: `${r.name} ${r.dosage}`,
      scheduledTime: r.hhmm,
      status: r.status,
    }));
  });

  /**
   * O cuidador confirma uma dose pelo paciente (confirmDose): "tomou no
   * horário", "tomou com atraso" ou "não tomou". Fica registrado no histórico
   * com o nome de quem alterou.
   */
  router.post("/doses/:id/confirm", { role: "caregiver" }, async (ctx) => {
    assertUuid(ctx.params.id, "Dose não encontrada.");
    const data = confirmSchema.parse(ctx.body);

    await db.tx(async (q) => {
      const dose = await lockDose(q, ctx.params.id, {});
      await requireLink(q, ctx.auth.id, dose.patient_id);
      assertCaregiverCanEdit(dose);

      const next = data.status === "onTime" ? "taken" : data.status === "late" ? "taken_late" : "missed";
      if (next === "missed") {
        if (dose.status === "missed" || dose.status === "skipped") {
          // Já está como "não tomada": o cuidador só está dando o alerta como visto.
          // Fica registrado quem viu (confirmed_by_type) e o alerta da home some.
          await q.query(
            `update doses set note = coalesce(nullif($2, ''), note),
                    confirmed_by_type = 'caregiver', confirmed_by_user_id = $3 where id = $1`,
            [dose.id, data.notes, ctx.auth.id],
          );
          return;
        }
        await q.query(
          `update doses set status = 'missed', note = nullif($2, ''),
                  confirmed_by_type = 'caregiver', confirmed_by_user_id = $3 where id = $1`,
          [dose.id, data.notes, ctx.auth.id],
        );
      } else {
        // Horário informado vale para o dia da dose; sem horário, vale agora.
        const taken = await q.query<{ ok: boolean }>(
          `update doses set status = $2::dose_status,
                  taken_at = case when $3 = '' then now()
                                  else ((scheduled_at at time zone $4)::date + nullif($3, '')::time) at time zone $4 end,
                  note = nullif($5, ''), confirmed_by_type = 'caregiver', confirmed_by_user_id = $6,
                  skip_reason = null
           where id = $1
           returning (taken_at <= now() + interval '5 minutes') as ok`,
          [dose.id, next, data.time, config.timezone, data.notes, ctx.auth.id],
        );
        if (!taken.rows[0].ok) {
          throw new HttpError(422, "O horário informado ainda não chegou.");
        }
      }

      await q.query(
        `insert into dose_events (dose_id, actor_type, actor_user_id, from_status, to_status, note)
         values ($1, 'caregiver', $2, $3::dose_status, $4::dose_status, nullif($5, ''))`,
        [dose.id, ctx.auth.id, dose.status, next, data.notes],
      );
    });
    return noContent();
  });

  // -------------------------------------------------------------------------
  // Paciente
  // -------------------------------------------------------------------------

  /**
   * Doses de hoje que o paciente ainda precisa confirmar (getPendingDoses):
   * só as pendentes que já chegaram no horário (mais a janela
   * PATIENT_DOSE_WINDOW_MINUTES, 0 por padrão). Dose que virou "não tomada",
   * ou que o cuidador já confirmou, não volta para o paciente.
   */
  router.get("/patient/doses/pending", { role: "patient" }, async (ctx) => {
    await refreshDoses(db, [ctx.auth.id]);
    const { rows } = await db.query(
      `select d.id, m.name, m.dosage, to_char(d.scheduled_at at time zone $2, 'HH24:MI') as hhmm
       from doses d join medications m on m.id = d.medication_id
       where d.patient_id = $1 and d.status = 'pending'
         and d.scheduled_at >= (((now() at time zone $2)::date)::timestamp at time zone $2)
         and d.scheduled_at <= now() + make_interval(mins => $3::int)
       order by d.scheduled_at, m.name`,
      [ctx.auth.id, config.timezone, config.patientDoseWindowMinutes],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, dosage: r.dosage, scheduledTime: r.hhmm }));
  });

  /**
   * "Tomei" (takeDose). O horário real é o do toque: até 15 min depois do
   * previsto conta como "taken"; depois disso, "taken_late".
   */
  router.post("/patient/doses/:id/take", { role: "patient" }, async (ctx) => {
    assertUuid(ctx.params.id, "Dose não encontrada.");
    return db.tx(async (q) => {
      const dose = await lockDose(q, ctx.params.id, { patientId: ctx.auth.id });
      assertOpen(dose);

      const { rows } = await q.query<{ status: string; hhmm: string }>(
        `update doses set
           status = case when now() <= scheduled_at + make_interval(mins => $2::int)
                         then 'taken'::dose_status else 'taken_late'::dose_status end,
           taken_at = now(), confirmed_by_type = 'patient'
         where id = $1
         returning status::text as status, to_char(now() at time zone $3, 'HH24:MI') as hhmm`,
        [dose.id, config.doseOnTimeMinutes, config.timezone],
      );
      await q.query(
        `insert into dose_events (dose_id, actor_type, from_status, to_status)
         values ($1, 'patient', $2::dose_status, $3::dose_status)`,
        [dose.id, dose.status, rows[0].status],
      );
      return { time: rows[0].hhmm };
    });
  });

  /**
   * "Não tomei" (skipDose), com o motivo. Todo "não tomei" avisa os cuidadores
   * (notificação) e entra no alerta da home.
   */
  router.post("/patient/doses/:id/skip", { role: "patient" }, async (ctx) => {
    assertUuid(ctx.params.id, "Dose não encontrada.");
    const { reason } = skipSchema.parse(ctx.body);

    await db.tx(async (q) => {
      const dose = await lockDose(q, ctx.params.id, { patientId: ctx.auth.id });
      assertOpen(dose);

      await q.query(
        `update doses set status = 'skipped', skip_reason = $2, confirmed_by_type = 'patient' where id = $1`,
        [dose.id, reason],
      );
      await q.query(
        `insert into dose_events (dose_id, actor_type, from_status, to_status)
         values ($1, 'patient', $2::dose_status, 'skipped')`,
        [dose.id, dose.status],
      );

      const what = `${dose.name} ${dose.dosage} das ${dose.hhmm}`;
      if (reason === "feelingUnwell") {
        await notify(q, {
          patientId: dose.patient_id,
          type: "symptom",
          title: "Relato de sintoma",
          message: `Não tomou ${what}: está passando mal`,
          doseId: dose.id,
        });
      } else {
        const why =
          reason === "ranOut"
            ? "o remédio acabou"
            : reason === "notNow"
              ? "preferiu não tomar agora"
              : reason === "noAnswer"
                ? "sem resposta"
                : "outro motivo";
        await notify(q, {
          patientId: dose.patient_id,
          type: "missed_dose",
          title: "Dose não tomada",
          message: `Não tomou ${what}: ${why}`,
          doseId: dose.id,
        });
      }
    });
    return noContent();
  });
}
