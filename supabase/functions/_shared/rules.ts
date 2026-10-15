// Alert rules. Pure functions.
//
// Item level (one alert per product, evaluated on the item's best current price across all shops):
//   below_target, all_time_low, below_median
// Series level (one shop / seller): drop, back_in_stock — by default only when that shop is now the
// cheapest for the item — and suspicious_discount (info, no push).
//
// Rules are merged DEFAULT_RULES <- household defaults <- item overrides; items store only overrides.
import type { Availability } from "./types.ts";

export type RuleName =
  | "below_target"
  | "all_time_low"
  | "below_median"
  | "drop"
  | "back_in_stock"
  | "suspicious_discount"
  | "price_after_purchase"
  | "link_broken";

export const ITEM_RULES: RuleName[] = ["below_target", "all_time_low", "below_median"];

export type Rules = {
  below_target: boolean;
  all_time_low: { enabled: boolean; min_obs: number };
  below_median: { enabled: boolean; pct: number };
  drop: { enabled: boolean; pct: number };
  back_in_stock: boolean;
  suspicious: boolean;
  /** drop / back_in_stock only when the shop is (one of) the cheapest for the item afterwards */
  only_cheapest: boolean;
  cooldown_hours: number;
};

export const DEFAULT_RULES: Rules = {
  below_target: true,
  all_time_low: { enabled: true, min_obs: 6 },
  below_median: { enabled: true, pct: 10 },
  drop: { enabled: true, pct: 5 },
  back_in_stock: true,
  suspicious: true,
  only_cheapest: true,
  cooldown_hours: 24,
};

type Partialish = Partial<Omit<Rules, "all_time_low" | "below_median" | "drop">> & {
  all_time_low?: Partial<Rules["all_time_low"]>;
  below_median?: Partial<Rules["below_median"]>;
  drop?: Partial<Rules["drop"]>;
};

function asPartial(v: unknown): Partialish {
  return (v && typeof v === "object" ? v : {}) as Partialish;
}

/** DEFAULT_RULES <- each layer in order (household defaults, then item overrides). */
export function mergeRules(...layers: unknown[]): Rules {
  let r: Rules = structuredClone(DEFAULT_RULES);
  for (const layer of layers) {
    const p = asPartial(layer);
    r = {
      below_target: p.below_target ?? r.below_target,
      all_time_low: { ...r.all_time_low, ...(p.all_time_low ?? {}) },
      below_median: { ...r.below_median, ...(p.below_median ?? {}) },
      drop: { ...r.drop, ...(p.drop ?? {}) },
      back_in_stock: p.back_in_stock ?? r.back_in_stock,
      suspicious: p.suspicious ?? r.suspicious,
      only_cheapest: p.only_cheapest ?? r.only_cheapest,
      cooldown_hours: p.cooldown_hours ?? r.cooldown_hours,
    };
  }
  return r;
}

/** The part of `rules` that differs from `base` (what an item override needs to store). */
export function diffRules(rules: Rules, base: Rules): Partialish {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rules) as (keyof Rules)[]) {
    if (JSON.stringify(rules[k]) !== JSON.stringify(base[k])) out[k] = rules[k];
  }
  return out as Partialish;
}

export type Obs = {
  ts: number; // epoch ms
  priceCents: number;
  availability: Availability;
  lowest30dCents: number | null;
};

export type PrevAlert = { priceCents: number; ts: number };

export type AlertCandidate = {
  rule: RuleName;
  level: "alert" | "info";
  priceCents: number;
  refCents: number | null; // what it was compared against
};

const DAY = 86_400_000;
const UNAVAILABLE: Availability[] = ["out_of_stock"];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Median of per-day minimum prices (in-stock observations), as used by the UI and item rules. */
export function dailyMinMedian(obs: Obs[]): { median: number | null; days: number } {
  const byDay = new Map<string, number>();
  for (const o of obs) {
    if (UNAVAILABLE.includes(o.availability)) continue;
    const d = new Date(o.ts).toISOString().slice(0, 10);
    byDay.set(d, Math.min(byDay.get(d) ?? Infinity, o.priceCents));
  }
  return { median: median([...byDay.values()]), days: byDay.size };
}

// ---------------------------------------------------------------------------
// Item level
// ---------------------------------------------------------------------------

export type ItemState = {
  /** Best current price across tracked, fresh, not-out-of-stock offers. */
  bestCents: number | null;
  /** Lowest price ever observed for the item before this run (any shop). */
  prevMinCents: number | null;
  /** Number of observations before this run (any shop). */
  prevObsCount: number;
  /** 30-day median of daily minimums before this run, and how many days it covers. */
  medianCents: number | null;
  medianDays: number;
  targetCents: number | null;
};

