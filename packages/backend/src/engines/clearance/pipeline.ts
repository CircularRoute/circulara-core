/**
 * Wave 6 - confidentiality clearance pipeline v1 (§6, D9).
 *
 * Layered by design - sell the pipeline, not a magic detector:
 *  1. deterministic scanners: secrets (HARD BLOCK, wave-5 scanner) + PII
 *     patterns (emails, SSNs, cards w/ Luhn, phones) - PII caps the tier,
 *     never silently ships. Presidio-class NER rides the AD13 sidecar seam.
 *  2. LLM classification (cheap model, BYO key): contextual sensitivity the
 *     regexes cannot catch. Risk category + confidence - a SIGNAL, not a verdict.
 *  3. license/provenance: external-derived with unknown license caps at `org`,
 *     NEVER `marketable`; derivatives inherit via the parent_fp chain.
 *  4. policy engine: admin rules map risk categories to tier caps; the most
 *     restrictive cap wins (default-deny posture).
 *  5. human promotion gate: `org` may auto-approve under policy; `marketable`
 *     ALWAYS requires a named human sign-off, logged. No exceptions in v1.
 *  6. audit trail: every capture/scan/classification/promotion decision.
 *
 * Over-blocking starves the library; under-blocking is a trust catastrophe:
 * bias conservative and MEASURE the false-positive rate (audit rows can be
 * marked false_positive by an admin; /v1/clearance/stats reports the rate).
 */
import type { TenantContext } from "../../db/tenancy.js";
import type { TenantPolicy } from "../policy.js";
import { scanForSecrets, type ScanFinding } from "../reuse/scanner.js";

export type SharingTier = "private" | "team" | "org" | "marketable";
export const TIER_ORDER: SharingTier[] = ["private", "team", "org", "marketable"];
const tierIdx = (t: SharingTier) => TIER_ORDER.indexOf(t);
export const minTier = (a: SharingTier, b: SharingTier): SharingTier =>
  tierIdx(a) <= tierIdx(b) ? a : b;

// ---- step 1b: deterministic PII patterns (Presidio-class NER = AD13 sidecar) ----

const PII_PATTERNS: { kind: string; re: RegExp; validate?: (m: string) => boolean }[] = [
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    kind: "credit_card",
    re: /\b(?:\d[ -]?){13,19}\b/,
    validate: (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19) return false;
      let sum = 0;
      let dbl = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d; dbl = !dbl;
      }
      return sum % 10 === 0; // Luhn
    },
  },
  { kind: "phone", re: /\b\+?\d{1,2}[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/ },
];

export function scanForPii(text: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { kind, re, validate } of PII_PATTERNS) {
    const m = text.match(re);
    if (m && (!validate || validate(m[0])))
      findings.push({ kind: `pii_${kind}`, match: `${m[0].slice(0, 4)}...[redacted]` });
  }
  return findings;
}

// ---- step 2: LLM classification port (BYO cheap model) ----

export type RiskCategory =
  | "none"
  | "customer_data"
  | "financial"
  | "hr_personnel"
  | "legal"
  | "unannounced_product"
  | "credentials_or_infra";

export interface Classification {
  risk_category: RiskCategory;
  confidence: "low" | "medium" | "high";
}

export type ClassifierPort = (text: string) => Promise<Classification>;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLASSIFY_MODEL = "claude-haiku-4-5-20251001"; // cheap, per §6 step 2

export function makeAnthropicClassifier(apiKey: string): ClassifierPort {
  return async (text: string) => {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        max_tokens: 60,
        system:
          'Classify the sensitivity of a data asset for cross-team sharing inside a company. Reply ONLY with JSON: {"risk_category":"none|customer_data|financial|hr_personnel|legal|unannounced_product|credentials_or_infra","confidence":"low|medium|high"}. When unsure, pick the riskier category with low confidence (bias conservative).',
        messages: [{ role: "user", content: text.slice(0, 4000) }],
      }),
    });
    if (!res.ok) throw new Error(`classifier call failed: ${res.status}`);
    const j = (await res.json()) as { content: { text?: string }[] };
    const raw = j.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      risk_category: (parsed.risk_category ?? "none") as RiskCategory,
      confidence: (parsed.confidence ?? "low") as Classification["confidence"],
    };
  };
}

