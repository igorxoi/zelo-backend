import { z } from "zod";

import { config } from "../config.js";
import type { Db } from "../db.js";
import { notify } from "../domain/notifications.js";
import { noContent, type Router } from "../http.js";

/** Valores do app (SymptomType) → valores do banco. */
const SYMPTOMS = {
  pain: { kind: "pain", label: "Dor" },
  nausea: { kind: "nausea", label: "Enjoo" },
  dizziness: { kind: "dizziness", label: "Tontura" },
  fatigue: { kind: "fatigue", label: "Cansaço" },
  shortnessOfBreath: { kind: "shortness_of_breath", label: "Falta de ar" },
  other: { kind: "other", label: "Outro sintoma" },
} as const;

const symptomSchema = z.object({
  symptom: z.enum(Object.keys(SYMPTOMS) as [keyof typeof SYMPTOMS, ...(keyof typeof SYMPTOMS)[]]),
});

/** Rotas do app do paciente que não são de doses (as de doses ficam em doses.ts). */
export function patientAppRoutes(router: Router, db: Db) {
  /**
   * Diário de sintomas (reportSymptom). Cada toque vira um relato no histórico
   * ("Anormalidade") e uma notificação do tipo "symptom" para os cuidadores.
   */
  router.post("/patient/symptoms", { role: "patient" }, async (ctx) => {
    const { symptom } = symptomSchema.parse(ctx.body);
    const { kind, label } = SYMPTOMS[symptom];

    await db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; hhmm: string }>(
        `insert into symptom_reports (patient_id, kind) values ($1, $2::symptom_kind)
         returning id, to_char(reported_at at time zone $3, 'HH24:MI') as hhmm`,
        [ctx.auth.id, kind, config.timezone],
      );
      await notify(q, {
        patientId: ctx.auth.id,
        type: "symptom",
        title: "Relato de sintoma",
        message: `${label} relatado às ${rows[0].hhmm}`,
        symptomReportId: rows[0].id,
      });
    });
    return noContent();
  });

  /**
   * Perfil do paciente logado (getPatientProfile): nome, idade e quem cuida
   * dele (botão "Ligar para ..."). O paciente vem do token, não da URL.
   */
  router.get("/patient/profile", { role: "patient" }, async (ctx) => {
    const patient = await db.query(
      `select id, full_name, nickname,
              date_part('year', age((now() at time zone $2)::date, birth_date))::int as age
       from patients where id = $1`,
      [ctx.auth.id, config.timezone],
    );
    const caregivers = await db.query(
      `select u.id, u.name, u.phone
       from patient_caregivers pc join users u on u.id = pc.user_id
       where pc.patient_id = $1 order by pc.is_master desc, pc.created_at`,
      [ctx.auth.id],
    );
    const p = patient.rows[0];
    return {
      id: p.id,
      name: p.full_name,
      nickname: p.nickname,
      age: p.age,
      caregivers: caregivers.rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? "" })),
    };
  });
}
