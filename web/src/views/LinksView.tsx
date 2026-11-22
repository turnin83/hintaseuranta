// "Linkkien korjaus": one product tracked twice (merge), links that point to another product than their item
// (another size, capacity or colour: its prices would count as the item's), shops seen only via comparison
// sites that were among the cheapest (a direct link would make them reliable), and broken links. Work happens in the user's own browser: "Etsi" copies the search
// words and opens a search restricted to the shop's site; the copied product link is read back in the add
// view, which returns here after saving.
import { useEffect, useMemo, useState } from "preact/hooks";
import { allRows, supabase } from "../lib/supabase.ts";
import type { ProductLink, Shop, WishSummary } from "../lib/types.ts";
import { eur } from "../lib/format.ts";
import { type DuplicatePair, findDuplicates, linkMismatches } from "../lib/same-product.ts";
import { go } from "../lib/router.ts";
import { dataVersion, toast } from "../lib/store.ts";
import { useSkipped } from "../lib/skips.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconAlert, IconExternal } from "../components/icons.tsx";
import { setPendingDirectLink } from "../lib/direct-links.ts";
import { sellerKey, sellerMatchesShop } from "@shared/search.ts";

type SeriesRow = {
  wish_item_id: string;
  seller: string;
  seller_name: string;
  shop_strategy: string;
  price_cents: number;
  min_30d: number | null;
  ts: string;
};
type LinkRow = ProductLink & { failing_since: string | null };

const DAY = 86_400_000;
/** A seller is worth a direct link when its 30-day low was at most this much above the item's. */
const CLOSE = 1.05;


const searchUrl = (words: string, domain: string | null) =>
  `https://www.google.com/search?q=${encodeURIComponent(domain ? `site:${domain} ${words}` : words)}`;

/** The link's problem in plain words. */
function problemText(l: LinkRow): string {
  const e = l.last_error ?? "";
  if (/HTTP 404|HTTP 410/.test(e)) return "sivua ei enää ole";
  if (l.last_status === "no_data") return "sivulta ei löydy hintaa (tuote poistunut tai sivu muuttunut)";
  if (/robots/.test(e)) return "kauppa ei salli sivun hakua";
  return e || "haku epäonnistuu";
}

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

