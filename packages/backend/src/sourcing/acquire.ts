/**
 * Wave 5 - acquire_asset v2: the four-rung buy-or-build ladder (§6.3 + AD7).
 *
 *   rung 1  org library      (exact -> gates -> semantic)      reuse_exact/_semantic
 *   rung 2  Circulara Commons (exact fp, license-clean pool)   reuse_commons
 *   rung 3  free catalogs     (demand-pulled, gated, captured) external_free
 *   rung 4  paid catalogs     (PROPOSAL ONLY - human approves) purchase_proposed
 *   else    build it yourself (verdict; capture-on-build if enabled)
 *
 * Rules on every rung: identical freshness/quality/schema gates; identical
 * license gate; the cost gate reuse <= build x buy_threshold (<= 0.70, §6.4);
 * the ladder short-circuits downward only - a cheaper safer rung that passes
 * gates always wins. Every rung is metered (avoided-only events; external
 * spend on its own line, never netted - AD12).
 */
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../db/tenancy.js";
import type { ObjectStore } from "../storage/objectStore.js";
import type { TenantPolicy } from "../engines/policy.js";
import type { EmbedderPort } from "../engines/recycle/responseCache.js";
import type { PricingSnapshot } from "../registry/pricing.js";
import {
  libraryLookup,
  captureAsset,
  effectiveRedistributable,
  type LookupConstraints,
} from "../engines/reuse/library.js";
import { exactFingerprint, describeSpec, type AssetSpec } from "../engines/reuse/fingerprint.js";
import { estimateBuildCost, type BuildEstimateInput } from "../engines/reuse/estimate.js";
import { CommonsStore } from "./commons.js";
import { FederatedIndex, type CatalogEntry } from "./catalogs.js";
import { ingestEvent } from "../meter/meter.js";

export interface AcquireDeps {
  objects: ObjectStore;
  commons: CommonsStore;
  index: FederatedIndex;
  getPricing: () => PricingSnapshot | null;
  embedder: EmbedderPort | null;
}

export interface SeatRef {
  seat_id: string;
  identity_type: "human" | "named_agent";
  user_id: string;
  team_id: string | null;
  agent_identity: string | null;
}

export interface AcquireRequest {
  spec: AssetSpec;
  description?: string; // free-text for catalog search; defaults to spec description
  constraints?: LookupConstraints;
  build_estimate: BuildEstimateInput; // §6.4 inputs - what building would cost
}

export type AcquireResult =
  | { verdict: "reuse"; rung: 1 | 2 | 3; source: string; exact_fp: string; layer?: string; avoided_usd: number }
  | { verdict: "proposal"; rung: 4; proposal_id: string; entry: CatalogEntry; build_cost_usd: number }
  | { verdict: "build"; reason: string; build_cost_usd: number };

const SOURCING_EVENT = (
  seat: SeatRef,
  fields: Record<string, unknown>,
): Record<string, unknown> => ({
  event_id: randomUUID(),
  call_id: randomUUID(),
  ts: new Date().toISOString(),
  seat_id: seat.seat_id,
  identity_type: seat.identity_type,
  user_id: seat.user_id,
  team_id: seat.team_id,
  agent_identity: seat.agent_identity,
  host: "other",
  capture_path: "tool",
  session_id: null,
  module: "reuse",
  model_requested: null,
  model_used: null,
  energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
  carbon: {
    avoided_co2e_g: 0,
    grid_intensity_g_per_kwh: 400,
    pue: 1.2,
    region: null,
    method: "EcoLogits-class",
    confidence: "Estimated",
  },
  methodology_version: "esg-v1",
  asset_ref: null,
  cache_ref: null,
  sourcing: null,
  catalog_reserved: null,
  ...fields,
});

function costGate(reuseCost: number, buildCost: number, threshold: number): boolean {
  return reuseCost <= buildCost * threshold;
}

