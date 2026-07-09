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

/** Measured savings signals from THIS org's observed traffic (observer meter).
 * Where present, they REPLACE the generic benchmark for that technique, so the
 * potential becomes customer-specific instead of an industry average. */
export interface PotentialSignals {
  routingUsd?: number; // measured routing-to-cheaper-model savings
  dedupeUsd?: number; // measured exact duplicate/cacheable-call savings
}

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
    measured: boolean; // true = derived from your traffic, not a benchmark
  })[];
  confidence: "Benchmarked" | "Blended";
  basis: "benchmarked" | "blended";
  methodology_note: string;
}

/**
 * Blended estimate: for the techniques we can SEE in your metadata (routing to a
 * cheaper model, exact duplicate/cacheable calls) we use the MEASURED fraction of
 * your own spend; for the rest (compression, provider prompt caching, the reuse
 * library - which need prompt content or assets we never read) we fall back to
 * published benchmarks. Composed multiplicatively so overlapping wins never
 * double-count. Same call with no signals = pure benchmark (backward compatible).
 */
export function savingsPotential(
  observedUsd: number,
  signals: PotentialSignals = {},
): SavingsPotential {
  const measuredFrac = (v: number | undefined, cap: number): number | null =>
    observedUsd > 0 && (v ?? 0) > 0 ? Math.min((v as number) / observedUsd, cap) : null;

  const techs = TECHNIQUE_BENCHMARKS.map((t) => {
    if (t.key === "routing") {
      const m = measuredFrac(signals.routingUsd, t.high);
      if (m != null) return { ...t, low: m, high: m, measured: true };
    }
    if (t.key === "caching") {
      const exact = measuredFrac(signals.dedupeUsd, t.high);
      if (exact != null) {
        // exact duplicates measured; keep a small residual for semantic/near-dup
        // caching we cannot detect from metadata alone
        return { ...t, low: Math.min(exact + 0.02, t.high), high: Math.min(exact + 0.08, t.high), measured: true };
      }
    }
    return { ...t, measured: false };
  });

  const combinedLow = 1 - techs.reduce((p, t) => p * (1 - t.low), 1);
  const combinedHigh = 1 - techs.reduce((p, t) => p * (1 - t.high), 1);
  const blended = techs.some((t) => t.measured);

  return {
    observed_usd: observedUsd,
    combined_low_pct: combinedLow,
    combined_high_pct: combinedHigh,
    potential_low_usd: observedUsd * combinedLow,
    potential_high_usd: observedUsd * combinedHigh,
    typical_note: blended
      ? "Refined from your own traffic where Circulara can measure it (routing to cheaper models, duplicate/cacheable calls), plus published benchmarks for what needs your prompts or assets (compression, provider prompt caching, the reuse library). An estimate, not a guarantee."
      : "Most fleets should expect the conservative end first: 30-40% is the typical realized range once Reduce + Recycle are enabled; the Reuse library compounds beyond that over time.",
    techniques: techs.map((t) => ({
      ...t,
      potential_low_usd: observedUsd * t.low,
      potential_high_usd: observedUsd * t.high,
    })),
    confidence: blended ? "Blended" : "Benchmarked",
    basis: blended ? "blended" : "benchmarked",
    methodology_note: "",
  };
}
