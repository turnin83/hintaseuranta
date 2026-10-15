import { signal } from "@preact/signals";
import { supabase } from "./supabase.ts";

export type Campaign = {
  id: number;
  name: string;
  starts_on: string; // YYYY-MM-DD
  ends_on: string;
  fetch_interval_minutes: number;
  active: boolean;
};

/** Local date as YYYY-MM-DD (campaign dates are calendar days in the household's time zone). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isRunning(c: Campaign, on = today()): boolean {
  return c.active && c.starts_on <= on && on <= c.ends_on;
}

export function fiDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.`;
}

export function intervalLabel(min: number): string {
  if (min % 60 === 0) return min === 60 ? "tunnin välein" : `${min / 60} h välein`;
  return `${min} min välein`;
}

/** Campaign running today (shortest interval wins), shared by the views. */
export const runningCampaign = signal<Campaign | null>(null);

export async function refreshCampaigns(): Promise<Campaign[]> {
  const { data } = await supabase.from("campaigns").select("*").order("starts_on");
  const list = (data ?? []) as Campaign[];
  const running = list.filter((c) => isRunning(c)).sort((a, b) => a.fetch_interval_minutes - b.fetch_interval_minutes);
  runningCampaign.value = running[0] ?? null;
  return list;
}
