/**
 * builder.20260716.001 - model-WASTE detector (Observe / free tier).
 *
 * Flags WASTEFUL behaviour: sending a trivial task to a top-tier model when a
 * cheaper same-provider model would have matched it. Pure REDUCE story - the
 * point of the circular fleet is to not spend a premium token on a job a
 * commodity token does fine.
 *
 * ADVISORY ONLY. This never blocks, throttles, or reroutes a call. It surfaces a
 * pattern to the admin and feeds Routing Readiness evidence. Automatic routing is
 * a separate, staged capability (task 012).
 *
 * COUNTS, NOT CONTENT (brief §2): every input is metadata already on the observe
 * event - token counts, model id, seat/identity, task-type label, and an OPTIONAL
 * tool-call COUNT. No prompt, output, or file text is read. The heuristic cannot
 * see WHAT the task was, only that a big model did a tiny amount of work.
 *
 * SEPARATE FROM REALIZED SAVINGS: the dollar figure here is an ESTIMATE of
 * avoidable spend ("if you routed this pattern..."), computed at aggregation time
 * from observe rows. It is NEVER written back as a meter event and NEVER folds
 * into realized avoided_usd - the meter's integrity is load-bearing.
 */
import type { TenantContext } from "../db/tenancy.js";
import {
  type PricingSnapshot,
  topTierModels,
  cheapestSameProvider,
  resolveModelKey,
} from "../registry/pricing.js";
import type { TenantPolicy } from "../engines/policy.js";
import { priceTokens } from "./compute.js";
import { loadRows, type Row } from "./observer.js";

export type WastePolicy = TenantPolicy["waste"];

/**
 * Size sub-bucket for grouping repeated same-shaped calls into one pattern.
 * Candidates are already tiny (below the policy ceilings); this splits them so a
 * burst of ~identical little calls collapses into a single actionable pattern.
 */
export function sizeBucket(inTok: number, outTok: number): string {
  const inB = inTok <= 50 ? "in<=50" : "in<=200";
  const outB = outTok <= 100 ? "out<=100" : "out<=300";
  return `${inB}/${outB}`;
}

/**
 * The WASTE signature (all metadata): tiny input + tiny output + a top-price-tier
 * model + a HUMAN seat + no tool calls. A reported positive tool-call count exempts
 * the call (agentic work earns the big model); an ABSENT count (older plugins) is
 * "no tool signal", not a disqualifier - the tiny-input filter already excludes
 * most agentic calls.
 */
export function isWasteCandidate(
  row: Row,
  opts: { topTier: Set<string>; policy: WastePolicy },
): boolean {
  const { topTier, policy } = opts;
  if (!policy.enabled) return false;
  if (row.identity_type !== "human") return false;
  if (!row.model || !topTier.has(row.model)) return false;
  if (row.in_tok > policy.max_input_tokens) return false;
  if (row.out_tok > policy.max_output_tokens) return false;
  if (policy.require_zero_tools && typeof row.tool_calls === "number" && row.tool_calls > 0)
    return false;
  return true;
}

export interface Counterfactual {
  counterfactual_model: string;
  actual_usd: number;
  counterfactual_usd: number;
  saving_usd: number; // actual - counterfactual (>= 0)
}

/**
 * What this call would have cost on the cheapest same-provider model, and the
 * avoidable delta. Prices both models on the SAME token counts (apples-to-apples,
 * clearly an estimate). Returns null if the model is unknown or already cheapest.
 */
export function counterfactual(
  row: Row,
  pricing: PricingSnapshot | null,
): Counterfactual | null {
  if (!pricing || !row.model) return null;
  const cheaper = cheapestSameProvider(pricing, row.model);
  if (!cheaper) return null;
  const actual = priceTokens(pricing, row.model, row.in_tok, row.out_tok);
  const cf = priceTokens(pricing, cheaper.id, row.in_tok, row.out_tok);
  if (!actual.priced || !cf.priced) return null;
  const saving = Math.max(0, actual.usd - cf.usd);
  return {
    counterfactual_model: cheaper.id,
    actual_usd: actual.usd,
    counterfactual_usd: cf.usd,
    saving_usd: saving,
  };
}

export interface WastePattern {
  pattern_key: string; // stable id for dismissal: seat|task_type|size_bucket
  seat_id: string;
  user_id: string;
  task_type: string;
  model: string; // the top-tier model being used
  counterfactual_model: string; // the cheaper same-provider model
  size_bucket: string;
  occurrences: number;
  active_days: number; // distinct calendar days the pattern appeared on
  recurring: boolean; // seen on >= 2 distinct days (not a one-off)
  observed_saving_usd: number; // avoidable spend over the window
  projected_monthly_usd: number | null; // if recurring, scaled to 30 active days
  confidence: "low" | "medium"; // metadata-only ceiling is "medium"
  dismissed: boolean;
}

export interface WasteReport {
  enabled: boolean;
  basis: "estimated";
  method: string;
  from: string | null;
  to: string | null;
  candidate_calls: number;
  patterns: WastePattern[]; // non-dismissed first, then dismissed; each sorted by $
  observed_saving_usd: number; // sum over non-dismissed patterns
  projected_monthly_usd: number; // sum over non-dismissed recurring patterns
  precision: number | null; // 1 - dismissed/total patterns (admin feedback loop)
}

const METHOD =
  "Heuristic from call metadata only (token counts, model, seat, tool-call count) - never prompt or output content. A 'waste' candidate is a tiny task run on a top-tier model that a cheaper same-provider model would match. Dollars are an ESTIMATE of avoidable spend at published rates, not realized savings.";

