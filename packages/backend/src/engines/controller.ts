/**
 * Wave 3 - Cost-Controller (Tier 1). Intervenes BEFORE wasteful calls.
 *
 * Checks, in order (cheapest veto first):
 *  1. model allowlist
 *  2. tenant monthly budget (spend from meter_events vs policy)
 *  3. per-seat monthly budget
 * Verdicts: allow | flag | block. A block emits a meter event with
 * counterfactual = estimated cost of the call that did NOT happen and
 * actual = 0 - avoided_usd is the whole estimated cost (that is the product).
 *
 * HIERARCHY-AWARE messages (§4.3, proprietary wiring): every verdict carries
 * the sourcing ladder the controller consulted. Rung 1 (org library) is a
 * declared stub until Reuse ships - the message framework is in place now so
 * blocking messages already teach the ladder.
 */
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../db/tenancy.js";
import type { PricingSnapshot } from "../registry/pricing.js";
import { priceTokens } from "../meter/compute.js";
import { ingestEvent } from "../meter/meter.js";
import type { TenantPolicy } from "./policy.js";

export const estTokens = (chars: number) => Math.ceil(chars / 4);

export interface LadderRung {
  rung: string;
  status: "checked" | "available" | "coming_soon";
  note: string;
}

export interface ControllerVerdict {
  action: "allow" | "flag" | "block";
  reason: string | null;
  estimated_cost_usd: number;
  ladder: LadderRung[];
}

export interface CallIntent {
  model: string;
  inputChars: number;
  maxOutputTokens: number;
  seatId: string;
}

function ladder(reason: string | null): LadderRung[] {
  return [
    {
      rung: "org_library",
      status: "available", // wave 5: the ladder is LIVE via POST /v1/acquire
      note: "Before building anything expensive, run it through POST /v1/acquire - Circulara checks your org library, the Circulara Commons, and free/paid certified catalogs first (four-rung buy-or-build ladder).",
    },
    {
      rung: "budget_policy",
      status: "checked",
      note: reason ?? "within budget and policy",
    },
  ];
}

async function monthSpend(ctx: TenantContext, seatId?: string): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const r = await ctx.db.query<{ s: string }>(
    `SELECT coalesce(sum(actual_usd),0)::text AS s FROM meter_events
      WHERE to_char(ts,'YYYY-MM') = $1 ${seatId ? "AND seat_id = $2" : ""}`,
    seatId ? [month, seatId] : [month],
  );
  return Number(r.rows[0].s);
}

export async function controllerCheck(
  ctx: TenantContext,
  policy: TenantPolicy,
  pricing: PricingSnapshot | null,
  intent: CallIntent,
): Promise<ControllerVerdict> {
  const est = priceTokens(
    pricing,
    intent.model,
    estTokens(intent.inputChars),
    intent.maxOutputTokens,
  ).usd;

  if (policy.model_allowlist && !policy.model_allowlist.includes(intent.model)) {
    const reason = `model ${intent.model} is not on this org's allowlist`;
    return { action: "block", reason, estimated_cost_usd: est, ladder: ladder(reason) };
  }
  if (policy.monthly_budget_usd != null) {
    const spend = await monthSpend(ctx);
    if (spend + est > policy.monthly_budget_usd) {
      const reason = `org monthly budget $${policy.monthly_budget_usd} would be exceeded (spent $${spend.toFixed(2)}, this call ~$${est.toFixed(4)})`;
      return { action: "block", reason, estimated_cost_usd: est, ladder: ladder(reason) };
    }
    if (spend + est > policy.monthly_budget_usd * 0.8) {
      const reason = `org spend is past 80% of the monthly budget`;
      return { action: "flag", reason, estimated_cost_usd: est, ladder: ladder(reason) };
    }
  }
  if (policy.per_seat_monthly_budget_usd != null) {
    const spend = await monthSpend(ctx, intent.seatId);
    if (spend + est > policy.per_seat_monthly_budget_usd) {
      const reason = `seat monthly budget $${policy.per_seat_monthly_budget_usd} would be exceeded (seat spent $${spend.toFixed(2)})`;
      return { action: "block", reason, estimated_cost_usd: est, ladder: ladder(reason) };
    }
  }
  return { action: "allow", reason: null, estimated_cost_usd: est, ladder: ladder(null) };
}

/** Book the avoided cost of a blocked call (counterfactual = est, actual = 0). */
export async function emitBlockEvent(
  ctx: TenantContext,
  pricing: PricingSnapshot | null,
  intent: CallIntent,
  verdict: ControllerVerdict,
  seat: {
    identity_type: "human" | "named_agent";
    user_id: string;
    team_id: string | null;
    agent_identity: string | null;
  },
  host: "claude_code" | "cursor" | "other",
  capturePath: "hook" | "gateway" | "tool",
): Promise<void> {
  const inTok = estTokens(intent.inputChars);
  await ingestEvent(ctx, {
    event_id: randomUUID(),
    call_id: randomUUID(),
    schema_version: "1.0",
    ts: new Date().toISOString(),
    seat_id: intent.seatId,
    identity_type: seat.identity_type,
    user_id: seat.user_id,
    team_id: seat.team_id,
    agent_identity: seat.agent_identity,
    host,
    capture_path: capturePath,
    session_id: null,
    module: "cost_controller",
    intervention_type: "block",
    model_requested: intent.model,
    model_used: null,
    tokens: {
      input_counterfactual: inTok,
      output_counterfactual: intent.maxOutputTokens,
      input_actual: 0,
      output_actual: 0,
    },
    cost: {
      counterfactual_usd: verdict.estimated_cost_usd,
      actual_usd: 0,
      avoided_usd: verdict.estimated_cost_usd,
      currency: "USD",
      pricing_source: "meter",
      pricing_version: pricing?.pricing_version ?? "unpriced",
      // QA MJ4: assumes the full requested output and that blocked work is
      // truly avoided (it is often retried, i.e. deferred) - upper bound.
      basis: "upper_bound",
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
  });
}