// ---- steps 1-4 composed: the capture-time pipeline ----

export interface ClearanceVerdict {
  blocked: boolean; // secrets hard block
  max_tier: SharingTier; // the cap all later promotion obeys
  findings: ScanFinding[];
  classification: Classification | null;
  reasons: string[];
}

export interface ClearanceInput {
  text: string;
  provenance: { producer: string; source: string; build_method: string };
  license: { redistributable: boolean; spdx_or_terms: string | null };
}

export async function runClearance(
  policy: TenantPolicy,
  input: ClearanceInput,
  classifier: ClassifierPort | null,
): Promise<ClearanceVerdict> {
  const reasons: string[] = [];

  // step 1: secrets = HARD BLOCK at any tier
  const secrets = scanForSecrets(input.text);
  if (secrets.blocked)
    return {
      blocked: true,
      max_tier: "private",
      findings: secrets.findings,
      classification: null,
      reasons: ["secret scanner HARD BLOCK - never enters the library (§6 step 1)"],
    };

  let maxTier: SharingTier = policy.clearance.default_max_tier;
  const findings: ScanFinding[] = [];

  // step 1b: PII caps at team (raw client data never auto-publishes)
  const pii = scanForPii(input.text);
  if (pii.length > 0) {
    findings.push(...pii);
    maxTier = minTier(maxTier, "team");
    reasons.push(`PII detected (${pii.map((p) => p.kind).join(", ")}) - capped at team`);
  }

  // step 2: LLM classification (signal, not verdict) -> policy rules
  let classification: Classification | null = null;
  if (classifier) {
    try {
      classification = await classifier(input.text);
    } catch {
      // QA M1: an outage must FAIL CONSERVATIVE - cap the tier, do not
      // pretend the content was classified clean.
      classification = null;
      maxTier = minTier(maxTier, "team");
      reasons.push("classifier unavailable - conservatively capped at team until re-classified");
    }
  }

  // QA re-review M1-absent: with NO classifier configured, content is
  // unclassified - it may share internally but can never reach marketable
  // without a classification pass.
  if (!classifier) {
    maxTier = minTier(maxTier, "org");
    reasons.push("no classifier configured - unclassified content caps at org (never marketable)");
  }

  // step 4: policy engine - admin rules on risk categories, most restrictive wins
  if (classification && classification.risk_category !== "none") {
    const rule = policy.clearance.rules.find(
      (r) => r.risk_category === classification!.risk_category,
    );
    const cap = rule?.max_tier ?? "team"; // unruled risk defaults conservative
    maxTier = minTier(maxTier, cap);
    reasons.push(
      `classified ${classification.risk_category} (${classification.confidence}) - capped at ${cap}`,
    );
  }

  // step 3: license/provenance - unknown external license NEVER marketable.
  // QA MJ1: the signal is the SOURCE; producer is an authenticated subject
  // now and no longer a spoofable "org" string.
  const external = input.provenance.source !== "internal";
  if (external && input.license.redistributable !== true) {
    maxTier = minTier(maxTier, "org");
    reasons.push("external provenance without verified redistributable license - capped at org, never marketable");
  }

  return { blocked: false, max_tier: maxTier, findings, classification, reasons };
}

// ---- step 6: audit trail ----

export async function auditLog(
  ctx: TenantContext,
  entry: {
    exact_fp: string | null;
    action: "capture" | "capture_blocked" | "classify" | "promote" | "promote_denied";
    actor: string;
    detail: unknown;
  },
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO clearance_audit (exact_fp, action, actor, detail) VALUES ($1,$2,$3,$4)`,
    [entry.exact_fp, entry.action, entry.actor, JSON.stringify(entry.detail)],
  );
}
