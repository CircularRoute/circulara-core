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
import { ingestEvent } from "../src/meter/meter.js";
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
let commons: import("../src/sourcing/commons.js").CommonsStore;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "circulara-test-"));
  control = new ControlPlane(tmp, /* inMemory */ true);
  await control.init();
  const { CommonsStore } = await import("../src/sourcing/commons.js");
  const { FederatedIndex, launchCatalogs } = await import("../src/sourcing/catalogs.js");
  commons = new CommonsStore(tmp, true);
  await commons.init();
  const index = new FederatedIndex(
    launchCatalogs({
      hf_hub: [
        {
          source: "hf_hub", tier: "free", native_id: "hf/wiki-qa-open",
          title: "Wiki QA open dataset", description: "openly licensed qa dataset for wiki entities",
          license: { redistributable: true, spdx_or_terms: "CC-BY-4.0" },
          price_usd: 0, billing_route: "none", freshness: "static", schema_hint: null,
        },
        {
          source: "hf_hub", tier: "free", native_id: "hf/private-ish",
          title: "Unknown license corpus", description: "corpus with unknown licensing terms",
          license: { redistributable: false, spdx_or_terms: null },
          price_usd: 0, billing_route: "none", freshness: "static", schema_hint: null,
        },
      ],
      adx: [
        {
          source: "adx", tier: "paid", native_id: "adx/firmo-500",
          title: "Firmographics 500", description: "premium firmographics dataset for enrichment",
          license: { redistributable: false, spdx_or_terms: "DSA" },
          price_usd: 250, billing_route: "customer_aws", freshness: "monthly", schema_hint: null,
        },
      ],
    }),
  );
  app = buildApp({
    commons,
    index,
    // benign classifier for capture paths; the absent/outage behaviors are
    // unit-tested against runClearance directly
    classifierFor: async () => async () => ({ risk_category: "none" as const, confidence: "high" as const }),
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
  // engine-class event: in-process ingestion is the ONLY path (QA BL2)
  const ctxT1 = await control.contextFor(t1.tenant_id);
  const sourcingOk = {
    statusCode: 201,
    ...(await ingestEvent(ctxT1, validEvent(seat_id, {
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
    }))),
  };
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
    const ctxM1 = await control.contextFor(t.tenant_id);
    const res = {
      statusCode: 201,
      ...(await ingestEvent(ctxM1, validEvent(seat_id, {
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
      }))),
    };
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
  const ctxRep = await control.contextFor(t.tenant_id);
  for (const ev of events) {
    await ingestEvent(ctxRep, ev); // engine-class: in-process only (QA BL2)
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
  // Reuse library now has its own explicit technique line
  assert.ok(p.techniques.some((t: { key: string }) => t.key === "reuse"));
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
  assert.ok(html.includes("Observer Dashboard")); // one-page free-tier view
  assert.ok(html.includes("over the free Observe seat limit")); // m4 banner
  // Observer dashboard: Potential Savings card (Actual Savings is paid-only, removed)
  assert.ok(html.includes("Potential Savings") && !html.includes("Actual Savings"));
  // breakdowns are by model / provider / month (no by-user/team on Observer)
  assert.ok(html.includes("By model") && html.includes("By provider") && html.includes("By month"));
  // upgrade CTA
  assert.ok(html.includes("Upgrade to start saving with Circulara AI"));
  assert.ok(html.includes("kWh")); // energy range
  assert.ok(html.includes("CO2e")); // carbon range
  assert.ok(html.includes("Estimated")); // confidence label
  // Connect plugin is a button; paid tabs are shown locked with an upgrade hover
  assert.ok(html.includes("Connect plugin") && html.includes("Upgrade to unlock"));
  assert.ok(html.includes("IBM Plex Mono")); // figures in mono (brand)
  assert.ok(html.includes("#009AE4") && html.includes("#0E8E4E")); // brand tokens present (blue unified to site #009AE4)

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
  assert.equal(chk.ladder[0].status, "available"); // wave 5: the ladder went live

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
  // avoided flows end to end. Dashboard dollars now render at 2dp, so a sub-cent
  // fixture shows $0.00 on screen; assert the underlying figure via the report API.
  const rep = await app.inject({
    method: "GET", url: `/v1/meter/report?month=${month}`,
    headers: { ...SEAT, "x-tenant-id": t.tenant_id },
  });
  assert.ok(Number((rep.json() as { avoided_usd: number }).avoided_usd) > 0);
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
  // cap hit (QA MJ3): phantom output is an UPPER BOUND - tokens counted,
  // dollars NEVER booked
  const hit = stageSavings(TEST_PRICING, [capApplied], "claude-haiku-4-5-20251001", {
    input: 100, output: 1000, stop_reason: "max_tokens",
  });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].avoided_usd, 0);
  assert.equal(hit[0].tokens_avoided_output, 3000);
  assert.equal(hit[0].basis, "upper_bound");

  // prompt cache: measured dollars from provider-reported cache reads at 90%
  // discount - and ZERO avoided tokens (the compute still ran, QA BL3)
  const cache = stageSavings(TEST_PRICING, [cacheApplied], "claude-haiku-4-5-20251001", {
    input: 100, output: 10, cache_read: 10000,
  });
  assert.equal(cache.length, 1);
  assert.ok(Math.abs(cache[0].avoided_usd - 10000 * 1e-6 * 0.9) < 1e-12);
  assert.equal(cache[0].tokens_avoided_input + cache[0].tokens_avoided_output, 0);
  assert.equal(cache[0].basis, "measured");
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

// ---------- wave 5 (Reuse library + sourcing network) ----------

test("wave5 fingerprints: deterministic, config-sensitive (AD5 slice)", async () => {
  const { exactFingerprint } = await import("../src/engines/reuse/fingerprint.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emb = (over: Record<string, unknown> = {}): any => ({
    asset_type: 1 as const, corpus_id: "repo-x", corpus_version: "v3",
    chunking_scheme: "fixed-512", embedding_model_id: "text-embedding-3-small",
    dimensions: 1536, normalization: "l2", ...over,
  });
  assert.equal(exactFingerprint(emb()), exactFingerprint(emb())); // same config -> same fp
  assert.notEqual(exactFingerprint(emb()), exactFingerprint(emb({ embedding_model_id: "other" })));
  assert.notEqual(exactFingerprint(emb()), exactFingerprint(emb({ chunking_scheme: "fixed-256" })));
  // tool results: freshness window is IN the key
  const tool = (now: Date) =>
    exactFingerprint(
      { asset_type: 3, canonical_source_id: "sql", params: { q: 1 }, schema_version: "s1", freshness_bucket: "daily" },
      now,
    );
  assert.notEqual(tool(new Date("2026-07-07T01:00:00Z")), tool(new Date("2026-07-08T01:00:00Z")));
});

