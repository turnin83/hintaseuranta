// Alert rules. Pure functions, shared by fetch-prices and the web app.
//
// Item level (evaluated once per run on the item's best current price across shops):
//   below_target, below_median — state based: they fire when the price enters the state, and again only
//   when it falls meaningfully further or leaves and re-enters the state (never just because time passed).
//   all_time_low — a new low that is meaningfully below the previous one.
// Series level (one shop / seller): drop, back_in_stock — by default only when that shop is the cheapest
// afterwards; a drop back to a price seen in the last 7 days is a bounce, not an alert.
// Everything one run finds for an item becomes ONE event (buildEvent) with a headline, reasons and an
// optional warning; whether it is pushed depends on how significant it is (push_min_pct).
//
// Rules are merged DEFAULT_RULES <- household defaults <- item overrides; items store only overrides.
import type { Availability } from "./types.ts";

export type RuleName =
  | "below_target"
  | "all_time_low"
  | "below_median"
  | "drop"
  | "back_in_stock"
  | "suspicious_discount" // legacy rows only; shown now as a price note, not an alert
  | "price_after_purchase"
  | "link_broken";

export type Rules = {
  below_target: boolean;
  all_time_low: { enabled: boolean; min_obs: number };
  below_median: { enabled: boolean; pct: number };
  drop: { enabled: boolean; pct: number };
  back_in_stock: boolean;
  /** drop / back_in_stock only when the shop is (one of) the cheapest for the item afterwards */
  only_cheapest: boolean;
  /** push when a discount (below usual price / drop) is at least this; smaller ones go to the list only */
  push_min_pct: number;
  /** a shop's drop / back-in-stock repeats at the earliest after this, unless the price falls further */
  cooldown_hours: number;
};

