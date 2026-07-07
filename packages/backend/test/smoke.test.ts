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
      // fake provider: echoes usage in the right per-format shape; asserts the
      // REAL key arrived, not the credential
      forward: async (url, body, providerKey) => {
        const isOpenAI = url.includes("openai");
        const expectedKey = isOpenAI ? "sk-oai-test-real-key" : "sk-ant-test-real-key";
        if (providerKey !== expectedKey)
          return { status: 500, json: { error: "wrong provider key reached forward" } };
        return {
          status: 200,
          json: {
            model: (body as { model: string }).model,
            usage: isOpenAI
              ? { prompt_tokens: 100, completion_tokens: 20 }
              : { input_tokens: 100, output_tokens: 20 },
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
  // distinct payloads per call: this test proves ATTRIBUTION; identical
  // payloads would (correctly) hit the wave-4 response cache instead
  let n = 0;
  for (const cred of [credA.credential, credA.credential, credB.credential]) {
    const r = await app.inject({
      method: "POST", url: "/gateway/anthropic/v1/messages",
      headers: { ...th, "x-api-key": cred },
      payload: { model: "claude-haiku-4-5-20251001", max_tokens: 8, messages: [{ role: "user", content: `hi ${n++}` }] },
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

// ---------- sprint 3 (WS3 + WS4 + OpenAI gateway) ----------

test("WS3 re-pricing: client observe events are re-priced by the meter", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "reprice" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|rp" },
    })
  ).json() as { seat_id: string };

  // client claims a nonsense cost; meter must book snapshot price instead
  const res = await app.inject({
    method: "POST", url: "/v1/events",
    headers: { ...SEAT, ...th },
    payload: validEvent(seat_id, {
      model_used: "claude-haiku-4-5-20251001",
      model_requested: "claude-haiku-4-5-20251001",
      cost: {
        counterfactual_usd: 999,
        actual_usd: 999,
        avoided_usd: 0,
        currency: "USD",
        pricing_source: "plugin-unpriced",
        pricing_version: "plugin-unpriced",
      },
    }),
  });
  assert.equal(res.statusCode, 201);
  const sum = (
    await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, ...th } })
  ).json() as { observed_usd: number };
  // 1000 x 1e-6 + 200 x 5e-6 = 0.002 from TEST_PRICING, NOT 999
  assert.ok(Math.abs(sum.observed_usd - 0.002) < 1e-9);
});

test("WS3 free-tier cap (m4): 4th seat accepted, tenant flagged over-cap", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "cap" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  for (let i = 0; i < 4; i++) {
    const { seat_id } = (
      await app.inject({
        method: "POST", url: "/v1/seats",
        headers: { ...ADMIN, ...th },
        payload: { identity_type: "human", user_id: `sso|u${i}` },
      })
    ).json() as { seat_id: string };
    const res = await app.inject({
      method: "POST", url: "/v1/events",
      headers: { ...SEAT, ...th },
      payload: validEvent(seat_id, { user_id: `sso|u${i}` }),
    });
    assert.equal(res.statusCode, 201); // ACCEPTED even past the cap - no data loss
  }
  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as { events: number; over_seat_cap: boolean };
  assert.equal(report.events, 4);
  assert.equal(report.over_seat_cap, true);
});

