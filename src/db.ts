export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createPgDb(connectionString: string): Promise<Db> {
  if (!connectionString) throw new Error("Defina DATABASE_URL.");

  const pg: any = await import("pg" as string);
  const Pool = pg.Pool ?? pg.default?.Pool;
  const pool = new Pool({ connectionString, max: 10 });

  return {
    query: (text, params) => pool.query(text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (text, params) => client.query(text, params) });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

export const toIso = (value: unknown): string => new Date(value as string | number | Date).toISOString();
