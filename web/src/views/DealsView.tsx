// "Tarjoukset nyt": items whose best current price is clearly below their own usual price,
// grouped by how big the discount is, with a buy recommendation where it is warranted.
import { useEffect, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { WishSummary } from "../lib/types.ts";
import { ago, eur } from "../lib/format.ts";
import { dataVersion } from "../lib/store.ts";
import { assessDeal, type DealAssessment, isDeal, type Tier, TIERS } from "../lib/deals.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconArrowDown, IconCheck, IconExternal } from "../components/icons.tsx";

type Filter = "all" | "20" | "40" | "buy";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Kaikki" },
  { key: "20", label: "≥ 20 %" },
  { key: "40", label: "≥ 40 %" },
  { key: "buy", label: "Ostosuositukset" },
];

type Deal = { item: WishSummary; a: DealAssessment };

export function DealsView() {
  const [items, setItems] = useState<WishSummary[] | null>(null);
  const [obsByItem, setObsByItem] = useState<Map<string, number>>(new Map());
  const [filter, setFilter] = useState<Filter>("all");

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

  const all: Deal[] = (items ?? [])
    .map((item) => ({ item, a: assessDeal(item, obsByItem.get(item.id) ?? 0) }))
    .filter((d) => isDeal(d.a))
    .sort((x, y) => y.a.score - x.a.score);

  const shown = all.filter(({ a }) =>
    filter === "all" ? true
      : filter === "buy" ? a.recommendation === "buy"
      : (a.discountPct ?? 0) >= Number(filter)
  );
  const buyCount = all.filter((d) => d.a.recommendation === "buy").length;

  // Sections by tier; target / all-time-low hits without a % discount go last.
  const sections: { key: Tier | "other"; heading: string; deals: Deal[] }[] = [
    ...TIERS.map((t) => ({ key: t.tier, heading: t.heading, deals: shown.filter((d) => d.a.tier === t.tier) })),
    { key: "other" as const, heading: "Tavoitehinnassa tai historian alimmillaan", deals: shown.filter((d) => d.a.tier == null) },
  ].filter((s) => s.deals.length > 0);

  return (
    <div class="page stack">
      <TopBar title="Tarjoukset nyt" />
      <div class="stack-sm">
        <p class="muted">
          Paras saatavilla oleva hinta verrattuna tuotteen tavalliseen hintaan (30 päivän mediaani).
          {buyCount > 0 && <> <strong>{buyCount} {buyCount === 1 ? "ostosuositus" : "ostosuositusta"}.</strong></>}
        </p>
        <div class="seg" role="group" aria-label="Suodata">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
      </div>

      {items === null && <div class="skeleton" />}

      {items && shown.length === 0 && (
        <div class="empty">
          <h2>{all.length === 0 ? "Ei tarjouksia juuri nyt" : "Ei tällä rajauksella"}</h2>
          <p>
            {all.length === 0
              ? "Mikään hinta ei ole nyt selvästi tavallista alempi, tavoitteen alla tai historian alimmillaan. Vertailu tarkentuu, kun hintoja kertyy useammalta päivältä."
              : "Valitse laajempi rajaus nähdäksesi pienemmät alennukset."}
          </p>
        </div>
      )}

      {sections.map((s) => (
        <section class="stack-sm" key={s.key} aria-label={s.heading}>
          <h2 class="deal-heading">{s.heading}</h2>
          <div class="list">
            {s.deals.map((d) => <DealCard key={d.item.id} deal={d} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function DealCard({ deal: { item: i, a } }: { deal: Deal }) {
  const tierLabel = TIERS.find((t) => t.tier === a.tier)?.label;
  return (
    <div class={`card deal-card tier-${a.tier ?? "none"}`}>
      <a class="deal-main" href={`#/item/${i.id}`}>
        <div class="head">
          <span class="name">{i.name}</span>
          {a.discountPct != null && a.discountPct >= 5 && (
            <span class="deal-pct num" aria-label={`${a.discountPct} prosenttia alle tavallisen hinnan`}>
              <IconArrowDown width={18} height={18} />−{a.discountPct} %
            </span>
          )}
        </div>
        <div class="price-row">
          <span class="price num">{eur(i.best_price_cents!)}</span>
          {i.median_30d_cents != null && a.discountPct != null && a.discountPct >= 5 && (
            <s class="was num">{eur(i.median_30d_cents)}</s>
          )}
          <span class="muted">{i.best_seller}</span>
        </div>
        {a.recommendation && (
          <p class={`reco reco-${a.recommendation}`}>
            {a.recommendation === "buy" ? <IconCheck width={18} height={18} /> : null}
            <strong>{a.recommendation === "buy" ? (a.tier === "must" ? "Pakko ostaa" : "Ostosuositus") : "Harkitse"}:</strong>{" "}
            {a.reasons.join(", ")}
          </p>
        )}
        {!a.recommendation && a.reasons.length > 0 && <p class="meta">{tierLabel ? `${tierLabel}: ` : ""}{a.reasons.join(", ")}</p>}
        <p class="meta">
          {a.lowConfidence ? "Vähän hintahistoriaa, arvio on suuntaa antava · " : ""}päivitetty {ago(i.best_ts)}
        </p>
      </a>
      {i.best_url && (
        <a class={`btn deal-shop${a.recommendation === "buy" ? " primary" : ""}`} href={i.best_url} target="_blank" rel="noopener noreferrer">
          <IconExternal /> Avaa {i.best_seller ?? "kauppa"}
        </a>
      )}
    </div>
  );
}