test("WS3 OpenAI-format gateway: Bearer credential, usage mapping, cursor host", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "oai" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|cursor-user" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/provider-keys/openai",
    headers: { ...ADMIN, ...th },
    payload: { key: "sk-oai-test-real-key" },
  });
  const { credential } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };

  // OpenAI convention: Authorization: Bearer <credential>
  const res = await app.inject({
    method: "POST", url: "/gateway/openai/v1/chat/completions",
    headers: { ...th, authorization: `Bearer ${credential}` },
    payload: { model: "claude-haiku-4-5-20251001", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(res.statusCode, 200);

  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as {
    events: number;
    observed_usd: number;
    by_user: { key: string; events: number }[];
  };
  assert.equal(report.events, 1);
  // prompt 100 + completion 20 priced: 100e-6 + 100e-6 = 0.0002
  assert.ok(Math.abs(report.observed_usd - 0.0002) < 1e-9);
  assert.equal(report.by_user[0].key, "sso|cursor-user");
  // host attribution: cursor (payload check)
  const ctx = await control.contextFor(t.tenant_id);
  const row = await ctx.db.query<{ host: string; capture_path: string }>(
    `SELECT host, capture_path FROM meter_events`,
  );
  assert.equal(row.rows[0].host, "cursor");
  assert.equal(row.rows[0].capture_path, "gateway");
});

test("WS4 report: per user/team/module/month attribution + labeled impact ranges", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "report" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const seatOf = async (user: string) =>
    (
      (await app.inject({
        method: "POST", url: "/v1/seats",
        headers: { ...ADMIN, ...th },
        payload: { identity_type: "human", user_id: user },
      })).json() as { seat_id: string }
    ).seat_id;
  const amy = await seatOf("sso|amy");
  const ben = await seatOf("sso|ben");

  // synthetic replayed events: 2 users, 2 teams, 2 months, 2 modules
  const mk = (seat: string, user: string, team: string, ts: string, module: string, it: string, cf: number, act: number) =>
    validEvent(seat, {
      user_id: user,
      team_id: team,
      ts,
      module,
      intervention_type: it,
      model_used: "claude-haiku-4-5-20251001",
      model_requested: "claude-haiku-4-5-20251001",
      tokens: { input_counterfactual: 2000, output_counterfactual: 400, input_actual: 1000, output_actual: 200 },
      cost: {
        counterfactual_usd: cf, actual_usd: act, avoided_usd: cf - act,
        currency: "USD", pricing_source: "meter", pricing_version: "test-2026-07-07",
      },
    });
  const events = [
    mk(amy, "sso|amy", "eng", "2026-06-15T10:00:00Z", "reduce", "compress", 0.01, 0.004),
    mk(amy, "sso|amy", "eng", "2026-07-01T10:00:00Z", "recycle", "toolcall_cache", 0.02, 0.0),
    mk(ben, "sso|ben", "sales", "2026-07-02T10:00:00Z", "reduce", "route", 0.03, 0.01),
  ];
  for (const ev of events) {
    const r = await app.inject({
      method: "POST", url: "/v1/events", headers: { ...SEAT, ...th }, payload: ev,
    });
    assert.equal(r.statusCode, 201);
  }

  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as {
    events: number;
    avoided_usd: number;
    by_user: { key: string; avoided_usd: number }[];
    by_team: { key: string; events: number }[];
    by_module: { key: string; events: number }[];
    by_month: { key: string; events: number }[];
    observed_impact: { energy_kwh: { low: number; median: number; high: number; confidence: string }; co2e_g: { median: number; confidence: string } };
    avoided_impact: { co2e_g: { median: number } };
    methodology_note: string;
  };
  assert.equal(report.events, 3);
  assert.ok(Math.abs(report.avoided_usd - 0.046) < 1e-9); // 0.006+0.02+0.02
  const users = Object.fromEntries(report.by_user.map((u) => [u.key, u.avoided_usd]));
  assert.ok(Math.abs(users["sso|amy"] - 0.026) < 1e-9);
  assert.ok(Math.abs(users["sso|ben"] - 0.02) < 1e-9);
  assert.equal(report.by_team.length, 2);
  assert.equal(report.by_module.length, 2);
  assert.deepEqual(report.by_month.map((m) => m.key).sort(), ["2026-06", "2026-07"]);
  // impact: ranges ordered, confidence labeled, avoided from avoided tokens
  const e = report.observed_impact.energy_kwh;
  assert.ok(e.low < e.median && e.median < e.high);
  assert.ok(["Measured", "Benchmarked", "Estimated"].includes(e.confidence));
  assert.ok(report.observed_impact.co2e_g.median > 0);
  assert.ok(report.avoided_impact.co2e_g.median > 0); // 1200 avoided tokens per event
  assert.ok(report.methodology_note.includes("Ranges"));

  // month filter
  const june = (
    await app.inject({ method: "GET", url: "/v1/meter/report?month=2026-06", headers: { ...SEAT, ...th } })
  ).json() as { events: number };
  assert.equal(june.events, 1);
  const badMonth = await app.inject({
    method: "GET", url: "/v1/meter/report?month=junk", headers: { ...SEAT, ...th },
  });
  assert.equal(badMonth.statusCode, 400);
});

