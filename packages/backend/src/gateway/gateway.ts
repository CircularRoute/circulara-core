/**
 * WS2 - gateway metering mode (AD3 path B) with per-seat attribution (QA M2).
 *
 * The host points its Anthropic-compatible base_url at
 *   POST /gateway/anthropic/v1/messages
 * and sends its PER-SEAT Circulara credential as the x-api-key. We map
 * credential -> seat_id, load the tenant's REAL provider key (envelope-
 * decrypted, in memory only), forward the call, meter real token usage from
 * the response, and emit an observe event priced from the approved registry
 * snapshot. The provider key never reaches the client; the credential never
 * reaches the provider.
 *
 * Disclosure (QA m6): in this mode prompts/completions transit the customer's
 * own per-tenant backend. Stated in architecture_v1.md AD3.
 */
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../db/tenancy.js";
import { seatForCredential } from "../auth/auth.js";
import { getProviderKey } from "../keys/providerKeys.js";
import { ingestEvent } from "../meter/meter.js";
import type { PricingSnapshot } from "../registry/pricing.js";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface GatewayDeps {
  kek: Buffer;
  getPricing: () => PricingSnapshot | null;
  /** test seam: replaces the real provider call */
  forward?: (
    body: unknown,
    providerKey: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
}

async function defaultForward(
  body: unknown,
  providerKey: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": providerKey,
      "anthropic-version": headers["anthropic-version"] ?? "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function priceUsage(
  pricing: PricingSnapshot | null,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; pricingVersion: string } {
  const entry =
    pricing?.models[model] ??
    pricing?.models[`anthropic/${model}`] ??
    null;
  if (!entry) return { usd: 0, pricingVersion: pricing?.pricing_version ?? "unpriced" };
  return {
    usd:
      inputTokens * entry.input_cost_per_token +
      outputTokens * entry.output_cost_per_token,
    pricingVersion: pricing!.pricing_version,
  };
}

export async function handleGatewayMessage(
  ctx: TenantContext,
  deps: GatewayDeps,
  credential: string | undefined,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  // M2: credential -> seat. No seat, no service.
  if (!credential)
    return { status: 401, json: { error: "missing x-api-key (per-seat gateway credential)" } };
  const seatId = await seatForCredential(ctx, credential);
  if (!seatId)
    return { status: 401, json: { error: "unknown or inactive gateway credential" } };

  const providerKey = await getProviderKey(ctx, deps.kek, "anthropic");
  if (!providerKey)
    return {
      status: 503,
      json: { error: "no anthropic provider key configured for this tenant (BYO keys, D4)" },
    };

  const forward = deps.forward ?? defaultForward;
  const res = await forward(body, providerKey, headers);

  // Meter from real usage (observe semantics: counterfactual = actual).
  const usage = (res.json as { usage?: { input_tokens?: number; output_tokens?: number } })
    ?.usage;
  if (res.status === 200 && usage) {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const model = String(body["model"] ?? "unknown");
    const { usd, pricingVersion } = priceUsage(
      deps.getPricing(),
      model,
      inputTokens,
      outputTokens,
    );
    // seat row fields for the event
    const seat = await ctx.db.query<{
      identity_type: "human" | "named_agent";
      user_id: string;
      team_id: string | null;
      agent_identity: string | null;
    }>(
      `SELECT identity_type, user_id, team_id, agent_identity FROM seats WHERE seat_id = $1`,
      [seatId],
    );
    const s = seat.rows[0];
    await ingestEvent(ctx, {
      event_id: randomUUID(),
      call_id: randomUUID(), // one gateway call = one underlying call
      schema_version: "1.0",
      ts: new Date().toISOString(),
      seat_id: seatId,
      identity_type: s.identity_type,
      user_id: s.user_id,
      team_id: s.team_id,
      agent_identity: s.agent_identity,
      host: "other",
      capture_path: "gateway",
      session_id: null,
      module: "meter",
      intervention_type: "observe",
      model_requested: model,
      model_used: model,
      tokens: {
        input_counterfactual: inputTokens,
        output_counterfactual: outputTokens,
        input_actual: inputTokens,
        output_actual: outputTokens,
      },
      cost: {
        counterfactual_usd: usd,
        actual_usd: usd,
        avoided_usd: 0,
        currency: "USD",
        pricing_source: "provider_registry",
        pricing_version: pricingVersion,
      },
      energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
      carbon: {
        avoided_co2e_g: 0,
        grid_intensity_g_per_kwh: 400,
        pue: 1.2,
        region: null,
        method: "EcoLogits-class",
        confidence: "Estimated",
      },
      methodology_version: "esg-v1",
    });
  }
  return res;
}
