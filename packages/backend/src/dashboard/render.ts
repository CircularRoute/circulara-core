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
    : `$${n.toFixed(2)}`;
const num = (n: number) => n.toLocaleString("en-US");
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** A hover/focus info affordance with an explainer tooltip (CSS-driven). */
const infoTip = (text: string) =>
  `<span class="info" tabindex="0" role="button" aria-label="More information">i</span><div class="tip">${esc(text)}</div>`;

/** Single-value formatters (median), for the "show one number, not a range" views. */
const kwhOne = (x: number): string => `${x >= 1 ? x.toFixed(1) : x.toFixed(3)} kWh`;
const co2One = (x: number): string =>
  x >= 1_000_000
    ? `${(x / 1_000_000).toFixed(1)} t CO2e`
    : x >= 1000
      ? `${(x / 1000).toFixed(1)} kg CO2e`
      : `${x.toFixed(1)} g CO2e`;

/** Ledger Light tokens, unified with the circulara.ai marketing site design
 * system (same Inter + IBM Plex Mono, same palette). Self-hosted fonts served
 * from /assets so the dashboard reads as the same product as the site. */
const CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("/assets/inter-latin.woff2") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:400;font-display:swap;src:url("/assets/plexmono-400.woff2") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:500;font-display:swap;src:url("/assets/plexmono-500.woff2") format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;font-display:swap;src:url("/assets/plexmono-600.woff2") format("woff2")}
:root{
  --surface:#FFFFFF; --surface-subtle:#F6F8FB; --surface-2:#EEF1F5;
  --line:#E2E8F0; --line-strong:#CBD6E2;
  --ink:#0A2540; --ink-2:#42566B; --ink-3:#8497A9;
  --blue:#009AE4; --blue-deep:#0072B5; --blue-wash:rgba(0,154,228,.10);
  --green:#16B364; --green-deep:#0E8E4E; --navy:#00288C; --band:#071A2B;
  --focus:rgba(0,154,228,.45);
  --r-sm:8px; --r-md:12px; --r-lg:16px;
  --shadow-card:0 1px 0 rgba(10,37,64,.04),0 8px 24px -14px rgba(10,37,64,.18);
  --shadow-hover:0 2px 0 rgba(10,37,64,.04),0 18px 40px -18px rgba(10,37,64,.28);
  --font-ui:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-fig:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--surface-2);color:var(--ink);font:16px/1.55 var(--font-ui);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 96px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.brand{display:flex;align-items:center}
