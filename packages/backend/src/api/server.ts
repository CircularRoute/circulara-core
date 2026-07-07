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
import { meterSummary } from "../meter/meter.js";
import { meterReport } from "../meter/report.js";
import { normalizeAndAppend } from "../pipeline/normalize.js";
import { interventionEventSchema } from "@circulara/schema";
import { setProviderKey, listProviders, type Provider } from "../keys/providerKeys.js";
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
