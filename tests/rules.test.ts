import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvent,
  claimCheck,
  DEFAULT_RULES,
  dailyMinMedian,
  describeClaim,
  diffRules,
  evaluateAfterPurchase,
  evaluateItemRules,
  evaluateSeriesRules,
  type ItemAlertState,
  type ItemState,
  meaningfulDrop,
  median,
  mergeRules,
  type Obs,
  ownLow30d,
  passesCooldown,
  type Reason,
  bigDrops,
  confirmDrops,
  expandHistory,
} from "../supabase/functions/_shared/rules.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);
const nb = String.fromCharCode(0xa0);
const plain = (s: string) => s.replaceAll(nb, " ");

/** Twice-daily history: prices[i] observed at T0 + i * 12h. */
function series(prices: number[], availability: Obs["availability"] = "in_stock"): Obs[] {
  return prices.map((p, i) => ({ ts: T0 + i * DAY / 2, priceCents: p, availability, lowest30dCents: null }));
}

const item = (s: Partial<ItemState>): ItemState => ({
  bestCents: null,
  prevMinCents: null,
  prevObsCount: 0,
  medianCents: null,
  medianDays: 0,
  targetCents: null,
  ...s,
});
const SEEN: ItemAlertState = {}; // evaluated before, nothing active
const itemRules = (s: Partial<ItemState>, prev: ItemAlertState | null = SEEN, rules = DEFAULT_RULES) =>
  evaluateItemRules(item(s), rules, prev).candidates.map((c) => c.rule);

function seriesRules(history: Obs[], current: Partial<Obs> & { priceCents: number }, othersBestCents: number | null = null, rules = DEFAULT_RULES) {
  const ts = (history.at(-1)?.ts ?? T0) + DAY / 2;
  return evaluateSeriesRules({
    current: { ts, availability: "in_stock", lowest30dCents: null, ...current },
    history,
    othersBestCents,
    rules,
  }).map((c) => c.rule);
}

test("median and daily-min median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), null);
  const obs: Obs[] = [
    { ts: T0, priceCents: 1000, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + 1000, priceCents: 900, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + DAY, priceCents: 1100, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + DAY + 1000, priceCents: 500, availability: "out_of_stock", lowest30dCents: null },
    { ts: T0 + 2 * DAY, priceCents: 950, availability: "in_stock", lowest30dCents: null },
  ];
  assert.deepEqual(dailyMinMedian(obs), { median: 950, days: 3 });
});

test("meaningful drop: at least 1 € and 1 %", () => {
  assert.equal(meaningfulDrop(9864, 9862), false); // Kingston: 2 cents
  assert.equal(meaningfulDrop(1549, 1535), false); // 14 cents
  assert.equal(meaningfulDrop(20900, 19900), true);
  assert.equal(meaningfulDrop(500000, 499500), false); // 5 € but 0,1 %
});

test("item: below target fires on entering, not every day while it stays", () => {
  const s = { bestCents: 5057, targetCents: 7500 };
  const first = evaluateItemRules(item(s), DEFAULT_RULES, SEEN);
  assert.deepEqual(first.candidates.map((c) => c.rule), ["below_target"]);
  // Next runs at the same (or slightly lower) price: nothing
  assert.deepEqual(itemRules(s, first.next), []);
  assert.deepEqual(itemRules({ ...s, bestCents: 5000 }, first.next), []); // 57 cents
  // Meaningfully lower: again
  assert.deepEqual(itemRules({ ...s, bestCents: 4500 }, first.next), ["below_target"]);
  // Leaves the state and comes back: again
  const up = evaluateItemRules(item({ ...s, bestCents: 7900 }), DEFAULT_RULES, first.next);
  assert.deepEqual(up.candidates, []);
  assert.deepEqual(itemRules(s, up.next), ["below_target"]);
});

test("item: first evaluation only records the state (no burst after deploy)", () => {
  const r = evaluateItemRules(item({ bestCents: 5057, targetCents: 7500 }), DEFAULT_RULES, null);
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.next.below_target, { on: true, last: 5057 });
});

