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
import { randomUUID, randomBytes } from "node:crypto";
import { ControlPlane } from "../src/db/tenancy.js";
import { FsObjectStore, sha256hex } from "../src/storage/objectStore.js";
import { buildApp } from "../src/api/server.js";
import { Authenticator } from "../src/auth/auth.js";
import {
  PricingRegistry,
  normalizeUpstream,
  diffSnapshots,
  type PricingSnapshot,
} from "../src/registry/pricing.js";
import { CARBON_V1 } from "../src/registry/carbon.js";

const ADMIN = { authorization: "Bearer dev-admin-token" };
const SEAT = { authorization: "Bearer dev-seat-token" };

export const TEST_KEK = randomBytes(32);
export const TEST_PRICING: PricingSnapshot = {
  pricing_version: "test-2026-07-07",
  source: "fixture",
  fetched_at: "t",
  models: {
    "claude-haiku-4-5-20251001": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 5e-6,
      provider: "anthropic",
    },
  },
};

let control: ControlPlane;
let app: ReturnType<typeof buildApp>;
let tmp: string;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "circulara-test-"));
  control = new ControlPlane(tmp, /* inMemory */ true);
  await control.init();
  app = buildApp({
    control,
    objects: new FsObjectStore(join(tmp, "objects")),
    auth: new Authenticator({
      mode: "dev",
      agentTokenSecret: Buffer.from("test-agent-secret"),
    }),
    gateway: {
      kek: TEST_KEK,
      getPricing: () => TEST_PRICING,
      // fake provider: echoes usage; asserts the REAL key arrived, not the credential
      forward: async (body, providerKey) => {
        if (providerKey !== "sk-ant-test-real-key")
          return { status: 500, json: { error: "wrong provider key reached forward" } };
        return {
          status: 200,
          json: {
            model: (body as { model: string }).model,
            usage: { input_tokens: 100, output_tokens: 20 },
            content: [{ type: "text", text: "ok" }],
          },
        };
      },
    },
  });
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

// ---------- sprint 2 (WS2 + M2) ----------

test("envelope encryption roundtrip + tamper detection", async () => {
  const { envelopeEncrypt, envelopeDecrypt } = await import(
    "../src/keys/envelope.js"
  );
  const blob = envelopeEncrypt(TEST_KEK, "sk-ant-super-secret");
  assert.equal(envelopeDecrypt(TEST_KEK, blob), "sk-ant-super-secret");
  assert.ok(!JSON.stringify(blob).includes("sk-ant-super-secret"));
  const tampered = { ...blob, ct: Buffer.from("xx").toString("base64") };
  assert.throws(() => envelopeDecrypt(TEST_KEK, tampered));
  const wrongKek = randomBytes(32);
  assert.throws(() => envelopeDecrypt(wrongKek, blob));
});

test("agent seat tokens: mint, verify, expiry; humans denied", async () => {
  const authn = new Authenticator({
    mode: "dev",
    agentTokenSecret: Buffer.from("test-agent-secret"),
    agentTokenTtlSeconds: 2,
  });
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "tok" } })
  ).json() as { tenant_id: string };
  const agent = (
    await app.inject({
      method: "POST",
      url: "/v1/seats",
      headers: { ...ADMIN, "x-tenant-id": t.tenant_id },
      payload: { identity_type: "named_agent", user_id: "sso|owner", agent_identity: "nightly-bot" },
    })
  ).json() as { seat_id: string };
  const human = (
    await app.inject({
      method: "POST",
      url: "/v1/seats",
      headers: { ...ADMIN, "x-tenant-id": t.tenant_id },
      payload: { identity_type: "human", user_id: "sso|h" },
    })
  ).json() as { seat_id: string };

  // mint via API for the agent seat
  const mint = await app.inject({
    method: "POST",
    url: `/v1/seats/${agent.seat_id}/token`,
    headers: { ...ADMIN, "x-tenant-id": t.tenant_id },
  });
  assert.equal(mint.statusCode, 201);
  const { token } = mint.json() as { token: string };

  // token verifies as a seat-role principal
  const v = await authn.verify(`Bearer ${await authn.mintAgentToken(t.tenant_id, agent.seat_id)}`);
  assert.ok(v.ok && v.role === "seat" && v.kind === "agent_token");

  // human seats do not get minted tokens (SSO instead)
  const mintHuman = await app.inject({
    method: "POST",
    url: `/v1/seats/${human.seat_id}/token`,
    headers: { ...ADMIN, "x-tenant-id": t.tenant_id },
  });
  assert.equal(mintHuman.statusCode, 400);

  // expiry: 2s TTL token rejected after 3s
  const shortTok = await authn.mintAgentToken(t.tenant_id, agent.seat_id);
  await new Promise((r) => setTimeout(r, 3000));
  const expired = await authn.verify(`Bearer ${shortTok}`);
  assert.ok(!expired.ok);

  // the minted API token is usable as bearer auth for event posting
  const evRes = await app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": t.tenant_id },
    payload: validEvent(agent.seat_id, {
      identity_type: "named_agent",
      agent_identity: "nightly-bot",
    }),
  });
  assert.equal(evRes.statusCode, 201);
});