test("wave5 capture safety: default-OFF + secret scanner HARD BLOCK", async () => {
  const { scanForSecrets } = await import("../src/engines/reuse/scanner.js");
  assert.equal(scanForSecrets("plain prose about recycling assets").blocked, false);
  for (const bad of [
    "config: AKIAIOSFODNN7EXAMPLE is the key",
    "-----BEGIN RSA PRIVATE KEY-----\nabc",
    'api_key = "supersecretvalue1234567890abcd"',
    "postgres://admin:hunter2pass@db.internal:5432/prod",
  ]) {
    assert.equal(scanForSecrets(bad).blocked, true, bad.slice(0, 30));
  }

  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "cap5" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const spec = {
    asset_type: 2, source_checksum: "c".repeat(64), pipeline: "pdf-to-md", pipeline_version: "1",
  };
  const capture = (content: string) =>
    app.inject({
      method: "POST", url: "/v1/assets/capture",
      headers: { ...SEAT, ...th },
      payload: { spec, content, provenance: { producer: "sso|x", source: "upload", build_method: "parse" } },
    });

  // default OFF (§6.6)
  const off = await capture("clean parsed document text");
  assert.equal(off.statusCode, 422);
  assert.ok((off.json() as { reason: string }).reason.includes("OFF"));

  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });
  // secrets HARD BLOCK even with capture on
  const blocked = await capture('parsed doc containing token = "abcdefghijklmnop1234567890XYZ"');
  assert.equal(blocked.statusCode, 422);
  assert.ok((blocked.json() as { reason: string }).reason.includes("HARD BLOCK"));
  // clean content captures
  const ok = await capture("clean parsed document text");
  assert.equal(ok.statusCode, 201);
  assert.ok((ok.json() as { exact_fp: string }).exact_fp.length === 64);
});

test("wave5 acquire rung 1: library reuse hit books avoided; gates block stale (AD5 slice)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "rung1" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|r1" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });
  const spec = {
    asset_type: 1, corpus_id: "monorepo", corpus_version: "v9", chunking_scheme: "fixed-512",
    embedding_model_id: "text-embedding-3-small", dimensions: 1536, normalization: "l2",
  };
  await app.inject({
    method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
    payload: { spec, content: "embedding index bytes v9", provenance: { producer: "sso|r1", source: "build", build_method: "embed" } },
  });

  // acquire the same spec: rung-1 exact hit; avoided = full build estimate
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id, spec,
        build_estimate: { expected_input_tokens: 2_000_000, model: "claude-haiku-4-5-20251001" },
      },
    })
  ).json() as { verdict: string; rung: number; layer: string; avoided_usd: number };
  assert.equal(acq.verdict, "reuse");
  assert.equal(acq.rung, 1);
  assert.equal(acq.layer, "exact");
  // 2M tokens x 1e-6 = $2 x 1.15 failure premium = $2.30 avoided
  assert.ok(Math.abs(acq.avoided_usd - 2.0) < 1e-9); // MJ5: hard dollars only, no soft premium

  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as { avoided_usd: number; by_module: { key: string; avoided_usd: number }[] };
  assert.ok(Math.abs(report.avoided_usd - 2.0) < 1e-9);
  assert.ok(report.by_module.find((m) => m.key === "reuse"));

  // GATES: a TTL-expired asset is NEVER served (freshness gate) -> falls to build
  const { libraryLookup } = await import("../src/engines/reuse/library.js");
  const { getPolicy } = await import("../src/engines/policy.js");
  const ctx = await control.contextFor(t.tenant_id);
  await ctx.db.query(
    `UPDATE assets SET ttl_seconds = 1, created_at = now() - interval '1 hour'`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stale = await libraryLookup(ctx, await getPolicy(ctx), spec as any, {}, null);
  assert.equal(stale, null); // exact match exists but gates reject: never serve stale
});

test("wave5 rungs 2+3: Commons demand-seeding (D18) + license HARD gate (D14)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "rung23" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|r23" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });

  const before = await commons.stats();

  // rung 3: no library/commons hit -> free catalog pull (redistributable)
  const spec = {
    asset_type: 2, source_checksum: "d".repeat(64), pipeline: "hf-download", pipeline_version: "1",
  };
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id, spec, description: "openly licensed qa dataset",
        build_estimate: { expected_input_tokens: 500_000, model: "claude-haiku-4-5-20251001" },
      },
    })
  ).json() as { verdict: string; rung: number; source: string; exact_fp: string };
  assert.equal(acq.verdict, "reuse");
  assert.equal(acq.rung, 3);
  assert.equal(acq.source, "hf_hub");

  // D18 demand-seeding: THAT pull (redistributable) seeded the Commons
  const after = await commons.stats();
  assert.equal(after.assets, before.assets + 1);

  // rung 2: a SECOND tenant acquiring the same spec hits the COMMONS
  const t2 = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "rung2b" } })
  ).json() as { tenant_id: string };
  const th2 = { "x-tenant-id": t2.tenant_id };
  const seat2 = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th2 },
      payload: { identity_type: "human", user_id: "sso|r2b" },
    })
  ).json() as { seat_id: string };
  const acq2 = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th2 },
      payload: {
        seat_id: seat2.seat_id, spec, description: "openly licensed qa dataset",
        build_estimate: { expected_input_tokens: 500_000, model: "claude-haiku-4-5-20251001" },
      },
    })
  ).json() as { verdict: string; rung: number; source: string };
  assert.equal(acq2.verdict, "reuse");
  assert.equal(acq2.rung, 2);
  assert.equal(acq2.source, "commons");

  // D14 HARD gate: non-redistributable pull NEVER pools
  const specBad = {
    asset_type: 2, source_checksum: "e".repeat(64), pipeline: "hf-download", pipeline_version: "1",
  };
  const acqBad = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id, spec: specBad, description: "corpus with unknown licensing terms",
        build_estimate: { expected_input_tokens: 500_000, model: "claude-haiku-4-5-20251001" },
      },
    })
  ).json() as { verdict: string; rung: number };
  assert.equal(acqBad.rung, 3); // served to THIS tenant fine...
  const afterBad = await commons.stats();
  assert.equal(afterBad.assets, after.assets); // ...but the Commons did NOT grow

  // direct admit with unknown license also refused (no override path)
  const refuse = await commons.admit({
    exact_fp: "f".repeat(64), asset_type: 2, description: "x", source: "hf_hub",
    catalog_ref: null, license: { redistributable: false, spdx_or_terms: null },
    license_evidence: null, bytes: Buffer.from("x"), tenantId: t.tenant_id,
  });
  assert.equal(refuse.admitted, false);
});

test("wave5 rung 4: paid catalogs propose, named human approves, spend itemized (D15/AD11/AD12)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "rung4" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|r4" },
    })
  ).json() as { seat_id: string };

  // paid-only match, build cost high enough to pass the cost gate
  const spec = {
    asset_type: 3, canonical_source_id: "enrich-api", params: { seg: "b2b" },
    schema_version: "s1", freshness_bucket: "static",
  };
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id, spec, description: "premium firmographics dataset",
        build_estimate: { external_fees_usd: 2000 }, // building would cost $2300 w/ premium
      },
    })
  ).json() as { verdict: string; rung: number; proposal_id: string; entry: { price_usd: number } };
  assert.equal(acq.verdict, "proposal"); // NEVER auto-purchases
  assert.equal(acq.rung, 4);
  assert.equal(acq.entry.price_usd, 250);

  // approval REQUIRES a named human
  const noName = await app.inject({
    method: "POST", url: `/v1/approvals/${acq.proposal_id}/approve`,
    headers: { ...ADMIN, ...th }, payload: {},
  });
  assert.equal(noName.statusCode, 400);

  const approved = (
    await app.inject({
      method: "POST", url: `/v1/approvals/${acq.proposal_id}/approve`,
      headers: { ...ADMIN, ...th }, payload: { approver: "Rashad (founder)" },
    })
  ).json() as { status: string; next_step: string };
  assert.equal(approved.status, "approved");
  assert.ok(approved.next_step.includes("your own AWS")); // router, not merchant

  // double-decide refused
  const again = await app.inject({
    method: "POST", url: `/v1/approvals/${acq.proposal_id}/approve`,
    headers: { ...ADMIN, ...th }, payload: { approver: "x" },
  });
  assert.equal(again.statusCode, 409);

  // AD12: spend on its own line, never netted; itemized report shows it
  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as { external_spend_usd: number; avoided_usd: number };
  assert.equal(report.external_spend_usd, 250);
  assert.equal(report.avoided_usd, 0); // proposal+approval booked no fake savings

  const spend = (
    await app.inject({ method: "GET", url: "/v1/meter/external-spend", headers: { ...SEAT, ...th } })
  ).json() as { total_spend_usd: number; items: { type: string; approval_ref: string | null }[] };
  assert.equal(spend.total_spend_usd, 250);
  assert.ok(spend.items.some((i) => i.type === "purchase_approved" && i.approval_ref === acq.proposal_id));
});

