// Async enrichment after page parsing: extra data a shop exposes outside the product page HTML.
//
// Power.fi: the public product API (/api/v2/products?ids=<id>, not disallowed by robots.txt) tells the
// legally required comparison price during a campaign: "Alin hinta 30 pv aikana ennen kampanjaa".
import type { PageData } from "./types.ts";
import { toCents } from "./jsonld.ts";
import { domainOf } from "./url.ts";
import { USER_AGENT } from "./fetcher.ts";

type PowerProduct = {
  productId?: number;
  price?: number;
  previousPrice?: number;
  minimumPreviousPriceInfo?: {
    minimumPrice?: number;
    activeCampaignStartTime?: string;
    activeCampaignEndTime?: string;
  } | null;
};

/** Comparison price (cents) from a Power API product, when a campaign is active and it is higher. */
export function powerReferenceCents(p: PowerProduct, now: number): number | null {
  const info = p.minimumPreviousPriceInfo;
  if (!info?.minimumPrice || p.price == null) return null;
  const start = info.activeCampaignStartTime ? Date.parse(info.activeCampaignStartTime) : -Infinity;
  const end = info.activeCampaignEndTime ? Date.parse(info.activeCampaignEndTime) : Infinity;
  if (now < start || now > end) return null;
  return info.minimumPrice > p.price ? toCents(info.minimumPrice) : null;
}

async function enrichPower(page: PageData, url: string): Promise<PageData> {
  const id = url.match(/\/p-(\d+)\/?/)?.[1];
  const offer = page.offers[0];
  if (!id || !offer || page.kind !== "shop") return page;
  try {
    const res = await fetch(`https://www.power.fi/api/v2/products?ids=${id}`, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return page;
    const [p] = (await res.json()) as PowerProduct[];
    if (!p || toCents(p.price ?? null) !== offer.priceCents) return page; // different product / stale API
    const ref = powerReferenceCents(p, Date.now());
    return ref == null ? page : { ...page, source: "jsonld+power-api", offers: [{ ...offer, lowest30dCents: ref }] };
  } catch {
    return page; // enrichment is best effort
  }
}

export async function enrichPage(page: PageData, url: string): Promise<PageData> {
  switch (domainOf(url)) {
    case "power.fi":
      return enrichPower(page, url);
    default:
      return page;
  }
}
