/**
 * Wave 4 - response cache: layer 1 exact + layer 2 GATED semantic (§6.8).
 *
 * Accuracy risk is the whole game here: one wrong reuse erodes fleet trust,
 * so every layer is gated conservatively and the gates run BEFORE any lookup:
 *
 *   G1 time-sensitivity: queries about now/today/latest/prices/news NEVER hit
 *      the cache (either layer) - fresh-by-nature.
 *   G2 conversation-history threshold: long conversations are contextual;
 *      only short exchanges (default <= 2 messages) are cacheable.
 *   G3 per-context scoping: default scope = the SEAT. User A's answers are
 *      never served to user B unless the admin widens scope to tenant.
 *   G4 TTL: conservative default 900s; the window is small on purpose.
 *   G5 semantic threshold: >= 0.95 default, HARD floor 0.92 (enforced in
 *      policy load) - and the semantic layer is OPT-IN entirely.
 *   G6 tools: requests carrying tool definitions are never cached (agentic
 *      calls are contextual by construction).
 *   G7 numeric consistency: a semantic hit is REJECTED if the probe and the
 *      stored query disagree on any number ("invoice #10234" vs "#10235"
 *      embeds nearly identical - deterministic guard, not similarity).
 *   G8 code-token consistency: same for short ALL-CAPS tokens (USD vs GBP,
 *      AAPL vs MSFT, SKU codes) - embeddings barely separate them.
 *
 * Embeddings (semantic layer) run on the CUSTOMER's key (D4) via a pluggable
 * EmbedderPort; without a configured embedder the semantic layer is silently
 * unavailable and exact-only serves.
 */
import { createHash } from "node:crypto";
import type { TenantContext } from "../../db/tenancy.js";
import type { TenantPolicy } from "../policy.js";
import { canonicalJson } from "./toolcache.js";

export type EmbedderPort = (text: string) => Promise<number[]>; // 1536-dim

const TIME_SENSITIVE =
  /\b(now|today|tonight|yesterday|tomorrow|latest|current(ly)?|breaking|news|weather|stock|price of|exchange rate|score|schedule|this (week|month|year|morning))\b/i;

interface Msg {
  role: string;
  content: unknown;
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content))
      return m.content
        .map((c: { text?: string }) => c?.text ?? "")
        .join(" ");
  }
  return "";
}

export interface GateResult {
  cacheable: boolean;
  reason: string | null;
}

/** The gates. Run before ANY lookup or store; both layers obey them. */
export function responseCacheGates(
  policy: TenantPolicy,
  body: Record<string, unknown>,
): GateResult {
  const r = policy.recycle.response;
  if (!r.exact_enabled && !r.semantic_enabled)
    return { cacheable: false, reason: "response cache disabled" };
  const messages = (body.messages as Msg[]) ?? [];
  if (Array.isArray(body.tools) && (body.tools as unknown[]).length > 0)
    return { cacheable: false, reason: "G6: tool-using request" };
  if (messages.length > r.max_history_messages)
    return {
      cacheable: false,
      reason: `G2: conversation history ${messages.length} > ${r.max_history_messages}`,
    };
  const q = lastUserText(messages);
  if (!q.trim()) return { cacheable: false, reason: "no user text" };
  if (TIME_SENSITIVE.test(q))
    return { cacheable: false, reason: "G1: time-sensitive query" };
  return { cacheable: true, reason: null };
}

export function scopeKey(policy: TenantPolicy, seatId: string): string {
  return policy.recycle.response.scope === "tenant" ? "tenant" : seatId;
}