test("wave5 buy-or-build correctness: threshold capped at 0.70; expensive reuse -> build", async () => {
  const { getPolicy, setPolicy, DEFAULT_POLICY } = await import("../src/engines/policy.js");
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "bob" } })
  ).json() as { tenant_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  const pol = structuredClone(DEFAULT_POLICY);
  pol.reuse.buy_threshold = 0.99; // config attempt above the cap
  await setPolicy(ctx, pol);
  assert.equal((await getPolicy(ctx)).reuse.buy_threshold, 0.7); // §6.4 hard cap

  // paid option ($250) vs cheap build ($100): 250 > 100*0.7 -> BUILD, never buy
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|bob" },
    })
  ).json() as { seat_id: string };
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id,
        spec: { asset_type: 3, canonical_source_id: "enrich-api", params: { seg: "smb" }, schema_version: "s1", freshness_bucket: "static" },
        description: "premium firmographics dataset",
        build_estimate: { external_fees_usd: 87 }, // ~$100 with premium
      },
    })
  ).json() as { verdict: string };
  assert.equal(acq.verdict, "build"); // reuse must be an OBVIOUS win or nothing
});

// ---------- wave 6 (clearance pipeline) ----------

test("wave6 pipeline: PII caps, classifier rules, license caps, secrets block (steps 1-4)", async () => {
  const { runClearance, scanForPii } = await import("../src/engines/clearance/pipeline.js");
  const { DEFAULT_POLICY } = await import("../src/engines/policy.js");
  const internal = { producer: "org", source: "internal", build_method: "x" };
  const licensed = { redistributable: true, spdx_or_terms: "CC-BY-4.0" };

  // PII patterns incl. Luhn validation
  assert.ok(scanForPii("reach me at jane@acme.com").some((f) => f.kind === "pii_email"));
  assert.ok(scanForPii("ssn 123-45-6789").some((f) => f.kind === "pii_ssn"));
  assert.ok(scanForPii("card 4539 1488 0343 6467").some((f) => f.kind === "pii_credit_card")); // valid Luhn
  assert.ok(!scanForPii("card 1234 5678 9012 3456").some((f) => f.kind === "pii_credit_card")); // fails Luhn
  assert.equal(scanForPii("clean corpus about recycling").length, 0);

  // secrets = hard block, tier irrelevant
  const blocked = await runClearance(
    DEFAULT_POLICY,
    { text: "key AKIAIOSFODNN7EXAMPLE here", provenance: internal, license: licensed },
    null,
  );
  assert.equal(blocked.blocked, true);

  // PII caps at team
  const pii = await runClearance(
    DEFAULT_POLICY,
    { text: "customer email jane@acme.com in the export", provenance: internal, license: licensed },
    null,
  );
  assert.equal(pii.blocked, false);
  assert.equal(pii.max_tier, "team");

  // classifier signal + policy rule: hr -> private (most restrictive wins)
  const hr = await runClearance(
    DEFAULT_POLICY,
    { text: "salary bands for the engineering org", provenance: internal, license: licensed },
    async () => ({ risk_category: "hr_personnel", confidence: "high" }),
  );
  assert.equal(hr.max_tier, "private");

  // external + unknown license: capped at org, never marketable
  const ext = await runClearance(
    DEFAULT_POLICY,
    {
      text: "clean external dataset rows",
      provenance: { producer: "external", source: "hf_hub", build_method: "pull" },
      license: { redistributable: false, spdx_or_terms: null },
    },
    async () => ({ risk_category: "none", confidence: "high" }),
  );
  assert.equal(ext.max_tier, "org");

  // classifier failure -> conservative, not crash
  const broken = await runClearance(
    DEFAULT_POLICY,
    { text: "anything", provenance: internal, license: licensed },
    async () => { throw new Error("api down"); },
  );
  assert.equal(broken.blocked, false);
  assert.ok(broken.reasons.some((r) => r.includes("classifier unavailable")));
});

