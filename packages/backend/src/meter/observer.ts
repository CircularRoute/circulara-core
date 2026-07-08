/**
 * Task 011 - the consolidated Observer meter + Routing Readiness.
 *
 * MEASUREMENT ONLY: this reads observed event metadata and reports; it changes
 * no model calls (automatic routing = task 012, post-launch).
 *
 * THE RECONCILIATION GUARANTEE (brief §1): the meter shows actual spend next
 * to potential-with-Circulara, and their gap IS the savings. We compute
 * `actual` and `potential` per figure and then define savings := actual -
 * potential (a SUBTRACTION, never an independent accumulation). So across all
 * four figures ($ / tokens / kWh / CO2e) the numbers can never fail to add up.
 *
 * COST METHOD (brief §1, "an open estimate, not a bill"): cost is recomputed
 * from observed token metadata at STANDARD PUBLISHED provider rates (the
 * approved registry snapshot) - independent of anything stored on the event.
 * Prompt-cache reads are priced at the cached rate, not full price. Labeled
 * plainly; no invoice reconciliation.
 *
 * EVIDENCED OPTIMIZATIONS ONLY (brief §1): potential reflects only what the
 * Observer can SEE and prove - (a) routing a call flagged routable to a
 * cheaper same-provider model, priced at that model's published rate; (b)
 * detectable duplicate/cacheable calls (same client-computed request_fp seen
 * earlier in the window). No speculative savings.
 *
 * COUNTS, NOT CONTENT (brief §2): every input here is metadata - model, token
 * counts, a client-computed request hash, a routable flag, task type, user.
 * Never prompt/output/file text.
 */
import type { TenantContext } from "../db/tenancy.js";
import type { PricingSnapshot } from "../registry/pricing.js";
import { priceTokens } from "./compute.js";
import { CARBON_V1, modelEnergyWeight } from "../registry/carbon.js";

const CACHED_READ_RATE = 0.1; // prompt-cache reads priced at ~10% of full input
const ROUTE_READY_THRESHOLD = 30; // routable observations before a type is "ready"

export interface Quad {
  usd: number;
  tokens: number;
  kwh: { low: number; median: number; high: number };
  co2e: { low: number; median: number; high: number };
}

export interface ObserverMeter {
  from: string | null;
  to: string | null;
  events: number;
  actual: Quad; // spend as-run, at published rates
  potential: Quad; // if evidenced optimizations were applied
  savings: Quad; // actual - potential (by construction; always reconciles)
  savings_source: { routing_usd: number; dedupe_usd: number }; // what drove $ savings
  by_user: { key: string; actual_usd: number; savings_usd: number }[];
  by_task_type: { key: string; actual_usd: number; savings_usd: number }[];
  cost_method: string;
  carbon_confidence: "Estimated";
}

interface Row {
  user_id: string;
  task_type: string;
  model: string | null;
  in_tok: number;
  out_tok: number;
  cache_read: number;
  routable: boolean;
  route_to: string | null;
  request_fp: string | null;
  ts: string;
}

const zeroQuad = (): Quad => ({
  usd: 0,
  tokens: 0,
  kwh: { low: 0, median: 0, high: 0 },
  co2e: { low: 0, median: 0, high: 0 },
});

function addQuad(a: Quad, b: Quad) {
  a.usd += b.usd;
  a.tokens += b.tokens;
  a.kwh.low += b.kwh.low; a.kwh.median += b.kwh.median; a.kwh.high += b.kwh.high;
  a.co2e.low += b.co2e.low; a.co2e.median += b.co2e.median; a.co2e.high += b.co2e.high;
}

function subQuad(a: Quad, b: Quad): Quad {
  return {
    usd: a.usd - b.usd,
    tokens: a.tokens - b.tokens,
    kwh: { low: a.kwh.low - b.kwh.low, median: a.kwh.median - b.kwh.median, high: a.kwh.high - b.kwh.high },
    co2e: { low: a.co2e.low - b.co2e.low, median: a.co2e.median - b.co2e.median, high: a.co2e.high - b.co2e.high },
  };
}

