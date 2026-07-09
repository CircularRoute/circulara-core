/**
 * WS4 - meter report: per user / team / module / month attribution (§7),
 * observed baseline + avoided figures, energy/CO2e as RANGES with confidence
 * labels and disclosed methodology (D8: credible-transparent, never a single
 * confident carbon number). This is the data feed for the Observe dashboard
 * (WS5) and the savings-potential report.
 */
import type { TenantContext } from "../db/tenancy.js";
import {
  estimateEnergyCarbon,
  type EnergyCarbonEstimate,
} from "./compute.js";
import { isOverSeatCap } from "../pipeline/normalize.js";

interface Slice {
  key: string;
  events: number;
  tokens: number;
  observed_usd: number;
  avoided_usd: number;
}

export interface MeterReport {
  month: string | null; // YYYY-MM filter, null = all time
  events: number;
  tokens_observed: number;
  observed_usd: number;
  avoided_usd: number;
  external_spend_usd: number;
  observed_impact: EnergyCarbonEstimate; // ranges + confidence, observed baseline
  avoided_impact: EnergyCarbonEstimate; // ranges + confidence, from avoided tokens
  by_user: Slice[];
  by_team: Slice[];
  by_module: Slice[];
  by_model: Slice[];
  by_provider: Slice[];
  by_month: Slice[];
  over_seat_cap: boolean; // QA m4: WS5 renders banner + report watermark
  /** QA MJ6: the WORST basis among avoided-cost events - the export must never
   * label a figure more certain than its weakest input. */
  avoided_cost_basis: "measured" | "estimated" | "upper_bound";
  avoided_usd_by_basis: Record<string, number>;
  methodology_note: string;
}

const MODEL_EXPR = `lower(coalesce(payload->>'model_used', payload->>'model_requested',''))`;
const SLICE_SQL: Record<string, string> = {
  by_user: `coalesce(payload->>'user_id','unknown')`,
  by_team: `coalesce(payload->>'team_id','(no team)')`,
  by_module: `module`,
  by_model: `coalesce(payload->>'model_used', payload->>'model_requested', '(unknown)')`,
  // provider derived from the model name (Observe never needs a provider field)
  by_provider: `CASE
      WHEN ${MODEL_EXPR} LIKE 'claude%' THEN 'Anthropic'
      WHEN ${MODEL_EXPR} LIKE 'gpt%' OR ${MODEL_EXPR} LIKE 'o1%' OR ${MODEL_EXPR} LIKE 'o3%' OR ${MODEL_EXPR} LIKE 'o4%' THEN 'OpenAI'
      WHEN ${MODEL_EXPR} LIKE 'gemini%' THEN 'Google'
      WHEN ${MODEL_EXPR} = '' THEN '(unknown)'
      ELSE 'Other'
    END`,
  by_month: `to_char(ts, 'YYYY-MM')`,
};

export async function meterReport(
  ctx: TenantContext,
  month?: string,
): Promise<MeterReport> {
  const where = month ? `WHERE to_char(ts, 'YYYY-MM') = $1` : ``;
  const params = month ? [month] : [];

  const totals = await ctx.db.query<{
    events: number;
    tokens: string;
    avoided_tokens: string;
    observed_usd: string;
    avoided_usd: string;
    external_spend_usd: string;
  }>(
    `SELECT count(*)::int AS events,
            coalesce(sum((payload->'tokens'->>'input_actual')::bigint
                       + (payload->'tokens'->>'output_actual')::bigint),0)::text AS tokens,
            coalesce(sum((payload->'tokens'->>'input_counterfactual')::bigint
                       + (payload->'tokens'->>'output_counterfactual')::bigint
                       - (payload->'tokens'->>'input_actual')::bigint
                       - (payload->'tokens'->>'output_actual')::bigint),0)::text AS avoided_tokens,
            coalesce(sum(actual_usd),0)::text AS observed_usd,
            coalesce(sum(avoided_usd),0)::text AS avoided_usd,
            coalesce(sum(sourcing_spend_usd),0)::text AS external_spend_usd
       FROM meter_events ${where}`,
    params,
  );

  const slice = async (expr: string): Promise<Slice[]> => {
    const r = await ctx.db.query<{
      key: string;
      events: number;
      tokens: string;
      observed_usd: string;
      avoided_usd: string;
    }>(
      `SELECT ${expr} AS key,
              count(*)::int AS events,
              coalesce(sum((payload->'tokens'->>'input_actual')::bigint
                         + (payload->'tokens'->>'output_actual')::bigint),0)::text AS tokens,
              coalesce(sum(actual_usd),0)::text AS observed_usd,
              coalesce(sum(avoided_usd),0)::text AS avoided_usd
         FROM meter_events ${where}
        GROUP BY 1 ORDER BY 4 DESC`,
      params,
    );
    return r.rows.map((x) => ({
      key: x.key,
      events: x.events,
      tokens: Number(x.tokens),
      observed_usd: Number(x.observed_usd),
      avoided_usd: Number(x.avoided_usd),
    }));
  };

  const t = totals.rows[0];
  const tokensObserved = Number(t.tokens);
  const tokensAvoided = Math.max(0, Number(t.avoided_tokens));

  // QA MJ6: aggregate avoided dollars by declared basis (absent = measured)
  const basisRows = await ctx.db.query<{ basis: string | null; s: string }>(
    `SELECT payload->'cost'->>'basis' AS basis, coalesce(sum(avoided_usd),0)::text AS s
       FROM meter_events ${where} ${month ? "AND" : "WHERE"} avoided_usd > 0
      GROUP BY 1`,
    params,
  );
  const byBasis: Record<string, number> = {};
  for (const r of basisRows.rows) byBasis[r.basis ?? "measured"] = Number(r.s);
  const ORDER = ["measured", "estimated", "upper_bound"] as const;
  const worst =
    ORDER.filter((b) => (byBasis[b] ?? 0) > 0).pop() ?? "measured";

  return {
    month: month ?? null,
    events: t.events,
    tokens_observed: tokensObserved,
    observed_usd: Number(t.observed_usd),
    avoided_usd: Number(t.avoided_usd),
    external_spend_usd: Number(t.external_spend_usd),
    observed_impact: estimateEnergyCarbon(tokensObserved),
    avoided_impact: estimateEnergyCarbon(tokensAvoided),
    by_user: await slice(SLICE_SQL.by_user),
    by_team: await slice(SLICE_SQL.by_team),
    by_module: await slice(SLICE_SQL.by_module),
    by_model: await slice(SLICE_SQL.by_model),
    by_provider: await slice(SLICE_SQL.by_provider),
    by_month: await slice(SLICE_SQL.by_month),
    over_seat_cap: await isOverSeatCap(ctx),
    avoided_cost_basis: worst,
    avoided_usd_by_basis: byBasis,
    methodology_note:
      "Energy and CO2e are estimated ranges (low/median/high) from EcoLogits-class " +
      "coefficients with per-figure confidence labels; assumptions disclosed on the " +
      "methodology page. Ranges, not point claims, by design.",
  };
}
