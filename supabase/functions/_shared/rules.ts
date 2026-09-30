// Alert rules. Pure functions: evaluated per price series (product link + seller).
import type { Availability } from "./types.ts";

export type RuleName =
  | "below_target"
  | "all_time_low"
  | "below_median"
  | "drop"
  | "back_in_stock"
  | "suspicious_discount";

export type Rules = {
  below_target: boolean;
  all_time_low: { enabled: boolean; min_obs: number };
  below_median: { enabled: boolean; pct: number };
  drop: { enabled: boolean; pct: number };
  back_in_stock: boolean;
  suspicious: boolean;
  cooldown_hours: number;
};

export const DEFAULT_RULES: Rules = {
  below_target: true,
  all_time_low: { enabled: true, min_obs: 6 },
  below_median: { enabled: true, pct: 10 },
  drop: { enabled: true, pct: 5 },
  back_in_stock: true,
  suspicious: true,
  cooldown_hours: 24,
};

export function mergeRules(partial: unknown): Rules {
  const p = (partial && typeof partial === "object" ? partial : {}) as Partial<Rules>;
  return {
    below_target: p.below_target ?? DEFAULT_RULES.below_target,
    all_time_low: { ...DEFAULT_RULES.all_time_low, ...(p.all_time_low ?? {}) },
    below_median: { ...DEFAULT_RULES.below_median, ...(p.below_median ?? {}) },
    drop: { ...DEFAULT_RULES.drop, ...(p.drop ?? {}) },
    back_in_stock: p.back_in_stock ?? DEFAULT_RULES.back_in_stock,
    suspicious: p.suspicious ?? DEFAULT_RULES.suspicious,
    cooldown_hours: p.cooldown_hours ?? DEFAULT_RULES.cooldown_hours,
  };
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
const PURCHASABLE: Availability[] = ["in_stock", "limited", "backorder", "preorder", "unknown"];
const UNAVAILABLE: Availability[] = ["out_of_stock"];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Evaluate rules for the newest observation of one series.
 * `history` = earlier observations of the same series (any order), excluding `current`.
 */
export function evaluateRules(args: {
  current: Obs;
  history: Obs[];
  targetCents: number | null;
  rules: Rules;
}): AlertCandidate[] {
  const { current, rules, targetCents } = args;
  const history = [...args.history].sort((a, b) => a.ts - b.ts);
  const out: AlertCandidate[] = [];
  const price = current.priceCents;
  const buyable = PURCHASABLE.includes(current.availability);
  const prev = history.at(-1);
  const last30 = history.filter((o) => o.ts >= current.ts - 30 * DAY);

  if (buyable) {
    if (rules.below_target && targetCents != null && price <= targetCents) {
      out.push({ rule: "below_target", level: "alert", priceCents: price, refCents: targetCents });
    }
    if (rules.all_time_low.enabled && history.length + 1 >= rules.all_time_low.min_obs) {
      const min = Math.min(...history.map((o) => o.priceCents));
      if (price < min) out.push({ rule: "all_time_low", level: "alert", priceCents: price, refCents: min });
    }
    if (rules.below_median.enabled && last30.length >= 3) {
      const med = median(last30.map((o) => o.priceCents))!;
      if (price <= med * (1 - rules.below_median.pct / 100)) {
        out.push({ rule: "below_median", level: "alert", priceCents: price, refCents: med });
      }
    }
    if (rules.drop.enabled && prev && price <= prev.priceCents * (1 - rules.drop.pct / 100)) {
      out.push({ rule: "drop", level: "alert", priceCents: price, refCents: prev.priceCents });
    }
  }

  if (
    rules.back_in_stock && prev && UNAVAILABLE.includes(prev.availability) &&
    (current.availability === "in_stock" || current.availability === "limited")
  ) {
    out.push({ rule: "back_in_stock", level: "alert", priceCents: price, refCents: null });
  }

  // Shop claims a discount, but our own 30-day history already had the same or a lower price.
  if (rules.suspicious && current.lowest30dCents != null && current.lowest30dCents > price && last30.length >= 3) {
    const spanDays = (current.ts - last30[0].ts) / DAY;
    const ownMin = Math.min(...last30.map((o) => o.priceCents));
    if (spanDays >= 7 && ownMin <= price) {
      out.push({ rule: "suspicious_discount", level: "info", priceCents: price, refCents: ownMin });
    }
  }

  return out;
}

/** Cooldown: same rule on the same series fires again only if price fell further or cooldown passed. */
export function passesCooldown(c: AlertCandidate, prev: PrevAlert | undefined, now: number, cooldownHours: number) {
  if (!prev) return true;
  if (c.priceCents < prev.priceCents) return true;
  return now - prev.ts >= cooldownHours * 3_600_000;
}

// Deterministic Finnish euro format (ICU output varies between runtimes): 1299.9 -> "1 299,90 €"
export function eur(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${whole}${frac ? "," + String(frac).padStart(2, "0") : ""} €`;
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
  }
}

export const RULE_LABELS: Record<RuleName, string> = {
  below_target: "Alle tavoitehinnan",
  all_time_low: "Kaikkien aikojen alin",
  below_median: "Alle 30 pv mediaanin",
  drop: "Hinnanpudotus",
  back_in_stock: "Palasi varastoon",
  suspicious_discount: "Epäilyttävä tarjous",
};
