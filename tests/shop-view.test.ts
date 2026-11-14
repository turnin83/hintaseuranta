import { test } from "node:test";
import assert from "node:assert/strict";
import { compareOther, indexShops, type ShopSeriesRow } from "../web/src/lib/shop-view.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const h = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const row = (p: Partial<ShopSeriesRow>): ShopSeriesRow => ({
  wish_item_id: "a", seller: "", seller_name: "", domain: "verkkokauppa.com", shop_strategy: "direct", url: "u",
  price_cents: 10000, ts: h(1), availability: "in_stock", shipping_cents: null, lowest_30d_cents: null,
  own_low_30d_cents: null, obs_count: 3, ...p,
});
const shops = [
  { domain: "verkkokauppa.com", name: "Verkkokauppa.com", strategy: "direct" as const },
  { domain: "gigantti.fi", name: "Gigantti", strategy: "blocked" as const },
  { domain: "hintaopas.fi", name: "Hintaopas", strategy: "aggregator" as const },
];

test("a comparison site's seller is the same shop as its direct link", () => {
  const ix = indexShops([
    row({}),
    row({ wish_item_id: "b", domain: "hintaopas.fi", shop_strategy: "aggregator", seller: "Verkkokauppa.com", seller_name: "Verkkokauppa.com" }),
    row({ wish_item_id: "b", domain: "hintaopas.fi", shop_strategy: "aggregator", seller: "Gigantti", seller_name: "Gigantti", price_cents: 9000 }),
    row({ wish_item_id: "b", domain: "hintaopas.fi", shop_strategy: "aggregator", seller: "", seller_name: "Hintaopas" }),
  ], shops, NOW);
  assert.deepEqual(ix.options.map((o) => [o.key, o.name, o.count]), [
    ["d:verkkokauppa.com", "Verkkokauppa.com", 2],
    ["d:gigantti.fi", "Gigantti", 1],
  ]);
  assert.equal(ix.obsByItem.get("b"), 9);
});

test("the shop's offer compares with the cheapest fresh, in-stock other shop", () => {
  const ix = indexShops([
    row({ price_cents: 10000 }),
    row({ domain: "power.fi", price_cents: 9500 }),
    row({ domain: "jimms.fi", price_cents: 8000, availability: "out_of_stock" }),
    row({ domain: "proshop.fi", price_cents: 7000, ts: h(48) }), // stale: not compared
  ], shops, NOW);
  const o = ix.offers("d:verkkokauppa.com").get("a")!;
  assert.deepEqual(o.other, { name: "power.fi", cents: 9500 });
  assert.deepEqual(compareOther(o), { kind: "dearer", diff: 500 });
  const p = ix.offers("d:power.fi").get("a")!;
  assert.equal(compareOther(p).kind, "cheapest");
  assert.equal(ix.offers("d:proshop.fi").get("a")!.stale, true);
});

test("readings older than a week drop the shop", () => {
  const ix = indexShops([row({ ts: h(24 * 8) })], shops, NOW);
  assert.equal(ix.options.length, 0);
});
