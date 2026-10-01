// Replacing comparison-site sellers with direct shop links.
import { supabase } from "./supabase.ts";
import { sellerMatchesShop } from "@shared/search.ts";

// ---------- "Lisää suora linkki" intent ----------
// The user leaves the app to find the shop page, then shares or pastes the link back.
// Remember which item / seller they were working on so the shared link lands on that item.

const KEY = "pending-direct-link";
const TTL_MS = 30 * 60_000;

export type PendingDirectLink = { item: string; seller: string; at: number };

export function setPendingDirectLink(item: string, seller: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ item, seller, at: Date.now() }));
  } catch { /* private mode */ }
}

export function getPendingDirectLink(): PendingDirectLink | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as PendingDirectLink | null;
    return p && Date.now() - p.at < TTL_MS ? p : null;
  } catch {
    return null;
  }
}

export function clearPendingDirectLink() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

// ---------- De-duplication ----------

type AggLink = { id: string; sellers: string[] | null; shops: { strategy: string } | null };

/**
 * After a direct link to `shop` is saved for an item, stop recording that shop through the item's
 * comparison-site links (history is kept). A comparison link left with no sellers is deactivated.
 * Returns the seller names that were removed.
 */
export async function removeShopFromComparisonLinks(itemId: string, shop: { domain: string; name: string | null }): Promise<string[]> {
  const { data } = await supabase.from("product_links").select("id, sellers, shops(strategy)")
    .eq("wish_item_id", itemId).eq("active", true);
  const removed: string[] = [];
  for (const l of (data ?? []) as unknown as AggLink[]) {
    if (l.shops?.strategy !== "aggregator") continue;
    let sellers = l.sellers;
    if (!sellers) {
      // "All sellers": use the sellers actually recorded from this link.
      const { data: s } = await supabase.from("v_series").select("seller").eq("product_link_id", l.id);
      sellers = [...new Set((s ?? []).map((x) => x.seller as string).filter(Boolean))];
    }
    const drop = sellers.filter((s) => sellerMatchesShop(s, shop));
    if (drop.length === 0) continue;
    const keep = sellers.filter((s) => !drop.includes(s));
    const { error } = await supabase.from("product_links")
      .update(keep.length ? { sellers: keep } : { active: false }).eq("id", l.id);
    if (!error) removed.push(...drop);
  }
  return removed;
}
