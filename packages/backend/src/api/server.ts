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
import { ingestEvent, meterSummary } from "../meter/meter.js";
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

  // ---- meter ----
  app.post("/v1/events", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const res = await ingestEvent(ctx, req.body);
    return reply.status(201).send(res);
  });

  app.get("/v1/meter/summary", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    return meterSummary(ctx);
  });

  // ---- WS2: gateway metering mode (AD3 path B). Auth = per-seat credential,
  // NOT bearer: the host sends the credential as its x-api-key. ----
  app.post("/gateway/anthropic/v1/messages", async (req, reply) => {
    const ctx = await tenantCtx(req);
    const credential =
      (req.headers["x-api-key"] as string | undefined) ??
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined);
    const res = await handleGatewayMessage(
      ctx,
      deps.gateway,
      credential,
      req.body as Record<string, unknown>,
      req.headers as Record<string, string>,
    );
    return reply.status(res.status).send(res.json);
  });

  return app;
}
