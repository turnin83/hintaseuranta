// "Tarjoukset nyt": items whose best current price is clearly below our own history.
import { useEffect, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { WishSummary } from "../lib/types.ts";
import { ago, eur, pctDelta, signedPct } from "../lib/format.ts";
import { dataVersion } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconArrowDown, IconCheck, IconExternal } from "../components/icons.tsx";

const THRESHOLDS = [5, 10, 20] as const;
const MIN_OBS_FOR_ATL = 6; // same default as the all-time-low alert rule

type Deal = {
  item: WishSummary;
  discountPct: number | null; // vs item 30 d median, positive = cheaper
  targetHit: boolean;
  allTimeLow: boolean;
  score: number;
};

export function DealsView() {
  const [items, setItems] = useState<WishSummary[] | null>(null);
  const [obsByItem, setObsByItem] = useState<Map<string, number>>(new Map());
  const [min, setMin] = useState<(typeof THRESHOLDS)[number]>(5);

  useEffect(() => {
    Promise.all([
      supabase.from("v_wish_summary").select("*").eq("active", true),
      supabase.from("v_series").select("wish_item_id, obs_count"),
    ]).then(([w, s]) => {
      const m = new Map<string, number>();
      for (const r of (s.data ?? []) as { wish_item_id: string; obs_count: number }[]) {
        m.set(r.wish_item_id, (m.get(r.wish_item_id) ?? 0) + r.obs_count);
      }
      setObsByItem(m);
      setItems((w.data ?? []) as WishSummary[]);
    });
  }, [dataVersion.value]);

  const deals: Deal[] = (items ?? [])
    .filter((i) => i.best_price_cents != null && i.best_availability !== "out_of_stock")
    .map((i) => {
      const p = i.best_price_cents!;
      const discountPct = i.median_30d_cents ? -pctDelta(p, i.median_30d_cents) : null;
      const targetHit = i.target_price_cents != null && p <= i.target_price_cents;
      const allTimeLow = i.min_all_cents != null && p <= i.min_all_cents && (obsByItem.get(i.id) ?? 0) >= MIN_OBS_FOR_ATL;
      const score = (discountPct ?? 0) + (targetHit ? 5 : 0) + (allTimeLow ? 3 : 0);
      return { item: i, discountPct, targetHit, allTimeLow, score };
    })
    .filter((d) => (d.discountPct ?? 0) >= min || d.targetHit || d.allTimeLow)
    .sort((a, b) => b.score - a.score);

  const withHistory = (items ?? []).filter((i) => i.median_30d_cents != null).length;

  return (
    <div class="page stack">
      <TopBar title="Tarjoukset nyt" />
      <div class="stack-sm">
        <p class="muted">Paras hinta nyt verrattuna omaan 30 päivän historiaan. Mukana vain saatavilla olevat.</p>
        <div class="seg" role="group" aria-label="Vähimmäisale">
          {THRESHOLDS.map((t) => (
            <button key={t} aria-pressed={min === t} onClick={() => setMin(t)}>≥ {t} %</button>
          ))}
        </div>
      </div>

      {items === null && <div class="skeleton" />}

      {items && deals.length === 0 && (
        <div class="empty">
          <h2>Ei selviä tarjouksia juuri nyt</h2>
          <p>
            {withHistory < (items?.length ?? 0)
              ? "Osalla tuotteista historiaa on vielä vähän. Vertailu paranee, kun hintoja on kerätty muutaman päivän."
              : `Mikään hinta ei ole nyt vähintään ${min} % alle 30 päivän mediaanin, tavoitteen alla tai kaikkien aikojen alin.`}
          </p>
        </div>
      )}

      <div class="list">
        {deals.map((d) => <DealCard key={d.item.id} deal={d} />)}
      </div>
    </div>
  );
}

function DealCard({ deal: d }: { deal: Deal }) {
  const i = d.item;
  return (
    <div class="card deal-card">
      <a class="deal-main" href={`#/item/${i.id}`}>
        <div class="head">
          <span class="name">{i.name}</span>
          {d.discountPct != null && d.discountPct > 0 && (
            <span class="deal-pct num" aria-label={`${d.discountPct} prosenttia alle mediaanin`}>
              <IconArrowDown width={16} height={16} />{signedPct(-d.discountPct)}
            </span>
          )}
        </div>
        <div class="price-row">
          <span class="price num">{eur(i.best_price_cents!)}</span>
          <span class="muted">{i.best_seller}</span>
        </div>
        <div class="actions meta">
          {i.median_30d_cents != null && <span class="num">30 pv mediaani {eur(i.median_30d_cents)}</span>}
          {d.targetHit && <span class="chip good"><IconCheck /> Tavoite {eur(i.target_price_cents!)} alittui</span>}
          {d.allTimeLow && <span class="chip good">Alin koskaan</span>}
          <span>päivitetty {ago(i.best_ts)}</span>
        </div>
      </a>
      {i.best_url && (
        <a class="btn deal-shop" href={i.best_url} target="_blank" rel="noopener noreferrer">
          <IconExternal /> Avaa {i.best_seller ?? "kauppa"}
        </a>
      )}
    </div>
  );
}