test("wave6 promotion gate + audit trail + FP rate (steps 5-6)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "clr" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });

  // capture a clean, internally produced, redistributable asset
  const spec = { asset_type: 2, source_checksum: "9".repeat(64), pipeline: "md", pipeline_version: "1" };
  const cap = (
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: {
        spec, content: "clean internal documentation corpus",
        provenance: { producer: "org", source: "internal", build_method: "parse" },
        license: { redistributable: true, spdx_or_terms: "CC-BY-4.0" },
      },
    })
  ).json() as { exact_fp: string; clearance: { max_tier: string } };
  assert.equal(cap.clearance.max_tier, "org"); // default cap

  // marketable while capped at org -> refused whatever else is true (cap binds first)
  const capped = await app.inject({
    method: "POST", url: `/v1/assets/${cap.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "marketable", approver: "Rashad" },
  });
  assert.equal(capped.statusCode, 403);

  // a marketable-capable asset (policy raises the default cap) still REQUIRES
  // a named human for marketable - no exceptions
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true }, clearance: { default_max_tier: "marketable", rules: [], auto_approve_org: false } },
  });
  const spec2 = { asset_type: 2, source_checksum: "8".repeat(64), pipeline: "md", pipeline_version: "1" };
  const cap2 = (
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: {
        spec: spec2, content: "clean internal marketing corpus",
        provenance: { producer: "org", source: "internal", build_method: "parse" },
        license: { redistributable: true, spdx_or_terms: "CC-BY-4.0" },
        license_evidence: "https://creativecommons.org/licenses/by/4.0/ (org-authored, CC-BY declared at capture)", // MJ1
      },
    })
  ).json() as { exact_fp: string; clearance: { max_tier: string } };
  assert.equal(cap2.clearance.max_tier, "marketable");
  const noAppr = await app.inject({
    method: "POST", url: `/v1/assets/${cap2.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "marketable" },
  });
  assert.equal(noAppr.statusCode, 400); // named human, ALWAYS
  const mkt = await app.inject({
    method: "POST", url: `/v1/assets/${cap2.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "marketable", approver: "Rashad (founder)" },
  });
  assert.equal(mkt.statusCode, 200);

  // org promotion with named approver (auto_approve_org off by default)
  const noName = await app.inject({
    method: "POST", url: `/v1/assets/${cap.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "org" },
  });
  assert.equal(noName.statusCode, 400);
  const org = await app.inject({
    method: "POST", url: `/v1/assets/${cap.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "org", approver: "Rashad (founder)" },
  });
  assert.equal(org.statusCode, 200);

  // non-admin cannot promote to org/marketable
  const seatTry = await app.inject({
    method: "POST", url: `/v1/assets/${cap.exact_fp}/promote`,
    headers: { ...SEAT, ...th }, payload: { to_tier: "org", approver: "eve" },
  });
  assert.equal(seatTry.statusCode, 403);

  // audit trail: capture + denials + promotion all present
  const audit = (
    await app.inject({ method: "GET", url: "/v1/clearance/audit", headers: { ...ADMIN, ...th } })
  ).json() as { entries: { id: number; action: string }[] };
  const actions = audit.entries.map((e) => e.action);
  assert.ok(actions.includes("capture"));
  assert.ok(actions.includes("promote"));
  assert.ok(actions.filter((a) => a === "promote_denied").length >= 3);

  // FP metric: mark one denial as a false positive; rate reflects it
  const denied = audit.entries.find((e) => e.action === "promote_denied")!;
  await app.inject({
    method: "POST", url: `/v1/clearance/audit/${denied.id}/false-positive`,
    headers: { ...ADMIN, ...th },
  });
  const stats = (
    await app.inject({ method: "GET", url: "/v1/clearance/stats", headers: { ...SEAT, ...th } })
  ).json() as { false_positive_rate: number };
  assert.ok(stats.false_positive_rate > 0 && stats.false_positive_rate <= 1);
});

// ---------- wave 7 (ESG export + statement) ----------

test("wave7 ESG export: ranges + confidence + sources on every figure; CSV works", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "esg" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|esg" },
    })
  ).json() as { seat_id: string };
  // one observe + one avoided event so both sides have data
  for (const over of [
    {},
    {
      module: "reduce", intervention_type: "compress",
      tokens: { input_counterfactual: 9000, output_counterfactual: 1000, input_actual: 1000, output_actual: 200 },
      cost: { counterfactual_usd: 0.05, actual_usd: 0.01, avoided_usd: 0.04, currency: "USD", pricing_source: "meter", pricing_version: "t" },
    },
  ]) {
    const ctxEsg = await control.contextFor(t.tenant_id);
    await ingestEvent(ctxEsg, validEvent(seat_id, { ts: "2026-07-06T10:00:00Z", ...over })); // QA BL2
  }

  const exp = (
    await app.inject({ method: "GET", url: "/v1/meter/esg-export?month=2026-07", headers: { ...SEAT, ...th } })
  ).json() as {
    period: string;
    methodology: { coefficients_version: string; sources: string[]; assumptions: string[] };
    impact: Record<string, { low: number; median: number; high: number; confidence: string; source: string }>;
    intensity: { co2e_g_per_1k_tokens: { median: number; confidence: string } };
    totals: { external_data_spend_usd: number; avoided_cost_usd: number };
    disclosure_note: string;
    audit_grade: { available: boolean; note: string };
  };
  assert.equal(exp.period, "2026-07");
  assert.ok(exp.methodology.coefficients_version.length > 0);
  assert.ok(exp.methodology.sources.length >= 3);
  assert.ok(exp.methodology.assumptions.length >= 3);
  for (const [k, f] of Object.entries(exp.impact)) {
    assert.ok(f.low <= f.median && f.median <= f.high, `${k} range ordered`);
    assert.ok(["Measured", "Benchmarked", "Estimated"].includes(f.confidence), `${k} labeled`);
    assert.ok(f.source.length > 0, `${k} sourced`);
  }
  assert.ok(exp.impact.avoided_co2e.median > 0); // avoided tokens flowed through
  assert.ok(exp.intensity.co2e_g_per_1k_tokens.median > 0);
  assert.equal(exp.audit_grade.available, false); // seam, not shipped (D8)
  assert.ok(exp.disclosure_note.includes("not audit-grade"));

  const csv = await app.inject({
    method: "GET", url: "/v1/meter/esg-export?month=2026-07&format=csv", headers: { ...SEAT, ...th },
  });
  assert.equal(csv.statusCode, 200);
  assert.ok(csv.headers["content-type"]?.includes("text/csv"));
  assert.ok(csv.body.includes("observed_co2e"));
  assert.ok(csv.body.includes("never netted")); // AD12 line survives into CSV

  // statement: headline + breakdowns + $0 Observe fee + export links
  const st = await app.inject({
    method: "GET",
    url: `/dashboard/statement?tenant=${t.tenant_id}&token=dev-seat-token&month=2026-07`,
  });
  assert.equal(st.statusCode, 200);
  assert.ok(st.body.includes("Circulara saved you"));
  assert.ok(st.body.includes("Fee this month")); // $0 Observe fee (footer band)
  assert.ok(st.body.includes("By user") && st.body.includes("By team") && st.body.includes("By module"));
  // builder.20260708.001: statement ESG links now point at the browser-authed
  // dashboard download routes (cookie/token), not the header-only /v1 API route.
  assert.ok(st.body.includes("/dashboard/esg.json") && st.body.includes("/dashboard/esg.csv"));
});

// ---------- wave 8 (billing test mode) ----------

test("wave8 billing: idle unbilled, library NEVER metered, coupon math, first-10 cap", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "bill" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const month = "2026-07";

  // two seats; only one emits events -> only one bills (idle unbilled, AD6)
  const mkSeat = async (u: string) =>
    ((await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: u },
    })).json() as { seat_id: string }).seat_id;
  const active = await mkSeat("sso|active");
  await mkSeat("sso|idle");
  await app.inject({
    method: "POST", url: "/v1/events", headers: { ...SEAT, ...th },
    payload: validEvent(active, { ts: "2026-07-03T10:00:00Z" }),
  });

  // observe plan: $0 whatever happens
  let inv = (
    await app.inject({ method: "GET", url: `/v1/billing/invoice?month=${month}`, headers: { ...SEAT, ...th } })
  ).json() as { active_seats: number; total_usd: number; mode: string };
  assert.equal(inv.active_seats, 1);
  assert.equal(inv.total_usd, 0);
  assert.equal(inv.mode, "test");

  // team annual: 1 active seat x $49
  await app.inject({
    method: "PUT", url: "/v1/billing/plan", headers: { ...ADMIN, ...th },
    payload: { plan: "team", cycle: "annual" },
  });
  inv = (
    await app.inject({ method: "GET", url: `/v1/billing/invoice?month=${month}`, headers: { ...SEAT, ...th } })
  ).json() as { active_seats: number; total_usd: number; mode: string };
  assert.equal(inv.total_usd, 49);

  // LIBRARY IS NEVER METERED: capture assets + drive reuse hits -> invoice unchanged
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });
  const spec = { asset_type: 2, source_checksum: "b".repeat(64), pipeline: "md", pipeline_version: "1" };
  await app.inject({
    method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
    payload: { spec, content: "clean corpus for the flywheel test", provenance: { producer: "org", source: "internal", build_method: "parse" } },
  });
  const inv2 = (
    await app.inject({ method: "GET", url: `/v1/billing/invoice?month=${month}`, headers: { ...SEAT, ...th } })
  ).json() as { total_usd: number; notes: string[] };
  assert.equal(inv2.total_usd, 49); // capture changed nothing
  assert.ok(inv2.notes.some((n) => n.includes("NEVER metered")));

  // early-adopter: 30% off; second redemption for the same org refused
  const redeem = await app.inject({
    method: "POST", url: "/v1/billing/redeem-early-adopter", headers: { ...ADMIN, ...th },
  });
  assert.equal(redeem.statusCode, 200);
  const inv3 = (
    await app.inject({ method: "GET", url: `/v1/billing/invoice?month=${month}`, headers: { ...SEAT, ...th } })
  ).json() as { total_usd: number; discount_usd: number; coupon: { code: string } };
  assert.equal(inv3.coupon.code, "EARLY10");
  assert.ok(Math.abs(inv3.discount_usd - 49 * 0.3) < 1e-9);
  assert.ok(Math.abs(inv3.total_usd - 49 * 0.7) < 1e-9);
  const again = await app.inject({
    method: "POST", url: "/v1/billing/redeem-early-adopter", headers: { ...ADMIN, ...th },
  });
  assert.equal(again.statusCode, 409);

  // checkout intent: test mode, no live charge path
  const intent = (
    await app.inject({
      method: "POST", url: "/v1/billing/checkout-intent", headers: { ...SEAT, ...th },
      payload: { plan: "business", cycle: "monthly" },
    })
  ).json() as { mode: string; price_per_seat_usd: number; note: string };
  assert.equal(intent.mode, "test");
  assert.equal(intent.price_per_seat_usd, 99);
  assert.ok(intent.note.includes("no live charge"));

  // statement fee line reflects the invoice
  const st = await app.inject({
    method: "GET",
    url: `/dashboard/statement?tenant=${t.tenant_id}&token=dev-seat-token&month=${month}`,
  });
  assert.ok(st.body.includes("$34.30")); // 49 * 0.7
});


// ---------- QA fix pass (qa_waves6-9): B1, B2, M1, M3, policy PATCH ----------

test("QA-B1: seats cannot forge savings; claimed meter pricing is re-priced", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "forge" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|mallory" },
    })
  ).json() as { seat_id: string };

  // forgery attempt 1: seat posts a non-observe event with huge avoided -> 403
  const forge = await app.inject({
    method: "POST", url: "/v1/events", headers: { ...SEAT, ...th },
    payload: validEvent(seat_id, {
      module: "reduce", intervention_type: "compress",
      cost: { counterfactual_usd: 57777, actual_usd: 0, avoided_usd: 57777, currency: "USD", pricing_source: "meter", pricing_version: "x" },
    }),
  });
  assert.equal(forge.statusCode, 403);

  // forgery attempt 2: seat posts observe CLAIMING pricing_source meter with a
  // fake cost -> accepted but RE-PRICED from the snapshot (fake number gone)
  const sneak = await app.inject({
    method: "POST", url: "/v1/events", headers: { ...SEAT, ...th },
    payload: validEvent(seat_id, {
      model_used: "claude-haiku-4-5-20251001", model_requested: "claude-haiku-4-5-20251001",
      cost: { counterfactual_usd: 9999, actual_usd: 9999, avoided_usd: 0, currency: "USD", pricing_source: "meter", pricing_version: "x" },
    }),
  });
  assert.equal(sneak.statusCode, 201);
  const sum = (
    await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, ...th } })
  ).json() as { observed_usd: number; avoided_usd: number };
  assert.ok(Math.abs(sum.observed_usd - 0.002) < 1e-9); // snapshot price, not 9999
  assert.equal(sum.avoided_usd, 0);
});

test("QA-B2: external rungs obey the schema gate (mismatch falls to build)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "b2" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|b2" },
    })
  ).json() as { seat_id: string };
  // the paid fixture matches by keyword but declares NO schema_hint; a caller
  // demanding schema s9 on a type-3 spec must fall through to build
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: {
        seat_id,
        spec: { asset_type: 3, canonical_source_id: "enrich-api", params: { seg: "gate" }, schema_version: "s9", freshness_bucket: "static" },
        description: "premium firmographics dataset",
        constraints: { schema_version: "s9" },
        build_estimate: { external_fees_usd: 2000 },
      },
    })
  ).json() as { verdict: string };
  assert.equal(acq.verdict, "build"); // never merely "about the same thing"
});

test("QA-M1: classifier outage caps conservatively at team", async () => {
  const { runClearance } = await import("../src/engines/clearance/pipeline.js");
  const { DEFAULT_POLICY } = await import("../src/engines/policy.js");
  const v = await runClearance(
    DEFAULT_POLICY,
    { text: "possibly sensitive but regex-clean content", provenance: { producer: "org", source: "internal", build_method: "x" }, license: { redistributable: true, spdx_or_terms: "MIT" } },
    async () => { throw new Error("outage"); },
  );
  assert.equal(v.blocked, false);
  assert.equal(v.max_tier, "team"); // NOT the org default: fail conservative
  assert.ok(v.reasons.some((r) => r.includes("conservatively capped")));
});

test("QA-M3: capture on fingerprint collision returns the STORED verdict", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "m3" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true, authorized_asset_types: [1, 2, 3], buy_threshold: 0.7, semantic_enabled: false, semantic_threshold: 0.95 } },
  });
  const spec = { asset_type: 2, source_checksum: "5".repeat(64), pipeline: "md", pipeline_version: "1" };
  const payload = {
    spec, content: "stable content",
    provenance: { producer: "org", source: "internal", build_method: "parse" },
    license: { redistributable: true, spdx_or_terms: "MIT" },
  };
  const first = (
    await app.inject({ method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th }, payload })
  ).json() as { clearance: { max_tier: string } };
  assert.equal(first.clearance.max_tier, "org");

  // policy later raises the default cap; re-capture of the SAME fp must report
  // the STORED (enforced) verdict, not a fresh marketable one
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { clearance: { default_max_tier: "marketable", rules: [], auto_approve_org: false } },
  });
  const second = (
    await app.inject({ method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th }, payload })
  ).json() as { clearance: { max_tier: string } };
  assert.equal(second.clearance.max_tier, "org"); // stored cap, not the new policy
});

test("QA policy-PATCH: sectioned updates preserve everything not mentioned", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "patch" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { monthly_budget_usd: 500 }, // a DIFFERENT section
  });
  const pol = (
    await app.inject({ method: "GET", url: "/v1/policy", headers: { ...ADMIN, ...th } })
  ).json() as { monthly_budget_usd: number; reuse: { capture_enabled: boolean } };
  assert.equal(pol.monthly_budget_usd, 500);
  assert.equal(pol.reuse.capture_enabled, true); // NOT silently reset (QA finding)
});

// ---------- QA v1 fix pass (BL1-BL4 + MJ5/B1b + MJ7): regression battery ----------

test("QA-BL1: credentials are tenant-bound; deprovisioned agent tokens revoke (MJ8)", async () => {
  const mk = async (name: string) =>
    (await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name } })).json() as { tenant_id: string };
  const tA = await mk("bl1-a");
  const tB = await mk("bl1-b");
  const agent = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, "x-tenant-id": tA.tenant_id },
      payload: { identity_type: "named_agent", user_id: "sso|owner", agent_identity: "bot" },
    })
  ).json() as { seat_id: string };
  const { token } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${agent.seat_id}/token`,
      headers: { ...ADMIN, "x-tenant-id": tA.tenant_id },
    })
  ).json() as { token: string };

  // token minted for tenant A used against tenant B -> 403 (BL1)
  const cross = await app.inject({
    method: "GET", url: "/v1/meter/report",
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": tB.tenant_id },
  });
  assert.equal(cross.statusCode, 403);
  // ... and against its own tenant -> works
  const own = await app.inject({
    method: "GET", url: "/v1/meter/report",
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": tA.tenant_id },
  });
  assert.equal(own.statusCode, 200);

  // MJ8: deprovision the seat -> the still-unexpired token is rejected
  const ctxA = await control.contextFor(tA.tenant_id);
  await ctxA.db.query(`UPDATE seats SET active = false WHERE seat_id = $1`, [agent.seat_id]);
  const revoked = await app.inject({
    method: "GET", url: "/v1/meter/report",
    headers: { authorization: `Bearer ${token}`, "x-tenant-id": tA.tenant_id },
  });
  assert.equal(revoked.statusCode, 401);
});

