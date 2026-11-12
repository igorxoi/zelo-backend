import type { Db } from "../db.js";
import { toIso } from "../db.js";
import { refreshDoses } from "../domain/doses.js";
import { assertUuid } from "../domain/access.js";
import { HttpError, noContent, type Router } from "../http.js";

const TYPE_TO_APP = { missed_dose: "missedDose", symptom: "symptom" } as const;

export function caregiverAppRoutes(router: Router, db: Db) {
  router.get("/notifications", { role: "caregiver" }, async (ctx) => {
    const mine = await db.query<{ patient_id: string }>(
      "select patient_id from patient_caregivers where user_id = $1",
      [ctx.auth.id],
    );
    await refreshDoses(db, mine.rows.map((r) => r.patient_id));

    const { rows } = await db.query(
      `select n.id, n.type::text as type, n.title, n.message, n.created_at,
              p.full_name as patient_name, (r.read_at is not null) as read
       from notification_recipients r
       join notifications n on n.id = r.notification_id
       join patients p on p.id = n.patient_id
       where r.user_id = $1
       order by n.created_at desc, n.id limit 100`,
      [ctx.auth.id],
    );
    return rows.map((r) => ({
      id: r.id,
      type: TYPE_TO_APP[r.type as keyof typeof TYPE_TO_APP],
      title: r.title,
      message: r.message,
      patientName: r.patient_name,
      createdAt: toIso(r.created_at),
      read: r.read === true || r.read === "t",
    }));
  });

  router.post("/notifications/:id/read", { role: "caregiver" }, async (ctx) => {
    assertUuid(ctx.params.id, "Notificação não encontrada.");
    const { rows } = await db.query(
      `update notification_recipients set read_at = coalesce(read_at, now())
       where notification_id = $1 and user_id = $2 returning notification_id`,
      [ctx.params.id, ctx.auth.id],
    );
    if (rows.length === 0) throw new HttpError(404, "Notificação não encontrada.");
    return noContent();
  });

  router.post("/notifications/read-all", { role: "caregiver" }, async (ctx) => {
    await db.query(
      "update notification_recipients set read_at = now() where user_id = $1 and read_at is null",
      [ctx.auth.id],
    );
    return noContent();
  });

  router.get("/profile", { role: "caregiver" }, async (ctx) => {
    const { rows } = await db.query(
      `select u.id, u.name, u.email, u.phone,
              exists (select 1 from patient_caregivers pc where pc.user_id = u.id and pc.is_master) as is_master
       from users u where u.id = $1`,
      [ctx.auth.id],
    );
    const u = rows[0];
    const isMaster = u.is_master === true || u.is_master === "t";
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone ?? "",
      roleLabel: isMaster ? "Cuidador master" : "Cuidador",
      isMaster,
    };
  });
}
