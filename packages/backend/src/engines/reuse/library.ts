/**
 * Wave 5 - the org Reuse library (the proprietary core, §4.3).
 *
 * Capture (§6.6, DEFAULT OFF):
 *  - policy.reuse.capture_enabled must be true AND the asset type authorized
 *  - deterministic secret scan HARD BLOCKS live credentials (capture-safety
 *    minimum bar; full clearance pipeline = wave 6, same seam)
 *  - provenance recorded on every entry; sharing_tier starts 'private'
 *  - license defaults NOT redistributable; derivatives carry parent_fp
 *
 * Lookup (§6.3 order): exact fingerprint -> gates -> semantic fallback
 * (strictly gated like the response cache: opt-in, thresholded, guarded).
 * Gates that must never be skipped (§6.5): freshness, quality, schema.
 */
import type { TenantContext } from "../../db/tenancy.js";
import type { ObjectStore } from "../../storage/objectStore.js";
import type { TenantPolicy } from "../policy.js";
import type { EmbedderPort } from "../recycle/responseCache.js";
import {
  exactFingerprint,
  describeSpec,
  type AssetSpec,
} from "./fingerprint.js";
import { type ScanResult } from "./scanner.js";
import {
  runClearance,
  auditLog,
  type ClassifierPort,
  type ClearanceVerdict,
} from "../clearance/pipeline.js";

export interface CaptureInput {
  spec: AssetSpec;
  bytes: Buffer;
  provenance: { producer: string; source: string; build_method: string };
  license?: { redistributable: boolean; spdx_or_terms: string | null };
  parent_fp?: string | null; // derivative chain (AD8)
  price_usd?: number; // what it cost to build (reuse-side counterfactual basis)
  schema_json?: unknown;
  freshness_bucket?: string;
  ttl_seconds?: number;
}

export type CaptureResult =
  | { captured: true; exact_fp: string; clearance: ClearanceVerdict }
  | { captured: false; reason: string; scan?: ScanResult; clearance?: ClearanceVerdict };

export async function captureAsset(
  ctx: TenantContext,
  objects: ObjectStore,
  policy: TenantPolicy,
  input: CaptureInput,
  embedder: EmbedderPort | null,
  classifier?: ClassifierPort | null,
): Promise<CaptureResult> {
  if (!policy.reuse.capture_enabled)
    return { captured: false, reason: "capture is OFF (default, §6.6) - enable in policy" };
  if (!policy.reuse.authorized_asset_types.includes(input.spec.asset_type))
    return {
      captured: false,
      reason: `asset type ${input.spec.asset_type} not authorized for capture`,
    };

  // Wave 6: the full clearance pipeline runs at capture time (§6).
  const verdict = await runClearance(
    policy,
    {
      text: input.bytes.toString("utf8"),
      provenance: input.provenance,
      license: input.license ?? { redistributable: false, spdx_or_terms: null },
    },
    classifier ?? null,
  );
  if (verdict.blocked) {
    await auditLog(ctx, {
      exact_fp: null,
      action: "capture_blocked",
      actor: input.provenance.producer,
      detail: { reasons: verdict.reasons, findings: verdict.findings },
    });
    return {
      captured: false,
      reason: "secret scanner HARD BLOCK (§6 step 1)",
      clearance: verdict,
    };
  }

  const fp = exactFingerprint(input.spec);
  const checksum = await objects.put(ctx.tenantId, input.bytes);
  let embedding: string | null = null;
  if (policy.reuse.semantic_enabled && embedder) {
    embedding = `[${(await embedder(describeSpec(input.spec))).join(",")}]`;
  }
  await ctx.db.query(
    `INSERT INTO assets
       (exact_fp, asset_type, schema_json, sample_preview, semantic_vector,
        freshness_bucket, ttl_seconds, provenance, size_bytes, price, checksum,
        quality, license, parent_fp, sharing_tier, clearance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'private',$15)
     ON CONFLICT (exact_fp) DO NOTHING`,
    [
      fp,
      input.spec.asset_type,
      input.schema_json ? JSON.stringify(input.schema_json) : null,
      input.bytes.toString("utf8").slice(0, 500),
      embedding,
      input.freshness_bucket ?? "static",
      input.ttl_seconds ?? null,
      JSON.stringify(input.provenance),
      input.bytes.length,
      input.price_usd ?? 0,
      checksum,
      JSON.stringify({ rating: null, num_uses: 0, verified: false }),
      JSON.stringify(
        input.license ?? { redistributable: false, spdx_or_terms: null }, // default NOT redistributable (D14)
      ),
      input.parent_fp ?? null,
      JSON.stringify(verdict),
    ],
  );
  await auditLog(ctx, {
    exact_fp: fp,
    action: "capture",
    actor: input.provenance.producer,
    detail: {
      max_tier: verdict.max_tier,
      findings: verdict.findings,
      classification: verdict.classification,
      reasons: verdict.reasons,
    },
  });
  return { captured: true, exact_fp: fp, clearance: verdict };
}

