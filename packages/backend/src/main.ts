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

// dev = static tokens (local/tests); consumer = free Observe (email+Google
// dashboard login, HS256 workspace/agent tokens); oidc = enterprise SSO (paid).
const authMode = (process.env.CIRCULARA_AUTH_MODE ?? "dev") as "dev" | "oidc" | "consumer";
const auth = new Authenticator({
  mode: authMode,
  issuer: process.env.CIRCULARA_OIDC_ISSUER,
  audience: process.env.CIRCULARA_OIDC_AUDIENCE,
  agentTokenSecret: Buffer.from(agentSecret, "utf8"),
  workspaceTokenTtlSeconds:
    Number(process.env.CIRCULARA_WORKSPACE_TOKEN_TTL_DAYS ?? 180) * 86400,
});

// B3: production binds 0.0.0.0:$PORT; also decides Secure cookies below.
const isProd = process.env.NODE_ENV === "production" || !!process.env.DATABASE_URL;

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
// Do NOT init() at boot: CommonsStore lazily loads pglite on first use, so the
// prod Postgres box does not pay the WASM cost at startup (builder.20260709.001).
// Commons is empty + demand-seeded (D18), so it is untouched at launch.
const commons = new CommonsStore(cfg.dataDir);
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

// builder.20260708.001: consumer dashboard login (email magic-link + Google).
// Only wired in consumer mode; enterprise SSO (oidc) is a paid concern.
let web: import("./auth/webauth.js").WebAuthDeps | undefined;
if (authMode === "consumer") {
  const sessionSecret = loadSecret(cfg, "CIRCULARA_SESSION_SECRET") ?? agentSecret;
  const baseUrl = process.env.CIRCULARA_APP_BASE_URL ?? `http://127.0.0.1:${cfg.port}`;
  const gid = loadSecret(cfg, "GOOGLE_CLIENT_ID");
  const gsecret = loadSecret(cfg, "GOOGLE_CLIENT_SECRET");
  const brevo = loadSecret(cfg, "BREVO_API_KEY");
  web = {
    mode: "consumer",
    baseUrl,
    sessionSecret: Buffer.from(sessionSecret, "utf8"),
    sessionTtlSeconds: Number(process.env.CIRCULARA_SESSION_TTL_SECONDS ?? 7 * 86400),
    secureCookies: baseUrl.startsWith("https") || isProd,
    control,
    google: gid && gsecret ? { clientId: gid, clientSecret: gsecret } : undefined,
    email: brevo
      ? {
          brevoApiKey: brevo,
          // Brevo-verified sender (same as the marketing site's contact form).
          fromEmail: process.env.CIRCULARA_EMAIL_FROM ?? "hello@circularroute.com",
          fromName: process.env.CIRCULARA_EMAIL_FROM_NAME ?? "Circulara AI",
        }
      : undefined,
  };
}

const app = buildApp({
  control,
  web,
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
const host = process.env.CIRCULARA_HOST ?? (isProd ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port: cfg.port, host });
const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
console.log(
  `circulara-core listening on ${host}:${cfg.port} (auth ${authMode}, ${process.env.DATABASE_URL ? "shared Postgres" : "PGlite"}, boot RSS ${rssMb} MB)`,
);
