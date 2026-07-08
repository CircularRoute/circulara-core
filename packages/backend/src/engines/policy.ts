/**
 * Wave 3 - tenant policy: budgets + technique switches. Zero-config defaults
 * are CONSERVATIVE (§6.1 caution: over-aggressive optimization hurts quality).
 * Stored in tenant_meta under 'policy'; admin-editable via /v1/policy.
 */
import type { TenantContext } from "../db/tenancy.js";

export interface TenantPolicy {
  monthly_budget_usd: number | null; // tenant-wide hard budget (null = off)
  per_seat_monthly_budget_usd: number | null;
  model_allowlist: string[] | null; // null = all models allowed
  reduce: {
    output_cap_tokens: number | null; // clamp max_tokens above this
    context_pruning: boolean; // deterministic dedupe/compaction
    compression: boolean; // deterministic prose/code compaction (TS pass; ML sidecar per AD13 when configured)
    routing: { enabled: boolean; map: Record<string, string>; simple_max_chars: number };
    tool_pruning: { enabled: boolean; allow: string[] | null }; // null = keep all
    prompt_cache: boolean; // inject provider cache_control on stable blocks
  };
  // Wave 4 - Recycle. STRICTLY gated (§6.8): one wrong reuse erodes fleet trust.
  recycle: {
    toolcall: {
      // Deterministic tool-call cache is ALLOWLIST-ONLY: cache nothing until an
      // admin declares a tool deterministic and picks its freshness bucket.
      allow: {
        tool: string; // exact tool name
        bucket: "static" | "daily" | "hourly"; // freshness bucket (§6.2)
        est_cost_usd?: number; // optional: what a re-run costs (paid API fee); unset = book $0, count the hit honestly
      }[];
    };
    response: {
      exact_enabled: boolean; // layer 1: identical request bytes, scoped + TTLed
      semantic_enabled: boolean; // layer 2: OPT-IN (embedding similarity)
      ttl_seconds: number; // conservative default 900
      scope: "seat" | "tenant"; // per-context scoping (§6.8); seat = safest
      semantic_threshold: number; // >= 0.95 enforced floor 0.92
      max_history_messages: number; // conversation-history thresholding (§6.8)
    };
  };
  // Wave 6 - clearance pipeline (§6, D9). Default-deny posture.
  clearance: {
    default_max_tier: "private" | "team" | "org" | "marketable"; // cap when nothing else applies
    rules: { risk_category: string; max_tier: "private" | "team" | "org" | "marketable" }[];
    auto_approve_org: boolean; // org promotion may auto-approve; marketable NEVER does
  };
  // Wave 5 - Reuse library (§6.3-6.6).
  reuse: {
    capture_enabled: boolean; // DEFAULT OFF (§6.6): only capture what an admin enabled
    authorized_asset_types: number[]; // v1 launch classes 1-3
    buy_threshold: number; // <= 0.70 HARD cap (§6.4): only reuse obvious wins
    semantic_enabled: boolean; // fuzzy fingerprint fallback: OPT-IN
    semantic_threshold: number; // >= 0.92 floor, default 0.95
    // QA R2: aggregate ceiling on ESTIMATE-basis avoided $ booked per month.
    // A capture->acquire loop cannot inflate the estimated bucket past this;
    // measured savings (BL2-unforgeable) are unaffected.
    max_monthly_estimated_avoided_usd: number;
  };
}

export const DEFAULT_POLICY: TenantPolicy = {
  monthly_budget_usd: null,
  per_seat_monthly_budget_usd: null,
  model_allowlist: null,
  reduce: {
    output_cap_tokens: null,
    context_pruning: true, // safe: deterministic, reversible reasoning
    compression: true, // safe: whitespace/duplicate collapse only
    routing: { enabled: false, map: {}, simple_max_chars: 2000 }, // opt-in: quality-affecting
    tool_pruning: { enabled: false, allow: null }, // opt-in: needs org knowledge
    prompt_cache: true, // safe: provider-native, no quality effect
  },
  recycle: {
    toolcall: { allow: [] }, // allowlist-only: zero-config caches NOTHING
    response: {
      exact_enabled: true, // identical bytes, seat-scoped, short TTL: safe
      semantic_enabled: false, // OPT-IN: the accuracy-risk layer (§6.8)
      ttl_seconds: 900,
      scope: "seat",
      semantic_threshold: 0.95,
      max_history_messages: 2, // single-turn only by default
    },
  },
  clearance: {
    default_max_tier: "org", // sane default: shareable inside the org, never outside
    rules: [
      { risk_category: "customer_data", max_tier: "team" },
      { risk_category: "hr_personnel", max_tier: "private" },
      { risk_category: "financial", max_tier: "team" },
      { risk_category: "legal", max_tier: "private" },
      { risk_category: "unannounced_product", max_tier: "team" },
      { risk_category: "credentials_or_infra", max_tier: "private" },
    ],
    auto_approve_org: false, // default-deny: even org promotion wants a human until configured
  },
  reuse: {
    capture_enabled: false, // DEFAULT OFF (§6.6) - the standing rule
    authorized_asset_types: [1, 2, 3],
    buy_threshold: 0.7,
    semantic_enabled: false,
    semantic_threshold: 0.95,
    max_monthly_estimated_avoided_usd: 50_000,
  },
};

export async function getPolicy(ctx: TenantContext): Promise<TenantPolicy> {
  const r = await ctx.db.query<{ value: TenantPolicy }>(
    `SELECT value FROM tenant_meta WHERE key = 'policy'`,
  );
  if (r.rows.length === 0) return DEFAULT_POLICY;
  const raw = r.rows[0].value;
  const stored = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<TenantPolicy>;
  // merge over defaults so new fields get sane values for old tenants
  const merged: TenantPolicy = {
    ...DEFAULT_POLICY,
    ...stored,
    reduce: { ...DEFAULT_POLICY.reduce, ...(stored.reduce ?? {}) },
    recycle: {
      toolcall: {
        ...DEFAULT_POLICY.recycle.toolcall,
        ...(stored.recycle?.toolcall ?? {}),
      },
      response: {
        ...DEFAULT_POLICY.recycle.response,
        ...(stored.recycle?.response ?? {}),
      },
    },
  };
  merged.reuse = { ...DEFAULT_POLICY.reuse, ...(stored.reuse ?? {}) };
  merged.clearance = { ...DEFAULT_POLICY.clearance, ...(stored.clearance ?? {}) };
  // hard floor (§6.8): semantic threshold can never be configured below 0.92
  if (merged.recycle.response.semantic_threshold < 0.92)
    merged.recycle.response.semantic_threshold = 0.92;
  if (merged.reuse.semantic_threshold < 0.92)
    merged.reuse.semantic_threshold = 0.92;
  // hard cap (§6.4): buy_threshold can never exceed 0.70
  if (merged.reuse.buy_threshold > 0.7) merged.reuse.buy_threshold = 0.7;
  return merged;
}

export async function setPolicy(
  ctx: TenantContext,
  policy: TenantPolicy,
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO tenant_meta (key, value) VALUES ('policy', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(policy)],
  );
}
