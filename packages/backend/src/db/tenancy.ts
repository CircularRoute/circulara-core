/**
 * Tenancy: the isolation boundary.
 *
 * TWO modes (go-live model, decisions.md 2026-07-07):
 *  - SHARED (free Observe, the default): ONE deployment, ONE database, many
 *    workspaces - each workspace is a Postgres SCHEMA (ws_<id>). A workspace
 *    context sets `search_path = <schema>, public` per operation (inside a
 *    transaction, so interleaved awaits on the shared connection cannot leak
 *    across workspaces). One instance = one bill; isolation is physical
 *    (separate schemas), which the BL1 isolation battery validates. This is
 *    the founder-approved shape (schema-per-workspace, not workspace_id rows -
 *    PGlite does not enforce RLS, so schemas give the dev-testable safety net).
 *  - DEDICATED (paying customers): each tenant gets its OWN database/instance
 *    (AD2/AD3 single-tenant isolation), provisioned per customer on conversion.
 *
 * DRIVERS: dev/tests use embedded PGlite; production uses node-postgres when
 * DATABASE_URL is set (Render). Both satisfy the `Db` interface below, so no
 * app query changes. Same SQL + pgvector either way.
 *
 * The invariant: NO code path touches tenant data except through a
 * TenantContext, which is bound to exactly one workspace schema (shared) or
 * one dedicated database.
 */
// PGlite (dev/tests only) is LAZY-loaded: on the prod Postgres path
// (DATABASE_URL set) the pglite + pgvector-WASM modules must never load - they
// are the boot-memory hogs that OOM'd the 512MB Render Starter box
// (builder.20260709.001). Type-only import is erased at compile (no runtime load).
import type { PGlite as PGliteInstance } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CONTROL_MIGRATIONS, TENANT_MIGRATIONS } from "./migrations.js";

/** The minimal DB surface the app uses. PGlite, ScopedDb, and the pg driver
 * (B2) all satisfy it, so `ctx.db.query(...)` call sites never change. */
export interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export type PlanMode = "shared" | "dedicated";

async function migrate(
  db: Db,
  migrations: { version: number; sql: string }[],
): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (version int PRIMARY KEY, applied_at timestamptz DEFAULT now())`,
  );
  for (const m of migrations) {
    const done = await db.query<{ version: number }>(
      `SELECT version FROM _migrations WHERE version = $1`,
      [m.version],
    );
    if (done.rows.length === 0) {
      await db.exec(m.sql);
      await db.query(`INSERT INTO _migrations (version) VALUES ($1)`, [m.version]);
    }
  }
}

export interface TenantRecord {
  tenant_id: string;
  name: string;
  plan_mode: PlanMode;
  schema: string | null; // shared: the workspace schema; dedicated: null
  storage_ref: string; // dedicated: DB path/ref; shared: "shared://<schema>"
}

/** A handle bound to exactly one workspace (shared) or one dedicated DB. */
export class TenantContext {
  constructor(
    public readonly tenantId: string,
    public readonly db: Db,
    public readonly planMode: PlanMode = "dedicated",
  ) {}
}

const SCHEMA_RE = /^ws_[a-f0-9]{32}$/;
const schemaFor = (tenantId: string) => `ws_${tenantId.replace(/-/g, "")}`;

/**
 * Shared-mode DB view: wraps the ONE shared connection, pinning every
 * operation to a workspace schema via `SET LOCAL search_path` inside a
 * transaction. `SET LOCAL` is transaction-scoped, so two workspaces whose
 * awaits interleave on the shared connection cannot see each other's rows.
 */
class ScopedDb implements Db {
  constructor(
    private shared: Db,
    private schema: string,
  ) {
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid workspace schema: ${schema}`);
  }
  private scoped<T>(run: (tx: Db) => Promise<T>): Promise<T> {
    return this.shared.transaction(async (tx) => {
      // identifier cannot be parameterized; validated by SCHEMA_RE in ctor
      await tx.query(`SET LOCAL search_path TO ${this.schema}, public`);
      return run(tx);
    });
  }
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.scoped((tx) => tx.query<T>(sql, params));
  }
  exec(sql: string) {
    return this.scoped(async (tx) => {
      await tx.exec(sql);
    });
  }
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.scoped((tx) => fn(tx));
  }
}

export class ControlPlane {
  private control!: Db;
  private shared!: Db; // the one shared workspace DB (free tier)
  private dedicatedDbs = new Map<string, Db>();
  private ownedPglite: PGliteInstance[] = [];
  private pgEnd: (() => Promise<void>) | null = null;
  private pgliteMod?: {
    PGlite: typeof import("@electric-sql/pglite").PGlite;
    vector: typeof import("@electric-sql/pglite-pgvector").vector;
  };

  constructor(
    private dataDir: string,
    private inMemory = false,
    /** B2: when set (Render), control + shared run on ONE node-postgres pool */
    private databaseUrl?: string,
  ) {}

  /** Lazily import the pglite + pgvector-WASM modules (dev/tests only). */
  private async loadPglite() {
    if (!this.pgliteMod) {
      const [core, pgv] = await Promise.all([
        import("@electric-sql/pglite"),
        import("@electric-sql/pglite-pgvector"),
      ]);
      this.pgliteMod = { PGlite: core.PGlite, vector: pgv.vector };
    }
    return this.pgliteMod;
  }

  private async pgliteFor(path?: string): Promise<Db> {
    const { PGlite, vector } = await this.loadPglite();
    const pg =
      this.inMemory || !path
        ? new PGlite({ extensions: { vector } })
        : (mkdirSync(path, { recursive: true }), new PGlite(path, { extensions: { vector } }));
    this.ownedPglite.push(pg);
    return pg as unknown as Db;
  }