// ---------- sprint 4 (WS5: dashboard + potential + statement) ----------

test("WS5 potential math: multiplicative composition, ordered ranges", async () => {
  const { savingsPotential, TECHNIQUE_BENCHMARKS } = await import(
    "../src/meter/potential.js"
  );
  const p = savingsPotential(1000);
  assert.ok(p.combined_low_pct > 0 && p.combined_high_pct < 1);
  assert.ok(p.combined_low_pct < p.combined_high_pct);
  // multiplicative, not summed: combined < sum of parts (high end)
  const naiveSum = TECHNIQUE_BENCHMARKS.reduce((s, t) => s + t.high, 0);
  assert.ok(p.combined_high_pct < naiveSum);
  assert.ok(Math.abs(p.potential_low_usd - 1000 * p.combined_low_pct) < 1e-9);
  assert.equal(p.confidence, "Benchmarked");
  assert.ok(p.methodology_note.includes("not guarantees"));
});

test("WS5 dashboard/potential/statement render with brand + compliance rules", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "dash" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  // 4 seats -> over free cap (m4 banner + watermark must render)
  const seats: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { seat_id } = (
      await app.inject({
        method: "POST", url: "/v1/seats",
        headers: { ...ADMIN, ...th },
        payload: { identity_type: "human", user_id: `sso|d${i}`, team_id: i % 2 ? "eng" : "data" },
      })
    ).json() as { seat_id: string };
    seats.push(seat_id);
    const r = await app.inject({
      method: "POST", url: "/v1/events", headers: { ...SEAT, ...th },
      payload: validEvent(seat_id, {
        user_id: `sso|d${i}`,
        team_id: i % 2 ? "eng" : "data",
        ts: "2026-07-05T10:00:00Z",
        model_used: "claude-haiku-4-5-20251001",
        model_requested: "claude-haiku-4-5-20251001",
      }),
    });
    assert.equal(r.statusCode, 201);
  }

  // auth: no token -> 401
  const noAuth = await app.inject({ method: "GET", url: `/dashboard?tenant=${t.tenant_id}` });
  assert.equal(noAuth.statusCode, 401);

  const q = `?tenant=${t.tenant_id}&token=dev-seat-token`;
  const dash = await app.inject({ method: "GET", url: `/dashboard${q}` });
  assert.equal(dash.statusCode, 200);
  const html = dash.body;
  assert.ok(html.includes("Observed spend"));
  assert.ok(html.includes("over the free Observe seat limit")); // m4 banner
  assert.ok(html.includes("never netted into savings")); // AD12 external line
  assert.ok(html.includes("kWh")); // energy range
  assert.ok(html.includes("CO2e")); // carbon range
  assert.ok(html.includes("Estimated")); // confidence label
  assert.ok(html.includes("By user") && html.includes("By team") && html.includes("By month"));
  assert.ok(html.includes("IBM Plex Mono")); // figures in mono (brand)
  assert.ok(html.includes("#009BE8") && html.includes("#0E8E4E")); // brand tokens present

  const pot = await app.inject({ method: "GET", url: `/dashboard/potential${q}` });
  assert.equal(pot.statusCode, 200);
  assert.ok(pot.body.includes("Savings potential"));
  assert.ok(pot.body.includes("Benchmarked"));
  assert.ok(pot.body.includes("Generated over the free-tier seat limit")); // m4 watermark
  assert.ok(pot.body.includes("30-40%")); // typical realized range note

  const st = await app.inject({ method: "GET", url: `/dashboard/statement${q}&month=2026-07` });
  assert.equal(st.statusCode, 200);
  assert.ok(st.body.includes("Statement - 2026-07"));
  assert.ok(st.body.includes("$0")); // Observe fee line
  assert.ok(st.body.includes("reported separately")); // AD12
  const badMonth = await app.inject({
    method: "GET", url: `/dashboard/statement${q}&month=nope`,
  });
  assert.equal(badMonth.statusCode, 400);
});