test("item: below 30-day median is state based too", () => {
  const s = { bestCents: 900, medianCents: 1000, medianDays: 3 };
  const first = evaluateItemRules(item(s), DEFAULT_RULES, SEEN);
  assert.deepEqual(first.candidates.map((c) => c.rule), ["below_median"]);
  assert.deepEqual(itemRules(s, first.next), []);
  assert.deepEqual(itemRules({ ...s, bestCents: 901 }), []); // under 10 %
  assert.deepEqual(itemRules({ ...s, medianDays: 2 }), []);
});

test("item: all-time low needs history and a meaningful step", () => {
  assert.deepEqual(itemRules({ bestCents: 9000, prevMinCents: 10000, prevObsCount: 4 }), []); // 5 < 6 obs
  assert.deepEqual(itemRules({ bestCents: 9000, prevMinCents: 10000, prevObsCount: 5 }), ["all_time_low"]);
  assert.deepEqual(itemRules({ bestCents: 9862, prevMinCents: 9864, prevObsCount: 50 }), []); // 2 cents
});

test("series: drop only when the shop is now the cheapest (default)", () => {
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 6707 }, 5057), []);
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 4990 }, 5057), ["drop"]);
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 900 }, null), ["drop"]);
  const all = mergeRules({ only_cheapest: false });
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 6707 }, 5057, all), ["drop"]);
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 960 }, null), []); // < 5 %
  assert.deepEqual(seriesRules(series([1549]), { priceCents: 1470 }, null), []); // 5 % but 79 cents
});

test("series: a raise followed by a drop back is a bounce, not a drop", () => {
  // 199 -> 249 -> 199 within a week (OBH MultiCook pattern)
  assert.deepEqual(seriesRules(series([19900, 19900, 24900, 24900]), { priceCents: 19900 }), []);
  // ... but a drop below the earlier level is real
  assert.deepEqual(seriesRules(series([19900, 19900, 24900, 24900]), { priceCents: 17900 }), ["drop"]);
});

test("series: back in stock only for the cheapest by default", () => {
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000 }, 1200), ["back_in_stock"]);
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000 }, 900), []);
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000, availability: "out_of_stock" }), []);
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 500, availability: "out_of_stock" }), []);
});

test("own 30-day low needs a week of history", () => {
  const h = series(Array(20).fill(19900)); // 10 days
  assert.equal(ownLow30d(h, h.at(-1)!.ts + DAY / 2), 19900);
  assert.equal(ownLow30d(series([19900, 19900, 19900]), T0 + 2 * DAY), null); // 1 day
});

test("shop's before price vs own history", () => {
  // Shop: "before 319 €, now 199 €"; we saw 199 € all month
  const fake = claimCheck(19900, 31900, 19900)!;
  assert.equal(fake.kind, "fake");
  assert.equal(fake.claimPct, 38);
  assert.match(plain(describeClaim(fake)), /Ei oikea alennus: .*319 € \(−38 %\).*199 € jo 30 päivän sisällä/);
  // Shop: "before 319 €"; our lowest was 219 €: real discount 9 %
  const ex = claimCheck(19900, 31900, 21900)!;
  assert.equal(ex.kind, "exaggerated");
  assert.equal(ex.realPct, 9);
  // Matches our history
  assert.equal(claimCheck(19900, 31900, 31900)!.kind, "ok");
  assert.equal(claimCheck(19900, null, 21900), null);
  assert.equal(claimCheck(19900, 31900, null), null); // not enough history
});

const reason = (r: Partial<Reason> & Pick<Reason, "rule" | "priceCents">): Reason => ({
  level: "alert", refCents: null, seller: "Verkkokauppa.com", link: "L1", series: "", ...r,
});

