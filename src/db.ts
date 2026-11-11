/**
 * Acesso ao PostgreSQL. O resto do código só conhece estas interfaces, o
 * driver `pg` fica isolado aqui (e os testes trocam por outra implementação).
 *
 * Atenção ao escrever SQL: o `pg` devolve `date`/`timestamptz` como Date,
 * `bigint`/`count` como string e `time` como "HH:MM:SS". Por isso as queries
 * formatam datas e horários com to_char e fazem cast (::int) nos contadores.
 */
export type QueryResult<T> = { rows: T[]; rowCount: number };

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Executa `fn` numa transação: confirma se terminar bem, desfaz se lançar erro. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Cria o Db em cima do driver `pg` (pool de conexões). */
export async function createPgDb(connectionString: string): Promise<Db> {
  if (!connectionString) throw new Error("Defina DATABASE_URL.");

  // Import dinâmico só para o tipo do módulo ficar isolado neste arquivo.
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

/** Erro de violação de unique (23505). `constraint` filtra pelo nome do índice. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

/** Converte o timestamptz (Date ou string) do driver em ISO 8601. */
export const toIso = (value: unknown): string => new Date(value as string | number | Date).toISOString();
