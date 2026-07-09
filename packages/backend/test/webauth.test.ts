/**
 * builder.20260708.001 - consumer dashboard login (email magic-link + Google).
 * The live Google/Brevo calls are injected as test seams, so these exercise the
 * full redirect + cookie + session flow with no network. Covers: session crypto,
 * magic-link end-to-end, Google OAuth with CSRF state, cookie-authed dashboard,
 * dev-token fallback, and the per-workspace install token (BL1-bound).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ControlPlane } from "../src/db/tenancy.js";
import { FsObjectStore } from "../src/storage/objectStore.js";
import { buildApp } from "../src/api/server.js";
import { Authenticator } from "../src/auth/auth.js";
import {
  signSession,
  verifySession,
  signMagic,
  verifyMagic,
} from "../src/auth/session.js";
import type { WebAuthDeps } from "../src/auth/webauth.js";
import type { PricingSnapshot } from "../src/registry/pricing.js";

const SECRET = randomBytes(32);
const SESSION_SECRET = randomBytes(32);
const TEST_KEK = randomBytes(32);
const TEST_PRICING: PricingSnapshot = {
  pricing_version: "test-webauth",
  source: "fixture",
  fetched_at: "t",
  models: {
    "claude-haiku-4-5-20251001": {
      input_cost_per_token: 1e-6,
      output_cost_per_token: 5e-6,
      provider: "anthropic",
    },
  },
};

let control: ControlPlane;
let app: ReturnType<typeof buildApp>;
let tmp: string;
let sentEmails: { to: string; subject: string; html: string }[] = [];
let googleEmail: { email: string; emailVerified: boolean; name?: string };

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "circulara-webauth-"));
  control = new ControlPlane(tmp, /* inMemory */ true);
  await control.init();
  const { CommonsStore } = await import("../src/sourcing/commons.js");
  const { FederatedIndex, launchCatalogs } = await import("../src/sourcing/catalogs.js");
  const commons = new CommonsStore(tmp, true);
  await commons.init();

  const auth = new Authenticator({
    mode: "consumer",
    agentTokenSecret: SECRET,
  });
  const web: WebAuthDeps = {
    mode: "consumer",
    baseUrl: "http://localhost:8787",
    sessionSecret: SESSION_SECRET,
    sessionTtlSeconds: 3600,
    secureCookies: false,
    control,
    google: { clientId: "test-client-id", clientSecret: "test-secret" },
    email: { brevoApiKey: "x", fromEmail: "noreply@circulara.ai", fromName: "Circulara" },
    signupNotifyTo: "ops@circulara.test",
    sendEmail: async (to, subject, html) => {
      sentEmails.push({ to, subject, html });
    },
    exchangeGoogleCode: async () => googleEmail,
  };
  app = buildApp({
    control,
    web,
    objects: new FsObjectStore(join(tmp, "objects")),
    auth,
    gateway: { kek: TEST_KEK, getPricing: () => TEST_PRICING },
    commons,
    index: new FederatedIndex(launchCatalogs()),
    classifierFor: async () => async () => ({ risk_category: "none" as const, confidence: "high" as const }),
  });
});

after(async () => {
  await control.close();
  rmSync(tmp, { recursive: true, force: true });
});

const cookieVal = (setCookie: string | string[] | undefined, name: string): string | null => {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of arr) {
    const m = c.match(new RegExp(`(?:^|; |^)${name}=([^;]*)`));
    if (m && m[1] !== "") return decodeURIComponent(m[1]);
  }
  return null;
};

test("session token: sign/verify roundtrip, tamper + wrong-secret rejected", async () => {
  const tok = await signSession(SESSION_SECRET, { email: "a@b.com", tenant_id: "t1", role: "admin" }, 3600);
  const ok = await verifySession(SESSION_SECRET, tok);
  assert.equal(ok?.email, "a@b.com");
  assert.equal(ok?.tenant_id, "t1");
  assert.equal(ok?.role, "admin");
  assert.equal(await verifySession(randomBytes(32), tok), null); // wrong secret
  assert.equal(await verifySession(SESSION_SECRET, tok.slice(0, -3) + "xyz"), null); // tampered
});

test("magic token: verifies, and a magic token is NOT accepted as a session", async () => {
  const m = await signMagic(SESSION_SECRET, "u@x.com", 900, "/dashboard/meter");
  const v = await verifyMagic(SESSION_SECRET, m);
  assert.equal(v?.email, "u@x.com");
  assert.equal(v?.next, "/dashboard/meter");
  // typ discrimination: a magic token must never authenticate a session
  assert.equal(await verifySession(SESSION_SECRET, m), null);
});