export interface AssetRow {
  exact_fp: string;
  asset_type: number;
  schema_json: unknown;
  freshness_bucket: string;
  ttl_seconds: number | null;
  created_at: string;
  price: string;
  checksum: string;
  quality: { rating: number | null; num_uses: number; verified: boolean };
  license: { redistributable: boolean; spdx_or_terms: string | null };
  parent_fp: string | null;
  sharing_tier: string;
  similarity?: number;
}

export interface LookupConstraints {
  schema_version?: string; // semantic matches must satisfy the requested schema
  min_quality_uses?: number; // quality gate knob (default 0: fresh library)
}

/** §6.5 gates - never skipped, identical for exact and semantic hits. */
export function passesGates(
  row: AssetRow,
  spec: AssetSpec,
  constraints: LookupConstraints,
  now = new Date(),
): { ok: boolean; reason: string | null } {
  // freshness: TTL respected; bucketed types must be in-window (the window is
  // in the exact fp for type 3, so a stale bucket simply never matches - this
  // guards semantic matches and TTLed entries)
  if (row.ttl_seconds != null) {
    const age = (now.getTime() - new Date(row.created_at).getTime()) / 1000;
    if (age > row.ttl_seconds) return { ok: false, reason: "freshness gate: TTL expired" };
  }
  // quality: minimum uses / verified when demanded
  if (
    constraints.min_quality_uses != null &&
    row.quality.num_uses < constraints.min_quality_uses
  )
    return { ok: false, reason: "quality gate: insufficient usage history" };
  // schema: a match must satisfy the requested schema, not merely be "about the same thing"
  if (constraints.schema_version != null) {
    const rowSchema =
      spec.asset_type === 3
        ? (row.schema_json as { schema_version?: string } | null)?.schema_version ??
          (typeof row.schema_json === "string"
            ? (JSON.parse(row.schema_json as string) as { schema_version?: string })
                ?.schema_version
            : undefined)
        : undefined;
    if (spec.asset_type === 3 && rowSchema !== constraints.schema_version)
      return { ok: false, reason: "schema gate: version mismatch" };
  }
  return { ok: true, reason: null };
}

export async function libraryLookup(
  ctx: TenantContext,
  policy: TenantPolicy,
  spec: AssetSpec,
  constraints: LookupConstraints,
  embedder: EmbedderPort | null,
): Promise<{ row: AssetRow; layer: "exact" | "semantic" } | null> {
  const fp = exactFingerprint(spec);
  const exact = await ctx.db.query<AssetRow>(
    `SELECT exact_fp, asset_type, schema_json, freshness_bucket, ttl_seconds,
            created_at, price::text, checksum, quality, license, parent_fp, sharing_tier
       FROM assets WHERE exact_fp = $1`,
    [fp],
  );
  if (exact.rows.length > 0) {
    const row = exact.rows[0];
    if (passesGates(row, spec, constraints).ok) return { row, layer: "exact" };
    return null; // an exact match that fails gates is NOT served (never stale/worse)
  }

  // semantic fallback: SECOND, opt-in, thresholded (§6.2 fuzzy layer)
  if (policy.reuse.semantic_enabled && embedder) {
    const vec = await embedder(describeSpec(spec));
    const r = await ctx.db.query<AssetRow & { sim: number }>(
      `SELECT exact_fp, asset_type, schema_json, freshness_bucket, ttl_seconds,
              created_at, price::text, checksum, quality, license, parent_fp,
              sharing_tier, 1 - (semantic_vector <=> $1::vector) AS sim
         FROM assets
        WHERE asset_type = $2 AND semantic_vector IS NOT NULL
        ORDER BY semantic_vector <=> $1::vector ASC LIMIT 1`,
      [`[${vec.join(",")}]`, spec.asset_type],
    );
    const best = r.rows[0];
    if (
      best &&
      best.sim >= policy.reuse.semantic_threshold &&
      passesGates(best, spec, constraints).ok
    )
      return { row: { ...best, similarity: best.sim }, layer: "semantic" };
  }
  return null;
}

/** Walk the parent_fp chain; the MOST RESTRICTIVE license on the path wins (AD8). */
export async function effectiveRedistributable(
  ctx: TenantContext,
  fp: string,
): Promise<boolean> {
  let current: string | null = fp;
  let hops = 0;
  while (current && hops < 20) {
    const r: { rows: { license: { redistributable?: boolean }; parent_fp: string | null }[] } =
      await ctx.db.query(
        `SELECT license, parent_fp FROM assets WHERE exact_fp = $1`,
        [current],
      );
    if (r.rows.length === 0) return false; // unknown ancestry -> NOT redistributable
    if (r.rows[0].license?.redistributable !== true) return false;
    current = r.rows[0].parent_fp;
    hops++;
  }
  return true;
}
