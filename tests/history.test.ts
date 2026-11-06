import { test } from "node:test";
import assert from "node:assert/strict";
import { lowestBetween, type PriceRow, usualPriceBefore } from "../web/src/lib/history.ts";

const row = (day: string, cents: number, seller = "#history", shop: string | null = "Proshop"): PriceRow => ({
  ts: `${day}T12:00:00.000Z`,
  price_cents: cents,
  availability: "in_stock",
  seller,
  history_shop: seller === "#history" ? shop : null,
  product_link_id: "L1",
});

// LG 27G610A-B: market low ~172 € in October, Gigantti 129 € from 2.11., bought 3.11.
const rows: PriceRow[] = [
  row("2026-08-11", 16007, "#history", "Hobby Hall"),
  ...Array.from({ length: 28 }, (_, i) => row(`2026-10-${String(i + 4).padStart(2, "0")}`, 17200)),
  row("2026-11-01", 17171),
  row("2026-11-02", 12900, "#history", "Gigantti"),
];
const bought = Date.parse("2026-11-03T10:00:00Z");

test("usual price before a purchase uses the price history from before tracking", () => {
  assert.equal(usualPriceBefore(rows, bought), 17200);
  assert.equal(usualPriceBefore([], bought), null);
});

test("lowest price before a purchase tells where and when", () => {
  const low = lowestBetween(rows, bought - 90 * 86_400_000, bought, () => null)!;
  assert.deepEqual(low, { cents: 12900, ts: "2026-11-02T12:00:00.000Z", where: "Gigantti", fromHistory: true });
  const before = lowestBetween(rows, 0, Date.parse("2026-11-01T00:00:00Z"), () => null)!;
  assert.equal(before.cents, 16007);
  assert.equal(before.where, "Hobby Hall");
  const own = lowestBetween([row("2026-11-04", 12900, "")], 0, Date.now(), () => "Proshop")!;
  assert.equal(own.where, "Proshop");
  assert.equal(own.fromHistory, false);
});
