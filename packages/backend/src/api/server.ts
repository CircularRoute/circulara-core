/**
 * API service (WS0 skeleton + WS2 auth/keys/gateway).
 * Every tenant-scoped route resolves a TenantContext from the x-tenant-id
 * header via the control plane; that is the only door.
 */
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
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
  renderObserverMeter,
  renderConnect,
  renderOps,
  type OpsRow,
} from "../dashboard/render.js";
import { normalizeAndAppend } from "../pipeline/normalize.js";
import { interventionEventSchema } from "@circulara/schema";
import { setProviderKey, listProviders, type Provider } from "../keys/providerKeys.js";
import { getPolicy, setPolicy, DEFAULT_POLICY, type TenantPolicy } from "../engines/policy.js";
import { controllerCheck, estTokens } from "../engines/controller.js";
import { toolCacheLookup, toolCacheStore } from "../engines/recycle/toolcache.js";
import { captureAsset } from "../engines/reuse/library.js";
import type { ClassifierPort } from "../engines/clearance/pipeline.js";
import type { TenantContext } from "../db/tenancy.js";
import { acquireAsset, type AcquireRequest, type SeatRef } from "../sourcing/acquire.js";
import type { CommonsStore } from "../sourcing/commons.js";
import type { FederatedIndex } from "../sourcing/catalogs.js";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handleGatewayMessage, type GatewayDeps } from "../gateway/gateway.js";
import type { ObjectStore } from "../storage/objectStore.js";
import {
  registerWebAuth,
  sessionFromRequest,
  type WebAuthDeps,
} from "../auth/webauth.js";

export interface AppDeps {
  control: ControlPlane;
  objects: ObjectStore;
  auth: Authenticator;
  gateway: GatewayDeps;
  commons: CommonsStore;
  index: FederatedIndex;
  /** wave 6: LLM classifier factory (BYO cheap model); null = unclassified-conservative */
  classifierFor?: (ctx: TenantContext) => Promise<ClassifierPort | null>;
  /** builder.20260708.001: consumer dashboard login (email + Google). When set,
   * the dashboard authenticates via a signed session cookie; absent = dev token
   * fallback only (tests / local). */
  web?: WebAuthDeps;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Parse native HTML form posts (application/x-www-form-urlencoded). Fastify only
  // registers JSON + text parsers by default, so the /login email form (a native
  // <form> with no enctype) was rejected with 415 before its handler ran. Kept
  // dependency-free with URLSearchParams, consistent with the hand-rolled cookies.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
    // QA BL1: a credential is BOUND to its tenant. The header selects the
    // tenant DB, but the token must agree. Unbound tokens are dev-mode only;
    // an oidc token without a tenant claim fails CLOSED here.
    const authRes = await deps.auth.verify(req.headers.authorization);
    if (authRes.ok) {
      if (authRes.tenant_id != null && authRes.tenant_id !== tenantId)
        throw Object.assign(
          new Error("credential is bound to a different tenant (BL1 tenant isolation)"),
          { statusCode: 403 },
        );
      if (authRes.tenant_id == null && authRes.kind === "oidc")
        throw Object.assign(
          new Error("oidc token carries no tenant claim - tenant routes fail closed (BL1)"),
          { statusCode: 403 },
        );
    }
    let ctx;
    try {
      ctx = await deps.control.contextFor(tenantId);
    } catch {
      throw Object.assign(new Error("unknown tenant"), { statusCode: 404 });
    }
    // QA MJ8: agent tokens re-check the seat is STILL active, so
    // deprovisioning revokes before TTL expiry.
    if (authRes.ok && authRes.kind === "agent_token" && authRes.subject) {
      const alive = await ctx.db.query(
        `SELECT 1 FROM seats WHERE seat_id = $1 AND active`,
        [authRes.subject],
      );
      if (alive.rows.length === 0)
        throw Object.assign(new Error("agent seat deprovisioned - token revoked (MJ8)"), {
          statusCode: 401,
        });
    }
    return ctx;
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

