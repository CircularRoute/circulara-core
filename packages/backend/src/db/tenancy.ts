/**
 * Tenancy: the isolation boundary (AD2, §4.4).
 *
 * Production: each tenant gets its OWN Postgres (+pgvector) instance; the
 * control plane stores only a connection reference.
 * Local dev / tests: each tenant gets its own embedded PGlite instance in its
 * own data directory - one database per tenant, mirroring prod isolation.
 * Same SQL, same extension (pgvector), swap is a driver concern.
 *
 * The invariant this module enforces: NO code path queries tenant data except
 * through a TenantContext bound to exactly one tenant's database.
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { CONTROL_MIGRATIONS, TENANT_MIGRATIONS } from "./migrations.js";

async function migrate(
  db: PGlite,
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
      await db.query(`INSERT INTO _migrations (version) VALUES ($1)`, [
        m.version,
      ]);
    }
  }
}

export interface TenantRecord {
  tenant_id: string;
  name: string;
  storage_ref: string;
}

/** A handle bound to exactly one tenant's database. */
export class TenantContext {
  constructor(
    public readonly tenantId: string,
    public readonly db: PGlite,
  ) {}
}

export class ControlPlane {
  private control!: PGlite;
  private tenantDbs = new Map<string, PGlite>();

  constructor(
    private dataDir: string,
    private inMemory = false,
  ) {}

  private pgliteFor(path?: string): PGlite {
    // In-memory for tests; on-disk per-directory for dev.
    if (this.inMemory || !path) return new PGlite({ extensions: { vector } });
    mkdirSync(path, { recursive: true });
    return new PGlite(path, { extensions: { vector } });
  }

  async init(): Promise<void> {
    if (!this.inMemory) mkdirSync(join(this.dataDir, "control"), { recursive: true });
    this.control = this.pgliteFor(join(this.dataDir, "control"));
    await migrate(this.control, CONTROL_MIGRATIONS);
  }

  async createTenant(name: string): Promise<TenantRecord> {
    const tenantId = randomUUID();
    const storageRef = this.inMemory
      ? `memory://${tenantId}`
      : join(this.dataDir, "tenants", tenantId);
    await this.control.query(
      `INSERT INTO tenants (tenant_id, name, storage_ref) VALUES ($1, $2, $3)`,
      [tenantId, name, storageRef],
    );
    // Provision the tenant's own database and run its migrations now, so a
    // tenant is usable the moment it exists.
    await this.contextFor(tenantId);
    return { tenant_id: tenantId, name, storage_ref: storageRef };
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const res = await this.control.query<TenantRecord>(
      `SELECT tenant_id, name, storage_ref FROM tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  /** The only way to touch tenant data. */
  async contextFor(tenantId: string): Promise<TenantContext> {
    const rec = await this.getTenant(tenantId);
    if (!rec) throw new Error(`unknown tenant: ${tenantId}`);
    let db = this.tenantDbs.get(tenantId);
    if (!db) {
      db = this.pgliteFor(
        rec.storage_ref.startsWith("memory://") ? undefined : rec.storage_ref,
      );
      await migrate(db, TENANT_MIGRATIONS);
      this.tenantDbs.set(tenantId, db);
    }
    return new TenantContext(tenantId, db);
  }

  async close(): Promise<void> {
    for (const db of this.tenantDbs.values()) await db.close();
    await this.control.close();
  }
}
