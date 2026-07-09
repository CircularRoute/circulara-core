/**
 * WS5 - Observe dashboard + savings-potential report + monthly statement.
 * Server-rendered (no SPA build chain): the backend already holds the data.
 *
 * Styling: LEDGER LIGHT brand spec tokens verbatim
 * (/outputs/content/design/ledger_light_brand_spec.md) - light-first, blue =
 * action only, green = savings/carbon only, ALL figures IBM Plex Mono
 * tabular-nums, carbon ALWAYS a range with confidence label (D8), external
 * spend on its own line (AD12), over_seat_cap -> banner + watermark (m4).
 * Fonts: Inter/Plex Mono stacks with system fallbacks in dev; SELF-HOST at
 * launch per spec (no Google Fonts CDN in production).
 */
import type { MeterReport } from "../meter/report.js";
import type { SavingsPotential } from "../meter/potential.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const usd = (n: number) =>
  n >= 100
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : n >= 1
      ? `$${n.toFixed(2)}`
      : `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString("en-US");
const pct = (f: number) => `${Math.round(f * 100)}%`;

function co2Range(r: { low: number; median: number; high: number }): string {
  const g = (x: number) =>
    x >= 1_000_000
      ? `${(x / 1_000_000).toFixed(1)} t`
      : x >= 1000
        ? `${(x / 1000).toFixed(1)} kg`
        : `${x.toFixed(1)} g`;
  return `${g(r.low)} - ${g(r.high)} CO2e`;
}
function kwhRange(r: { low: number; high: number }): string {
  const f = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(3));
  return `${f(r.low)} - ${f(r.high)} kWh`;
}

/** Ledger Light tokens, from the brand spec. Never hardcode values elsewhere. */
const CSS = `
:root{
  --surface:#FFFFFF; --surface-subtle:#F6F8FB; --surface-2:#EEF1F5;
  --line:#E2E8F0; --line-strong:#CBD6E2;
  --ink:#0A2540; --ink-2:#42566B; --ink-3:#8497A9;
  --blue:#009BE8; --blue-deep:#0072B5; --blue-wash:rgba(0,155,232,.10);
  --green:#16B364; --green-deep:#0E8E4E; --navy:#00288C; --band:#071A2B;
  --focus:rgba(0,155,232,.45);
  --r-sm:8px; --r-md:12px; --r-lg:16px;
  --shadow-card:0 1px 0 rgba(10,37,64,.04),0 8px 24px -14px rgba(10,37,64,.18);
  --font-ui:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-fig:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--surface-2);color:var(--ink);font:16px/1.55 var(--font-ui)}
