// Page -> PageData: generic JSON-LD first, then an optional domain adapter.
import type { PageData } from "./types.ts";
import { parseJsonLdPage } from "./jsonld.ts";
import { ADAPTERS } from "./adapters.ts";
import { domainOf } from "./url.ts";

export function extractPage(html: string, url: string): PageData | null {
  const { page } = parseJsonLdPage(html);
  const adapter = ADAPTERS[domainOf(url)];
  const out = adapter ? adapter(html, url, page) : page;
  if (!out) return null;
  // Drop offers without a usable price.
  const offers = out.offers.filter((o) => o.priceCents != null && o.priceCents > 0);
  return { ...out, offers };
}

/** Case/spacing-insensitive seller match ("Verkkokauppa.com" vs "verkkokauppa.com"). */
export function sellerKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9åäö]/g, "");
}
