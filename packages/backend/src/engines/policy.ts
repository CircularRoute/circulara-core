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
  // hard floor (§6.8): semantic threshold can never be configured below 0.92
  if (merged.recycle.response.semantic_threshold < 0.92)
    merged.recycle.response.semantic_threshold = 0.92;
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