// ---------- wave 3 (Cost-Controller + Reduce) ----------

test("wave3 Cost-Controller: allowlist + budget block with hierarchy ladder, avoided booked", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "ctrl" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|ctrl" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/provider-keys/anthropic",
    headers: { ...ADMIN, ...th }, payload: { key: "sk-ant-test-real-key" },
  });
  const { credential } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };

  // policy: tiny org budget
  const put = await app.inject({
    method: "PUT", url: "/v1/policy",
    headers: { ...ADMIN, ...th },
    payload: { monthly_budget_usd: 0.0001 },
  });
  assert.equal(put.statusCode, 204);

  // check endpoint returns block + ladder (hook path)
  const chk = (
    await app.inject({
      method: "POST", url: "/v1/controller/check",
      headers: { ...SEAT, ...th },
      payload: { model: "claude-haiku-4-5-20251001", input_chars: 40000, max_output_tokens: 4000, seat_id },
    })
  ).json() as { action: string; ladder: { rung: string; status: string }[] };
  assert.equal(chk.action, "block");
  assert.equal(chk.ladder[0].rung, "org_library");
  assert.equal(chk.ladder[0].status, "coming_soon");

  // gateway path: blocked BEFORE forward (402), avoided cost booked
  const gw = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": credential },
    payload: { model: "claude-haiku-4-5-20251001", max_tokens: 4000, messages: [{ role: "user", content: "x".repeat(40000) }] },
  });
  assert.equal(gw.statusCode, 402);
  const gwBody = gw.json() as { reason: string; ladder: unknown[] };
  assert.ok(gwBody.reason.includes("budget"));
  const sum = (
    await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, ...th } })
  ).json() as { avoided_usd: number; observed_usd: number; events: number };
  assert.equal(sum.events, 1);
  assert.ok(sum.avoided_usd > 0); // AVOIDED IS NONZERO - the wave-3 point
  assert.equal(sum.observed_usd, 0); // nothing was spent

  // model allowlist blocks a disallowed model outright
  await app.inject({
    method: "PUT", url: "/v1/policy",
    headers: { ...ADMIN, ...th },
    payload: { model_allowlist: ["claude-haiku-4-5-20251001"] },
  });
  const chk2 = (
    await app.inject({
      method: "POST", url: "/v1/controller/check",
      headers: { ...SEAT, ...th },
      payload: { model: "claude-opus-4-8", input_chars: 10, max_output_tokens: 100, seat_id },
    })
  ).json() as { action: string; reason: string };
  assert.equal(chk2.action, "block");
  assert.ok(chk2.reason.includes("allowlist"));
});

