/**
 * B2 - node-postgres driver behind the same `Db` interface as PGlite, selected
 * when DATABASE_URL is set (Render). Same SQL + pgvector, so no app query
 * changes. Uses a single pooled client per logical connection so that
 * ScopedDb's `SET LOCAL search_path` (inside a transaction) pins to one
 * backend connection for the duration of that transaction.
 *
 * NOTE: `pg` is imported lazily so local/dev + tests (PGlite only) never load
 * it. This path is interface-matched + typechecked here; it needs a live
 * Render Postgres smoke test at deploy (no Postgres available in the dev
 * sandbox). Deploy is founder-gated.
 */
import type { Db } from "./tenancy.js";

// Minimal shapes we use from `pg` (kept local so `pg` types are not required
// at build time in the dev sandbox).
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}
interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export class PgDriver implements Db {
  private constructor(private pool: PgPoolLike) {}

  static async connect(databaseUrl: string): Promise<PgDriver> {
    // lazy import so dev/tests never require the `pg` package
    const pgMod = (await import("pg")) as unknown as {
      default?: { Pool: new (cfg: unknown) => PgPoolLike };
      Pool?: new (cfg: unknown) => PgPoolLike;
    };
    const Pool = (pgMod.Pool ?? pgMod.default?.Pool)!;
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    return new PgDriver(pool);
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[], affectedRows: r.rowCount ?? undefined };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // one dedicated backend connection for the whole txn, so SET LOCAL and the
    // scoped queries share the same session (search_path pin holds).
    const tx: Db = {
      query: async <U = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const r = await client.query(sql, params);
        return { rows: r.rows as U[], affectedRows: r.rowCount ?? undefined };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      transaction: (inner) => inner(tx), // already in a txn; reuse it
    };
    try {
      await client.query("BEGIN");
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
