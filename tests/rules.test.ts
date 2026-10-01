import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RULES,
  dailyMinMedian,
  describeAlert,
  diffRules,
  evaluateItemRules,
  evaluateSeriesRules,
  median,
  mergeRules,
  passesCooldown,
  type ItemState,
  type Obs,
} from "../supabase/functions/_shared/rules.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

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
const itemRules = (s: Partial<ItemState>, rules = DEFAULT_RULES) => evaluateItemRules(item(s), rules).map((c) => c.rule);

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
  // Two shops per day: the day's minimum counts; out-of-stock ignored.
  const obs: Obs[] = [
    { ts: T0, priceCents: 1000, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + 1000, priceCents: 900, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + DAY, priceCents: 1100, availability: "in_stock", lowest30dCents: null },
    { ts: T0 + DAY + 1000, priceCents: 500, availability: "out_of_stock", lowest30dCents: null },
    { ts: T0 + 2 * DAY, priceCents: 950, availability: "in_stock", lowest30dCents: null },
  ];
  assert.deepEqual(dailyMinMedian(obs), { median: 950, days: 3 });
});

test("item: below target fires once for the item's best price", () => {
  const c = evaluateItemRules(item({ bestCents: 5057, targetCents: 7500 }), DEFAULT_RULES);
  assert.deepEqual(c, [{ rule: "below_target", level: "alert", priceCents: 5057, refCents: 7500 }]);
  assert.deepEqual(itemRules({ bestCents: 7600, targetCents: 7500 }), []);
  assert.deepEqual(itemRules({ bestCents: 7500, targetCents: 7500 }), ["below_target"]); // equal counts
  assert.deepEqual(itemRules({ bestCents: null, targetCents: 7500 }), []);
});

test("item: all-time low across all shops, needs N observations", () => {
  assert.deepEqual(itemRules({ bestCents: 900, prevMinCents: 1000, prevObsCount: 4 }), []); // 5 < 6
  assert.deepEqual(itemRules({ bestCents: 900, prevMinCents: 1000, prevObsCount: 5 }), ["all_time_low"]);
  assert.deepEqual(itemRules({ bestCents: 1000, prevMinCents: 1000, prevObsCount: 50 }), []); // equal is not new
});

test("item: below 30-day median needs 3 days of data", () => {
  assert.deepEqual(itemRules({ bestCents: 900, medianCents: 1000, medianDays: 3 }), ["below_median"]); // 10 %
  assert.deepEqual(itemRules({ bestCents: 901, medianCents: 1000, medianDays: 3 }), []);
  assert.deepEqual(itemRules({ bestCents: 500, medianCents: 1000, medianDays: 2 }), []);
});

test("series: drop only when the shop is now the cheapest (default)", () => {
  // CS Megastore 72,41 -> 67,07 while Proshop sells at 50,57: not relevant
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 6707 }, 5057), []);
  // Same drop when it becomes the cheapest
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 4990 }, 5057), ["drop"]);
  // Only shop of the item
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 950 }, null), ["drop"]);
  // Setting off: every shop
  const all = mergeRules({ only_cheapest: false });
  assert.deepEqual(seriesRules(series([7241]), { priceCents: 6707 }, 5057, all), ["drop"]);
  // Under threshold
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 960 }, null), []);
});

test("series: back in stock only for the cheapest by default", () => {
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000 }, 1200), ["back_in_stock"]);
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000 }, 900), []);
  assert.deepEqual(seriesRules(series([1000], "out_of_stock"), { priceCents: 1000, availability: "out_of_stock" }), []);
});

test("series: no drop alert while out of stock", () => {
  assert.deepEqual(seriesRules(series([1000]), { priceCents: 500, availability: "out_of_stock" }), []);
});

test("series: suspicious discount is info and independent of cheapest", () => {
  const h = series(Array(20).fill(1000));
  const c = evaluateSeriesRules({
    current: { ts: h.at(-1)!.ts + DAY / 2, priceCents: 1000, availability: "in_stock", lowest30dCents: 1300 },
    history: h,
    othersBestCents: 800,
    rules: DEFAULT_RULES,
  });
  assert.deepEqual(c.map((x) => [x.rule, x.level, x.refCents]), [["suspicious_discount", "info", 1000]]);
  assert.equal(seriesRules(series([1000, 1000, 1000]), { priceCents: 1000, lowest30dCents: 1300 }).includes("suspicious_discount"), false);
});

test("rules merge: defaults <- household <- item, and diff", () => {
  const household = { drop: { pct: 10 }, back_in_stock: false };
  const itemOverride = { drop: { enabled: false } };
  const r = mergeRules(household, itemOverride);
  assert.deepEqual(r.drop, { enabled: false, pct: 10 });
  assert.equal(r.back_in_stock, false);
  assert.equal(r.below_target, true);
  const base = mergeRules(household);
  assert.deepEqual(diffRules(r, base), { drop: { enabled: false, pct: 10 } });
  assert.deepEqual(diffRules(base, base), {});
  // Legacy single-layer call still works
  assert.equal(mergeRules({ cooldown_hours: 48 }).cooldown_hours, 48);
});

test("cooldown: again only if cheaper or 24 h passed", () => {
  const cand = { rule: "drop" as const, level: "alert" as const, priceCents: 900, refCents: 1000 };
  const now = T0 + 10 * DAY;
  assert.equal(passesCooldown(cand, undefined, now, 24), true);
  assert.equal(passesCooldown(cand, { priceCents: 900, ts: now - 3_600_000 }, now, 24), false);
  assert.equal(passesCooldown(cand, { priceCents: 950, ts: now - 3_600_000 }, now, 24), true);
  assert.equal(passesCooldown(cand, { priceCents: 900, ts: now - 25 * 3_600_000 }, now, 24), true);
});

test("describe", () => {
  assert.equal(describeAlert({ rule: "drop", level: "alert", priceCents: 99900, refCents: 129900 }), "999 €, laski 23 % (oli 1 299 €)");
});