test("wave3 Reduce via gateway: routing + compression stages, M1 chain, report shows avoided", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "reduce" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|rdc" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/provider-keys/anthropic",
    headers: { ...ADMIN, ...th }, payload: { key: "sk-ant-test-real-key" },
  });
  const { credential } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };

  // enable routing opus -> haiku; compression on by default
  await app.inject({
    method: "PUT", url: "/v1/policy",
    headers: { ...ADMIN, ...th },
    payload: {
      reduce: {
        routing: { enabled: true, map: { "claude-opus-4-8": "claude-haiku-4-5-20251001" }, simple_max_chars: 2000 },
      },
    },
  });

  // TEST_PRICING knows haiku only; add opus so routing savings price
  TEST_PRICING.models["claude-opus-4-8"] = {
    input_cost_per_token: 15e-6, output_cost_per_token: 75e-6, provider: "anthropic",
  };

  // simple request on opus -> routed to haiku by the gateway
  const gw = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": credential },
    payload: { model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "What is 2+2?" }] },
  });
  assert.equal(gw.statusCode, 200);

  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as {
    avoided_usd: number; observed_usd: number;
    by_module: { key: string; avoided_usd: number }[];
  };
  // fake forward: 100 in / 20 out. haiku actual = 100e-6+100e-6 = 0.0002
  // routed avoided = opus(100,20)=0.0015+0.0015=0.003 minus haiku 0.0002 = 0.0028
  assert.ok(Math.abs(report.observed_usd - 0.0002) < 1e-9);
  assert.ok(Math.abs(report.avoided_usd - 0.0028) < 1e-9);
  const reduceSlice = report.by_module.find((m) => m.key === "reduce");
  assert.ok(reduceSlice && Math.abs(reduceSlice.avoided_usd - 0.0028) < 1e-9);

  // M1: stage + terminal share one call_id; stage has actual=0
  const ctx = await control.contextFor(t.tenant_id);
  const rows = await ctx.db.query<{
    call_id: string; intervention_type: string; actual_usd: string; avoided_usd: string;
  }>(`SELECT call_id, intervention_type, actual_usd::text, avoided_usd::text FROM meter_events ORDER BY intervention_type`);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0].call_id, rows.rows[1].call_id);
  const stage = rows.rows.find((r) => r.intervention_type === "route")!;
  const terminal = rows.rows.find((r) => r.intervention_type === "observe")!;
  assert.equal(Number(stage.actual_usd), 0);
  assert.ok(Number(stage.avoided_usd) > 0);
  assert.equal(Number(terminal.avoided_usd), 0);

  // statement shows nonzero avoided (the wave-3 end-to-end proof)
  const month = new Date().toISOString().slice(0, 7);
  const st = await app.inject({
    method: "GET",
    url: `/dashboard/statement?tenant=${t.tenant_id}&token=dev-seat-token&month=${month}`,
  });
  assert.equal(st.statusCode, 200);
  assert.ok(st.body.includes("Cost avoided by Circulara"));
  assert.ok(st.body.includes("$0.0028"));
});

