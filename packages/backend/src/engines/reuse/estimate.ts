/**
 * Wave 5 - estimate_build_cost (§6.4): the crux that makes reuse rational.
 *
 *   build_cost = expected_tokens x model price          (generation/embedding)
 *              + external API/proxy fees                (scraping, paid APIs)
 *              + value of expected wall-clock time      (latency cost)
 *              + failure-risk premium                   (retries, variance)
 *
 * Every term is caller-supplied or conservatively defaulted; the estimator
 * never inflates to make reuse look better - buy_threshold <= 0.70 does the
 * safety work (§6.4: only reuse obvious wins).
 */
import type { PricingSnapshot } from "../../registry/pricing.js";
import { priceTokens } from "../../meter/compute.js";

export interface BuildEstimateInput {
  expected_input_tokens?: number;
  expected_output_tokens?: number;
  model?: string; // model that would do the work
  external_fees_usd?: number; // paid APIs, scraping infra
  expected_wall_clock_seconds?: number;
  wall_clock_usd_per_hour?: number; // value of waiting; default $0 (conservative)
  failure_risk?: number; // 0..1 expected retry overhead; default 0.15
}

export interface BuildEstimate {
  total_usd: number;
  parts: {
    tokens_usd: number;
    external_fees_usd: number;
    wall_clock_usd: number;
    failure_premium_usd: number;
  };
}

export function estimateBuildCost(
  pricing: PricingSnapshot | null,
  input: BuildEstimateInput,
): BuildEstimate {
  const tokensUsd = input.model
    ? priceTokens(
        pricing,
        input.model,
        input.expected_input_tokens ?? 0,
        input.expected_output_tokens ?? 0,
      ).usd
    : 0;
  const fees = input.external_fees_usd ?? 0;
  const wallClock =
    ((input.expected_wall_clock_seconds ?? 0) / 3600) *
    (input.wall_clock_usd_per_hour ?? 0);
  const base = tokensUsd + fees + wallClock;
  const premium = base * (input.failure_risk ?? 0.15);
  return {
    total_usd: base + premium,
    parts: {
      tokens_usd: tokensUsd,
      external_fees_usd: fees,
      wall_clock_usd: wallClock,
      failure_premium_usd: premium,
    },
  };
}
