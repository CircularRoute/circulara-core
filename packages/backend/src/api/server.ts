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
import { captureAsset } from "../engines/reuse/library.js";
import type { ClassifierPort } from "../engines/clearance/pipeline.js";
import type { TenantContext } from "../db/tenancy.js";
import { acquireAsset, type AcquireRequest, type SeatRef } from "../sourcing/acquire.js";
import type { CommonsStore } from "../sourcing/commons.js";
import type { FederatedIndex } from "../sourcing/catalogs.js";
import { randomUUID } from "node:crypto";
import { handleGatewayMessage, type GatewayDeps } from "../gateway/gateway.js";
import type { ObjectStore } from "../storage/objectStore.js";

export interface AppDeps {
  control: ControlPlane;
  objects: ObjectStore;
  auth: Authenticator;
  gateway: GatewayDeps;
  commons: CommonsStore;
  index: FederatedIndex;
  /** wave 6: LLM classifier factory (BYO cheap model); null = unclassified-conservative */
  classifierFor?: (ctx: TenantContext) => Promise<ClassifierPort | null>;
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
    const res = await captureAsset(
      ctx,
      deps.objects,
      policy,
      {
        spec: b.spec,
        bytes: Buffer.from(b.content, "utf8"),
        provenance: b.provenance,
        license: b.license,
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
    await ctx.db.query(
      `UPDATE purchase_approvals SET status = $1, approver = $2, decided_at = now() WHERE proposal_id = $3`,
      [status, b.approver, proposalId],
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
        actor: b?.approver ?? "unnamed",
        detail: { to_tier: to, reason },
      });
      return reply.status(status).send({ error: reason });
    };
    // the clearance cap from capture time is binding
    const cap = (asset.clearance?.max_tier ?? "org") as (typeof TIER_ORDER)[number];
    if (minTier(to, cap) !== to)
      return deny(`clearance pipeline capped this asset at '${cap}' - promotion to '${to}' refused`);
    // marketable: named human, ALWAYS + license must be verifiably redistributable
    if (to === "marketable") {
      if (!b?.approver)
        return deny("promotion to marketable ALWAYS requires a named human approver - no exceptions (§6 step 5)", 400);
      if (asset.license?.redistributable !== true)
        return deny("marketable requires a verifiably redistributable license");
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
      actor: b?.approver ?? "policy:auto_approve_org",
      detail: { from: asset.sharing_tier, to },
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
    const { computeInvoice } = await import("../billing/billing.js");
    const invoice = await computeInvoice(ctx, month);
    return reply
      .type("text/html")
      .send(renderStatement(r, p, tenantQ(tenantId, q, month), month, invoice.total_usd));
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

  // checkout intent for the public pricing page (CTO wires the button)
  app.post("/v1/billing/checkout-intent", async (req, reply) => {
    await auth(req);
    const ctx = await tenantCtx(req);
    const b = req.body as { plan?: string; cycle?: string };
    const { checkoutIntent, PLAN_PRICES } = await import("../billing/billing.js");
    if (!b?.plan || !(b.plan in PLAN_PRICES))
      return reply.status(400).send({ error: "plan required" });
    return checkoutIntent(
      b.plan as keyof typeof PLAN_PRICES,
      b.cycle === "annual" ? "annual" : "monthly",
      ctx.tenantId,
    );
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
