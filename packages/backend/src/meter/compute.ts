/**
 * WS4 - meter compute.
 *
 * PRICING PLACEMENT (sprint-3 decision, per the sprint-2 WS3 note): pricing
 * lives HERE, not at the capture edges. Every capture path (hook, gateway,
 * tool) delivers tokens + model; this module prices them from the APPROVED
 * registry snapshot and computes energy/CO2e ranges with confidence labels
 * (§7, D8). Rationale: one code path -> identical treatment for all captures,
 * pricing_version stamped consistently, and re-pricing of client-priced
 * events is impossible to skip. Gateways no longer price synchronously.
 *
 * Energy/carbon: EcoLogits-class coefficient ranges (CARBON_V1). The meter
 * NEVER emits an unlabeled carbon figure; ranges (low/median/high) travel
 * with every number. Observe events: counterfactual = actual, avoided = 0.
 */
import type { PricingSnapshot } from "../registry/pricing.js";
import { CARBON_V1, type CarbonCoefficients } from "../registry/carbon.js";

export interface PricedCost {
  usd: number;
  pricing_version: string;
  priced: boolean; // false when the model is unknown to the snapshot
}

export function priceTokens(
  pricing: PricingSnapshot | null,
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): PricedCost {
  if (!pricing || !model)
    return { usd: 0, pricing_version: pricing?.pricing_version ?? "unpriced", priced: false };
  const entry =
    pricing.models[model] ??
    pricing.models[`anthropic/${model}`] ??
    pricing.models[`openai/${model}`] ??
    null;
  if (!entry)
    return { usd: 0, pricing_version: pricing.pricing_version, priced: false };
  return {
    usd:
      inputTokens * entry.input_cost_per_token +
      outputTokens * entry.output_cost_per_token,
    pricing_version: pricing.pricing_version,
    priced: true,
  };
}

export interface EnergyCarbonRange {
  low: number;
  median: number;
  high: number;
  unit: string;
  confidence: "Measured" | "Benchmarked" | "Estimated";
}

export interface EnergyCarbonEstimate {
  energy_kwh: EnergyCarbonRange;
  co2e_g: EnergyCarbonRange;
  method: string;
  coefficients_version: string;
}

/** Token count -> energy/CO2e RANGES with confidence labels (§7 chain). */
export function estimateEnergyCarbon(
  totalTokens: number,
  coeff: CarbonCoefficients = CARBON_V1,
): EnergyCarbonEstimate {
  const e = coeff.energy_per_token_wh;
  const g = coeff.grid_intensity_g_per_kwh;
  const p = coeff.pue;
  const kwh = (x: number) => (totalTokens * x) / 1000;
  const energy = { low: kwh(e.low), median: kwh(e.median), high: kwh(e.high) };
  return {
    energy_kwh: {
      ...energy,
      unit: "kWh",
      confidence: e.confidence,
    },
    co2e_g: {
      low: energy.low * g.low * p.low,
      median: energy.median * g.median * p.median,
      high: energy.high * g.high * p.high,
      unit: "gCO2e",
      confidence: mostConservative(e.confidence, g.confidence, p.confidence),
    },
    method: coeff.methodology,
    coefficients_version: coeff.coefficients_version,
  };
}

const ORDER = { Measured: 0, Benchmarked: 1, Estimated: 2 } as const;
function mostConservative(
  ...labels: ("Measured" | "Benchmarked" | "Estimated")[]
) {
  return labels.sort((a, b) => ORDER[b] - ORDER[a])[0];
}
