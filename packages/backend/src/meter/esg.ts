/**
 * Wave 7 - ESG-ready impact export (credible-transparent v1, D8).
 *
 * The rules that make this survive scrutiny (§7):
 *  - every figure is a RANGE (low/median/high) with a per-figure confidence
 *    label (Measured / Benchmarked / Estimated) and a named source
 *  - assumptions are DISCLOSED, methodology is published, coefficients are
 *    versioned (EcoLogits/Jegham-class open methodologies)
 *  - cumulative + intensity at fleet scale, never per-query point claims
 *  - audit-grade (CSRD/ESRS-E1 pack, +25%) is BUILT ON FIRST CUSTOMER PULL -
 *    the seam is this module's shape; only the disclosure pack is added.
 */
import type { MeterReport } from "./report.js";
import { CARBON_V1 } from "../registry/carbon.js";

interface Figure {
  low: number;
  median: number;
  high: number;
  unit: string;
  confidence: "Measured" | "Benchmarked" | "Estimated";
  source: string;
}

export interface EsgExport {
  organization: string;
  period: string; // YYYY-MM or "all-time"
  generated_at: string;
  methodology: {
    name: string;
    coefficients_version: string;
    formula: string;
    sources: string[];
    assumptions: string[];
  };
  totals: {
    tokens_observed: number;
    tokens_avoided: number;
    observed_spend_usd: number;
    avoided_cost_usd: number;
    /** QA MJ6: how certain the avoided figure is - the WORST basis among its
     * inputs, plus the per-basis breakdown. Never overstated. */
    avoided_cost_basis: "measured" | "estimated" | "upper_bound";
    avoided_usd_by_basis: Record<string, number>;
    external_data_spend_usd: number; // own line, never netted (AD12)
  };
  impact: {
    observed_energy: Figure;
    observed_co2e: Figure;
    avoided_energy: Figure;
    avoided_co2e: Figure;
  };
  intensity: {
    co2e_g_per_1k_tokens: Figure;
  };
  disclosure_note: string;
  audit_grade: { available: false; note: string };
}

const fig = (
  r: { low: number; median: number; high: number; unit: string; confidence: Figure["confidence"] },
  source: string,
): Figure => ({ ...r, source });

export function esgExport(
  report: MeterReport,
  organization: string,
): EsgExport {
  const c = CARBON_V1;
  const per1k = (x: number) =>
    report.tokens_observed > 0 ? (x / report.tokens_observed) * 1000 : 0;
  return {
    organization,
    period: report.month ?? "all-time",
    generated_at: new Date().toISOString(),
    methodology: {
      name: "Circulara credible-transparent v1 (EcoLogits/Jegham-class regression estimates)",
      coefficients_version: c.coefficients_version,
      formula: "co2e = tokens x energy_per_token x grid_intensity x PUE; each factor carried as a low/median/high range",
      sources: [
        c.energy_per_token_wh.source,
        c.energy_per_query_wh.source,
        c.grid_intensity_g_per_kwh.source,
        c.pue.source,
      ],
      assumptions: [
        "provider-side energy per token is not disclosed by providers; regression-based estimates with published ranges are used",
        "grid intensity uses a global range pending per-region deployment metadata (region field exists on every event)",
        `PUE assumed in the ${c.pue.low}-${c.pue.high} range typical of hyperscale datacenters`,
        "avoided figures derive from metered avoided tokens - interventions are logged per event with counterfactual accounting (AD4)",
      ],
    },
    totals: {
      tokens_observed: report.tokens_observed,
      tokens_avoided: Math.round(
        report.avoided_impact.energy_kwh.median > 0 && c.energy_per_token_wh.median > 0
          ? (report.avoided_impact.energy_kwh.median * 1000) / c.energy_per_token_wh.median
          : 0,
      ),
      observed_spend_usd: report.observed_usd,
      avoided_cost_usd: report.avoided_usd,
      avoided_cost_basis: report.avoided_cost_basis,
      avoided_usd_by_basis: report.avoided_usd_by_basis,
      external_data_spend_usd: report.external_spend_usd,
    },
    impact: {
      observed_energy: fig(report.observed_impact.energy_kwh, c.energy_per_token_wh.source),
      observed_co2e: fig(report.observed_impact.co2e_g, c.grid_intensity_g_per_kwh.source),
      avoided_energy: fig(report.avoided_impact.energy_kwh, c.energy_per_token_wh.source),
      avoided_co2e: fig(report.avoided_impact.co2e_g, c.grid_intensity_g_per_kwh.source),
    },
    intensity: {
      co2e_g_per_1k_tokens: {
        low: per1k(report.observed_impact.co2e_g.low),
        median: per1k(report.observed_impact.co2e_g.median),
        high: per1k(report.observed_impact.co2e_g.high),
        unit: "gCO2e/1k tokens",
        confidence: report.observed_impact.co2e_g.confidence,
        source: "derived from observed co2e range over observed tokens",
      },
    },
    disclosure_note:
      "Figures are estimated ranges with disclosed assumptions, suitable for internal tracking and most sustainability reporting. They are not audit-grade assurance figures. A confident single number would be less honest, not more.",
    audit_grade: {
      available: false,
      note: "Audit-grade module (assurance documentation, per-model coefficient sourcing, CSRD/ESRS-E1 disclosure pack) is a paid add-on (+25%) built on first customer pull (D8).",
    },
  };
}

/** Flat CSV for spreadsheet-native sustainability teams. */
export function esgExportCsv(e: EsgExport): string {
  const rows: string[][] = [
    ["metric", "low", "median", "high", "unit", "confidence", "source"],
    ...Object.entries(e.impact).map(([k, f]) => [
      k, String(f.low), String(f.median), String(f.high), f.unit, f.confidence, f.source,
    ]),
    [
      "co2e_g_per_1k_tokens",
      String(e.intensity.co2e_g_per_1k_tokens.low),
      String(e.intensity.co2e_g_per_1k_tokens.median),
      String(e.intensity.co2e_g_per_1k_tokens.high),
      e.intensity.co2e_g_per_1k_tokens.unit,
      e.intensity.co2e_g_per_1k_tokens.confidence,
      e.intensity.co2e_g_per_1k_tokens.source,
    ],
    ["tokens_observed", "", String(e.totals.tokens_observed), "", "tokens", "Measured", "meter events"],
    ["observed_spend_usd", "", String(e.totals.observed_spend_usd), "", "USD", "Measured", "meter events"],
    ["avoided_cost_usd", "", String(e.totals.avoided_cost_usd), "", "USD",
      e.totals.avoided_cost_basis === "measured" ? "Measured" : e.totals.avoided_cost_basis === "estimated" ? "Estimated" : "Upper bound",
      "meter events (counterfactual accounting, AD4); basis = worst input basis (MJ6)"],
    ["external_data_spend_usd", "", String(e.totals.external_data_spend_usd), "", "USD", "Measured", "itemized purchases (AD12, never netted)"],
  ];
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
}
