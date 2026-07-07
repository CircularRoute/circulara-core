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
};

export async function getPolicy(ctx: TenantContext): Promise<TenantPolicy> {
  const r = await ctx.db.query<{ value: TenantPolicy }>(
    `SELECT value FROM tenant_meta WHERE key = 'policy'`,
  );
  if (r.rows.length === 0) return DEFAULT_POLICY;
  const raw = r.rows[0].value;
  const stored = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<TenantPolicy>;
  // merge over defaults so new fields get sane values for old tenants
  return {
    ...DEFAULT_POLICY,
    ...stored,
    reduce: { ...DEFAULT_POLICY.reduce, ...(stored.reduce ?? {}) },
  };
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
