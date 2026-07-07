/**
 * Wave 5 - deterministic secret scanner: the capture-safety MINIMUM BAR.
 *
 * HARD BLOCK: an asset containing a live credential never enters the library
 * at any tier, and certainly never the Commons (§6 step 1). This is the
 * detect-secrets/Gitleaks-class deterministic pass implemented in-process
 * (TS); the Python sidecar (AD13) adds Presidio PII + the full clearance
 * pipeline in wave 6 - the seam is the ScanResult shape, unchanged.
 */
export interface ScanFinding {
  kind: string;
  match: string; // REDACTED preview, never the full secret
}

export interface ScanResult {
  blocked: boolean;
  findings: ScanFinding[];
}

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "aws_secret_key", re: /\baws.{0,20}['"][0-9a-zA-Z/+]{40}['"]/i },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9-_]{20,}\b/ },
  { kind: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9-_]{20,}\b/ },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: "generic_assignment",
    re: /\b(?:api[_-]?key|secret|password|token|credential)s?\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i,
  },
  { kind: "connection_string", re: /\b(?:postgres|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"@]+:[^\s'"@]+@/i },
];

/** Shannon entropy per char - flags random-looking 32+ char tokens. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENTROPY_CANDIDATE = /\b[A-Za-z0-9+/=_-]{32,64}\b/g;

export function scanForSecrets(text: string): ScanResult {
  const findings: ScanFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = text.match(re);
    if (m) findings.push({ kind, match: `${m[0].slice(0, 8)}...[redacted]` });
  }
  // entropy pass: random-looking long tokens near secret-ish context words
  for (const m of text.matchAll(ENTROPY_CANDIDATE)) {
    const token = m[0];
    if (entropy(token) < 4.5) continue; // hex/uuid-ish and prose stay under this
    const ctx = text.slice(Math.max(0, m.index! - 40), m.index!);
    if (/key|secret|token|password|credential|auth/i.test(ctx))
      findings.push({ kind: "high_entropy_near_secret_context", match: `${token.slice(0, 8)}...[redacted]` });
  }
  return { blocked: findings.length > 0, findings };
}
