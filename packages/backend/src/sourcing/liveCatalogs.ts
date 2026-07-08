/**
 * Task 010 - LIVE HTTP wiring for the FREE catalog connectors (AD10).
 * Replaces the fixture adapters at runtime; demand-pulled (D18), so a search
 * hits the source API only when a customer's ladder run needs it.
 *
 *   Hugging Face Hub   https://huggingface.co/api/datasets?search=&full=true
 *   CKAN (data.gov,    /api/3/action/package_search?q=   (one adapter, N hosts)
 *    data.europa.eu)
 *   RODA (AWS open)    https://registry.opendata.aws (static index; keyword match)
 *
 * PAID sources (ADX/Snowflake) are NOT wired live: they transact on the
 * customer's own account, human-approved (D15/AD11) - never a Circulara call.
 *
 * License mapping is CONSERVATIVE: a source license maps to
 * redistributable=true ONLY when it is a recognized open/permissive license.
 * Anything unknown -> redistributable=false (D14 default; the Commons gate
 * then keeps it per-customer). Network failure -> empty results (the ladder
 * falls through to build), never a throw that breaks acquire.
 */
import type { CatalogEntry, CatalogPort } from "./catalogs.js";

const REDISTRIBUTABLE_SPDX = new Set([
  "cc-by-4.0", "cc-by-sa-4.0", "cc0-1.0", "cc-by-3.0", "cc-by-2.0",
  "mit", "apache-2.0", "bsd-3-clause", "bsd-2-clause", "odbl-1.0", "odc-by-1.0",
  "cc-by", "pddl-1.0", "gpl-3.0", "public-domain", "us-pd",
]);

function mapLicense(raw: string | null | undefined): CatalogEntry["license"] {
  const norm = (raw ?? "").toLowerCase().trim();
  return {
    redistributable: REDISTRIBUTABLE_SPDX.has(norm),
    spdx_or_terms: raw ?? null,
  };
}

type FetchImpl = typeof fetch;

const timeout = (ms: number) => {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(id) };
};

async function safeJson(
  fetchImpl: FetchImpl,
  url: string,
): Promise<unknown | null> {
  const t = timeout(8000);
  try {
    const res = await fetchImpl(url, { signal: t.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // demand-pulled: a dead source is a miss, never an error (D18)
  } finally {
    t.done();
  }
}

export class HuggingFaceCatalog implements CatalogPort {
  readonly source = "hf_hub" as const;
  readonly tier = "free" as const;
  constructor(private fetchImpl: FetchImpl = fetch) {}

  async search(query: string): Promise<CatalogEntry[]> {
    const url = `https://huggingface.co/api/datasets?search=${encodeURIComponent(query)}&limit=10&full=true`;
    const j = await safeJson(this.fetchImpl, url);
    if (!Array.isArray(j)) return [];
    return j.slice(0, 10).map((d: Record<string, unknown>) => {
      const card = (d.cardData ?? {}) as { license?: string };
      return {
        source: "hf_hub" as const,
        tier: "free" as const,
        native_id: String(d.id ?? d._id ?? ""),
        title: String(d.id ?? ""),
        description: String((d.description as string) ?? d.id ?? ""),
        license: mapLicense(card.license ?? (d.license as string)),
        price_usd: 0,
        billing_route: "none" as const,
        freshness: String((d.lastModified as string) ?? "static"),
        schema_hint: null,
      };
    });
  }

  async acquire(entry: CatalogEntry): Promise<Buffer> {
    // metadata + a fetch pointer; the actual dataset pull is size-bounded and
    // happens on the customer side. v1 returns the resolved reference.
    return Buffer.from(JSON.stringify({ source: "hf_hub", dataset: entry.native_id, url: `https://huggingface.co/datasets/${entry.native_id}` }));
  }
}

export class CkanCatalog implements CatalogPort {
  readonly tier = "free" as const;
  constructor(
    readonly source: "data_gov" | "data_europa",
    private baseUrl: string,
    private fetchImpl: FetchImpl = fetch,
  ) {}

  async search(query: string): Promise<CatalogEntry[]> {
    const url = `${this.baseUrl}/api/3/action/package_search?q=${encodeURIComponent(query)}&rows=10`;
    const j = (await safeJson(this.fetchImpl, url)) as
      | { result?: { results?: Record<string, unknown>[] } }
      | null;
    const rows = j?.result?.results ?? [];
    return rows.slice(0, 10).map((r) => ({
      source: this.source,
      tier: "free" as const,
      native_id: String(r.id ?? r.name ?? ""),
      title: String(r.title ?? r.name ?? ""),
      description: String(r.notes ?? r.title ?? ""),
      license: mapLicense((r.license_id as string) ?? (r.license_title as string)),
      price_usd: 0,
      billing_route: "none" as const,
      freshness: String((r.metadata_modified as string) ?? "static"),
      schema_hint: null,
    }));
  }

  async acquire(entry: CatalogEntry): Promise<Buffer> {
    return Buffer.from(JSON.stringify({ source: this.source, package: entry.native_id, host: this.baseUrl }));
  }
}

/** RODA has no search API; a small curated index is matched by keyword. */
export class RodaCatalog implements CatalogPort {
  readonly source = "roda" as const;
  readonly tier = "free" as const;
  // demand-pulled: this is metadata only (never bytes), refreshed by the
  // federated-index maintenance job, not bulk-ingested.
  private index: CatalogEntry[] = [];
  setIndex(entries: CatalogEntry[]) {
    this.index = entries;
  }
  async search(query: string): Promise<CatalogEntry[]> {
    const q = query.toLowerCase();
    return this.index.filter(
      (e) => e.title.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }
  async acquire(entry: CatalogEntry): Promise<Buffer> {
    return Buffer.from(JSON.stringify({ source: "roda", id: entry.native_id }));
  }
}

/** The launch set with LIVE free adapters + fixture-shaped paid adapters. */
export function liveFreeCatalogs(fetchImpl: FetchImpl = fetch): CatalogPort[] {
  return [
    new HuggingFaceCatalog(fetchImpl),
    new CkanCatalog("data_gov", "https://catalog.data.gov", fetchImpl),
    new CkanCatalog("data_europa", "https://data.europa.eu/api/hub/search", fetchImpl),
    new RodaCatalog(),
  ];
}

export { mapLicense };