/** G7+G8: deterministic token guards a similarity score cannot be trusted with. */
export function tokenGuardsPass(probe: string, stored: string): boolean {
  const numbers = (s: string) =>
    (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join(",");
  if (numbers(probe) !== numbers(stored)) return false; // G7
  const codes = (s: string) =>
    (s.match(/\b[A-Z]{2,5}\b/g) ?? []).sort().join(",");
  if (codes(probe) !== codes(stored)) return false; // G8
  return true;
}

export function exactKey(
  scope: string,
  body: Record<string, unknown>,
): string {
  // model + full canonical request (messages, system, max_tokens all included)
  return createHash("sha256")
    .update(`${scope} ${canonicalJson(body)}`)
    .digest("hex");
}

export interface ResponseCacheHit {
  layer: "exact" | "semantic";
  response: unknown;
  usage: { input_tokens: number; output_tokens: number };
  similarity: number; // 1 for exact
  key: string;
}

export async function responseCacheLookup(
  ctx: TenantContext,
  policy: TenantPolicy,
  seatId: string,
  body: Record<string, unknown>,
  embedder: EmbedderPort | null,
): Promise<ResponseCacheHit | null> {
  const gates = responseCacheGates(policy, body);
  if (!gates.cacheable) return null;
  const r = policy.recycle.response;
  const scope = scopeKey(policy, seatId);

  // layer 1: exact
  if (r.exact_enabled) {
    const key = exactKey(scope, body);
    const row = await ctx.db.query<{
      response: unknown;
      usage: { input_tokens: number; output_tokens: number };
    }>(
      `SELECT response, usage FROM response_cache WHERE key = $1 AND expires_at > now()`,
      [key],
    );
    if (row.rows.length > 0)
      return {
        layer: "exact",
        response: row.rows[0].response,
        usage: row.rows[0].usage,
        similarity: 1,
        key,
      };
  }

  // layer 2: semantic (opt-in + embedder available + same scope + same model)
  if (r.semantic_enabled && embedder) {
    const q = lastUserText((body.messages as Msg[]) ?? []);
    const vec = await embedder(q);
    const row = await ctx.db.query<{
      key: string;
      response: unknown;
      usage: { input_tokens: number; output_tokens: number };
      query_text: string;
      sim: number;
    }>(
      `SELECT key, response, usage, query_text, 1 - (embedding <=> $1::vector) AS sim
         FROM response_cache
        WHERE scope = $2 AND model = $3 AND embedding IS NOT NULL AND expires_at > now()
        ORDER BY embedding <=> $1::vector ASC LIMIT 1`,
      [`[${vec.join(",")}]`, scope, String(body.model ?? "")],
    );
    const best = row.rows[0];
    if (
      best &&
      best.sim >= r.semantic_threshold &&
      tokenGuardsPass(q, best.query_text) // G7+G8: similarity alone is never enough
    )
      return {
        layer: "semantic",
        response: best.response,
        usage: best.usage,
        similarity: best.sim,
        key: best.key,
      };
  }
  return null;
}

export async function responseCacheStore(
  ctx: TenantContext,
  policy: TenantPolicy,
  seatId: string,
  body: Record<string, unknown>,
  response: unknown,
  usage: { input_tokens: number; output_tokens: number },
  embedder: EmbedderPort | null,
): Promise<void> {
  const gates = responseCacheGates(policy, body);
  if (!gates.cacheable) return; // never store what could never be served
  const r = policy.recycle.response;
  const scope = scopeKey(policy, seatId);
  const key = exactKey(scope, body);
  let embedding: string | null = null;
  if (r.semantic_enabled && embedder) {
    const q = lastUserText((body.messages as Msg[]) ?? []);
    embedding = `[${(await embedder(q)).join(",")}]`;
  }
  const expires = new Date(Date.now() + r.ttl_seconds * 1000).toISOString();
  await ctx.db.query(
    `INSERT INTO response_cache (key, scope, model, query_text, embedding, response, usage, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (key) DO UPDATE SET response = $6, usage = $7, expires_at = $8`,
    [
      key,
      scope,
      String(body.model ?? ""),
      lastUserText((body.messages as Msg[]) ?? []),
      embedding,
      JSON.stringify(response),
      JSON.stringify(usage),
      expires,
    ],
  );
}
