import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";

import { config } from "./config.js";
import { verifyToken, type TokenRole } from "./security.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Reply {
  constructor(
    public status: number,
    public body?: unknown,
  ) {}
}
export const created = (body: unknown) => new Reply(201, body);
export const noContent = () => new Reply(204);

export type Auth = { id: string; role: TokenRole };

export type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  auth: Auth;
  ip: string;
};

type Handler = (ctx: Ctx) => Promise<unknown>;
type RouteOptions = { role?: TokenRole };
type Route = {
  method: string;
  regex: RegExp;
  keys: string[];
  role?: TokenRole;
  handler: Handler;
};

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, options: RouteOptions, handler: Handler) {
    const keys: string[] = [];
    const pattern = path.replace(/:([A-Za-z]+)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      regex: new RegExp(`^${pattern}$`),
      keys,
      role: options.role,
      handler,
    });
  }

  get = (path: string, options: RouteOptions, handler: Handler) => this.add("GET", path, options, handler);
  post = (path: string, options: RouteOptions, handler: Handler) => this.add("POST", path, options, handler);
  patch = (path: string, options: RouteOptions, handler: Handler) => this.add("PATCH", path, options, handler);
  delete = (path: string, options: RouteOptions, handler: Handler) => this.add("DELETE", path, options, handler);

  match(method: string, pathname: string) {
    let pathExists = false;
    for (const route of this.routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => (params[key] = decodeURIComponent(found[index + 1])));
      return { route, params };
    }
    return { route: null, params: {}, pathExists };
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: "nome",
  fullName: "nome completo",
  nickname: "apelido",
  email: "e-mail",
  phone: "telefone",
  cpf: "CPF",
  password: "senha",
  birthDate: "data de nascimento",
  code: "código",
  dosage: "dosagem",
  startDate: "início do tratamento",
  endDate: "término do tratamento",
  schedule: "frequência",
  time: "horário",
  times: "horários",
  days: "dias da semana",
  everyHours: "intervalo em horas",
  startTime: "horário inicial",
  notes: "observações",
  reason: "motivo",
  symptom: "sintoma",
  status: "situação",
  date: "data",
  month: "mês",
  year: "ano",
};

const MAX_BODY_BYTES = 100 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Corpo da requisição grande demais.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function createHandler(
  router: Router,
  authorize: (auth: Auth) => Promise<boolean>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204);

      const url = new URL(req.url ?? "/", "http://localhost");
      const { route, params, pathExists } = router.match(req.method ?? "GET", url.pathname) as {
        route: Route | null;
        params: Record<string, string>;
        pathExists?: boolean;
      };
      if (!route) {
        throw new HttpError(pathExists ? 405 : 404, pathExists ? "Método não permitido." : "Rota não encontrada.");
      }

      let auth: Auth | null = null;
      if (route.role) {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        const payload = token ? verifyToken(token) : null;
        if (!payload) throw new HttpError(401, "Sessão expirada. Entre novamente.");
        if (payload.role !== route.role) throw new HttpError(403, "Você não tem acesso a esta ação.");
        auth = { id: payload.sub, role: payload.role };
        if (!(await authorize(auth))) throw new HttpError(401, "Sessão expirada. Entre novamente.");
      }

      const body = ["POST", "PATCH", "PUT"].includes(req.method ?? "") ? await readBody(req) : undefined;
      const result = await route.handler({
        params,
        query: url.searchParams,
        body,
        auth: auth as Auth,
        ip: req.socket.remoteAddress ?? "unknown",
      });

      if (result instanceof Reply) return send(res, result.status, result.body);
      return send(res, 200, result);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { message: error.message });
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        const field = String(issue.path[issue.path.length - 1] ?? "");
        const label = FIELD_LABELS[field];
        return send(res, 422, {
          message: label ? `Confira o campo ${label}: ${issue.message}.` : `Dado inválido: ${issue.message}.`,
          issues: error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        });
      }
      console.error(error);
      return send(res, 500, { message: "Erro interno. Tente novamente em instantes." });
    }
  };
}

const attempts = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > max) {
    throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos e tente de novo.");
  }
}

export const resetRateLimits = () => attempts.clear();
