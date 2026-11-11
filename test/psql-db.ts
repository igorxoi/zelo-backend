/**
 * Db de TESTE: fala com o PostgreSQL pelo `psql` (uma sessão persistente),
 * para rodar os testes onde o driver `pg` não está instalado. Em produção a
 * API usa createPgDb (src/db.ts). Os resultados voltam como JSON; por isso
 * os testes aqui NÃO substituem um teste com o driver `pg` de verdade.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";

import type { Db, Queryable, QueryResult } from "../src/db.js";

const SENTINEL = "__END__";

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    const items = value.map((v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`).join(",");
    return `'{${items.replace(/'/g, "''")}}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function wrap(sql: string): { text: string; rows: boolean } {
  const body = sql.trim().replace(/;+\s*$/, "");
  const head = body.slice(0, 20).toLowerCase();
  const isDml = /^(insert|update|delete)\b/.test(head);
  const withDml = /^with\b/.test(head) && /\b(insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i.test(body);
  const agg = "coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)";

  if (/^select\b/.test(head) || (/^with\b/.test(head) && !withDml)) {
    return { text: `select ${agg} from (${body}) q`, rows: true };
  }
  if (isDml && /\breturning\b/i.test(body)) {
    return { text: `with q as (${body}) select ${agg} from q`, rows: true };
  }
  // WITH com DML (ex.: notify): o código não lê linhas desse tipo de comando.
  return { text: body, rows: false };
}

export class PsqlDb implements Db {
  private proc: ChildProcessWithoutNullStreams;
  private out = "";
  private err = "";
  private waiting: (() => void) | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(database: string) {
    // Conexão pelas variáveis padrão do PostgreSQL (PGHOST, PGUSER, PGPORT, PGPASSWORD).
    this.proc = spawn("psql", ["-d", database, "-X", "-A", "-t", "-q"]);
    this.proc.stdout.on("data", (chunk) => this.onData("out", chunk.toString()));
    this.proc.stderr.on("data", (chunk) => this.onData("err", chunk.toString()));
    this.proc.stdin.write("\\set VERBOSITY verbose\n");
  }

  private onData(stream: "out" | "err", text: string) {
    if (stream === "out") this.out += text;
    else this.err += text;
    if (this.out.includes(SENTINEL + "\n") && this.err.includes(SENTINEL + "\n")) this.waiting?.();
  }

  private run(text: string): Promise<{ out: string; err: string }> {
    return new Promise((resolve) => {
      this.out = "";
      this.err = "";
      this.waiting = () => {
        this.waiting = null;
        resolve({ out: this.out.replace(SENTINEL + "\n", ""), err: this.err.replace(SENTINEL + "\n", "") });
      };
      this.proc.stdin.write(`${text};\n\\echo ${SENTINEL}\n\\warn ${SENTINEL}\n`);
    });
  }

  /** Executa direto na sessão (sem pegar o lock; quem chama já cuida disso). */
  private async raw<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    // PGTEST_SQL_LOG: grava o SQL original (com $n) para conferir a inferência de tipos com PREPARE.
    if (process.env.PGTEST_SQL_LOG) appendFileSync(process.env.PGTEST_SQL_LOG, JSON.stringify(sql) + "\n");
    const filled = sql.replace(/\$(\d+)/g, (_, n) => literal(params[Number(n) - 1]));
    const { text, rows } = wrap(filled);
    const { out, err } = await this.run(text);

    const error = /ERROR:\s+(\w{5}):\s+(.*)/.exec(err);
    if (error) {
      const e = new Error(error[2]) as Error & { code?: string; constraint?: string };
      e.code = error[1];
      e.constraint = /constraint "([^"]+)"/.exec(err)?.[1];
      throw e;
    }
    if (!rows) return { rows: [], rowCount: 0 };
    const parsed = JSON.parse(out.trim()) as T[];
    return { rows: parsed, rowCount: parsed.length };
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  query<T = any>(text: string, params?: unknown[]) {
    return this.locked(() => this.raw<T>(text, params));
  }

  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.locked(async () => {
      const q: Queryable = { query: (text, params) => this.raw(text, params) };
      await this.raw("begin");
      try {
        const result = await fn(q);
        await this.raw("commit");
        return result;
      } catch (error) {
        await this.raw("rollback");
        throw error;
      }
    });
  }

  async close() {
    this.proc.stdin.end("\\q\n");
  }
}