.brand img.logo{height:30px;width:auto;display:block}
.crumb{color:var(--ink-3);font-size:14px}
nav.tabs{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap}
nav.tabs a{padding:8px 16px;border-radius:999px;text-decoration:none;font-size:14px;font-weight:600;color:var(--blue-deep);background:var(--blue-wash)}
nav.tabs a.active{background:var(--blue);color:#fff}
nav.tabs .tab-locked{position:relative;padding:8px 14px;border-radius:999px;font-size:14px;font-weight:600;color:var(--ink-3);background:transparent;border:1px dashed var(--line-strong);cursor:not-allowed;display:inline-flex;align-items:center;gap:6px}
nav.tabs .tab-locked svg{width:12px;height:12px}
nav.tabs .tab-locked::after{content:"Upgrade to unlock";position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%) translateY(-4px);background:var(--band);color:#fff;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;padding:6px 10px;border-radius:8px;white-space:nowrap;opacity:0;visibility:hidden;transition:opacity .15s ease,transform .15s ease;z-index:30;pointer-events:none;box-shadow:0 8px 20px -8px rgba(10,37,64,.4)}
nav.tabs .tab-locked:hover::after,nav.tabs .tab-locked:focus::after{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}
.obs-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.obs-title{font-size:26px;font-weight:800;letter-spacing:-.02em}
.obs-sub{color:var(--ink-2);font-size:14.5px;margin-top:4px}
.obs-actions{display:flex;gap:10px;flex-wrap:wrap}
.obs-hint{color:var(--ink-2);font-size:13.5px;margin-top:20px;background:var(--blue-wash);padding:12px 16px;border-radius:var(--r-md)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 20px;border-radius:10px;font:600 14.5px var(--font-ui);text-decoration:none;cursor:pointer;border:1px solid transparent;transition:background .15s ease,border-color .15s ease}
.btn.primary{background:var(--blue);color:#fff}
.btn.primary:hover{background:var(--blue-deep)}
.btn.ghost{background:var(--surface);color:var(--blue-deep);border-color:var(--line-strong)}
.btn.ghost:hover{border-color:var(--blue)}
.backlink{display:inline-block;margin-bottom:16px;color:var(--blue-deep);font-size:14px;font-weight:600;text-decoration:none}
.upsell{display:flex;align-items:center;justify-content:space-between;gap:16px 24px;flex-wrap:wrap;background:linear-gradient(135deg,var(--green-deep),#15A85C);color:#fff;border-radius:var(--r-lg);padding:22px 26px;margin:8px 0 28px}
.upsell-text{font-size:17px;font-weight:700;letter-spacing:-.01em}
.upsell .btn.primary{background:#fff;color:var(--green-deep)}
.upsell .btn.primary:hover{background:#EAF6EF}
.modal-ov{position:fixed;inset:0;background:rgba(10,37,64,.55);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100}
.modal-ov[hidden]{display:none}
.modal{background:var(--surface);border-radius:var(--r-lg);box-shadow:0 24px 64px -20px rgba(10,37,64,.5);padding:32px;max-width:440px;width:100%;position:relative}
.modal-x{position:absolute;top:10px;right:14px;background:none;border:0;font-size:26px;line-height:1;color:var(--ink-3);cursor:pointer}
.modal-x:hover{color:var(--ink)}
.modal.wide{max-width:520px}
.modal-h{font-size:22px;font-weight:800;letter-spacing:-.01em;margin-bottom:10px}
.modal-p{color:var(--ink-2);font-size:15px;line-height:1.55;margin-bottom:22px}
.modal-eyebrow{font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--blue-deep);margin-bottom:6px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.fld{display:flex;flex-direction:column;gap:6px;font-size:13.5px}
.fld.full{grid-column:1 / -1}
.fld>span{font-weight:600;color:var(--ink)}
.fld input,.fld textarea{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:14px var(--font-ui);color:var(--ink);background:#fff;width:100%}
.fld textarea{resize:vertical}
.fld input:focus,.fld textarea:focus{outline:2px solid var(--focus);border-color:var(--blue)}
.form-err{color:#B42318;font-size:13px;margin-top:12px}
.done-check{width:48px;height:48px;border-radius:50%;background:rgba(22,179,100,.15);color:var(--green-deep);font-weight:700;font-size:22px;display:flex;align-items:center;justify-content:center;margin:0 auto}
@media(max-width:520px){.form-grid{grid-template-columns:1fr}}
.banner{background:var(--blue-wash);border:1px solid var(--line);border-radius:var(--r-md);padding:12px 16px;color:var(--blue-deep);font-size:14px;font-weight:600;margin-bottom:24px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:24px;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
.card:hover{transform:translateY(-3px);box-shadow:var(--shadow-hover);border-color:var(--line-strong)}
.card.tipcard{position:relative}
.info{position:absolute;top:16px;right:16px;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--ink-3);color:var(--ink-3);font:600 11px/1 var(--font-ui);display:flex;align-items:center;justify-content:center;cursor:help;font-style:italic}
.info:hover,.info:focus{border-color:var(--blue);color:var(--blue);outline:none}
.tip{position:absolute;top:40px;right:12px;width:250px;max-width:78vw;background:var(--band);color:#E6EDF3;font:400 12.5px/1.5 var(--font-ui);letter-spacing:0;text-transform:none;padding:11px 13px;border-radius:10px;box-shadow:0 12px 32px -10px rgba(10,37,64,.45);opacity:0;visibility:hidden;transform:translateY(-4px);transition:opacity .15s ease,transform .15s ease;z-index:20}
.tip::after{content:"";position:absolute;top:-6px;right:16px;width:12px;height:12px;background:var(--band);transform:rotate(45deg)}
.info:hover + .tip,.info:focus + .tip,.tip:hover{opacity:1;visibility:visible;transform:translateY(0)}
.estpill{display:inline-block;margin-top:8px;padding:2px 10px;border-radius:999px;font-size:12.5px;font-weight:600;background:var(--blue-wash);color:var(--blue-deep)}
.label{font-size:12.5px;letter-spacing:.12em;font-weight:700;text-transform:uppercase;color:var(--ink);margin-bottom:8px}
.label.navy{color:var(--navy)}
.label.grn{color:var(--green-deep)}
.subtext{display:block;margin:0 0 12px;font-size:12px;font-weight:400;color:var(--ink-3);line-height:1.45;max-width:280px}
.fig{font-family:var(--font-fig);font-weight:600;font-variant-numeric:tabular-nums;font-size:30px;line-height:1.1}
.fig.green{color:var(--green-deep)}
.fig.navy{color:var(--navy)}
.savedrow{display:flex;flex-wrap:wrap;gap:16px 40px;align-items:flex-end}
.savedstat .fig{font-size:34px}
.savedstat .subtext{margin:4px 0 0;color:var(--ink-3);text-transform:none;letter-spacing:0}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:4px}
.tablewrap table{margin-bottom:0}
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
@media (max-width:640px){.wrap{padding:16px 12px 64px}.fig{font-size:24px}.savedstat .fig{font-size:26px}.card{padding:16px}th,td{padding:8px 10px}.brand img.logo{height:26px}nav.tabs{gap:6px}nav.tabs a{padding:7px 12px;font-size:13px}}
`;

// Free-tier Observer nav: only the Observer Dashboard is live; the richer views
// (Meter, Savings potential, Monthly statement) are shown LOCKED - visible so the
// user knows they exist, disabled until they upgrade. Connect plugin is a button
// on the dashboard, not a tab.
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

function page(title: string, tenantQ: string, active: string, body: string, account = ""): string {
  const tabs =
    `<a href="/dashboard${tenantQ}" class="${active === "dashboard" ? "active" : ""}">Observer Dashboard</a>` +
    ["Meter", "Savings potential", "Monthly statement"]
      .map((l) => `<span class="tab-locked" tabindex="0" title="Upgrade to unlock">${l} ${LOCK_SVG}</span>`)
      .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Circulara AI</title>
<link rel="manifest" href="/assets/manifest.webmanifest">
<meta name="theme-color" content="#EEF1F5">
<link rel="icon" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Observer">
<style>${CSS}</style></head>
<body><div class="wrap">
<header class="top">
  <a class="brand" href="/dashboard${tenantQ}"><img class="logo" src="/assets/circulara_logo.svg" alt="Circulara AI"></a>
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

export function renderDashboard(
  r: MeterReport,
  p: SavingsPotential,
  tenantQ: string,
  account = "",
  email = "",
): string {
  // Observe breakdowns: by model / provider / month (no by-user/team - Observe
  // has no team structure). Avoided is always $0 on free Observe, so it is omitted.
  const bd = (title: string, col: string, rows: MeterReport["by_user"]) => `
<h2 class="section">${title}</h2>
<div class="tablewrap"><table><thead><tr><th>${col}</th><th class="n">Calls</th><th class="n">Tokens</th><th class="n">Spend</th></tr></thead><tbody>
${rows.length
  ? rows
      .map(
        (s) =>
          `<tr><td>${esc(s.key)}</td><td class="n">${num(s.events)}</td><td class="n">${num(s.tokens)}</td><td class="n">${usd(s.observed_usd)}</td></tr>`,
      )
      .join("")
  : `<tr><td colspan="4" style="color:var(--ink-3)">No data yet - connect the plugin to start metering.</td></tr>`}
</tbody></table></div>`;
  // Potential impact = the same estimated optimization fraction (all techniques:
  // reduce + recycle + reuse) applied to the observed footprint. Non-zero as soon
  // as there is observed usage - it is what you COULD avoid on a paid tier.
  const midPct = (p.combined_low_pct + p.combined_high_pct) / 2;
  const potEnergyKwh = r.observed_impact.energy_kwh.median * midPct;
  const potCo2g = r.observed_impact.co2e_g.median * midPct;
  const body = `
<div class="obs-head">
  <div>
    <h1 class="obs-title">Observer Dashboard</h1>
    <p class="obs-sub">Your live AI savings meter - free forever. Connect the plugin and watch it fill in.</p>
  </div>
  <div class="obs-actions">
    <a class="btn primary" href="/dashboard/connect${tenantQ}">Connect plugin</a>
    <button class="btn ghost" id="installBtn">Install app</button>
  </div>
</div>
${capBanner(r)}
<div class="grid">
  <div class="card"><div class="label navy">Tokens</div>
    <div class="subtext">Total token usage observed</div>
    <div class="fig navy">${num(r.tokens_observed)}</div></div>
  <div class="card"><div class="label navy">Spend</div>
    <div class="subtext">Total cost of AI calls</div>
    <div class="fig navy">${usd(r.observed_usd)}</div></div>
  <div class="card tipcard"><div class="label grn">Potential Savings</div>
    <div class="subtext">What you could save with Circulara's paid tier</div>
    <div class="fig green">${usd((p.potential_low_usd + p.potential_high_usd) / 2)}</div>
    ${infoTip("What you could save on your observed spend on a paid tier. " + (p.basis === "blended" ? "Blended from your OWN traffic where we can measure it (routing to cheaper models, duplicate/cacheable calls), plus published benchmarks for compression, prompt caching and reuse" : "Estimated from published benchmarks across routing, caching, compression and reuse") + " - roughly " + usd(p.potential_low_usd) + " to " + usd(p.potential_high_usd) + ". An estimate, not a guarantee.")}</div>
</div>
<div class="grid">
  <div class="card tipcard"><div class="label grn">Potential Energy Savings</div>
    <div class="fig green">${kwhOne(potEnergyKwh)}</div>
    <div class="conf">Estimated</div>
    ${infoTip("Estimated electricity you could avoid on a paid tier - the same optimization fraction behind your Potential Savings (routing to smaller models, caching, compression, reuse), applied to the energy footprint of your observed usage. An estimate, not a guarantee.")}</div>
  <div class="card tipcard"><div class="label grn">Potential Carbon Savings</div>
    <div class="fig green">${co2One(potCo2g)}</div>
    <div class="conf">Estimated</div>
    ${infoTip("Estimated CO2e you could avoid on a paid tier, from the same optimizations applied to your observed footprint. Carbon is always an estimate (grid + datacenter assumptions disclosed), never a single guaranteed number.")}</div>
</div>
<div class="upsell">
  <div class="upsell-text">Upgrade to start saving with Circulara AI</div>
  <button class="btn primary" type="button" onclick="ciraUpgrade()">Upgrade</button>
</div>
${bd("By model", "Model", r.by_model)}
${bd("By provider", "Provider", r.by_provider)}
${bd("By month", "Month", r.by_month)}
<p class="obs-hint" id="installHint" hidden>Install Observer for one-tap access to your savings: on iPhone/iPad tap the Share button, then "Add to Home Screen". On desktop Chrome or Edge, use the install icon in the address bar.</p>
<div class="modal-ov" id="upgradeModal" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="upTitle">
    <button class="modal-x" type="button" onclick="ciraCloseUpgrade()" aria-label="Close">&times;</button>
    <h2 class="modal-h" id="upTitle">Ready to start saving?</h2>
    <p class="modal-p">Upgrading switches on Circulara's optimization engines, so the savings you see here become real. Tell us a bit about your setup and we'll get you started.</p>
    <button class="btn primary" type="button" onclick="ciraContact()">Contact Circulara AI</button>
  </div>
</div>
<div class="modal-ov" id="contactModal" hidden>
  <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="ctTitle">
    <button class="modal-x" type="button" onclick="ciraCloseContact()" aria-label="Close">&times;</button>
    <div id="contactForm">
      <p class="modal-eyebrow">Contact us</p>
      <h2 class="modal-h" id="ctTitle">Let's talk.</h2>
      <p class="modal-p" style="margin-bottom:18px">Tell us about your AI fleet and we'll set up your paid workspace. We usually reply within one business day.</p>
      <form onsubmit="return ciraSubmitContact(event)">
        <div class="form-grid">
          <label class="fld"><span>First name *</span><input name="firstName" autocomplete="given-name" required></label>
          <label class="fld"><span>Last name</span><input name="lastName" autocomplete="family-name"></label>
          <label class="fld"><span>Email *</span><input name="email" type="email" autocomplete="email" value="${esc(email)}" required></label>
          <label class="fld"><span>Phone</span><input name="phone" type="tel" autocomplete="tel"></label>
          <label class="fld full"><span>Your message *</span><textarea name="message" rows="4" required></textarea></label>
        </div>
        <p class="form-err" id="ctErr" hidden></p>
        <button class="btn primary" type="submit" id="ctSubmit" style="width:100%;margin-top:16px">Submit</button>
      </form>
    </div>
    <div id="contactDone" hidden style="text-align:center;padding:12px 0">
      <div class="done-check">&#10003;</div>
      <h2 class="modal-h" style="margin-top:14px">Message sent.</h2>
      <p class="modal-p" style="margin-bottom:0">The Circulara team will get back to you shortly.</p>
    </div>
  </div>
</div>
<script>
function ciraUpgrade(){var m=document.getElementById('upgradeModal');if(m)m.hidden=false;}
function ciraCloseUpgrade(){var m=document.getElementById('upgradeModal');if(m)m.hidden=true;}
function ciraContact(){ciraCloseUpgrade();var m=document.getElementById('contactModal');if(m)m.hidden=false;}
function ciraCloseContact(){var m=document.getElementById('contactModal');if(m)m.hidden=true;}
function ciraSubmitContact(e){
  e.preventDefault();
  var f=e.target, err=document.getElementById('ctErr'), btn=document.getElementById('ctSubmit');
  var g=function(n){var el=f.elements[n];return el?el.value.trim():'';};
  var email=g('email');
  if(!g('firstName')||!g('message')||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)){err.textContent='Please add your name, a valid email, and a message.';err.hidden=false;return false;}
  err.hidden=true; btn.disabled=true; btn.textContent='Sending...';
  fetch('/v1/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({firstName:g('firstName'),lastName:g('lastName'),email:email,phone:g('phone'),message:g('message')})})
    .then(function(r){if(!r.ok)throw 0;document.getElementById('contactForm').hidden=true;document.getElementById('contactDone').hidden=false;})
    .catch(function(){err.textContent='Something went wrong. Please try again, or email hello@circularroute.com directly.';err.hidden=false;btn.disabled=false;btn.textContent='Submit';});
  return false;
}
(function(){
  ['upgradeModal','contactModal'].forEach(function(id){var ov=document.getElementById(id);if(ov)ov.addEventListener('click',function(e){if(e.target===ov)ov.hidden=true;});});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){ciraCloseUpgrade();ciraCloseContact();}});
  var deferred=null, ib=document.getElementById('installBtn'), hint=document.getElementById('installHint');
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;});
  var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  if(standalone&&ib){ib.style.display='none';}
  else if(ib)ib.addEventListener('click',function(){
    if(deferred){deferred.prompt();deferred.userChoice.then(function(){deferred=null;});}
    else if(hint){hint.hidden=false;hint.scrollIntoView({behavior:'smooth',block:'nearest'});}
  });
  var isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  if(isIOS&&hint&&!standalone)hint.hidden=false;
})();
</script>
`;
  return page("Observer Dashboard", tenantQ, "dashboard", body, account);
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
  <div class="label grn">Savings potential on your observed baseline of ${usd(p.observed_usd)}</div>
  <div class="fig green">${usd((p.potential_low_usd + p.potential_high_usd) / 2)} <small>(${pct((p.combined_low_pct + p.combined_high_pct) / 2)})</small></div>
  <div class="conf">${esc(p.confidence)} - an estimate, not a guarantee</div>
</div>
<p class="note">${esc(p.typical_note)}</p>
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
<div class="tablewrap"><table><thead><tr><th>Key</th><th class="n">Tokens</th><th class="n">Observed</th><th class="n">Avoided</th></tr></thead><tbody>
${rows
  .map(
    (s) =>
      `<tr><td>${esc(s.key)}</td><td class="n">${num(s.tokens)}</td><td class="n">${usd(s.observed_usd)}</td><td class="n" style="color:var(--green-deep)">${usd(s.avoided_usd)}</td></tr>`,
  )
  .join("")}
</tbody></table></div>`;
  const body = `
${capBanner(r)}
${capWatermark(r)}
<div class="card" style="margin-bottom:24px">
  <div class="label grn">Circulara saved you${month ? ` - ${esc(month)}` : ""}</div>
  <div class="savedrow">
    <div class="savedstat"><div class="fig green">${usd(r.avoided_usd)}</div><div class="subtext">saved</div></div>
    <div class="savedstat"><div class="fig navy">${num(Math.round(r.tokens_observed))}</div><div class="subtext">tokens observed</div></div>
    <div class="savedstat"><div class="fig green">${co2One(r.avoided_impact.co2e_g.median)}</div><div class="subtext">CO2e avoided</div></div>
  </div>
</div>
<h2 class="section">Statement - ${esc(month)}</h2>
<div class="tablewrap"><table><tbody>
<tr><td>Observed provider spend</td><td class="n">${usd(r.observed_usd)}</td></tr>
<tr><td>Tokens observed</td><td class="n">${num(r.tokens_observed)}</td></tr>
<tr><td>Cost avoided by Circulara</td><td class="n" style="color:var(--green-deep)">${usd(r.avoided_usd)}</td></tr>
<tr><td>Baseline energy</td><td class="n">${kwhOne(r.observed_impact.energy_kwh.median)}</td></tr>
<tr><td>Baseline carbon (${esc(r.observed_impact.co2e_g.confidence)})</td><td class="n">${co2One(r.observed_impact.co2e_g.median)}</td></tr>
<tr><td>External data purchases (reported separately)</td><td class="n">${usd(r.external_spend_usd)}</td></tr>
<tr><td>Estimated savings potential</td><td class="n" style="color:var(--green-deep)">${usd((p.potential_low_usd + p.potential_high_usd) / 2)}</td></tr>
</tbody></table></div>
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
<div class="card tipcard" style="margin-bottom:24px">
  <div class="label grn">Detected savings (${m.events} calls observed)${m.from ? ` since ${esc(m.from)}` : ""}</div>
  <div class="fig green">${usd(m.savings.usd)}</div>
  <div class="fig" style="font-size:16px;color:var(--ink-2)">${num(Math.round(m.savings.tokens))} tokens &middot; ${kwhOne(m.savings.kwh.median)} &middot; ${co2One(m.savings.co2e.median)}</div>
  ${infoTip("This is not your total savings - only what Observe can prove from your traffic alone: routing simple calls to a cheaper model and detectable duplicate calls. Compression, response and tool-call caching, and the reuse library add more once enabled. See the Savings potential tab for the full estimate.")}
</div>
<h2 class="section">Actual vs potential (with Circulara)</h2>
<div class="tablewrap"><table><thead><tr><th></th><th class="n">Actual (as run)</th><th class="n">Potential (optimized)</th><th class="n">Savings</th></tr></thead><tbody>
${threeCol("Spend", usd(m.actual.usd), usd(m.potential.usd), usd(m.savings.usd))}
${threeCol("Tokens", num(Math.round(m.actual.tokens)), num(Math.round(m.potential.tokens)), num(Math.round(m.savings.tokens)))}
${threeCol("Energy", kwhOne(m.actual.kwh.median), kwhOne(m.potential.kwh.median), kwhOne(m.savings.kwh.median))}
${threeCol("Carbon", co2One(m.actual.co2e.median), co2One(m.potential.co2e.median), co2One(m.savings.co2e.median))}
</tbody></table></div>
<h2 class="section">Routing readiness (learned from your traffic)</h2>
<div class="tablewrap"><table><thead><tr><th>Task type</th><th class="n">Observed</th><th class="n">Routable</th><th class="n">Projected saving</th><th class="n">Evidence</th><th>Status</th></tr></thead><tbody>
${readyRows || '<tr><td colspan="6" style="color:var(--ink-3)">no task types observed yet</td></tr>'}
</tbody></table></div>
<p class="note">${esc(m.cost_method)}</p>
<div class="banner" style="margin-top:24px">Counts, not content - Observer meters your AI spend without reading your prompts, outputs, or code.</div>
`;
  return page("Meter", tenantQ, "meter", body, account);
}

/** builder.20260708.002 - the "Connect plugin" onboarding page: one install
 * command + a copy-paste CIRCULARA_* env block + the Claude Code hook snippet. */
export function renderConnect(
  data: {
    installCommand: string;
    env: Record<string, string>;
    hookSettings: unknown;
  },
  tenantQ: string,
  account = "",
): string {
  const envText = Object.entries(data.env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const settingsText = JSON.stringify(data.hookSettings, null, 2);
  // The whole setup as ONE paste: install + connect + all keys (incl. token).
  const oneLiner =
    "claude mcp add circulara " +
    Object.entries(data.env)
      .map(([k, v]) => `--env ${k}=${v}`)
      .join(" ") +
    " -- npx -y -p @circulara/plugin circulara-mcp";
  const block = (id: string, tag: string, text: string) => `
<div class="cbx">
  <div class="cbx-head"><span>${esc(tag)}</span>
    <button class="cbx-copy" type="button" onclick="ciraCopy('${id}',this)">Copy</button></div>
  <pre id="${id}" class="cbx-pre">${esc(text)}</pre>
</div>`;
  const body = `
<style>
.step{display:flex;align-items:center;gap:14px;margin:28px 0 6px}
.step .n{flex:0 0 auto;width:30px;height:30px;border-radius:50%;background:var(--blue);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:15px}
.step .t{font-size:19px;font-weight:700;letter-spacing:-.01em}
.stepnote{color:var(--ink-2);font-size:14.5px;margin:0 0 14px 44px;max-width:640px}
.cbx{border:1px solid var(--band);border-radius:var(--r-md);overflow:hidden;margin:0 0 8px 44px;background:var(--band)}
.cbx-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px 8px 14px;color:#9fb3c8;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:600}
.cbx-copy{background:var(--blue);color:#fff;border:0;border-radius:7px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:var(--font-ui)}
.cbx-copy:hover{background:var(--blue-deep)}
.cbx-pre{font-family:var(--font-fig);font-size:13px;color:#E6EDF3;padding:0 14px 14px;overflow-x:auto;white-space:pre;line-height:1.6;margin:0}
details.adv{margin:16px 0 8px 44px}
details.adv>summary{cursor:pointer;font-weight:600;color:var(--blue-deep);font-size:14px;list-style:none}
details.adv>summary::-webkit-details-marker{display:none}
details.adv>summary::before{content:"+ ";font-weight:700}
details.adv[open]>summary::before{content:"- "}
.donenote{margin-left:44px;color:var(--ink-2);font-size:14.5px}
@media(max-width:640px){.stepnote,.cbx,details.adv,.donenote{margin-left:0}}
</style>
<a class="backlink" href="/dashboard${tenantQ}">&larr; Observer Dashboard</a>
<div class="banner">You're signed in to this workspace. Copy the one command below, paste it in your terminal, and you're done - your keys are already baked in. Metering never blocks or changes your calls.</div>

<div class="step"><span class="n">1</span><span class="t">Add Circulara - one command</span></div>
<p class="stepnote">Paste this into your terminal (Claude Code, Cursor, or any MCP host). It installs the plugin and connects it to your workspace in a single step - nothing else to copy.</p>
${block("c-oneliner", "Terminal - paste once", oneLiner)}

<div class="step"><span class="n">2</span><span class="t">That's it</span></div>
<p class="donenote">Make a few AI calls, then watch them appear on your <a href="/dashboard${tenantQ}">Dashboard</a> and <a href="/dashboard/meter${tenantQ}">Meter</a>.</p>

<details class="adv"><summary>Prefer to set it up by hand?</summary>
<p class="stepnote" style="margin-left:0;margin-top:14px">Install the plugin, then add these keys to your project's <span class="range">.env</span> (or your MCP host's env).</p>
${block("c-install", "Terminal", data.installCommand)}
${block("c-env", ".env", envText)}
</details>

<details class="adv"><summary>Optional: auto-meter every tool call (Claude Code hooks)</summary>
<p class="stepnote" style="margin-left:0;margin-top:14px">Add this to <span class="range">.claude/settings.json</span>. It reads the same keys as above. Observe only - it never blocks or alters your tool calls.</p>
${block("c-hooks", ".claude/settings.json", settingsText)}
</details>

<p class="note" style="margin-left:44px;margin-top:24px">Keep your token private - anyone with it can report usage as your workspace. Reload this page any time to mint a fresh one (the old token stops working).</p>

<script>
function ciraCopy(id, btn){
  var el = document.getElementById(id);
  var txt = el ? el.innerText : "";
  var done = function(){ var o = btn.textContent; btn.textContent = "Copied"; setTimeout(function(){ btn.textContent = o; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, done); }
  else { try { var r = document.createRange(); r.selectNode(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); s.removeAllRanges(); done(); } catch(e){} }
}
</script>
`;
  return page("Connect plugin", tenantQ, "connect", body, account);
}

// ---- Operator console (internal; behind CIRCULARA_OPS_TOKEN) ----------------

export interface OpsRow {
  tenant_id: string;
  name: string;
  plan_mode: string;
  created_at: string;
  members: { email: string; role: string; created_at: string }[];
  usage: { events: number; tokens: number; observed_usd: number; last: string | null };
}

const opsDate = (d: string | null): string =>
  d ? String(d).replace("T", " ").slice(0, 16) + " UTC" : "-";

/** Circulara-internal view of every workspace + who signed up + their usage. */
export function renderOps(rows: OpsRow[]): string {
  const totals = rows.reduce(
    (a, r) => ({
      ws: a.ws + 1,
      members: a.members + r.members.length,
      events: a.events + r.usage.events,
      tokens: a.tokens + r.usage.tokens,
      usd: a.usd + r.usage.observed_usd,
    }),
    { ws: 0, members: 0, events: 0, tokens: 0, usd: 0 },
  );
  const tile = (label: string, value: string) =>
    `<div class="t"><div class="tl">${label}</div><div class="tv">${value}</div></div>`;
  const body = rows
    .map((r) => {
      const admin = r.members.find((m) => m.role === "admin") ?? r.members[0];
      const emails = admin
        ? `${esc(admin.email)}${r.members.length > 1 ? ` <span class="mut">+${r.members.length - 1}</span>` : ""}`
        : `<span class="mut">(no member)</span>`;
      return `<tr>
  <td>${emails}</td>
  <td>${esc(r.name)}</td>
  <td><span class="plan ${r.plan_mode}">${esc(r.plan_mode)}</span></td>
  <td class="nowrap">${opsDate(r.created_at)}</td>
  <td class="n">${num(r.usage.events)}</td>
  <td class="n">${num(r.usage.tokens)}</td>
  <td class="n">${usd(r.usage.observed_usd)}</td>
  <td class="nowrap">${opsDate(r.usage.last)}</td>
</tr>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Operator - Circulara AI</title>
<style>
:root{--ink:#0A2540;--ink-2:#42566B;--ink-3:#8497A9;--line:#E2E8F0;--surface:#fff;--surface-2:#EEF1F5;--blue:#009AE4;--green-deep:#0E8E4E;--navy:#00288C}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--surface-2);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:32px 24px 80px}
.wrap{max-width:1200px;margin:0 auto}
h1{font-size:24px;font-weight:800;letter-spacing:-.01em}
.sub{color:var(--ink-3);font-size:14px;margin:4px 0 24px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px}
.t{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.tl{font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:700}
.tv{font-size:26px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:11px 14px;text-align:left;border-bottom:1px solid var(--line);white-space:normal}
th{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);background:var(--surface-2)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.nowrap{white-space:nowrap;color:var(--ink-2)}
tr:last-child td{border-bottom:none}
.mut{color:var(--ink-3)}
.plan{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;text-transform:capitalize}
.plan.shared{background:rgba(0,154,228,.12);color:#0072B5}
.plan.dedicated{background:rgba(14,142,78,.14);color:var(--green-deep)}
.empty{padding:40px;text-align:center;color:var(--ink-3)}
</style></head><body><div class="wrap">
<h1>Circulara - Operator console</h1>
<div class="sub">Every workspace, who signed up, and their observed usage. Internal only.</div>
<div class="tiles">
  ${tile("Workspaces", num(totals.ws))}
  ${tile("Members", num(totals.members))}
  ${tile("Calls observed", num(totals.events))}
  ${tile("Tokens observed", num(totals.tokens))}
  ${tile("Observed spend", usd(totals.usd))}
</div>
<div class="tablewrap"><table>
<thead><tr><th>Email</th><th>Workspace</th><th>Plan</th><th>Signed up</th><th class="n">Calls</th><th class="n">Tokens</th><th class="n">Spend</th><th>Last active</th></tr></thead>
<tbody>${body || `<tr><td colspan="8" class="empty">No signups yet.</td></tr>`}</tbody>
</table></div>
</div></body></html>`;
}
