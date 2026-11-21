import { test } from "node:test";
import assert from "node:assert/strict";
import { qtyOf, qtyPrefix, savingsOf, spentOf } from "../web/src/lib/purchases.ts";

test("savings and spending grow with the quantity", () => {
  const i = { purchased_price_cents: 4990, purchased_ref_cents: 6990, purchased_qty: 3 };
  assert.equal(savingsOf(i), 6000);
  assert.equal(spentOf(i), 14970);
  assert.equal(qtyPrefix(i), "3 × ");
});

test("older purchases without a quantity count as one piece", () => {
  const i = { purchased_price_cents: 4990, purchased_ref_cents: 6990 };
  assert.equal(qtyOf(i), 1);
  assert.equal(savingsOf(i), 2000);
  assert.equal(qtyPrefix(i), "");
});

test("unknown usual price: no savings", () => {
  assert.equal(savingsOf({ purchased_price_cents: 4990, purchased_ref_cents: null, purchased_qty: 2 }), null);
});

test("the log total counts every purchase, an overpriced one as zero", async () => {
  const { totalSaved } = await import("../web/src/lib/purchases.ts");
  const row = (price_cents: number, ref_cents: number | null, qty: number) =>
    ({ id: 1, wish_item_id: "i", purchased_at: "", price_cents, qty, seller: null, ref_cents });
  assert.equal(totalSaved([row(4990, 6990, 2), row(5990, 6990, 1), row(7990, 6990, 1), row(4990, null, 1)]), 5000);
});