test("OIDC mode: RS256 verify, admin claim, dev tokens rejected", async () => {
  const { generateKeyPair, SignJWT } = await import("jose");
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const authn = new Authenticator({
    mode: "oidc",
    issuer: "https://idp.example.com",
    audience: "circulara",
    agentTokenSecret: Buffer.from("test-agent-secret"),
    oidcKeyOverride: publicKey,
  });
  const mk = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://idp.example.com")
      .setAudience("circulara")
      .setSubject("sso|alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const seatTok = await authn.verify(`Bearer ${await mk({})}`);
  assert.ok(seatTok.ok && seatTok.role === "seat" && seatTok.subject === "sso|alice");

  const adminTok = await authn.verify(`Bearer ${await mk({ circulara_role: "admin" })}`);
  assert.ok(adminTok.ok && adminTok.role === "admin");

  // dev static tokens are rejected outside dev mode
  const dev = await authn.verify("Bearer dev-admin-token");
  assert.ok(!dev.ok);

  // wrong issuer rejected
  const bad = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://evil.example.com")
    .setAudience("circulara")
    .setSubject("x")
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.ok(!(await authn.verify(`Bearer ${bad}`)).ok);
});

test("M2 gateway: credential -> seat attribution, BYO key forwarding, metering", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "gw" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const seatA = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|amy" },
    })
  ).json() as { seat_id: string };
  const seatB = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|ben" },
    })
  ).json() as { seat_id: string };

  // no provider key yet -> 503
  const credA = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seatA.seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };
  const noKey = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": credA.credential },
    payload: { model: "claude-haiku-4-5-20251001", max_tokens: 8, messages: [] },
  });
  assert.equal(noKey.statusCode, 503);

  // admin sets the BYO key (write-only; envelope-encrypted at rest)
  const put = await app.inject({
    method: "PUT", url: "/v1/provider-keys/anthropic",
    headers: { ...ADMIN, ...th },
    payload: { key: "sk-ant-test-real-key" },
  });
  assert.equal(put.statusCode, 204);
  const listed = (
    await app.inject({ method: "GET", url: "/v1/provider-keys", headers: { ...ADMIN, ...th } })
  ).json() as { configured: string[] };
  assert.deepEqual(listed.configured, ["anthropic"]);

  // at-rest check: raw table row never contains the plaintext key
  const ctx = await control.contextFor(t.tenant_id);
  const raw = await ctx.db.query<{ blob: unknown }>(`SELECT blob FROM provider_keys`);
  assert.ok(!JSON.stringify(raw.rows[0].blob).includes("sk-ant-test-real-key"));

  // bad credential -> 401
  const badCred = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": "ck-nope" },
    payload: { model: "claude-haiku-4-5-20251001", max_tokens: 8, messages: [] },
  });
  assert.equal(badCred.statusCode, 401);

  // seat A and seat B each call through their own credential
  const credB = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seatB.seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };
  for (const cred of [credA.credential, credA.credential, credB.credential]) {
    const r = await app.inject({
      method: "POST", url: "/gateway/anthropic/v1/messages",
      headers: { ...th, "x-api-key": cred },
      payload: { model: "claude-haiku-4-5-20251001", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(r.statusCode, 200); // fake forward proves REAL key arrived
  }

  // metering: per-seat attribution (M2) + registry pricing applied
  const sum = (
    await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, ...th } })
  ).json() as {
    events: number;
    observed_usd: number;
    by_seat: { seat_id: string; events: number }[];
  };
  assert.equal(sum.events, 3);
  const bySeat = Object.fromEntries(sum.by_seat.map((s) => [s.seat_id, s.events]));
  assert.equal(bySeat[seatA.seat_id], 2);
  assert.equal(bySeat[seatB.seat_id], 1);
  // 3 calls x (100 in x 1e-6 + 20 out x 5e-6) = 3 x 0.0002 = 0.0006
  assert.ok(Math.abs(sum.observed_usd - 0.0006) < 1e-9);
});
