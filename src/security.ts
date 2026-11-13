import {
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

export const hmac = (scope: string, value: string) =>
  createHmac("sha256", config.hashPepper).update(`${scope}:${value}`).digest("hex");

export const hashCpf = (cpfDigits: string) => hmac("cpf", cpfDigits);
export const hashPairingCode = (code: string) => hmac("pairing", code);

export const generatePairingCode = () => String(randomInt(100000, 1000000));

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LENGTH = 8;

export const generateInviteCode = () =>
  Array.from({ length: INVITE_CODE_LENGTH }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join("");
export const normalizeInviteCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const isInviteCode = (code: string) => /^[A-HJ-NP-Z2-9]{8}$/.test(code);
export const hashInviteCode = (code: string) => hmac("invite", code);

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
