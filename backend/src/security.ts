import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { config } from "./config.js";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Senha (scrypt). Formato guardado: "scrypt$<salt>$<hash>" em base64.
// ---------------------------------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Hash de dados sensíveis (LGPD). HMAC com segredo do servidor: quem vazar o
// banco não consegue testar CPFs ou códigos sem o segredo.
// ---------------------------------------------------------------------------
export const hmac = (scope: string, value: string) =>
  createHmac("sha256", config.hashPepper).update(`${scope}:${value}`).digest("hex");

export const hashCpf = (cpfDigits: string) => hmac("cpf", cpfDigits);
export const hashPairingCode = (code: string) => hmac("pairing", code);

/** Código de pareamento: 6 números. */
export const generatePairingCode = () => String(randomInt(100000, 1000000));

/** Token do link de convite: aleatório (256 bits). No banco vai só o hash. */
export const generateInviteToken = () => randomBytes(32).toString("base64url");
export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

// ---------------------------------------------------------------------------
// JWT HS256 mínimo (sem dependências).
// ---------------------------------------------------------------------------
export type TokenRole = "caregiver" | "patient";
export type TokenPayload = { sub: string; role: TokenRole; exp: number };

const b64 = (input: Buffer | string) => Buffer.from(input).toString("base64url");
const sign = (data: string) => createHmac("sha256", config.jwtSecret).update(data).digest("base64url");

export function signToken(sub: string, role: TokenRole): string {
  const days = role === "caregiver" ? config.caregiverTokenDays : config.patientTokenDays;
  const payload: TokenPayload = {
    sub,
    role,
    exp: Math.floor(Date.now() / 1000) + days * 24 * 60 * 60,
  };
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  const expected = Buffer.from(sign(`${head}.${body}`));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.role !== "caregiver" && payload.role !== "patient") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
