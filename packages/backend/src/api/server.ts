/**
 * API service (WS0 skeleton + WS2 auth/keys/gateway).
 * Every tenant-scoped route resolves a TenantContext from the x-tenant-id
 * header via the control plane; that is the only door.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ControlPlane } from "../db/tenancy.js";
import {
  Authenticator,
  provisionSeat,
  issueGatewayCredential,
  type SeatInput,
  type Role,
} from "../auth/auth.js";
import { meterSummary, ingestEvent } from "../meter/meter.js";
import { meterReport } from "../meter/report.js";
import { savingsPotential } from "../meter/potential.js";
import {
  renderDashboard,
  renderPotential,
  renderStatement,
} from "../dashboard/render.js";
import { normalizeAndAppend } from "../pipeline/normalize.js";
import { interventionEventSchema } from "@circulara/schema";
import { setProviderKey, listProviders, type Provider } from "../keys/providerKeys.js";
import { getPolicy, setPolicy, DEFAULT_POLICY, type TenantPolicy } from "../engines/policy.js";
import { controllerCheck, estTokens } from "../engines/controller.js";
import { toolCacheLookup, toolCacheStore } from "../engines/recycle/toolcache.js";
import { randomUUID } from "node:crypto";
import { handleGatewayMessage, type GatewayDeps } from "../gateway/gateway.js";
import type { ObjectStore } from "../storage/objectStore.js";

export interface AppDeps {
  control: ControlPlane;
  objects: ObjectStore;
  auth: Authenticator;
  gateway: GatewayDeps;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const auth = async (req: FastifyRequest): Promise<Role> => {
    const res = await deps.auth.verify(req.headers.authorization);
    if (!res.ok)
      throw Object.assign(new Error(res.reason ?? "unauthorized"), {
        statusCode: 401,
      });
    return res.role!;
  };

  const tenantCtx = async (req: FastifyRequest) => {
    const tenantId = req.headers["x-tenant-id"];
    if (typeof tenantId !== "string" || !tenantId)
      throw Object.assign(new Error("x-tenant-id header required"), {
        statusCode: 400,
      });
    try {
      return await deps.control.contextFor(tenantId);
    } catch {
      throw Object.assign(new Error("unknown tenant"), { statusCode: 404 });
    }
  };

  const adminOnly = async (req: FastifyRequest): Promise<void> => {
    if ((await auth(req)) !== "admin")
      throw Object.assign(new Error("admin only"), { statusCode: 403 });
  };

  app.setErrorHandler((err, _req, reply) => {
    // duck-type alongside instanceof: survives duplicate zod instances
    const zodLike = err as { name?: string; issues?: unknown[] };
    if (err instanceof ZodError || (zodLike.name === "ZodError" && Array.isArray(zodLike.issues)))
      return reply
        .status(422)
        .send({ error: "invalid event", issues: zodLike.issues });
    const e = err as { statusCode?: number; message?: string };
    return reply
      .status(e.statusCode ?? 500)
      .send({ error: e.message ?? "internal error" });
  });

  app.get("/healthz", async () => ({ ok: true, service: "circulara-core" }));

  // ---- control plane (admin) ----
  app.post("/v1/tenants", async (req, reply) => {
    await adminOnly(req);
    const body = req.body as { name?: string };
    if (!body?.name) return reply.status(400).send({ error: "name required" });
    const t = await deps.control.createTenant(body.name);
    return reply.status(201).send({ tenant_id: t.tenant_id, name: t.name });
  });

  // ---- seats (AD6) ----
  app.post("/v1/seats", async (req, reply) => {
    const role = await auth(req);
    const ctx = await tenantCtx(req);
    const seat = await provisionSeat(ctx, req.body as SeatInput, role);
    return reply.status(201).send(seat);
  });

  // WS2: short-lived named-agent seat token (admin mints, AD6)
  app.post("/v1/seats/:seatId/token", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const seatId = (req.params as { seatId: string }).seatId;
    const seat = await ctx.db.query<{ identity_type: string }>(
      `SELECT identity_type FROM seats WHERE seat_id = $1 AND active`,
      [seatId],
    );
    if (seat.rows.length === 0)
      return reply.status(404).send({ error: "unknown seat" });
    if (seat.rows[0].identity_type !== "named_agent")
      return reply
        .status(400)
        .send({ error: "tokens are minted for named_agent seats only (humans use SSO)" });
    const token = await deps.auth.mintAgentToken(ctx.tenantId, seatId);
    return reply.status(201).send({ token, expires_in: 3600 });
  });

  // WS2/M2: per-seat gateway credential (admin issues; hash-stored, shown once)
  app.post("/v1/seats/:seatId/gateway-credential", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const seatId = (req.params as { seatId: string }).seatId;
    const seat = await ctx.db.query(
      `SELECT 1 FROM seats WHERE seat_id = $1 AND active`,
      [seatId],
    );
    if (seat.rows.length === 0)
      return reply.status(404).send({ error: "unknown seat" });
    const cred = await issueGatewayCredential(ctx, seatId);
    return reply.status(201).send(cred);
  });

  // ---- WS2: BYO provider keys (admin sets; write-only, never read back) ----
  app.put("/v1/provider-keys/:provider", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const provider = (req.params as { provider: string }).provider as Provider;
    if (!["anthropic", "openai", "gemini"].includes(provider))
      return reply.status(400).send({ error: "unsupported provider" });
    const body = req.body as { key?: string };
    if (!body?.key) return reply.status(400).send({ error: "key required" });
    await setProviderKey(ctx, deps.gateway.kek, provider, body.key);
    return reply.status(204).send();
  });

  app.get("/v1/provider-keys", async (req) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    return { configured: await listProviders(ctx) }; // names only, never values
  });

  // ---- wave 3: policy (admin) + controller check (any seat / hook path) ----
  app.get("/v1/policy", async (req) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    return getPolicy(ctx);
  });

  app.put("/v1/policy", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const body = req.body as Partial<TenantPolicy>;
    const merged: TenantPolicy = {
      ...DEFAULT_POLICY,
      ...body,
      reduce: { ...DEFAULT_POLICY.reduce, ...(body.reduce ?? {}) },
    };
    await setPolicy(ctx, merged);
    return reply.status(204).send();
  });

  // Hook-path Cost-Controller: the Claude Code PreToolUse hook asks before a
  // call runs; verdict includes the hierarchy-aware ladder message (§4.3).
  app.post("/v1/controller/check", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as {
      model?: string;
      input_chars?: number;
      max_output_tokens?: number;
      seat_id?: string;
    };
    if (!b?.model || !b?.seat_id)
      throw Object.assign(new Error("model and seat_id required"), { statusCode: 400 });
    const policy = await getPolicy(ctx);
    return controllerCheck(ctx, policy, deps.gateway.getPricing(), {
      model: b.model,
      inputChars: b.input_chars ?? 0,
      maxOutputTokens: b.max_output_tokens ?? 4096,
      seatId: b.seat_id,
    });
  });

  // ---- wave 4: deterministic tool-call cache (hook + tool path) ----
  // Lookup books the hit event server-side (est_cost_usd from the allowlist
  // entry; unset books $0 - hits are counted honestly, dollars never invented).
  app.post("/v1/toolcache/lookup", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { tool?: string; args?: unknown; seat_id?: string };
    if (!b?.tool || !b?.seat_id)
      throw Object.assign(new Error("tool and seat_id required"), { statusCode: 400 });
    const policy = await getPolicy(ctx);
    const res = await toolCacheLookup(ctx, policy, b.tool, b.args ?? {});
    if (res.hit) {
      const seat = await ctx.db.query<{
        identity_type: "human" | "named_agent";
        user_id: string;
        team_id: string | null;
        agent_identity: string | null;
      }>(
        `SELECT identity_type, user_id, team_id, agent_identity FROM seats WHERE seat_id = $1 AND active`,
        [b.seat_id],
      );
      if (seat.rows.length > 0) {
        const s = seat.rows[0];
        const resultTokens = estTokens(JSON.stringify(res.result).length);
        const pricing = deps.gateway.getPricing();
        await ingestEvent(ctx, {
          event_id: randomUUID(),
          call_id: randomUUID(),
          schema_version: "1.0",
          ts: new Date().toISOString(),
          seat_id: b.seat_id,
          identity_type: s.identity_type,
          user_id: s.user_id,
          team_id: s.team_id,
          agent_identity: s.agent_identity,
          host: "claude_code",
          capture_path: "hook",
          session_id: null,
          module: "recycle",
          intervention_type: "toolcall_cache",
          model_requested: null,
          model_used: null,
          tokens: {
            input_counterfactual: 0,
            output_counterfactual: resultTokens,
            input_actual: 0,
            output_actual: 0,
          },
          cost: {
            counterfactual_usd: res.est_cost_usd,
            actual_usd: 0,
            avoided_usd: res.est_cost_usd,
            currency: "USD",
            pricing_source: "meter",
            pricing_version: pricing?.pricing_version ?? "unpriced",
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
          asset_ref: null,
          cache_ref: { cache_key: res.key, layer: "exact", similarity: 1 },
          sourcing: null,
          catalog_reserved: null,
        });
      }
    }
    return res;
  });

  app.post("/v1/toolcache/store", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { tool?: string; args?: unknown; result?: unknown };
    if (!b?.tool)
      throw Object.assign(new Error("tool required"), { statusCode: 400 });
    const policy = await getPolicy(ctx);
    const res = await toolCacheStore(ctx, policy, b.tool, b.args ?? {}, b.result ?? null);
    return reply.status(res.stored ? 201 : 200).send(res);
  });

  // ---- meter (WS3 pipeline: validate -> normalize/re-price -> append) ----
  app.post("/v1/events", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const ev = interventionEventSchema.parse(req.body);
    const res = await normalizeAndAppend(ctx, { getPricing: deps.gateway.getPricing }, ev);
    return reply.status(201).send(res);
  });

  app.get("/v1/meter/summary", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    return meterSummary(ctx);
  });

  // WS4: attribution report (per user/team/module/month; energy+CO2e ranges)
  app.get("/v1/meter/report", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const month = (req.query as { month?: string }).month;
    if (month && !/^\d{4}-\d{2}$/.test(month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    return meterReport(ctx, month);
  });

  // ---- WS5: Observe dashboard (server-rendered, Ledger Light) ----
  // Auth: bearer header OR ?token= (dev convenience; a browser session flow
  // replaces the query token before public launch - flagged in launch prep).
  const dashAuth = async (req: FastifyRequest) => {
    const q = req.query as { token?: string; tenant?: string; month?: string };
    const authz = req.headers.authorization ?? (q.token ? `Bearer ${q.token}` : undefined);
    const res = await deps.auth.verify(authz);
    if (!res.ok)
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    const tenantId = q.tenant ?? (req.headers["x-tenant-id"] as string | undefined);
    if (!tenantId)
      throw Object.assign(new Error("tenant required (?tenant=)"), { statusCode: 400 });
    try {
      return { ctx: await deps.control.contextFor(tenantId), q, tenantId };
    } catch {
      throw Object.assign(new Error("unknown tenant"), { statusCode: 404 });
    }
  };
  const tenantQ = (tenantId: string, q: { token?: string }, month?: string) =>
    `?tenant=${tenantId}${q.token ? `&token=${q.token}` : ""}${month ? `&month=${month}` : ""}`;

  app.get("/dashboard", async (req, reply) => {
    const { ctx, q, tenantId } = await dashAuth(req);
    const r = await meterReport(ctx, q.month);
    return reply.type("text/html").send(renderDashboard(r, tenantQ(tenantId, q, q.month)));
  });

  app.get("/dashboard/potential", async (req, reply) => {
    const { ctx, q, tenantId } = await dashAuth(req);
    const r = await meterReport(ctx, q.month);
    const p = savingsPotential(r.observed_usd);
    return reply
      .type("text/html")
      .send(renderPotential(r, p, tenantQ(tenantId, q, q.month)));
  });

  app.get("/dashboard/statement", async (req, reply) => {
    const { ctx, q, tenantId } = await dashAuth(req);
    // default: current month
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    const r = await meterReport(ctx, month);
    const p = savingsPotential(r.observed_usd);
    return reply
      .type("text/html")
      .send(renderStatement(r, p, tenantQ(tenantId, q, month), month));
  });

  // ---- gateway metering mode (AD3 path B). Auth = per-seat credential. ----
  const credentialFrom = (req: FastifyRequest) =>
    (req.headers["x-api-key"] as string | undefined) ??
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);

  app.post("/gateway/anthropic/v1/messages", async (req, reply) => {
    const ctx = await tenantCtx(req);
    const res = await handleGatewayMessage(
      ctx,
      deps.gateway,
      "anthropic",
      credentialFrom(req),
      req.body as Record<string, unknown>,
      req.headers as Record<string, string>,
    );
    return reply.status(res.status).send(res.json);
  });

  // WS3: OpenAI-format endpoint for Cursor-class hosts (same pipeline)
  app.post("/gateway/openai/v1/chat/completions", async (req, reply) => {
    const ctx = await tenantCtx(req);
    const res = await handleGatewayMessage(
      ctx,
      deps.gateway,
      "openai",
      credentialFrom(req),
      req.body as Record<string, unknown>,
      req.headers as Record<string, string>,
    );
    return reply.status(res.status).send(res.json);
  });

  return app;
}
