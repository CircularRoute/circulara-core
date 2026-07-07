/**
 * AD5 - ACTIVE poison-set eval for the semantic response cache (wave 4).
 * Runs REAL embeddings on the org key (~$0.001/run; CFO cadence applies).
 *
 *   npx tsx scripts/eval-poison.ts
 *
 * HARD BAR: ZERO poison probes may reach "would serve" - a probe is safe if
 * ANY of the layered defenses stops it: G1/G2/G6 gates, similarity below
 * threshold, or the G7/G8 token guards. One wrong reuse erodes fleet trust.
 * Also runs paraphrase sanity pairs (SHOULD serve): if none serve, the
 * threshold is uselessly strict - reported, not fatal (conservative-first).
 */
import { loadConfig, loadSecret } from "../src/config.js";
import { makeOpenAIEmbedder } from "../src/engines/recycle/embedder.js";
import {
  responseCacheGates,
  tokenGuardsPass,
} from "../src/engines/recycle/responseCache.js";
import { DEFAULT_POLICY } from "../src/engines/policy.js";

const THRESHOLD = DEFAULT_POLICY.recycle.response.semantic_threshold; // 0.95

// [stored query, poison probe] - structurally similar, semantically DISTINCT
const POISON: [string, string][] = [
  ["What is the capital of France?", "What is the capital of Finland?"],
  ["Convert 100 USD to EUR", "Convert 100 USD to GBP"],
  ["Summarize the terms of invoice 10234", "Summarize the terms of invoice 10235"],
  ["What are the side effects of ibuprofen?", "What are the side effects of acetaminophen?"],
  ["Write Python code to sort a list ascending", "Write Python code to sort a list descending"],
  ["What is 15% of 2400?", "What is 15% of 2500?"],
  ["Translate 'good morning' to French", "Translate 'good night' to French"],
  ["Who is the CEO of Stripe?", "Who is the CFO of Stripe?"],
  ["Refund policy for orders over 100 dollars", "Refund policy for orders under 100 dollars"],
  ["Average flight time from NYC to London", "Average flight time from NYC to Lisbon"],
  ["Is port 8080 open by default on nginx?", "Is port 8443 open by default on nginx?"],
  ["Recommended dose of vitamin D for adults", "Recommended dose of vitamin C for adults"],
];

// probes that must be stopped by GATES before similarity even runs
const GATED_PROBES: string[] = [
  "What is the weather in Paris today?",
  "current price of AAPL stock",
  "latest news about the merger",
];

// [stored, paraphrase] - SHOULD serve (sanity that the cache is not useless)
const PARAPHRASE: [string, string][] = [
  ["What is the capital of France?", "What's the capital city of France?"],
  ["How do I revert the last git commit?", "How can I revert my last git commit?"],
  ["Explain what a vector index is", "Explain what a vector index is, briefly"],
];

const cfg = loadConfig();
const key = loadSecret(cfg, "OPENAI_API_KEY");
if (!key) {
  console.error("OPENAI_API_KEY missing in env file - cannot run the live poison eval");
  process.exit(1);
}
const embed = makeOpenAIEmbedder(key);

const cos = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const asBody = (q: string) => ({ model: "m", messages: [{ role: "user", content: q }] });

let falseHits = 0;
let embedCalls = 0;

console.log(`threshold=${THRESHOLD} | guards: G1 gates, G7 numbers, G8 code tokens\n`);
console.log("POISON PAIRS (must not serve):");
for (const [stored, probe] of POISON) {
  const [a, b] = await Promise.all([embed(stored), embed(probe)]);
  embedCalls += 2;
  const sim = cos(a, b);
  const overThreshold = sim >= THRESHOLD;
  const guardsCatch = !tokenGuardsPass(probe, stored);
  const wouldServe = overThreshold && !guardsCatch;
  if (wouldServe) falseHits++;
  const defense = !overThreshold ? "similarity" : guardsCatch ? "G7/G8 guard" : "NONE";
  console.log(
    `  ${wouldServe ? "✖ WOULD SERVE" : "✔ stopped"} sim=${sim.toFixed(4)} [${defense}]  "${probe}"`,
  );
}

console.log("\nGATED PROBES (stopped before similarity):");
for (const probe of GATED_PROBES) {
  const g = responseCacheGates(
    { ...DEFAULT_POLICY, recycle: { ...DEFAULT_POLICY.recycle, response: { ...DEFAULT_POLICY.recycle.response, semantic_enabled: true } } },
    asBody(probe),
  );
  if (g.cacheable) falseHits++;
  console.log(`  ${g.cacheable ? "✖ NOT GATED" : "✔ gated"} (${g.reason}) "${probe}"`);
}

console.log("\nPARAPHRASE SANITY (should serve):");
let served = 0;
for (const [stored, probe] of PARAPHRASE) {
  const [a, b] = await Promise.all([embed(stored), embed(probe)]);
  embedCalls += 2;
  const sim = cos(a, b);
  const wouldServe = sim >= THRESHOLD && tokenGuardsPass(probe, stored);
  if (wouldServe) served++;
  console.log(`  ${wouldServe ? "✔ serves" : "- misses"} sim=${sim.toFixed(4)}  "${probe}"`);
}

console.log(
  `\nembeddings used: ${embedCalls} (text-embedding-3-small, ~$${(embedCalls * 0.00000002 * 1000).toFixed(6)})`,
);
console.log(`paraphrase hit-rate: ${served}/${PARAPHRASE.length} (misses are conservative, not fatal)`);
if (falseHits > 0) {
  console.error(`\n✖ HARD BAR FAILED: ${falseHits} poison probe(s) would serve. DO NOT SHIP the semantic layer.`);
  process.exit(1);
}
console.log("\n✔ POISON EVAL PASS: zero false hits across all layered defenses");