test("wave3 Reduce passes: cap conservative rule + prompt-cache measured savings", async () => {
  const { applyReduce, stageSavings } = await import("../src/engines/reduce.js");
  const { DEFAULT_POLICY } = await import("../src/engines/policy.js");
  const pol = {
    ...DEFAULT_POLICY,
    reduce: { ...DEFAULT_POLICY.reduce, output_cap_tokens: 1000 },
  };
  const r = applyReduce(pol, {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    system: "s".repeat(5000),
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.body.max_tokens, 1000);
  const capApplied = r.applied.find((a) => a.technique === "cap")!;
  const cacheApplied = r.applied.find((a) => a.technique === "prompt_cache")!;
  assert.ok(capApplied && cacheApplied);

  // cap: NOT hit -> zero claimed
  const notHit = stageSavings(TEST_PRICING, [capApplied], "claude-haiku-4-5-20251001", {
    input: 100, output: 500, stop_reason: "end_turn",
  });
  assert.equal(notHit.length, 0);
  // cap: hit -> avoided = (4000-1000) output tokens priced
  const hit = stageSavings(TEST_PRICING, [capApplied], "claude-haiku-4-5-20251001", {
    input: 100, output: 1000, stop_reason: "max_tokens",
  });
  assert.equal(hit.length, 1);
  assert.ok(Math.abs(hit[0].avoided_usd - 3000 * 5e-6) < 1e-12);

  // prompt cache: measured from provider-reported cache reads at 90% discount
  const cache = stageSavings(TEST_PRICING, [cacheApplied], "claude-haiku-4-5-20251001", {
    input: 100, output: 10, cache_read: 10000,
  });
  assert.equal(cache.length, 1);
  assert.ok(Math.abs(cache[0].avoided_usd - 10000 * 1e-6 * 0.9) < 1e-12);
});

// ---------- wave 4 (Recycle: tool-call cache + response cache) ----------

test("wave4 tool-call cache: allowlist-only, bucket windows, hit books configured cost", async () => {
  const { toolCacheKey, bucketWindow, canonicalJson } = await import(
    "../src/engines/recycle/toolcache.js"
  );
  // canonical json: key order does not matter
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  // bucket windows in the key: daily key changes across days
  const d1 = new Date("2026-07-07T10:00:00Z");
  const d2 = new Date("2026-07-08T10:00:00Z");
  assert.notEqual(toolCacheKey("t", { q: 1 }, "daily", d1), toolCacheKey("t", { q: 1 }, "daily", d2));
  assert.equal(toolCacheKey("t", { q: 1 }, "static", d1), toolCacheKey("t", { q: 1 }, "static", d2));
  assert.equal(bucketWindow("hourly", d1), "2026-07-07T10");

  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "tc" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|tc" },
    })
  ).json() as { seat_id: string };

  // not allowlisted -> store is a no-op, lookup not cacheable
  const s0 = await app.inject({
    method: "POST", url: "/v1/toolcache/store",
    headers: { ...SEAT, ...th },
    payload: { tool: "sql_select", args: { q: "SELECT 1" }, result: { rows: [1] } },
  });
  assert.equal(s0.statusCode, 200);
  assert.equal((s0.json() as { stored: boolean }).stored, false);

  // allowlist the tool with an est cost
  await app.inject({
    method: "PUT", url: "/v1/policy",
    headers: { ...ADMIN, ...th },
    payload: { recycle: { toolcall: { allow: [{ tool: "sql_select", bucket: "daily", est_cost_usd: 0.05 }] } } },
  });
  const s1 = await app.inject({
    method: "POST", url: "/v1/toolcache/store",
    headers: { ...SEAT, ...th },
    payload: { tool: "sql_select", args: { q: "SELECT 1" }, result: { rows: [1] } },
  });
  assert.equal(s1.statusCode, 201);

  // same args -> hit + event booked with est cost; different args -> miss
  const hit = (
    await app.inject({
      method: "POST", url: "/v1/toolcache/lookup",
      headers: { ...SEAT, ...th },
      payload: { tool: "sql_select", args: { q: "SELECT 1" }, seat_id },
    })
  ).json() as { hit: boolean; result: { rows: number[] }; est_cost_usd: number };
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.result.rows, [1]);
  const miss = (
    await app.inject({
      method: "POST", url: "/v1/toolcache/lookup",
      headers: { ...SEAT, ...th },
      payload: { tool: "sql_select", args: { q: "SELECT 2" }, seat_id },
    })
  ).json() as { hit: boolean };
  assert.equal(miss.hit, false);

  const sum = (
    await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, ...th } })
  ).json() as { avoided_usd: number; events: number };
  assert.equal(sum.events, 1);
  assert.ok(Math.abs(sum.avoided_usd - 0.05) < 1e-9);
});

test("wave4 response cache: exact hit end to end, avoided = full skipped cost", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "rc" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|rc" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/provider-keys/anthropic",
    headers: { ...ADMIN, ...th }, payload: { key: "sk-ant-test-real-key" },
  });
  const { credential } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${seat_id}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };

  const ask = () =>
    app.inject({
      method: "POST", url: "/gateway/anthropic/v1/messages",
      headers: { ...th, "x-api-key": credential },
      payload: {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: "What is the capital of France?" }],
      },
    });

  // first call: real forward + stored; second: served from cache
  const r1 = await ask();
  assert.equal(r1.statusCode, 200);
  const r2 = await ask();
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), r1.json()); // identical cached response

  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as {
    events: number; observed_usd: number; avoided_usd: number;
    by_module: { key: string; avoided_usd: number }[];
  };
  // call 1: observe 0.0002. call 2: recycle hit, avoided 0.0002, spent 0.
  assert.equal(report.events, 2);
  assert.ok(Math.abs(report.observed_usd - 0.0002) < 1e-9);
  assert.ok(Math.abs(report.avoided_usd - 0.0002) < 1e-9);
  const recycle = report.by_module.find((m) => m.key === "recycle");
  assert.ok(recycle && Math.abs(recycle.avoided_usd - 0.0002) < 1e-9);
});

