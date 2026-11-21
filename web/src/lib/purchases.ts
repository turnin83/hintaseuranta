import type { WishSummary } from "./types.ts";

type Bought = Pick<WishSummary, "purchased_price_cents" | "purchased_ref_cents" | "purchased_qty">;

/** Pieces bought (older rows and the API before the migration: 1). */
export function qtyOf(i: Bought): number {
  return i.purchased_qty != null && i.purchased_qty >= 1 ? i.purchased_qty : 1;
}

/** What was paid in all: price per piece × pieces. */
export function spentOf(i: Bought): number {
  return (i.purchased_price_cents ?? 0) * qtyOf(i);
}

/** Saved vs the usual price at purchase time, for all pieces; null when unknown. Can be negative. */
export function savingsOf(i: Bought): number | null {
  return i.purchased_price_cents != null && i.purchased_ref_cents != null
    ? (i.purchased_ref_cents - i.purchased_price_cents) * qtyOf(i)
    : null;
}

/** "3 × 49,90 €" for several pieces, "49,90 €" for one. */
export function qtyPrefix(i: Bought): string {
  const n = qtyOf(i);
  return n > 1 ? `${n} × ` : "";
}

/** One row of the purchase log (table purchases). An item bought again has several. */
export type PurchaseRow = {
  id: number;
  wish_item_id: string;
  purchased_at: string;
  price_cents: number;
  qty: number;
  seller: string | null;
  ref_cents: number | null;
};

/** A log row in the shape the helpers above take. */
export function asBought(r: PurchaseRow): Bought {
  return { purchased_price_cents: r.price_cents, purchased_ref_cents: r.ref_cents, purchased_qty: r.qty };
}

/** Saved in all over the log (purchases above the usual price count as 0, not negative). */
export function totalSaved(rows: PurchaseRow[]): number {
  return rows.reduce((n, r) => n + Math.max(0, savingsOf(asBought(r)) ?? 0), 0);
}
