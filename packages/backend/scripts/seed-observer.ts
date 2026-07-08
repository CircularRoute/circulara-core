import { loadConfig, loadSecret } from "../src/config.js";
import { ControlPlane } from "../src/db/tenancy.js";
import { ingestEvent } from "../src/meter/meter.js";
import { randomUUID } from "node:crypto";
const cfg = loadConfig();
const control = new ControlPlane(cfg.dataDir); await control.init();
const t = await control.createTenant("demo-observer");
const ctx = await control.contextFor(t.tenant_id);
const users = ["sso|maya","sso|jonas","sso|priya"];
const types = [
  { type: "chat", model: "claude-opus-4-8", routable: true, route: "claude-haiku-4-5-20251001" },
  { type: "code-review", model: "claude-sonnet-5", routable: true, route: "claude-haiku-4-5-20251001" },
  { type: "reasoning", model: "claude-opus-4-8", routable: false, route: null },
];
let x = 7; const rnd = () => ((x = (x*1103515245+12345)%2**31), x/2**31);
let n = 0;
for (let i=0;i<120;i++){
  const u = users[Math.floor(rnd()*users.length)];
  const tt = types[Math.floor(rnd()*types.length)];
  const inTok = 2000 + Math.floor(rnd()*40000), outTok = 300 + Math.floor(rnd()*4000);
  const dup = rnd() > 0.85 ? "d".repeat(64) : null; // ~15% duplicates
  await ingestEvent(ctx, {
    event_id: randomUUID(), call_id: randomUUID(), schema_version: "1.0",
    ts: `2026-07-0${1+Math.floor(rnd()*7)}T10:00:00Z`, seat_id: (await (async()=>{ const s=randomUUID(); await ctx.db.query("INSERT INTO seats (seat_id,identity_type,user_id) VALUES ($1,'human',$2)",[s,u]); return s;})()),
    identity_type: "human", user_id: u, team_id: null, agent_identity: null,
    host: "claude_code", capture_path: "hook", session_id: null, module: "meter", intervention_type: "observe",
    model_requested: tt.model, model_used: tt.model,
    tokens: { input_counterfactual: inTok, output_counterfactual: outTok, input_actual: inTok, output_actual: outTok },
    cost: { counterfactual_usd: 0, actual_usd: 0, avoided_usd: 0, currency: "USD", pricing_source: "provider_registry", pricing_version: "seed" },
    energy: { avoided_kwh: 0, method: "EcoLogits-class", confidence: "Estimated" },
    carbon: { avoided_co2e_g: 0, grid_intensity_g_per_kwh: 400, pue: 1.2, region: null, method: "EcoLogits-class", confidence: "Estimated" },
    methodology_version: "esg-v1",
    observer: { task_type: tt.type, latency_ms: 800+Math.floor(rnd()*4000), request_fp: dup, cache_read_tokens: Math.floor(rnd()*500), routable: tt.routable, route_to_model: tt.route },
  });
  n++;
}
console.log(`seeded ${n} events; dashboard: http://127.0.0.1:8798/dashboard/meter?tenant=${t.tenant_id}&token=dev-seat-token`);
await control.close();