/** Per-call cost from token metadata at published rates (cache reads cheaper). */
function callUsd(pricing: PricingSnapshot | null, model: string | null, inTok: number, outTok: number, cacheRead: number): number {
  const billable = Math.max(0, inTok - cacheRead);
  const full = priceTokens(pricing, model, billable, outTok).usd;
  const cached = priceTokens(pricing, model, cacheRead, 0).usd * CACHED_READ_RATE;
  return full + cached;
}

/** Per-call energy (kWh) range, model-weighted; cache reads at the cached weight. */
function callKwh(model: string | null, inTok: number, outTok: number, cacheRead: number) {
  const w = modelEnergyWeight(model);
  const e = CARBON_V1.energy_per_token_wh;
  const eTok = Math.max(0, inTok - cacheRead) + outTok + cacheRead * CACHED_READ_RATE;
  const wh = (perTok: number) => (eTok * perTok * w) / 1000; // Wh -> kWh
  return { low: wh(e.low), median: wh(e.median), high: wh(e.high) };
}

function kwhToCo2e(kwh: { low: number; median: number; high: number }) {
  const g = CARBON_V1.grid_intensity_g_per_kwh;
  const p = CARBON_V1.pue;
  return {
    low: kwh.low * g.low * p.low,
    median: kwh.median * g.median * p.median,
    high: kwh.high * g.high * p.high,
  };
}

function quadFor(pricing: PricingSnapshot | null, model: string | null, inTok: number, outTok: number, cacheRead: number): Quad {
  const kwh = callKwh(model, inTok, outTok, cacheRead);
  return { usd: callUsd(pricing, model, inTok, outTok, cacheRead), tokens: inTok + outTok, kwh, co2e: kwhToCo2e(kwh) };
}

