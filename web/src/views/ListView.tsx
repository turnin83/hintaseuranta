import { useEffect, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { WishSummary } from "../lib/types.ts";
import { AVAILABILITY, ago, eur, pctDelta, signedPct } from "../lib/format.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconPlus } from "../components/icons.tsx";

export function ListView() {
  const [items, setItems] = useState<WishSummary[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("v_wish_summary")
      .select("*")
      .order("priority")
      .order("name")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setItems(data as WishSummary[]);
      });
  }, []);

  const visible = (items ?? [])
    .filter((i) => showInactive || i.active)
    .sort((a, b) => Number(b.unread_alerts > 0) - Number(a.unread_alerts > 0) || a.priority - b.priority);
  const inactiveCount = (items ?? []).filter((i) => !i.active).length;
  const lastFetch = (items ?? []).map((i) => i.last_fetched_at).filter(Boolean).sort().at(-1) ?? null;

  return (
    <div class="page stack">
      <TopBar title="Toivelista" />
      {error && <div class="notice bad">{error}</div>}
      {items === null && !error && (
        <div class="list" aria-busy="true">
          <div class="skeleton" />
          <div class="skeleton" />
        </div>
      )}
      {items?.length === 0 && (
        <div class="empty">
          <h2>Ei vielä seurattavia tuotteita</h2>
          <p>Liitä tuotesivun linkki mistä tahansa verkkokaupasta tai hintavertailusta. Hinta haetaan heti ja sen jälkeen ajastetusti.</p>
          <a class="btn primary" href="#/add">
            <IconPlus /> Lisää tuote
          </a>
        </div>
      )}
      {visible.length > 0 && (
        <>
          <p class="meta">Viimeisin haku {ago(lastFetch)}</p>
          <div class="list">
            {visible.map((i) => <ItemCard key={i.id} item={i} />)}
          </div>
        </>
      )}
      {inactiveCount > 0 && (
        <button class="btn ghost" onClick={() => setShowInactive(!showInactive)}>
          {showInactive ? "Piilota pois käytöstä olevat" : `Näytä pois käytöstä olevat (${inactiveCount})`}
        </button>
      )}
    </div>
  );
}

function ItemCard({ item: i }: { item: WishSummary }) {
  const delta = i.best_price_cents != null && i.median_30d_cents ? pctDelta(i.best_price_cents, i.median_30d_cents) : null;
  const targetHit = i.best_price_cents != null && i.target_price_cents != null && i.best_price_cents <= i.target_price_cents;

  return (
    <a class={`card item-card${i.active ? "" : " inactive"}`} href={`#/item/${i.id}`}>
      <div class="head">
        <span class="name">{i.name}</span>
        {i.unread_alerts > 0 && <span class="chip good">{i.unread_alerts} uutta</span>}
      </div>

      {i.best_price_cents != null ? (
        <div class="price-row">
          <span class="price num">{eur(i.best_price_cents)}</span>
          <span class="muted">{i.best_seller}</span>
          {i.best_availability === "out_of_stock" && <span class="chip neutral">{AVAILABILITY.out_of_stock}</span>}
        </div>
      ) : (
        <p class="muted">{i.link_count === 0 ? "Ei linkkejä" : "Ei hintatietoa vielä"}</p>
      )}

      <div class="actions meta">
        {delta != null && (
          <span class={`delta num ${delta < 0 ? "down" : delta > 0 ? "up" : ""}`}>
            {delta < 0 ? <IconArrowDown width={14} height={14} style="vertical-align:-2px" /> : delta > 0 ? <IconArrowUp width={14} height={14} style="vertical-align:-2px" /> : null}
            {" "}{signedPct(delta)} vs 30 pv mediaani
          </span>
        )}
        {i.target_price_cents != null && (
          targetHit
            ? <span class="chip good"><IconCheck /> Tavoite {eur(i.target_price_cents)} alittui</span>
            : <span class="num">Tavoite {eur(i.target_price_cents)}</span>
        )}
        {i.failing_links > 0 && (
          <span class="chip warn"><IconAlert /> {i.failing_links === 1 ? "1 linkki ei toimi" : `${i.failing_links} linkkiä ei toimi`}</span>
        )}
      </div>
    </a>
  );
}
