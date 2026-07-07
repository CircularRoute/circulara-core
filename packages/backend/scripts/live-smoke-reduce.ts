/**
 * Wave-3 LIVE smoke: one real routed call proves the intervening path end to
 * end - Cost-Controller allow -> Reduce routes opus->haiku -> real Anthropic
 * call on the tenant's BYO key -> stage + terminal events -> report shows
 * NONZERO avoided_usd priced from the approved snapshot.
 *
 * Run deliberately (~$0.001): npx tsx scripts/live-smoke-reduce.ts
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadSecret } from "../src/config.js";
import { ControlPlane } from "../src/db/tenancy.js";
import { FsObjectStore } from "../src/storage/objectStore.js";
import { buildApp } from "../src/api/server.js";
import { Authenticator } from "../src/auth/auth.js";
import { parseKek } from "../src/keys/envelope.js";
import { PricingRegistry } from "../src/registry/pricing.js";

const cfg = loadConfig();
const anthropicKey = loadSecret(cfg, "ANTHROPIC_API_KEY");
const masterKey = loadSecret(cfg, "CIRCULARA_MASTER_KEY");
if (!anthropicKey || !masterKey) {
  console.error("required keys missing in env file - aborting");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "circulara-w3-"));
const control = new ControlPlane(tmp, true);
await control.init();
const registry = new PricingRegistry(join(process.cwd(), "registry-data"));
const app = buildApp({
  control,
  objects: new FsObjectStore(join(tmp, "objects")),
  auth: new Authenticator({ mode: "dev", agentTokenSecret: randomBytes(32) }),
  gateway: { kek: parseKek(masterKey), getPricing: () => registry.getApproved() },
});

const ADMIN = { authorization: "Bearer dev-admin-token" };
const t = (
  await app.inject({ method: "POST", url: "/v1/tenants", headers: ADMIN, payload: { name: "w3-live" } })
).json() as { tenant_id: string };
const th = { "x-tenant-id": t.tenant_id };
const { seat_id } = (
  await app.inject({
    method: "POST", url: "/v1/seats",
    headers: { ...ADMIN, ...th },
    payload: { identity_type: "human", user_id: "sso|w3" },
  })
).json() as { seat_id: string };
await app.inject({
  method: "PUT", url: "/v1/provider-keys/anthropic",
  headers: { ...ADMIN, ...th }, payload: { key: anthropicKey },
});
const { credential } = (
  await app.inject({
    method: "POST", url: `/v1/seats/${seat_id}/gateway-credential`,
    headers: { ...ADMIN, ...th },
  })
).json() as { credential: string };
await app.inject({
  method: "PUT", url: "/v1/policy",
  headers: { ...ADMIN, ...th },
  payload: {
    reduce: {
      routing: {
        enabled: true,
        map: { "claude-opus-4-8": "claude-haiku-4-5-20251001" },
        simple_max_chars: 2000,
      },
    },
  },
});

// a "wastefully premium" request: opus asked, simple question -> should route
const res = await app.inject({
  method: "POST", url: "/gateway/anthropic/v1/messages",
  headers: { ...th, "x-api-key": credential },
  payload: {
    model: "claude-opus-4-8",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with exactly: routed" }],
  },
});
const body = res.json() as {
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  content?: { text?: string }[];
};
if (res.statusCode !== 200) throw new Error(`live call failed: ${res.statusCode} ${JSON.stringify(body)}`);
console.log(
  `live 200: requested claude-opus-4-8, served by ${body.model}, usage in=${body.usage?.input_tokens} out=${body.usage?.output_tokens}, reply="${body.content?.[0]?.text}"`,
);

const report = (
  await app.inject({
    method: "GET", url: "/v1/meter/report",
    headers: { authorization: "Bearer dev-seat-token", ...th },
  })
).json() as {
  events: number; observed_usd: number; avoided_usd: number;
  by_module: { key: string; avoided_usd: number }[];
};
console.log("report:", JSON.stringify(report, null, 2).slice(0, 600));

if (!body.model?.includes("haiku")) throw new Error("expected the call to be routed to haiku");
if (!(report.avoided_usd > 0)) throw new Error("expected NONZERO avoided_usd");
if (!(report.observed_usd > 0)) throw new Error("expected observed spend booked");
if (!(report.avoided_usd > report.observed_usd)) throw new Error("routing opus->haiku should avoid more than it spends");

await app.close();
await control.close();
rmSync(tmp, { recursive: true, force: true });
console.log("WAVE-3 LIVE SMOKE PASS: controller in path, routed for real, avoided_usd > 0 through the meter chain");
