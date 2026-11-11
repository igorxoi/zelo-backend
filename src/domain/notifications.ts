import type { Queryable } from "../db.js";

export type NewNotification = {
  patientId: string;
  type: "missed_dose" | "symptom";
  title: string;
  message: string;
  doseId?: string;
  symptomReportId?: string;
};

/**
 * Cria a notificação e entrega para todos os cuidadores do paciente
 * (cada um com o seu "lida"). Repetir a mesma dose/relato não duplica.
 */
export async function notify(q: Queryable, n: NewNotification) {
  await q.query(
    `with n as (
       insert into notifications (patient_id, type, title, message, dose_id, symptom_report_id)
       values ($1, $2::notification_type, $3, $4, $5, $6)
       on conflict do nothing
       returning id
     )
     insert into notification_recipients (notification_id, user_id)
     select n.id, pc.user_id from n, patient_caregivers pc where pc.patient_id = $1`,
    [n.patientId, n.type, n.title, n.message, n.doseId ?? null, n.symptomReportId ?? null],
  );
}
