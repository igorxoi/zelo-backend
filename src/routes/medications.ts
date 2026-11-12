import { z } from "zod";

import type { Db } from "../db.js";
import { assertUuid, requireLink } from "../domain/access.js";
import { created, HttpError, noContent, type Router } from "../http.js";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];

// Segunda = 1 ... domingo = 7 (ISO), como no banco.
const weekdayToNumber = (day: Weekday) => WEEKDAYS.indexOf(day) + 1;
const numberToWeekday = (n: number) => WEEKDAYS[n - 1];

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:mm");

/** Mesmas quatro frequências do formulário do app (MedicationSchedule). */
const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("interval"),
    everyHours: z.number().int().min(1).max(24),
    startTime: time,
  }),
  z.object({ type: z.literal("daily"), time }),
  z.object({
    type: z.literal("weekdays"),
    days: z.array(z.enum(WEEKDAYS)).min(1, "escolha ao menos um dia").max(7),
    time,
  }),
  z.object({ type: z.literal("custom"), times: z.array(time).min(1).max(12) }),
]);
type Schedule = z.infer<typeof scheduleSchema>;

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "use AAAA-MM-DD")
  .transform((v) => v.slice(0, 10))
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), "data inválida");

const createSchema = z
  .object({
    name: z.string().trim().min(1, "informe o nome").max(120),
    dosage: z.string().trim().min(1, "informe a dosagem").max(60),
    schedule: scheduleSchema,
    startDate: dateOnly,
    endDate: dateOnly.nullable().default(null), // null = uso contínuo
    notes: z.string().trim().max(500).default(""),
  })
  .refine((v) => v.endDate === null || v.endDate >= v.startDate, {
    message: "o término não pode ser antes do início",
    path: ["endDate"],
  });

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Horários das doses de cada frequência (igual a getScheduleTimes do app).
 * Intervalo fixo: floor(24 / everyHours) doses por dia a partir do horário inicial.
 */
export function getScheduleTimes(schedule: Schedule): string[] {
  switch (schedule.type) {
    case "interval": {
      const [hour, minute] = schedule.startTime.split(":").map(Number);
      const doses = Math.floor(24 / schedule.everyHours);
      return Array.from(
        { length: doses },
        (_, i) => `${pad((hour + i * schedule.everyHours) % 24)}:${pad(minute)}`,
      ).sort();
    }
    case "daily":
    case "weekdays":
      return [schedule.time];
    case "custom":
      return [...new Set(schedule.times)].sort();
  }
}

type Row = {
  id: string;
  patient_id: string;
  name: string;
  dosage: string;
  schedule_type: Schedule["type"];
  interval_hours: number | null;
  interval_start: string | null;
  weekdays: number[] | null;
  times: string[];
  start_date: string;
  end_date: string | null;
  notes: string;
};

const SELECT = `
  select m.id, m.patient_id, m.name, m.dosage, m.schedule_type, m.interval_hours::int as interval_hours,
         to_char(m.interval_start_time, 'HH24:MI') as interval_start, m.weekdays::int[] as weekdays,
         to_char(m.start_date, 'YYYY-MM-DD') as start_date, to_char(m.end_date, 'YYYY-MM-DD') as end_date,
         m.notes,
         array(select to_char(t.time_of_day, 'HH24:MI') from medication_schedule_times t
               where t.medication_id = m.id order by t.time_of_day) as times
  from medications m`;

/** Monta o Medication do app a partir da linha do banco. */
function toMedication(r: Row) {
  const times = r.times;
  let schedule: Schedule;
  switch (r.schedule_type) {
    case "interval":
      schedule = { type: "interval", everyHours: r.interval_hours!, startTime: r.interval_start! };
      break;
    case "daily":
      schedule = { type: "daily", time: times[0] };
      break;
    case "weekdays":
      schedule = { type: "weekdays", days: (r.weekdays ?? []).map(numberToWeekday), time: times[0] };
      break;
    default:
      schedule = { type: "custom", times };
  }
  return {
    id: r.id,
    patientId: r.patient_id,
    name: r.name,
    dosage: r.dosage,
    schedule,
    times,
    startDate: r.start_date,
    endDate: r.end_date,
    notes: r.notes,
  };
}

export function medicationRoutes(router: Router, db: Db) {
  /** Medicamentos ativos do paciente (getMedications). */
  router.get("/patients/:id/medications", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    const { rows } = await db.query<Row>(
      `${SELECT} where m.patient_id = $1 and m.ended_at is null order by m.created_at desc`,
      [ctx.params.id],
    );
    return rows.map(toMedication);
  });

  /**
   * Cadastra o medicamento (createMedication). Os horários são calculados aqui
   * e as doses de cada dia nascem a partir deles (domain/doses.ts).
   */
  router.post("/patients/:id/medications", { role: "caregiver" }, async (ctx) => {
    await requireLink(db, ctx.auth.id, ctx.params.id);
    const data = createSchema.parse(ctx.body);
    const { schedule } = data;
    const times = getScheduleTimes(schedule);

    const id = await db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into medications
           (patient_id, name, dosage, schedule_type, interval_hours, interval_start_time, weekdays,
            start_date, end_date, notes, created_by)
         values ($1, $2, $3, $4::schedule_type, $5, $6, $7::smallint[], $8, $9, $10, $11)
         returning id`,
        [
          ctx.params.id,
          data.name,
          data.dosage,
          schedule.type,
          schedule.type === "interval" ? schedule.everyHours : null,
          schedule.type === "interval" ? schedule.startTime : null,
          schedule.type === "weekdays" ? [...new Set(schedule.days.map(weekdayToNumber))] : null,
          data.startDate,
          data.endDate,
          data.notes,
          ctx.auth.id,
        ],
      );
      for (const t of times) {
        await q.query(
          "insert into medication_schedule_times (medication_id, time_of_day) values ($1, $2)",
          [rows[0].id, t],
        );
      }
      return rows[0].id;
    });

    const { rows } = await db.query<Row>(`${SELECT} where m.id = $1`, [id]);
    return created(toMedication(rows[0]));
  });

  /**
   * Encerra o medicamento (endMedication): sai da lista e para de gerar doses,
   * mas o que já foi registrado continua no histórico.
   */
  router.delete("/medications/:id", { role: "caregiver" }, async (ctx) => {
    assertUuid(ctx.params.id, "Medicamento não encontrado.");
    const found = await db.query<{ patient_id: string }>(
      "select patient_id from medications where id = $1 and ended_at is null",
      [ctx.params.id],
    );
    if (found.rows.length === 0) throw new HttpError(404, "Medicamento não encontrado.");
    await requireLink(db, ctx.auth.id, found.rows[0].patient_id);

    await db.tx(async (q) => {
      await q.query("update medications set ended_at = now(), ended_by = $2 where id = $1", [
        ctx.params.id,
        ctx.auth.id,
      ]);
      // Doses que ainda esperavam resposta somem; as já respondidas ficam.
      await q.query("delete from doses where medication_id = $1 and status = 'pending'", [ctx.params.id]);
    });
    return noContent();
  });
}
