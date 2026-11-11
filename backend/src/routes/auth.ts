import { z } from "zod";

import { isValidCpf, onlyDigits } from "../cpf.js";
import { isUniqueViolation, type Db } from "../db.js";
import { created, HttpError, rateLimit, type Router } from "../http.js";
import {
  hashCpf,
  hashPairingCode,
  hashPassword,
  signToken,
  verifyPassword,
} from "../security.js";

/** Formato que o app espera (AuthUser) + o token da sessão. */
const session = (id: string, name: string, profile: "caregiver" | "patient") => ({
  token: signToken(id, profile),
  user: { id, name, profile },
});

const signInSchema = z.object({
  email: z.string().trim().min(1, "informe o e-mail"),
  password: z.string().min(1, "informe a senha"),
});

const registerSchema = z.object({
  name: z.string().trim().min(2, "mínimo 2 letras").max(120),
  email: z.string().trim().toLowerCase().email("e-mail inválido").max(254),
  phone: z
    .string()
    .transform(onlyDigits)
    .refine((v) => v.length >= 10 && v.length <= 13, "telefone inválido"),
  cpf: z.string().transform(onlyDigits).refine(isValidCpf, "CPF inválido"),
  password: z.string().min(8, "mínimo 8 caracteres").max(200),
});

const patientSignInSchema = z.object({
  code: z.string().transform(onlyDigits).refine((v) => v.length === 6, "o código tem 6 números"),
});

// Hash de uma senha qualquer, usado quando o e-mail não existe: assim o tempo
// de resposta não revela se a conta existe.
let dummyHash: Promise<string> | null = null;

export function authRoutes(router: Router, db: Db) {
  /** Login do cuidador (signInCaregiver). */
  router.post("/auth/caregiver/sign-in", {}, async (ctx) => {
    rateLimit(`sign-in:${ctx.ip}`, 10, 15 * 60 * 1000);
    const { email, password } = signInSchema.parse(ctx.body);

    const { rows } = await db.query<{ id: string; name: string; password_hash: string }>(
      "select id, name, password_hash from users where lower(email) = lower($1)",
      [email],
    );
    const user = rows[0];
    const hash = user?.password_hash ?? (await (dummyHash ??= hashPassword("zelo-dummy-password")));
    const ok = await verifyPassword(password, hash);
    if (!user || !ok) throw new HttpError(401, "E-mail ou senha incorretos.");

    return session(user.id, user.name, "caregiver");
  });

  /** Cadastro do cuidador (registerCaregiver). Já devolve o usuário logado. */
  router.post("/auth/caregiver/register", {}, async (ctx) => {
    rateLimit(`register:${ctx.ip}`, 10, 60 * 60 * 1000);
    const data = registerSchema.parse(ctx.body);
    const passwordHash = await hashPassword(data.password);

    try {
      const { rows } = await db.query<{ id: string }>(
        `insert into users (name, email, phone, cpf_hash, password_hash)
         values ($1, $2, $3, $4, $5) returning id`,
        [data.name, data.email, data.phone, hashCpf(data.cpf), passwordHash],
      );
      return created(session(rows[0].id, data.name, "caregiver"));
    } catch (error) {
      if (isUniqueViolation(error, "users_email_key")) {
        throw new HttpError(409, "Já existe uma conta com este e-mail.");
      }
      if (isUniqueViolation(error)) {
        throw new HttpError(409, "Já existe uma conta com este CPF.");
      }
      throw error;
    }
  });

  /**
   * Login do paciente (signInPatient): só o código de 6 números gerado pelo
   * cuidador. O código vale 24 horas e só pode ser usado uma vez.
   */
  router.post("/auth/patient/sign-in", {}, async (ctx) => {
    rateLimit(`patient-sign-in:${ctx.ip}`, 10, 15 * 60 * 1000);
    const { code } = patientSignInSchema.parse(ctx.body);

    const patient = await db.tx(async (q) => {
      // O update já consome o código: duas pessoas não usam o mesmo.
      const used = await q.query<{ patient_id: string }>(
        `update patient_pairing_codes set used_at = now()
         where code_hash = $1 and used_at is null and revoked_at is null and expires_at > now()
         returning patient_id`,
        [hashPairingCode(code)],
      );
      if (used.rows.length === 0) return null;

      const { rows } = await q.query<{ id: string; full_name: string }>(
        "select id, full_name from patients where id = $1",
        [used.rows[0].patient_id],
      );
      return rows[0] ?? null;
    });

    if (!patient) throw new HttpError(401, "Código inválido ou expirado.");
    return session(patient.id, patient.full_name, "patient");
  });
}
