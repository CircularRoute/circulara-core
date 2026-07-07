/**
 * WS2/WS3 - gateway metering mode (AD3 path B) with per-seat attribution (M2).
 *
 * Two host-format endpoints, one pipeline:
 *   POST /gateway/anthropic/v1/messages          (Anthropic format; x-api-key)
 *   POST /gateway/openai/v1/chat/completions     (OpenAI format, Cursor-class
 *                                                 hosts; Authorization: Bearer)
 * The credential the host sends is the PER-SEAT Circulara credential. We map
 * credential -> seat_id, load the tenant's REAL provider key (envelope-
 * decrypted, memory only), forward, and hand the observed usage to the WS3
 * pipeline (recordCapture) - which prices it from the approved registry
 * snapshot (WS4). Gateways do NOT price; the meter owns money (sprint-3
 * pricing-placement decision, see meter/compute.ts).
 *
 * Disclosure (QA m6): in this mode prompts/completions transit the customer's
 * own per-tenant backend. Stated in architecture_v1.md AD3.
 */
import type { TenantContext } from "../db/tenancy.js";
import { seatForCredential } from "../auth/auth.js";
import { getProviderKey, type Provider } from "../keys/providerKeys.js";
import { recordCapture, type PipelineDeps } from "../pipeline/normalize.js";
import type { PricingSnapshot } from "../registry/pricing.js";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface GatewayDeps {
  kek: Buffer;
  getPricing: () => PricingSnapshot | null;
  /** test seam: replaces the real provider call */
  forward?: (
    url: string,
    body: unknown,
    providerKey: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; json: unknown }>;
}

async function defaultForward(
  url: string,
  body: unknown,
  providerKey: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const isAnthropic = url === ANTHROPIC_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: isAnthropic
      ? {
          "content-type": "application/json",
          "x-api-key": providerKey,
          "anthropic-version": headers["anthropic-version"] ?? "2023-06-01",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${providerKey}`,
        },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

type Format = "anthropic" | "openai";

const FORMAT_CONFIG: Record<
  Format,
  { url: string; provider: Provider; host: "cursor" | "other" }
> = {
  anthropic: { url: ANTHROPIC_URL, provider: "anthropic", host: "other" },
  // OpenAI format is what Cursor-class hosts speak; attribute host accordingly
  openai: { url: OPENAI_URL, provider: "openai", host: "cursor" },
};

/** Extract input/output token usage from either response format. */
function usageFrom(format: Format, json: unknown): { input: number; output: number } | null {
  const j = json as {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
    };
  };
  if (!j?.usage) return null;
  const input =
    format === "anthropic" ? j.usage.input_tokens : j.usage.prompt_tokens;
  const output =
    format === "anthropic" ? j.usage.output_tokens : j.usage.completion_tokens;
  if (input == null && output == null) return null;
  return { input: input ?? 0, output: output ?? 0 };
}

export async function handleGatewayMessage(
  ctx: TenantContext,
  deps: GatewayDeps,
  format: Format,
  credential: string | undefined,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const fc = FORMAT_CONFIG[format];

  // M2: credential -> seat. No seat, no service.
  if (!credential)
    return {
      status: 401,
      json: { error: "missing per-seat gateway credential (x-api-key or Authorization: Bearer)" },
    };
  const seatId = await seatForCredential(ctx, credential);
  if (!seatId)
    return { status: 401, json: { error: "unknown or inactive gateway credential" } };

  const providerKey = await getProviderKey(ctx, deps.kek, fc.provider);
  if (!providerKey)
    return {
      status: 503,
      json: {
        error: `no ${fc.provider} provider key configured for this tenant (BYO keys, D4)`,
      },
    };

  const forward = deps.forward ?? defaultForward;
  const res = await forward(fc.url, body, providerKey, headers);

  // WS3: hand observed usage to the pipeline; pricing happens there (WS4).
  const usage = res.status === 200 ? usageFrom(format, res.json) : null;
  if (usage) {
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
    const pipeline: PipelineDeps = { getPricing: deps.getPricing };
    await recordCapture(ctx, pipeline, {
      capturePath: "gateway",
      host: fc.host,
      seat: { seat_id: seatId, ...s },
      model: typeof body["model"] === "string" ? (body["model"] as string) : null,
      inputTokens: usage.input,
      outputTokens: usage.output,
    });
  }
  return res;
}