/** pattern_keys an admin has dismissed (false positive / accepted-as-intended). */
export async function loadDismissed(ctx: TenantContext): Promise<Set<string>> {
  const r = await ctx.db.query<{ pattern_key: string }>(
    `SELECT pattern_key FROM waste_dismissals`,
  );
  return new Set(r.rows.map((x) => x.pattern_key));
}

export async function dismissPattern(
  ctx: TenantContext,
  patternKey: string,
  by: string,
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO waste_dismissals (pattern_key, dismissed_by) VALUES ($1, $2)
     ON CONFLICT (pattern_key) DO NOTHING`,
    [patternKey, by],
  );
}

export async function undismissPattern(
  ctx: TenantContext,
  patternKey: string,
): Promise<void> {
  await ctx.db.query(`DELETE FROM waste_dismissals WHERE pattern_key = $1`, [
    patternKey,
  ]);
}

interface Agg {
  seat_id: string;
  user_id: string;
  task_type: string;
  size_bucket: string;
  model: string;
  counterfactual_model: string;
  occurrences: number;
  days: Set<string>;
  saving_usd: number;
}

/**
 * Aggregate waste candidates from observe rows into actionable patterns.
 * `dismissed` = pattern_keys an admin has waved off (feedback loop / precision).
 */
export async function wasteReport(
  ctx: TenantContext,
  pricing: PricingSnapshot | null,
  policy: TenantPolicy,
  opts: { from?: string; to?: string; dismissed?: Set<string> } = {},
): Promise<WasteReport> {
  const wp = policy.waste;
  const base: Omit<WasteReport, "patterns"> & { patterns: WastePattern[] } = {
    enabled: wp.enabled,
    basis: "estimated",
    method: METHOD,
    from: opts.from ?? null,
    to: opts.to ?? null,
    candidate_calls: 0,
    patterns: [],
    observed_saving_usd: 0,
    projected_monthly_usd: 0,
    precision: null,
  };
  if (!wp.enabled || !pricing) return base;

  const rows = await loadRows(ctx, opts.from, opts.to);
  const topTier = topTierModels(pricing, wp.price_ratio);
  const dismissed = opts.dismissed ?? new Set<string>();

  const groups = new Map<string, Agg>();
  let candidateCalls = 0;
  for (const raw of rows) {
    // normalize the model id to its canonical snapshot key so the tier check and
    // counterfactual compare like-for-like (bare "claude-..." vs "anthropic/claude-...")
    const canonical = resolveModelKey(pricing, raw.model);
    const r: Row = canonical ? { ...raw, model: canonical } : raw;
    if (!isWasteCandidate(r, { topTier, policy: wp })) continue;
    const cf = counterfactual(r, pricing);
    if (!cf || cf.saving_usd <= 0) continue; // no cheaper alternative -> not waste
    candidateCalls += 1;
    const bucket = sizeBucket(r.in_tok, r.out_tok);
    const key = `${r.seat_id}|${r.task_type}|${bucket}`;
    const g = groups.get(key) ?? {
      seat_id: r.seat_id,
      user_id: r.user_id,
      task_type: r.task_type,
      size_bucket: bucket,
      model: r.model as string,
      counterfactual_model: cf.counterfactual_model,
      occurrences: 0,
      days: new Set<string>(),
      saving_usd: 0,
    };
    g.occurrences += 1;
    // ts is a string (API path) or a Date (pg/PGlite timestamptz); normalize to
    // a calendar day so "repeated ~daily" counts distinct days robustly.
    g.days.add(new Date(r.ts).toISOString().slice(0, 10));
    g.saving_usd += cf.saving_usd;
    groups.set(key, g);
  }

  const patterns: WastePattern[] = [];
  for (const [key, g] of groups) {
    const activeDays = g.days.size;
    const recurring = activeDays >= 2;
    // conservative projection: per-active-day saving x 30, ONLY when recurring
    // (never extrapolate a whole month from a single day's spike).
    const projected = recurring
      ? (g.saving_usd / activeDays) * 30
      : null;
    const confidence: "low" | "medium" =
      g.occurrences >= 5 && activeDays >= 3 ? "medium" : "low";
    patterns.push({
      pattern_key: key,
      seat_id: g.seat_id,
      user_id: g.user_id,
      task_type: g.task_type,
      model: g.model,
      counterfactual_model: g.counterfactual_model,
      size_bucket: g.size_bucket,
      occurrences: g.occurrences,
      active_days: activeDays,
      recurring,
      observed_saving_usd: g.saving_usd,
      projected_monthly_usd: projected,
      confidence,
      dismissed: dismissed.has(key),
    });
  }

  // non-dismissed first, each block sorted by projected (fallback observed) $ desc
  const score = (p: WastePattern) => p.projected_monthly_usd ?? p.observed_saving_usd;
  patterns.sort((a, b) => {
    if (a.dismissed !== b.dismissed) return a.dismissed ? 1 : -1;
    return score(b) - score(a);
  });

  const live = patterns.filter((p) => !p.dismissed);
  const observed = live.reduce((s, p) => s + p.observed_saving_usd, 0);
  const projectedMonthly = live.reduce(
    (s, p) => s + (p.projected_monthly_usd ?? 0),
    0,
  );
  const total = patterns.length;
  const dismissedCount = patterns.length - live.length;

  return {
    ...base,
    candidate_calls: candidateCalls,
    patterns,
    observed_saving_usd: observed,
    projected_monthly_usd: projectedMonthly,
    precision: total > 0 ? 1 - dismissedCount / total : null,
  };
}
