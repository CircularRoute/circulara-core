#!/usr/bin/env npx tsx
/**
 * Wave 4 - Claude Code PreToolUse hook: the Cost-Controller + tool-call cache
 * client wiring (closes wave-3 flag 3 - the controller now actually blocks).
 *
 * Wire in .claude/settings.json:
 *   { "hooks": { "PreToolUse": [ { "matcher": "*",
 *     "hooks": [{ "type": "command",
 *       "command": "npx tsx <repo>/packages/plugin/src/hook-pre.ts" }] } ] } }
 *
 * Behavior, fail-open by design (metering must never break the host):
 *  1. Tool-call cache: if the tool is on the tenant allowlist and a fresh
 *     cached result exists, DENY the call and inject the cached result as
 *     context - the model uses the cache instead of re-running the tool.
 *  2. Cost-Controller: ask /v1/controller/check; on "block", DENY with the
 *     hierarchy-ladder reason. On "flag", allow but surface the warning.
 *  3. Any error or timeout -> allow (exit 0, no output).
 */
import { pathToFileURL } from "node:url";
import { loadPluginConfig } from "./config.js";

interface PreHookPayload {
  tool_name?: string;
  tool_input?: unknown;
}

export interface PreHookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export async function decide(
  payload: PreHookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<PreHookDecision | null> {
  const cfg = loadPluginConfig();
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.token}`,
    "x-tenant-id": cfg.tenantId,
  };
  const tool = payload.tool_name ?? "";
  if (!tool) return null;

  // 1. tool-call cache
  const cacheRes = await fetchImpl(`${cfg.backendUrl}/v1/toolcache/lookup`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tool, args: payload.tool_input ?? {}, seat_id: cfg.seatId }),
  });
  if (cacheRes.ok) {
    const cache = (await cacheRes.json()) as { hit?: boolean; result?: unknown };
    if (cache.hit) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Circulara Recycle: a fresh cached result for this exact tool call exists - use the cached result below instead of re-running the tool.",
          additionalContext: `Cached result for ${tool} (deterministic, within its freshness window):\n${JSON.stringify(cache.result)}`,
        },
      };
    }
  }

  // 2. cost-controller
  const chkRes = await fetchImpl(`${cfg.backendUrl}/v1/controller/check`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: `tool:${tool}`,
      input_chars: JSON.stringify(payload.tool_input ?? {}).length,
      max_output_tokens: 0,
      seat_id: cfg.seatId,
    }),
  });
  if (chkRes.ok) {
    const verdict = (await chkRes.json()) as {
      action: "allow" | "flag" | "block";
      reason: string | null;
      ladder: { rung: string; note: string }[];
    };
    if (verdict.action === "block") {
      const ladder = verdict.ladder.map((l) => `[${l.rung}] ${l.note}`).join(" ");
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `Blocked by Circulara Cost-Controller: ${verdict.reason}. ${ladder}`,
        },
      };
    }
    if (verdict.action === "flag") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: `Circulara Cost-Controller warning: ${verdict.reason}`,
        },
      };
    }
  }
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const payload = JSON.parse(await readStdin()) as PreHookPayload;
    const decision = await decide(payload);
    if (decision) console.log(JSON.stringify(decision));
  } catch {
    // fail-open: never break the host over metering/caching
  }
  process.exit(0);
}
