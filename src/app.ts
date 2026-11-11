import type { Db } from "./db.js";
import { createHandler, Router, type Auth } from "./http.js";
import { authRoutes } from "./routes/auth.js";
import { caregiverAppRoutes } from "./routes/caregiver-app.js";
import { doseRoutes } from "./routes/doses.js";
import { historyRoutes } from "./routes/history.js";
import { medicationRoutes } from "./routes/medications.js";
import { patientAppRoutes } from "./routes/patient-app.js";
import { patientRoutes } from "./routes/patients.js";

/** Monta todas as rotas da API. */
export function createApp(db: Db) {
  const router = new Router();

  router.get("/health", {}, async () => {
    await db.query("select 1");
    return { status: "ok" };
  });

  authRoutes(router, db);
  patientRoutes(router, db);
  medicationRoutes(router, db);
  doseRoutes(router, db);
  historyRoutes(router, db);
  patientAppRoutes(router, db);
  caregiverAppRoutes(router, db);

  const authorize = async (auth: Auth) => {
    const table = auth.role === "caregiver" ? "users" : "patients";
    const { rows } = await db.query(`select 1 from ${table} where id = $1`, [auth.id]);
    return rows.length > 0;
  };

  return createHandler(router, authorize);
}