test("wave4 response cache GATES (the poison surface): time-sensitive, history, scope, tools", async () => {
  const { responseCacheGates, exactKey, scopeKey } = await import(
    "../src/engines/recycle/responseCache.js"
  );
  const { DEFAULT_POLICY } = await import("../src/engines/policy.js");

  const base = (content: string, extra: Record<string, unknown> = {}) => ({
    model: "m",
    messages: [{ role: "user", content }],
    ...extra,
  });

  // G1: time-sensitive never cacheable
  for (const q of [
    "What is the weather in NYC today?",
    "latest news on the merger",
    "current price of bitcoin",
    "What is the score right now",
  ]) {
    assert.equal(responseCacheGates(DEFAULT_POLICY, base(q)).cacheable, false, q);
  }
  // stable/factual passes
  assert.equal(
    responseCacheGates(DEFAULT_POLICY, base("What is the capital of France?")).cacheable,
    true,
  );
  // G2: long conversations rejected
  assert.equal(
    responseCacheGates(DEFAULT_POLICY, {
      model: "m",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    }).cacheable,
    false,
  );
  // G6: tool-using requests rejected
  assert.equal(
    responseCacheGates(DEFAULT_POLICY, base("stable question", { tools: [{ name: "x" }] })).cacheable,
    false,
  );
  // G3: seat scoping - same request, different seats -> different keys
  const bodyX = base("What is my account status?");
  assert.notEqual(exactKey("seat-A", bodyX), exactKey("seat-B", bodyX));
  assert.equal(scopeKey(DEFAULT_POLICY, "seat-A"), "seat-A");
  // semantic threshold floor: policy cannot go below 0.92
  const { getPolicy, setPolicy } = await import("../src/engines/policy.js");
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "floor" } })
  ).json() as { tenant_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  const pol = structuredClone(DEFAULT_POLICY);
  pol.recycle.response.semantic_threshold = 0.5; // attacker-friendly config attempt
  await setPolicy(ctx, pol);
  const loaded = await getPolicy(ctx);
  assert.equal(loaded.recycle.response.semantic_threshold, 0.92);
});

test("wave4 semantic layer: gated hit with fake embedder; sub-threshold refuses", async () => {
  const { responseCacheLookup, responseCacheStore } = await import(
    "../src/engines/recycle/responseCache.js"
  );
  const { DEFAULT_POLICY } = await import("../src/engines/policy.js");
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "sem" } })
  ).json() as { tenant_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  const pol = structuredClone(DEFAULT_POLICY);
  pol.recycle.response.semantic_enabled = true;

  // fake 1536-dim embedder: "France" and "France please" near-identical;
  // "Finland" orthogonal-ish (the poison pair)
  const vec = (seedChar: string) => {
    const v = new Array(1536).fill(0);
    v[seedChar.charCodeAt(0) % 1536] = 1;
    return v;
  };
  const embedder = async (text: string) => {
    if (text.includes("Finland")) return vec("Z");
    return vec("F"); // France-family
  };

  const franceBody = {
    model: "m",
    messages: [{ role: "user", content: "What is the capital of France?" }],
  };
  await responseCacheStore(
    ctx, pol, "seat-1", franceBody,
    { content: [{ text: "Paris" }] }, { input_tokens: 10, output_tokens: 2 }, embedder,
  );

  // near-identical phrasing -> semantic hit (sim 1.0 with the fake embedder)
  const paraphrase = {
    model: "m",
    messages: [{ role: "user", content: "What is the capital of France please?" }],
  };
  const hit = await responseCacheLookup(ctx, pol, "seat-1", paraphrase, embedder);
  assert.ok(hit && hit.layer === "semantic");

  // POISON: structurally similar, semantically distinct -> must NOT hit
  const finland = {
    model: "m",
    messages: [{ role: "user", content: "What is the capital of Finland?" }],
  };
  const poison = await responseCacheLookup(ctx, pol, "seat-1", finland, embedder);
  assert.equal(poison, null);

  // cross-seat scope: same question, other seat -> no hit (G3)
  const crossSeat = await responseCacheLookup(ctx, pol, "seat-2", paraphrase, embedder);
  assert.equal(crossSeat, null);

  // no embedder configured -> semantic layer silently unavailable
  const noEmb = await responseCacheLookup(ctx, pol, "seat-1", paraphrase, null);
  assert.equal(noEmb, null);
});
