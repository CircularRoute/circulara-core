/**
 * WS1 - Circulara MCP server (stdio). AD3 path C: advise/report tools that
 * work in EVERY MCP host (Claude Code, Cursor, any). Enforcement rides path A
 * (Claude Code hooks, see hook.ts) or path B (gateway mode).
 *
 * Install (Claude Code):
 *   claude mcp add circulara -- npx tsx <repo>/packages/plugin/src/server.ts
 * with the CIRCULARA_* env vars set (see config.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadPluginConfig } from "./config.js";
import { BackendClient, buildObserveEvent } from "./client.js";

const cfg = loadPluginConfig();
const client = new BackendClient(cfg);

const server = new McpServer({ name: "circulara", version: "0.1.0" });

server.registerTool(
  "circulara_report",
  {
    description:
      "Report an observed LLM call to the Circulara meter (tokens in/out, model). " +
      "Use after completing model calls so the org's spend baseline is accurate.",
    inputSchema: {
      model: z.string().describe("provider/model id, e.g. anthropic/claude-haiku-4-5"),
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      session_id: z.string().optional(),
    },
  },
  async (args: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    session_id?: string;
  }) => {
    const ev = buildObserveEvent(cfg, {
      model: args.model,
      inputTokens: args.input_tokens,
      outputTokens: args.output_tokens,
      sessionId: args.session_id ?? null,
      capturePath: "tool",
    });
    const res = await client.postEvent(ev);
    return {
      content: [
        {
          type: "text" as const,
          text: res.ok
            ? `recorded (event ${ev.event_id})`
            : `failed to record (status ${res.status})`,
        },
      ],
    };
  },
);

server.registerTool(
  "circulara_status",
  {
    description:
      "Get this org's Circulara meter summary: observed spend, avoided cost, events, per-seat.",
  },
  async () => {
    const summary = await client.meterSummary();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
    };
  },
);

await server.connect(new StdioServerTransport());
