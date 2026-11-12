try {
  process.loadEnvFile();
} catch {
}

function required(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minLength) {
    throw new Error(
      `Variável de ambiente ${name} ausente ou curta demais (mínimo ${minLength} caracteres).`,
    );
  }
  return value;
}

const number = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Variável de ambiente ${name} inválida.`);
  }
  return value;
};

export const config = {
  port: number("PORT", 3333),
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwtSecret: required("JWT_SECRET", 32),
  hashPepper: required("HASH_PEPPER", 32),
  timezone: process.env.APP_TIMEZONE ?? "America/Sao_Paulo",
  publicUrl: (
    process.env.PUBLIC_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    `http://localhost:${process.env.PORT ?? 3333}`
  ).replace(/\/$/, ""),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  webAppUrl: (process.env.WEB_APP_URL ?? "").replace(/\/$/, ""),
  caregiverTokenDays: number("CAREGIVER_TOKEN_DAYS", 7),
  patientTokenDays: number("PATIENT_TOKEN_DAYS", 90),
  doseOnTimeMinutes: number("DOSE_ON_TIME_MINUTES", 15),
  doseMissedAfterMinutes: number("DOSE_MISSED_AFTER_MINUTES", 15),
  patientDoseWindowMinutes: number("PATIENT_DOSE_WINDOW_MINUTES", 0),
  inviteValidDays: 7,
  pairingCodeValidHours: 24,
} as const;
