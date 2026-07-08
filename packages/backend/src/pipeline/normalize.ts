/**
 * WS3 - telemetry pipeline: capture -> normalize -> price (WS4) -> append.
 *
 * ONE path for all three captures (AD3):
 *   hook    (Claude Code PostToolUse, plugin)  -> POST /v1/events
 *   tool    (circulara_report MCP tool)        -> POST /v1/events
 *   gateway (path B, Anthropic/OpenAI format)  -> recordCapture() in-process
 *
 * Normalization rules:
 *  - Plugin-priced events are NOT trusted: any event whose
 *    cost.pricing_source != "meter" is RE-PRICED here from the approved
 *    registry snapshot (pricing placement decision, see meter/compute.ts).
 *    Clients send tokens + model; the meter owns money.
 *  - Observe semantics enforced: intervention_type "observe" gets
 *    counterfactual = actual, avoided = 0, whatever the client claimed.
 *  - Free-tier seat cap (QA m4): events are ACCEPTED past the cap; the
 *    tenant is marked over-cap in tenant_meta (dashboard banner + report
 *    watermark read it in WS5). No data loss, no silent unlimited free.
 */
import { randomUUID } from "node:crypto";
import type { InterventionEvent } from "@circulara/schema";
import type { TenantContext } from "../db/tenancy.js";
import type { PricingSnapshot } from "../registry/pricing.js";
import { priceTokens } from "../meter/compute.js";
import { ingestEvent } from "../meter/meter.js";

export const FREE_TIER_SEAT_CAP = 3;

export interface PipelineDeps {
  getPricing: () => PricingSnapshot | null;
}

/** A raw capture from any path, before normalization. */
export interface Capture {
  capturePath: "hook" | "gateway" | "tool";
  host: "claude_code" | "cursor" | "other";
  seat: {
    seat_id: string;
    identity_type: "human" | "named_agent";
    user_id: string;
    team_id: string | null;
    agent_identity: string | null;
  };
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  callId?: string;
  sessionId?: string | null;
  ts?: string;
}

/** Gateway/in-process path: build + normalize + price + append. */
export async function recordCapture(
  ctx: TenantContext,
  deps: PipelineDeps,
  cap: Capture,
): Promise<{ event_id: string }> {
  const cost = priceTokens(
    deps.getPricing(),
    cap.model,
    cap.inputTokens,
    cap.outputTokens,
  );
  const ev: InterventionEvent = {
    event_id: randomUUID(),
    call_id: cap.callId ?? randomUUID(),
    schema_version: "1.0",
    ts: cap.ts ?? new Date().toISOString(),
    seat_id: cap.seat.seat_id,
    identity_type: cap.seat.identity_type,
    user_id: cap.seat.user_id,
    team_id: cap.seat.team_id,
    agent_identity: cap.seat.agent_identity,
    host: cap.host,
    capture_path: cap.capturePath,
    session_id: cap.sessionId ?? null,
    module: "meter",
    intervention_type: "observe",
    model_requested: cap.model,
    model_used: cap.model,
    tokens: {
      input_counterfactual: cap.inputTokens,
      output_counterfactual: cap.outputTokens,
      input_actual: cap.inputTokens,
      output_actual: cap.outputTokens,
    },
    cost: {
      counterfactual_usd: cost.usd,
      actual_usd: cost.usd,
      avoided_usd: 0,
      currency: "USD",
      pricing_source: "meter",
      pricing_version: cost.pricing_version,
    },
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
  };
  return appendNormalized(ctx, deps, ev);
}

/**
 * API path (POST /v1/events): the event was built client-side against the
 * shared schema; normalize it before append.
 */
export async function normalizeAndAppend(
  ctx: TenantContext,
  deps: PipelineDeps,
  ev: InterventionEvent,
  fromClient = false, // QA B1: API-originated events get zero pricing trust
): Promise<{ event_id: string }> {
  const normalized = { ...ev, cost: { ...ev.cost } };

  // Re-pricing rule (sprint-3 decision): client-submitted OBSERVE events are
  // token-based, so the meter re-prices them from the approved snapshot -
  // client cost is a hint, never the booked number. NON-observe events carry
  // engine-computed savings math (reuse: build-cost vs price; sourcing:
  // subscription math) that is NOT reconstructible from tokens - those events
  // come from Circulara's own engines (in-process, meter-priced at source)
  // and pass through here unmodified. The boundary is enforced at the API
  // route (server.ts /v1/events): the route rejects every non-observe event
  // and always passes fromClient=true, so client cost fields are NEVER
  // booked as sent (QA BL2).
  if (
    normalized.intervention_type === "observe" &&
    (fromClient || normalized.cost.pricing_source !== "meter")
  ) {
    // fromClient: a client claiming pricing_source "meter" is re-priced anyway (QA B1)
    const priced = priceTokens(
      deps.getPricing(),
      normalized.model_used ?? normalized.model_requested,
      normalized.tokens.input_actual,
      normalized.tokens.output_actual,
    );
    normalized.cost = {
      counterfactual_usd: priced.usd, // observe: counterfactual = actual (QA n2)
      actual_usd: priced.usd,
      avoided_usd: 0,
      currency: "USD",
      pricing_source: "meter",
      pricing_version: priced.pricing_version,
    };
  }

  return appendNormalized(ctx, deps, normalized);
}

async function appendNormalized(
  ctx: TenantContext,
  _deps: PipelineDeps,
  ev: InterventionEvent,
): Promise<{ event_id: string }> {
  const res = await ingestEvent(ctx, ev);
  await checkSeatCap(ctx);
  return res;
}

/** QA m4: accept + flag, never reject (rejecting would corrupt the baseline). */
async function checkSeatCap(ctx: TenantContext): Promise<void> {
  const plan = await ctx.db.query<{ value: { plan?: string } }>(
    `SELECT value FROM tenant_meta WHERE key = 'plan'`,
  );
  const planName = plan.rows[0]?.value?.plan ?? "observe_free";
  if (planName !== "observe_free") return;
  const seats = await ctx.db.query<{ n: number }>(
    `SELECT count(DISTINCT seat_id)::int AS n FROM meter_events`,
  );
  if (seats.rows[0].n > FREE_TIER_SEAT_CAP) {
    await ctx.db.query(
      `INSERT INTO tenant_meta (key, value) VALUES ('over_seat_cap', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [
        JSON.stringify({
          over: true,
          cap: FREE_TIER_SEAT_CAP,
          active_seats: seats.rows[0].n,
          since: new Date().toISOString(),
        }),
      ],
    );
  }
}

export async function isOverSeatCap(ctx: TenantContext): Promise<boolean> {
  const r = await ctx.db.query<{ value: { over?: boolean } }>(
    `SELECT value FROM tenant_meta WHERE key = 'over_seat_cap'`,
  );
  return r.rows[0]?.value?.over === true;
}