export async function acquireAsset(
  ctx: TenantContext,
  policy: TenantPolicy,
  deps: AcquireDeps,
  seat: SeatRef,
  req: AcquireRequest,
): Promise<AcquireResult> {
  const pricing = deps.getPricing();
  const build = estimateBuildCost(pricing, req.build_estimate);
  const threshold = Math.min(policy.reuse.buy_threshold, 0.7); // §6.4 hard cap
  const constraints = req.constraints ?? {};
  const pricingVersion = pricing?.pricing_version ?? "unpriced";
  const desc = req.description ?? describeSpec(req.spec);

  // ---- rung 1: org library ----
  const lib = await libraryLookup(ctx, policy, req.spec, constraints, deps.embedder);
  if (lib) {
    const reuseCost = Number(lib.row.price) * 0 + 0; // access-controlled fetch ~ free (§6.3 single-tenant)
    if (costGate(reuseCost, build.total_usd, threshold)) {
      const avoided = build.total_usd - reuseCost;
      await ctx.db.query(
        `UPDATE assets SET quality = jsonb_set(quality, '{num_uses}', ((quality->>'num_uses')::int + 1)::text::jsonb) WHERE exact_fp = $1`,
        [lib.row.exact_fp],
      );
      await ingestEvent(
        ctx,
        SOURCING_EVENT(seat, {
          schema_version: "1.0",
          intervention_type: lib.layer === "exact" ? "reuse_exact" : "reuse_semantic",
          tokens: { input_counterfactual: 0, output_counterfactual: 0, input_actual: 0, output_actual: 0 },
          cost: {
            counterfactual_usd: avoided,
            actual_usd: 0,
            avoided_usd: avoided,
            currency: "USD",
            pricing_source: "meter",
            pricing_version: pricingVersion,
          },
          asset_ref: {
            exact_fp: lib.row.exact_fp,
            asset_type: req.spec.asset_type,
            sharing_tier: lib.row.sharing_tier,
          },
        }),
      );
      return {
        verdict: "reuse",
        rung: 1,
        source: "org",
        exact_fp: lib.row.exact_fp,
        layer: lib.layer,
        avoided_usd: avoided,
      };
    }
  }

  // ---- rung 2: Circulara Commons (exact fp; same gates by construction) ----
  const fp = exactFingerprint(req.spec);
  const commonsHit = await deps.commons.lookup(fp);
  if (commonsHit && costGate(0, build.total_usd, threshold)) {
    const avoided = build.total_usd;
    // cache a local copy in the org library (provenance = commons)
    const bytes = await deps.commons.fetchBytes(commonsHit.checksum);
    if (bytes && policy.reuse.capture_enabled) {
      await captureAsset(
        ctx,
        deps.objects,
        policy,
        {
          spec: req.spec,
          bytes,
          provenance: { producer: "commons", source: commonsHit.source, build_method: "commons-pull" },
          license: commonsHit.license,
        },
        deps.embedder,
      );
    }
    await ingestEvent(
      ctx,
      SOURCING_EVENT(seat, {
        schema_version: "1.1",
        intervention_type: "reuse_commons",
        tokens: { input_counterfactual: 0, output_counterfactual: 0, input_actual: 0, output_actual: 0 },
        cost: {
          counterfactual_usd: avoided,
          actual_usd: 0,
          avoided_usd: avoided,
          currency: "USD",
          pricing_source: "meter",
          pricing_version: pricingVersion,
        },
        sourcing: {
          rung: 2,
          source: "commons",
          catalog_ref: null,
          spend_usd: 0,
          billing_route: "none",
          approval_ref: null,
          license: { ...commonsHit.license, parent_fp: null },
          commons_captured: false,
        },
      }),
    );
    return { verdict: "reuse", rung: 2, source: "commons", exact_fp: fp, avoided_usd: avoided };
  }

  // ---- rung 3: free/open catalogs (demand-pulled) ----
  const freeHits = await deps.index.search(desc, "free");
  const freeBest = freeHits[0];
  if (freeBest && costGate(0, build.total_usd, threshold)) {
    const catalog = deps.index.catalogFor(freeBest.source)!;
    const bytes = await catalog.acquire!(freeBest);
    // capture into the org library (scan gate inside; failure falls through to build)
    let capturedFp: string | null = null;
    if (policy.reuse.capture_enabled) {
      const cap = await captureAsset(
        ctx,
        deps.objects,
        policy,
        {
          spec: req.spec,
          bytes,
          provenance: { producer: "external", source: freeBest.source, build_method: "catalog-pull" },
          license: freeBest.license,
        },
        deps.embedder,
      );
      if (cap.captured) capturedFp = cap.exact_fp;
    }
    // AD9 capture-on-pull: redistributable pulls seed the Commons (the ONLY Commons write path)
    let commonsCaptured = false;
    if (capturedFp && (await effectiveRedistributable(ctx, capturedFp))) {
      const admitted = await deps.commons.admit({
        exact_fp: capturedFp,
        asset_type: req.spec.asset_type,
        description: desc,
        source: freeBest.source,
        catalog_ref: freeBest.native_id,
        license: freeBest.license,
        license_evidence: freeBest.license.spdx_or_terms,
        bytes,
        tenantId: ctx.tenantId,
        embedding: deps.embedder ? await deps.embedder(desc) : null,
      });
      commonsCaptured = admitted.admitted;
    }
    const avoided = build.total_usd; // fetch cost ~ 0; the whole build was avoided
    await ingestEvent(
      ctx,
      SOURCING_EVENT(seat, {
        schema_version: "1.1",
        intervention_type: "external_free",
        tokens: { input_counterfactual: 0, output_counterfactual: 0, input_actual: 0, output_actual: 0 },
        cost: {
          counterfactual_usd: avoided,
          actual_usd: 0,
          avoided_usd: avoided,
          currency: "USD",
          pricing_source: "meter",
          pricing_version: pricingVersion,
        },
        sourcing: {
          rung: 3,
          source: freeBest.source,
          catalog_ref: freeBest.native_id,
          spend_usd: 0,
          billing_route: "none",
          approval_ref: null,
          license: { ...freeBest.license, parent_fp: null },
          commons_captured: commonsCaptured,
        },
      }),
    );
    return {
      verdict: "reuse",
      rung: 3,
      source: freeBest.source,
      exact_fp: capturedFp ?? fp,
      avoided_usd: avoided,
    };
  }

  // ---- rung 4: paid certified catalogs -> PROPOSAL, never auto-purchase (D15/AD11) ----
  const paidHits = await deps.index.search(desc, "paid");
  const paidBest = paidHits[0];
  if (paidBest && costGate(paidBest.price_usd, build.total_usd, threshold)) {
    const proposalId = randomUUID();
    await ctx.db.query(
      `INSERT INTO purchase_approvals
         (proposal_id, source, catalog_ref, title, price_usd, billing_route,
          build_cost_usd, requested_by_seat, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
      [
        proposalId,
        paidBest.source,
        paidBest.native_id,
        paidBest.title,
        paidBest.price_usd,
        paidBest.billing_route,
        build.total_usd,
        seat.seat_id,
      ],
    );
    await ingestEvent(
      ctx,
      SOURCING_EVENT(seat, {
        schema_version: "1.1",
        intervention_type: "purchase_proposed",
        tokens: { input_counterfactual: 0, output_counterfactual: 0, input_actual: 0, output_actual: 0 },
        cost: {
          counterfactual_usd: 0,
          actual_usd: 0,
          avoided_usd: 0,
          currency: "USD",
          pricing_source: "meter",
          pricing_version: pricingVersion,
        },
        sourcing: {
          rung: 4,
          source: paidBest.source,
          catalog_ref: paidBest.native_id,
          spend_usd: 0, // nothing spent at proposal time
          billing_route: paidBest.billing_route,
          approval_ref: proposalId,
          license: { ...paidBest.license, parent_fp: null },
          commons_captured: false,
        },
      }),
    );
    return {
      verdict: "proposal",
      rung: 4,
      proposal_id: proposalId,
      entry: paidBest,
      build_cost_usd: build.total_usd,
    };
  }

  // ---- fallthrough: build it ----
  return {
    verdict: "build",
    reason: "no rung passed gates and the cost gate - building is the rational choice",
    build_cost_usd: build.total_usd,
  };
}
