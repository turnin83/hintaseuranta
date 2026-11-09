// Page -> PageData: generic JSON-LD first, then an optional domain adapter.
import type { PageData } from "./types.ts";
import { parseJsonLdPage } from "./jsonld.ts";
import { ADAPTERS, csx4, CSX4_PRICE_FIELD } from "./adapters.ts";
import { domainOf } from "./url.ts";

export function extractPage(html: string, url: string): PageData | null {
  const { page } = parseJsonLdPage(html);
  const adapter = ADAPTERS[domainOf(url)] ?? (html.includes(CSX4_PRICE_FIELD) ? csx4 : undefined);
  const out = adapter ? adapter(html, url, page) : page;
  if (!out) return null;
  // Drop offers without a usable price.
  const offers = out.offers.filter((o) => o.priceCents != null && o.priceCents > 0);
  return { ...out, offers };
}

export { sellerKey } from "./search.ts";
