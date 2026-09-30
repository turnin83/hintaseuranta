import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RULES,
  describeAlert,
  evaluateRules,
  median,
  mergeRules,
  passesCooldown,
  type Obs,
  type Rules,
} from "../supabase/functions/_shared/rules.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

/** Twice-daily history: prices[i] observed at T0 + i * 12h. */
function series(prices: number[], availability: Obs["availability"] = "in_stock"): Obs[] {
  return prices.map((p, i) => ({ ts: T0 + i * DAY / 2, priceCents: p, availability, lowest30dCents: null }));
}

function run(history: Obs[], current: Partial<Obs> & { priceCents: number }, rules: Rules = DEFAULT_RULES, target: number | null = null) {
  const ts = (history.at(-1)?.ts ?? T0) + DAY / 2;
  return evaluateRules({
    current: { ts, availability: "in_stock", lowest30dCents: null, ...current },
    history,
    targetCents: target,
    rules,
  }).map((c) => c.rule);
}

test("median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // rounds 2.5 -> 3
  assert.equal(median([]), null);
});

test("below target", () => {
  assert.deepEqual(run(series([100000, 100000]), { priceCents: 90000 }, DEFAULT_RULES, 95000).includes("below_target"), true);
  assert.deepEqual(run(series([100000, 100000]), { priceCents: 96000 }, DEFAULT_RULES, 95000).includes("below_target"), false);
  assert.equal(run([], { priceCents: 95000 }, DEFAULT_RULES, 95000).includes("below_target"), true); // equal counts
});

test("all-time low requires N observations", () => {
  const h = series([1000, 1000, 1000, 1000]); // 4 + current = 5 < 6
  assert.equal(run(h, { priceCents: 900 }).includes("all_time_low"), false);
  const h2 = series([1000, 1000, 1000, 1000, 1000]); // 5 + current = 6
  assert.equal(run(h2, { priceCents: 900 }).includes("all_time_low"), true);
  assert.equal(run(h2, { priceCents: 1000 }).includes("all_time_low"), false); // equal is not new low
});

test("below 30-day median by X %", () => {
  const h = series([1000, 1000, 1000, 1000]);
  assert.equal(run(h, { priceCents: 900 }).includes("below_median"), true); // exactly 10 %
  assert.equal(run(h, { priceCents: 901 }).includes("below_median"), false);
  // Observations older than 30 d are ignored: only 2 recent -> not enough data
  const old = [...series([500, 500, 500]).map((o) => ({ ...o, ts: o.ts - 60 * DAY })), ...series([1000, 1000])];
  assert.equal(run(old, { priceCents: 800 }).includes("below_median"), false);
});

test("drop vs previous observation", () => {
  assert.equal(run(series([1000]), { priceCents: 950 }).includes("drop"), true); // 5 %
  assert.equal(run(series([1000]), { priceCents: 960 }).includes("drop"), false);
  assert.equal(run([], { priceCents: 1 }).includes("drop"), false);
});

test("back in stock", () => {
  assert.deepEqual(run(series([1000], "out_of_stock"), { priceCents: 1000 }), ["back_in_stock"]);
  assert.equal(run(series([1000], "in_stock"), { priceCents: 1000 }).includes("back_in_stock"), false);
  assert.equal(run(series([1000], "out_of_stock"), { priceCents: 1000, availability: "out_of_stock" }).length, 0);
});

test("price alerts suppressed while out of stock", () => {
  const r = run(series([1000, 1000, 1000, 1000, 1000]), { priceCents: 500, availability: "out_of_stock" }, DEFAULT_RULES, 900);
  assert.deepEqual(r, []);
});

test("suspicious discount: shop claims discount but own history had same price", () => {
  // 20 obs over 10 days at 1000, then a "campaign" claiming ref 1300 at 1000.
  const h = series(Array(20).fill(1000));
  const c = evaluateRules({
    current: { ts: h.at(-1)!.ts + DAY / 2, priceCents: 1000, availability: "in_stock", lowest30dCents: 1300 },
    history: h,
    targetCents: null,
    rules: DEFAULT_RULES,
  });
  const s = c.find((x) => x.rule === "suspicious_discount")!;
  assert.equal(s.level, "info");
  assert.equal(s.refCents, 1000);
  // Real discount (below own history) is not suspicious
  const real = run(h, { priceCents: 900, lowest30dCents: 1000 });
  assert.equal(real.includes("suspicious_discount"), false);
  // Too little history (<7 days span) -> no verdict
  assert.equal(run(series([1000, 1000, 1000]), { priceCents: 1000, lowest30dCents: 1300 }).includes("suspicious_discount"), false);
});

test("rules can be disabled per item", () => {
  const rules = mergeRules({ drop: { enabled: false }, below_median: { pct: 50 } });
  assert.equal(rules.drop.pct, 5);
  assert.equal(run(series([1000, 1000, 1000]), { priceCents: 800 }, rules).includes("drop"), false);
  assert.equal(run(series([1000, 1000, 1000]), { priceCents: 800 }, rules).includes("below_median"), false);
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
