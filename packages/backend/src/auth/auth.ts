/**
 * WS2 - real auth. Replaces the sprint-1 dev stub (AD6).
 *
 * Three ways in:
 *  1. OIDC/SSO (humans): RS256 JWT verified against the tenant org's issuer
 *     JWKS (issuer + audience configured per deployment). `sub` = SSO subject.
 *     Admin = configurable claim (default: "circulara_role" == "admin").
 *  2. Named-agent seat tokens: SHORT-LIVED (default 1h) HS256 JWTs minted by
 *     the backend for admin-provisioned agent seats (AD6). Signed with a
 *     per-deployment secret; claims bind tenant + seat.
 *  3. Dev mode: the sprint-1 static tokens, ONLY when CIRCULARA_AUTH_MODE=dev.
 *     Production default is oidc; dev tokens are rejected outside dev mode.
 *
 * Gateway credentials (M2) are NOT bearer auth - they authenticate the
 * gateway data path; see gateway.ts.
 */
import { randomUUID, createHash } from "node:crypto";
import {
  jwtVerify,
  SignJWT,
  createRemoteJWKSet,
  type JWTPayload,
  type CryptoKey as JoseKey,
} from "jose";
import type { TenantContext } from "../db/tenancy.js";

export type Role = "admin" | "seat";

export interface AuthResult {
  ok: boolean;
  role?: Role;
  subject?: string; // SSO sub or agent seat_id
  kind?: "oidc" | "agent_token" | "workspace" | "dev";
  /** QA BL1: the tenant this credential is BOUND to. null = unbound, which is
   * acceptable ONLY in dev mode; oidc tokens without a tenant claim are
   * rejected at the tenant boundary (fail closed). */
  tenant_id?: string | null;
  reason?: string;
}

export interface AuthConfig {
  // dev     = sprint-1 static tokens (local/tests only).
  // consumer= free Observe: HS256 workspace-install + named-agent tokens; email/
  //           Google dashboard login lives in the web-auth layer. No OIDC bearer
  //           and no dev statics. This is the go-live free-tier mode.
  // oidc    = enterprise SSO bearer (RESERVED FOR PAID customers).
  mode: "oidc" | "dev" | "consumer";
  issuer?: string;
  audience?: string;
  adminClaim?: string; // claim name marking admins (default circulara_role)
  tenantClaim?: string; // claim naming the bound tenant (default circulara_tenant)
  agentTokenSecret: Buffer; // HS256 secret for agent seat + workspace tokens
  agentTokenTtlSeconds?: number;
  /** free-install workspace token lifetime (default 180d). */
  workspaceTokenTtlSeconds?: number;
  /** test seam: verification key overriding the remote JWKS */
  oidcKeyOverride?: JoseKey;
}

const DEV_ADMIN_TOKEN = "dev-admin-token";
const DEV_SEAT_TOKEN = "dev-seat-token";

