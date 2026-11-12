// schema.org microdata (itemprop attributes in the HTML), for shops without Product JSON-LD
// (Datatronic, CS MEGASTORE). Regex-based like the JSON-LD parser: the first Product item on the page,
// up to the next Product item (related products below it are not read).
import type { PageData } from "./types.ts";
import { decodeEntities, normalizeAvailability, parsePrice, toCents } from "./jsonld.ts";

const PRODUCT = /itemtype=["']https?:\/\/schema\.org\/Product["']/gi;

/** Value of the first itemprop=name in the scope: content/href attribute, else the element's text. */
function prop(scope: string, name: string): string | null {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bitemprop=["']${name}["'][^>]*>`, "i");
  const m = scope.match(re);
  if (!m) return null;
  const tag = m[0];
  const attr = tag.match(/\b(?:content|href)=["']([^"']*)["']/i)?.[1];
  if (attr != null) return decodeEntities(attr).trim() || null;
  const rest = scope.slice(m.index! + tag.length);
  const end = rest.search(new RegExp(`</${m[1]}>`, "i"));
  const text = rest.slice(0, end < 0 ? 300 : Math.min(end, 2000)).replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim() || null;
}

export function parseMicrodataPage(html: string): PageData | null {
  const starts = [...html.matchAll(PRODUCT)].map((m) => m.index!);
  if (starts.length === 0) return null;
  const scope = html.slice(starts[0], starts[1] ?? starts[0] + 200_000);
  const priceCents = toCents(parsePrice(prop(scope, "price")));
  if (priceCents == null || priceCents <= 0) return null;
  const ean = ["gtin13", "gtin", "gtin14", "gtin12", "gtin8"].map((k) => prop(scope, k)).find((v) => v && /^\d{8,14}$/.test(v));
  return {
    kind: "shop",
    source: "microdata",
    name: prop(scope, "name"),
    ean: ean ?? null,
    model: prop(scope, "model"),
    sku: prop(scope, "sku"),
    image: prop(scope, "image"),
    offers: [{
      seller: null,
      priceCents,
      currency: prop(scope, "priceCurrency") ?? "EUR",
      availability: normalizeAvailability(prop(scope, "availability")),
      lowest30dCents: null,
    }],
  };
}
