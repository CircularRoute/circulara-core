/**
 * Task 010 - Stripe wiring, behind a feature flag. TEST MODE IS THE DEFAULT.
 *
 * MONEY HARD GATE: this module NEVER creates a live charge on its own. Live
 * mode requires ALL of:
 *   - CIRCULARA_BILLING_LIVE=true          (explicit env opt-in)
 *   - STRIPE_SECRET_KEY present + starts "sk_live_"  (a real founder key)
 *   - STRIPE_WEBHOOK_SECRET present
 * Absent any of these, mode is "test": checkout produces a stub URL and the
 * webhook verifier refuses. Adding the live keys and flipping the flag is a
 * FOUNDER action, parked in /awaiting_approval - the Builder ships the wiring,
 * never the switch.
 *
 * No Stripe SDK dependency: we call the REST API with fetch (test only) and
 * verify webhook signatures with Node crypto. Keys load via loadSecret().
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig, loadSecret } from "../config.js";
import type { Plan, Cycle } from "./billing.js";
import { PLAN_PRICES } from "./billing.js";

export type BillingMode = "test" | "live";

export interface StripeConfig {
  mode: BillingMode;
  secretKey: string | null;
  webhookSecret: string | null;
  reason: string;
}

/** Resolve the mode from env - defaults CLOSED (test) unless every live gate is met. */
export function resolveStripeConfig(): StripeConfig {
  const cfg = loadConfig();
  const live = process.env.CIRCULARA_BILLING_LIVE === "true";
  const key = loadSecret(cfg, "STRIPE_SECRET_KEY");
  const wh = loadSecret(cfg, "STRIPE_WEBHOOK_SECRET");
  if (!live)
    return { mode: "test", secretKey: null, webhookSecret: null, reason: "CIRCULARA_BILLING_LIVE not set (default test mode)" };
  if (!key || !key.startsWith("sk_live_"))
    return { mode: "test", secretKey: null, webhookSecret: null, reason: "no sk_live_ key present - refusing to go live (money gate)" };
  if (!wh)
    return { mode: "test", secretKey: null, webhookSecret: null, reason: "STRIPE_WEBHOOK_SECRET missing - webhook cannot be verified" };
  return { mode: "live", secretKey: key, webhookSecret: wh, reason: "live billing enabled by founder" };
}

/**
 * Verify a Stripe webhook signature (the t=,v1= scheme) without the SDK.
 * Returns the parsed event on success, throws on any mismatch. In test mode
 * (no webhook secret) this ALWAYS throws - a test deployment must not accept
 * unauthenticated billing events.
 */
export function verifyWebhook(
  scfg: StripeConfig,
  payload: string,
  signatureHeader: string | undefined,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): unknown {
  if (scfg.mode !== "live" || !scfg.webhookSecret)
    throw Object.assign(new Error("webhook rejected: billing is in test mode"), { statusCode: 400 });
  if (!signatureHeader)
    throw Object.assign(new Error("missing stripe-signature header"), { statusCode: 400 });
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const ts = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!ts || !v1) throw Object.assign(new Error("malformed signature header"), { statusCode: 400 });
  if (Math.abs(now - ts) > toleranceSeconds)
    throw Object.assign(new Error("signature timestamp outside tolerance"), { statusCode: 400 });
  const expected = createHmac("sha256", scfg.webhookSecret)
    .update(`${ts}.${payload}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw Object.assign(new Error("signature verification failed"), { statusCode: 400 });
  return JSON.parse(payload);
}

export interface CheckoutSession {
  mode: BillingMode;
  plan: Plan;
  cycle: Cycle;
  price_per_seat_usd: number;
  checkout_url: string;
  note: string;
}

/**
 * Create a checkout session. In TEST mode returns a stub URL (no network, no
 * charge). In LIVE mode POSTs to Stripe with the founder key - but the caller
 * only reaches live mode after the founder flipped the flag and added keys.
 */
export async function createCheckoutSession(
  scfg: StripeConfig,
  plan: Plan,
  cycle: Cycle,
  tenantId: string,
  seats: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSession> {
  const price = PLAN_PRICES[plan][cycle];
  if (scfg.mode === "test" || !scfg.secretKey)
    return {
      mode: "test",
      plan,
      cycle,
      price_per_seat_usd: price,
      checkout_url: `https://checkout.test.invalid/circulara/${tenantId}/${plan}/${cycle}`,
      note: `TEST MODE (${scfg.reason}): no live charge. Founder enables live billing + keys to activate.`,
    };
  // LIVE path: subscription checkout on the founder's account. Per-seat qty.
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": `Circulara ${plan} (${cycle})`,
    "line_items[0][price_data][unit_amount]": String(price * 100),
    "line_items[0][price_data][recurring][interval]": cycle === "annual" ? "year" : "month",
    "line_items[0][quantity]": String(Math.max(1, seats)),
    "metadata[tenant_id]": tenantId,
    "metadata[plan]": plan,
    success_url: "https://circulara.ai/billing/success",
    cancel_url: "https://circulara.ai/pricing",
  });
  const res = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${scfg.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const j = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok || !j.url)
    throw Object.assign(new Error(`stripe checkout failed: ${j.error?.message ?? res.status}`), { statusCode: 502 });
  return {
    mode: "live",
    plan,
    cycle,
    price_per_seat_usd: price,
    checkout_url: j.url,
    note: "LIVE billing - transacts on the Circular Route Stripe account.",
  };
}
