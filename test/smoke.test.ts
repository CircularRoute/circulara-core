/**
 * Sprint-1 smoke tests. In-memory PGlite (same SQL + pgvector as prod path).
 * Covers: tenant isolation, seat rules (AD6), event validation + append-only
 * meter (AD4/AD12), object-store integrity, pricing registry flow (WS6).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlane } from "../src/db/tenancy.js";
import { FsObjectStore, sha256hex } from "../src/storage/objectStore.js";
import { buildApp } from "../src/api/server.js";
import {
  PricingRegistry,
  normalizeUpstream,
  diffSnapshots,
} from "../src/registry/pricing.js";
import { CARBON_V1 } from "../src/registry/carbon.js";

const ADMIN = { authorization: "Bearer dev-admin-token" };
const SEAT = { authorization: "Bearer dev-seat-token" };

let control: ControlPlane;
let app: ReturnType<typeof buildApp>;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "circulara-test-"));
  control = new ControlPlane(tmp, /* inMemory */ true);
  await control.init();
  app = buildApp({ control, objects: new FsObjectStore(join(tmp, "objects")) });
});

after(async () => {
  await app.close();
  await control.close();
  rmSync(tmp, { recursive: true, force: true });
});

function validEvent(seatId: string, over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    call_id: randomUUID(),
    schema_version: "1.0",
    ts: new Date().toISOString(),
    seat_id: seatId,
    identity_type: "human",
    user_id: "sso|user1",
    host: "claude_code",
    capture_path: "hook",
    module: "meter",
    intervention_type: "observe",
    tokens: {
      input_counterfactual: 1000,
      output_counterfactual: 200,
      input_actual: 1000,
      output_actual: 200,
    },
    cost: {
      counterfactual_usd: 0.0123,
      actual_usd: 0.0123,
      avoided_usd: 0,
      currency: "USD",
      pricing_source: "provider_registry",
      pricing_version: "test-snapshot",
    },
    energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
    carbon: {
      avoided_co2e_g: 0,
      grid_intensity_g_per_kwh: 400,
      pue: 1.2,
      region: null,
      method: "EcoLogits-class",
      confidence: "Estimated",
    },
    methodology_version: "esg-v1",
    ...over,
  };
}

test("health", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
});

test("auth required everywhere", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/tenants",
    payload: { name: "x" },
  });
  assert.equal(res.statusCode, 401);
});

test("tenant lifecycle + seat rules + event flow + isolation", async () => {
  // create two tenants
  const t1 = (
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: ADMIN,
      payload: { name: "acme" },
    })
  ).json() as { tenant_id: string };
  const t2 = (
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: ADMIN,
      payload: { name: "globex" },
    })
  ).json() as { tenant_id: string };

  // human seat: any authenticated caller
  const seatRes = await app.inject({
    method: "POST",
    url: "/v1/seats",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: { identity_type: "human", user_id: "sso|alice" },
  });
  assert.equal(seatRes.statusCode, 201);
  const { seat_id } = seatRes.json() as { seat_id: string };

  // named-agent seat: NOT provisioned by a non-admin (AD6)
  const agentDenied = await app.inject({
    method: "POST",
    url: "/v1/seats",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: {
      identity_type: "named_agent",
      user_id: "sso|alice",
      agent_identity: "ci-bot",
    },
  });
  assert.equal(agentDenied.statusCode, 403);

  // ... but admin can
  const agentOk = await app.inject({
    method: "POST",
    url: "/v1/seats",
    headers: { ...ADMIN, "x-tenant-id": t1.tenant_id },
    payload: {
      identity_type: "named_agent",
      user_id: "sso|alice",
      agent_identity: "ci-bot",
    },
  });
  assert.equal(agentOk.statusCode, 201);

  // valid observe event lands
  const ok = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: validEvent(seat_id),
  });
  assert.equal(ok.statusCode, 201);

  // invalid: avoided_usd must equal counterfactual - actual
  const bad = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: validEvent(seat_id, {
      cost: {
        counterfactual_usd: 1,
        actual_usd: 0.4,
        avoided_usd: 0.7,
        currency: "USD",
        pricing_source: "provider_registry",
        pricing_version: "test-snapshot",
      },
    }),
  });
  assert.equal(bad.statusCode, 422);

  // invalid: sourcing intervention without sourcing block / on v1.0
  const badSourcing = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: validEvent(seat_id, { intervention_type: "external_paid" }),
  });
  assert.equal(badSourcing.statusCode, 422);

  // valid v1.1 sourcing event (rung-4 spend reported separately)
  const sourcingOk = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    payload: validEvent(seat_id, {
      schema_version: "1.1",
      module: "reuse",
      intervention_type: "external_paid",
      cost: {
        counterfactual_usd: 5,
        actual_usd: 0.1,
        avoided_usd: 4.9,
        currency: "USD",
        pricing_source: "provider_registry",
        pricing_version: "test-snapshot",
      },
      sourcing: {
        rung: 4,
        source: "adx",
        catalog_ref: "adx://dataset/123",
        spend_usd: 2.5,
        billing_route: "customer_aws",
        approval_ref: "appr-1",
        license: { redistributable: false, spdx_or_terms: "DSA", parent_fp: null },
        commons_captured: false,
      },
    }),
  });
  assert.equal(sourcingOk.statusCode, 201);

  // summary reflects t1 only; external spend separated from savings
  const sum = (
    await app.inject({
      method: "GET",
      url: "/v1/meter/summary",
      headers: { ...SEAT, "x-tenant-id": t1.tenant_id },
    })
  ).json() as { events: number; external_spend_usd: number; avoided_usd: number };
  assert.equal(sum.events, 2);
  assert.equal(sum.external_spend_usd, 2.5);
  assert.ok(Math.abs(sum.avoided_usd - 4.9) < 1e-9);

  // ISOLATION: tenant 2 sees nothing
  const sum2 = (
    await app.inject({
      method: "GET",
      url: "/v1/meter/summary",
      headers: { ...SEAT, "x-tenant-id": t2.tenant_id },
    })
  ).json() as { events: number };
  assert.equal(sum2.events, 0);

  // seat of t1 does not exist in t2 (event rejected)
  const cross = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { ...SEAT, "x-tenant-id": t2.tenant_id },
    payload: validEvent(seat_id),
  });
  assert.equal(cross.statusCode, 422);

  // APPEND-ONLY: direct UPDATE/DELETE on meter_events must fail (AD4 trigger)
  const ctx = await control.contextFor(t1.tenant_id);
  await assert.rejects(
    ctx.db.query(`UPDATE meter_events SET avoided_usd = 999`),
    /append-only/,
  );
  await assert.rejects(
    ctx.db.query(`DELETE FROM meter_events`),
    /append-only/,
  );
});