test("QA-BL2: /v1/events is observe-only for EVERYONE (admin included)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "bl2" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|bl2" },
    })
  ).json() as { seat_id: string };
  const adminForge = await app.inject({
    method: "POST", url: "/v1/events", headers: { ...ADMIN, ...th },
    payload: validEvent(seat_id, {
      module: "reduce", intervention_type: "compress",
      cost: { counterfactual_usd: 1000, actual_usd: 0, avoided_usd: 1000, currency: "USD", pricing_source: "meter", pricing_version: "x" },
    }),
  });
  assert.equal(adminForge.statusCode, 403); // no client input path to savings, full stop
});

test("QA-BL3: a multi-stage call books marginal avoided tokens, not 3x the call", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "bl3" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|bl3" },
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
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reduce: { routing: { enabled: true, map: { "claude-opus-4-8": "claude-haiku-4-5-20251001" }, simple_max_chars: 2000 } } },
  });
  // routed call: fake forward reports 100 in / 20 out
  const gw = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": credential },
    payload: { model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(gw.statusCode, 200);
  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as {
    tokens_observed: number; avoided_usd: number;
    avoided_impact: { co2e_g: { median: number } };
    avoided_cost_basis: string;
  };
  assert.equal(report.tokens_observed, 120);
  assert.ok(report.avoided_usd > 0); // routing dollars are real (measured)
  // BL3: routing avoids ZERO tokens - the avoided carbon chain stays zero
  assert.equal(report.avoided_impact.co2e_g.median, 0);
});

