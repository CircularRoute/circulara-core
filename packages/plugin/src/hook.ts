/**
 * WS1 - Claude Code hook (AD3 path A capture).
 *
 * Wire as a PostToolUse hook in .claude/settings.json:
 *   { "hooks": { "PostToolUse": [ { "matcher": "*",
 *     "hooks": [{ "type": "command",
 *       "command": "npx tsx <repo>/packages/plugin/src/hook.ts" }] } ] } }
 *
 * Claude Code pipes the hook payload as JSON on stdin. Sprint-2 scope:
 * OBSERVE only - extract token usage when present and emit a meter event.
 * (Blocking/rewriting = PreToolUse enforcement, wave 3 Cost-Controller.)
 * The hook never fails the tool call: metering must not break the host.
 */
import { pathToFileURL } from "node:url";
import { loadPluginConfig } from "./config.js";
import { BackendClient, buildObserveEvent } from "./client.js";

export interface HookPayload {
  session_id?: string;
  tool_name?: string;
  tool_response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
    model?: string;
  };
}

/** Extract an observable call from a hook payload; null if nothing to meter. */
export function callFromHookPayload(payload: HookPayload) {
  const usage = payload.tool_response?.usage;
  if (!usage || (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) === 0)
    return null;
  return {
    sessionId: payload.session_id ?? null,
    model: payload.tool_response?.model ?? null,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    capturePath: "hook" as const,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// entrypoint: only when executed directly (never on test/library import)
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const payload = JSON.parse(await readStdin()) as HookPayload & {
      tool_input?: unknown;
    };
    const cfg = loadPluginConfig();
    const call = callFromHookPayload(payload);
    if (call) {
      await new BackendClient(cfg).postEvent(buildObserveEvent(cfg, call));
    }
    // wave 4: offer the result to the tool-call cache (server-side allowlist
    // decides whether to store; misses are free and silent)
    if (payload.tool_name && payload.tool_response !== undefined) {
      await fetch(`${cfg.backendUrl}/v1/toolcache/store`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.token}`,
          "x-tenant-id": cfg.tenantId,
        },
        body: JSON.stringify({
          tool: payload.tool_name,
          args: payload.tool_input ?? {},
          result: payload.tool_response,
        }),
      });
    }
  } catch {
    // never break the host tool call over metering
  }
  process.exit(0);
}