test("M1 stacking rule: chained events on one call_id telescope, no double-count", async () => {
  const t = (
    await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: ADMIN,
      payload: { name: "stacking" },
    })
  ).json() as { tenant_id: string };
  const { seat_id } = (
    await app.inject({
      method: "POST",
      url: "/v1/seats",
      headers: { ...ADMIN, "x-tenant-id": t.tenant_id },
      payload: { identity_type: "human", user_id: "sso|bob" },
    })
  ).json() as { seat_id: string };

  // one underlying call, two stacked interventions (compress -> route):
  // stage 2's counterfactual = stage 1's actual (the chain rule).
  const callId = randomUUID();
  const stage1 = { counterfactual_usd: 1.0, actual_usd: 0.6 }; // compress: avoids 0.4
  const stage2 = { counterfactual_usd: 0.6, actual_usd: 0.25 }; // route: avoids 0.35
  for (const [i, stage] of [stage1, stage2].entries()) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...SEAT, "x-tenant-id": t.tenant_id },
      payload: validEvent(seat_id, {
        call_id: callId,
        module: "reduce",
        intervention_type: i === 0 ? "compress" : "route",
        cost: {
          ...stage,
          avoided_usd: stage.counterfactual_usd - stage.actual_usd,
          currency: "USD",
          pricing_source: "provider_registry",
          pricing_version: "test-snapshot",
        },
      }),
    });
    assert.equal(res.statusCode, 201);
  }
  const sum = (
    await app.inject({
      method: "GET",
      url: "/v1/meter/summary",
      headers: { ...SEAT, "x-tenant-id": t.tenant_id },
    })
  ).json() as { avoided_usd: number };
  // telescoped: original counterfactual (1.0) - final actual (0.25) = 0.75
  assert.ok(Math.abs(sum.avoided_usd - 0.75) < 1e-9);
});

test("object store: content-addressed + integrity", async () => {
  const store = new FsObjectStore(join(tmp, "objects2"));
  const bytes = Buffer.from("embedding index bytes");
  const key = await store.put("tenant-a", bytes);
  assert.equal(key, sha256hex(bytes));
  const back = await store.get("tenant-a", key);
  assert.ok(back && back.equals(bytes));
  assert.equal(await store.get("tenant-a", "0".repeat(64)), null);
});

test("pricing registry: normalize, diff, human-gated approve (WS6)", async () => {
  const dir = join(tmp, "registry");
  const reg = new PricingRegistry(dir);

  // approve without candidate refuses
  assert.throws(() => reg.approve(), /no candidate/);

  // update from a FIXTURE upstream (offline; live fetch exercised via CLI)
  const fixture = {
    sample_spec: { note: "ignored" },
    "test/model-a": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 5e-6,
      litellm_provider: "testprov",
    },
    "test/model-b": {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 8e-6,
      litellm_provider: "testprov",
    },
    "test/unpriced": { litellm_provider: "testprov" },
  };
  const diff1 = await reg.update(async () => fixture);
  assert.equal(diff1.added.length, 2); // unpriced + sample_spec excluded
  const snap1 = reg.approve("2026-07-07");
  assert.equal(snap1.pricing_version, "2026-07-07");
  assert.equal(Object.keys(snap1.models).length, 2);

  // price change shows up in the diff; re-approve bumps same-day version
  fixture["test/model-a"].input_cost_per_token = 1.5e-6;
  const diff2 = await reg.update(async () => fixture);
  assert.equal(diff2.changed.length, 1);
  assert.equal(diff2.changed[0].from, 1e-6);
  const snap2 = reg.approve("2026-07-07");
  assert.equal(snap2.pricing_version, "2026-07-07.2");
  assert.equal(reg.getApproved()!.pricing_version, "2026-07-07.2");

  // pure-function checks
  const norm = normalizeUpstream(fixture, "t");
  assert.ok(diffSnapshots(null, norm).added.length === 2);
});

test("carbon coefficients: every figure carries a confidence label", () => {
  for (const [k, v] of Object.entries(CARBON_V1)) {
    if (typeof v === "object")
      assert.ok(
        ["Measured", "Benchmarked", "Estimated"].includes(
          (v as { confidence: string }).confidence,
        ),
        `${k} missing confidence label`,
      );
  }
});
