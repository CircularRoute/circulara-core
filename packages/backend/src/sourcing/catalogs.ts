/**
 * Wave 5 - catalog abstraction + adapters (AD10) and the federated index (D15).
 *
 * Normalized port: every source implements search/resolve; PAID sources never
 * acquire directly - they produce purchase PROPOSALS (router-not-merchant,
 * D15: the customer's own account transacts after a named human approves).
 *
 * All sources are DEMAND-PULLED (D18): nothing is crawled or mirrored; a
 * search hits the source API at request time. Adapters here are fixture-
 * seeded for offline dev/test and shaped exactly like the live APIs; wiring
 * the live HTTP calls is config, not architecture (fetch seam per adapter).
 *
 * Federated index rule: metadata, fingerprints, cost, freshness, ratings -
 * NEVER bytes.
 */

export interface CatalogEntry {
  source: "hf_hub" | "data_gov" | "data_europa" | "roda" | "adx" | "snowflake";
  tier: "free" | "paid";
  native_id: string;
  title: string;
  description: string;
  license: { redistributable: boolean; spdx_or_terms: string | null };
  price_usd: number; // 0 for free tier
  billing_route: "none" | "customer_aws" | "customer_snowflake";
  freshness: string;
  schema_hint: string | null;
}

export interface CatalogPort {
  readonly source: CatalogEntry["source"];
  readonly tier: "free" | "paid";
  search(query: string): Promise<CatalogEntry[]>;
  /** free tier only: fetch the bytes on demand (customer-side network) */
  acquire?(entry: CatalogEntry): Promise<Buffer>;
}

type Fetcher = (entry: CatalogEntry) => Promise<Buffer>;

/** Fixture-driven adapter base: live fetch plugs in via the seams. */
class FixtureCatalog implements CatalogPort {
  constructor(
    readonly source: CatalogEntry["source"],
    readonly tier: "free" | "paid",
    private fixtures: CatalogEntry[],
    private fetcher?: Fetcher,
  ) {}

  async search(query: string): Promise<CatalogEntry[]> {
    const q = query.toLowerCase();
    return this.fixtures.filter(
      (f) =>
        f.title.toLowerCase().includes(q) || f.description.toLowerCase().includes(q),
    );
  }

  async acquire(entry: CatalogEntry): Promise<Buffer> {
    if (this.tier === "paid")
      throw new Error("paid catalogs never acquire directly - purchase approval flow only (D15)");
    if (this.fetcher) return this.fetcher(entry);
    return Buffer.from(
      JSON.stringify({ source: entry.source, native_id: entry.native_id, demo: true }),
    );
  }
}

/** Launch adapters (AD10). Fixtures mirror each source's real shape. */
export function launchCatalogs(fixtures?: Partial<Record<string, CatalogEntry[]>>): CatalogPort[] {
  return [
    new FixtureCatalog("hf_hub", "free", fixtures?.hf_hub ?? []),
    new FixtureCatalog("data_gov", "free", fixtures?.data_gov ?? []),
    new FixtureCatalog("data_europa", "free", fixtures?.data_europa ?? []),
    new FixtureCatalog("roda", "free", fixtures?.roda ?? []),
    new FixtureCatalog("adx", "paid", fixtures?.adx ?? []),
    new FixtureCatalog("snowflake", "paid", fixtures?.snowflake ?? []),
  ];
}

/** Federated index: one search pane across all sources. METADATA ONLY. */
export class FederatedIndex {
  constructor(private catalogs: CatalogPort[]) {}

  async search(
    query: string,
    tier?: "free" | "paid",
  ): Promise<CatalogEntry[]> {
    const targets = tier ? this.catalogs.filter((c) => c.tier === tier) : this.catalogs;
    const results = await Promise.all(targets.map((c) => c.search(query)));
    // cheapest & safest first: free before paid, then by price
    return results
      .flat()
      .sort((a, b) => (a.tier === b.tier ? a.price_usd - b.price_usd : a.tier === "free" ? -1 : 1));
  }

  catalogFor(source: CatalogEntry["source"]): CatalogPort | undefined {
    return this.catalogs.find((c) => c.source === source);
  }
}
