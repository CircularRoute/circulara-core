/**
 * WS5 - seed a demo tenant with two months of realistic observe telemetry so
 * the dashboard/potential/statement views render end to end.
 *
 *   npx tsx scripts/seed-demo.ts          # 4 seats (shows the m4 over-cap banner)
 *   npx tsx scripts/seed-demo.ts --clean  # 3 seats (under the free cap)
 *
 * Writes to ./data (the dev server's on-disk store). Prints the dashboard URL.
 * Uses the APPROVED pricing snapshot so figures are real prices.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { ControlPlane } from "../src/db/tenancy.js";
import { PricingRegistry } from "../src/registry/pricing.js";
import { recordCapture } from "../src/pipeline/normalize.js";
import { provisionSeat } from "../src/auth/auth.js";

const clean = process.argv.includes("--clean");
const cfg = loadConfig();
const control = new ControlPlane(cfg.dataDir);
await control.init();
const registry = new PricingRegistry(join(process.cwd(), "registry-data"));
const pricing = registry.getApproved();
if (!pricing) {
  console.error("no approved pricing snapshot - run: npm run registry -- update && approve");
  process.exit(1);
}

const tenant = await control.createTenant(`demo-${randomUUID().slice(0, 8)}`);
const ctx = await control.contextFor(tenant.tenant_id);

const people = [
  { user: "sso|maya", team: "platform" },
  { user: "sso|jonas", team: "platform" },
  { user: "sso|priya", team: "data" },
  ...(clean ? [] : [{ user: "sso|arthur", team: "data" }]),
];
const seats: { seat_id: string; user: string; team: string }[] = [];
for (const p of people) {
  const s = await provisionSeat(
    ctx,
    { identity_type: "human", user_id: p.user, team_id: p.team },
    "admin",
  );
  seats.push({ seat_id: s.seat_id, ...p });
}

// realistic-ish model mix from the approved snapshot (fall back if renamed)
const MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-4-8",
].filter((m) => pricing.models[m] || pricing.models[`anthropic/${m}`]);
if (MODELS.length === 0) MODELS.push(Object.keys(pricing.models)[0]);

// deterministic pseudo-random so reseeds are comparable
let x = 42;
const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31), x / 2 ** 31);

const months = ["2026-06", "2026-07"];
let events = 0;
for (const month of months) {
  for (const seat of seats) {
    const sessions = 20 + Math.floor(rnd() * 20);
    for (let i = 0; i < sessions; i++) {
      const model = MODELS[Math.floor(rnd() * MODELS.length)];
      const day = String(1 + Math.floor(rnd() * 27)).padStart(2, "0");
      const inTok = 2_000 + Math.floor(rnd() * 60_000);
      const outTok = 300 + Math.floor(rnd() * 6_000);
      await recordCapture(
        ctx,
        { getPricing: () => pricing },
        {
          capturePath: rnd() > 0.5 ? "hook" : "gateway",
          host: rnd() > 0.3 ? "claude_code" : "cursor",
          seat: {
            seat_id: seat.seat_id,
            identity_type: "human",
            user_id: seat.user,
            team_id: seat.team,
            agent_identity: null,
          },
          model,
          inputTokens: inTok,
          outputTokens: outTok,
          ts: `${month}-${day}T1${Math.floor(rnd() * 9)}:0${Math.floor(rnd() * 9)}:00Z`,
        },
      );
      events++;
    }
  }
}

console.log(`seeded tenant ${tenant.tenant_id} (${tenant.name})`);
console.log(`seats: ${seats.length}${clean ? " (under cap)" : " (over free cap -> banner)"} | events: ${events}`);
console.log(
  `dashboard: http://127.0.0.1:${cfg.port}/dashboard?tenant=${tenant.tenant_id}&token=dev-seat-token`,
);
await control.close();
