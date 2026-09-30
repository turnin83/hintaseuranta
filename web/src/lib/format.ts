import type { Availability } from "@shared/types.ts";
export { eur } from "@shared/rules.ts";

export function pctDelta(value: number, ref: number): number {
  return Math.round(((value - ref) / ref) * 100);
}

/** "−8 %" / "+3 %" / "±0 %" with a real minus sign. */
export function signedPct(p: number): string {
  if (p === 0) return "±0 %";
  return `${p < 0 ? "−" : "+"}${Math.abs(p)} %`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "ei vielä";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "juuri nyt";
  if (s < 3600) return `${Math.round(s / 60)} min sitten`;
  if (s < 86400) return `${Math.round(s / 3600)} h sitten`;
  const d = Math.round(s / 86400);
  return d === 1 ? "eilen" : `${d} pv sitten`;
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("fi-FI", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const AVAILABILITY: Record<Availability, string> = {
  in_stock: "Varastossa",
  limited: "Vähissä",
  backorder: "Tilattavissa",
  preorder: "Ennakkotilaus",
  out_of_stock: "Loppu",
  unknown: "Saatavuus ?",
};

export const PRIORITY: Record<number, string> = { 1: "Korkea", 2: "Normaali", 3: "Matala" };

/** Parses "1 299,90" / "1299.9" / "1299" euros to cents. */
export function parseEurInput(s: string): number | null {
  const t = s.replace(/[\s €]/g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

export function centsToInput(c: number | null | undefined): string {
  return c == null ? "" : (c / 100).toString().replace(".", ",");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
