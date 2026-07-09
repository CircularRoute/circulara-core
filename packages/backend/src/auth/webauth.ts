/**
 * Consumer dashboard login (builder.20260708.001), founder decision 2026-07-08:
 *  - "Sign in with email" (magic-link, sent via Brevo - already wired for the
 *    website forms) and "Sign in with Google" (Google OAuth client the founder
 *    holds). Consumer-style, per USER; NOT enterprise per-org SSO.
 *  - Replaces the dev `?token=` dashboard access with a signed httpOnly session
 *    cookie bound to the user's workspace.
 *  - Enterprise OIDC/SSO is RESERVED FOR PAID customers (see auth.ts modes).
 *
 * Existing vendors only: Google OAuth + Brevo. No new vendor, no new runtime
 * dependency (jose + global fetch + node crypto). The live Google/Brevo calls
 * are injectable (sendEmail / exchangeGoogleCode) so the flow is unit-tested
 * without network; production uses the built-in fetch implementations below.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ControlPlane } from "../db/tenancy.js";
import {
  signSession,
  signMagic,
  verifyMagic,
  signState,
  verifyState,
  serializeCookie,
  clearCookie,
  parseCookies,
  type SessionClaims,
} from "./session.js";

export const SESSION_COOKIE = "cira_session";
const OAUTH_COOKIE = "cira_oauth";
const MAGIC_TTL_SECONDS = 15 * 60;

export interface WebAuthDeps {
  mode: "consumer" | "oidc" | "dev";
  baseUrl: string; // CIRCULARA_APP_BASE_URL, e.g. https://app.circulara.ai
  sessionSecret: Buffer;
  sessionTtlSeconds: number;
  secureCookies: boolean; // Secure attribute (true in prod / https)
  control: ControlPlane;
  google?: { clientId: string; clientSecret: string };
  email?: { brevoApiKey: string; fromEmail: string; fromName: string };
  /** test seam: capture the outbound magic-link email instead of calling Brevo */
  sendEmail?: (to: string, subject: string, html: string) => Promise<void>;
  /** test seam: stub the Google code exchange instead of calling Google */
  exchangeGoogleCode?: (
    code: string,
  ) => Promise<{ email: string; emailVerified: boolean; name?: string }>;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Only allow same-origin relative paths as post-login redirect (open-redirect guard).
const safeNext = (n?: string): string | undefined =>
  n && n.startsWith("/") && !n.startsWith("//") ? n : undefined;

const humanError = (code?: string): string | undefined => {
  switch (code) {
    case "google_unavailable":
      return "Google sign-in is not configured yet.";
    case "expired":
      return "That sign-in link expired. Request a new one.";
    default:
      return undefined;
  }
};

// ---- login page (Ledger Light: blue = action only) --------------------------

