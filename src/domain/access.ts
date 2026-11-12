import type { Queryable } from "../db.js";
import { HttpError } from "../http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, message = "Não encontrado."): string {
  if (!UUID.test(value)) throw new HttpError(404, message);
  return value;
}

export async function requireLink(
  q: Queryable,
  userId: string,
  patientId: string,
): Promise<{ isMaster: boolean }> {
  assertUuid(patientId, "Paciente não encontrado.");
  const { rows } = await q.query<{ is_master: boolean }>(
    "select is_master from patient_caregivers where patient_id = $1 and user_id = $2",
    [patientId, userId],
  );
  if (rows.length === 0) throw new HttpError(404, "Paciente não encontrado.");
  return { isMaster: rows[0].is_master };
}

export async function requireMaster(q: Queryable, userId: string, patientId: string) {
  const link = await requireLink(q, userId, patientId);
  if (!link.isMaster) {
    throw new HttpError(403, "Só o cuidador master pode fazer isso.");
  }
}