test("event: one readable alert per item and run", () => {
  const e = buildEvent([
    reason({ rule: "drop", priceCents: 19900, refCents: 31900 }),
    reason({ rule: "below_median", priceCents: 19900, refCents: 24300 }),
    reason({ rule: "all_time_low", priceCents: 19900, refCents: 20900 }),
    reason({ rule: "below_target", priceCents: 19900, refCents: 22000 }),
  ], { pushMinPct: 20 })!;
  assert.equal(e.rule, "below_target");
  assert.deepEqual(e.rules, ["below_target", "all_time_low", "below_median", "drop"]);
  assert.equal(plain(e.headline), "Alle tavoitehinnan: 199 €");
  assert.deepEqual(e.lines.map(plain), [
    "Tavoite 220 €",
    "Uusi alin hinta (aiempi 209 €)",
    "18 % alle tavallisen 243 €",
    "Laski 319 € → 199 €",
  ]);
  assert.deepEqual(e.lineRules, ["below_target", "all_time_low", "below_median", "drop"]);
  assert.equal(e.notify, true);
  assert.equal(e.seller, "Verkkokauppa.com");
});

test("event: push only when significant", () => {
  const small = buildEvent([reason({ rule: "drop", priceCents: 9000, refCents: 10000 })], { pushMinPct: 20 })!;
  assert.equal(small.notify, false); // 10 % drop: list only
  const big = buildEvent([reason({ rule: "below_median", priceCents: 7500, refCents: 10000 })], { pushMinPct: 20 })!;
  assert.equal(big.notify, true);
  assert.equal(plain(big.headline), "25 % tavallista halvempi: 75 €");
  // Price was lower recently: a big "discount" is not pushed and carries a warning
  const inflated = buildEvent([reason({ rule: "below_median", priceCents: 7500, refCents: 10000 })], {
    pushMinPct: 20, inflated: true, warnings: ["Hinta oli alempi 12.10.: 69 €."],
  })!;
  assert.equal(inflated.notify, false);
  assert.equal(inflated.warning, "Hinta oli alempi 12.10.: 69 €.");
  // Target is the user's own limit: always pushed
  assert.equal(buildEvent([reason({ rule: "below_target", priceCents: 9900, refCents: 10000 })], { pushMinPct: 50 })!.notify, true);
  assert.equal(buildEvent([], { pushMinPct: 20 }), null);
});

test("event: two shops dropping in one run keep the cheaper, other shop is named", () => {
  const e = buildEvent([
    reason({ rule: "below_median", priceCents: 19900, refCents: 24300 }),
    reason({ rule: "drop", priceCents: 21900, refCents: 25900, seller: "Power" }),
    reason({ rule: "drop", priceCents: 22900, refCents: 25900, seller: "Gigantti" }),
  ], { pushMinPct: 20 })!;
  assert.deepEqual(e.rules, ["below_median", "drop"]);
  assert.equal(plain(e.lines[1]), "Laski 259 € → 219 € (Power)");
});

test("rules merge: defaults <- household <- item, and diff", () => {
  const household = { drop: { pct: 10 }, back_in_stock: false };
  const itemOverride = { drop: { enabled: false }, push_min_pct: 30 };
  const r = mergeRules(household, itemOverride);
  assert.deepEqual(r.drop, { enabled: false, pct: 10 });
  assert.equal(r.back_in_stock, false);
  assert.equal(r.push_min_pct, 30);
  assert.equal(mergeRules().push_min_pct, 20);
  const base = mergeRules(household);
  assert.deepEqual(diffRules(r, base), { drop: { enabled: false, pct: 10 }, push_min_pct: 30 });
  assert.deepEqual(diffRules(base, base), {});
  // Old stored rules with removed keys are ignored
  assert.equal("suspicious" in mergeRules({ suspicious: true }), false);
});

test("cooldown (shop rules): again only if cheaper or the cooldown passed", () => {
  const cand = { rule: "drop" as const, level: "alert" as const, priceCents: 900, refCents: 1000 };
  const now = T0 + 10 * DAY;
  assert.equal(passesCooldown(cand, undefined, now, 24), true);
  assert.equal(passesCooldown(cand, { priceCents: 900, ts: now - 3_600_000 }, now, 24), false);
  assert.equal(passesCooldown(cand, { priceCents: 950, ts: now - 3_600_000 }, now, 24), true);
  assert.equal(passesCooldown(cand, { priceCents: 900, ts: now - 25 * 3_600_000 }, now, 24), true);
});