test("GET /login renders email form + Google button", async () => {
  const res = await app.inject({ method: "GET", url: "/login" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("Send me a sign-in link"));
  assert.ok(res.body.includes("Sign in with Google"));
  assert.ok(res.body.includes('action="/auth/email/start"'));
});

test("email magic-link: start sends mail, callback sets session + self-serve-creates the workspace", async () => {
  sentEmails = [];
  const start = await app.inject({
    method: "POST",
    url: "/auth/email/start",
    payload: { email: "founder@newco.com" },
    headers: { "content-type": "application/json" },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, "founder@newco.com");
  // extract the magic token from the emailed link
  const m = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/);
  assert.ok(m, "email contains a magic-link token");
  const cb = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${m![1]}` });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, "/dashboard");
  const session = cookieVal(cb.headers["set-cookie"], "cira_session");
  assert.ok(session, "a session cookie is set");
  const claims = await verifySession(SESSION_SECRET, session!);
  assert.equal(claims?.email, "founder@newco.com");
  // a workspace was created for the verified email, with it as admin
  const ms = await control.membershipsFor("founder@newco.com");
  assert.equal(ms.length, 1);
  assert.equal(ms[0].role, "admin");
});

test("invalid email is rejected; bad magic token shows an error, sets no session", async () => {
  const bad = await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "not-an-email" }, headers: { "content-type": "application/json" },
  });
  assert.equal(bad.statusCode, 400);
  const cb = await app.inject({ method: "GET", url: "/auth/magic/callback?token=garbage" });
  assert.equal(cb.statusCode, 400);
  assert.equal(cookieVal(cb.headers["set-cookie"], "cira_session"), null);
});

test("a new signup emails the team (heads-up with the new email)", async () => {
  sentEmails = [];
  await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "newbie@startup.com" }, headers: { "content-type": "application/json" },
  });
  const token = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/)![1];
  await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  const notif = sentEmails.find(
    (e) => e.to === "ops@circulara.test" && e.subject.includes("New Observer signup"),
  );
  assert.ok(notif, "team notification sent");
  assert.ok(notif!.subject.includes("newbie@startup.com"));
  assert.ok(notif!.html.includes("newbie@startup.com"));
});

test("magic link is single-use: a reused link is rejected", async () => {
  sentEmails = [];
  await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "reuse@co.com" }, headers: { "content-type": "application/json" },
  });
  const token = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/)![1];
  const first = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  assert.equal(first.statusCode, 302); // works the first time
  const second = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  assert.equal(second.statusCode, 400); // reuse rejected
  assert.ok(second.body.includes("already been used"));
  assert.equal(cookieVal(second.headers["set-cookie"], "cira_session"), null);
});

test("email link requests are rate limited per address", async () => {
  let last;
  for (let i = 0; i < 6; i++)
    last = await app.inject({
      method: "POST", url: "/auth/email/start",
      payload: { email: "spammy@co.com" }, headers: { "content-type": "application/json" },
    });
  assert.equal(last!.statusCode, 429); // 6th within the window is blocked (limit 5)
  assert.ok(last!.body.includes("recently"));
});

test("dashboard: session cookie authenticates; no cookie redirects to /login", async () => {
  // sign in via magic link to get a cookie
  sentEmails = [];
  await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "dash@co.com" }, headers: { "content-type": "application/json" },
  });
  const token = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/)![1];
  const cb = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  const session = cookieVal(cb.headers["set-cookie"], "cira_session")!;

  const dash = await app.inject({
    method: "GET", url: "/dashboard", headers: { cookie: `cira_session=${session}` },
  });
  assert.equal(dash.statusCode, 200);
  assert.ok(dash.body.includes("Observe dashboard") || dash.body.includes("Circulara AI"));
  assert.ok(dash.body.includes("dash@co.com")); // account block in header
  assert.ok(dash.body.includes("Sign out"));

  // no cookie -> humans are redirected to the login page (consumer mode)
  const anon = await app.inject({ method: "GET", url: "/dashboard" });
  assert.equal(anon.statusCode, 302);
  assert.equal(anon.headers.location, "/login");
});

test("Google OAuth: start redirects with state cookie; callback verifies state + sets session", async () => {
  const start = await app.inject({ method: "GET", url: "/auth/google/start" });
  assert.equal(start.statusCode, 302);
  const loc = start.headers.location!;
  assert.ok(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  assert.ok(loc.includes("client_id=test-client-id"));
  const state = new URL(loc).searchParams.get("state")!;
  const nonce = cookieVal(start.headers["set-cookie"], "cira_oauth")!;
  assert.ok(state && nonce);

  googleEmail = { email: "g@gmail.com", emailVerified: true, name: "G User" };
  const cb = await app.inject({
    method: "GET",
    url: `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: `cira_oauth=${nonce}` },
  });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, "/dashboard");
  const session = cookieVal(cb.headers["set-cookie"], "cira_session");
  assert.equal((await verifySession(SESSION_SECRET, session!))?.email, "g@gmail.com");
});

