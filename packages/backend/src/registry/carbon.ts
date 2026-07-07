/**
 * WS6 - carbon coefficient feed, v1 (credible-transparent, D8).
 *
 * Grounded ranges from the CEO doc §7 / EcoLogits-class methodology. Every
 * figure carries a confidence label; the meter NEVER emits an unlabeled
 * carbon number. Quarterly manual research review updates this file through
 * the same human-approves-diffs discipline as pricing (git diff = the diff).
 */
export interface CoefficientRange {
  low: number;
  median: number;
  high: number;
  unit: string;
  confidence: "Measured" | "Benchmarked" | "Estimated";
  source: string;
}

export interface CarbonCoefficients {
  coefficients_version: string;
  methodology: string;
  energy_per_token_wh: CoefficientRange; // short-query class
  energy_per_query_wh: CoefficientRange;
  reasoning_multiplier: CoefficientRange; // reasoning/long-output models
  grid_intensity_g_per_kwh: CoefficientRange;
  pue: CoefficientRange;
}

export const CARBON_V1: CarbonCoefficients = {
  coefficients_version: "2026-07-07",
  methodology:
    "EcoLogits-class regression estimates; ranges + disclosed assumptions per Circulara ESG methodology page. carbon = kWh x grid_intensity x PUE.",
  energy_per_token_wh: {
    low: 0.0001,
    median: 0.0003,
    high: 0.001,
    unit: "Wh/token",
    confidence: "Estimated",
    source: "EcoLogits-class regression; ~3e-4 Wh/token short-query class",
  },
  energy_per_query_wh: {
    low: 0.16,
    median: 0.31,
    high: 0.6,
    unit: "Wh/query",
    confidence: "Benchmarked",
    source: "Published medians (~0.24-0.34 Wh); IQR 0.16-0.60",
  },
  reasoning_multiplier: {
    low: 10,
    median: 70,
    high: 100,
    unit: "x short-query energy",
    confidence: "Estimated",
    source: "Reasoning/long-output models 1-2 orders of magnitude higher (33+ Wh long prompts)",
  },
  grid_intensity_g_per_kwh: {
    low: 50,
    median: 400,
    high: 700,
    unit: "gCO2e/kWh",
    confidence: "Benchmarked",
    source: "Regional grid intensity range; per-region feed post-v1",
  },
  pue: {
    low: 1.1,
    median: 1.2,
    high: 1.5,
    unit: "ratio",
    confidence: "Benchmarked",
    source: "Typical datacenter PUE range",
  },
};
