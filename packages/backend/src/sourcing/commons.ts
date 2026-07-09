/**
 * Wave 5 - Circulara Commons (D14/D18, AD8/AD9).
 *
 * One SHARED multi-tenant store - architecturally separate from every tenant
 * DB. Holds ONLY openly licensed, redistributable assets. Invariants:
 *
 *  - HARD GATE: license.redistributable === true admits; false/unknown NEVER
 *    pools (unknown = NOT redistributable, no override flag exists).
 *  - Derivatives inherit the parent license via the fingerprint chain; the
 *    most restrictive license on the path wins (checked tenant-side before
 *    the write is even attempted).
 *  - DEMAND-SEEDED ONLY (D18): the ONLY write path is capture-on-pull from a
 *    customer's rung-3/4 acquisition. There is no upload API, no seeding job,
 *    no crawler. The Commons launches EMPTY and that is correct.
 *  - Secret scan re-runs at Commons scope (defense in depth): a "public"
 *    dataset with leaked credentials in it must not pool.
 *  - Bytes are content-addressed (sha256 = key), same convention as tenants.
 *  - No tenant data by construction: only externally-sourced redistributable
 *    assets, plus a hashed source-tenant ref for audit (never exposed).
 */
// PGlite is LAZY-loaded (dynamic import in ensureInit): the Commons launches
// EMPTY + demand-seeded (D18), so on the prod Postgres box it is untouched at
// launch and must not pay the pglite-WASM boot cost (builder.20260709.001).
import type { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FsObjectStore } from "../storage/objectStore.js";
import { scanForSecrets } from "../engines/reuse/scanner.js";

const COMMONS_MIGRATION = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS commons_assets (
  exact_fp         text PRIMARY KEY,
  asset_type       smallint NOT NULL,
  description      text NOT NULL,
  embedding        vector(1536),
  source           text NOT NULL,              -- hf_hub | data_gov | data_europa | roda | adx | snowflake
  catalog_ref      text,
  license          jsonb NOT NULL,             -- MUST have redistributable: true
  license_evidence text NOT NULL,              -- URL/text justifying admission
  checksum         text NOT NULL,
  size_bytes       bigint,
  freshness_bucket text NOT NULL DEFAULT 'static',
  quality          jsonb NOT NULL DEFAULT '{"rating":null,"num_uses":0,"verified":false}',
  source_tenant    text NOT NULL,              -- sha256(tenant_id): audit only, never exposed
  admitted_at      timestamptz NOT NULL DEFAULT now()
);
`;

export interface CommonsAdmitInput {
  exact_fp: string;
  asset_type: number;
  description: string;
  source: string;
  catalog_ref: string | null;
  license: { redistributable: boolean; spdx_or_terms: string | null };
  license_evidence: string | null;
  bytes: Buffer;
  freshness_bucket?: string;
  tenantId: string;
  embedding?: number[] | null;
}

export type CommonsAdmitResult =
  | { admitted: true }
  | { admitted: false; reason: string };

export interface CommonsHit {
  exact_fp: string;
  asset_type: number;
  description: string;
  source: string;
  license: { redistributable: boolean; spdx_or_terms: string | null };
  checksum: string;
  quality: { num_uses: number };
}

export class CommonsStore {
  private db!: PGlite;
  private objects: FsObjectStore;
  private initialized = false;

  constructor(
    private dataDir: string,
    private inMemory = false,
  ) {
    this.objects = new FsObjectStore(join(dataDir, "commons-objects"));
  }

  /** Idempotent. Explicit callers (tests) may call it; every method also calls
   * ensureInit, so on prod the pglite WASM loads on FIRST Commons use, not boot. */
  async init(): Promise<void> {
    await this.ensureInit();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    const [{ PGlite }, { vector }] = await Promise.all([
      import("@electric-sql/pglite"),
      import("@electric-sql/pglite-pgvector"),
    ]);
    if (this.inMemory) {
      this.db = new PGlite({ extensions: { vector } });
    } else {
      const dir = join(this.dataDir, "commons");
      mkdirSync(dir, { recursive: true });
      this.db = new PGlite(dir, { extensions: { vector } });
    }
    await this.db.exec(COMMONS_MIGRATION);
    this.initialized = true;
  }

  /** The ONLY write path (AD9 capture-on-pull). License + scan gates inside. */
  async admit(input: CommonsAdmitInput): Promise<CommonsAdmitResult> {
    await this.ensureInit();
    // HARD GATE (D14): true admits; false/unknown never pools. No override.
    if (input.license?.redistributable !== true)
      return { admitted: false, reason: "license gate: not verifiably redistributable (D14 hard gate)" };
    if (!input.license_evidence)
      return { admitted: false, reason: "license gate: no license evidence recorded" };
    // defense in depth: secrets never pool, whatever the license says
    const scan = scanForSecrets(input.bytes.toString("utf8"));
    if (scan.blocked)
      return { admitted: false, reason: "secret scanner HARD BLOCK at Commons scope" };

    // dedup: already pooled -> record the demand signal, stop
    const existing = await this.db.query<{ exact_fp: string }>(
      `SELECT exact_fp FROM commons_assets WHERE exact_fp = $1`,
      [input.exact_fp],
    );
    if (existing.rows.length > 0) {
      await this.db.query(
        `UPDATE commons_assets
            SET quality = jsonb_set(quality, '{num_uses}', ((quality->>'num_uses')::int + 1)::text::jsonb)
          WHERE exact_fp = $1`,
        [input.exact_fp],
      );
      return { admitted: true };
    }

    const checksum = await this.objects.put("commons", input.bytes);
    await this.db.query(
      `INSERT INTO commons_assets
         (exact_fp, asset_type, description, embedding, source, catalog_ref,
          license, license_evidence, checksum, size_bytes, freshness_bucket, source_tenant)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.exact_fp,
        input.asset_type,
        input.description,
        input.embedding ? `[${input.embedding.join(",")}]` : null,
        input.source,
        input.catalog_ref,
        JSON.stringify(input.license),
        input.license_evidence,
        checksum,
        input.bytes.length,
        input.freshness_bucket ?? "static",
        createHash("sha256").update(input.tenantId).digest("hex"),
      ],
    );
    return { admitted: true };
  }

  /** Multi-tenant read: exact fingerprint lookup. */
  async lookup(exactFp: string): Promise<CommonsHit | null> {
    await this.ensureInit();
    const r = await this.db.query<CommonsHit>(
      `SELECT exact_fp, asset_type, description, source, license, checksum, quality
         FROM commons_assets WHERE exact_fp = $1`,
      [exactFp],
    );
    if (r.rows.length === 0) return null;
    await this.db.query(
      `UPDATE commons_assets
          SET quality = jsonb_set(quality, '{num_uses}', ((quality->>'num_uses')::int + 1)::text::jsonb)
        WHERE exact_fp = $1`,
      [exactFp],
    );
    return r.rows[0];
  }

  async fetchBytes(checksum: string): Promise<Buffer | null> {
    return this.objects.get("commons", checksum);
  }

  async stats(): Promise<{ assets: number; total_uses: number }> {
    await this.ensureInit();
    const r = await this.db.query<{ assets: number; total_uses: string }>(
      `SELECT count(*)::int AS assets,
              coalesce(sum((quality->>'num_uses')::int),0)::text AS total_uses
         FROM commons_assets`,
    );
    return { assets: r.rows[0].assets, total_uses: Number(r.rows[0].total_uses) };
  }

  async close(): Promise<void> {
    if (this.initialized) await this.db.close();
  }
}
