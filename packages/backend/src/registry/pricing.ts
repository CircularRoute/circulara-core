/**
 * WS6 - provider pricing registry.
 *
 * The meter's counterfactual math references an APPROVED, versioned pricing
 * snapshot (`pricing_version`, AD4). Flow (D12: human approves diffs):
 *
 *   update  -> fetch upstream prices, normalize, write candidate + diff report
 *   approve -> promote candidate to snapshots/pricing_vYYYY-MM-DD[.n].json
 *              and point `approved.json` at it. No auto-approval, ever.
 *
 * Upstream source: LiteLLM's maintained model-price map (MIT), fetched read-only.
 * This job is an agent workload in steady state and runs through Circulara's
 * own optimization layer once that exists (D12 dogfood hook).
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

export const UPSTREAM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface ModelPrice {
  input_cost_per_token: number;
  output_cost_per_token: number;
  provider: string;
}

export interface PricingSnapshot {
  pricing_version: string; // e.g. "2026-07-07" (+ ".2" on same-day re-approve)
  source: string;
  fetched_at: string;
  models: Record<string, ModelPrice>;
}

export interface PricingDiff {
  added: string[];
  removed: string[];
  changed: {
    model: string;
    field: "input_cost_per_token" | "output_cost_per_token";
    from: number;
    to: number;
  }[];
}

/** Normalize LiteLLM's map into our snapshot shape (only priced chat/embed models). */
export function normalizeUpstream(
  raw: Record<string, unknown>,
  fetchedAt: string,
): Omit<PricingSnapshot, "pricing_version"> {
  const models: Record<string, ModelPrice> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (id === "sample_spec" || typeof v !== "object" || v === null) continue;
    const m = v as Record<string, unknown>;
    const inp = m["input_cost_per_token"];
    const out = m["output_cost_per_token"];
    if (typeof inp !== "number" || typeof out !== "number") continue;
    models[id] = {
      input_cost_per_token: inp,
      output_cost_per_token: out,
      provider: String(m["litellm_provider"] ?? "unknown"),
    };
  }
  return { source: UPSTREAM_URL, fetched_at: fetchedAt, models };
}

export function diffSnapshots(
  current: PricingSnapshot | null,
  candidate: Omit<PricingSnapshot, "pricing_version">,
): PricingDiff {
  const cur = current?.models ?? {};
  const cand = candidate.models;
  const added = Object.keys(cand).filter((k) => !(k in cur));
  const removed = Object.keys(cur).filter((k) => !(k in cand));
  const changed: PricingDiff["changed"] = [];
  for (const k of Object.keys(cand)) {
    if (!(k in cur)) continue;
    for (const f of [
      "input_cost_per_token",
      "output_cost_per_token",
    ] as const) {
      if (cur[k][f] !== cand[k][f])
        changed.push({ model: k, field: f, from: cur[k][f], to: cand[k][f] });
    }
  }
  return { added, removed, changed };
}

export class PricingRegistry {
  constructor(private dir: string) {
    mkdirSync(join(dir, "snapshots"), { recursive: true });
  }

  private approvedPointer() {
    return join(this.dir, "approved.json");
  }
  private candidatePath() {
    return join(this.dir, "candidate.json");
  }
  private diffPath() {
    return join(this.dir, "candidate.diff.md");
  }

  getApproved(): PricingSnapshot | null {
    if (!existsSync(this.approvedPointer())) return null;
    const ref = JSON.parse(readFileSync(this.approvedPointer(), "utf8"));
    return JSON.parse(
      readFileSync(join(this.dir, "snapshots", ref.file), "utf8"),
    );
  }

  /** Fetch upstream + write candidate + human-readable diff. Returns the diff. */
  async update(fetcher?: () => Promise<Record<string, unknown>>): Promise<PricingDiff> {
    const fetchUpstream = fetcher ?? (async () => {
      const res = await fetch(UPSTREAM_URL);
      if (!res.ok) throw new Error(`upstream fetch failed: ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    });
    const raw = await fetchUpstream();
    const candidate = normalizeUpstream(raw, new Date().toISOString());
    const diff = diffSnapshots(this.getApproved(), candidate);
    writeFileSync(this.candidatePath(), JSON.stringify(candidate, null, 2));
    writeFileSync(this.diffPath(), renderDiff(diff, candidate));
    return diff;
  }

  /** Human gate. Refuses without a candidate; stamps the version; moves files. */
  approve(today = new Date().toISOString().slice(0, 10)): PricingSnapshot {
    if (!existsSync(this.candidatePath()))
      throw new Error("no candidate to approve - run update first");
    const candidate = JSON.parse(readFileSync(this.candidatePath(), "utf8"));
    // same-day re-approvals get .2, .3 ...
    let version = today;
    let n = 1;
    while (existsSync(join(this.dir, "snapshots", `pricing_v${version}.json`))) {
      n += 1;
      version = `${today}.${n}`;
    }
    const snapshot: PricingSnapshot = { pricing_version: version, ...candidate };
    const file = `pricing_v${version}.json`;
    writeFileSync(
      join(this.dir, "snapshots", file),
      JSON.stringify(snapshot, null, 2),
    );
    writeFileSync(
      this.approvedPointer(),
      JSON.stringify({ file, approved_at: new Date().toISOString() }, null, 2),
    );
    renameSync(this.candidatePath(), this.candidatePath() + ".applied");
    return snapshot;
  }
}

function renderDiff(
  diff: PricingDiff,
  candidate: Omit<PricingSnapshot, "pricing_version">,
): string {
  const lines = [
    `# Pricing registry - candidate diff`,
    ``,
    `Fetched: ${candidate.fetched_at}`,
    `Models in candidate: ${Object.keys(candidate.models).length}`,
    ``,
    `## Changed (${diff.changed.length})`,
    ...diff.changed.map(
      (c) => `- ${c.model} ${c.field}: ${c.from} -> ${c.to}`,
    ),
    ``,
    `## Added (${diff.added.length})`,
    ...diff.added.slice(0, 50).map((m) => `- ${m}`),
    diff.added.length > 50 ? `- ... and ${diff.added.length - 50} more` : ``,
    ``,
    `## Removed (${diff.removed.length})`,
    ...diff.removed.map((m) => `- ${m}`),
    ``,
    `To promote: npm run registry -- approve`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}