function loginPage(web: WebAuthDeps, opts: { error?: string; sent?: string; bye?: boolean } = {}): string {
  const googleBtn = web.google
    ? `<a class="btn google" href="/auth/google/start">Sign in with Google</a><div class="or">or</div>`
    : "";
  const msg = opts.error
    ? `<div class="msg err">${esc(opts.error)}</div>`
    : opts.sent
      ? `<div class="msg ok">Check your inbox - a sign-in link is on its way to <b>${esc(opts.sent)}</b>.</div>`
      : opts.bye
        ? `<div class="msg ok">You are signed out.</div>`
        : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in - Circulara AI</title><style>
:root{--surface:#fff;--surface-2:#EEF1F5;--line:#E2E8F0;--ink:#0A2540;--ink-2:#42566B;--ink-3:#8497A9;
--blue:#009BE8;--blue-deep:#0072B5;--green-deep:#0E8E4E;--err:#B42318;--r:12px;
--font:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--surface-2);color:var(--ink);font:16px/1.55 var(--font);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px -14px rgba(10,37,64,.18);padding:32px;max-width:400px;width:100%}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:22px;letter-spacing:-.01em;margin-bottom:4px}
.brand .mark{width:28px;height:28px;border-radius:50%;background:conic-gradient(#16B364 0 33%,var(--blue) 33% 66%,#00288C 66% 100%)}
.sub{color:var(--ink-3);font-size:14px;margin-bottom:24px}
label{display:block;font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:600;margin-bottom:8px}
input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r);font:16px var(--font);color:var(--ink);margin-bottom:16px}
input:focus{outline:2px solid rgba(0,155,232,.45);border-color:var(--blue)}
.btn{display:block;width:100%;text-align:center;padding:12px 16px;border-radius:var(--r);font-weight:600;font-size:15px;text-decoration:none;cursor:pointer;border:0}
button.btn{background:var(--blue);color:#fff}
.btn.google{background:#fff;color:var(--ink);border:1px solid var(--line);margin-bottom:16px}
.or{text-align:center;color:var(--ink-3);font-size:13px;margin-bottom:16px}
.msg{padding:12px 14px;border-radius:var(--r);font-size:14px;margin-bottom:16px}
.msg.ok{background:rgba(22,179,100,.10);color:var(--green-deep)}
.msg.err{background:rgba(180,35,24,.08);color:var(--err)}
.foot{color:var(--ink-3);font-size:12.5px;margin-top:20px;text-align:center}
</style></head><body>
<div class="card">
  <div class="brand"><span class="mark" aria-hidden="true"></span>Circulara AI</div>
  <div class="sub">Observe (free tier) - sign in to your workspace</div>
  ${msg}
  ${googleBtn}
  <form method="POST" action="/auth/email/start">
    <label for="email">Work email</label>
    <input id="email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required>
    <button class="btn" type="submit">Send me a sign-in link</button>
  </form>
  <div class="foot">Enterprise SSO is available on paid plans.</div>
</div></body></html>`;
}

// ---- live provider implementations (used when no test seam is injected) ------

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function liveExchangeGoogleCode(
  web: WebAuthDeps,
  code: string,
): Promise<{ email: string; emailVerified: boolean; name?: string }> {
  const g = web.google!;
  const body = new URLSearchParams({
    code,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    redirect_uri: `${web.baseUrl}/auth/google/callback`,
    grant_type: "authorization_code",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`google token exchange failed: ${r.status}`);
  const j = (await r.json()) as { id_token?: string };
  if (!j.id_token) throw new Error("google returned no id_token");
  if (!googleJwks)
    googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const { payload } = await jwtVerify(j.id_token, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: g.clientId,
  });
  return {
    email: String(payload.email ?? ""),
    emailVerified: (payload as { email_verified?: unknown }).email_verified === true,
    name: typeof (payload as { name?: unknown }).name === "string" ? (payload as { name: string }).name : undefined,
  };
}

async function liveSendEmail(
  web: WebAuthDeps,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const e = web.email!;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": e.brevoApiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: e.fromName, email: e.fromEmail },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!r.ok) throw new Error(`brevo send failed: ${r.status}`);
}

const magicEmailHtml = (link: string) =>
  `<div style="font-family:Inter,Arial,sans-serif;color:#0A2540;max-width:480px">
  <h2 style="margin:0 0 12px">Sign in to Circulara</h2>
  <p style="color:#42566B">Click the button below to sign in to your Observe workspace. This link expires in 15 minutes.</p>
  <p><a href="${esc(link)}" style="display:inline-block;background:#009BE8;color:#fff;padding:12px 20px;border-radius:12px;text-decoration:none;font-weight:600">Sign in</a></p>
  <p style="color:#8497A9;font-size:12px">If you did not request this, you can ignore this email.</p>
</div>`;

// ---- registration -----------------------------------------------------------

export function registerWebAuth(app: FastifyInstance, web: WebAuthDeps): void {
  const setCookie = (reply: FastifyReply, cookies: string[]) => {
    reply.header("set-cookie", cookies);
  };

  // Resolve (or self-serve create) the workspace for a VERIFIED email.
  const resolveWorkspace = async (
    email: string,
    name?: string,
  ): Promise<SessionClaims> => {
    const lower = email.toLowerCase();
    const ms = await web.control.membershipsFor(lower);
    if (ms.length > 0)
      return { email: lower, tenant_id: ms[0].tenant_id, role: ms[0].role, name };
    const t = await web.control.createSharedWorkspaceForEmail(lower);
    return { email: lower, tenant_id: t.tenant_id, role: "admin", name };
  };

  const finishLogin = async (
    reply: FastifyReply,
    claims: SessionClaims,
    next?: string,
    extraCookies: string[] = [],
  ) => {
    const token = await signSession(web.sessionSecret, claims, web.sessionTtlSeconds);
    const cookie = serializeCookie(SESSION_COOKIE, token, {
      maxAge: web.sessionTtlSeconds,
      httpOnly: true,
      secure: web.secureCookies,
      sameSite: "Lax",
    });
    setCookie(reply, [...extraCookies, cookie]);
    return reply.redirect(safeNext(next) ?? "/dashboard");
  };

  app.get("/login", async (req, reply) => {
    const q = req.query as { error?: string; bye?: string };
    return reply
      .type("text/html")
      .send(loginPage(web, { error: humanError(q.error), bye: q.bye === "1" }));
  });

  app.get("/auth/logout", async (_req, reply) => {
    setCookie(reply, [clearCookie(SESSION_COOKIE, web.secureCookies)]);
    return reply.redirect("/login?bye=1");
  });

  // ---- email magic-link ----
  app.post("/auth/email/start", async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string };
    const email = (b.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email))
      return reply
        .status(400)
        .type("text/html")
        .send(loginPage(web, { error: "Enter a valid email address." }));
    const next = safeNext((req.query as { next?: string }).next);
    const token = await signMagic(web.sessionSecret, email, MAGIC_TTL_SECONDS, next);
    const link = `${web.baseUrl}/auth/magic/callback?token=${encodeURIComponent(token)}`;
    const sender =
      web.sendEmail ?? (web.email ? (to: string, s: string, h: string) => liveSendEmail(web, to, s, h) : null);
    if (!sender) {
      // No email provider configured. In dev (insecure cookies) show the link so
      // local sign-in works; in production this is a misconfiguration, fail loud.
      if (web.secureCookies)
        return reply
          .status(500)
          .type("text/html")
          .send(loginPage(web, { error: "Email sign-in is not configured (missing BREVO_API_KEY)." }));
      return reply
        .type("text/html")
        .send(loginPage(web, { error: `Dev mode - no email provider. Sign-in link: ${link}` }));
    }
    try {
      await sender(email, "Sign in to Circulara", magicEmailHtml(link));
    } catch {
      return reply
        .status(502)
        .type("text/html")
        .send(loginPage(web, { error: "Could not send the sign-in email. Please try again." }));
    }
    return reply.type("text/html").send(loginPage(web, { sent: email }));
  });

  app.get("/auth/magic/callback", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    const v = token ? await verifyMagic(web.sessionSecret, token) : null;
    if (!v)
      return reply
        .status(400)
        .type("text/html")
        .send(loginPage(web, { error: "This sign-in link is invalid or expired. Request a new one." }));
    const claims = await resolveWorkspace(v.email);
    return finishLogin(reply, claims, v.next);
  });

  // ---- Google OAuth (authorization code) ----
  app.get("/auth/google/start", async (req, reply) => {
    if (!web.google) return reply.redirect("/login?error=google_unavailable");
    const nonce = randomUUID();
    const next = safeNext((req.query as { next?: string }).next);
    const state = await signState(web.sessionSecret, nonce, next);
    setCookie(reply, [
      serializeCookie(OAUTH_COOKIE, nonce, {
        maxAge: 600,
        httpOnly: true,
        secure: web.secureCookies,
        sameSite: "Lax",
      }),
    ]);
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", web.google.clientId);
    u.searchParams.set("redirect_uri", `${web.baseUrl}/auth/google/callback`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "select_account");
    return reply.redirect(u.toString());
  });

  app.get("/auth/google/callback", async (req, reply) => {
    if (!web.google) return reply.redirect("/login?error=google_unavailable");
    const q = req.query as { code?: string; state?: string };
    const cookieNonce = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    const st = q.state ? await verifyState(web.sessionSecret, q.state) : null;
    // CSRF double-submit: signed state nonce must equal the cookie nonce.
    if (!q.code || !st || !cookieNonce || st.nonce !== cookieNonce)
      return reply
        .status(400)
        .type("text/html")
        .send(loginPage(web, { error: "Google sign-in could not be verified. Please try again." }));
    let g: { email: string; emailVerified: boolean; name?: string };
    try {
      g = web.exchangeGoogleCode
        ? await web.exchangeGoogleCode(q.code)
        : await liveExchangeGoogleCode(web, q.code);
    } catch {
      return reply
        .status(502)
        .type("text/html")
        .send(loginPage(web, { error: "Google sign-in failed. Please try again." }));
    }
    if (!g.email || !g.emailVerified)
      return reply
        .status(403)
        .type("text/html")
        .send(loginPage(web, { error: "Your Google account email is not verified." }));
    const claims = await resolveWorkspace(g.email.toLowerCase(), g.name);
    return finishLogin(reply, claims, st.next, [clearCookie(OAUTH_COOKIE, web.secureCookies)]);
  });
}

/** Read + verify the dashboard session cookie from a request. */
export async function sessionFromRequest(
  web: Pick<WebAuthDeps, "sessionSecret">,
  req: FastifyRequest,
): Promise<SessionClaims | null> {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const { verifySession } = await import("./session.js");
  return verifySession(web.sessionSecret, raw);
}
