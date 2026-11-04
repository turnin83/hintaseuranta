import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDeal, isDeal, priceMismatch } from "../web/src/lib/deals.ts";
import type { WishSummary } from "../web/src/lib/types.ts";

const item = (p: Partial<WishSummary>): WishSummary => ({
  id: "i", name: "x", tags: [], target_price_cents: null, priority: 2, active: true, notes: null, rules: {},
  created_at: "", best_seller: "Shop", best_price_cents: 10000, best_url: null, best_availability: "in_stock",
  best_ts: "", best_shipping_cents: null, best_claim_cents: null, best_own_low_cents: null,
  purchased_at: null, purchased_price_cents: null, purchased_seller: null, purchased_ref_cents: null, min_all_cents: 10000, median_30d_cents: 10000, link_count: 1, failing_links: 0, last_fetched_at: null,
  unread_alerts: 0, ...p,
});

test("unchanged price is not a deal (the filter bug)", () => {
  const a = assessDeal(item({}), 20); // best == min == median
  assert.equal(a.allTimeLow, false);
  assert.equal(a.tier, null);
  assert.equal(isDeal(a), false);
});

test("tiers by discount vs the usual (median) price", () => {
  const tier = (best: number) => assessDeal(item({ best_price_cents: best, min_all_cents: best }), 20).tier;
  assert.equal(tier(3500), "must"); // 65 %
  assert.equal(tier(5900), "excellent"); // 41 %
  assert.equal(tier(7800), "good"); // 22 %
  assert.equal(tier(9400), "small"); // 6 %
  assert.equal(tier(9700), null); // 3 %
});

test("recommendation", () => {
  const big = assessDeal(item({ best_price_cents: 5900, min_all_cents: 5900 }), 20);
  assert.equal(big.recommendation, "buy");
  assert.deepEqual(big.reasons, ["41 % alle tavallisen hinnan", "halvin koskaan seurattu hinta"]);

  const lowWithHistory = assessDeal(item({ best_price_cents: 8400, min_all_cents: 8400 }), 20); // 16 % + ATL
  assert.equal(lowWithHistory.recommendation, "buy");

  const target = assessDeal(item({ best_price_cents: 9900, min_all_cents: 9000, target_price_cents: 9900 }), 20);
  assert.equal(target.recommendation, "buy");
  assert.equal(target.tier, null);
  assert.ok(isDeal(target));

  const good = assessDeal(item({ best_price_cents: 7800, min_all_cents: 7000 }), 20); // 22 %, not ATL
  assert.equal(good.recommendation, "consider");

  const small = assessDeal(item({ best_price_cents: 9400, min_all_cents: 9000 }), 20);
  assert.equal(small.recommendation, null);
});

test("little history: no all-time-low claim, flagged as low confidence", () => {
  const a = assessDeal(item({ best_price_cents: 8000, min_all_cents: 8000 }), 3);
  assert.equal(a.allTimeLow, false);
  assert.equal(a.lowConfidence, true);
  assert.equal(a.tier, "good");
});

test("out of stock or no price is never a deal", () => {
  assert.equal(isDeal(assessDeal(item({ best_price_cents: 3000, best_availability: "out_of_stock" }), 20)), false);
  assert.equal(isDeal(assessDeal(item({ best_price_cents: null }), 20)), false);
});

test("raised then discounted: no buy recommendation, warning shown", () => {
  // usual (median) 299 €, now 179 € (40 %), but we have seen 149 € before
  const a = assessDeal(item({ best_price_cents: 17900, median_30d_cents: 29900, min_all_cents: 14900 }), 20);
  assert.equal(a.tier, "excellent");
  assert.equal(a.recommendation, "consider");
  assert.ok(a.warnings[0].replaceAll(String.fromCharCode(0xa0), " ").includes("Hinta on ollut alempi: 149 €"));
  assert.match(a.reasons[0], /alle viime aikojen hinnan$/);
  // own target still wins
  const t = assessDeal(item({ best_price_cents: 17900, median_30d_cents: 29900, min_all_cents: 14900, target_price_cents: 18000 }), 20);
  assert.equal(t.recommendation, "buy");
});

test("misleading before-price of the best offer", () => {
  const a = assessDeal(item({ best_price_cents: 5900, min_all_cents: 5900, best_claim_cents: 9900, best_own_low_cents: 5900 }), 20);
  assert.equal(a.recommendation, "consider"); // 41 % vs median would be "buy", but the shop's discount is fake
  assert.match(a.warnings[0], /^Ei oikea alennus/);
});

test("price mismatch: comparison page shows a clearly different price for the same shop", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const x = (cents: number, h: number) => ({ cents, via: "hinta.fi", ts: at(h) });
  assert.equal(priceMismatch(4900, at(1), x(99900, 1), now)?.cents, 99900); // "49 €/kk" read as the price
  assert.equal(priceMismatch(99900, at(1), x(97900, 1), now), null); // 2 %: aggregator lag, no note
  assert.equal(priceMismatch(1000, at(1), x(1090, 1), now), null); // 9 % but under 1 €
  assert.equal(priceMismatch(4900, at(1), x(99900, 9), now), null); // readings 8 h apart
  assert.equal(priceMismatch(4900, at(40), x(99900, 40), now), null); // old
  assert.equal(priceMismatch(4900, at(1), null, now), null);
});
