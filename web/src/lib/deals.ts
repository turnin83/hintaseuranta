// Deal assessment: how good is the item's best current price compared with its own history,
// and should we recommend buying now. Used by the Deals view and the item page.
import type { CrossCheck, WishSummary } from "./types.ts";
// Relative path (not @shared) so the Node unit tests can import this module too.
import { claimCheck, describeClaim, eur, meaningfulDrop } from "../../../supabase/functions/_shared/rules.ts";

export type Tier = "must" | "excellent" | "good" | "small";
export type Recommendation = "buy" | "consider";

export const TIERS: { tier: Tier; min: number; label: string; heading: string }[] = [
  { tier: "must", min: 60, label: "Pakko ostaa", heading: "Pakko ostaa · vähintään 60 % alle tavallisen" },
  { tier: "excellent", min: 40, label: "Erinomainen tarjous", heading: "Erinomaiset · 40–59 %" },
  { tier: "good", min: 20, label: "Hyvä tarjous", heading: "Hyvät · 20–39 %" },
  { tier: "small", min: 5, label: "Pieni alennus", heading: "Pienet alennukset · 5–19 %" },
];

const MIN_OBS = 6; // same default as the all-time-low alert rule

export type DealAssessment = {
  discountPct: number | null; // vs the item's 30 d median ("tavallinen hinta"), positive = cheaper
  tier: Tier | null;
  targetHit: boolean;
  allTimeLow: boolean;
  recommendation: Recommendation | null;
  reasons: string[];
  /** Things that may make the deal look better than it is (misleading "before" price, lower earlier). */
  warnings: string[];
  lowConfidence: boolean;
  score: number;
};

export function assessDeal(i: WishSummary, obsCount: number): DealAssessment {
  const p = i.best_price_cents;
  const none: DealAssessment = {
    discountPct: null, tier: null, targetHit: false, allTimeLow: false, recommendation: null, reasons: [],
    warnings: [], lowConfidence: true, score: 0,
  };
  if (p == null || i.best_availability === "out_of_stock" || i.purchased_at) return none;

  const med = i.median_30d_cents;
  const discountPct = med ? Math.round(((med - p) / med) * 100) : null;
  const tier = discountPct == null ? null : TIERS.find((t) => discountPct >= t.min)?.tier ?? null;
  const targetHit = i.target_price_cents != null && p <= i.target_price_cents;
  // "All-time low" only when the price really is below its usual level, not merely unchanged.
  const allTimeLow = i.min_all_cents != null && p <= i.min_all_cents && med != null && p < med * 0.98 && obsCount >= MIN_OBS;
  const lowConfidence = med == null || obsCount < MIN_OBS;

  const warnings: string[] = [];
  const claim = claimCheck(p, i.best_claim_cents, i.best_own_low_cents);
  if (claim && claim.kind !== "ok") warnings.push(describeClaim(claim));
  // Price raised and then "discounted": the usual price looks high, but we have seen it clearly lower.
  const wasLower = i.min_all_cents != null && meaningfulDrop(p, i.min_all_cents) && p > i.min_all_cents * 1.03;
  if (wasLower) warnings.push(`Hinta on ollut alempi: ${eur(i.min_all_cents!)}.`);

  const reasons: string[] = [];
  // After a raise the 30-day median isn't a "usual" price, so say only what it is.
  if (discountPct != null && discountPct >= 5)
    reasons.push(`${discountPct} % alle ${wasLower ? "viime aikojen" : "tavallisen"} hinnan`);
  if (allTimeLow) reasons.push("halvin koskaan seurattu hinta");
  if (targetHit) reasons.push("alittaa tavoitehinnan");

  let recommendation: Recommendation | null = null;
  if ((discountPct ?? 0) >= 40 || targetHit || (allTimeLow && (discountPct ?? 0) >= 15)) recommendation = "buy";
  else if ((discountPct ?? 0) >= 20 || allTimeLow) recommendation = "consider";
  // Only the user's own target overrides a misleading-looking discount.
  if (recommendation === "buy" && !targetHit && (wasLower || claim?.kind === "fake")) recommendation = "consider";

  const score = (discountPct ?? 0) + (targetHit ? 15 : 0) + (allTimeLow ? 10 : 0) - (warnings.length ? 10 : 0);
  return { discountPct, tier, targetHit, allTimeLow, recommendation, reasons, warnings, lowConfidence, score };
}

const HOUR = 3_600_000;

/**
 * A comparison page shows a clearly different price for the same shop (over 5 % and at least 1 €, both
 * readings within 6 h of each other and from the last 36 h): the shop page may have been misread.
 */
export function priceMismatch(priceCents: number, priceTs: string, x: CrossCheck | null | undefined, now = Date.now()): CrossCheck | null {
  if (!x) return null;
  const t = Date.parse(x.ts);
  if (now - t > 36 * HOUR || Math.abs(t - Date.parse(priceTs)) > 6 * HOUR) return null;
  const diff = Math.abs(x.cents - priceCents);
  return diff >= 100 && diff > priceCents * 0.05 ? x : null;
}

export function isDeal(d: DealAssessment): boolean {
  return d.tier != null || d.targetHit || d.allTimeLow;
}
