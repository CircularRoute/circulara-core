/**
 * WS5 - savings-potential estimator (Observe's headline artifact).
 *
 * Observed baseline x technique benchmark ranges (CEO doc §6.1), composed
 * multiplicatively (techniques overlap; naive summing overstates):
 *   combined = 1 - PRODUCT(1 - t_i)
 * Presented as a RANGE with per-technique breakdown and disclosed assumptions
 * (same discipline as carbon, D8). All figures confidence = Benchmarked -
 * these are published-benchmark ranges, not measurements of this workload.
 */
export interface TechniquePotential {
  key: string;
  label: string;
  low: number; // fraction of observed spend
  high: number;
  assumption: string;
}

export const TECHNIQUE_BENCHMARKS: TechniquePotential[] = [
  {
    key: "prompt_cache",
    label: "Provider prompt caching",
    low: 0.05,
    high: 0.15,
    assumption:
      "Configuring provider-native prefix caching on repeated context (up to ~90% discount on repeated input tokens at high hit rates)",
  },
  {
    key: "routing",
    label: "Model routing / right-sizing",
    low: 0.1,
    high: 0.25,
    assumption:
      "Routing simple work to cheaper models (~85% of queries routable with <5% quality loss on benchmarks)",
  },
  {
    key: "compression",
    label: "Prompt compression + context pruning",
    low: 0.1,
    high: 0.25,
    assumption:
      "LLMLingua-class compression (2-20x on prose) + targeted retrieval instead of file dumps; conservative share of input spend",
  },
  {
    key: "caching",
    label: "Response + tool-call caching",
    low: 0.05,
    high: 0.2,
    assumption:
      "Exact + gated semantic response cache and deterministic tool-call cache (73-90% reported in high-repetition workloads; conservative for mixed workloads)",
  },
  {
    key: "reuse",
    label: "Reuse library (buy-or-build)",
    low: 0.05,
    high: 0.15,
    assumption:
      "An org-scoped library of already-produced assets (embeddings, parsed docs, datasets, research, tool results) so no agent regenerates what another already made. Starts small and compounds as your library grows.",
  },
];

export interface SavingsPotential {
  observed_usd: number;
  combined_low_pct: number; // e.g. 0.27
  combined_high_pct: number;
  potential_low_usd: number;
  potential_high_usd: number;
  typical_note: string;
  techniques: (TechniquePotential & {
    potential_low_usd: number;
    potential_high_usd: number;
  })[];
  confidence: "Benchmarked";
  methodology_note: string;
}

export function savingsPotential(observedUsd: number): SavingsPotential {
  const combinedLow = 1 - TECHNIQUE_BENCHMARKS.reduce((p, t) => p * (1 - t.low), 1);
  const combinedHigh = 1 - TECHNIQUE_BENCHMARKS.reduce((p, t) => p * (1 - t.high), 1);
  return {
    observed_usd: observedUsd,
    combined_low_pct: combinedLow,
    combined_high_pct: combinedHigh,
    potential_low_usd: observedUsd * combinedLow,
    potential_high_usd: observedUsd * combinedHigh,
    typical_note:
      "Most fleets should expect the conservative end first: 30-40% is the typical realized range once Reduce + Recycle are enabled; the Reuse library compounds beyond that over time.",
    techniques: TECHNIQUE_BENCHMARKS.map((t) => ({
      ...t,
      potential_low_usd: observedUsd * t.low,
      potential_high_usd: observedUsd * t.high,
    })),
    confidence: "Benchmarked",
    methodology_note: "",
  };
}
