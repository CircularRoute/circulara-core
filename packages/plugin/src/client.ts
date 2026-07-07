/**
 * WS1 - backend client + event construction against the SHARED schema
 * (@circulara/schema is the single source of truth; the event is validated
 * plugin-side BEFORE it leaves, so a drifting plugin fails loudly, not
 * silently at intake).
 */
import { randomUUID } from "node:crypto";
import {
  interventionEventSchema,
  type InterventionEvent,
} from "@circulara/schema";
import type { PluginConfig } from "./config.js";

export interface ObservedCall {
  callId?: string;
  sessionId?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  /** priced cost if the caller knows it; the meter re-prices server-side in WS4 */
  costUsd?: number;
  capturePath: "hook" | "tool";
}

export function buildObserveEvent(
  cfg: PluginConfig,
  call: ObservedCall,
): InterventionEvent {
  const usd = call.costUsd ?? 0;
  return interventionEventSchema.parse({
    event_id: randomUUID(),
    call_id: call.callId ?? randomUUID(),
    schema_version: "1.0",
    ts: new Date().toISOString(),
    seat_id: cfg.seatId,
    identity_type: cfg.identityType,
    user_id: cfg.userId,
    team_id: cfg.teamId,
    agent_identity: cfg.agentIdentity,
    host: cfg.host,
    capture_path: call.capturePath,
    session_id: call.sessionId ?? null,
    module: "meter",
    intervention_type: "observe",
    model_requested: call.model ?? null,
    model_used: call.model ?? null,
    tokens: {
      input_counterfactual: call.inputTokens,
      output_counterfactual: call.outputTokens,
      input_actual: call.inputTokens,
      output_actual: call.outputTokens,
    },
    cost: {
      counterfactual_usd: usd,
      actual_usd: usd,
      avoided_usd: 0,
      currency: "USD",
      pricing_source: "provider_registry",
      pricing_version: "plugin-unpriced", // server-side pricing lands in WS4
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

export class BackendClient {
  constructor(
    private cfg: PluginConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.cfg.token}`,
      "x-tenant-id": this.cfg.tenantId,
    };
  }

  async postEvent(ev: InterventionEvent): Promise<{ ok: boolean; status: number }> {
    const res = await this.fetchImpl(`${this.cfg.backendUrl}/v1/events`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(ev),
    });
    return { ok: res.status === 201, status: res.status };
  }

  async meterSummary(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.cfg.backendUrl}/v1/meter/summary`, {
      headers: this.headers(),
    });
    return res.json();
  }
}
