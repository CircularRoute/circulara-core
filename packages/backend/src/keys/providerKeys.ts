/**
 * WS2 - per-tenant BYO provider keys, envelope-encrypted at rest (D4).
 * Plaintext exists only in memory, only inside the gateway/worker call path.
 * Admin sets a key; nothing ever reads it back out through the API.
 */
import type { TenantContext } from "../db/tenancy.js";
import {
  envelopeEncrypt,
  envelopeDecrypt,
  type EnvelopeBlob,
} from "./envelope.js";

export type Provider = "anthropic" | "openai" | "gemini";

export async function setProviderKey(
  ctx: TenantContext,
  kek: Buffer,
  provider: Provider,
  secret: string,
): Promise<void> {
  const blob = envelopeEncrypt(kek, secret);
  await ctx.db.query(
    `INSERT INTO provider_keys (provider, blob, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (provider) DO UPDATE SET blob = $2, updated_at = now()`,
    [provider, JSON.stringify(blob)],
  );
}

/** Internal use only (gateway/worker path). Never exposed via API response. */
export async function getProviderKey(
  ctx: TenantContext,
  kek: Buffer,
  provider: Provider,
): Promise<string | null> {
  const res = await ctx.db.query<{ blob: EnvelopeBlob }>(
    `SELECT blob FROM provider_keys WHERE provider = $1`,
    [provider],
  );
  if (res.rows.length === 0) return null;
  const raw = res.rows[0].blob;
  const blob: EnvelopeBlob = typeof raw === "string" ? JSON.parse(raw) : raw;
  return envelopeDecrypt(kek, blob);
}

export async function listProviders(ctx: TenantContext): Promise<string[]> {
  const res = await ctx.db.query<{ provider: string }>(
    `SELECT provider FROM provider_keys ORDER BY provider`,
  );
  return res.rows.map((r) => r.provider);
}