export const DEFAULT_RULES: Rules = {
  below_target: true,
  all_time_low: { enabled: true, min_obs: 6 },
  below_median: { enabled: true, pct: 10 },
  drop: { enabled: true, pct: 5 },
  back_in_stock: true,
  only_cheapest: true,
  push_min_pct: 20,
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
      only_cheapest: p.only_cheapest ?? r.only_cheapest,
      push_min_pct: p.push_min_pct ?? r.push_min_pct,
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

/** A change worth telling: at least 1 € and 1 %. */
export function meaningfulDrop(fromCents: number, toCents: number): boolean {
  return fromCents - toCents >= 100 && toCents <= fromCents * 0.99;
}

export function pctBelow(priceCents: number, refCents: number): number {
  return Math.round((1 - priceCents / refCents) * 100);
}

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

type StateEntry = { on: boolean; last: number | null };
/** Stored per item (wish_items.alert_state); null = never evaluated (first run only records it). */
export type ItemAlertState = { below_target?: StateEntry; below_median?: StateEntry };

export function evaluateItemRules(
  s: ItemState,
  rules: Rules,
  prev: ItemAlertState | null,
): { candidates: AlertCandidate[]; next: ItemAlertState } {
  const candidates: AlertCandidate[] = [];
  const next: ItemAlertState = { ...(prev ?? {}) };
  const p = s.bestCents;
  if (p == null) return { candidates, next };

  // Fires on entering the state, or when the price falls meaningfully below the last alerted price.
  const stateRule = (key: keyof ItemAlertState, active: boolean, ref: number | null) => {
    const was = prev?.[key];
    if (!active) {
      next[key] = { on: false, last: was?.last ?? null };
      return;
    }
    const fire = prev != null && (!was?.on || (was.last != null && meaningfulDrop(was.last, p)));
    next[key] = { on: true, last: fire || was?.last == null ? p : was.last };
    if (fire) candidates.push({ rule: key as RuleName, level: "alert", priceCents: p, refCents: ref });
  };

  stateRule("below_target", rules.below_target && s.targetCents != null && p <= s.targetCents, s.targetCents);
  stateRule(
    "below_median",
    rules.below_median.enabled && s.medianCents != null && s.medianDays >= 3 &&
      p <= s.medianCents * (1 - rules.below_median.pct / 100),
    s.medianCents,
  );
  if (
    rules.all_time_low.enabled && s.prevMinCents != null && s.prevObsCount + 1 >= rules.all_time_low.min_obs &&
    meaningfulDrop(s.prevMinCents, p)
  ) {
    candidates.push({ rule: "all_time_low", level: "alert", priceCents: p, refCents: s.prevMinCents });
  }
  return { candidates, next };
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

  // A drop back to a price this shop already had during the last 7 days is a bounce (e.g. a raise before
  // a "sale"), not a new opportunity.
  const recentLow = Math.min(...history.filter((o) => o.ts >= current.ts - 7 * DAY).map((o) => o.priceCents));
  const bounce = Number.isFinite(recentLow) && recentLow <= price;

  if (
    available && relevant && !bounce && rules.drop.enabled && prev &&
    price <= prev.priceCents * (1 - rules.drop.pct / 100) && meaningfulDrop(prev.priceCents, price)
  ) {
    out.push({ rule: "drop", level: "alert", priceCents: price, refCents: prev.priceCents });
  }
  if (
    relevant && rules.back_in_stock && prev && UNAVAILABLE.includes(prev.availability) &&
    (current.availability === "in_stock" || current.availability === "limited")
  ) {
    out.push({ rule: "back_in_stock", level: "alert", priceCents: price, refCents: null });
  }
  return out;
}

/** Our own lowest price for a series in the 30 days before `current` (null with under 7 days of data). */
export function ownLow30d(history: Obs[], currentTs: number): number | null {
  const last30 = history.filter((o) => o.ts >= currentTs - 30 * DAY && o.ts < currentTs);
  if (last30.length < 3) return null;
  const span = (currentTs - Math.min(...last30.map((o) => o.ts))) / DAY;
  return span >= 7 ? Math.min(...last30.map((o) => o.priceCents)) : null;
}

// ---------------------------------------------------------------------------
// Shop's "before" price vs our own history
// ---------------------------------------------------------------------------

export type ClaimVerdict = {
  kind: "fake" | "exaggerated" | "ok";
  claimCents: number; // shop's "before" / lowest-30-days price
  ownLowCents: number; // our lowest price in the 30 days before
  claimPct: number; // discount the shop advertises
  realPct: number; // discount compared with our own history (0 = none)
};

export function claimCheck(priceCents: number, claimCents: number | null, ownLowCents: number | null): ClaimVerdict | null {
  if (claimCents == null || ownLowCents == null || claimCents <= priceCents) return null;
  const claimPct = pctBelow(priceCents, claimCents);
  if (ownLowCents <= priceCents) return { kind: "fake", claimCents, ownLowCents, claimPct, realPct: 0 };
  if (ownLowCents < claimCents * 0.97) {
    return { kind: "exaggerated", claimCents, ownLowCents, claimPct, realPct: pctBelow(priceCents, ownLowCents) };
  }
  return { kind: "ok", claimCents, ownLowCents, claimPct, realPct: claimPct };
}

export function describeClaim(v: ClaimVerdict): string {
  if (v.kind === "fake") {
    return `Ei oikea alennus: kauppa ilmoittaa ennen-hinnaksi ${eur(v.claimCents)} (−${v.claimPct} %), mutta hinta oli ${eur(v.ownLowCents)} jo 30 päivän sisällä.`;
  }
  if (v.kind === "exaggerated") {
    return `Alennus liioiteltu: kauppa −${v.claimPct} % (ennen ${eur(v.claimCents)}), oikeasti −${v.realPct} % (alin 30 pv ${eur(v.ownLowCents)}).`;
  }
  return `Kaupan ennen-hinta ${eur(v.claimCents)} täsmää seurantaan.`;
}

// ---------------------------------------------------------------------------
// Purchased items
// ---------------------------------------------------------------------------

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

/** Cooldown for shop-level rules: again only if the price fell further or the cooldown has passed. */
export function passesCooldown(c: AlertCandidate, prev: PrevAlert | undefined, now: number, cooldownHours: number) {
  if (!prev) return true;
  if (c.priceCents < prev.priceCents) return true;
  return now - prev.ts >= cooldownHours * 3_600_000;
}

// ---------------------------------------------------------------------------
// One readable event per item and run
// ---------------------------------------------------------------------------

// Deterministic Finnish euro format (ICU output varies between runtimes): 1299.9 -> "1 299,90 €".
// Spaces are non-breaking so an amount never wraps across lines.
const NBSP = String.fromCharCode(0xa0);
export function eur(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const frac = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${whole}${frac ? "," + String(frac).padStart(2, "0") : ""}${NBSP}€`;
}

/** One reason found in a run; link/series identify it for cooldowns. */
export type Reason = AlertCandidate & { seller: string; link: string; series: string };

export type EventDraft = {
  rule: RuleName; // primary reason
  rules: RuleName[];
  priceCents: number;
  refCents: number | null;
  seller: string;
  link: string;
  series: string;
  headline: string;
  lines: string[];
  warning: string | null;
  notify: boolean;
  /** plain text for old clients and push bodies */
  message: string;
};

const PRIORITY: RuleName[] = [
  "price_after_purchase",
  "below_target",
  "all_time_low",
  "below_median",
  "drop",
  "back_in_stock",
  "link_broken",
];
const ALWAYS_PUSH: RuleName[] = ["price_after_purchase", "below_target", "all_time_low", "back_in_stock", "link_broken"];

function headlineOf(r: Reason): string {
  const p = eur(r.priceCents);
  switch (r.rule) {
    case "price_after_purchase":
      return `Hinta laski ostoksen jälkeen: ${p}`;
    case "below_target":
      return `Alle tavoitehinnan: ${p}`;
    case "all_time_low":
      return `Uusi alin hinta: ${p}`;
    case "below_median":
      return `${pctBelow(r.priceCents, r.refCents!)} % tavallista halvempi: ${p}`;
    case "drop":
      return `Hinta laski: ${eur(r.refCents!)} → ${p}`;
    case "back_in_stock":
      return `Taas saatavilla: ${p}`;
    case "link_broken":
      return `Linkki ei toimi: ${r.seller}`;
    default:
      return p;
  }
}

/** Detail line: for the primary reason it explains the headline, for others it is a short add-on. */
function lineOf(r: Reason, primary: boolean, primarySeller: string): string {
  const ref = r.refCents != null ? eur(r.refCents) : "";
  const other = r.seller !== primarySeller ? ` (${r.seller})` : "";
  switch (r.rule) {
    case "price_after_purchase":
      return `Maksoit ${ref}, nyt ${eur(r.refCents! - r.priceCents)} halvempi. Tarkista palautusoikeus tai hintatakuu.`;
    case "below_target":
      return primary ? `Tavoite ${ref}` : `Alittaa tavoitteen ${ref}`;
    case "all_time_low":
      return primary ? `Aiempi alin ${ref}` : `Uusi alin hinta (aiempi ${ref})`;
    case "below_median":
      return primary
        ? `Tavallinen hinta ${ref} (30 pv mediaani)`
        : `${pctBelow(r.priceCents, r.refCents!)} % alle tavallisen ${ref}`;
    case "drop":
      return primary
        ? `Laski ${pctBelow(r.priceCents, r.refCents!)} %${other}`
        : `Laski ${ref} → ${eur(r.priceCents)}${other}`;
    case "back_in_stock":
      return `Taas varastossa${other}`;
    case "link_broken":
      return "Ei hintaa yli vuorokauteen. Tarkista tai poista linkki.";
    default:
      return "";
  }
}

/**
 * Merge a run's reasons for one item into one event.
 * `inflated` = the price was clearly lower within 60 days, so "below usual" / "drop" are not pushed.
 */
export function buildEvent(
  reasons: Reason[],
  opts: { pushMinPct: number; warnings?: (string | null)[]; inflated?: boolean },
): EventDraft | null {
  if (reasons.length === 0) return null;
  const sorted = [...reasons].sort((a, b) => PRIORITY.indexOf(a.rule) - PRIORITY.indexOf(b.rule));
  // One reason per rule (e.g. two shops dropping): keep the cheapest.
  const byRule = new Map<RuleName, Reason>();
  for (const r of sorted) {
    const had = byRule.get(r.rule);
    if (!had || r.priceCents < had.priceCents) byRule.set(r.rule, r);
  }
  const uniq = [...byRule.values()];
  const primary = uniq[0];
  const lines = [lineOf(primary, true, primary.seller), ...uniq.slice(1).map((r) => lineOf(r, false, primary.seller))]
    .filter(Boolean);
  const warning = (opts.warnings ?? []).filter((w): w is string => Boolean(w)).join(" ") || null;
  const significant = (r: Reason) =>
    ALWAYS_PUSH.includes(r.rule) ||
    (!opts.inflated && (r.rule === "below_median" || r.rule === "drop") && r.refCents != null &&
      pctBelow(r.priceCents, r.refCents) >= opts.pushMinPct);
  const headline = headlineOf(primary);
  return {
    rule: primary.rule,
    rules: uniq.map((r) => r.rule),
    priceCents: primary.priceCents,
    refCents: primary.refCents,
    seller: primary.seller,
    link: primary.link,
    series: primary.series,
    headline,
    lines,
    warning,
    notify: uniq.some(significant),
    message: [headline, ...lines].join(" · "),
  };
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
