// Lê o arquivo .env quando ele existe (desenvolvimento local). Em hospedagem
// (Render, Railway...) as variáveis já vêm do painel e o arquivo não existe.
try {
  process.loadEnvFile();
} catch {
  // sem .env: segue só com as variáveis do ambiente
}

/**
 * Configuração lida das variáveis de ambiente (veja o .env.example).
 * Os segredos são obrigatórios: sem eles a API não sobe.
 */
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
  /** Tempo de vida do token de login. */
  caregiverTokenDays: number("CAREGIVER_TOKEN_DAYS", 7),
  patientTokenDays: number("PATIENT_TOKEN_DAYS", 90),
  /** Até quantos minutos depois do horário a dose ainda conta como "no horário". */
  doseOnTimeMinutes: number("DOSE_ON_TIME_MINUTES", 15),
  /** Depois de quantos minutos sem confirmação a dose vira "missed". */
  doseMissedAfterMinutes: number("DOSE_MISSED_AFTER_MINUTES", 30),
  /** O paciente vê a dose a partir de quantos minutos antes do horário. */
  patientDoseWindowMinutes: number("PATIENT_DOSE_WINDOW_MINUTES", 60),
  inviteValidDays: 7,
  pairingCodeValidHours: 24,
} as const;