test("price drop after purchase: clear drop only", () => {
  assert.deepEqual(evaluateAfterPurchase(29900, 34900), { rule: "price_after_purchase", level: "alert", priceCents: 29900, refCents: 34900 });
  assert.equal(evaluateAfterPurchase(34850, 34900), null);
  assert.equal(evaluateAfterPurchase(1950, 1990), null);
  assert.equal(evaluateAfterPurchase(34900, 34900), null);
  assert.equal(evaluateAfterPurchase(null, 34900), null);
  const e = buildEvent([{ rule: "price_after_purchase", level: "alert", priceCents: 29900, refCents: 34900, seller: "Power", link: "L", series: "" }], { pushMinPct: 20 })!;
  assert.equal(plain(e.headline), "Hinta laski ostoksen jälkeen: 299 €");
  assert.equal(plain(e.lines[0]), "Maksoit 349 €, nyt 50 € halvempi. Tarkista palautusoikeus tai hintatakuu.");
});

test("big drop: confirmed by the re-read, a one-off slip is replaced, otherwise retried", () => {
  const last = new Map([["", 100000], ["Power", 50000], ["Gigantti", 80000]]);
  const o = (seller: string | null, priceCents: number) => ({ seller, priceCents });
  // shop page: 1000 € -> 49 € ("49 €/kk") is a big drop, 1000 € -> 950 € is not
  assert.equal(bigDrops([o(null, 4900)], last).length, 1);
  assert.equal(bigDrops([o(null, 95000)], last).length, 0);
  assert.equal(bigDrops([o("Uusi kauppa", 100)], last).length, 0); // no history: nothing to compare

  // same low price on the re-read -> recorded
  let r = confirmDrops([o(null, 69900)], last, [o(null, 69900)]);
  assert.deepEqual(r, { offers: [o(null, 69900)], unconfirmed: [] });
  // re-read shows the normal price -> the re-read is recorded instead of the slip
  r = confirmDrops([o(null, 4900)], last, [o(null, 99900)]);
  assert.deepEqual(r, { offers: [o(null, 99900)], unconfirmed: [] });
  // re-read failed -> not recorded now
  r = confirmDrops([o(null, 4900)], last, null);
  assert.deepEqual(r, { offers: [], unconfirmed: [o(null, 4900)] });
  // a different low price on the re-read -> not recorded now
  r = confirmDrops([o(null, 4900)], last, [o(null, 5900)]);
  assert.equal(r.unconfirmed.length, 1);

  // comparison page: only the big-drop seller waits; others pass unchanged
  r = confirmDrops([o("Power", 49000), o("Gigantti", 20000)], last, [o("Power", 48000)]);
  assert.deepEqual(r.offers, [o("Power", 49000)]);
  assert.deepEqual(r.unconfirmed, [o("Gigantti", 20000)]);
});

test("price history: change points become one value per day until tracking began", () => {
  const points = [
    { ts: "2026-10-28T21:00:00Z", priceCents: 17200, shop: "Proshop" },
    { ts: "2026-10-30T21:00:00Z", priceCents: 17171, shop: "Proshop" },
    { ts: "2026-11-01T22:00:00Z", priceCents: 12900, shop: "Gigantti" },
  ];
  const days = expandHistory(points, Date.parse("2026-11-03T19:58:00Z"));
  // 28.10. noon is before the first point (21:00) -> the first day is 29.10.; last day 2.11.
  assert.deepEqual(days.map((d) => [d.ts.slice(0, 10), d.priceCents, d.shop]), [
    ["2026-10-29", 17200, "Proshop"],
    ["2026-10-30", 17200, "Proshop"],
    ["2026-10-31", 17171, "Proshop"],
    ["2026-11-01", 17171, "Proshop"],
    ["2026-11-02", 12900, "Gigantti"],
  ]);
  assert.deepEqual(expandHistory([], Date.now()), []);
  assert.deepEqual(expandHistory(points, Date.parse("2026-10-29T08:00:00Z")), []); // tracking began first
});
