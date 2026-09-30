import { signal } from "@preact/signals";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase.ts";

export const session = signal<Session | null | undefined>(undefined); // undefined = loading
export const unreadCount = signal(0);
export const toastMsg = signal<string | null>(null);
/** Bumped when data changed in the background (e.g. a fetch finished) so open views reload. */
export const dataVersion = signal(0);

let toastTimer: number | undefined;
export function toast(msg: string) {
  toastMsg.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastMsg.value = null), 3500) as unknown as number;
}

export async function refreshUnread() {
  const { count } = await supabase
    .from("v_alerts")
    .select("id", { count: "exact", head: true })
    .eq("read", false)
    .eq("level", "alert");
  unreadCount.value = count ?? 0;
}
