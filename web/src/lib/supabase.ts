import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const configMissing = !SUPABASE_URL || !KEY;

export const supabase = createClient(SUPABASE_URL || "https://invalid.local", KEY || "missing", {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Invoke an Edge Function; throws with the function's own error message. */
export async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      const j = ctx ? await ctx.json() : null;
      if (j?.error) msg = j.error;
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  return data as T;
}

/** All rows of a query, page by page (the API returns at most 1000 rows per request). */
export async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await page(from, from + 999);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}
