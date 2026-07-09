/**
 * Dev entrypoint: on-disk PGlite under ./data, Fs object store.
 *
 * WS2 secrets (from the external env file via loadSecret(), per api.md):
 *   CIRCULARA_MASTER_KEY        - 32-byte hex KEK for envelope encryption
 *   CIRCULARA_AGENT_TOKEN_SECRET- HS256 secret for named-agent seat tokens
 * Auth mode: CIRCULARA_AUTH_MODE=dev|oidc (oidc needs CIRCULARA_OIDC_ISSUER /
 * _AUDIENCE). Dev default is dev mode; production deployments set oidc.
 */
import { loadConfig, loadSecret } from "./config.js";
import { ControlPlane } from "./db/tenancy.js";
import { FsObjectStore } from "./storage/objectStore.js";
import { buildApp } from "./api/server.js";
import { Authenticator } from "./auth/auth.js";
import { parseKek } from "./keys/envelope.js";
import { PricingRegistry } from "./registry/pricing.js";
import { join } from "node:path";

const cfg = loadConfig();

const masterKeyHex = loadSecret(cfg, "CIRCULARA_MASTER_KEY");
const agentSecret = loadSecret(cfg, "CIRCULARA_AGENT_TOKEN_SECRET");
if (!masterKeyHex || !agentSecret) {
  // Do not prompt for keys inside code (api.md rule): flag and exit.
  console.error(
    "missing CIRCULARA_MASTER_KEY / CIRCULARA_AGENT_TOKEN_SECRET in the env file (see /context/api.md)",
  );
  process.exit(1);
}

const authMode = (process.env.CIRCULARA_AUTH_MODE ?? "dev") as "dev" | "oidc";
const auth = new Authenticator({
  mode: authMode,
  issuer: process.env.CIRCULARA_OIDC_ISSUER,
  audience: process.env.CIRCULARA_OIDC_AUDIENCE,
  agentTokenSecret: Buffer.from(agentSecret, "utf8"),
});

const registry = new PricingRegistry(
  process.env.CIRCULARA_REGISTRY_DIR ?? "./registry-data",
);

// B2: on Render, DATABASE_URL -> one shared Postgres; else embedded PGlite.
const control = new ControlPlane(cfg.dataDir, false, process.env.DATABASE_URL);
await control.init();
// wave 5: shared Commons (multi-tenant by design, license-gated; D14/AD8) +
// federated index over the launch catalogs (demand-pulled fixtures in dev)
const { CommonsStore } = await import("./sourcing/commons.js");
const { FederatedIndex, launchCatalogs } = await import("./sourcing/catalogs.js");
const commons = new CommonsStore(cfg.dataDir);
await commons.init();
// task 010: live free-catalog HTTP adapters when enabled; fixtures otherwise.
// Paid adapters stay fixture-shaped (customer-account-gated, D15).
let catalogs;
if (process.env.CIRCULARA_LIVE_CATALOGS === "true") {
  const { liveFreeCatalogs } = await import("./sourcing/liveCatalogs.js");
  const { launchCatalogs: paidFixtures } = await import("./sourcing/catalogs.js");
  const paid = paidFixtures().filter((c) => c.tier === "paid");
  catalogs = [...liveFreeCatalogs(), ...paid];
} else {
  catalogs = launchCatalogs();
}
const index = new FederatedIndex(catalogs);
const app = buildApp({
  control,
  objects: new FsObjectStore(join(cfg.dataDir, "objects")),
  auth,
  gateway: {
    kek: parseKek(masterKeyHex),
    getPricing: () => registry.getApproved(),
  },
  commons,
  index,
  // wave 6: classify on the tenant's own cheap model (BYO, §6 step 2)
  classifierFor: async (ctx) => {
    const { getProviderKey } = await import("./keys/providerKeys.js");
    const { makeAnthropicClassifier } = await import("./engines/clearance/pipeline.js");
    const key = await getProviderKey(ctx, parseKek(masterKeyHex!), "anthropic");
    return key ? makeAnthropicClassifier(key) : null;
  },
});
// B3: Render routes to 0.0.0.0:$PORT; bind 0.0.0.0 in production, localhost in dev.
const isProd = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;
const host = process.env.CIRCULARA_HOST ?? (isProd ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port: cfg.port, host });
console.log(
  `circulara-core listening on ${host}:${cfg.port} (auth ${authMode}, ${process.env.DATABASE_URL ? "shared Postgres" : "PGlite"})`,
);