  // Static brand assets (logos + self-hosted Inter/Plex Mono) so the dashboard
  // matches the marketing site. Served from ./assets (cwd-relative, like data/
  // and registry-data), cached, filename-whitelisted (no path traversal).
  const ASSET_TYPES: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  };
  const assetCache = new Map<string, Buffer>();
  app.get("/assets/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-zA-Z0-9._-]+$/.test(file) || file.includes(".."))
      return reply.status(400).send({ error: "bad asset name" });
    const ext = file.slice(file.lastIndexOf("."));
    const type = ASSET_TYPES[ext];
    if (!type) return reply.status(404).send({ error: "not found" });
    let buf = assetCache.get(file);
    if (!buf) {
      const p = join(process.cwd(), "assets", file);
      if (!existsSync(p)) return reply.status(404).send({ error: "not found" });
      buf = readFileSync(p);
      assetCache.set(file, buf);
    }
    return reply
      .type(type)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(buf);
  });

  // ---- Operator console (Circulara-internal): every signup + its usage. ----
  // Protected by CIRCULARA_OPS_TOKEN (?key= or Bearer). Not the consumer session.
  app.get("/ops", async (req, reply) => {
    const opsToken = process.env.CIRCULARA_OPS_TOKEN;
    if (!opsToken)
      return reply.status(503).send({ error: "operator console not configured (set CIRCULARA_OPS_TOKEN)" });
    const q = req.query as { key?: string; format?: string };
    const provided =
      q.key ??
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
    if (provided !== opsToken) return reply.status(401).send({ error: "unauthorized" });

    const cdb = deps.control.controlDb();
    const ws = await cdb.query<{ tenant_id: string; name: string; plan_mode: string; created_at: string }>(
      `SELECT tenant_id, name, plan_mode, created_at::text FROM tenants ORDER BY created_at DESC`,
    );
    const mem = await cdb.query<{ tenant_id: string; email: string; role: string; created_at: string }>(
      `SELECT tenant_id, email, role, created_at::text FROM workspace_members ORDER BY created_at ASC`,
    );
    const byTenant = new Map<string, { email: string; role: string; created_at: string }[]>();
    for (const m of mem.rows) {
      const a = byTenant.get(m.tenant_id) ?? [];
      a.push({ email: m.email, role: m.role, created_at: m.created_at });
      byTenant.set(m.tenant_id, a);
    }
    const rows: OpsRow[] = [];
    for (const w of ws.rows) {
      let usage = { events: 0, tokens: 0, observed_usd: 0, last: null as string | null };
      try {
        const ctx = await deps.control.contextFor(w.tenant_id);
        const u = await ctx.db.query<{ events: number; tokens: string; usd: string; last: string | null }>(
          `SELECT count(*)::int AS events,
                  coalesce(sum((payload->'tokens'->>'input_actual')::bigint
                             + (payload->'tokens'->>'output_actual')::bigint),0)::text AS tokens,
                  coalesce(sum(actual_usd),0)::text AS usd,
                  max(ts)::text AS last
             FROM meter_events`,
        );
        const r = u.rows[0];
        usage = { events: r.events, tokens: Number(r.tokens), observed_usd: Number(r.usd), last: r.last };
      } catch {
        // workspace not readable (provisioning edge) - show zeros
      }
      rows.push({
        tenant_id: w.tenant_id,
        name: w.name,
        plan_mode: w.plan_mode,
        created_at: w.created_at,
        members: byTenant.get(w.tenant_id) ?? [],
        usage,
      });
    }
    if (q.format === "json" || (req.headers.accept ?? "").includes("application/json"))
      return reply.send({ signups: rows });
    return reply.type("text/html").send(renderOps(rows));
  });

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

  // R3 (QA MJ8 completion): admin deprovisions a seat; agent tokens for it
  // are then revoked at the next request (active recheck at the boundary).
  app.post("/v1/seats/:seatId/deprovision", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const seatId = (req.params as { seatId: string }).seatId;
    const r = await ctx.db.query(
      `UPDATE seats SET active = false WHERE seat_id = $1 AND active`,
      [seatId],
    );
    // also disable this seat's gateway credentials
    await ctx.db.query(
      `UPDATE gateway_credentials SET active = false WHERE seat_id = $1`,
      [seatId],
    );
    if ((r.affectedRows ?? 0) === 0)
      return reply.status(404).send({ error: "unknown or already-inactive seat" });
    return { seat_id: seatId, active: false };
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
    // QA cross-cutting: PATCH semantics - merge over the STORED policy so a
    // sectioned update can never silently reset the sections it omitted.
    const current = await getPolicy(ctx);
    const merged: TenantPolicy = {
      ...current,
      ...body,
      reduce: { ...current.reduce, ...(body.reduce ?? {}) },
      recycle: {
        toolcall: { ...current.recycle.toolcall, ...(body.recycle?.toolcall ?? {}) },
        response: { ...current.recycle.response, ...(body.recycle?.response ?? {}) },
      },
      reuse: { ...current.reuse, ...(body.reuse ?? {}) },
      clearance: { ...current.clearance, ...(body.clearance ?? {}) },
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

  // ---- wave 5: the four-rung acquire loop + library capture + approvals ----
  const seatRefFor = async (
    ctx: Awaited<ReturnType<typeof tenantCtx>>,
    seatId: string,
  ): Promise<SeatRef> => {
    const r = await ctx.db.query<{
      identity_type: "human" | "named_agent";
      user_id: string;
      team_id: string | null;
      agent_identity: string | null;
    }>(
      `SELECT identity_type, user_id, team_id, agent_identity FROM seats WHERE seat_id = $1 AND active`,
      [seatId],
    );
    if (r.rows.length === 0)
      throw Object.assign(new Error("unknown seat"), { statusCode: 422 });
    return { seat_id: seatId, ...r.rows[0] };
  };

  app.post("/v1/acquire", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { seat_id?: string } & AcquireRequest;
    if (!b?.seat_id || !b?.spec || !b?.build_estimate)
      throw Object.assign(new Error("seat_id, spec, build_estimate required"), {
        statusCode: 400,
      });
    const seat = await seatRefFor(ctx, b.seat_id);
    const policy = await getPolicy(ctx);
    return acquireAsset(
      ctx,
      policy,
      {
        objects: deps.objects,
        commons: deps.commons,
        index: deps.index,
        getPricing: deps.gateway.getPricing,
        embedder: deps.gateway.embedder ?? null,
      },
      seat,
      { spec: b.spec, description: b.description, constraints: b.constraints, build_estimate: b.build_estimate },
    );
  });

  app.post("/v1/assets/capture", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as {
      spec?: AcquireRequest["spec"];
      content?: string;
      provenance?: { producer: string; source: string; build_method: string };
      license?: { redistributable: boolean; spdx_or_terms: string | null };
      parent_fp?: string | null;
      price_usd?: number;
      schema_json?: unknown;
    };
    if (!b?.spec || b?.content == null || !b?.provenance)
      throw Object.assign(new Error("spec, content, provenance required"), {
        statusCode: 400,
      });
    const policy = await getPolicy(ctx);
    const classifier = deps.classifierFor ? await deps.classifierFor(ctx) : null;
    const authRes = await deps.auth.verify(req.headers.authorization);
    // R1 (QA MJ1 hardening): only an ADMIN may vouch source="internal". A
    // seat/agent capture is treated as external for the license cap, so it
    // cannot self-declare internal provenance to dodge the org cap.
    const declaredSource = b.provenance.source;
    const effectiveSource =
      declaredSource === "internal" && authRes.role !== "admin"
        ? "declared_internal_unverified"
        : declaredSource;
    const res = await captureAsset(
      ctx,
      deps.objects,
      policy,
      {
        spec: b.spec,
        bytes: Buffer.from(b.content, "utf8"),
        // QA MJ1: producer = the AUTHENTICATED identity; the caller's claim is
        // recorded as declared_producer and trusted for nothing.
        provenance: {
          producer: authRes.subject ?? "unknown",
          declared_producer: b.provenance.producer,
          source: effectiveSource,
          build_method: b.provenance.build_method,
        },
        license: b.license,
        license_evidence: (b as { license_evidence?: string }).license_evidence ?? null,
        parent_fp: b.parent_fp,
        price_usd: b.price_usd,
        schema_json: b.schema_json,
      },
      deps.gateway.embedder ?? null,
      classifier,
    );
    return reply.status(res.captured ? 201 : 422).send(res);
  });

  // AD11: promotion of money is ALWAYS a named human. approver = required.
  app.post("/v1/approvals/:proposalId/:decision", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const { proposalId, decision } = req.params as {
      proposalId: string;
      decision: string;
    };
    if (decision !== "approve" && decision !== "reject")
      return reply.status(400).send({ error: "decision must be approve|reject" });
    const b = req.body as { approver?: string };
    if (!b?.approver)
      return reply.status(400).send({ error: "approver (named human) required - no exceptions (AD11)" });
    const row = await ctx.db.query<{
      source: string; catalog_ref: string; price_usd: string;
      billing_route: string; requested_by_seat: string; status: string;
    }>(
      `SELECT source, catalog_ref, price_usd::text, billing_route, requested_by_seat, status
         FROM purchase_approvals WHERE proposal_id = $1`,
      [proposalId],
    );
    if (row.rows.length === 0) return reply.status(404).send({ error: "unknown proposal" });
    if (row.rows[0].status !== "pending")
      return reply.status(409).send({ error: `already ${row.rows[0].status}` });
    const p = row.rows[0];
    const status = decision === "approve" ? "approved" : "rejected";
    const approvalAuth = await deps.auth.verify(req.headers.authorization);
    await ctx.db.query(
      `UPDATE purchase_approvals SET status = $1, approver = $2, decided_at = now() WHERE proposal_id = $3`,
      [status, `${b.approver} [auth:${approvalAuth.subject ?? "unknown"}]`, proposalId], // MJ2
    );
    const seat = await seatRefFor(ctx, p.requested_by_seat);
    const pricing = deps.gateway.getPricing();
    await ingestEvent(ctx, {
      event_id: randomUUID(),
      call_id: randomUUID(),
      schema_version: "1.1",
      ts: new Date().toISOString(),
      seat_id: seat.seat_id,
      identity_type: seat.identity_type,
      user_id: seat.user_id,
      team_id: seat.team_id,
      agent_identity: seat.agent_identity,
      host: "other",
      capture_path: "tool",
      session_id: null,
      module: "reuse",
      intervention_type: decision === "approve" ? "purchase_approved" : "purchase_rejected",
      model_requested: null,
      model_used: null,
      tokens: { input_counterfactual: 0, output_counterfactual: 0, input_actual: 0, output_actual: 0 },
      cost: {
        counterfactual_usd: 0,
        actual_usd: 0,
        avoided_usd: 0,
        currency: "USD",
        pricing_source: "meter",
        pricing_version: pricing?.pricing_version ?? "unpriced",
      },
      energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
      carbon: {
        avoided_co2e_g: 0, grid_intensity_g_per_kwh: 400, pue: 1.2, region: null,
        method: "EcoLogits-class", confidence: "Estimated",
      },
      methodology_version: "esg-v1",
      asset_ref: null,
      cache_ref: null,
      sourcing: {
        rung: 4,
        source: p.source as "adx" | "snowflake",
        catalog_ref: p.catalog_ref,
        spend_usd: decision === "approve" ? Number(p.price_usd) : 0, // spend on its own line, never netted (AD12)
        billing_route: p.billing_route as "customer_aws" | "customer_snowflake",
        approval_ref: proposalId,
        license: { redistributable: false, spdx_or_terms: null, parent_fp: null },
        commons_captured: false,
      },
      catalog_reserved: null,
    });
    return {
      proposal_id: proposalId,
      status,
      approver: b.approver,
      // router-not-merchant (D15): the customer's own account transacts
      next_step:
        decision === "approve"
          ? `subscribe via your own ${p.billing_route === "customer_aws" ? "AWS (Data Exchange)" : "Snowflake"} account: ${p.catalog_ref}. Circulara records the reference and the itemized spend; it never resells data.`
          : "no purchase; the request falls back to build",
    };
  });

  app.get("/v1/approvals", async (req) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const r = await ctx.db.query(
      `SELECT proposal_id, source, catalog_ref, title, price_usd::text, billing_route,
              build_cost_usd::text, status, approver, created_at, decided_at
         FROM purchase_approvals ORDER BY created_at DESC`,
    );
    return { proposals: r.rows };
  });

  // AD12/D15: the unified, ITEMIZED external-data-spend report
  app.get("/v1/meter/external-spend", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const r = await ctx.db.query<{
      ts: string; intervention_type: string; spend: string; payload: {
        sourcing?: { source?: string; catalog_ref?: string; approval_ref?: string; billing_route?: string };
        user_id?: string;
      };
    }>(
      `SELECT ts, intervention_type, coalesce(sourcing_spend_usd,0)::text AS spend, payload
         FROM meter_events WHERE sourcing_rung IS NOT NULL ORDER BY ts DESC`,
    );
    const items = r.rows.map((x) => ({
      ts: x.ts,
      type: x.intervention_type,
      source: x.payload.sourcing?.source ?? null,
      catalog_ref: x.payload.sourcing?.catalog_ref ?? null,
      approval_ref: x.payload.sourcing?.approval_ref ?? null,
      billing_route: x.payload.sourcing?.billing_route ?? null,
      requested_by: x.payload.user_id ?? null,
      spend_usd: Number(x.spend),
    }));
    return {
      total_spend_usd: items.reduce((s, i) => s + i.spend_usd, 0),
      note: "external purchases transact on YOUR accounts (router, not merchant - D15); reported separately, never netted into savings (AD12)",
      items,
    };
  });

  // wave 5: Commons stats (network-effect metrics, §14)
  app.get("/v1/commons/stats", async (req) => {
    await auth(req);
    return deps.commons.stats();
  });

  // ---- wave 6: sharing-tier promotion + audit trail (§6 steps 5-6) ----
  app.post("/v1/assets/:fp/promote", async (req, reply) => {
    const role = await auth(req);
    const authRes = await deps.auth.verify(req.headers.authorization); // MJ2: audited subject
    const ctx = await tenantCtx(req);
    const { fp } = req.params as { fp: string };
    const b = req.body as { to_tier?: string; approver?: string };
    const { TIER_ORDER, minTier } = await import("../engines/clearance/pipeline.js");
    const { auditLog } = await import("../engines/clearance/pipeline.js");
    const to = b?.to_tier as (typeof TIER_ORDER)[number];
    if (!to || !TIER_ORDER.includes(to))
      return reply.status(400).send({ error: "to_tier must be private|team|org|marketable" });
    const row = await ctx.db.query<{
      sharing_tier: string;
      clearance: { max_tier?: string } | null;
      license: { redistributable?: boolean };
      provenance: { source?: string };
    }>(
      `SELECT sharing_tier, clearance, license, provenance FROM assets WHERE exact_fp = $1`,
      [fp],
    );
    if (row.rows.length === 0) return reply.status(404).send({ error: "unknown asset" });
    const asset = row.rows[0];
    const deny = async (reason: string, status = 403) => {
      await auditLog(ctx, {
        exact_fp: fp,
        action: "promote_denied",
        actor: authRes.subject ?? "unknown", // MJ2: the AUTHENTICATED subject
        detail: { to_tier: to, reason, approver_declared: b?.approver ?? null },
      });
      return reply.status(status).send({ error: reason });
    };
    // the clearance cap from capture time is binding
    const cap = (asset.clearance?.max_tier ?? "org") as (typeof TIER_ORDER)[number];
    if (minTier(to, cap) !== to)
      return deny(`clearance pipeline capped this asset at '${cap}' - promotion to '${to}' refused`);
    // marketable: named human, ALWAYS + license verifiably redistributable
    // THROUGH THE WHOLE PARENT CHAIN (QA BL4) + recorded evidence (QA MJ1)
    if (to === "marketable") {
      if (!b?.approver)
        return deny("promotion to marketable ALWAYS requires a named human approver - no exceptions (§6 step 5)", 400);
      if (asset.license?.redistributable !== true)
        return deny("marketable requires a verifiably redistributable license");
      const { effectiveRedistributable } = await import("../engines/reuse/library.js");
      if (!(await effectiveRedistributable(ctx, fp)))
        return deny(
          "marketable requires the ENTIRE parent chain to be verifiably redistributable - derivative license inheritance (D14/BL4), walk fails closed",
        );
      const ev = await ctx.db.query<{ license_evidence: string | null }>(
        `SELECT license_evidence FROM assets WHERE exact_fp = $1`,
        [fp],
      );
      if (!ev.rows[0]?.license_evidence)
        return deny("marketable requires recorded license evidence (MJ1)");
    }
    // org: auto-approve only if policy says so; otherwise a named human
    if (to === "org") {
      const policy = await getPolicy(ctx);
      if (!policy.clearance.auto_approve_org && !b?.approver)
        return deny("org promotion requires a named approver (auto_approve_org is off)", 400);
    }
    if ((to === "org" || to === "marketable") && role !== "admin")
      return deny("org/marketable promotion is admin-only");
    await ctx.db.query(`UPDATE assets SET sharing_tier = $1 WHERE exact_fp = $2`, [to, fp]);
    await auditLog(ctx, {
      exact_fp: fp,
      action: "promote",
      actor: authRes.subject ?? "unknown", // MJ2: the AUTHENTICATED subject
      detail: { from: asset.sharing_tier, to, approver_declared: b?.approver ?? "policy:auto_approve_org" },
    });
    return { exact_fp: fp, sharing_tier: to, approver: b?.approver ?? null };
  });

  app.get("/v1/clearance/audit", async (req) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const r = await ctx.db.query(
      `SELECT id, exact_fp, action, actor, detail, false_positive, ts
         FROM clearance_audit ORDER BY ts DESC LIMIT 200`,
    );
    return { entries: r.rows };
  });

  // FP-rate metric: admin marks an over-block as a false positive
  app.post("/v1/clearance/audit/:id/false-positive", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const { id } = req.params as { id: string };
    await ctx.db.query(`UPDATE clearance_audit SET false_positive = true WHERE id = $1`, [id]);
    return reply.status(204).send();
  });

  app.get("/v1/clearance/stats", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const r = await ctx.db.query<{ action: string; n: number; fp: number }>(
      `SELECT action, count(*)::int AS n,
              count(*) FILTER (WHERE false_positive)::int AS fp
         FROM clearance_audit GROUP BY action`,
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.action, { n: x.n, false_positives: x.fp }]));
    const blocks = (by.capture_blocked?.n ?? 0) + (by.promote_denied?.n ?? 0);
    const fps = (by.capture_blocked?.false_positives ?? 0) + (by.promote_denied?.false_positives ?? 0);
    return {
      by_action: by,
      false_positive_rate: blocks > 0 ? fps / blocks : 0,
      note: "over-blocking starves the library; admins mark wrongly blocked items so the rate is measured, not guessed",
    };
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
    const role = await auth(req);
    const ctx = await tenantCtx(req);
    const ev = interventionEventSchema.parse(req.body);
    // QA BL2 (meter forgery): this route accepts OBSERVE events only, from
    // anyone. Every intervention event (compress/route/reuse/purchase/...)
    // is engine-born in-process and NEVER arrives through the API - there is
    // no client input path to the savings number, full stop. Observe events
    // are unconditionally re-priced server-side; client cost fields and
    // pricing_source claims are ignored.
    void role;
    if (ev.intervention_type !== "observe")
      return reply.status(403).send({
        error:
          "this route accepts observe events only; intervention events are engine-originated in-process (QA BL2)",
      });
    const res = await normalizeAndAppend(
      ctx,
      { getPricing: deps.gateway.getPricing },
      ev,
      /* fromClient */ true, // ALWAYS re-price client events
    );
    return reply.status(201).send(res);
  });

  app.get("/v1/meter/summary", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    return meterSummary(ctx);
  });

  // Task 011: consolidated Observer meter (actual vs potential vs savings,
  // four ways, reconciling by construction) + Routing Readiness.
  app.get("/v1/observer/meter", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const q = req.query as { from?: string; to?: string };
    const { observerMeter } = await import("../meter/observer.js");
    return observerMeter(ctx, deps.gateway.getPricing(), { from: q.from, to: q.to });
  });

  app.get("/v1/observer/routing-readiness", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const q = req.query as { from?: string; to?: string };
    const { routingReadiness } = await import("../meter/observer.js");
    return routingReadiness(ctx, deps.gateway.getPricing(), { from: q.from, to: q.to });
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

  // ---- consumer dashboard login wiring (builder.20260708.001) ----
  // When web auth is configured, register /login + /auth/* and authenticate the
  // dashboard via a signed session cookie. The dev `?token=`/`?tenant=` path is
  // kept as a fallback (dev mode only) for local use + the sprint test suite.
  if (deps.web) registerWebAuth(app, deps.web);

  const escAttr = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  interface DashScope {
    ctx: Awaited<ReturnType<ControlPlane["contextFor"]>>;
    tenantId: string;
    /** the signed-in user's email when cookie-authed; undefined in dev-token mode */
    email?: string;
    /** query string for tab/download links, correct for the active auth mode */
    mkQ: (month?: string) => string;
    /** header account block (email + Sign out) when cookie-authed; else "" */
    account: string;
  }

  // Returns the resolved scope, or null after writing a 401/redirect to reply.
  const dashGuard = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<DashScope | null> => {
    // 1. signed session cookie (consumer / production)
    if (deps.web) {
      const s = await sessionFromRequest(deps.web, req);
      if (s) {
        try {
          const ctx = await deps.control.contextFor(s.tenant_id);
          const mkQ = (month?: string) => (month ? `?month=${month}` : "");
          const account = `<span class="crumb">${escAttr(s.email)}</span> &middot; <a class="crumb" href="/auth/logout">Sign out</a>`;
          return { ctx, tenantId: s.tenant_id, email: s.email, mkQ, account };
        } catch {
          // workspace vanished under a live session -> re-auth
        }
      }
    }
    // 2. dev token/tenant fallback (dev static tokens verify only in dev mode)
    const q = req.query as { token?: string; tenant?: string };
    const authz = req.headers.authorization ?? (q.token ? `Bearer ${q.token}` : undefined);
    const res = await deps.auth.verify(authz);
    const tenantId = q.tenant ?? (req.headers["x-tenant-id"] as string | undefined);
    if (res.ok && tenantId) {
      if (res.tenant_id != null && res.tenant_id !== tenantId) {
        reply.status(403).send({ error: "credential is bound to a different tenant (BL1)" });
        return null;
      }
      try {
        const ctx = await deps.control.contextFor(tenantId);
        const mkQ = (month?: string) => {
          const p = [`tenant=${tenantId}`];
          if (q.token) p.push(`token=${q.token}`);
          if (month) p.push(`month=${month}`);
          return `?${p.join("&")}`;
        };
        return { ctx, tenantId, mkQ, account: "" };
      } catch {
        reply.status(404).send({ error: "unknown tenant" });
        return null;
      }
    }
    // 3. unauthenticated: send humans to /login (consumer), else 401 (dev/tests)
    if (deps.web && deps.web.mode !== "dev") {
      reply.redirect("/login");
      return null;
    }
    reply.status(401).send({ error: "unauthorized" });
    return null;
  };

  app.get("/dashboard", async (req, reply) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const month = (req.query as { month?: string }).month;
    const r = await meterReport(g.ctx, month);
    // Blend: feed the MEASURED routing + duplicate savings from this org's own
    // traffic into the potential estimate; benchmarks cover the rest.
    const { observerMeter } = await import("../meter/observer.js");
    const om = await observerMeter(g.ctx, deps.gateway.getPricing(), {
      from: month ? `${month}-01` : undefined,
    });
    const p = savingsPotential(r.observed_usd, {
      routingUsd: om.savings_source.routing_usd,
      dedupeUsd: om.savings_source.dedupe_usd,
    });
    return reply.type("text/html").send(renderDashboard(r, p, g.mkQ(month), g.account, g.email));
  });

  app.get("/dashboard/meter", async (req, reply) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const month = (req.query as { month?: string }).month;
    const { observerMeter, routingReadiness } = await import("../meter/observer.js");
    const m = await observerMeter(g.ctx, deps.gateway.getPricing(), { from: month ? `${month}-01` : undefined });
    const rr = await routingReadiness(g.ctx, deps.gateway.getPricing(), {});
    return reply.type("text/html").send(renderObserverMeter(m, rr.types, g.mkQ(), g.account));
  });

  app.get("/dashboard/potential", async (req, reply) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const month = (req.query as { month?: string }).month;
    const r = await meterReport(g.ctx, month);
    const p = savingsPotential(r.observed_usd);
    return reply.type("text/html").send(renderPotential(r, p, g.mkQ(month), g.account));
  });

  app.get("/dashboard/statement", async (req, reply) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const month = (req.query as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    const r = await meterReport(g.ctx, month);
    const p = savingsPotential(r.observed_usd);
    const { computeInvoice } = await import("../billing/billing.js");
    const invoice = await computeInvoice(g.ctx, month);
    return reply
      .type("text/html")
      .send(renderStatement(r, p, g.mkQ(month), month, invoice.total_usd, g.account));
  });

  // ESG export from the dashboard (browser download). Cookie- or token-authed so
  // the <a> links work in both consumer and dev modes; the /v1 API variant stays
  // header-only for programmatic clients.
  const dashEsg = async (req: FastifyRequest, reply: FastifyReply, csv: boolean) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const month = (req.query as { month?: string }).month;
    if (month && !/^\d{4}-\d{2}$/.test(month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    const { esgExport, esgExportCsv } = await import("../meter/esg.js");
    const tenant = await deps.control.getTenant(g.tenantId);
    const report = await meterReport(g.ctx, month);
    const exp = esgExport(report, tenant?.name ?? g.tenantId);
    if (csv)
      return reply
        .type("text/csv")
        .header("content-disposition", `attachment; filename=circulara-esg-${exp.period}.csv`)
        .send(esgExportCsv(exp));
    return reply.send(exp);
  };
  app.get("/dashboard/esg.json", (req, reply) => dashEsg(req, reply, false));
  app.get("/dashboard/esg.csv", (req, reply) => dashEsg(req, reply, true));

  // builder.20260708.002: self-serve install strings. The published plugin is
  // `npx -y -p @circulara/plugin <bin>` (Path A, dist bundled with schema inlined).
  const INSTALL_COMMAND = "claude mcp add circulara -- npx -y -p @circulara/plugin circulara-mcp";
  const HOOK_SETTINGS = {
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "npx -y -p @circulara/plugin circulara-hook-pre" }] },
      ],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "npx -y -p @circulara/plugin circulara-hook" }] },
      ],
    },
  };

  // The ready-to-paste onboarding block config.ts needs. Mints (or reuses) the
  // caller's human seat and a per-workspace signed install token.
  const buildOnboarding = async (tenantId: string, userId: string) => {
    const ctx = await deps.control.contextFor(tenantId);
    const existing = await ctx.db.query<{ seat_id: string }>(
      `SELECT seat_id FROM seats WHERE user_id = $1 AND identity_type = 'human' AND active LIMIT 1`,
      [userId],
    );
    const seatId =
      existing.rows[0]?.seat_id ??
      (await provisionSeat(ctx, { identity_type: "human", user_id: userId }, "admin")).seat_id;
    const token = await deps.auth.mintWorkspaceToken(tenantId);
    const backendUrl = deps.web?.baseUrl ?? "";
    return {
      tenant_id: tenantId,
      seat_id: seatId,
      user_id: userId,
      token,
      backend_url: backendUrl,
      install_command: INSTALL_COMMAND,
      // exact field names config.ts (loadPluginConfig) reads
      env: {
        CIRCULARA_BACKEND_URL: backendUrl,
        CIRCULARA_TENANT_ID: tenantId,
        CIRCULARA_TOKEN: token,
        CIRCULARA_SEAT_ID: seatId,
        CIRCULARA_USER_ID: userId,
      },
      hook_settings: HOOK_SETTINGS,
    };
  };

  // Per-workspace plugin onboarding (free Observe). The plugin sends CIRCULARA_TOKEN.
  // Session cookie (dashboard "Connect plugin") OR bearer admin. Replaces the dev
  // static tokens as the production install path.
  app.get("/v1/workspace/plugin-token", async (req, reply) => {
    let tenantId: string | undefined;
    let role: Role | undefined;
    let userId: string | undefined;
    if (deps.web) {
      const s = await sessionFromRequest(deps.web, req);
      if (s) {
        tenantId = s.tenant_id;
        role = s.role === "admin" ? "admin" : "seat";
        userId = s.email;
      }
    }
    if (!tenantId) {
      const res = await deps.auth.verify(req.headers.authorization);
      const hdr = req.headers["x-tenant-id"] as string | undefined;
      if (res.ok && hdr) {
        if (res.tenant_id != null && res.tenant_id !== hdr)
          return reply.status(403).send({ error: "credential is bound to a different tenant (BL1)" });
        tenantId = hdr;
        role = res.role;
        userId = (req.headers["x-user-id"] as string | undefined) ?? `admin@${hdr}`;
      }
    }
    if (!tenantId)
      return reply.status(401).send({ error: "sign in to the dashboard or provide an admin token" });
    if (role !== "admin")
      return reply.status(403).send({ error: "admin only" });
    const o = await buildOnboarding(tenantId, userId!);
    return {
      ...o,
      note: "Set these in your plugin env. Treat CIRCULARA_TOKEN like a password; re-mint here to rotate.",
    };
  });

  // "Let's talk" contact form from the dashboard upgrade flow. Emails the team
  // via Brevo (same verified sender as the marketing site). Signed-in only.
  app.post("/v1/contact", async (req, reply) => {
    if (deps.web) {
      const s = await sessionFromRequest(deps.web, req);
      if (!s) return reply.status(401).send({ error: "sign in first" });
    }
    const b = (req.body ?? {}) as {
      firstName?: string; lastName?: string; email?: string; phone?: string; message?: string;
    };
    const firstName = (b.firstName ?? "").trim();
    const lastName = (b.lastName ?? "").trim();
    const email = (b.email ?? "").trim();
    const phone = (b.phone ?? "").trim();
    const message = (b.message ?? "").trim();
    if (!firstName || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return reply.status(400).send({ error: "name, a valid email, and a message are required" });
    const key = deps.web?.email?.brevoApiKey;
    if (!key) return reply.status(503).send({ error: "contact is not configured" });
    const name = `${firstName} ${lastName}`.trim();
    const esc2 = (s: string) =>
      s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
    const rows: [string, string][] = [
      ["Name", name], ["Email", email], ["Phone", phone], ["Message", message],
    ];
    const rowsHtml = rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 14px 4px 0;color:#42566B;vertical-align:top"><strong>${esc2(k)}</strong></td><td style="padding:4px 0;color:#0A2540">${esc2(v).replace(/\n/g, "<br>")}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:Inter,Arial,sans-serif;color:#0A2540;max-width:560px"><h2 style="color:#0072B5;margin:0 0 14px;font-size:18px">New Observer upgrade enquiry</h2><table style="border-collapse:collapse;font-size:14px">${rowsHtml}</table><p style="margin-top:22px;color:#8497A9;font-size:12px">Submitted from the Circulara Observer dashboard.</p></div>`;
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: "Circulara Observer", email: "hello@circularroute.com" },
          to: [{ email: "hello@circularroute.com" }],
          replyTo: { email, name },
          subject: `[Circulara] Observer upgrade: ${name}`,
          htmlContent: html,
        }),
      });
      if (!res.ok) return reply.status(502).send({ error: "could not send your message" });
    } catch {
      return reply.status(502).send({ error: "could not send your message" });
    }
    return { ok: true };
  });

  // The onboarding PAGE: install command + copy-paste env block + hook snippet.
  app.get("/dashboard/connect", async (req, reply) => {
    const g = await dashGuard(req, reply);
    if (!g) return reply;
    const o = await buildOnboarding(g.tenantId, g.email ?? `admin@${g.tenantId}`);
    return reply.type("text/html").send(
      renderConnect(
        { installCommand: o.install_command, env: o.env, hookSettings: HOOK_SETTINGS },
        g.mkQ(),
        g.account,
      ),
    );
  });

  // ---- wave 8: per-seat billing, TEST MODE only (no live charges) ----
  app.get("/v1/billing/invoice", async (req) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const q = req.query as { month?: string };
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    const { computeInvoice } = await import("../billing/billing.js");
    return computeInvoice(ctx, month);
  });

  app.put("/v1/billing/plan", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { plan?: string; cycle?: string };
    const { getBilling, setBilling, PLAN_PRICES } = await import("../billing/billing.js");
    if (!b?.plan || !(b.plan in PLAN_PRICES))
      return reply.status(400).send({ error: "plan must be observe|team|business|enterprise" });
    const cycle = b.cycle === "annual" ? "annual" : "monthly";
    const cur = await getBilling(ctx);
    await setBilling(ctx, { ...cur, plan: b.plan as keyof typeof PLAN_PRICES, cycle });
    return reply.status(204).send();
  });

  app.post("/v1/billing/redeem-early-adopter", async (req, reply) => {
    await adminOnly(req);
    const ctx = await tenantCtx(req);
    const { redeemEarlyAdopter } = await import("../billing/billing.js");
    const res = await redeemEarlyAdopter(deps.control.controlDb(), ctx);
    return reply.status(res.redeemed ? 200 : 409).send(res);
  });

  // checkout session for the public pricing page (CTO wires the button).
  // Stripe module resolves test-vs-live from env; test is the default.
  app.post("/v1/billing/checkout-intent", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { plan?: string; cycle?: string };
    const { PLAN_PRICES, computeInvoice } = await import("../billing/billing.js");
    const { resolveStripeConfig, createCheckoutSession } = await import("../billing/stripe.js");
    if (!b?.plan || !(b.plan in PLAN_PRICES))
      return reply.status(400).send({ error: "plan required" });
    const month = new Date().toISOString().slice(0, 7);
    const inv = await computeInvoice(ctx, month);
    return createCheckoutSession(
      resolveStripeConfig(),
      b.plan as keyof typeof PLAN_PRICES,
      b.cycle === "annual" ? "annual" : "monthly",
      ctx.tenantId,
      Math.max(1, inv.active_seats),
    );
  });

  // Stripe webhook (live mode only; test mode rejects unauthenticated events).
  // No auth() - authenticity is the SIGNATURE, verified against the secret.
  app.post("/v1/billing/webhook", async (req, reply) => {
    const { resolveStripeConfig, verifyWebhook } = await import("../billing/stripe.js");
    const scfg = resolveStripeConfig();
    let event: unknown;
    try {
      event = verifyWebhook(
        scfg,
        typeof req.body === "string" ? req.body : JSON.stringify(req.body),
        req.headers["stripe-signature"] as string | undefined,
      );
    } catch (e) {
      return reply.status((e as { statusCode?: number }).statusCode ?? 400).send({ error: (e as Error).message });
    }
    // v1 records the event; subscription-state application lands with the
    // deploy target. Money never moves here - Stripe already charged.
    return reply.status(200).send({ received: true, type: (event as { type?: string })?.type ?? null });
  });

  // Billing mode probe (so the CTO/founder can confirm the gate is closed).
  app.get("/v1/billing/mode", async (req) => {
    await auth(req);
    const { resolveStripeConfig } = await import("../billing/stripe.js");
    const scfg = resolveStripeConfig();
    return { mode: scfg.mode, reason: scfg.reason };
  });

  // ---- wave 7: ESG-ready export (credible-transparent, D8) ----
  app.get("/v1/meter/esg-export", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const q = req.query as { month?: string; format?: string };
    if (q.month && !/^\d{4}-\d{2}$/.test(q.month))
      throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
    const { esgExport, esgExportCsv } = await import("../meter/esg.js");
    const tenant = await deps.control.getTenant(ctx.tenantId);
    const report = await meterReport(ctx, q.month);
    const exp = esgExport(report, tenant?.name ?? ctx.tenantId);
    if (q.format === "csv")
      return reply
        .type("text/csv")
        .header("content-disposition", `attachment; filename=circulara-esg-${exp.period}.csv`)
        .send(esgExportCsv(exp));
    return exp;
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
