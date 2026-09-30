// Shop/aggregator-specific adapters. Only for data JSON-LD does not carry.
// Each adapter gets the generic JSON-LD result (may be null) and may enrich or replace it.
import type { Availability, Offer, PageData } from "./types.ts";
import { toCents } from "./jsonld.ts";

export type Adapter = (html: string, url: string, base: PageData | null) => PageData | null;

/** Returns the balanced JSON value (object/array) starting at `start`, or null. */
export function sliceJson(text: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, k + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

// ---------- Verkkokauppa.com ----------
// JSON-LD has the current price. Embedded state has {current, original, discount...};
// in a campaign `original` is the Omnibus comparison price (lowest 30 d).

const verkkokauppa: Adapter = (html, url, base) => {
  if (!base || base.offers.length !== 1) return base;
  const pid = url.match(/\/product\/(\d+)/)?.[1];
  const offer = base.offers[0];
  if (!pid || offer.priceCents == null) return base;
  const re = new RegExp(`"pid":${pid}[,}]`, "g");
  for (const m of html.matchAll(re)) {
    const seg = html.slice(m.index!, m.index! + 4000);
    const cut = seg.indexOf('"pid":', 8);
    const scope = cut > 0 ? seg.slice(0, cut) : seg;
    const pm = scope.match(/"price":\{"current":([\d.]+)[^}]*?"original":([\d.]+)/);
    if (!pm) continue;
    const current = toCents(Number(pm[1]));
    const original = toCents(Number(pm[2]));
    if (current !== offer.priceCents) continue; // not this product's price object
    return {
      ...base,
      source: "adapter:verkkokauppa",
      offers: [{ ...offer, lowest30dCents: original != null && original > current ? original : null }],
    };
  }
  return base;
};

// ---------- Hintaopas.fi (Prisjakt) ----------
// JSON-LD only has an AggregateOffer; per-shop offers live in Next.js flight data ("offerRows").

function hintaopasAvailability(s: unknown): Availability {
  switch (String(s)) {
    case "InStock":
      return "in_stock";
    case "OutOfStock":
      return "out_of_stock";
    case "Backorder":
    case "Incoming":
      return "backorder";
    case "Preorder":
      return "preorder";
    case "LimitedStock":
      return "limited";
    default:
      return "unknown";
  }
}

export function nextFlightText(html: string): string {
  let flight = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      flight += JSON.parse(m[1]);
    } catch { /* skip malformed chunk */ }
  }
  return flight;
}

const hintaopas: Adapter = (html, _url, base) => {
  const flight = nextFlightText(html);
  const key = '"offerRows":';
  const at = flight.indexOf(key);
  if (at < 0) return base;
  const raw = sliceJson(flight, at + key.length);
  if (!raw) return base;
  let rows: Record<string, any>[];
  try {
    rows = JSON.parse(raw);
  } catch {
    return base;
  }
  const bySeller = new Map<string, Offer>();
  for (const r of rows) {
    const seller = r?.shop?.name;
    const amount = r?.price?.amount;
    if (typeof seller !== "string" || typeof amount !== "number") continue;
    if (r.condition && r.condition !== "New") continue; // skip used/refurbished
    const orig = typeof r?.originalPrice?.amount === "number" ? toCents(r.originalPrice.amount) : null;
    const offer: Offer = {
      seller,
      priceCents: toCents(amount),
      currency: r.price.currency ?? "EUR",
      availability: hintaopasAvailability(r.stockStatus),
      lowest30dCents: orig != null && orig > toCents(amount)! ? orig : null,
    };
    const prev = bySeller.get(seller);
    if (!prev || offer.priceCents! < prev.priceCents!) bySeller.set(seller, offer);
  }
  if (bySeller.size === 0) return base;
  return {
    kind: "aggregator",
    source: "adapter:hintaopas",
    name: base?.name ?? null,
    ean: base?.ean ?? null,
    model: base?.model ?? null,
    sku: base?.sku ?? null,
    image: base?.image ?? null,
    offers: [...bySeller.values()],
  };
};

// Registry: domain (without www.) -> adapter. hinta.fi needs none (seller offers are in JSON-LD).
export const ADAPTERS: Record<string, Adapter> = {
  "verkkokauppa.com": verkkokauppa,
  "hintaopas.fi": hintaopas,
};
