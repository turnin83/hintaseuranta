// Where and when a price was lowest, from the item's observations including the price history from
// before tracking (hintaopas.fi, HISTORY_SELLER). Pure functions; the caller loads the rows.
import { HISTORY_SELLER } from "../../../supabase/functions/_shared/rules.ts";

export type PriceRow = {
  ts: string;
  price_cents: number;
  availability: string;
  seller: string;
  history_shop: string | null;
  product_link_id: string;
};

export const PRICE_ROW_COLS = "ts, price_cents, availability, seller, history_shop, product_link_id";

const inStockBetween = (rows: PriceRow[], fromMs: number, toMs: number) =>
  rows.filter((r) => {
    const t = Date.parse(r.ts);
    return t >= fromMs && t < toMs && r.availability !== "out_of_stock";
  });

export type LowPoint = { cents: number; ts: string; where: string | null; fromHistory: boolean };

/** Lowest in-stock price in [fromMs, toMs) and where it was (the latest day if it repeats). */
export function lowestBetween(
  rows: PriceRow[],
  fromMs: number,
  toMs: number,
  nameOf: (r: PriceRow) => string | null,
): LowPoint | null {
  let best: PriceRow | null = null;
  for (const r of inStockBetween(rows, fromMs, toMs)) {
    if (!best || r.price_cents < best.price_cents || (r.price_cents === best.price_cents && r.ts > best.ts)) best = r;
  }
  if (!best) return null;
  const fromHistory = best.seller === HISTORY_SELLER;
  return { cents: best.price_cents, ts: best.ts, where: fromHistory ? best.history_shop : nameOf(best), fromHistory };
}

export const fiDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1}.`;
};