test("Google OAuth: mismatched CSRF state is rejected; unverified email is refused", async () => {
  const start = await app.inject({ method: "GET", url: "/auth/google/start" });
  const state = new URL(start.headers.location!).searchParams.get("state")!;
  // wrong nonce cookie -> CSRF check fails
  const mism = await app.inject({
    method: "GET", url: `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: `cira_oauth=not-the-nonce` },
  });
  assert.equal(mism.statusCode, 400);
  assert.equal(cookieVal(mism.headers["set-cookie"], "cira_session"), null);

  // valid state but Google says the email is unverified -> 403
  const nonce = cookieVal(start.headers["set-cookie"], "cira_oauth")!;
  googleEmail = { email: "unverified@gmail.com", emailVerified: false };
  const unver = await app.inject({
    method: "GET", url: `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: `cira_oauth=${nonce}` },
  });
  assert.equal(unver.statusCode, 403);
});

test("plugin-token: minted for a session admin, BL1-bound, and authorizes the meter", async () => {
  // sign in -> get session + tenant
  sentEmails = [];
  await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "plug@co.com" }, headers: { "content-type": "application/json" },
  });
  const token = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/)![1];
  const cb = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  const session = cookieVal(cb.headers["set-cookie"], "cira_session")!;
  const tenantId = (await control.membershipsFor("plug@co.com"))[0].tenant_id;

  const pt = await app.inject({
    method: "GET", url: "/v1/workspace/plugin-token", headers: { cookie: `cira_session=${session}` },
  });
  assert.equal(pt.statusCode, 200);
  const body = pt.json() as {
    tenant_id: string; seat_id: string; user_id: string; token: string;
    install_command: string; env: Record<string, string>;
  };
  assert.equal(body.tenant_id, tenantId);
  assert.equal(body.user_id, "plug@co.com");
  assert.ok(body.token && body.env.CIRCULARA_TOKEN === body.token);
  // env block carries the exact fields loadPluginConfig() reads (task 002)
  assert.equal(body.env.CIRCULARA_BACKEND_URL, "http://localhost:8787");
  assert.equal(body.env.CIRCULARA_TENANT_ID, tenantId);
  assert.equal(body.env.CIRCULARA_SEAT_ID, body.seat_id);
  assert.equal(body.env.CIRCULARA_USER_ID, "plug@co.com");
  assert.ok(body.install_command.includes("npx -y -p @circulara/plugin circulara-mcp"));

  // the workspace token authorizes a metered call for ITS tenant...
  const ok = await app.inject({
    method: "GET", url: "/v1/meter/summary",
    headers: { authorization: `Bearer ${body.token}`, "x-tenant-id": tenantId },
  });
  assert.equal(ok.statusCode, 200);

  // ...but NOT another tenant (BL1 binding)
  const other = await control.createTenant("other-ws", { mode: "shared" });
  const cross = await app.inject({
    method: "GET", url: "/v1/meter/summary",
    headers: { authorization: `Bearer ${body.token}`, "x-tenant-id": other.tenant_id },
  });
  assert.equal(cross.statusCode, 403);
});

test("connect page: renders install command + env block + hook snippet", async () => {
  sentEmails = [];
  await app.inject({
    method: "POST", url: "/auth/email/start",
    payload: { email: "connect@co.com" }, headers: { "content-type": "application/json" },
  });
  const token = sentEmails[0].html.match(/token=([A-Za-z0-9._-]+)/)![1];
  const cb = await app.inject({ method: "GET", url: `/auth/magic/callback?token=${token}` });
  const session = cookieVal(cb.headers["set-cookie"], "cira_session")!;
  const page = await app.inject({
    method: "GET", url: "/dashboard/connect", headers: { cookie: `cira_session=${session}` },
  });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes("npx -y -p @circulara/plugin circulara-mcp")); // install cmd
  assert.ok(page.body.includes("CIRCULARA_BACKEND_URL=") && page.body.includes("CIRCULARA_SEAT_ID="));
  assert.ok(page.body.includes("circulara-hook-pre") && page.body.includes("PostToolUse")); // hook snippet
});

test("logout clears the session cookie", async () => {
  const res = await app.inject({ method: "GET", url: "/auth/logout" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, "/login?bye=1");
  const sc = res.headers["set-cookie"];
  const arr = Array.isArray(sc) ? sc : [sc];
  assert.ok(arr.some((c) => c?.includes("cira_session=") && c.includes("Max-Age=0")));
});