async function loadRows(ctx: TenantContext, from?: string, to?: string): Promise<Row[]> {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) { params.push(from); clauses.push(`ts >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`ts <= $${params.length}`); }
  // Only true observation events feed the Observer meter: it re-derives cost
  // from token metadata, so it must not double-count intervention stage events
  // (which carry avoided-only tokens). Observe events are the raw usage record.
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")} AND ` : `WHERE `;
  const r = await ctx.db.query<{ payload: Record<string, unknown>; ts: string }>(
    `SELECT payload, ts FROM meter_events ${where} intervention_type = 'observe' ORDER BY ts ASC`,
    params,
  );
  return r.rows.map((x) => {
    const p = x.payload;
    const tokens = (p.tokens ?? {}) as Record<string, number>;
    const obs = (p.observer ?? {}) as Record<string, unknown>;
    return {
      user_id: String(p.user_id ?? "unknown"),
      task_type: String((obs.task_type as string) ?? "untyped"),
      model: (p.model_used as string) ?? (p.model_requested as string) ?? null,
      in_tok: Number(tokens.input_actual ?? 0),
      out_tok: Number(tokens.output_actual ?? 0),
      cache_read: Number((obs.cache_read_tokens as number) ?? 0),
      routable: obs.routable === true,
      route_to: (obs.route_to_model as string) ?? null,
      request_fp: (obs.request_fp as string) ?? null,
      ts: x.ts,
    };
  });
}

export async function observerMeter(
  ctx: TenantContext,
  pricing: PricingSnapshot | null,
  opts: { from?: string; to?: string } = {},
): Promise<ObserverMeter> {
  const rows = await loadRows(ctx, opts.from, opts.to);

  // dedupe detection (counts-not-content): the 2nd+ call sharing a request_fp
  // within the window is a detectable cacheable duplicate.
  const seenFp = new Set<string>();
  const isDuplicate = (r: Row) => {
    if (!r.request_fp) return false;
    if (seenFp.has(r.request_fp)) return true;
    seenFp.add(r.request_fp);
    return false;
  };

  const actual = zeroQuad();
  const potential = zeroQuad();
  let routingUsd = 0;
  let dedupeUsd = 0;
  const byUser = new Map<string, { actual_usd: number; savings_usd: number }>();
  const byType = new Map<string, { actual_usd: number; savings_usd: number }>();

  for (const r of rows) {
    const a = quadFor(pricing, r.model, r.in_tok, r.out_tok, r.cache_read);
    addQuad(actual, a);

    // potential: the evidenced-optimized version of THIS call
    let p: Quad;
    let callSavingsUsd = 0;
    if (isDuplicate(r)) {
      p = zeroQuad(); // cacheable duplicate: the whole call is avoidable
      dedupeUsd += a.usd;
      callSavingsUsd = a.usd;
    } else if (r.routable && r.route_to && priceTokens(pricing, r.route_to, 1, 0).priced) {
      p = quadFor(pricing, r.route_to, r.in_tok, r.out_tok, r.cache_read);
      routingUsd += Math.max(0, a.usd - p.usd);
      callSavingsUsd = Math.max(0, a.usd - p.usd);
    } else {
      p = a; // no evidenced optimization -> potential equals actual (zero savings)
    }
    addQuad(potential, p);

    const u = byUser.get(r.user_id) ?? { actual_usd: 0, savings_usd: 0 };
    u.actual_usd += a.usd; u.savings_usd += callSavingsUsd;
    byUser.set(r.user_id, u);
    const ty = byType.get(r.task_type) ?? { actual_usd: 0, savings_usd: 0 };
    ty.actual_usd += a.usd; ty.savings_usd += callSavingsUsd;
    byType.set(r.task_type, ty);
  }

  return {
    from: opts.from ?? null,
    to: opts.to ?? null,
    events: rows.length,
    actual,
    potential,
    savings: subQuad(actual, potential), // RECONCILES by construction
    savings_source: { routing_usd: routingUsd, dedupe_usd: dedupeUsd },
    by_user: [...byUser.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((x, y) => y.savings_usd - x.savings_usd),
    by_task_type: [...byType.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((x, y) => y.savings_usd - x.savings_usd),
    cost_method:
      "Estimated from your token usage at standard published provider rates (prompt-cache reads at the cached rate). Not a reconciliation of your actual invoice - your negotiated pricing, committed-use discounts, and credits are private to you. Savings count only evidenced optimizations (routing flagged-simple tasks to a cheaper same-provider model; detectable duplicate/cacheable calls); no speculative savings.",
    carbon_confidence: "Estimated",
  };
}

// ---------------- Routing Readiness (per task type) ----------------

export interface ReadinessRow {
  task_type: string;
  observations: number;
  routable_observations: number;
  projected_saving_usd: number; // routing $ savings seen for this type in-window
  evidence: number; // 0..1, climbs with routable observations
  ready: boolean; // crossed the confidence threshold to route safely
  threshold: number;
}

export async function routingReadiness(
  ctx: TenantContext,
  pricing: PricingSnapshot | null,
  opts: { from?: string; to?: string } = {},
): Promise<{ threshold: number; types: ReadinessRow[]; note: string }> {
  const rows = await loadRows(ctx, opts.from, opts.to);
  const agg = new Map<string, { obs: number; routable: number; saving: number }>();
  for (const r of rows) {
    const a = agg.get(r.task_type) ?? { obs: 0, routable: 0, saving: 0 };
    a.obs += 1;
    if (r.routable && r.route_to && priceTokens(pricing, r.route_to, 1, 0).priced) {
      a.routable += 1;
      const actual = callUsd(pricing, r.model, r.in_tok, r.out_tok, r.cache_read);
      const routed = callUsd(pricing, r.route_to, r.in_tok, r.out_tok, r.cache_read);
      a.saving += Math.max(0, actual - routed);
    }
    agg.set(r.task_type, a);
  }
  const types = [...agg.entries()]
    .map(([task_type, v]) => ({
      task_type,
      observations: v.obs,
      routable_observations: v.routable,
      projected_saving_usd: v.saving,
      // evidence climbs with routable observations, saturating at the threshold
      evidence: Math.min(1, v.routable / ROUTE_READY_THRESHOLD),
      // ready = enough routable evidence AND routing is a consistent pattern
      // for the type (majority of its observed calls are routable)
      ready: v.routable >= ROUTE_READY_THRESHOLD && v.routable / Math.max(1, v.obs) >= 0.6,
      threshold: ROUTE_READY_THRESHOLD,
    }))
    .sort((x, y) => y.projected_saving_usd - x.projected_saving_usd);
  return {
    threshold: ROUTE_READY_THRESHOLD,
    types,
    note: "Learned from THIS organization's own traffic (public benchmarks are unreliable). A task type becomes routable only after enough of its own calls show a cheaper model would match - the score climbs with time and data. Measurement only; automatic routing is a separate staged capability.",
  };
}
