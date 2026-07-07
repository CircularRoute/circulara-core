/**
 * WS1 plugin tests: config surface, event construction against the SHARED
 * schema, backend client wire format, hook payload extraction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { interventionEventSchema } from "@circulara/schema";
import { loadPluginConfig } from "../src/config.js";
import { BackendClient, buildObserveEvent } from "../src/client.js";
import { callFromHookPayload } from "../src/hook.js";

const ENV = {
  CIRCULARA_BACKEND_URL: "http://127.0.0.1:9999/",
  CIRCULARA_TENANT_ID: randomUUID(),
  CIRCULARA_TOKEN: "tok",
  CIRCULARA_SEAT_ID: randomUUID(),
  CIRCULARA_USER_ID: "sso|dev",
};

test("config: required vars enforced, defaults applied", () => {
  const cfg = loadPluginConfig(ENV);
  assert.equal(cfg.backendUrl, "http://127.0.0.1:9999"); // trailing slash stripped
  assert.equal(cfg.identityType, "human");
  assert.equal(cfg.host, "claude_code");
  assert.throws(() => loadPluginConfig({ ...ENV, CIRCULARA_TENANT_ID: "" }), /CIRCULARA_TENANT_ID/);
});

test("buildObserveEvent validates against the shared schema", () => {
  const cfg = loadPluginConfig(ENV);
  const ev = buildObserveEvent(cfg, {
    model: "anthropic/claude-haiku-4-5",
    inputTokens: 1200,
    outputTokens: 80,
    capturePath: "tool",
  });
  // parses clean under the SAME schema the backend enforces at intake
  const parsed = interventionEventSchema.parse(ev);
  assert.equal(parsed.intervention_type, "observe");
  assert.equal(parsed.cost.avoided_usd, 0);
  assert.equal(parsed.seat_id, ENV.CIRCULARA_SEAT_ID);
  assert.ok(parsed.call_id); // M1 correlation always present
});

test("client posts to /v1/events with tenant + bearer headers", async () => {
  const cfg = loadPluginConfig(ENV);
  const seen: { url?: string; init?: RequestInit } = {};
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response("{}", { status: 201 });
  }) as typeof fetch;
  const client = new BackendClient(cfg, fakeFetch);
  const ev = buildObserveEvent(cfg, { inputTokens: 1, outputTokens: 1, capturePath: "hook" });
  const res = await client.postEvent(ev);
  assert.ok(res.ok);
  assert.equal(seen.url, "http://127.0.0.1:9999/v1/events");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["x-tenant-id"], ENV.CIRCULARA_TENANT_ID);
  assert.equal(headers["authorization"], "Bearer tok");
  assert.equal(interventionEventSchema.parse(JSON.parse(String(seen.init?.body))).event_id, ev.event_id);
});

test("hook: extracts usage when present, skips when absent", () => {
  const hit = callFromHookPayload({
    session_id: "s1",
    tool_name: "SomeModelCall",
    tool_response: { usage: { input_tokens: 500, output_tokens: 42 }, model: "claude-haiku-4-5" },
  });
  assert.ok(hit);
  assert.equal(hit!.inputTokens, 500);
  assert.equal(hit!.capturePath, "hook");

  assert.equal(callFromHookPayload({ tool_name: "Read" }), null);
  assert.equal(
    callFromHookPayload({ tool_response: { usage: { input_tokens: 0, output_tokens: 0 } } }),
    null,
  );
});