export class Authenticator {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private cfg: AuthConfig) {
    if (cfg.mode === "oidc" && !cfg.oidcKeyOverride) {
      if (!cfg.issuer) throw new Error("oidc mode requires issuer");
      this.jwks = createRemoteJWKSet(
        new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
      );
    }
  }

  async verify(authorization?: string): Promise<AuthResult> {
    if (!authorization?.startsWith("Bearer "))
      return { ok: false, reason: "missing bearer token" };
    const token = authorization.slice(7);

    // dev mode only: static tokens
    if (this.cfg.mode === "dev") {
      if (token === DEV_ADMIN_TOKEN)
        return { ok: true, role: "admin", subject: "dev-admin", kind: "dev", tenant_id: null };
      if (token === DEV_SEAT_TOKEN)
        return { ok: true, role: "seat", subject: "dev-seat", kind: "dev", tenant_id: null };
    }

    // HS256, our own mint: named-agent seat token OR workspace-install token
    const hs = await this.verifyHsToken(token);
    if (hs.ok) return hs;

    // OIDC (RS256 against org issuer)
    if (this.cfg.mode === "oidc") {
      try {
        const opts = { issuer: this.cfg.issuer, audience: this.cfg.audience };
        const { payload } = this.cfg.oidcKeyOverride
          ? await jwtVerify(token, this.cfg.oidcKeyOverride, opts)
          : await jwtVerify(token, this.jwks!, opts);
        const roleClaim = payload[this.cfg.adminClaim ?? "circulara_role"];
        const tenantClaim = payload[this.cfg.tenantClaim ?? "circulara_tenant"];
        return {
          ok: true,
          role: roleClaim === "admin" ? "admin" : "seat",
          subject: String(payload.sub ?? ""),
          kind: "oidc",
          // BL1: admin means admin OF THIS TENANT, never of all tenants
          tenant_id: typeof tenantClaim === "string" ? tenantClaim : null,
        };
      } catch (e) {
        return { ok: false, reason: `oidc: ${(e as Error).message}` };
      }
    }
    return { ok: false, reason: "invalid token" };
  }

  /** Mint a short-lived token for an admin-provisioned named-agent seat (AD6). */
  async mintAgentToken(tenantId: string, seatId: string): Promise<string> {
    return new SignJWT({ tenant_id: tenantId, seat_id: seatId, typ: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(seatId)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + (this.cfg.agentTokenTtlSeconds ?? 3600),
      )
      .sign(this.cfg.agentTokenSecret);
  }

  /**
   * Mint a per-workspace install token (free Observe). This is the bearer the
   * plugin/MCP sends as CIRCULARA_TOKEN; it REPLACES the dev static tokens for
   * real installs. Bound to the workspace tenant (BL1) so the header x-tenant-id
   * must agree. Long-lived (default 180d) - a workspace admin re-mints from the
   * dashboard to rotate.
   */
  async mintWorkspaceToken(tenantId: string, role: "admin" | "seat" = "admin"): Promise<string> {
    return new SignJWT({ tenant_id: tenantId, typ: "workspace", role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(`workspace:${tenantId}`)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + (this.cfg.workspaceTokenTtlSeconds ?? 180 * 86400),
      )
      .sign(this.cfg.agentTokenSecret);
  }

  /** Verify an HS256 token we minted: named-agent seat OR workspace install. */
  private async verifyHsToken(token: string): Promise<AuthResult> {
    try {
      const { payload } = await jwtVerify(token, this.cfg.agentTokenSecret, {
        algorithms: ["HS256"],
      });
      const p = payload as JWTPayload & { typ?: string; tenant_id?: string; role?: string };
      // BL1: the tenant_id claim minted into the token is BINDING
      const tenant_id = String(p.tenant_id ?? "") || null;
      if (p.typ === "agent")
        return { ok: true, role: "seat", subject: String(payload.sub), kind: "agent_token", tenant_id };
      if (p.typ === "workspace")
        return {
          ok: true,
          role: p.role === "seat" ? "seat" : "admin",
          subject: String(payload.sub),
          kind: "workspace",
          tenant_id,
        };
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

// ---- seats (unchanged rules from sprint 1, AD6) ----

export interface SeatInput {
  identity_type: "human" | "named_agent";
  user_id: string;
  team_id?: string;
  agent_identity?: string;
}

export async function provisionSeat(
  ctx: TenantContext,
  input: SeatInput,
  role: Role,
): Promise<{ seat_id: string }> {
  if (input.identity_type === "named_agent" && role !== "admin") {
    throw Object.assign(
      new Error("named-agent seats are admin-provisioned only (AD6)"),
      { statusCode: 403 },
    );
  }
  if (input.identity_type === "named_agent" && !input.agent_identity) {
    throw Object.assign(new Error("named_agent requires agent_identity"), {
      statusCode: 400,
    });
  }
  const seatId = randomUUID();
  await ctx.db.query(
    `INSERT INTO seats (seat_id, identity_type, user_id, team_id, agent_identity)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      seatId,
      input.identity_type,
      input.user_id,
      input.team_id ?? null,
      input.agent_identity ?? null,
    ],
  );
  return { seat_id: seatId };
}

// ---- gateway credentials (M2) ----

export function hashCredential(cred: string): string {
  return createHash("sha256").update(cred).digest("hex");
}

/** Issue a per-seat gateway credential; only its hash is stored (M2). */
export async function issueGatewayCredential(
  ctx: TenantContext,
  seatId: string,
): Promise<{ credential: string }> {
  const credential = `ck-${randomUUID()}${randomUUID()}`.replace(/-/g, "");
  await ctx.db.query(
    `INSERT INTO gateway_credentials (cred_hash, seat_id) VALUES ($1, $2)`,
    [hashCredential(credential), seatId],
  );
  return { credential }; // shown once; never retrievable again
}

export async function seatForCredential(
  ctx: TenantContext,
  credential: string,
): Promise<string | null> {
  const res = await ctx.db.query<{ seat_id: string }>(
    `SELECT seat_id FROM gateway_credentials WHERE cred_hash = $1 AND active`,
    [hashCredential(credential)],
  );
  return res.rows[0]?.seat_id ?? null;
}
