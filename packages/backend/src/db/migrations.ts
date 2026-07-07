/**
 * Per-tenant schema, v1. Mirrors:
 *  - asset metadata record (CEO doc §6.2) + AD12 additions (parent_fp, license_evidence)
 *  - meter event schema v1.0/v1.1 (AD4 + AD12): load-bearing fields as columns,
 *    full validated payload as jsonb. APPEND-ONLY enforced by trigger.
 *  - seats (AD6): human = SSO identity; named agent = admin-provisioned principal.
 *
 * pgvector: semantic_vector dimension is a per-tenant setting (depends on the
 * customer's embedding model, BYO-keys). The scaffold defaults to 1536 and
 * records the choice in tenant_meta; changing it is a migration, by design.
 */
export const TENANT_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenant_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  seat_id        uuid PRIMARY KEY,
  identity_type  text NOT NULL CHECK (identity_type IN ('human','named_agent')),
  user_id        text NOT NULL,             -- SSO subject (human) or owning human (agent)
  team_id        text,
  agent_identity text,                      -- registered agent_id, null for humans
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_needs_identity CHECK (
    identity_type <> 'named_agent' OR agent_identity IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS assets (
  exact_fp         text PRIMARY KEY,        -- sha256 content address (§6.2)
  asset_type       smallint NOT NULL,       -- 1..16 (§5)
  schema_json      jsonb,
  sample_preview   text,
  semantic_vector  vector(1536),            -- description embedding; nullable until embedded
  created_at       timestamptz NOT NULL DEFAULT now(),
  freshness_bucket text NOT NULL DEFAULT 'static',
  ttl_seconds      bigint,
  provenance       jsonb NOT NULL,          -- producer, source, build method
  size_bytes       bigint,
  price            numeric(14,6) DEFAULT 0,
  currency         text DEFAULT 'USD',
  checksum         text NOT NULL,           -- sha256 of bytes
  quality          jsonb NOT NULL DEFAULT '{"rating":null,"num_uses":0,"verified":false}',
  license          jsonb NOT NULL DEFAULT '{"redistributable":false,"spdx_or_terms":null}',
  parent_fp        text REFERENCES assets(exact_fp),  -- AD8/AD12 license inheritance chain
  license_evidence text,
  sharing_tier     text NOT NULL DEFAULT 'private'
    CHECK (sharing_tier IN ('private','team','org','marketable'))
);

CREATE TABLE IF NOT EXISTS meter_events (
  event_id          uuid PRIMARY KEY,
  call_id           uuid NOT NULL,           -- QA M1: per-underlying-call correlation
  schema_version    text NOT NULL,
  ts                timestamptz NOT NULL,
  seat_id           uuid NOT NULL REFERENCES seats(seat_id),
  module            text NOT NULL,
  intervention_type text NOT NULL,
  host              text NOT NULL,
  capture_path      text NOT NULL,
  avoided_usd       numeric(14,6) NOT NULL DEFAULT 0,
  actual_usd        numeric(14,6) NOT NULL DEFAULT 0,
  pricing_version   text NOT NULL,
  sourcing_rung     smallint,                -- v1.1, null for v1.0 events
  sourcing_spend_usd numeric(14,6),          -- v1.1
  payload           jsonb NOT NULL,          -- full validated event
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meter_events_ts   ON meter_events (ts);
CREATE INDEX IF NOT EXISTS meter_events_seat ON meter_events (seat_id, ts);
CREATE INDEX IF NOT EXISTS meter_events_call ON meter_events (call_id);

-- WS2: BYO provider keys, envelope-encrypted at rest (D4). One row per provider.
CREATE TABLE IF NOT EXISTS provider_keys (
  provider   text PRIMARY KEY,
  blob       jsonb NOT NULL,               -- EnvelopeBlob (wrapped DEK + ciphertext)
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- WS2/M2: per-seat gateway credentials. The host sends the credential as its
-- API key; the gateway maps hash -> seat_id, then forwards on the tenant's
-- real provider key. Only the sha256 hash is stored.
CREATE TABLE IF NOT EXISTS gateway_credentials (
  cred_hash  text PRIMARY KEY,             -- sha256 hex of the credential
  seat_id    uuid NOT NULL REFERENCES seats(seat_id),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_credentials_seat ON gateway_credentials (seat_id);

-- Wave 4: deterministic tool-call cache (§6.2 exact-args + freshness-bucket key).
CREATE TABLE IF NOT EXISTS tool_cache (
  key        text PRIMARY KEY,             -- sha256(tool + canonical args + bucket window)
  tool       text NOT NULL,
  bucket     text NOT NULL,
  result     jsonb NOT NULL,
  hits       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_cache_exp ON tool_cache (expires_at);

-- Wave 4: response cache - layer 1 exact + layer 2 gated semantic (§6.8, AD2).
CREATE TABLE IF NOT EXISTS response_cache (
  key        text PRIMARY KEY,             -- sha256(scope + model + canonical request)
  scope      text NOT NULL,                -- seat_id or 'tenant' (per-context scoping)
  model      text NOT NULL,
  query_text text NOT NULL,                -- last user message (semantic layer input)
  embedding  vector(1536),                 -- null until semantic layer embeds it
  response   jsonb NOT NULL,
  usage      jsonb NOT NULL,               -- recorded token usage (counterfactual basis)
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS response_cache_exp   ON response_cache (expires_at);
CREATE INDEX IF NOT EXISTS response_cache_scope ON response_cache (scope);

-- Append-only: the meter's integrity depends on events never mutating (AD4).
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'meter_events is append-only (AD4)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meter_events_immutable ON meter_events;
CREATE TRIGGER meter_events_immutable
  BEFORE UPDATE OR DELETE ON meter_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
`,
  },
];

export const CONTROL_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   uuid PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- prod: connection ref to the tenant's own Postgres. dev: PGlite data dir.
  storage_ref text NOT NULL
);
`,
  },
];