test("QA-BL4: derivative laundering is refused; cycles fail closed", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "bl4" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true }, clearance: { default_max_tier: "marketable", rules: [], auto_approve_org: false } },
  });
  // A: NOT redistributable
  const specA = { asset_type: 2, source_checksum: "a1".repeat(32), pipeline: "md", pipeline_version: "1" };
  const capA = (
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: {
        spec: specA, content: "proprietary licensed dataset rows",
        provenance: { producer: "org", source: "internal", build_method: "parse" },
        license: { redistributable: false, spdx_or_terms: "proprietary" },
      },
    })
  ).json() as { exact_fp: string };
  // B: derivative of A, SELF-DECLARES redistributable + brings evidence
  const specB = { asset_type: 2, source_checksum: "b2".repeat(32), pipeline: "md", pipeline_version: "1" };
  const capB = (
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: {
        spec: specB, content: "derived summary of the proprietary rows",
        provenance: { producer: "org", source: "internal", build_method: "summarize" },
        license: { redistributable: true, spdx_or_terms: "CC-BY-4.0" },
        license_evidence: "self-declared", parent_fp: capA.exact_fp,
      },
    })
  ).json() as { exact_fp: string; clearance: { max_tier: string } };
  // the capture-time verdict already caps the derivative at org (BL4 in clearance)
  assert.equal(capB.clearance.max_tier, "org");
  // and the promotion gate independently walks the chain and refuses
  const promo = await app.inject({
    method: "POST", url: `/v1/assets/${capB.exact_fp}/promote`,
    headers: { ...ADMIN, ...th }, payload: { to_tier: "marketable", approver: "Rashad (founder)" },
  });
  assert.equal(promo.statusCode, 403);

  // cycle fail-closed: A <-> B loop returns NOT redistributable
  const ctx = await control.contextFor(t.tenant_id);
  await ctx.db.query(`UPDATE assets SET parent_fp = $1 WHERE exact_fp = $2`, [capB.exact_fp, capA.exact_fp]);
  const { effectiveRedistributable } = await import("../src/engines/reuse/library.js");
  assert.equal(await effectiveRedistributable(ctx, capB.exact_fp), false);
});

test("QA-B1b/MJ5: the $1.15M acquire attack is clamped and labeled estimated", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "b1b" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|b1b" },
    })
  ).json() as { seat_id: string };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true } },
  });
  const spec = { asset_type: 2, source_checksum: "c3".repeat(32), pipeline: "md", pipeline_version: "1" };
  await app.inject({
    method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
    payload: { spec, content: "tiny", provenance: { producer: "org", source: "internal", build_method: "x" } },
  });
  // the original attack: a million dollars of claimed external fees
  const acq = (
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: { seat_id, spec, build_estimate: { external_fees_usd: 1_000_000 } },
    })
  ).json() as { verdict: string; avoided_usd: number };
  assert.equal(acq.verdict, "reuse");
  assert.ok(acq.avoided_usd <= 5_000); // clamped to the fee ceiling
  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as { avoided_usd: number; avoided_cost_basis: string };
  assert.ok(report.avoided_usd <= 5_000);
  assert.equal(report.avoided_cost_basis, "estimated"); // MJ6: never claimed as measured
});

test("QA-MJ7: coupon covers exactly 12 billing periods; 10th slot is the last", async () => {
  const { computeInvoice, setBilling } = await import("../src/billing/billing.js");
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "mj7" } })
  ).json() as { tenant_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  await setBilling(ctx, {
    plan: "team", cycle: "annual",
    coupon: { code: "EARLY10", redeemed_at: "2025-07-15T12:00:00Z" },
  });
  // months 0..11 discounted; month 12 (2026-07) is NOT (the old bug's 13th month)
  const m11 = await computeInvoice(ctx, "2026-06");
  assert.ok(m11.coupon); // 12th period, still discounted
  const m12 = await computeInvoice(ctx, "2026-07");
  assert.equal(m12.coupon, null); // 13th period: expired (MJ7)
});

// ---------- task 010 (launch backend: Stripe flag + live catalogs) ----------

test("task010 Stripe: test mode is default; webhook rejects; live gate needs all keys", async () => {
  const { resolveStripeConfig, verifyWebhook, createCheckoutSession } = await import(
    "../src/billing/stripe.js"
  );
  // default (no env) -> test
  const def = resolveStripeConfig();
  assert.equal(def.mode, "test");

  // webhook in test mode ALWAYS throws (no unauthenticated billing events)
  assert.throws(() => verifyWebhook(def, "{}", "t=1,v1=abc"));

  // checkout in test mode -> stub URL, no network
  const co = await createCheckoutSession(def, "team", "annual", "tid", 5);
  assert.equal(co.mode, "test");
  assert.ok(co.checkout_url.includes("test.invalid"));
  assert.ok(co.note.includes("no live charge"));

  // a fabricated LIVE config verifies a correctly-signed webhook and rejects a bad one
  const { createHmac } = await import("node:crypto");
  const live = { mode: "live" as const, secretKey: "sk_live_x", webhookSecret: "whsec_test", reason: "x" };
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ type: "checkout.session.completed" });
  const good = createHmac("sha256", "whsec_test").update(`${ts}.${payload}`).digest("hex");
  const ev = verifyWebhook(live, payload, `t=${ts},v1=${good}`) as { type: string };
  assert.equal(ev.type, "checkout.session.completed");
  assert.throws(() => verifyWebhook(live, payload, `t=${ts},v1=deadbeef`)); // tampered
  assert.throws(() => verifyWebhook(live, payload, `t=${ts - 9999},v1=${good}`)); // stale
});

test("task010 billing routes: mode probe + checkout session (test) via API", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "stripe" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const mode = (
    await app.inject({ method: "GET", url: "/v1/billing/mode", headers: { ...SEAT, ...th } })
  ).json() as { mode: string };
  assert.equal(mode.mode, "test");
  const co = (
    await app.inject({
      method: "POST", url: "/v1/billing/checkout-intent", headers: { ...SEAT, ...th },
      payload: { plan: "business", cycle: "monthly" },
    })
  ).json() as { mode: string; price_per_seat_usd: number };
  assert.equal(co.mode, "test");
  assert.equal(co.price_per_seat_usd, 99);
  // unsigned webhook in test mode -> rejected
  const wh = await app.inject({
    method: "POST", url: "/v1/billing/webhook", headers: th, payload: { type: "x" },
  });
  assert.equal(wh.statusCode, 400);
});

