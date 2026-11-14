// Wish list by shop: which items a shop sells, its price for each, and how that compares with the other
// shops. A shop seen through a comparison site (hintaopas.fi, hinta.fi seller) is the same shop as its
// direct link (e.g. seller "Verkkokauppa.com" = verkkokauppa.com).
import type { Availability } from "@shared/types.ts";
import type { Series, Shop, WishSummary } from "./types.ts";
// Relative path (not @shared) so the Node unit tests can import this module too.
import { sellerKey, sellerMatchesShop } from "../../../supabase/functions/_shared/search.ts";

export type ShopSeriesRow = Pick<
  Series,
  | "wish_item_id" | "seller" | "seller_name" | "domain" | "shop_strategy" | "url" | "price_cents" | "ts"
  | "availability" | "shipping_cents" | "lowest_30d_cents" | "own_low_30d_cents" | "obs_count"
>;

export type ShopOption = { key: string; name: string; count: number };

export type ShopOffer = {
  price_cents: number;
  shipping_cents: number | null;
  availability: Availability;
  url: string;
  ts: string;
  claim_cents: number | null;
  own_low_cents: number | null;
  /** Price is older than FRESH_MS: the shop page has not been read lately. */
  stale: boolean;
  /** Cheapest fresh, in-stock price at another shop. */
  other: { name: string; cents: number } | null;
};

const HOUR = 3_600_000;
/** Same as the item's best price (v_wish_summary): readings from the last 36 h. */
export const FRESH_MS = 36 * HOUR;
/** Older readings still say the shop sells the item, but are shown as stale and never compared. */
const KEEP_MS = 7 * 24 * HOUR;

type ShopRef = Pick<Shop, "domain" | "name" | "strategy">;

/** Shop identity of a series row: direct shop domain, or the comparison site's seller mapped to it. */
export function shopOfRow(r: ShopSeriesRow, shops: ShopRef[]): { key: string; name: string } | null {
  if (r.shop_strategy !== "aggregator") {
    const s = shops.find((x) => x.domain === r.domain);
    return { key: `d:${r.domain}`, name: s?.name ?? r.domain };
  }
  if (!r.seller) return null; // the comparison page's own lowest price, not a shop
  const s = shops.find((x) => x.strategy !== "aggregator" && sellerMatchesShop(r.seller, x));
  if (s) return { key: `d:${s.domain}`, name: s.name ?? r.seller_name };
  const k = sellerKey(r.seller);
  return k ? { key: `s:${k}`, name: r.seller_name } : null;
}

const better = (a: ShopSeriesRow, b: ShopSeriesRow) =>
  Number(a.availability === "out_of_stock") - Number(b.availability === "out_of_stock") || a.price_cents - b.price_cents;

export type ShopIndex = {
  options: ShopOption[];
  offers: (key: string) => Map<string, ShopOffer>;
  /** Observations per item (all shops), for deal confidence. */
  obsByItem: Map<string, number>;
};

export function indexShops(rows: ShopSeriesRow[], shops: ShopRef[], now = Date.now()): ShopIndex {
  const obsByItem = new Map<string, number>();
  // item -> shop key -> best row
  const byItem = new Map<string, Map<string, { name: string; row: ShopSeriesRow }>>();
  const names = new Map<string, string>();
  for (const r of rows) {
    obsByItem.set(r.wish_item_id, (obsByItem.get(r.wish_item_id) ?? 0) + r.obs_count);
    if (now - Date.parse(r.ts) > KEEP_MS) continue;
    const shop = shopOfRow(r, shops);
    if (!shop) continue;
    if (!names.has(shop.key)) names.set(shop.key, shop.name);
    const m = byItem.get(r.wish_item_id) ?? new Map();
    byItem.set(r.wish_item_id, m);
    const cur = m.get(shop.key);
    const fresh = (x: ShopSeriesRow) => now - Date.parse(x.ts) <= FRESH_MS;
    // Prefer a fresh reading, then in stock, then the lower price.
    if (!cur || Number(fresh(r)) - Number(fresh(cur.row)) > 0 || (fresh(r) === fresh(cur.row) && better(r, cur.row) < 0)) {
      m.set(shop.key, { name: shop.name, row: r });
    }
  }

  const counts = new Map<string, number>();
  for (const m of byItem.values()) for (const k of m.keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
  const options = [...counts.entries()]
    .map(([key, count]) => ({ key, name: names.get(key)!, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "fi"));

  const offers = (key: string) => {
    const out = new Map<string, ShopOffer>();
    for (const [itemId, m] of byItem) {
      const mine = m.get(key);
      if (!mine) continue;
      const r = mine.row;
      let other: ShopOffer["other"] = null;
      for (const [k, o] of m) {
        if (k === key || o.row.availability === "out_of_stock" || now - Date.parse(o.row.ts) > FRESH_MS) continue;
        if (!other || o.row.price_cents < other.cents) other = { name: o.name, cents: o.row.price_cents };
      }
      out.set(itemId, {
        price_cents: r.price_cents,
        shipping_cents: r.shipping_cents,
        availability: r.availability,
        url: r.url,
        ts: r.ts,
        claim_cents: r.lowest_30d_cents,
        own_low_cents: r.own_low_30d_cents,
        stale: now - Date.parse(r.ts) > FRESH_MS,
        other,
      });
    }
    return out;
  };
  return { options, offers, obsByItem };
}

/** The item as if this shop's offer were its best one, so the deal assessment rates the shop's price. */
export function asShopItem(i: WishSummary, o: ShopOffer, shopName: string): WishSummary {
  return {
    ...i,
    best_seller: shopName,
    best_price_cents: o.stale ? null : o.price_cents, // a stale price is not a current deal
    best_shipping_cents: o.shipping_cents,
    best_claim_cents: o.claim_cents,
    best_own_low_cents: o.own_low_cents,
    best_url: o.url,
    best_availability: o.availability,
    best_ts: o.ts,
  };
}

/** How the shop's price compares with the cheapest other shop: "cheapest", "same", or the difference. */
export function compareOther(o: ShopOffer): { kind: "only" | "cheapest" | "same" | "dearer"; diff: number } {
  if (!o.other) return { kind: "only", diff: 0 };
  const diff = o.price_cents - o.other.cents;
  if (Math.abs(diff) < 50) return { kind: "same", diff };
  return { kind: diff < 0 ? "cheapest" : "dearer", diff };
}
