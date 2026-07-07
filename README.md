# circulara-core

Circulara Observe tier: per-tenant backend + MCP plugin. Sprints 1-4: WS0 (scaffold),
WS6 (pricing registry), WS1 (MCP plugin), WS2 (auth + BYO keys + gateway), WS3
(telemetry pipeline: normalize -> re-price -> append; free-tier cap; OpenAI-format
gateway for Cursor-class hosts), WS4 (meter compute: registry pricing, energy/CO2e
ranges with confidence labels, per user/team/module/month report), WS5 (Observe
dashboard + savings-potential report + monthly statement, server-rendered, Ledger
Light brand tokens; seed a demo tenant with packages/backend/scripts/seed-demo.ts
and open the printed /dashboard URL).
Architecture: /outputs/reports/architecture_v1.md (AD1-AD6, rev 2026-07-07) + the
sourcing addendum (AD7-AD12).

**Pricing placement:** the meter owns money. All three capture paths (hook, tool,
gateway) deliver tokens + model; pricing happens ONCE in the WS3/WS4 pipeline from the
approved registry snapshot. Client-submitted observe events are re-priced server-side;
client cost is a hint, never the booked number. Engine-computed events (reuse/sourcing,
waves 3+) carry their own math and are born meter-priced in-process.

## Workspace layout

| Package | What |
|---|---|
| packages/schema | THE event schema (zod, v1.0+v1.1, AD4/AD12 incl. call_id + M1 stacking rule). Single source of truth for backend intake AND plugin emission |
| packages/backend | Per-tenant backend: tenancy/isolation (PGlite+pgvector dev, per-tenant Postgres prod), append-only meter, seats (AD6), WS2 auth (OIDC + short-lived agent tokens + dev mode), BYO provider keys envelope-encrypted at rest, gateway metering mode (AD3-B, M2 per-seat credentials), object store, WS6 pricing registry + carbon coefficients |
| packages/plugin | MCP plugin (AD3 path C tools: circulara_report, circulara_status) + Claude Code PostToolUse hook (path A observe capture). Validates events against the shared schema BEFORE sending |

## Run

```bash
npm install
npm test              # all workspaces: backend 11 + plugin 4 (in-memory, no keys)
npm run typecheck
npm run dev           # backend on 127.0.0.1:8787 (CIRCULARA_AUTH_MODE=dev|oidc)

# WS6 registry flow (human approves diffs, D12):
npm run registry -- update|approve|show

# WS2 LIVE smoke (deliberate; ~cents on the configured Anthropic key):
cd packages/backend && npx tsx scripts/live-smoke.ts
```

## Auth (WS2)

- Humans: OIDC/SSO (RS256 vs org issuer JWKS; admin via `circulara_role=admin` claim).
- Named agents: short-lived HS256 seat tokens minted at POST /v1/seats/:id/token (admin).
- Dev mode ONLY with CIRCULARA_AUTH_MODE=dev: `Bearer dev-admin-token` / `dev-seat-token`.
- Gateway (M2): per-seat credentials from POST /v1/seats/:id/gateway-credential; the host
  sends the credential as x-api-key to POST /gateway/anthropic/v1/messages; backend maps
  credential -> seat, forwards on the tenant's real key, meters per seat.

## MCP plugin install (Claude Code)

```bash
claude mcp add circulara \
  -e CIRCULARA_BACKEND_URL=http://127.0.0.1:8787 \
  -e CIRCULARA_TENANT_ID=<uuid> -e CIRCULARA_TOKEN=<bearer> \
  -e CIRCULARA_SEAT_ID=<uuid> -e CIRCULARA_USER_ID=<sso-subject> \
  -- npx tsx <repo>/packages/plugin/src/server.ts
```
Hook capture (path A): wire `packages/plugin/src/hook.ts` as a PostToolUse hook (see file
header). The hook never fails the host tool call.

## Invariants the tests enforce

- Tenant isolation; append-only meter_events; admin-only agent seats (AD6).
- avoided_usd == counterfactual - actual; sourcing types require the v1.1 block; M1
  call_id chaining telescopes per-call savings.
- Provider keys never at rest in plaintext (envelope AES-256-GCM, wrong-KEK/tamper throw);
  write-only API (names listed, values never returned).
- Gateway: unknown credential 401; missing tenant key 503; per-seat attribution exact;
  registry-priced usage.
- OIDC: wrong issuer rejected; dev tokens rejected outside dev mode; agent tokens expire.

## Keys

Runtime keys come ONLY from the external env file via loadSecret() (path in
src/config.ts, names in /context/api.md): CIRCULARA_MASTER_KEY (envelope KEK),
CIRCULARA_AGENT_TOKEN_SECRET (agent JWTs), tenant provider keys via the API.
Never hardcoded, never logged, never committed.
