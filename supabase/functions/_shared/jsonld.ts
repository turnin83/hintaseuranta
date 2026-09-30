// Generic schema.org Product JSON-LD parser.
import type { Availability, Offer, PageData } from "./types.ts";

type Node = Record<string, unknown>;

export function extractJsonLd(html: string): { data: unknown[]; errors: number } {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const data: unknown[] = [];
  let errors = 0;
  for (const m of html.matchAll(re)) {
    const txt = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try {
      data.push(JSON.parse(txt));
    } catch {
      // Some shops emit raw newlines inside strings; retry once with them escaped.
      try {
        data.push(JSON.parse(txt.replace(/[\r\n\t]+/g, " ")));
      } catch {
        errors++;
      }
    }
  }
  return { data, errors };
}

function hasType(node: Node, t: string): boolean {
  const ty = node["@type"];
  const norm = (s: unknown) => String(s).replace(/^https?:\/\/schema\.org\//, "");
  return Array.isArray(ty) ? ty.some((x) => norm(x) === t) : norm(ty) === t;
}

export function findProduct(data: unknown): Node | null {
  const stack: unknown[] = [data];
  while (stack.length) {
    const n = stack.shift();
    if (Array.isArray(n)) stack.push(...n);
    else if (n && typeof n === "object") {
      const o = n as Node;
      if (hasType(o, "Product")) return o;
      if (hasType(o, "ProductGroup")) {
        const variants = o["hasVariant"];
        const v = Array.isArray(variants) ? variants[0] : variants;
        return (v && typeof v === "object") ? { ...o, ...(v as Node) } : o;
      }
      if (o["@graph"]) stack.push(o["@graph"]);
      if (o["mainEntity"]) stack.push(o["mainEntity"]);
    }
  }
  return null;
}

export function first<T>(v: T | T[] | undefined | null): T | undefined {
  return Array.isArray(v) ? v[0] : (v ?? undefined);
}

export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s ]/g, "").replace(/[^\d.,-]/g, "");
  if (!s) return null;
  // "1.299,90" -> 1299.90 ; "1299,90" -> 1299.90 ; "1,299.90" -> 1299.90 ; "1299.90" -> 1299.90
  let norm = s;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) norm = s.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma && lastComma >= 0) norm = s.replace(/,/g, "");
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

export function toCents(price: number | null): number | null {
  return price == null ? null : Math.round(price * 100);
}

export function normalizeAvailability(v: unknown): Availability {
  const s = String(first(v as unknown[]) ?? "").replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  if (!s) return "unknown";
  if (s === "instock" || s === "instoreonly" || s === "onlineonly") return "in_stock";
  if (s === "limitedavailability") return "limited";
  if (s === "outofstock" || s === "soldout" || s === "discontinued") return "out_of_stock";
  if (s === "preorder" || s === "presale") return "preorder";
  if (s === "backorder") return "backorder";
  return "unknown";
}

const ENTITIES: Record<string, string> = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " " };

/** Some shops HTML-escape text inside JSON-LD ("Jimm&apos;s"). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function str(v: unknown): string | null {
  const f = first(v as unknown[]);
  if (f == null) return null;
  if (typeof f === "object") return str((f as Node)["name"] ?? (f as Node)["@id"]);
  const s = decodeEntities(String(f)).trim();
  return s || null;
}

function sellerName(offer: Node): string | null {
  return str(offer["seller"]);
}

function offerFrom(offer: Node, withSeller: boolean): Offer {
  const spec = first(offer["priceSpecification"] as Node | Node[]) ?? {};
  const price = parsePrice(offer["price"] ?? offer["lowPrice"] ?? spec["price"]);
  return {
    seller: withSeller ? sellerName(offer) : null,
    priceCents: toCents(price),
    currency: str(offer["priceCurrency"] ?? spec["priceCurrency"]),
    availability: normalizeAvailability(offer["availability"]),
    lowest30dCents: null,
  };
}

/**
 * Parses a Product node. A shop page yields one offer (seller = null).
 * An aggregator page (AggregateOffer with per-seller offers) yields one offer per seller.
 */
export function productFromJsonLd(p: Node): PageData {
  const offersRaw = p["offers"] as Node | Node[] | undefined;
  const top = first(offersRaw) ?? {};
  let offers: Offer[] = [];
  let kind: PageData["kind"] = "shop";

  if (hasType(top, "AggregateOffer")) {
    const inner = top["offers"] as Node | Node[] | undefined;
    const list = Array.isArray(inner) ? inner : inner ? [inner] : [];
    const withSellers = list.filter((o) => sellerName(o));
    if (withSellers.length > 0) {
      kind = "aggregator";
      offers = withSellers.map((o) => offerFrom(o, true));
    } else {
      // Aggregate without seller breakdown: keep only the low price as a single shop-level offer.
      offers = [offerFrom(top, false)];
      kind = "aggregator";
    }
  } else if (Array.isArray(offersRaw) && offersRaw.length > 1 && offersRaw.some((o) => sellerName(o))) {
    // Multiple offers from different sellers (marketplace) – take the cheapest as the page price.
    const parsed = offersRaw.map((o) => offerFrom(o, false)).filter((o) => o.priceCents != null);
    parsed.sort((a, b) => a.priceCents! - b.priceCents!);
    offers = parsed.slice(0, 1);
  } else if (offersRaw) {
    offers = [offerFrom(top, false)];
  }

  const gtin = str(p["gtin13"] ?? p["gtin"] ?? p["gtin14"] ?? p["gtin12"] ?? p["gtin8"] ?? p["ean"]);
  return {
    kind,
    source: "jsonld",
    name: str(p["name"]),
    ean: gtin && /^\d{8,14}$/.test(gtin) ? gtin : null,
    model: str(p["mpn"] ?? p["model"]),
    sku: str(p["sku"] ?? p["productID"]),
    image: str(p["image"]),
    offers,
  };
}

export function parseJsonLdPage(html: string): { page: PageData | null; blocks: number; errors: number } {
  const { data, errors } = extractJsonLd(html);
  const p = findProduct(data);
  return { page: p ? productFromJsonLd(p) : null, blocks: data.length, errors };
}
