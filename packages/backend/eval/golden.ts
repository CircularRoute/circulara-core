/**
 * AD5 - golden eval set for wave-3 techniques. Deterministic invariants:
 * the TS passes are deterministic transforms, so quality gating = provable
 * properties, not LLM judging (zero API spend; the LLM-judge slice activates
 * with the ML compression sidecar per AD13, run at the CFO cadence).
 *
 * Every case states the invariant that must NEVER regress.
 */

export interface CompressionCase {
  name: string;
  input: string;
  invariants: {
    keeps: string[]; // substrings that MUST survive
    maxRatio: number; // output/input length must be <= this (did it compress?)
    minRatio: number; // ... and >= this (did it butcher?)
  };
}

const BIG_PARA =
  "The clearance pipeline is a first-class module and a precondition for any sharing. " +
  "Promotion to marketable always needs a named human sign-off, no exceptions in v1. " +
  "Default-deny throughout; scanners plus policy plus human gate rather than trust in a single classifier. ";

const BIG_CODE = [
  "```ts",
  "export function priceTokens(pricing: PricingSnapshot, model: string) {",
  "  const entry = pricing.models[model];",
  "  if (!entry) return { usd: 0, priced: false };",
  "  return { usd: entry.input_cost_per_token, priced: true };",
  "}",
  "// padding so the block clears the 200-char dedupe threshold ------------",
  "```",
].join("\n");

export const COMPRESSION_CASES: CompressionCase[] = [
  {
    name: "prose: duplicate paragraph removed, content preserved",
    input: `${BIG_PARA}\n\nUnrelated middle content that must survive.\n\n${BIG_PARA}`,
    invariants: {
      keeps: ["clearance pipeline", "Unrelated middle content that must survive."],
      maxRatio: 0.75,
      minRatio: 0.3,
    },
  },
  {
    name: "code: duplicate fenced block deduped, code inside NEVER altered",
    input: `${BIG_CODE}\n\nExplanation between blocks.\n\n${BIG_CODE}`,
    invariants: {
      keeps: [
        "export function priceTokens",
        "input_cost_per_token",
        "Explanation between blocks.",
      ],
      maxRatio: 0.8,
      minRatio: 0.3,
    },
  },
  {
    name: "no-op: short unique content is untouched",
    input: "Short unique prompt. No duplication here.",
    invariants: {
      keeps: ["Short unique prompt. No duplication here."],
      maxRatio: 1.0,
      minRatio: 1.0,
    },
  },
  {
    name: "whitespace: blank-line runs collapse, single blanks survive",
    input: "line one\n\n\n\n\nline two\n\nline three",
    invariants: {
      keeps: ["line one", "line two", "line three"],
      maxRatio: 0.95,
      minRatio: 0.5,
    },
  },
];

export interface RoutingCase {
  name: string;
  body: Record<string, unknown>;
  expectRouted: boolean;
}

export const ROUTING_MAP = { "claude-opus-4-8": "claude-haiku-4-5-20251001" };

export const ROUTING_CASES: RoutingCase[] = [
  {
    name: "simple short request routes down",
    body: { model: "claude-opus-4-8", messages: [{ role: "user", content: "What is 2+2?" }] },
    expectRouted: true,
  },
  {
    name: "long request does NOT route",
    body: {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "x".repeat(5000) }],
    },
    expectRouted: false,
  },
  {
    name: "tool-using request does NOT route",
    body: {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "short" }],
      tools: [{ name: "search" }],
    },
    expectRouted: false,
  },
  {
    name: "unmapped model does NOT route",
    body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] },
    expectRouted: false,
  },
];
