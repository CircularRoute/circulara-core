/**
 * AD5 - nightly eval runner (wave-3 slice). Deterministic, zero API spend.
 *
 *   npx tsx scripts/eval.ts        # exits 1 on any regression (CI-gateable)
 *
 * D12: this runner is itself an agent workload in steady state and runs
 * through Circulara's own optimization layer. LLM-judge slices (ML
 * compression, response-cache poison set) activate with their engines,
 * within the CFO cap (smaller nightly core + periodic full run).
 */
import { compressText, applyReduce } from "../src/engines/reduce.js";
import { DEFAULT_POLICY } from "../src/engines/policy.js";
import {
  COMPRESSION_CASES,
  ROUTING_CASES,
  ROUTING_MAP,
} from "../eval/golden.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// ---- compression invariants ----
for (const c of COMPRESSION_CASES) {
  const out = compressText(c.input);
  const ratio = out.length / c.input.length;
  for (const keep of c.invariants.keeps)
    check(`[compress] ${c.name} :: keeps "${keep.slice(0, 40)}..."`, out.includes(keep));
  check(
    `[compress] ${c.name} :: ratio ${ratio.toFixed(2)} in [${c.invariants.minRatio}, ${c.invariants.maxRatio}]`,
    ratio >= c.invariants.minRatio && ratio <= c.invariants.maxRatio,
    `got ${ratio.toFixed(2)}`,
  );
}

// ---- routing invariants ----
const routingPolicy = {
  ...DEFAULT_POLICY,
  reduce: {
    ...DEFAULT_POLICY.reduce,
    routing: { enabled: true, map: ROUTING_MAP, simple_max_chars: 2000 },
  },
};
for (const c of ROUTING_CASES) {
  const r = applyReduce(routingPolicy, structuredClone(c.body));
  const routed = r.applied.some((a) => a.technique === "route");
  check(`[route] ${c.name}`, routed === c.expectRouted, `routed=${routed}`);
}

// ---- cap invariants (conservative rule is tested in the unit suite; here:
// clamp only above the cap) ----
const capPolicy = {
  ...DEFAULT_POLICY,
  reduce: { ...DEFAULT_POLICY.reduce, output_cap_tokens: 1000 },
};
{
  const over = applyReduce(capPolicy, { model: "m", max_tokens: 4000, messages: [] });
  check("[cap] clamps above cap", over.body.max_tokens === 1000);
  const under = applyReduce(capPolicy, { model: "m", max_tokens: 500, messages: [] });
  check("[cap] leaves below-cap untouched", under.body.max_tokens === 500);
}

// ---- tool-prune invariants ----
const prunePolicy = {
  ...DEFAULT_POLICY,
  reduce: {
    ...DEFAULT_POLICY.reduce,
    tool_pruning: { enabled: true, allow: ["keep_me"] },
  },
};
{
  const r = applyReduce(prunePolicy, {
    model: "m",
    messages: [],
    tools: [{ name: "keep_me" }, { name: "drop_me" }],
  });
  const names = (r.body.tools as { name: string }[]).map((t) => t.name);
  check("[tool_prune] keeps allowlisted", names.includes("keep_me"));
  check("[tool_prune] drops others", !names.includes("drop_me"));
}

// ---- prompt-cache invariants ----
{
  const big = "s".repeat(5000);
  const r = applyReduce(DEFAULT_POLICY, { model: "m", system: big, messages: [] });
  const sys = r.body.system as { cache_control?: { type: string }; text?: string }[];
  check(
    "[prompt_cache] large system block marked cacheable, content intact",
    Array.isArray(sys) && sys[0]?.cache_control?.type === "ephemeral" && sys[0]?.text === big,
  );
  const small = applyReduce(DEFAULT_POLICY, { model: "m", system: "small", messages: [] });
  check("[prompt_cache] small system untouched", small.body.system === "small");
}

console.log(`eval: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.error("REGRESSIONS (drift alert):");
  for (const f of failures) console.error("  ✖ " + f);
  process.exit(1);
}
