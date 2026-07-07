# circulara-core

Circulara per-tenant backend - Observe tier. Sprint 1: WS0 (backend scaffold) + WS6
(pricing registry / carbon coefficients). Architecture: /outputs/reports/architecture_v1.md
(AD1-AD6) + the sourcing addendum (AD7-AD12).

## What is here

| Path | What |
|---|---|
| src/db/ | Control plane + per-tenant databases (Postgres+pgvector semantics via embedded PGlite in dev; per-tenant managed Postgres in prod behind the same interface) and schema migrations (assets per §6.2 + AD12, append-only meter_events per AD4, seats per AD6) |
| src/api/ | Fastify API skeleton: /healthz, /v1/tenants, /v1/seats, /v1/events, /v1/meter/summary |
| src/auth/ | WS0 auth STUB (dev bearer tokens; AD6 provisioning rules enforced). WS2 replaces with OIDC/SSO |
| src/events/ | Meter event schema v1.0 + v1.1 (zod), AD4 + AD12 |
| src/meter/ | Event intake (validated, append-only) + summary aggregation |
| src/storage/ | Content-addressed object store (sha256 = key). Fs driver for dev; S3 stub |
| src/registry/ | WS6: provider-pricing registry (update -> human reviews diff -> approve -> versioned snapshot) + carbon coefficient feed (confidence-labeled ranges) |
| src/config.ts | Runtime config + the ONLY blessed loader for the external env file (keys never logged) |

## Run

```bash
npm install
npm test              # smoke tests (in-memory, no network, no keys)
npm run typecheck
npm run dev           # API on 127.0.0.1:8787, data under ./data

# WS6 registry flow (human approves diffs, D12):
npm run registry -- update    # fetch upstream prices -> candidate + diff report
npm run registry -- approve   # promote candidate to versioned snapshot
npm run registry -- show
```

Dev auth (WS0 stub only): `Authorization: Bearer dev-admin-token` (admin) or
`dev-seat-token` (seat). Tenant scope via `x-tenant-id` header.

## Invariants the tests enforce

- Tenant isolation: one database per tenant; the only door is TenantContext.
- meter_events is append-only (trigger rejects UPDATE/DELETE).
- Named-agent seats are admin-provisioned only (AD6).
- avoided_usd == counterfactual_usd - actual_usd; sourcing events require the v1.1 block.
- Rung-4 external spend is reported separately, never netted into savings (AD12).
- Object store keys are sha256 of the bytes; reads verify integrity.
- Every carbon coefficient carries a confidence label (D8).

## Keys

No live keys are needed for sprint 1. When WS2 lands, keys load at runtime from the
external env file (path in src/config.ts, per /context/api.md) - never hardcoded,
never logged, never committed.
