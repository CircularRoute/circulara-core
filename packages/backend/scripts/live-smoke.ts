/**
 * WS2 LIVE smoke: proves BYO-key handling end to end against the real
 * Anthropic API through the gateway (AD3 path B + M2 attribution).
 *
 * Run deliberately (costs a few cents on the configured key):
 *   npx tsx scripts/live-smoke.ts
 *
 * Flow: in-memory backend -> tenant -> 2 seats -> set REAL provider key
 * (loaded from the external env file; envelope-encrypted at rest) -> issue
 * per-seat gateway credentials -> 2 tiny live calls -> assert per-seat
 * metering + registry pricing. Secrets are never printed.
 */
import { randomBytes } from "node:crypto";
import { loadConfig, loadSecret } from "../src/config.js";
import { ControlPlane } from "../src/db/tenancy.js";
import { FsObjectStore } from "../src/storage/objectStore.js";
import { buildApp } from "../src/api/server.js";
import { Authenticator } from "../src/auth/auth.js";
import { parseKek } from "../src/keys/envelope.js";
import { PricingRegistry } from "../src/registry/pricing.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = "claude-haiku-4-5-20251001"; // cheapest current tier for smoke calls

const cfg = loadConfig();
const anthropicKey = loadSecret(cfg, "ANTHROPIC_API_KEY");
const masterKey = loadSecret(cfg, "CIRCULARA_MASTER_KEY");
if (!anthropicKey || !masterKey) {
  console.error("required keys missing in env file - aborting (see api.md)");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "circulara-live-"));
const control = new ControlPlane(tmp, true);
await control.init();
const registry = new PricingRegistry(join(process.cwd(), "registry-data"));
const app = buildApp({
  control,
  objects: new FsObjectStore(join(tmp, "objects")),
  auth: new Authenticator({
    mode: "dev",
    agentTokenSecret: randomBytes(32),
  }),
  gateway: { kek: parseKek(masterKey), getPricing: () => registry.getApproved() },
});

const ADMIN = { authorization: "Bearer dev-admin-token" };
const t = (
  await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "live-smoke" } })
).json() as { tenant_id: string };
const th = { "x-tenant-id": t.tenant_id };

const mkSeat = async (user: string) =>
  (
    await app.inject({
      method: "POST", url: "/v1/seats",
      headers: { ...ADMIN, ...th },
      payload: { identity_type: "human", user_id: user },
    })
  ).json() as { seat_id: string };
const seatA = await mkSeat("sso|live-a");
const seatB = await mkSeat("sso|live-b");

// real key in, envelope-encrypted at rest; response is 204, key never echoed
const put = await app.inject({
  method: "PUT", url: "/v1/provider-keys/anthropic",
  headers: { ...ADMIN, ...th },
  payload: { key: anthropicKey },
});
if (put.statusCode !== 204) throw new Error(`key set failed: ${put.statusCode}`);

const credFor = async (seatId: string) =>
  (
    await app.inject({
      method: "POST", url: `/v1/seats/${seatId}/gateway-credential`,
      headers: { ...ADMIN, ...th },
    })
  ).json() as { credential: string };
const credA = await credFor(seatA.seat_id);
const credB = await credFor(seatB.seat_id);

// live calls: 2 tiny messages, one per seat
for (const [name, cred] of [
  ["seatA", credA.credential],
  ["seatB", credB.credential],
] as const) {
  const res = await app.inject({
    method: "POST", url: "/gateway/anthropic/v1/messages",
    headers: { ...th, "x-api-key": cred },
    payload: {
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: circular" }],
    },
  });
  const body = res.json() as {
    usage?: { input_tokens: number; output_tokens: number };
    content?: { text?: string }[];
    error?: unknown;
  };
  if (res.statusCode !== 200) throw new Error(`${name} live call failed: ${res.statusCode} ${JSON.stringify(body.error ?? body)}`);
  console.log(
    `${name}: live 200, usage in=${body.usage?.input_tokens} out=${body.usage?.output_tokens}, reply="${body.content?.[0]?.text ?? ""}"`,
  );
}

const sum = (
  await app.inject({
    method: "GET", url: "/v1/meter/summary",
    headers: { authorization: "Bearer dev-seat-token", ...th },
  })
).json() as {
  events: number;
  observed_usd: number;
  by_seat: { seat_id: string; events: number; observed_usd: number }[];
};
console.log("meter:", JSON.stringify(sum, null, 2));

if (sum.events !== 2) throw new Error("expected 2 metered events");
if (sum.by_seat.length !== 2) throw new Error("expected per-seat attribution for 2 seats (M2)");
if (!(sum.observed_usd > 0)) throw new Error("expected priced usage from the approved registry snapshot");

await app.close();
await control.close();
rmSync(tmp, { recursive: true, force: true });
console.log("LIVE SMOKE PASS: BYO key envelope->decrypt->forward, M2 per-seat attribution, registry pricing");
