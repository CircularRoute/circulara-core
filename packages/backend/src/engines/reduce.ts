/**
 * Wave 3 - Reduce engine (Tier 2). Deterministic passes, TS in-process (AD13);
 * the ML compression sidecar (LLMLingua-2) plugs in behind WorkerPort when the
 * deploy target exists - the pipeline shape does not change.
 *
 * Passes transform an OUTBOUND request (gateway path) before forwarding.
 * Savings are booked AFTER the response, from real usage where measurable:
 *  - routing: actual tokens priced at requested vs routed model (measured)
 *  - prompt_cache: provider-reported cache_read tokens x discount (measured)
 *  - context pruning / compression: token delta from removed chars (estimated)
 *  - output caps: only when the response actually hit the cap (conservative)
 *  - tool pruning: token delta of removed tool definitions (estimated)
 *
 * Conservative by construction: quality-affecting passes (routing, tool
 * pruning) are OPT-IN in policy; deterministic text passes never remove
 * content, only redundancy (repeated blocks, whitespace runs).
 */
import type { TenantPolicy } from "./policy.js";
import type { PricingSnapshot } from "../registry/pricing.js";
import { priceTokens } from "../meter/compute.js";
import { estTokens } from "./controller.js";

export interface AppliedPass {
  technique:
    | "route"
    | "compress"
    | "cap"
    | "tool_prune"
    | "prompt_cache";
  detail: string;
  /** chars removed from the request (estimated passes); 0 for measured ones */
  charsSaved: number;
  /** for routing: the model the request WOULD have used */
  originalModel?: string;
  /** for caps: the max_tokens the request asked for before clamping */
  originalMaxTokens?: number;
}

export interface ReduceResult {
  body: Record<string, unknown>;
  applied: AppliedPass[];
}

// ---------- deterministic text passes ----------

/** Collapse 3+ blank lines to 1, strip trailing spaces. Never touches content. */
export function compactWhitespace(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Dedupe repeated paragraph blocks (>= 200 chars) - the classic "same file
 * pasted twice" agent failure. Later occurrences are replaced by a short
 * reference marker. Fenced code blocks are treated as atomic (never altered
 * internally, only deduped whole).
 */
export function dedupeBlocks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g); // keep fences atomic
  const seen = new Map<string, number>();
  let refN = 0;
  const out = parts.map((part) => {
    if (part.startsWith("```")) {
      const key = part.trim();
      if (key.length >= 200 && seen.has(key)) {
        refN++;
        return `[duplicate of code block #${seen.get(key)} removed by Circulara Reduce]`;
      }
      if (key.length >= 200) seen.set(key, seen.size + 1);
      return part;
    }
    // paragraph-level dedupe for prose
    return part
      .split(/\n\n+/)
      .map((para) => {
        const key = para.trim();
        if (key.length >= 200) {
          if (seen.has(key)) {
            refN++;
            return `[duplicate paragraph removed by Circulara Reduce]`;
          }
          seen.set(key, seen.size + 1);
        }
        return para;
      })
      .join("\n\n");
  });
  void refN;
  return out.join("");
}

export function compressText(text: string): string {
  return compactWhitespace(dedupeBlocks(text));
}

// ---------- request-shape helpers (Anthropic + OpenAI formats) ----------

type Msg = { role: string; content: unknown };

function mapTextContent(m: Msg, fn: (t: string) => string): Msg {
  if (typeof m.content === "string") return { ...m, content: fn(m.content) };
  if (Array.isArray(m.content))
    return {
      ...m,
      content: m.content.map((c: { type?: string; text?: string }) =>
        c?.type === "text" && typeof c.text === "string"
          ? { ...c, text: fn(c.text) }
          : c,
      ),
    };
  return m;
}

const textLen = (m: Msg): number =>
  typeof m.content === "string"
    ? m.content.length
    : Array.isArray(m.content)
      ? m.content.reduce(
          (n: number, c: { text?: string }) => n + (c?.text?.length ?? 0),
          0,
        )
      : 0;

// ---------- the pipeline ----------