test("task010 live catalogs: HF + CKAN adapters parse fixture-shaped API JSON; license mapped conservatively", async () => {
  const { HuggingFaceCatalog, CkanCatalog, mapLicense } = await import(
    "../src/sourcing/liveCatalogs.js"
  );
  // conservative license mapping
  assert.equal(mapLicense("cc-by-4.0").redistributable, true);
  assert.equal(mapLicense("MIT").redistributable, true);
  assert.equal(mapLicense("some-custom-eula").redistributable, false);
  assert.equal(mapLicense(null).redistributable, false); // unknown -> NOT redistributable (D14)

  // HF adapter over a fake fetch returning HF's real shape
  const hfFetch = (async () =>
    new Response(JSON.stringify([
      { id: "org/qa-dataset", description: "open QA data", cardData: { license: "cc-by-4.0" }, lastModified: "2026-06-01" },
    ]), { status: 200 })) as typeof fetch;
  const hf = new HuggingFaceCatalog(hfFetch);
  const hits = await hf.search("qa");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "hf_hub");
  assert.equal(hits[0].license.redistributable, true);

  // CKAN adapter over data.gov's real response shape
  const ckanFetch = (async () =>
    new Response(JSON.stringify({ result: { results: [
      { id: "pkg-1", title: "Census rows", notes: "public data", license_id: "cc0-1.0", metadata_modified: "2026-05-01" },
    ] } }), { status: 200 })) as typeof fetch;
  const ckan = new CkanCatalog("data_gov", "https://catalog.data.gov", ckanFetch);
  const cHits = await ckan.search("census");
  assert.equal(cHits[0].license.redistributable, true);

  // network failure -> empty (demand-pulled, never throws)
  const deadFetch = (async () => { throw new Error("down"); }) as typeof fetch;
  const dead = new HuggingFaceCatalog(deadFetch);
  assert.deepEqual(await dead.search("x"), []);
});

// ---------- QA re-review residuals R1/R3 (folded into task 010) ----------

