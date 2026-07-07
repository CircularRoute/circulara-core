/**
 * Wave 8 - per-seat billing (Stripe-class), TEST MODE ONLY.
 *
 * HARD RULES (pricing decision 2026-07-02 + task gates):
 *  - a seat bills ONLY if it emitted >= 1 meter event in the period (idle
 *    seats unbilled, AD6)
 *  - library size and reuse hits are NEVER metered or charged - the invoice
 *    is a function of ACTIVE SEATS and PLAN alone, nothing else (protects
 *    the flywheel; tested explicitly)
 *  - early-adopter coupon: 30% off x 12 months x first 10 orgs, public and
 *    time-boxed; NO ad-hoc discounting path exists
 *  - NO live charges: this module computes invoices and produces test-mode
 *    checkout intents. Real Stripe wiring is founder-gated (no live keys).
 *
 * Plans (decisions.md 2026-07-02): Observe free <=3 seats / Team $59 ($49
 * annual) 4-50 / Business $99 ($79 annual) 25-250 / Enterprise custom.
 */
import type { TenantContext } from "../db/tenancy.js";

export type Plan = "observe" | "team" | "business" | "enterprise";
export type Cycle = "monthly" | "annual";

export const PLAN_PRICES: Record<Plan, Record<Cycle, number>> = {
  observe: { monthly: 0, annual: 0 },
  team: { monthly: 59, annual: 49 },
  business: { monthly: 99, annual: 79 },
  enterprise: { monthly: 0, annual: 0 }, // custom - quoted, never self-serve
};

export const EARLY_ADOPTER = {
  code: "EARLY10",
  discount: 0.3,
  months: 12,
  max_orgs: 10,
};

export interface BillingConfig {
  plan: Plan;
  cycle: Cycle;
  coupon: { code: string; redeemed_at: string } | null;
}

const DEFAULT_BILLING: BillingConfig = { plan: "observe", cycle: "monthly", coupon: null };

export async function getBilling(ctx: TenantContext): Promise<BillingConfig> {
  const r = await ctx.db.query<{ value: BillingConfig }>(
    `SELECT value FROM tenant_meta WHERE key = 'billing'`,
  );
  if (r.rows.length === 0) return DEFAULT_BILLING;
  const raw = r.rows[0].value;
  return { ...DEFAULT_BILLING, ...(typeof raw === "string" ? JSON.parse(raw) : raw) };
}

export async function setBilling(ctx: TenantContext, cfg: BillingConfig): Promise<void> {
  await ctx.db.query(
    `INSERT INTO tenant_meta (key, value) VALUES ('billing', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(cfg)],
  );
}

export interface Invoice {
  period: string; // YYYY-MM
  plan: Plan;
  cycle: Cycle;
  active_seats: number; // seats with >= 1 meter event this period - the ONLY usage input
  price_per_seat_usd: number;
  subtotal_usd: number;
  coupon: { code: string; discount_pct: number; expires: string } | null;
  discount_usd: number;
  total_usd: number;
  mode: "test"; // no live charges exist in this build
  notes: string[];
}

export async function computeInvoice(
  ctx: TenantContext,
  month: string,
): Promise<Invoice> {
  const cfg = await getBilling(ctx);
  // idle seats unbilled: active = emitted >= 1 event in the period (AD6)
  const active = await ctx.db.query<{ n: number }>(
    `SELECT count(DISTINCT seat_id)::int AS n FROM meter_events
      WHERE to_char(ts, 'YYYY-MM') = $1`,
    [month],
  );
  const seats = active.rows[0].n;
  const price = PLAN_PRICES[cfg.plan][cfg.cycle];
  const subtotal = seats * price;

  // coupon: 30% x 12 months from redemption, then silently expires
  let coupon: Invoice["coupon"] = null;
  let discount = 0;
  if (cfg.coupon?.code === EARLY_ADOPTER.code) {
    const redeemed = new Date(cfg.coupon.redeemed_at);
    const expires = new Date(redeemed);
    expires.setUTCMonth(expires.getUTCMonth() + EARLY_ADOPTER.months);
    if (new Date(`${month}-01T00:00:00Z`) < expires) {
      coupon = {
        code: EARLY_ADOPTER.code,
        discount_pct: EARLY_ADOPTER.discount * 100,
        expires: expires.toISOString().slice(0, 10),
      };
      discount = subtotal * EARLY_ADOPTER.discount;
    }
  }
  return {
    period: month,
    plan: cfg.plan,
    cycle: cfg.cycle,
    active_seats: seats,
    price_per_seat_usd: price,
    subtotal_usd: subtotal,
    coupon,
    discount_usd: discount,
    total_usd: subtotal - discount,
    mode: "test",
    notes: [
      "idle seats are unbilled: a seat counts only if it emitted >= 1 meter event this period",
      "library size and reuse hits are NEVER metered or charged - the invoice depends on active seats and plan only",
      cfg.plan === "enterprise" ? "enterprise is custom-quoted; this invoice shows $0 by design" : "",
    ].filter(Boolean),
  };
}

/**
 * Early-adopter redemption: first 10 orgs GLOBALLY (control-plane registry),
 * public and time-boxed - the only discount path that exists.
 */
export async function redeemEarlyAdopter(
  controlDb: { query: (sql: string, params?: unknown[]) => Promise<{ rows: { n?: number }[] }> },
  ctx: TenantContext,
): Promise<{ redeemed: boolean; reason?: string; slot?: number }> {
  const cfg = await getBilling(ctx);
  if (cfg.coupon) return { redeemed: false, reason: "coupon already redeemed for this org" };
  await controlDb.query(
    `CREATE TABLE IF NOT EXISTS early_adopter_redemptions (
       tenant_id text PRIMARY KEY, redeemed_at timestamptz NOT NULL DEFAULT now())`,
  );
  const count = await controlDb.query(
    `SELECT count(*)::int AS n FROM early_adopter_redemptions`,
  );
  const n = count.rows[0].n ?? 0;
  if (n >= EARLY_ADOPTER.max_orgs)
    return { redeemed: false, reason: `early-adopter program is full (first ${EARLY_ADOPTER.max_orgs} orgs)` };
  await controlDb.query(
    `INSERT INTO early_adopter_redemptions (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [ctx.tenantId],
  );
  await setBilling(ctx, {
    ...cfg,
    coupon: { code: EARLY_ADOPTER.code, redeemed_at: new Date().toISOString() },
  });
  return { redeemed: true, slot: n + 1 };
}

/**
 * Stripe-class checkout intent, TEST MODE. Produces the payload the public
 * pricing page's checkout button posts; live Stripe (real keys, webhooks,
 * live charges) is founder-gated and wired at go-live.
 */
export function checkoutIntent(
  plan: Plan,
  cycle: Cycle,
  tenantId: string,
): { mode: "test"; plan: Plan; cycle: Cycle; price_per_seat_usd: number; checkout_url: string; note: string } {
  return {
    mode: "test",
    plan,
    cycle,
    price_per_seat_usd: PLAN_PRICES[plan][cycle],
    checkout_url: `https://checkout.test.invalid/circulara/${tenantId}/${plan}/${cycle}`,
    note: "TEST MODE: no live charge exists in this build. Live Stripe wiring is founder-gated (no Stripe keys configured).",
  };
}
