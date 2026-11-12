import { config } from "../config.js";
import type { Db, Queryable } from "../db.js";
import { notify } from "./notifications.js";

export async function generateTodayDoses(q: Queryable, patientIds?: string[]) {
  await q.query(
    `insert into doses (patient_id, medication_id, scheduled_at)
     select m.patient_id, m.id,
            (((now() at time zone $1)::date + t.time_of_day) at time zone $1)
     from medications m
     join medication_schedule_times t on t.medication_id = m.id
     where m.ended_at is null
       and ($2::uuid[] is null or m.patient_id = any($2::uuid[]))
       and m.start_date <= (now() at time zone $1)::date
       and (m.end_date is null or m.end_date >= (now() at time zone $1)::date)
       and (m.schedule_type <> 'weekdays'
            or extract(isodow from (now() at time zone $1)::date)::int = any(m.weekdays))
       and (((now() at time zone $1)::date + t.time_of_day) at time zone $1) >= m.created_at
     on conflict (medication_id, scheduled_at) do nothing`,
    [config.timezone, patientIds ?? null],
  );
}

export async function sweepMissedDoses(db: Db, patientIds?: string[]): Promise<number> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{
      id: string;
      patient_id: string;
      name: string;
      dosage: string;
      hhmm: string;
    }>(
      `update doses d set status = 'missed'
       from medications m
       where m.id = d.medication_id
         and d.status = 'pending'
         and d.scheduled_at + make_interval(mins => $1::int) <= now()
         and ($2::uuid[] is null or d.patient_id = any($2::uuid[]))
       returning d.id, d.patient_id, m.name, m.dosage,
                 to_char(d.scheduled_at at time zone $3, 'HH24:MI') as hhmm`,
      [config.doseMissedAfterMinutes, patientIds ?? null, config.timezone],
    );

    for (const dose of rows) {
      await q.query(
        `insert into dose_events (dose_id, actor_type, from_status, to_status)
         values ($1, 'system', 'pending', 'missed')`,
        [dose.id],
      );
      await notify(q, {
        patientId: dose.patient_id,
        type: "missed_dose",
        title: "Dose não confirmada",
        message: `${dose.name} ${dose.dosage} deveria ter sido tomado às ${dose.hhmm}`,
        doseId: dose.id,
      });
    }
    return rows.length;
  });
}

export async function refreshDoses(db: Db, patientIds?: string[]) {
  if (patientIds && patientIds.length === 0) return;
  await generateTodayDoses(db, patientIds);
  await sweepMissedDoses(db, patientIds);
}
