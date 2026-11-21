import { allRows, supabase } from "./supabase.ts";
import type { PurchaseRow } from "./purchases.ts";

/** A purchase with its item; `open` = the item is still marked bought by it (not back on the wish list). */
export type LoggedPurchase = PurchaseRow & { name: string; open: boolean };

/** Every purchase of the household, newest first. Items in the trash are left out (as in v_wish_summary). */
export async function loadPurchases(): Promise<LoggedPurchase[]> {
  type Raw = PurchaseRow & { wish_items: { name: string; purchased_at: string | null } };
  const rows = await allRows<Raw>((a, b) =>
    supabase.from("purchases").select("*, wish_items!inner(name, purchased_at, deleted_at)")
      .is("wish_items.deleted_at", null).order("purchased_at", { ascending: false }).range(a, b)
  );
  return rows.map(({ wish_items: w, ...r }) => ({
    ...r,
    name: w.name,
    open: w.purchased_at != null && Date.parse(w.purchased_at) === Date.parse(r.purchased_at),
  }));
}
