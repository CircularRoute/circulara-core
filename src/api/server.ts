/**
 * API service skeleton (WS0). Fastify app factory - tests use app.inject(),
 * dev runs listen(). Every tenant-scoped route resolves a TenantContext from
 * the x-tenant-id header via the control plane; that is the only door.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { ControlPlane } from "../db/tenancy.js";
import { verifyRequest, provisionSeat, type SeatInput } from "../auth/auth.js";
import { ingestEvent, meterSummary } from "../meter/meter.js";
import type { ObjectStore } from "../storage/objectStore.js";

export interface AppDeps {
  control: ControlPlane;
  objects: ObjectStore;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const auth = (req: FastifyRequest) => {
    const res = verifyRequest(req.headers.authorization);
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

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError)
      return reply
        .status(422)
        .send({ error: "invalid event", issues: err.issues });
    const e = err as { statusCode?: number; message?: string };
    return reply
      .status(e.statusCode ?? 500)
      .send({ error: e.message ?? "internal error" });
  });

  app.get("/healthz", async () => ({ ok: true, service: "circulara-core" }));

  // control plane (admin)
  app.post("/v1/tenants", async (req, reply) => {
    const role = auth(req);
    if (role !== "admin")
      return reply.status(403).send({ error: "admin only" });
    const body = req.body as { name?: string };
    if (!body?.name)
      return reply.status(400).send({ error: "name required" });
    const t = await deps.control.createTenant(body.name);
    return reply.status(201).send({ tenant_id: t.tenant_id, name: t.name });
  });

  // seats (AD6)
  app.post("/v1/seats", async (req, reply) => {
    const role = auth(req);
    const ctx = await tenantCtx(req);
    const seat = await provisionSeat(ctx, req.body as SeatInput, role);
    return reply.status(201).send(seat);
  });

  // meter intake + summary
  app.post("/v1/events", async (req, reply) => {
    auth(req);
    const ctx = await tenantCtx(req);
    const res = await ingestEvent(ctx, req.body);
    return reply.status(201).send(res);
  });

  app.get("/v1/meter/summary", async (req) => {
    auth(req);
    const ctx = await tenantCtx(req);
    return meterSummary(ctx);
  });

  return app;
}
