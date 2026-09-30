// hinta.fi product search (https://hinta.fi/haku?q=...): allowed by robots.txt, plain HTML table.
// Used to find the same product (by EAN, or by name) in other shops.
import { decodeEntities, parsePrice, toCents } from "./jsonld.ts";

export type SearchHit = {
  id: string;
  url: string; // absolute hinta.fi product page
  name: string;
  group: string | null;
  priceCents: number | null; // cheapest price
  totalCents: number | null; // cheapest incl. delivery
  storeCount: number | null;
  inStock: boolean | null;
};

export const HINTAFI = "https://hinta.fi";

export function hintaFiSearchUrl(query: string): string {
  return `${HINTAFI}/haku?q=${encodeURIComponent(query.trim().slice(0, 64))}`;
}

const text = (s: string | undefined) => (s == null ? null : decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() || null);

export function parseHintaFiSearch(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const rowRe = /<tr class="hv-prt-tr"([^>]*)>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const attrs = m[1], row = m[2];
    const id = attrs.match(/data-id="(\d+)"/)?.[1];
    const href = row.match(/<a href="(\/\d+\/[^"]+)" class="hv-prt_product-a"/)?.[1];
    if (!id || !href) continue;
    const avail = row.match(/title="Saata(?:&shy;|­)?vuus: ([^"]+)"/)?.[1];
    const stores = text(row.match(/hv--store-count">([\s\S]*?)<\/td>/)?.[1]);
    hits.push({
      id,
      url: HINTAFI + href,
      name: text(row.match(/<strong class="hv--name">([\s\S]*?)<\/strong>/)?.[1]) ?? href,
      group: text(row.match(/<div class="hv--group">([\s\S]*?)<\/div>/)?.[1]),
      priceCents: toCents(parsePrice(attrs.match(/data-price="([^"]*)"/)?.[1])),
      totalCents: toCents(parsePrice(attrs.match(/data-price-total="([^"]*)"/)?.[1])),
      storeCount: stores && /^\d+$/.test(stores) ? Number(stores) : null,
      inStock: avail ? /varastossa/i.test(avail) : null,
    });
  }
  return hits;
}

/** Normalized seller / shop key: "Verkkokauppa.com" -> "verkkokauppacom". */
export function sellerKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9åäö]/g, "");
}

/**
 * Does an aggregator seller name refer to a shop we already track?
 * Compares against the shop's display name and its domain stem ("power.fi" -> "power").
 */
export function sellerMatchesShop(seller: string, shop: { domain: string; name: string | null }): boolean {
  const k = sellerKey(seller);
  if (!k) return false;
  const stem = sellerKey(shop.domain.replace(/\.[a-z]{2,}$/i, ""));
  const cands = [sellerKey(shop.domain), stem, shop.name ? sellerKey(shop.name) : ""].filter((c) => c.length >= 3);
  return cands.some((c) => c === k || k.startsWith(c) || c.startsWith(k));
}
