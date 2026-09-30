// "Etsi muista kaupoista": search hinta.fi by the item's EAN (or name) and add untracked shops
// as one hinta.fi link with the chosen sellers.
import { useState } from "preact/hooks";
import { invoke, supabase } from "../lib/supabase.ts";
import type { Availability } from "@shared/types.ts";
import type { SearchHit } from "@shared/search.ts";
import { AVAILABILITY, eur } from "../lib/format.ts";
import { toast } from "../lib/store.ts";

type Found = {
  query: string;
  byEan: boolean;
  results: SearchHit[];
  product: {
    url: string;
    name: string | null;
    ean: string | null;
    offers: { seller: string; priceCents: number | null; availability: Availability; tracked: boolean }[];
  } | null;
  shopId: number | null;
  existingLink: { id: string; sellers: string[] | null } | null;
};

export function FindOffers(props: { itemId: string; itemEans: string[]; onAdded: () => void }) {
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  const run = async (extra: { query?: string; product_url?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const f = await invoke<Found>("find-offers", { wish_item_id: props.itemId, ...extra });
      setFound(f);
      setQuery(f.query);
      setChosen(new Set((f.product?.offers ?? []).filter((o) => !o.tracked).map((o) => o.seller)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!found?.product || !found.shopId || chosen.size === 0) return;
    setBusy(true);
    try {
      let linkId: string;
      if (found.existingLink) {
        const sellers = [...new Set([...(found.existingLink.sellers ?? []), ...chosen])];
        const { error } = await supabase.from("product_links").update({ sellers, active: true }).eq("id", found.existingLink.id);
        if (error) throw error;
        linkId = found.existingLink.id;
      } else {
        const { data, error } = await supabase.from("product_links").insert({
          wish_item_id: props.itemId,
          shop_id: found.shopId,
          url: found.product.url,
          ean: found.product.ean,
          model_name: found.product.name?.slice(0, 200) ?? null,
          sellers: [...chosen],
        }).select("id").single();
        if (error) throw error;
        linkId = data.id;
      }
      await invoke("fetch-prices", { link_ids: [linkId] });
      toast(`Lisätty ${chosen.size} ${chosen.size === 1 ? "kauppa" : "kauppaa"} seurantaan`);
      setFound(null);
      props.onAdded();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!found) {
    return (
      <div class="stack-sm">
        <button class="btn block" disabled={busy} onClick={() => run()}>
          {busy ? "Haetaan hinta.fi:stä…" : "Etsi muista kaupoista"}
        </button>
        {error && <div class="notice bad">{error}</div>}
      </div>
    );
  }

  const p = found.product;
  const untracked = p?.offers.filter((o) => !o.tracked) ?? [];
  const eanMismatch = p?.ean && props.itemEans.length > 0 && !props.itemEans.includes(p.ean);

  return (
    <div class="card stack">
      <div class="section-head">
        <h3 style="flex:1">Muut kaupat</h3>
        <button class="btn ghost" onClick={() => setFound(null)}>Sulje</button>
      </div>

      {p ? (
        <>
          <p class="meta">
            hinta.fi: {p.name}{p.ean ? ` · EAN ${p.ean}` : ""}{found.byEan ? " · haettu EAN-koodilla" : ""}
          </p>
          {eanMismatch && (
            <div class="notice warn"><strong>Eri EAN</strong> kuin seuratuilla linkeillä. Tarkista, että malli on sama.</div>
          )}
          <div>
            {p.offers.map((o) => (
              <label class="check" key={o.seller} style={o.tracked ? "opacity:0.6" : undefined}>
                <input
                  type="checkbox"
                  disabled={o.tracked}
                  checked={o.tracked || chosen.has(o.seller)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if ((e.target as HTMLInputElement).checked) next.add(o.seller);
                    else next.delete(o.seller);
                    setChosen(next);
                  }}
                />
                <span style="flex:1;min-width:0">
                  {o.seller}
                  {(o.tracked || o.availability !== "unknown") && (
                    <span class="meta"> · {o.tracked ? "seurataan jo" : AVAILABILITY[o.availability]}</span>
                  )}
                </span>
                <span class="num">{o.priceCents != null ? eur(o.priceCents) : "–"}</span>
              </label>
            ))}
          </div>
          {untracked.length === 0 ? (
            <p class="muted">Kaikki löydetyt kaupat ovat jo seurannassa.</p>
          ) : (
            <button class="btn primary block" disabled={busy || chosen.size === 0} onClick={add}>
              {busy ? "Lisätään…" : `Lisää valitut (${chosen.size})`}
            </button>
          )}
        </>
      ) : found.results.length > 0 ? (
        <>
          <p class="meta">Valitse oikea tuote ({found.results.length} osumaa haulla "{found.query}"):</p>
          <div class="stack-sm">
            {found.results.map((r) => (
              <button key={r.id} class="hit" disabled={busy} onClick={() => run({ product_url: r.url })}>
                <strong>{r.name}</strong>
                <span class="meta">
                  {[r.group, r.priceCents != null ? `alk. ${eur(r.priceCents)}` : null, r.storeCount != null ? `${r.storeCount} kauppaa` : null]
                    .filter(Boolean).join(" · ")}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p class="muted">Ei osumia hinta.fi:ssä haulla "{found.query}".</p>
      )}

      {!p && (
        <form class="row" style="gap:8px" onSubmit={(e) => { e.preventDefault(); run({ query }); }}>
          <input aria-label="Hakusana" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <button class="btn" style="flex:none" disabled={busy || !query.trim()}>Hae</button>
        </form>
      )}
    </div>
  );
}
