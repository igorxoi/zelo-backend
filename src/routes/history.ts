import { z } from "zod";

import { config } from "../config.js";
import type { Db } from "../db.js";
import { assertUuid, requireLink } from "../domain/access.js";
import { refreshDoses } from "../domain/doses.js";
import { HttpError, type Router } from "../http.js";

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use AAAA-MM-DD");

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  taken: "Tomou",
  taken_late: "Tomou com atraso",
  missed: "Não tomou",
  skipped: "Não tomou",
};

const SKIP_REASON_LABEL: Record<string, string> = {
  feelingUnwell: "Estou passando mal",
  ranOut: "O remédio acabou",
  notNow: "Prefiro não tomar agora",
  other: "Outro motivo",
  noAnswer: "Sem resposta",
};

const SYMPTOM_LABEL: Record<string, string> = {
  pain: "dor",
  nausea: "enjoo",
  dizziness: "tontura",
  fatigue: "cansaço",
  shortness_of_breath: "falta de ar",
  other: "outro sintoma",
};

const DOSE_TITLE: Record<string, string> = {
  taken: "tomada",
  taken_late: "tomada com atraso",
  missed: "não tomada",
  skipped: "não tomada",
};

export function historyRoutes(router: Router, db: Db) {
  /**
   * Eventos de um dia (getHistory): doses respondidas + relatos de sintoma,
   * em ordem de horário. O filtro de medicamento esconde os relatos
   * (sintoma não pertence a um medicamento). Dia calculado no fuso do app.
   */
  router.get("/patients/:id/history", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    const date = dateParam.parse(ctx.query.get("date"));
    const medicationId = ctx.query.get("medicationId");
    if (medicationId) assertUuid(medicationId, "Medicamento não encontrado.");
    if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      throw new HttpError(422, "Data inválida.");
    }

    // Garante que as doses vencidas de hoje já estejam como "missed".
    await refreshDoses(db, [ctx.params.id]);

    const tz = config.timezone;
    const dayStart = "($2::date)::timestamp at time zone $3";
    const dayEnd = "(($2::date) + 1)::timestamp at time zone $3";

    const doses = await db.query(
      `select d.id, d.status::text as status, d.skip_reason, d.note, m.name, m.dosage,
              coalesce(d.taken_at, d.scheduled_at) as occurred_at,
              to_char(d.scheduled_at at time zone $3, 'HH24:MI') as scheduled_hhmm,
              to_char(coalesce(d.taken_at, d.scheduled_at) at time zone $3, 'HH24:MI') as hhmm
       from doses d join medications m on m.id = d.medication_id
       where d.patient_id = $1 and d.status <> 'pending'
         and coalesce(d.taken_at, d.scheduled_at) >= ${dayStart}
         and coalesce(d.taken_at, d.scheduled_at) < ${dayEnd}
         and ($4::uuid is null or d.medication_id = $4::uuid)`,
      [ctx.params.id, date, tz, medicationId],
    );

    const symptoms = medicationId
      ? { rows: [] as any[] }
      : await db.query(
          `select id, kind::text as kind, reported_at as occurred_at,
                  to_char(reported_at at time zone $3, 'HH24:MI') as hhmm
           from symptom_reports
           where patient_id = $1 and reported_at >= ${dayStart} and reported_at < ${dayEnd}`,
          [ctx.params.id, date, tz],
        );

    // Alterações de cada dose ("Alterações" no detalhe do histórico).
    const doseIds = doses.rows.map((d) => d.id);
    const events = doseIds.length
      ? await db.query(
          `select e.dose_id, e.actor_type::text as actor_type, e.from_status::text as from_status,
                  e.to_status::text as to_status, u.name as actor_name, e.created_at,
                  to_char(e.created_at at time zone $2, 'HH24:MI') as hhmm
           from dose_events e left join users u on u.id = e.actor_user_id
           where e.dose_id = any($1::uuid[]) order by e.created_at desc`,
          [doseIds, tz],
        )
      : { rows: [] as any[] };

    const items: { at: number; event: Record<string, unknown> }[] = [];

    for (const d of doses.rows) {
      // A resposta normal do paciente (pendente → tomou/não tomou) não é "alteração".
      const changes = events.rows
        .filter((e) => e.dose_id === d.id && !(e.actor_type === "patient" && e.from_status === "pending"))
        .map((e) => ({
          at: new Date(e.created_at).getTime(),
          time: e.hhmm as string,
          text:
            e.actor_type === "system"
              ? `o app marcou como ${STATUS_LABEL[e.to_status]}, sem confirmação.`
              : `${e.actor_type === "caregiver" ? e.actor_name : "O paciente"} mudou de ${STATUS_LABEL[e.from_status]} para ${STATUS_LABEL[e.to_status]}.`,
          by: e.actor_type === "caregiver" ? (e.actor_name as string) : null,
        }));

      const isNotTaken = d.status === "missed" || d.status === "skipped";
      const lastCaregiver = changes.find((c) => c.by);

      items.push({
        at: new Date(d.occurred_at).getTime(),
        event: {
          id: d.id,
          time: d.hhmm,
          scheduledTime: d.scheduled_hhmm,
          title: `${d.name} ${d.dosage} ${DOSE_TITLE[d.status]}`,
          description: d.note ?? "",
          tag: "Medicamento",
          variant: "medication",
          ...(lastCaregiver ? { lastChangedBy: lastCaregiver.by } : {}),
          ...(changes.length
            ? { changes: changes.map(({ time, text }) => ({ time, text })) }
            : {}),
          // O app mostra "Situação: Não tomou" + motivo quando esse campo existe.
          ...(isNotTaken
            ? {
                skipReason:
                  d.status === "skipped"
                    ? (SKIP_REASON_LABEL[d.skip_reason] ?? "Outro motivo")
                    : "Sem confirmação",
              }
            : {}),
        },
      });
    }

    for (const s of symptoms.rows) {
      items.push({
        at: new Date(s.occurred_at).getTime(),
        event: {
          id: s.id,
          time: s.hhmm,
          title: `Relato de ${SYMPTOM_LABEL[s.kind]}`,
          description: "Relatado pelo paciente",
          tag: "Anormalidade",
          variant: "abnormality",
        },
      });
    }

    return items.sort((a, b) => a.at - b.at).map((i) => i.event);
  });

  /**
   * Medicamentos que tiveram doses no mês (getHistoryMedications).
   * `month` vai de 0 a 11, como no JavaScript.
   */
  router.get("/patients/:id/history/medications", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    const { month, year } = z
      .object({
        month: z.coerce.number().int().min(0).max(11),
        year: z.coerce.number().int().min(2000).max(2100),
      })
      .parse({ month: ctx.query.get("month"), year: ctx.query.get("year") });

    const { rows } = await db.query(
      `select distinct m.id, m.name, m.dosage
       from doses d join medications m on m.id = d.medication_id
       where d.patient_id = $1 and d.status <> 'pending'
         and coalesce(d.taken_at, d.scheduled_at) >= make_date($2::int, $3::int + 1, 1)::timestamp at time zone $4
         and coalesce(d.taken_at, d.scheduled_at) <  (make_date($2::int, $3::int + 1, 1) + interval '1 month')::timestamp at time zone $4
       order by m.name`,
      [ctx.params.id, year, month, config.timezone],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, dosage: r.dosage }));
  });
}
