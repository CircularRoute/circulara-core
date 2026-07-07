/**
 * Wave 9 - the nightly maintenance run (D12: automated by design, dogfooded).
 *
 *   npx tsx scripts/nightly.ts                  # deterministic core ($0)
 *   npx tsx scripts/nightly.ts --with-poison    # + live poison eval (~$0.001)
 *   npx tsx scripts/nightly.ts --with-registry  # + upstream pricing fetch -> candidate + diff
 *
 * Cadence vs the CFO cap ($200/mo API): the deterministic core is $0 and runs
 * nightly; the poison slice (~$0.001/run) is weekly by default in CI; the
 * registry fetch is free (public JSON) and produces a CANDIDATE only - a
 * human approves diffs (standing approver: see AWAITING_FOUNDER).
 *
 * DOGFOOD (D12): when CIRCULARA_DOGFOOD_URL/TENANT/TOKEN/SEAT are set, the
 * run reports its own LLM usage as observe events through Circulara itself -
 * the maintenance agents are metered by the product they maintain.
 *
 * Exit code 1 on ANY drift = the alert (CI-gateable).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const withPoison = process.argv.includes("--with-poison");
const withRegistry = process.argv.includes("--with-registry");
const started = new Date().toISOString();
const results: Record<string, { ok: boolean; detail: string }> = {};

function run(name: string, argv: string[]) {
  try {
    const out = execFileSync("npx", ["tsx", ...argv], {
      encoding: "utf8",
      timeout: 300_000,
    });
    results[name] = { ok: true, detail: out.trim().split("\n").slice(-2).join(" | ") };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    results[name] = {
      ok: false,
      detail: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().split("\n").slice(-4).join(" | "),
    };
  }
}

// 1. deterministic golden eval (AD5): compression, routing, caps, pruning, cache marks
run("golden_eval", ["scripts/eval.ts"]);

// 2. unit + integration suite (the invariants ARE the regression net)
try {
  execFileSync("npx", ["tsx", "--test", "test/smoke.test.ts"], {
    encoding: "utf8",
    timeout: 600_000,
  });
  results["test_suite"] = { ok: true, detail: "suite green" };
} catch {
  results["test_suite"] = { ok: false, detail: "test suite failed - see CI logs" };
}

// 3. poison slice (LLM spend - weekly cadence under the CFO cap)
if (withPoison) run("poison_eval", ["scripts/eval-poison.ts"]);

// 4. provider-pricing registry: fetch upstream -> CANDIDATE + diff report.
// NEVER auto-approves: a human reviews the diff (human-approves-diffs, D12).
if (withRegistry) run("registry_update", ["scripts/../src/registry/cli.ts", "update"]);

const drift = Object.entries(results).filter(([, r]) => !r.ok);
const report = {
  started,
  finished: new Date().toISOString(),
  results,
  drift: drift.map(([k]) => k),
  note: "registry updates are candidates only; a named human approves diffs. Carbon coefficients are reviewed quarterly through the same discipline (git diff = the diff).",
};
mkdirSync("reports", { recursive: true });
const file = join("reports", `nightly-${started.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`nightly report -> ${file}`);
for (const [k, r] of Object.entries(results))
  console.log(`  ${r.ok ? "✔" : "✖"} ${k}: ${r.detail.slice(0, 120)}`);

// DOGFOOD (D12): report this run's own usage through Circulara itself
const dogfoodUrl = process.env.CIRCULARA_DOGFOOD_URL;
if (dogfoodUrl && process.env.CIRCULARA_DOGFOOD_TENANT && process.env.CIRCULARA_DOGFOOD_SEAT) {
  try {
    // poison eval used ~30 embedding calls (~20 tokens each); classify smokes vary.
    const tokens = withPoison ? 600 : 0;
    await fetch(`${dogfoodUrl}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CIRCULARA_DOGFOOD_TOKEN ?? ""}`,
        "x-tenant-id": process.env.CIRCULARA_DOGFOOD_TENANT,
      },
      body: JSON.stringify({
        event_id: randomUUID(),
        call_id: randomUUID(),
        schema_version: "1.0",
        ts: new Date().toISOString(),
        seat_id: process.env.CIRCULARA_DOGFOOD_SEAT,
        identity_type: "named_agent",
        user_id: "circulara-maintenance",
        team_id: "internal",
        agent_identity: "nightly-runner",
        host: "other",
        capture_path: "tool",
        session_id: null,
        module: "meter",
        intervention_type: "observe",
        model_requested: "text-embedding-3-small",
        model_used: "text-embedding-3-small",
        tokens: { input_counterfactual: tokens, output_counterfactual: 0, input_actual: tokens, output_actual: 0 },
        cost: { counterfactual_usd: 0, actual_usd: 0, avoided_usd: 0, currency: "USD", pricing_source: "plugin-unpriced", pricing_version: "plugin-unpriced" },
        energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
        carbon: { avoided_co2e_g: 0, grid_intensity_g_per_kwh: 400, pue: 1.2, region: null, method: "EcoLogits-class", confidence: "Estimated" },
        methodology_version: "esg-v1",
      }),
    });
    console.log("dogfood: run usage reported through Circulara (D12)");
  } catch {
    console.log("dogfood: backend unreachable (non-fatal)");
  }
}

if (drift.length > 0) {
  console.error(`DRIFT ALERT: ${drift.map(([k]) => k).join(", ")}`);
  process.exit(1);
}
console.log("NIGHTLY PASS");