.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 96px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:22px;letter-spacing:-.01em}
.brand .mark{width:28px;height:28px;border-radius:50%;background:conic-gradient(var(--green) 0 33%,var(--blue) 33% 66%,var(--navy) 66% 100%)}
.crumb{color:var(--ink-3);font-size:14px}
nav.tabs{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
nav.tabs a{padding:8px 16px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:600;color:var(--blue-deep);background:var(--blue-wash)}
nav.tabs a.active{background:var(--blue);color:#fff}
.banner{background:var(--blue-wash);border:1px solid var(--line);border-radius:var(--r-md);padding:12px 16px;color:var(--blue-deep);font-size:14px;font-weight:600;margin-bottom:24px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:24px}
.label{font-size:12.5px;letter-spacing:.12em;font-weight:600;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}
.fig{font-family:var(--font-fig);font-weight:600;font-variant-numeric:tabular-nums;font-size:30px;line-height:1.1}
.fig.green{color:var(--green-deep)}
.fig small{font-size:14px;color:var(--ink-2);font-weight:400}
.conf{display:inline-block;margin-top:8px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:rgba(22,179,100,.10);color:var(--green-deep)}
.conf.blue{background:var(--blue-wash);color:var(--blue-deep)}
.section{margin:32px 0 12px;font-size:22px;font-weight:700;letter-spacing:-.01em}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow-card)}
th,td{padding:12px 16px;text-align:left;font-size:14px;border-bottom:1px solid var(--line)}
th{font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);background:var(--surface-subtle)}
td.n{font-family:var(--font-fig);font-variant-numeric:tabular-nums;text-align:right}
th.n{text-align:right}
tr:last-child td{border-bottom:none}
.note{color:var(--ink-2);font-size:14px;margin-top:12px;max-width:720px}
.watermark{border:1px dashed var(--line-strong);border-radius:var(--r-md);padding:8px 16px;color:var(--ink-3);font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:16px}
.range{font-family:var(--font-fig);font-variant-numeric:tabular-nums}
footer.band{background:var(--band);color:#fff;border-radius:var(--r-lg);padding:24px;margin-top:48px;font-size:14px}
footer.band .fig{color:#fff}
@media (max-width:640px){.wrap{padding:16px 12px 64px}.fig{font-size:24px}.card{padding:16px}th,td{padding:8px 10px}}
`;

function page(title: string, tenantQ: string, active: string, body: string, account = ""): string {
  const tabs = [
    ["dashboard", "Dashboard", `/dashboard${tenantQ}`],
    ["meter", "Meter", `/dashboard/meter${tenantQ}`],
    ["potential", "Savings potential", `/dashboard/potential${tenantQ}`],
    ["statement", "Monthly statement", `/dashboard/statement${tenantQ}`],
  ]
    .map(
      ([k, label, href]) =>
        `<a href="${href}" class="${k === active ? "active" : ""}">${label}</a>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Circulara AI</title><style>${CSS}</style></head>
<body><div class="wrap">
<header class="top">
  <div class="brand"><span class="mark" aria-hidden="true"></span>Circulara AI</div>
  <div class="crumb">${account || "Observe (free tier)"}</div>
</header>
<nav class="tabs">${tabs}</nav>
${body}
</div></body></html>`;
}

const capBanner = (r: MeterReport) =>
  r.over_seat_cap
    ? `<div class="banner">This workspace is over the free Observe seat limit (3 seats). All usage is still metered - nothing is lost. Upgrade to Team to cover every seat.</div>`
    : "";

const capWatermark = (r: MeterReport) =>
  r.over_seat_cap
    ? `<div class="watermark">Generated over the free-tier seat limit</div>`
    : "";

export function renderDashboard(r: MeterReport, tenantQ: string, account = ""): string {
  const sliceTable = (title: string, rows: MeterReport["by_user"]) => `
<h2 class="section">${title}</h2>
<table><thead><tr><th>Key</th><th class="n">Events</th><th class="n">Tokens</th><th class="n">Observed spend</th><th class="n">Avoided</th></tr></thead><tbody>
${rows
  .map(
    (s) =>
      `<tr><td>${esc(s.key)}</td><td class="n">${num(s.events)}</td><td class="n">${num(s.tokens)}</td><td class="n">${usd(s.observed_usd)}</td><td class="n" style="color:var(--green-deep)">${usd(s.avoided_usd)}</td></tr>`,
  )
  .join("")}
</tbody></table>`;

  const body = `
${capBanner(r)}
<div class="grid">
  <div class="card"><div class="label">Observed spend${r.month ? ` (${esc(r.month)})` : ""}</div>
    <div class="fig">${usd(r.observed_usd)}</div>
    <div class="conf blue">Measured - your provider usage</div></div>
  <div class="card"><div class="label">Tokens observed</div>
    <div class="fig">${num(r.tokens_observed)}</div></div>
  <div class="card"><div class="label">Avoided cost</div>
    <div class="fig green">${usd(r.avoided_usd)}</div>
    <div class="conf">Observe intervenes on nothing - this grows on paid tiers</div></div>
  <div class="card"><div class="label">External data spend</div>
    <div class="fig">${usd(r.external_spend_usd)}</div>
    <div class="conf blue">Reported separately - never netted into savings</div></div>
</div>
<div class="grid">
  <div class="card"><div class="label">Baseline energy (estimated range)</div>
    <div class="fig"><span class="range">${kwhRange(r.observed_impact.energy_kwh)}</span></div>
    <div class="conf">${esc(r.observed_impact.energy_kwh.confidence)}</div></div>
  <div class="card"><div class="label">Baseline carbon (estimated range)</div>
    <div class="fig"><span class="range">${co2Range(r.observed_impact.co2e_g)}</span></div>
    <div class="conf">${esc(r.observed_impact.co2e_g.confidence)}</div></div>
</div>
<p class="note">${esc(r.methodology_note)}</p>
${sliceTable("By user", r.by_user)}
${sliceTable("By team", r.by_team)}
${sliceTable("By module", r.by_module)}
${sliceTable("By month", r.by_month)}
`;
  return page("Observe dashboard", tenantQ, "dashboard", body, account);
}

export function renderPotential(
  r: MeterReport,
  p: SavingsPotential,
  tenantQ: string,
  account = "",
): string {
  const body = `
${capBanner(r)}
${capWatermark(r)}
<div class="card" style="margin-bottom:24px">
  <div class="label">Savings potential on your observed baseline of ${usd(p.observed_usd)}</div>
  <div class="fig green"><span class="range">${usd(p.potential_low_usd)} - ${usd(p.potential_high_usd)}</span>
  <small>(${pct(p.combined_low_pct)} - ${pct(p.combined_high_pct)})</small></div>
  <div class="conf">${esc(p.confidence)} - published-benchmark ranges, not a guarantee</div>
</div>
<h2 class="section">By technique</h2>
<table><thead><tr><th>Technique</th><th class="n">Potential range</th><th>Assumption</th></tr></thead><tbody>
${p.techniques
  .map(
    (t) =>
      `<tr><td>${esc(t.label)}</td><td class="n" style="color:var(--green-deep)">${usd(t.potential_low_usd)} - ${usd(t.potential_high_usd)}</td><td style="color:var(--ink-2)">${esc(t.assumption)}</td></tr>`,
  )
  .join("")}
</tbody></table>
<p class="note">${esc(p.typical_note)}</p>
<p class="note">${esc(p.methodology_note)}</p>
`;
  return page("Savings potential", tenantQ, "potential", body, account);
}

export function renderStatement(
  r: MeterReport,
  p: SavingsPotential,
  tenantQ: string,
  month: string,
  feeUsd = 0, // Observe = $0; paid tiers wire computeInvoice (wave 8)
  account = "",
): string {
  const breakdown = (title: string, rows: MeterReport["by_user"]) => `
<h2 class="section">${title}</h2>
<table><thead><tr><th>Key</th><th class="n">Tokens</th><th class="n">Observed</th><th class="n">Avoided</th></tr></thead><tbody>
${rows
  .map(
    (s) =>
      `<tr><td>${esc(s.key)}</td><td class="n">${num(s.tokens)}</td><td class="n">${usd(s.observed_usd)}</td><td class="n" style="color:var(--green-deep)">${usd(s.avoided_usd)}</td></tr>`,
  )
  .join("")}
</tbody></table>`;
  const body = `
${capBanner(r)}
${capWatermark(r)}
<div class="card" style="margin-bottom:24px">
  <div class="label">The bottom line - ${esc(month)}</div>
  <div class="fig">Circulara saved you <span class="fig green">${usd(r.avoided_usd)}</span> / ${num(Math.round(r.tokens_observed))} tokens observed / <span class="range">${co2Range(r.avoided_impact.co2e_g)}</span> avoided (${esc(r.avoided_impact.co2e_g.confidence)}) - fee: <span class="fig" style="font-size:22px">${usd(feeUsd)}</span></div>
</div>
<h2 class="section">Statement - ${esc(month)}</h2>
<table><tbody>
<tr><td>Observed provider spend</td><td class="n">${usd(r.observed_usd)}</td></tr>
<tr><td>Tokens observed</td><td class="n">${num(r.tokens_observed)}</td></tr>
<tr><td>Cost avoided by Circulara</td><td class="n" style="color:var(--green-deep)">${usd(r.avoided_usd)}</td></tr>
<tr><td>Baseline energy (range)</td><td class="n range">${kwhRange(r.observed_impact.energy_kwh)}</td></tr>
<tr><td>Baseline carbon (range, ${esc(r.observed_impact.co2e_g.confidence)})</td><td class="n range">${co2Range(r.observed_impact.co2e_g)}</td></tr>
<tr><td>External data purchases (reported separately)</td><td class="n">${usd(r.external_spend_usd)}</td></tr>
<tr><td>Estimated savings potential (range)</td><td class="n range" style="color:var(--green-deep)">${usd(p.potential_low_usd)} - ${usd(p.potential_high_usd)}</td></tr>
</tbody></table>
${breakdown("By user", r.by_user)}
${breakdown("By team", r.by_team)}
${breakdown("By module", r.by_module)}
<footer class="band">
  Fee this month: <span class="fig" style="font-size:22px">${usd(feeUsd)}</span>${feeUsd === 0 ? " - Observe is free forever. See your savings potential above; Team turns interventions on." : " - next to the savings above, the invoice justifies itself."}
</footer>
<p class="note">${esc(r.methodology_note)}
ESG-ready export: <a href="/dashboard/esg.json${tenantQ}">JSON</a> - <a href="/dashboard/esg.csv${tenantQ}">CSV</a></p>
`;
  return page(`Statement ${month}`, tenantQ, "statement", body, account);
}

/** Task 011 - the consolidated Observer meter: actual vs potential, four ways,
 * reconciling by construction. Ledger Light tokens; carbon always a range. */
export function renderObserverMeter(
  m: import("../meter/observer.js").ObserverMeter,
  readiness: import("../meter/observer.js").ReadinessRow[],
  tenantQ: string,
  account = "",
): string {
  const kwh = (r: { low: number; high: number }) =>
    `${(r.low).toFixed(r.low < 1 ? 3 : 1)} - ${(r.high).toFixed(r.high < 1 ? 3 : 1)} kWh`;
  const threeCol = (label: string, a: string, p: string, s: string) => `
    <tr><td>${esc(label)}</td><td class="n">${a}</td><td class="n">${p}</td><td class="n" style="color:var(--green-deep)">${s}</td></tr>`;
  const readyRows = readiness
    .map(
      (r) => `<tr><td>${esc(r.task_type)}</td><td class="n">${num(r.observations)}</td>
      <td class="n">${num(r.routable_observations)}</td>
      <td class="n" style="color:var(--green-deep)">${usd(r.projected_saving_usd)}</td>
      <td class="n">${Math.round(r.evidence * 100)}%</td>
      <td>${r.ready ? '<span class="conf">ready</span>' : '<span class="conf blue">learning</span>'}</td></tr>`,
    )
    .join("");
  const body = `
<div class="card" style="margin-bottom:24px">
  <div class="label">Total savings (${m.events} calls observed)${m.from ? ` since ${esc(m.from)}` : ""}</div>
  <div class="fig green">${usd(m.savings.usd)}</div>
  <div class="fig" style="font-size:16px;color:var(--ink-2)">${num(Math.round(m.savings.tokens))} tokens &middot; <span class="range">${kwh(m.savings.kwh)}</span> &middot; <span class="range">${co2Range(m.savings.co2e)}</span></div>
  <div class="conf blue">the four figures come from the same avoided work; carbon ${esc(m.carbon_confidence)}</div>
</div>
<h2 class="section">Actual vs potential (with Circulara)</h2>
<table><thead><tr><th></th><th class="n">Actual (as run)</th><th class="n">Potential (optimized)</th><th class="n">Savings</th></tr></thead><tbody>
${threeCol("Spend", usd(m.actual.usd), usd(m.potential.usd), usd(m.savings.usd))}
${threeCol("Tokens", num(Math.round(m.actual.tokens)), num(Math.round(m.potential.tokens)), num(Math.round(m.savings.tokens)))}
${threeCol("Energy", kwh(m.actual.kwh), kwh(m.potential.kwh), kwh(m.savings.kwh))}
${threeCol("Carbon", co2Range(m.actual.co2e), co2Range(m.potential.co2e), co2Range(m.savings.co2e))}
</tbody></table>
<p class="note">Savings from routing simple tasks to a cheaper model: ${usd(m.savings_source.routing_usd)} &middot; from detectable duplicate/cacheable calls: ${usd(m.savings_source.dedupe_usd)}. Actual - potential = savings, exactly, on every line.</p>
<h2 class="section">Routing readiness (learned from your traffic)</h2>
<table><thead><tr><th>Task type</th><th class="n">Observed</th><th class="n">Routable</th><th class="n">Projected saving</th><th class="n">Evidence</th><th>Status</th></tr></thead><tbody>
${readyRows || '<tr><td colspan="6" style="color:var(--ink-3)">no task types observed yet</td></tr>'}
</tbody></table>
<p class="note">${esc(m.cost_method)}</p>
<div class="banner" style="margin-top:24px">Counts, not content - Observer meters your AI spend without reading your prompts, outputs, or code.</div>
`;
  return page("Meter", tenantQ, "meter", body, account);
}
