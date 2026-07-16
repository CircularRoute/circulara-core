/**
 * builder.20260716.001 - model-WASTE detector tests.
 * Covers: tier derivation, the candidate rule (metadata only), counterfactual
 * pricing, aggregation into patterns, projection + confidence, the dismiss /
 * precision feedback loop, content-sampling policy default+toggle, and the
 * load-bearing invariants: advisory NEVER inflates realized avoided_usd, and the
 * detector is counts-not-content (a smuggled prompt field is rejected at intake).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlane, type TenantContext } from "../src/db/tenancy.js";
import { ingestEvent, meterSummary } from "../src/meter/meter.js";
import { getPolicy, setPolicy, DEFAULT_POLICY } from "../src/engines/policy.js";
import {
  isWasteCandidate,
  counterfactual,
  sizeBucket,
  wasteReport,
  dismissPattern,
  loadDismissed,
} from "../src/meter/waste.js";
import type { Row } from "../src/meter/observer.js";
import {
  topTierModels,
  cheapestSameProvider,
  resolveModelKey,
  type PricingSnapshot,
} from "../src/registry/pricing.js";

const PRICING: PricingSnapshot = {
  pricing_version: "t",
  source: "fixture",
  fetched_at: "t",
  models: {
    // opus blended = 90e-6; haiku blended = 6e-6 -> ratio 15x -> opus is top tier
    "anthropic/claude-opus": {
      input_cost_per_token: 15e-6,
      output_cost_per_token: 75e-6,
      provider: "anthropic",
    },
    "anthropic/claude-haiku": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 5e-6,
      provider: "anthropic",
    },
    "openai/gpt-mini": {
      input_cost_per_token: 0.5e-6,
      output_cost_per_token: 1.5e-6,
      provider: "openai",
    },
  },
};

const TOP = topTierModels(PRICING, DEFAULT_POLICY.waste.price_ratio);

const row = (over: Partial<Row> = {}): Row => ({
  user_id: "sso|alice",
  seat_id: "seat-1",
  identity_type: "human",
  task_type: "chat",
  model: "anthropic/claude-opus",
  in_tok: 40,
  out_tok: 80,
  cache_read: 0,
  routable: false,
  route_to: null,
  request_fp: null,
  tool_calls: 0,
  ts: "2026-07-10T10:00:00.000Z",
  ...over,
});

// ---------------- pure helpers ----------------

test("tier derivation: only the expensive model is top-tier (per provider)", () => {
  assert.ok(TOP.has("anthropic/claude-opus"));
  assert.ok(!TOP.has("anthropic/claude-haiku")); // cheapest of its provider
  assert.ok(!TOP.has("openai/gpt-mini")); // only priced openai model -> baseline
});

test("counterfactual target is the cheapest same-provider model", () => {
  const cheaper = cheapestSameProvider(PRICING, "anthropic/claude-opus");
  assert.equal(cheaper?.id, "anthropic/claude-haiku");
  // the cheapest model has no cheaper same-provider alternative
  assert.equal(cheapestSameProvider(PRICING, "anthropic/claude-haiku"), null);
});

test("resolveModelKey maps a bare id to its canonical snapshot key", () => {
  // bare "claude-opus" resolves via the anthropic/ fallback
  assert.equal(resolveModelKey(PRICING, "claude-opus"), "anthropic/claude-opus");
  assert.equal(
    resolveModelKey(PRICING, "anthropic/claude-opus"),
    "anthropic/claude-opus",
  );
  assert.equal(resolveModelKey(PRICING, "totally-unknown"), null);
});

test("waste rule: tiny + top-tier + human + no tools = candidate", () => {
  const opts = { topTier: TOP, policy: DEFAULT_POLICY.waste };
  assert.ok(isWasteCandidate(row(), opts));
  // large input -> not tiny -> not waste
  assert.ok(!isWasteCandidate(row({ in_tok: 5000 }), opts));
  // large output -> not waste
  assert.ok(!isWasteCandidate(row({ out_tok: 5000 }), opts));
  // cheap model -> not top-tier -> not waste
  assert.ok(!isWasteCandidate(row({ model: "anthropic/claude-haiku" }), opts));
  // agentic identity -> exempt
  assert.ok(!isWasteCandidate(row({ identity_type: "named_agent" }), opts));
  // reported tool calls -> agentic -> exempt
  assert.ok(!isWasteCandidate(row({ tool_calls: 3 }), opts));
  // absent tool signal (older plugin) is NOT disqualifying
  assert.ok(isWasteCandidate(row({ tool_calls: null }), opts));
  // detector off -> nothing is a candidate
  assert.ok(
    !isWasteCandidate(row(), {
      topTier: TOP,
      policy: { ...DEFAULT_POLICY.waste, enabled: false },
    }),
  );
});

test("counterfactual saving is actual(opus) - cheapest(haiku), > 0", () => {
  const cf = counterfactual(row(), PRICING);
  assert.equal(cf?.counterfactual_model, "anthropic/claude-haiku");
  // opus: 40*15e-6 + 80*75e-6 = 6.6e-3 ; haiku: 40*1e-6 + 80*5e-6 = 4.4e-4
  assert.ok(cf!.saving_usd > 0);
  assert.ok(Math.abs(cf!.actual_usd - (40 * 15e-6 + 80 * 75e-6)) < 1e-12);
});

test("sizeBucket separates sub-sizes of tiny calls", () => {
  assert.equal(sizeBucket(40, 80), "in<=50/out<=100");
  assert.equal(sizeBucket(120, 250), "in<=200/out<=300");
});

// ---------------- integration: aggregation, dismissal, invariants ----------------

let control: ControlPlane;
let tmp: string;
let ctx: TenantContext;
const HUMAN = randomUUID();
const AGENT = randomUUID();

function observe(seatId: string, over: Record<string, unknown> = {}) {
  const obs = (over.observer as Record<string, unknown>) ?? {};
  return {
    event_id: randomUUID(),
    call_id: randomUUID(),
    schema_version: "1.0",
    ts: "2026-07-10T10:00:00.000Z",
    seat_id: seatId,
    identity_type: "human",
    user_id: "sso|alice",
    host: "claude_code",
    capture_path: "hook",
    module: "meter",
    intervention_type: "observe",
    model_used: "anthropic/claude-opus",
    model_requested: "anthropic/claude-opus",
    tokens: {
      input_counterfactual: 40,
      output_counterfactual: 80,
      input_actual: 40,
      output_actual: 80,
    },
    cost: {
      counterfactual_usd: 0,
      actual_usd: 0,
      avoided_usd: 0,
      currency: "USD",
      pricing_source: "meter",
      pricing_version: "t",
    },
    energy: { avoided_kwh: 0, method: "x", confidence: "Estimated" },
    carbon: {
      avoided_co2e_g: 0,
      grid_intensity_g_per_kwh: 400,
      pue: 1.2,
      region: null,
      method: "x",
      confidence: "Estimated",
    },
    methodology_version: "esg-v1",
    ...over,
    observer: { task_type: "chat", tool_calls: 0, ...obs },
  };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "circulara-waste-"));
  control = new ControlPlane(tmp, true);
  await control.init();
  const t = await control.createTenant("waste-co");
  ctx = await control.contextFor(t.tenant_id);
  await ctx.db.query(
    `INSERT INTO seats (seat_id, identity_type, user_id, agent_identity, active)
     VALUES ($1,'human','sso|alice',null,true)`,
    [HUMAN],
  );
  await ctx.db.query(
    `INSERT INTO seats (seat_id, identity_type, user_id, agent_identity, active)
     VALUES ($1,'named_agent','sso|alice','agent-x',true)`,
    [AGENT],
  );

  // 5 tiny opus "chat" calls by the human across 3 distinct days -> ONE recurring
  // pattern, occurrences 5, active_days 3 -> confidence "medium"
  const days = [
    "2026-07-10T10:00:00.000Z",
    "2026-07-10T12:00:00.000Z",
    "2026-07-11T09:00:00.000Z",
    "2026-07-11T15:00:00.000Z",
    "2026-07-12T08:00:00.000Z",
  ];
  for (const ts of days) await ingestEvent(ctx, observe(HUMAN, { ts }));

  // a second pattern: 1 tiny opus "code" call -> one-off, confidence "low"
  await ingestEvent(
    ctx,
    observe(HUMAN, { ts: "2026-07-10T10:00:00.000Z", observer: { task_type: "code" } }),
  );

  // NON-candidates (must be filtered out):
  // large input
  await ingestEvent(
    ctx,
    observe(HUMAN, {
      tokens: { input_counterfactual: 8000, output_counterfactual: 80, input_actual: 8000, output_actual: 80 },
    }),
  );
  // cheap model
  await ingestEvent(
    ctx,
    observe(HUMAN, { model_used: "anthropic/claude-haiku", model_requested: "anthropic/claude-haiku" }),
  );
  // agentic seat
  await ingestEvent(ctx, observe(AGENT, { identity_type: "named_agent", agent_identity: "agent-x" }));
  // reported tool calls
  await ingestEvent(ctx, observe(HUMAN, { observer: { task_type: "chat", tool_calls: 2 } }));
});

after(async () => {
  await control.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("aggregation: only true candidates count; patterns carry projection + confidence", async () => {
  const w = await wasteReport(ctx, PRICING, DEFAULT_POLICY);
  assert.equal(w.enabled, true);
  assert.equal(w.basis, "estimated");
  assert.equal(w.candidate_calls, 6); // 5 chat + 1 code; the 4 non-candidates excluded
  assert.equal(w.patterns.length, 2);

  const chat = w.patterns.find((p) => p.task_type === "chat")!;
  assert.ok(chat);
  assert.equal(chat.occurrences, 5);
  assert.equal(chat.active_days, 3);
  assert.equal(chat.recurring, true);
  assert.equal(chat.confidence, "medium");
  assert.equal(chat.model, "anthropic/claude-opus");
  assert.equal(chat.counterfactual_model, "anthropic/claude-haiku");
  assert.ok(chat.projected_monthly_usd && chat.projected_monthly_usd > 0);

  const code = w.patterns.find((p) => p.task_type === "code")!;
  assert.equal(code.occurrences, 1);
  assert.equal(code.recurring, false); // single day
  assert.equal(code.projected_monthly_usd, null); // never extrapolate one day
  assert.equal(code.confidence, "low");

  assert.ok(w.observed_saving_usd > 0);
  assert.ok(w.projected_monthly_usd > 0);
});

test("advisory NEVER inflates realized avoided_usd (meter integrity)", async () => {
  // wasteReport is read-only: no events written, and all observe events keep avoided = 0
  const before = await meterSummary(ctx);
  await wasteReport(ctx, PRICING, DEFAULT_POLICY);
  const after = await meterSummary(ctx);
  assert.equal(before.events, after.events); // no new meter events
  assert.equal(after.avoided_usd, 0); // realized avoided stays exactly zero
  // and there is no waste/overkill intervention_type row anywhere
  const r = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM meter_events WHERE intervention_type <> 'observe'`,
  );
  assert.equal(r.rows[0].n, 0);
});

test("dismiss loop: pattern flagged, excluded from totals, precision tracked", async () => {
  const w1 = await wasteReport(ctx, PRICING, DEFAULT_POLICY);
  const chat = w1.patterns.find((p) => p.task_type === "chat")!;
  await dismissPattern(ctx, chat.pattern_key, "admin@waste-co");

  const dismissed = await loadDismissed(ctx);
  assert.ok(dismissed.has(chat.pattern_key));

  const w2 = await wasteReport(ctx, PRICING, DEFAULT_POLICY, { dismissed });
  const chat2 = w2.patterns.find((p) => p.pattern_key === chat.pattern_key)!;
  assert.equal(chat2.dismissed, true);
  // dismissed pattern's $ is excluded from live totals
  const live = w2.patterns.filter((p) => !p.dismissed);
  assert.ok(!live.some((p) => p.pattern_key === chat.pattern_key));
  // precision = 1 - dismissed/total = 1 - 1/2 = 0.5
  assert.equal(w2.precision, 0.5);
});

test("detector off -> empty report, no candidates", async () => {
  const off = { ...DEFAULT_POLICY, waste: { ...DEFAULT_POLICY.waste, enabled: false } };
  const w = await wasteReport(ctx, PRICING, off);
  assert.equal(w.enabled, false);
  assert.equal(w.patterns.length, 0);
  assert.equal(w.candidate_calls, 0);
});

test("content_sampling defaults OFF and toggles via policy", async () => {
  const p0 = await getPolicy(ctx);
  assert.equal(p0.content_sampling.enabled, false); // opt-in only
  assert.equal(p0.waste.enabled, true); // advisory on by default

  await setPolicy(ctx, { ...p0, content_sampling: { enabled: true } });
  const p1 = await getPolicy(ctx);
  assert.equal(p1.content_sampling.enabled, true);
  assert.equal(p1.waste.enabled, true); // toggling sampling doesn't disturb waste
});

test("counts-not-content: a smuggled prompt field is rejected at intake", async () => {
  await assert.rejects(
    ingestEvent(ctx, observe(HUMAN, { observer: { task_type: "chat", tool_calls: 0, prompt: "secret user text" } })),
  );
});
