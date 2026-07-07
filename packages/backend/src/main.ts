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

const control = new ControlPlane(cfg.dataDir);
await control.init();
// wave 5: shared Commons (multi-tenant by design, license-gated; D14/AD8) +
// federated index over the launch catalogs (demand-pulled fixtures in dev)
const { CommonsStore } = await import("./sourcing/commons.js");
const { FederatedIndex, launchCatalogs } = await import("./sourcing/catalogs.js");
const commons = new CommonsStore(cfg.dataDir);
await commons.init();
const index = new FederatedIndex(launchCatalogs());
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
});
await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.log(
  `circulara-core listening on 127.0.0.1:${cfg.port} (auth mode: ${authMode})`,
);