export function evaluateItemRules(s: ItemState, rules: Rules): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const p = s.bestCents;
  if (p == null) return out;
  if (rules.below_target && s.targetCents != null && p <= s.targetCents) {
    out.push({ rule: "below_target", level: "alert", priceCents: p, refCents: s.targetCents });
  }
  if (
    rules.all_time_low.enabled && s.prevMinCents != null && s.prevObsCount + 1 >= rules.all_time_low.min_obs &&
    p < s.prevMinCents
  ) {
    out.push({ rule: "all_time_low", level: "alert", priceCents: p, refCents: s.prevMinCents });
  }
  if (
    rules.below_median.enabled && s.medianCents != null && s.medianDays >= 3 &&
    p <= s.medianCents * (1 - rules.below_median.pct / 100)
  ) {
    out.push({ rule: "below_median", level: "alert", priceCents: p, refCents: s.medianCents });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Series level
// ---------------------------------------------------------------------------

/**
 * Evaluate the newest observation of one shop/seller.
 * `history` = earlier observations of the same series (any order), excluding `current`.
 * `othersBestCents` = cheapest current price among the item's other tracked, available offers.
 */
export function evaluateSeriesRules(args: {
  current: Obs;
  history: Obs[];
  othersBestCents: number | null;
  rules: Rules;
}): AlertCandidate[] {
  const { current, rules } = args;
  const history = [...args.history].sort((a, b) => a.ts - b.ts);
  const out: AlertCandidate[] = [];
  const price = current.priceCents;
  const prev = history.at(-1);
  const available = !UNAVAILABLE.includes(current.availability);
  const cheapest = args.othersBestCents == null || price <= args.othersBestCents;
  const relevant = !rules.only_cheapest || cheapest;

  if (available && relevant && rules.drop.enabled && prev && price <= prev.priceCents * (1 - rules.drop.pct / 100)) {
    out.push({ rule: "drop", level: "alert", priceCents: price, refCents: prev.priceCents });
  }
  if (
    relevant && rules.back_in_stock && prev && UNAVAILABLE.includes(prev.availability) &&
    (current.availability === "in_stock" || current.availability === "limited")
  ) {
    out.push({ rule: "back_in_stock", level: "alert", priceCents: price, refCents: null });
  }

  // Shop claims a discount, but our own 30-day history already had the same or a lower price.
  const last30 = history.filter((o) => o.ts >= current.ts - 30 * DAY);
  if (rules.suspicious && current.lowest30dCents != null && current.lowest30dCents > price && last30.length >= 3) {
    const spanDays = (current.ts - last30[0].ts) / DAY;
    const ownMin = Math.min(...last30.map((o) => o.priceCents));
    if (spanDays >= 7 && ownMin <= price) {
      out.push({ rule: "suspicious_discount", level: "info", priceCents: price, refCents: ownMin });
    }
  }
  return out;
}

/** Days a purchased item is still watched for a price drop (return right / price guarantee). */
export const AFTER_PURCHASE_DAYS = 30;

/**
 * Purchased item: alert when the best current price is clearly below what was paid
 * (at least 2 % and 1 €, so cent-level noise does not trigger it).
 */
export function evaluateAfterPurchase(bestCents: number | null, paidCents: number | null): AlertCandidate | null {
  if (bestCents == null || paidCents == null) return null;
  const diff = paidCents - bestCents;
  if (diff < 100 || bestCents > paidCents * 0.98) return null;
  return { rule: "price_after_purchase", level: "alert", priceCents: bestCents, refCents: paidCents };
}

/** Cooldown: the same rule fires again only if the price fell further or the cooldown has passed. */
export function passesCooldown(c: AlertCandidate, prev: PrevAlert | undefined, now: number, cooldownHours: number) {
  if (!prev) return true;
  if (c.priceCents < prev.priceCents) return true;
  return now - prev.ts >= cooldownHours * 3_600_000;
}

// Deterministic Finnish euro format (ICU output varies between runtimes): 1299.9 -> "1 299,90 €".
// Spaces are non-breaking so an amount never wraps across lines.
const NBSP = String.fromCharCode(0xa0);
export function eur(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const frac = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${whole}${frac ? "," + String(frac).padStart(2, "0") : ""}${NBSP}€`;
}

export function describeAlert(c: AlertCandidate): string {
  const p = eur(c.priceCents);
  const r = c.refCents != null ? eur(c.refCents) : "";
  switch (c.rule) {
    case "below_target":
      return `${p}, alle tavoitehinnan ${r}`;
    case "all_time_low":
      return `${p}, uusi alin hinta (aiempi alin ${r})`;
    case "below_median":
      return `${p}, ${Math.round((1 - c.priceCents / c.refCents!) * 100)} % alle 30 pv mediaanin ${r}`;
    case "drop":
      return `${p}, laski ${Math.round((1 - c.priceCents / c.refCents!) * 100)} % (oli ${r})`;
    case "back_in_stock":
      return `Taas saatavilla, ${p}`;
    case "suspicious_discount":
      return `Kauppa ilmoittaa alennuksen, mutta hinta oli 30 pv sisällä jo ${r}`;
    case "price_after_purchase":
      return `Hinta laski ostoksen jälkeen: nyt ${p}, ostit ${r}. Tarkista palautusoikeus tai hintatakuu (${eur(c.refCents! - c.priceCents)}).`;
    case "link_broken":
      return "Linkki ei ole antanut hintaa yli vuorokauteen";
  }
}

export const RULE_LABELS: Record<RuleName, string> = {
  below_target: "Alle tavoitehinnan",
  all_time_low: "Kaikkien aikojen alin",
  below_median: "Alle 30 pv mediaanin",
  drop: "Hinnanpudotus",
  back_in_stock: "Palasi varastoon",
  suspicious_discount: "Epäilyttävä tarjous",
  price_after_purchase: "Hinta laski ostoksen jälkeen",
  link_broken: "Linkki ei toimi",
};