export function LinksView() {
  const [items, setItems] = useState<WishSummary[] | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [shops, setShops] = useState<Shop[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [skipped, skip] = useSkipped();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    Promise.all([
      supabase.from("v_wish_summary").select("*").eq("active", true).is("purchased_at", null),
      allRows<LinkRow>((a, b) => supabase.from("product_links").select("*, shops(domain, name, strategy)").range(a, b)),
      supabase.from("shops").select("*"),
      allRows<SeriesRow>((a, b) =>
        supabase.from("v_series").select("wish_item_id, seller, seller_name, shop_strategy, price_cents, min_30d, ts")
          .gt("ts", new Date(Date.now() - 30 * DAY).toISOString()).range(a, b)
      ),
    ]).then(([it, ls, sh, se]) => {
      setItems((it.data ?? []) as WishSummary[]);
      setLinks(ls);
      setShops((sh.data ?? []) as Shop[]);
      setSeries(se);
    });
  }, [version, dataVersion.value]);

  const { missing, broken, dupes, wrong } = useMemo(() => {
    const byItem = new Map((items ?? []).map((i) => [i.id, i]));
    const linksOf = (itemId: string) => links.filter((l) => l.wish_item_id === itemId);

    // The same product twice on the list.
    const dupes = findDuplicates(items ?? [], linksOf).filter((p) => !skipped.has(`dup|${p.older.id}|${p.newer.id}`));
    // A link to another product: active or not, its history counts in the item's lowest and usual price.
    const wrong = (items ?? []).flatMap((item) =>
      [...linkMismatches(item.name, linksOf(item.id))]
        .filter(([id]) => !skipped.has(`same|${id}`))
        .map(([id, why]) => ({ item, link: links.find((l) => l.id === id)!, why }))
    );
    const shopOf = (seller: string) => shops.find((s) => s.strategy !== "aggregator" && sellerMatchesShop(seller, s));
    const eanOf = (itemId: string) => links.find((l) => l.wish_item_id === itemId && l.ean)?.ean ?? null;

    // Missing: a comparison site's seller, among the cheapest, without a direct link on the item.
    const missing = new Map<string, { item: WishSummary; seller: string; low: number; best: number; domain: string | null }[]>();
    for (const item of items ?? []) {
      const own = series.filter((s) => s.wish_item_id === item.id && !(s.shop_strategy === "aggregator" && !s.seller));
      const best = Math.min(...own.map((s) => s.min_30d ?? s.price_cents));
      if (!Number.isFinite(best)) continue;
      const direct = links.filter((l) => l.wish_item_id === item.id && l.active && l.shops && l.shops.strategy !== "aggregator")
        .map((l) => l.shops!);
      const seen = new Set<string>();
      for (const s of own.filter((x) => x.shop_strategy === "aggregator")) {
        const key = sellerKey(s.seller);
        if (seen.has(key) || skipped.has(`${item.id}|${key}`)) continue;
        seen.add(key);
        if (direct.some((d) => sellerMatchesShop(s.seller, d))) continue;
        const shop = shopOf(s.seller);
        if (shop?.strategy === "blocked") continue; // the shop does not let us fetch its pages
        const low = Math.min(...own.filter((x) => sellerKey(x.seller) === key).map((x) => x.min_30d ?? x.price_cents));
        if (low > best * CLOSE) continue;
        const group = shop?.name ?? s.seller_name;
        missing.set(group, [...(missing.get(group) ?? []), { item, seller: s.seller_name, low, best, domain: shop?.domain ?? null }]);
      }
    }
    // Broken: no price for over a day (a paused comparison site is not broken).
    const broken = links.filter((l) =>
      l.active && byItem.has(l.wish_item_id) && l.last_status !== "blocked" && l.failing_since &&
      Date.now() - Date.parse(l.failing_since) > DAY
    ).map((l) => ({ link: l, item: byItem.get(l.wish_item_id)! }));
    return {
      missing: [...missing.entries()].sort((a, b) => b[1].length - a[1].length).map(([shop, rows]) => ({ shop, rows, eanOf })),
      broken,
      dupes,
      wrong,
    };
  }, [items, links, shops, series, skipped]);

  const missingCount = missing.reduce((n, g) => n + g.rows.length, 0);

  const startSearch = (itemId: string, seller: string, words: string, extra = "") => {
    copy(words);
    setPendingDirectLink(itemId, seller);
    setTimeout(() => go(`#/add?item=${itemId}&seller=${encodeURIComponent(seller)}&back=links${extra}`), 300);
  };
  const removeWrong = async (l: LinkRow, item: WishSummary, thenSearch: boolean) => {
    const shop = l.shops?.name ?? l.shops?.domain ?? "";
    if (!confirm(`Poistetaanko ${shop}-linkki ja sen hinnat tuotteelta ${item.name}? Väärän tuotteen hinnat vääristävät alinta ja tavallista hintaa.`)) return;
    const { error } = await supabase.from("product_links").delete().eq("id", l.id);
    if (error) return toast(error.message);
    dataVersion.value++;
    if (thenSearch) startSearch(item.id, shop, item.name);
    else {
      toast("Linkki ja sen hinnat poistettu");
      setVersion((v) => v + 1);
    }
  };
  const deactivate = async (l: LinkRow) => {
    if (!confirm(`Poistetaanko ${l.shops?.name ?? l.shops?.domain} käytöstä? Hintahistoria säilyy.`)) return;
    const { error } = await supabase.from("product_links").update({ active: false }).eq("id", l.id);
    if (error) return toast(error.message);
    toast("Linkki poistettu käytöstä");
    setVersion((v) => v + 1);
  };

  return (
    <div class="page stack-lg">
      <TopBar title="Linkkien korjaus" parent="#/settings" />
      <p class="meta">
        Etsi kopioi hakusanan leikepöydälle ja avaa haun kaupan sivuilta. Avaa oikea tuote, kopioi sen osoite ja palaa
        tänne: linkki luetaan automaattisesti (tai paina Liitä), ja tallennus palaa tähän listaan.
      </p>
      {items === null ? <div class="skeleton" /> : (
        <>
          {dupes.length > 0 && (
            <section class="section stack-sm" aria-labelledby="h-dupes">
              <h2 id="h-dupes">Sama tuote kahdesti <span class="summary-meta">{dupes.length}</span></h2>
              <p class="meta">
                Kaksi seurantaa samalle tuotteelle. Yhdistäessä valittu jää: toisen linkit, hintahistoria, hälytykset ja
                ostot siirtyvät siihen, ja sama kauppasivu yhdistyy yhdeksi linkiksi.
              </p>
              <div>
                {dupes.map((p) => (
                  <DuplicateRow
                    key={`${p.older.id}|${p.newer.id}`}
                    pair={p}
                    onMerged={() => setVersion((v) => v + 1)}
                    onSkip={() => skip(`dup|${p.older.id}|${p.newer.id}`)}
                  />
                ))}
              </div>
            </section>
          )}

          {wrong.length > 0 && (
            <section class="section stack-sm" aria-labelledby="h-wrong">
              <h2 id="h-wrong">Linkki eri tuotteeseen? <span class="summary-meta">{wrong.length}</span></h2>
              <p class="meta">
                Linkin tuote poikkeaa muista: eri koko, kapasiteetti, väri tai EAN. Sen hinnat lasketaan tuotteen alimpaan
                ja tavalliseen hintaan sekä hälytyksiin. Poista väärä linkki hintoineen, tai merkitse se samaksi tuotteeksi.
              </p>
              <div>
                {wrong.map(({ item, link: l, why }) => (
                  <div class="link-row" key={l.id}>
                    <strong>{item.name}</strong>
                    <span class="meta">{l.shops?.name ?? l.shops?.domain}{l.active ? "" : " · pois käytöstä"}: {l.model_name ?? l.url}</span>
                    <p class="claim-warn"><IconAlert width={16} height={16} /><span>{why.join(" · ")}</span></p>
                    <div class="actions">
                      <a class="btn small" href={l.url} target="_blank" rel="noopener noreferrer"><IconExternal /> Avaa</a>
                      {l.shops?.strategy !== "aggregator" && (
                        <button class="btn small primary" onClick={() => removeWrong(l, item, true)}>Poista ja etsi oikea</button>
                      )}
                      <button class="btn small ghost danger" onClick={() => removeWrong(l, item, false)}>Poista</button>
                      <button class="btn small ghost" onClick={() => skip(`same|${l.id}`)}>Sama tuote</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section class="section stack-sm" aria-labelledby="h-missing">
            <h2 id="h-missing">Puuttuvat suorat linkit <span class="summary-meta">{missingCount}</span></h2>
            <p class="meta">
              Kaupat, joiden hinta tulee vain vertailusivulta ja jotka ovat olleet 30 päivän aikana halvimpien joukossa
              (enintään 5 % halvinta kalliimpia). Suora linkki haetaan kaupasta itse, myös kun vertailusivu on tauolla.
            </p>
            {missing.length === 0 && <p class="muted">Ei puuttuvia linkkejä.</p>}
            {missing.map((g) => (
              <details class="panel" key={g.shop} open={missing.length <= 3}>
                <summary>
                  {g.shop}
                  <span class="summary-meta">{g.rows.length}</span>
                </summary>
                <div>
                  {g.rows.map((r) => {
                    const ean = g.eanOf(r.item.id);
                    const words = r.item.name;
                    const pct = Math.max(1, Math.round((r.low / r.best - 1) * 100));
                    return (
                      <div class="link-row" key={`${r.item.id}|${r.seller}`}>
                        <strong>{r.item.name}</strong>
                        <span class="meta num">
                          {r.seller}: alin {eur(r.low)} 30 pv{r.low <= r.best ? " · halvin" : ` · +${pct} % halvimpaan`}
                          {ean ? ` · EAN ${ean}` : ""}
                        </span>
                        <div class="actions">
                          <a
                            class="btn small primary"
                            href={searchUrl(words, r.domain)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => startSearch(r.item.id, r.seller, words)}
                          >
                            <IconExternal /> Etsi
                          </a>
                          {ean && <button class="btn small ghost" onClick={() => { copy(ean); toast("EAN kopioitu"); }}>Kopioi EAN</button>}
                          <button class="btn small ghost" onClick={() => skip(`${r.item.id}|${sellerKey(r.seller)}`)}>Ohita</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </section>

          <section class="section stack-sm" aria-labelledby="h-broken">
            <h2 id="h-broken">Rikkinäiset linkit <span class="summary-meta">{broken.length}</span></h2>
            <p class="meta">Ei hintaa yli vuorokauteen. Uusi osoite korvaa vanhan, ja hintahistoria säilyy.</p>
            {broken.length === 0 && <p class="muted">Kaikki linkit toimivat.</p>}
            <div>
              {broken.map(({ link: l, item }) => (
                <div class="link-row" key={l.id}>
                  <strong>{item.name}</strong>
                  <span class="meta">
                    {l.shops?.name ?? l.shops?.domain} · ei hintaa {Math.round((Date.now() - Date.parse(l.failing_since!)) / DAY)} pv
                    {` · ${problemText(l)}`}
                  </span>
                  <span class="url">{l.url}</span>
                  <div class="actions">
                    <a
                      class="btn small primary"
                      href={searchUrl(item.name, l.shops?.domain ?? null)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => startSearch(item.id, l.shops?.name ?? l.shops?.domain ?? "", item.name, `&replace=${l.id}`)}
                    >
                      <IconExternal /> Etsi uusi
                    </a>
                    <button class="btn small ghost danger" onClick={() => deactivate(l)}>Poista käytöstä</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DuplicateRow({ pair, onMerged, onSkip }: { pair: DuplicatePair<WishSummary>; onMerged: () => void; onSkip: () => void }) {
  const [keepId, setKeepId] = useState(pair.older.id);
  const [busy, setBusy] = useState(false);
  const [keep, drop] = keepId === pair.older.id ? [pair.older, pair.newer] : [pair.newer, pair.older];
  const merge = async () => {
    if (!confirm(`Yhdistetäänkö "${drop.name}" tuotteeseen "${keep.name}"? Linkit, hintahistoria ja hälytykset siirtyvät, ja "${drop.name}" poistuu listalta. Tätä ei voi perua.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("merge_items", { p_keep: keep.id, p_drop: drop.id });
    setBusy(false);
    if (error) return toast(error.message);
    toast("Yhdistetty");
    dataVersion.value++;
    onMerged();
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString("fi-FI", { day: "numeric", month: "numeric" });
  return (
    <div class="link-row">
      <span class="meta">{pair.why.join(" · ")}</span>
      <div class="stack-sm" role="radiogroup" aria-label="Kumpi jää">
        {[pair.older, pair.newer].map((i) => (
          <label class="check" key={i.id}>
            <input type="radio" name={`keep-${pair.older.id}`} checked={keepId === i.id} onChange={() => setKeepId(i.id)} />
            <span style="flex:1;min-width:0">
              <strong>{i.name}</strong>
              <span class="meta" style="display:block">
                lisätty {day(i.created_at)} · {i.link_count} linkkiä
                {i.target_price_cents != null ? ` · tavoite ${eur(i.target_price_cents)}` : ""}
                {i.best_price_cents != null ? ` · nyt ${eur(i.best_price_cents)}` : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div class="actions">
        <button class="btn small primary" disabled={busy} onClick={merge}>{busy ? "Yhdistetään…" : "Yhdistä, valittu jää"}</button>
        <a class="btn small ghost" href={`#/item/${keep.id}`}>Avaa</a>
        <button class="btn small ghost" onClick={onSkip}>Eri tuotteet</button>
      </div>
    </div>
  );
}