  async init(): Promise<void> {
    if (this.databaseUrl) {
      // PROD (Render): one Postgres holds control tables (public) + all
      // workspace schemas. pgvector installed once in public.
      const { PgDriver } = await import("./pgDriver.js");
      const driver = await PgDriver.connect(this.databaseUrl);
      this.pgEnd = () => driver.end();
      this.control = driver;
      this.shared = driver;
      await migrate(this.control, CONTROL_MIGRATIONS);
      await this.shared.exec(`CREATE EXTENSION IF NOT EXISTS vector`);
      return;
    }
    // DEV/TESTS: embedded PGlite (control + shared as separate instances)
    if (!this.inMemory) mkdirSync(join(this.dataDir, "control"), { recursive: true });
    this.control = await this.pgliteFor(this.inMemory ? undefined : join(this.dataDir, "control"));
    await migrate(this.control, CONTROL_MIGRATIONS);
    this.shared = await this.pgliteFor(this.inMemory ? undefined : join(this.dataDir, "shared"));
    await this.shared.exec(`CREATE EXTENSION IF NOT EXISTS vector`);
  }

  /** Free installs default to a SHARED workspace; paid conversion uses 'dedicated'. */
  async createTenant(name: string, opts: { mode?: PlanMode } = {}): Promise<TenantRecord> {
    const mode: PlanMode = opts.mode ?? "shared";
    const tenantId = randomUUID();
    if (mode === "shared") {
      const schema = schemaFor(tenantId);
      await this.shared.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await migrate(new ScopedDb(this.shared, schema), TENANT_MIGRATIONS);
      await this.control.query(
        `INSERT INTO tenants (tenant_id, name, plan_mode, schema, storage_ref) VALUES ($1,$2,'shared',$3,$4)`,
        [tenantId, name, schema, `shared://${schema}`],
      );
      return { tenant_id: tenantId, name, plan_mode: "shared", schema, storage_ref: `shared://${schema}` };
    }
    // dedicated (paid): own database. On the shared prod deployment this is a
    // separate per-customer provisioning step (own Render instance/VPC), done
    // on conversion - not wired into the shared backend. Fail loud.
    if (this.databaseUrl)
      throw new Error(
        "dedicated (paid) provisioning is a per-customer step, not available on the shared free deployment (go-live model)",
      );
    const storageRef = this.inMemory ? `memory://${tenantId}` : join(this.dataDir, "tenants", tenantId);
    await this.control.query(
      `INSERT INTO tenants (tenant_id, name, plan_mode, schema, storage_ref) VALUES ($1,$2,'dedicated',NULL,$3)`,
      [tenantId, name, storageRef],
    );
    await this.contextFor(tenantId); // provision its DB now
    return { tenant_id: tenantId, name, plan_mode: "dedicated", schema: null, storage_ref: storageRef };
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const res = await this.control.query<TenantRecord>(
      `SELECT tenant_id, name, plan_mode, schema, storage_ref FROM tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  /** Control-plane DB handle (global registries, e.g. early-adopter slots). */
  controlDb(): Db {
    return this.control;
  }

  // ---- workspace membership (consumer dashboard login, builder.20260708.001) --

  /** Grant an email access to a workspace (idempotent). */
  async addMember(
    tenantId: string,
    email: string,
    role: "admin" | "member" = "admin",
  ): Promise<void> {
    await this.control.query(
      `INSERT INTO workspace_members (tenant_id, email, role) VALUES ($1, lower($2), $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, email, role],
    );
  }

  /** The workspaces an email may sign into (email -> tenant, shared backend). */
  async membershipsFor(
    email: string,
  ): Promise<{ tenant_id: string; name: string; role: "admin" | "member" }[]> {
    const r = await this.control.query<{ tenant_id: string; name: string; role: "admin" | "member" }>(
      `SELECT m.tenant_id, t.name, m.role
         FROM workspace_members m JOIN tenants t ON t.tenant_id = m.tenant_id
        WHERE lower(m.email) = lower($1)
        ORDER BY m.created_at ASC`,
      [email],
    );
    return r.rows;
  }

  /**
   * Self-serve free signup: a VERIFIED email (magic-link or Google) with no
   * existing workspace gets a fresh SHARED workspace, and is added as its admin.
   * Verified-email-gated by the caller, so this is not an anonymous
   * schema-creation surface.
   */
  async createSharedWorkspaceForEmail(email: string): Promise<TenantRecord> {
    const t = await this.createTenant(email.toLowerCase(), { mode: "shared" });
    await this.addMember(t.tenant_id, email, "admin");
    return t;
  }

  /** The only way to touch tenant data. */
  async contextFor(tenantId: string): Promise<TenantContext> {
    const rec = await this.getTenant(tenantId);
    if (!rec) throw new Error(`unknown tenant: ${tenantId}`);
    if (rec.plan_mode === "shared") {
      // shared: a scoped view over the one shared DB (schema already migrated at create)
      return new TenantContext(tenantId, new ScopedDb(this.shared, rec.schema!), "shared");
    }
    // dedicated: the tenant's own DB (provisioned + migrated once, then cached)
    let db = this.dedicatedDbs.get(tenantId);
    if (!db) {
      db = await this.pgliteFor(rec.storage_ref.startsWith("memory://") ? undefined : rec.storage_ref);
      await migrate(db, TENANT_MIGRATIONS);
      this.dedicatedDbs.set(tenantId, db);
    }
    return new TenantContext(tenantId, db, "dedicated");
  }

  async close(): Promise<void> {
    for (const pg of this.ownedPglite) await pg.close();
    if (this.pgEnd) await this.pgEnd();
  }
}
