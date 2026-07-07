/**
 * Auth wiring STUB (WS0). Real OIDC/SSO lands in WS2.
 *
 * Model (AD6):
 *  - human seat        = the org's SSO/IAM identity (OIDC subject). No new identity store.
 *  - named-agent seat  = admin-provisioned service principal bound to an owning
 *                        human, authenticated with short-lived per-session tokens.
 *  - admin-only agent provisioning is the structural anti-abuse guard.
 *
 * Sprint-1 stub: a static dev bearer token distinguishes admin vs seat calls so
 * the API surface and the provisioning rules are real even before OIDC is.
 * NOTHING here is production auth; WS2 replaces verifyRequest wholesale.
 */
import { randomUUID } from "node:crypto";
import type { TenantContext } from "../db/tenancy.js";

export type Role = "admin" | "seat";

export interface AuthResult {
  ok: boolean;
  role?: Role;
  reason?: string;
}

const DEV_ADMIN_TOKEN = "dev-admin-token"; // WS0 stub only; not a secret, not prod
const DEV_SEAT_TOKEN = "dev-seat-token";

export function verifyRequest(authorization?: string): AuthResult {
  if (!authorization?.startsWith("Bearer "))
    return { ok: false, reason: "missing bearer token" };
  const token = authorization.slice(7);
  if (token === DEV_ADMIN_TOKEN) return { ok: true, role: "admin" };
  if (token === DEV_SEAT_TOKEN) return { ok: true, role: "seat" };
  return { ok: false, reason: "invalid token" };
}

export interface SeatInput {
  identity_type: "human" | "named_agent";
  user_id: string; // SSO subject (human) or owning human (agent)
  team_id?: string;
  agent_identity?: string;
}

/** Provision a seat. Named-agent seats require admin role (AD6). */
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
