/**
 * Browser session + short-lived flow tokens for the consumer dashboard login
 * (builder.20260708.001). Consumer-style sign-in (email magic-link + Google),
 * NOT enterprise SSO - enterprise OIDC/SSO is reserved for PAID customers.
 *
 * Everything here is HS256 via jose (already a dependency) + hand-rolled cookie
 * (de)serialization, so the dashboard login adds NO new runtime dependency and
 * no @fastify/cookie (cleaner npm install on Render).
 *
 * Three token kinds, all signed with the same session secret:
 *  - session:     the signed dashboard session (httpOnly cookie). Carries the
 *                 authenticated email + the workspace (tenant) it is bound to.
 *  - magic:       the emailed magic-link token (short TTL); proves email control.
 *  - oauth_state: CSRF state for the Google authorization-code flow.
 */
import { SignJWT, jwtVerify } from "jose";

const nowSec = () => Math.floor(Date.now() / 1000);

export interface SessionClaims {
  email: string;
  tenant_id: string;
  role: "admin" | "member";
  name?: string;
}

// ---- session ----------------------------------------------------------------

export async function signSession(
  secret: Buffer,
  c: SessionClaims,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ typ: "session", tid: c.tenant_id, role: c.role, name: c.name ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.email)
    .setIssuedAt()
    .setExpirationTime(nowSec() + ttlSeconds)
    .sign(secret);
}

export async function verifySession(
  secret: Buffer,
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const p = payload as { typ?: string; tid?: unknown; role?: unknown; name?: unknown };
    if (p.typ !== "session") return null;
    if (typeof p.tid !== "string" || (p.role !== "admin" && p.role !== "member")) return null;
    return {
      email: String(payload.sub ?? ""),
      tenant_id: p.tid,
      role: p.role,
      name: typeof p.name === "string" ? p.name : undefined,
    };
  } catch {
    return null;
  }
}

// ---- magic link -------------------------------------------------------------

export async function signMagic(
  secret: Buffer,
  email: string,
  ttlSeconds: number,
  next?: string,
): Promise<string> {
  return new SignJWT({ typ: "magic", email, next: next ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(nowSec() + ttlSeconds)
    .sign(secret);
}

export async function verifyMagic(
  secret: Buffer,
  token: string,
): Promise<{ email: string; next?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const p = payload as { typ?: string; email?: unknown; next?: unknown };
    if (p.typ !== "magic" || typeof p.email !== "string") return null;
    return { email: p.email, next: typeof p.next === "string" ? p.next : undefined };
  } catch {
    return null;
  }
}

// ---- oauth CSRF state -------------------------------------------------------

export async function signState(
  secret: Buffer,
  nonce: string,
  next?: string,
): Promise<string> {
  return new SignJWT({ typ: "oauth_state", nonce, next: next ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(nowSec() + 600)
    .sign(secret);
}

export async function verifyState(
  secret: Buffer,
  token: string,
): Promise<{ nonce: string; next?: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    const p = payload as { typ?: string; nonce?: unknown; next?: unknown };
    if (p.typ !== "oauth_state" || typeof p.nonce !== "string") return null;
    return { nonce: p.nonce, next: typeof p.next === "string" ? p.next : undefined };
  } catch {
    return null;
  }
}

// ---- cookies ----------------------------------------------------------------

export interface CookieOpts {
  maxAge?: number; // seconds
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Expire a cookie immediately (Max-Age=0). */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAge: 0, httpOnly: true, secure });
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