export function applyReduce(
  policy: TenantPolicy,
  body: Record<string, unknown>,
): ReduceResult {
  const applied: AppliedPass[] = [];
  const out: Record<string, unknown> = { ...body };
  const r = policy.reduce;

  // 1. model routing (opt-in): simple requests -> mapped cheaper model
  const model = typeof out.model === "string" ? out.model : "";
  if (r.routing.enabled && r.routing.map[model]) {
    const msgs = (out.messages as Msg[]) ?? [];
    const totalChars = msgs.reduce((n, m) => n + textLen(m), 0);
    const hasTools = Array.isArray(out.tools) && (out.tools as unknown[]).length > 0;
    if (totalChars <= r.routing.simple_max_chars && !hasTools) {
      applied.push({
        technique: "route",
        detail: `${model} -> ${r.routing.map[model]} (simple request, ${totalChars} chars, no tools)`,
        charsSaved: 0,
        originalModel: model,
      });
      out.model = r.routing.map[model];
    }
  }

  // 2. compression + context pruning (deterministic, safe-on-by-default)
  if ((r.compression || r.context_pruning) && Array.isArray(out.messages)) {
    let saved = 0;
    out.messages = (out.messages as Msg[]).map((m) => {
      const before = textLen(m);
      const compacted = mapTextContent(m, compressText);
      saved += before - textLen(compacted);
      return compacted;
    });
    if (saved > 0)
      applied.push({
        technique: "compress",
        detail: `deterministic compaction removed ~${saved} chars (duplicate blocks + whitespace)`,
        charsSaved: saved,
      });
  }

  // 3. output caps
  const reqMax = typeof out.max_tokens === "number" ? out.max_tokens : null;
  if (r.output_cap_tokens != null && reqMax != null && reqMax > r.output_cap_tokens) {
    applied.push({
      technique: "cap",
      detail: `max_tokens clamped ${reqMax} -> ${r.output_cap_tokens}`,
      charsSaved: 0,
      originalMaxTokens: reqMax,
    });
    out.max_tokens = r.output_cap_tokens;
  }

  // 4. tool pruning (opt-in allowlist)
  if (r.tool_pruning.enabled && r.tool_pruning.allow && Array.isArray(out.tools)) {
    const before = JSON.stringify(out.tools).length;
    const kept = (out.tools as { name?: string; function?: { name?: string } }[]).filter(
      (t) => r.tool_pruning.allow!.includes(t.name ?? t.function?.name ?? ""),
    );
    if (kept.length < (out.tools as unknown[]).length) {
      const after = JSON.stringify(kept).length;
      applied.push({
        technique: "tool_prune",
        detail: `${(out.tools as unknown[]).length - kept.length} tool definitions pruned`,
        charsSaved: before - after,
      });
      out.tools = kept;
    }
  }

  // 5. provider prompt-cache config (Anthropic format only): mark the system
  // block as cacheable when large + stable. No content change.
  if (r.prompt_cache && typeof out.system === "string" && out.system.length >= 4000) {
    out.system = [
      { type: "text", text: out.system, cache_control: { type: "ephemeral" } },
    ];
    applied.push({
      technique: "prompt_cache",
      detail: "cache_control set on system block (provider-native prefix cache)",
      charsSaved: 0,
    });
  }

  return { body: out, applied };
}

// ---------- savings math (post-response, from real usage) ----------

export interface StageSaving {
  technique: AppliedPass["technique"];
  module: "reduce";
  avoided_usd: number;
  detail: string;
}

export function stageSavings(
  pricing: PricingSnapshot | null,
  applied: AppliedPass[],
  finalModel: string,
  usage: {
    input: number;
    output: number;
    cache_read?: number;
    stop_reason?: string;
  },
): StageSaving[] {
  const out: StageSaving[] = [];
  for (const a of applied) {
    let avoided = 0;
    switch (a.technique) {
      case "route": {
        // measured: same tokens priced at the requested vs routed model
        const asRequested = priceTokens(pricing, a.originalModel!, usage.input, usage.output).usd;
        const asRouted = priceTokens(pricing, finalModel, usage.input, usage.output).usd;
        avoided = Math.max(0, asRequested - asRouted);
        break;
      }
      case "compress":
      case "tool_prune": {
        // estimated: chars removed -> input tokens not sent
        avoided = priceTokens(pricing, finalModel, estTokens(a.charsSaved), 0).usd;
        break;
      }
      case "cap": {
        // conservative: only counts if the response actually hit the cap
        if (usage.stop_reason === "max_tokens" && a.originalMaxTokens) {
          const savedOut = a.originalMaxTokens - usage.output;
          if (savedOut > 0)
            avoided = priceTokens(pricing, finalModel, 0, savedOut).usd;
        }
        break;
      }
      case "prompt_cache": {
        // measured: provider-reported cache reads at ~90% input discount
        const read = usage.cache_read ?? 0;
        avoided = priceTokens(pricing, finalModel, read, 0).usd * 0.9;
        break;
      }
    }
    if (avoided > 0)
      out.push({ technique: a.technique, module: "reduce", avoided_usd: avoided, detail: a.detail });
  }
  return out;
}