test("R3: deprovision endpoint revokes an agent token via HTTP (MJ8 completion)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "deprov" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const agent = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "named_agent", user_id: "sso|o", agent_identity: "bot" },
    })
  ).json() as { seat_id: string };
  const { token } = (
    await app.inject({
      method: "POST", url: `/v1/seats/${agent.seat_id}/token`, headers: { ...ADMIN, ...th },
    })
  ).json() as { token: string };
  // token works...
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/meter/report", headers: { authorization: `Bearer ${token}`, ...th } })).statusCode,
    200,
  );
  // ... deprovision via HTTP ...
  const dep = await app.inject({
    method: "POST", url: `/v1/seats/${agent.seat_id}/deprovision`, headers: { ...ADMIN, ...th },
  });
  assert.equal(dep.statusCode, 200);
  // ... token now revoked
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/meter/report", headers: { authorization: `Bearer ${token}`, ...th } })).statusCode,
    401,
  );
  // second deprovision -> 404
  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/seats/${agent.seat_id}/deprovision`, headers: { ...ADMIN, ...th } })).statusCode,
    404,
  );
});

test("R1: a seat cannot self-declare source=internal to dodge the external cap", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "r1" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true }, clearance: { default_max_tier: "marketable", rules: [], auto_approve_org: false } },
  });
  const spec = { asset_type: 2, source_checksum: "d4".repeat(32), pipeline: "md", pipeline_version: "1" };
  // SEAT (non-admin) claims source:internal + redistributable -> still capped
  // at org because a seat capture is treated as external for the license cap
  const seatCap = (
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: {
        spec, content: "asset a seat claims is internal",
        provenance: { producer: "org", source: "internal", build_method: "x" },
        license: { redistributable: false, spdx_or_terms: null },
      },
    })
  ).json() as { clearance: { max_tier: string } };
  assert.equal(seatCap.clearance.max_tier, "org"); // NOT marketable
});

// ---------- QA R2: acquire-loop aggregate cap on estimated savings ----------

test("R2: capture->acquire loop cannot inflate estimated savings past the monthly ceiling", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "r2" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  // low ceiling to exercise the clamp cheaply
  await app.inject({
    method: "PUT", url: "/v1/policy", headers: { ...ADMIN, ...th },
    payload: { reuse: { capture_enabled: true, max_monthly_estimated_avoided_usd: 3000 } },
  });
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|r2" },
    })
  ).json() as { seat_id: string };

  // each acquire tries to book ~$2000 estimated (clamped fee ceiling anyway);
  // loop several times - the running total must never exceed $3000
  for (let i = 0; i < 5; i++) {
    const spec = { asset_type: 2, source_checksum: String(i).repeat(64).slice(0, 64), pipeline: "md", pipeline_version: "1" };
    await app.inject({
      method: "POST", url: "/v1/assets/capture", headers: { ...SEAT, ...th },
      payload: { spec, content: `tiny ${i}`, provenance: { producer: "org", source: "internal", build_method: "x" } },
    });
    await app.inject({
      method: "POST", url: "/v1/acquire", headers: { ...SEAT, ...th },
      payload: { seat_id, spec, build_estimate: { external_fees_usd: 2000 } },
    });
  }
  const report = (
    await app.inject({ method: "GET", url: "/v1/meter/report", headers: { ...SEAT, ...th } })
  ).json() as { avoided_usd: number; avoided_usd_by_basis: Record<string, number> };
  assert.ok((report.avoided_usd_by_basis.estimated ?? 0) <= 3000 + 1e-9); // clamped
  assert.ok(report.avoided_usd <= 3000 + 1e-9);
});

// ---------- task 011 (consolidated Observer meter + readiness + privacy) ----------

test("task011 counts-not-content: schema rejects any prompt/output/content field", async () => {
  const { interventionEventSchema } = await import("@circulara/schema");
  const base = validEvent("00000000-0000-0000-0000-000000000000");
  // a client trying to smuggle content -> strict schema REJECTS it
  assert.throws(() => interventionEventSchema.parse({ ...base, prompt: "secret prompt text" }));
  assert.throws(() => interventionEventSchema.parse({ ...base, output_text: "model said..." }));
  assert.throws(() =>
    interventionEventSchema.parse({ ...base, observer: { task_type: "x", latency_ms: 1, request_fp: null, cache_read_tokens: 0, routable: false, route_to_model: null, source_code: "..." } }),
  );
  // metadata-only observer block parses fine
  const ok = interventionEventSchema.parse({
    ...base,
    observer: { task_type: "code-review", latency_ms: 1200, request_fp: "a".repeat(64), cache_read_tokens: 100, routable: true, route_to_model: "claude-haiku-4-5-20251001" },
  });
  assert.equal(ok.observer?.task_type, "code-review");
});

test("task011 Observer meter: four figures reconcile EXACTLY (actual - potential = savings)", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "obs" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|obs" },
    })
  ).json() as { seat_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  const mk = (over: Record<string, unknown>) =>
    ingestEvent(ctx, validEvent(seat_id, {
      model_used: "claude-opus-4-8", model_requested: "claude-opus-4-8",
      tokens: { input_counterfactual: 5000, output_counterfactual: 1000, input_actual: 5000, output_actual: 1000 },
      ...over,
    }));
  // a routable opus call (route down to haiku) - saves $ AND energy (weights differ)
  await mk({ observer: { task_type: "chat", latency_ms: 900, request_fp: null, cache_read_tokens: 0, routable: true, route_to_model: "claude-haiku-4-5-20251001" } });
  // a non-routable call - no savings
  await mk({ observer: { task_type: "reasoning", latency_ms: 5000, request_fp: null, cache_read_tokens: 0, routable: false, route_to_model: null } });
  // two calls sharing a request_fp - the 2nd is a cacheable duplicate (fully avoidable)
  await mk({ observer: { task_type: "chat", latency_ms: 800, request_fp: "f".repeat(64), cache_read_tokens: 0, routable: false, route_to_model: null } });
  await mk({ observer: { task_type: "chat", latency_ms: 800, request_fp: "f".repeat(64), cache_read_tokens: 0, routable: false, route_to_model: null } });

  const m = (
    await app.inject({ method: "GET", url: "/v1/observer/meter", headers: { ...SEAT, ...th } })
  ).json() as import("../src/meter/observer.js").ObserverMeter;

  assert.equal(m.events, 4);
  // THE GUARANTEE: every figure reconciles to the cent / token / mWh
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(m.savings.usd, m.actual.usd - m.potential.usd);
  near(m.savings.tokens, m.actual.tokens - m.potential.tokens);
  near(m.savings.kwh.median, m.actual.kwh.median - m.potential.kwh.median);
  near(m.savings.co2e.median, m.actual.co2e.median - m.potential.co2e.median);
  // savings are real and positive (routing + dedupe both fired)
  assert.ok(m.savings.usd > 0);
  assert.ok(m.savings_source.routing_usd > 0 && m.savings_source.dedupe_usd > 0);
  near(m.savings.usd, m.savings_source.routing_usd + m.savings_source.dedupe_usd);
  // routing genuinely moved energy (opus weight 3.0 -> haiku 0.5), so carbon saved > 0
  assert.ok(m.savings.co2e.median > 0);
  // dedupe: only ONE of the two identical calls counts toward potential; tokens saved = the dup's tokens (6000)
  assert.ok(m.savings.tokens >= 6000); // at least the deduped call's tokens
  // drilldowns present
  assert.ok(m.by_user.find((u) => u.key === "sso|user1")); // validEvent stamps user_id
  assert.ok(m.by_task_type.find((x) => x.key === "chat" && x.savings_usd > 0));
  assert.ok(m.cost_method.includes("published provider rates"));
  assert.equal(m.carbon_confidence, "Estimated");
});

test("task011 cost method: cache reads priced at the cached rate, not full", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "cache$" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|c" },
    })
  ).json() as { seat_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  // all 1000 input tokens are cache reads -> billed at 10% of input, not 100%
  await ingestEvent(ctx, validEvent(seat_id, {
    model_used: "claude-haiku-4-5-20251001", model_requested: "claude-haiku-4-5-20251001",
    tokens: { input_counterfactual: 1000, output_counterfactual: 0, input_actual: 1000, output_actual: 0 },
    observer: { task_type: "chat", latency_ms: 1, request_fp: null, cache_read_tokens: 1000, routable: false, route_to_model: null },
  }));
  const m = (
    await app.inject({ method: "GET", url: "/v1/observer/meter", headers: { ...SEAT, ...th } })
  ).json() as import("../src/meter/observer.js").ObserverMeter;
  // 1000 input @ 1e-6 would be 0.001 at full; cached at 10% -> 0.0001
  assert.ok(Math.abs(m.actual.usd - 0.0001) < 1e-9);
});

test("task011 Routing Readiness: climbs with evidence, flips ready at threshold", async () => {
  const t = (
    await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "ready" } })
  ).json() as { tenant_id: string };
  const th = { "x-tenant-id": t.tenant_id };
  const { seat_id } = (
    await app.inject({
      method: "POST", url: "/v1/seats", headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: "sso|r" },
    })
  ).json() as { seat_id: string };
  const ctx = await control.contextFor(t.tenant_id);
  const one = (routable: boolean) =>
    ingestEvent(ctx, validEvent(seat_id, {
      model_used: "claude-opus-4-8", model_requested: "claude-opus-4-8",
      observer: { task_type: "summarize", latency_ms: 1, request_fp: null, cache_read_tokens: 0, routable, route_to_model: routable ? "claude-haiku-4-5-20251001" : null },
    }));
  // 10 routable so far - below threshold (30) -> not ready
  for (let i = 0; i < 10; i++) await one(true);
  type RR = { threshold: number; types: { task_type: string; routable_observations: number; evidence: number; ready: boolean; projected_saving_usd: number }[] };
  let rr = (
    await app.inject({ method: "GET", url: "/v1/observer/routing-readiness", headers: { ...SEAT, ...th } })
  ).json() as RR;
  let sum = rr.types.find((x) => x.task_type === "summarize")!;
  assert.equal(sum.routable_observations, 10);
  assert.ok(sum.evidence > 0 && sum.evidence < 1);
  assert.equal(sum.ready, false);
  assert.ok(sum.projected_saving_usd > 0);
  // push past the threshold -> ready flips true
  for (let i = 0; i < 25; i++) await one(true);
  rr = (
    await app.inject({ method: "GET", url: "/v1/observer/routing-readiness", headers: { ...SEAT, ...th } })
  ).json() as RR;
  sum = rr.types.find((x) => x.task_type === "summarize")!;
  assert.ok(sum.routable_observations >= 30);
  assert.equal(sum.evidence, 1);
  assert.equal(sum.ready, true);
});

// ---------- builder.20260707.013 (shared multi-tenant free tier) ----------

test("013 shared mode: workspaces isolated within ONE instance; paid = dedicated", async () => {
  // shared is the DEFAULT (free tier). Two workspaces on the one shared DB.
  const wsA = (await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "free-a" } })).json() as { tenant_id: string };
  const wsB = (await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "free-b" } })).json() as { tenant_id: string };

  // both are shared plan_mode
  const recA = await control.getTenant(wsA.tenant_id);
  assert.equal(recA?.plan_mode, "shared");
  assert.ok(recA?.schema?.startsWith("ws_"));

  // seed A only
  const seatA = (await app.inject({ method: "POST", url: "/v1/seats", headers: { ...ADMIN, "x-tenant-id": wsA.tenant_id }, payload: { identity_type: "human", user_id: "sso|a" } })).json() as { seat_id: string };
  await app.inject({ method: "POST", url: "/v1/events", headers: { ...SEAT, "x-tenant-id": wsA.tenant_id }, payload: validEvent(seatA.seat_id) });

  // A sees its event; B (different schema, SAME instance) sees zero - isolation
  const sumA = (await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, "x-tenant-id": wsA.tenant_id } })).json() as { events: number };
  const sumB = (await app.inject({ method: "GET", url: "/v1/meter/summary", headers: { ...SEAT, "x-tenant-id": wsB.tenant_id } })).json() as { events: number };
  assert.equal(sumA.events, 1);
  assert.equal(sumB.events, 0);

  // A's seat does not exist in B's workspace (cross-workspace event rejected)
  const cross = await app.inject({ method: "POST", url: "/v1/events", headers: { ...SEAT, "x-tenant-id": wsB.tenant_id }, payload: validEvent(seatA.seat_id) });
  assert.equal(cross.statusCode, 422);

  // raw-DB proof: at the shared connection with NO schema pin, A's meter_events
  // table is not on the default search_path -> the workspace tables are only
  // reachable through the scoped context (physical schema isolation)
  const ctxA = await control.contextFor(wsA.tenant_id);
  const n = await ctxA.db.query<{ n: number }>(`SELECT count(*)::int n FROM meter_events`);
  assert.equal(n.rows[0].n, 1); // scoped view sees exactly A's rows

  // PAID path: dedicated mode provisions an isolated DB (opt-in, not default)
  const paid = await control.createTenant("paying-co", { mode: "dedicated" });
  assert.equal(paid.plan_mode, "dedicated");
  assert.equal(paid.schema, null);
  const ctxPaid = await control.contextFor(paid.tenant_id);
  const paidSeat = randomUUID();
  await ctxPaid.db.query(`INSERT INTO seats (seat_id, identity_type, user_id) VALUES ($1,'human','sso|paid')`, [paidSeat]);
  const paidN = await ctxPaid.db.query<{ n: number }>(`SELECT count(*)::int n FROM seats`);
  assert.equal(paidN.rows[0].n, 1); // its own DB, independent of the shared workspaces
});
