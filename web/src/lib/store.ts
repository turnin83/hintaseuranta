import { signal } from "@preact/signals";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase.ts";

export const session = signal<Session | null | undefined>(undefined); // undefined = loading
export const unreadCount = signal(0);
export const toastMsg = signal<string | null>(null);
export type ToastAction = { label: string; run: () => void | Promise<void> };
export const toastAction = signal<ToastAction | null>(null);
/** Bumped when data changed in the background (e.g. a fetch finished) so open views reload. */
export const dataVersion = signal(0);

let toastTimer: number | undefined;
/** Short status message; with an action (e.g. "Kumoa") it stays a bit longer. */
export function toast(msg: string, action?: ToastAction) {
  toastMsg.value = msg;
  toastAction.value = action ?? null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg.value = null;
    toastAction.value = null;
  }, action ? 7000 : 3500) as unknown as number;
}

export async function refreshUnread() {
  const { count } = await supabase
    .from("v_alerts")
    .select("id", { count: "exact", head: true })
    .eq("read", false)
    .eq("level", "alert");
  unreadCount.value = count ?? 0;
}
