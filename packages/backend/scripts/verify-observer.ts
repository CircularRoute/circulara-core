import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlPlane } from "../src/db/tenancy.js";
import { ingestEvent } from "../src/meter/meter.js";
import { observerMeter, routingReadiness } from "../src/meter/observer.js";
import { renderObserverMeter } from "../src/dashboard/render.js";
import type { PricingSnapshot } from "../src/registry/pricing.js";

const PRICING: PricingSnapshot = { pricing_version: "v", source: "x", fetched_at: "t", models: {
  "claude-opus-4-8": { input_cost_per_token: 15e-6, output_cost_per_token: 75e-6, provider: "anthropic" },
  "claude-sonnet-5": { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, provider: "anthropic" },
  "claude-haiku-4-5-20251001": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, provider: "anthropic" },
}};

const tmp = mkdtempSync(join(tmpdir(), "obs-verify-"));
const control = new ControlPlane(tmp, true); await control.init();
const t = await control.createTenant("verify"); const ctx = await control.contextFor(t.tenant_id);
let x = 7; const rnd = () => ((x=(x*1103515245+12345)%2**31), x/2**31);
const types = [
  { type:"chat", model:"claude-opus-4-8", routable:true, route:"claude-haiku-4-5-20251001" },
  { type:"code-review", model:"claude-sonnet-5", routable:true, route:"claude-haiku-4-5-20251001" },
  { type:"reasoning", model:"claude-opus-4-8", routable:false, route:null },
];
for (let i=0;i<120;i++){
  const tt = types[Math.floor(rnd()*types.length)];
  const inTok=2000+Math.floor(rnd()*40000), outTok=300+Math.floor(rnd()*4000);
  const seat=randomUUID(); await ctx.db.query("INSERT INTO seats (seat_id,identity_type,user_id) VALUES ($1,'human',$2)",[seat,["sso|maya","sso|jonas","sso|priya"][Math.floor(rnd()*3)]]);
  await ingestEvent(ctx, { event_id:randomUUID(), call_id:randomUUID(), schema_version:"1.0", ts:`2026-07-0${1+Math.floor(rnd()*7)}T10:00:00Z`, seat_id:seat, identity_type:"human", user_id:["sso|maya","sso|jonas","sso|priya"][Math.floor(rnd()*3)], team_id:null, agent_identity:null, host:"claude_code", capture_path:"hook", session_id:null, module:"meter", intervention_type:"observe", model_requested:tt.model, model_used:tt.model, tokens:{input_counterfactual:inTok,output_counterfactual:outTok,input_actual:inTok,output_actual:outTok}, cost:{counterfactual_usd:0,actual_usd:0,avoided_usd:0,currency:"USD",pricing_source:"provider_registry",pricing_version:"seed"}, energy:{avoided_kwh:0,method:"EcoLogits-class",confidence:"Estimated"}, carbon:{avoided_co2e_g:0,grid_intensity_g_per_kwh:400,pue:1.2,region:null,method:"EcoLogits-class",confidence:"Estimated"}, methodology_version:"esg-v1", observer:{task_type:tt.type,latency_ms:900,request_fp: rnd()>0.85?"d".repeat(64):null,cache_read_tokens:Math.floor(rnd()*500),routable:tt.routable,route_to_model:tt.route} });
}
const m = await observerMeter(ctx, PRICING, {});
const rr = await routingReadiness(ctx, PRICING, {});
const near = (a:number,b:number)=>Math.abs(a-b)<1e-9;
console.log("events", m.events);
console.log("USD    a=%s p=%s s=%s reconciles=%s", m.actual.usd.toFixed(4), m.potential.usd.toFixed(4), m.savings.usd.toFixed(4), near(m.savings.usd, m.actual.usd-m.potential.usd));
console.log("TOKENS a=%d p=%d s=%d reconciles=%s", Math.round(m.actual.tokens), Math.round(m.potential.tokens), Math.round(m.savings.tokens), near(m.savings.tokens, m.actual.tokens-m.potential.tokens));
console.log("kWh    s.median=%s reconciles=%s", m.savings.kwh.median.toFixed(4), near(m.savings.kwh.median, m.actual.kwh.median-m.potential.kwh.median));
console.log("CO2e   s.median=%s reconciles=%s", m.savings.co2e.median.toFixed(1), near(m.savings.co2e.median, m.actual.co2e.median-m.potential.co2e.median));
console.log("source", JSON.stringify(m.savings_source));
console.log("readiness types:", rr.types.map(x=>`${x.task_type}:${x.routable_observations}/${x.threshold} ready=${x.ready}`).join(" | "));
const html = renderObserverMeter(m, rr.types, `?tenant=${t.tenant_id}&token=dev-seat-token`);
writeFileSync("/tmp/observer-meter.html", html);
const checks = ["Total savings","Actual (as run)","Potential (optimized)","Routing readiness","Counts, not content","IBM Plex Mono"];
console.log("render checks:", checks.map(c=>`${c.slice(0,14)}=${html.includes(c)}`).join(" "));
await control.close();
