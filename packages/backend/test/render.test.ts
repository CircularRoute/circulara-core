/**
 * builder.20260716.001 - dashboard render: free vs PAID waste view.
 * Free = locked tabs, upsell, advisory panel. Paid = real tab links, no upsell,
 * annual projection, content-sampling toggle, routing recommendations. Honest:
 * paid never fabricates confidence or a live enforce action.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "../src/dashboard/render.js";
import { estimateEnergyCarbon } from "../src/meter/compute.js";
import { savingsPotential } from "../src/meter/potential.js";
import type { MeterReport } from "../src/meter/report.js";
import type { WasteReport, WastePattern } from "../src/meter/waste.js";

const impact = estimateEnergyCarbon(1000);
const REPORT: MeterReport = {
  month: null,
  events: 5,
  tokens_observed: 1000,
  observed_usd: 5,
  avoided_usd: 0,
  external_spend_usd: 0,
  observed_impact: impact,
  avoided_impact: impact,
  by_user: [],
  by_team: [],
  by_module: [],
  by_model: [],
  by_provider: [],
  by_month: [],
  over_seat_cap: false,
  avoided_cost_basis: "measured",
  avoided_usd_by_basis: {},
  methodology_note: "",
};
const POT = savingsPotential(5);

const EMPTY_WASTE: WasteReport = {
  enabled: true,
  basis: "estimated",
  method: "m",
  from: null,
  to: null,
  candidate_calls: 0,
  patterns: [],
  observed_saving_usd: 0,
  projected_monthly_usd: 0,
  precision: null,
};

const PATTERN: WastePattern = {
  pattern_key: "seat|chat|in<=50/out<=100",
  seat_id: "seat",
  user_id: "ava@co.test",
  task_type: "chat",
  model: "claude-opus-4",
  counterfactual_model: "claude-3-haiku",
  size_bucket: "in<=50/out<=100",
  occurrences: 5,
  active_days: 3,
  recurring: true,
  observed_saving_usd: 0.5,
  projected_monthly_usd: 2,
  confidence: "medium",
  dismissed: false,
};
const WASTE: WasteReport = {
  ...EMPTY_WASTE,
  candidate_calls: 5,
  patterns: [PATTERN],
  observed_saving_usd: 0.5,
  projected_monthly_usd: 2,
  precision: 1,
};

test("free tier: locked tabs, upsell, no paid controls", () => {
  const html = renderDashboard(REPORT, POT, "", "", "", WASTE, { paid: false });
  assert.ok(html.includes('class="tab-locked"'), "free nav is locked");
  assert.ok(html.includes("Upgrade to paid tier"), "free shows upsell");
  assert.ok(!html.includes("csToggle"), "no content-sampling toggle on free");
  assert.ok(!html.includes("Recommended routing rules"), "no routing recs on free");
  assert.ok(!html.includes('href="/dashboard/statement"'), "paid tabs are not real links on free");
});

test("paid tier: real tab links, no upsell, annual + toggle + routing recs", () => {
  const html = renderDashboard(REPORT, POT, "", "", "", WASTE, { paid: true });
  assert.ok(!html.includes('class="tab-locked"'), "paid nav is unlocked");
  assert.ok(html.includes('href="/dashboard/statement"'), "paid statement tab is a real link");
  assert.ok(html.includes('href="/dashboard/meter"'), "paid meter tab is a real link");
  assert.ok(!html.includes("Upgrade to paid tier"), "no upsell on paid");
  assert.ok(html.includes("csToggle"), "content-sampling toggle present on paid");
  assert.ok(html.includes("Recommended routing rules"), "routing recs present on paid");
  assert.ok(html.includes("/yr"), "annual projection shown on paid");
  // honesty: enforcement is labelled as not-yet-live
  assert.ok(html.includes("Ready to enforce when auto-routing turns on"));
});

test("content-sampling toggle reflects the stored setting", () => {
  const off = renderDashboard(REPORT, POT, "", "", "", WASTE, { paid: true, contentSampling: false });
  const on = renderDashboard(REPORT, POT, "", "", "", WASTE, { paid: true, contentSampling: true });
  // the checked attribute only appears when sampling is enabled
  assert.ok(!/id="csToggle"[^>]*checked/.test(off), "toggle unchecked when sampling off");
  assert.ok(/id="csToggle"[^>]*checked/.test(on), "toggle checked when sampling on");
});

test("paid empty state still offers the sampling toggle, no table", () => {
  const html = renderDashboard(REPORT, POT, "", "", "", EMPTY_WASTE, { paid: true });
  assert.ok(html.includes("No wasteful model usage detected"));
  assert.ok(html.includes("csToggle"), "toggle available even with no patterns");
});
