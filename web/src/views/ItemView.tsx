import { useEffect, useMemo, useState } from "preact/hooks";
import { invoke, supabase } from "../lib/supabase.ts";
import type { AlertEvent, ProductLink, Series, WishSummary } from "../lib/types.ts";
import { AVAILABILITY, PRIORITY, ago, centsToInput, dateTime, eur, hostOf, parseEurInput } from "../lib/format.ts";
import { go } from "../lib/router.ts";
import { dataVersion, refreshUnread, toast } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { PriceChart, type ChartPoint, type ChartSeries } from "../components/PriceChart.tsx";
import { IconExternal, IconPlus, IconRefresh } from "../components/icons.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { FindOffers } from "../components/FindOffers.tsx";
import { setPendingDirectLink } from "../lib/direct-links.ts";
import { sellerMatchesShop } from "@shared/search.ts";
import type { Shop } from "../lib/types.ts";
import { diffRules, mergeRules, RULE_LABELS, type RuleName, type Rules } from "@shared/rules.ts";
import { RulesForm, rulesSummary } from "../components/RulesForm.tsx";

const RANGES = [
  { key: "30", label: "30 pv", days: 30 },
  { key: "90", label: "90 pv", days: 90 },
  { key: "all", label: "Kaikki", days: null },
] as const;
const MAX_SERIES = 8; // categorical palette size; never generate a 9th hue

export function ItemView({ id }: { id: string }) {
  const [item, setItem] = useState<WishSummary | null>(null);
  const [links, setLinks] = useState<ProductLink[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [shops, setShops] = useState<Shop[]>([]);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("30");
  const [missing, setMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    (async () => {
      const [it, ls, se, al] = await Promise.all([
        supabase.from("v_wish_summary").select("*").eq("id", id).maybeSingle(),
        supabase.from("product_links").select("*, shops(domain, name, strategy)").eq("wish_item_id", id).order("created_at"),
        supabase.from("v_series").select("*").eq("wish_item_id", id).eq("tracked", true),
        supabase.from("v_alerts").select("*").eq("wish_item_id", id).order("ts", { ascending: false }).limit(10),
      ]);
      if (!it.data) {
        setMissing(true);
        return;
      }
      setItem(it.data as WishSummary);
      setLinks((ls.data ?? []) as ProductLink[]);
      setSeries((se.data ?? []) as Series[]);
      supabase.from("shops").select("*").then(({ data }) => setShops((data ?? []) as Shop[]));
      setAlerts((al.data ?? []) as AlertEvent[]);
      if ((al.data ?? []).some((a) => !a.read)) {
        await supabase.rpc("mark_alerts_read", { p_wish_item: id });
        refreshUnread();
      }
    })();
  }, [id, version, dataVersion.value]);

  // Stable series order (link creation order, then seller) -> stable colors across range changes.
  const orderedSeries = useMemo(() => {
    const linkOrder = new Map(links.map((l, i) => [l.id, i]));
    return [...series].sort((a, b) =>
      (linkOrder.get(a.product_link_id) ?? 0) - (linkOrder.get(b.product_link_id) ?? 0) ||
      a.seller_name.localeCompare(b.seller_name, "fi")
    );
  }, [series, links]);

  const chartSeries: ChartSeries[] = useMemo(
    () => orderedSeries.slice(0, MAX_SERIES).map((s, i) => ({
      key: `${s.product_link_id}|${s.seller}`,
      label: s.seller_name,
      colorVar: `--s${i + 1}`,
    })),
    [orderedSeries],
  );

  useEffect(() => {
    if (links.length === 0) {
      setPoints([]);
      return;
    }
    const days = RANGES.find((r) => r.key === range)!.days;
    let q = supabase
      .from("price_observations")
      .select("product_link_id, seller, ts, price_cents")
      .in("product_link_id", links.map((l) => l.id))
      .order("ts")
      .limit(10000);
    if (days) q = q.gte("ts", new Date(Date.now() - days * 86_400_000).toISOString());
    q.then(({ data }) =>
      setPoints((data ?? []).map((o) => ({ key: `${o.product_link_id}|${o.seller}`, ts: o.ts, price_cents: o.price_cents })))
    );
  }, [links, range]);

  if (missing) {
    return (
      <div class="page stack">
        <TopBar title="Ei löytynyt" parent="#/" />
        <p class="muted">Toiveasiaa ei löytynyt. Se on ehkä poistettu.</p>
      </div>
    );
  }
  if (!item) return <div class="page"><TopBar title="" parent="#/" /><div class="skeleton" /></div>;

  const eans = [...new Set(links.map((l) => l.ean).filter(Boolean))];
  const activeLinks = links.filter((l) => l.active);
  const failingLinks = activeLinks.filter((l) => l.last_status && l.last_status !== "ok").length;
  const colorOf = new Map(chartSeries.map((s) => [s.key, s.colorVar]));
  const linkById = new Map(links.map((l) => [l.id, l]));
  // Shops whose own pages gave no price (bot protection or no product data): a direct link is pointless.
  const noDirect = (seller: string) =>
    shops.some((sh) =>
      sh.strategy !== "aggregator" && sellerMatchesShop(seller, sh) &&
      (sh.strategy === "blocked" || (!sh.last_ok_at && sh.last_probe != null && !sh.last_probe.source))
    );
  // Cheapest current offer (fresh, not out of stock) gets the "Halvin nyt" mark.
  const fresh = orderedSeries.filter((s) => s.link_active && s.availability !== "out_of_stock" && Date.now() - Date.parse(s.ts) < 3 * 86_400_000);
  const cheapestKey = fresh.length
    ? (() => {
      const c = fresh.reduce((a, b) => (b.price_cents < a.price_cents ? b : a));
      return `${c.product_link_id}|${c.seller}`;
    })()
    : null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await invoke<{ ok: number; fail: number; alerts: number }>("fetch-prices", { wish_item_id: id });
      toast(`Päivitetty: ${r.ok ?? 0} onnistui${r.fail ? `, ${r.fail} epäonnistui` : ""}${r.alerts ? `, ${r.alerts} hälytystä` : ""}`);
      reload();
    } catch (e) {
      toast(`Päivitys epäonnistui: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div class="page stack-lg">
      <div>
        <TopBar title={item.name} parent="#/">
          <button class="icon-btn" onClick={refresh} disabled={refreshing} aria-label="Päivitä hinnat nyt">
            <IconRefresh class={refreshing ? "spin" : ""} />
          </button>
        </TopBar>

        {item.tags.length > 0 && <p class="item-tags" style="margin-top:-4px">{item.tags.join(" · ")}</p>}
        <section class="hero" aria-label="Paras hinta nyt">
          {item.best_price_cents != null ? (
            <>
              <span class="big num">{eur(item.best_price_cents)}</span>
              <span class="muted">
                {item.best_seller} · {AVAILABILITY[item.best_availability ?? "unknown"]} · {ago(item.best_ts)}
              </span>
            </>
          ) : (
            <span class="muted">{links.length ? "Ei hintatietoa vielä." : "Lisää ensimmäinen linkki, niin hinnan seuranta alkaa."}</span>
          )}
        </section>

        <dl class="facts">
          <div>
            <dt>Alin koskaan</dt>
            <dd class="num">{item.min_all_cents != null ? eur(item.min_all_cents) : "–"}</dd>
          </div>
          <div>
            <dt>30 pv mediaani</dt>
            <dd class="num">{item.median_30d_cents != null ? eur(item.median_30d_cents) : "–"}</dd>
          </div>
          <div>
            <dt>Tavoite</dt>
            <dd class="num">{item.target_price_cents != null ? eur(item.target_price_cents) : "–"}</dd>
          </div>
        </dl>
      </div>

      <section class="section" aria-labelledby="h-history">
        <div class="section-head">
          <h2 id="h-history">Hintahistoria</h2>
          <div class="seg" role="group" aria-label="Aikaväli">
            {RANGES.map((r) => (
              <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
            ))}
          </div>
        </div>
        <PriceChart series={chartSeries} points={points} targetCents={item.target_price_cents} />
        {orderedSeries.length > MAX_SERIES && (
          <p class="meta">Kaaviossa näkyy {MAX_SERIES} ensimmäistä kauppaa. Kaikki hinnat ovat alla.</p>
        )}
        {orderedSeries.length > 0 && (
          <div class="series" role="table" aria-label="Kauppakohtaiset hinnat">
            {orderedSeries.map((s) => {
              const key = `${s.product_link_id}|${s.seller}`;
              const color = colorOf.get(key);
              const link = linkById.get(s.product_link_id);
              const viaComparison = Boolean(s.seller);
              const siteName = link?.shops?.name ?? s.domain;
              return (
                <div class="series-row" role="row" key={key}>
                  <span class="swatch" style={{ background: color ? `var(${color})` : "var(--line)" }} aria-hidden="true" />
                  <div class="who" role="cell">
                    <div class="who-name">
                      <strong>{s.seller_name}</strong>
                      {key === cheapestKey && <span class="chip good">Halvin nyt</span>}
                    </div>
                    <span class="meta">
                      {s.availability !== "unknown" ? `${AVAILABILITY[s.availability]} · ` : ""}alin {eur(s.min_all)} · {ago(s.ts)}
                      {viaComparison ? ` · via ${s.domain}` : ""}
                    </span>
                  </div>
                  <div class="val" role="cell">
                    <strong class="num">{eur(s.price_cents)}</strong>
                    {s.lowest_30d_cents != null && (
                      <div class="meta num">ilmoitettu {eur(s.lowest_30d_cents)}</div>
                    )}
                  </div>
                  <div class="series-actions">
                    <a class="btn small" href={s.url} target="_blank" rel="noopener noreferrer">
                      <IconExternal /> {viaComparison ? `Avaa ${siteName}` : `Avaa ${s.seller_name}`}
                    </a>
                    {viaComparison && noDirect(s.seller) && (
                      <span class="meta" style="align-self:center">Kaupan sivulta ei saa hintaa, haetaan vertailusivulta</span>
                    )}
                    {viaComparison && !noDirect(s.seller) && (
                      <a
                        class="btn small"
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => {
                          // Open the comparison page (user taps the shop there) and wait for the link in the add view.
                          setPendingDirectLink(id, s.seller);
                          setTimeout(() => go(`#/add?item=${id}&seller=${encodeURIComponent(s.seller)}`), 300);
                        }}
                      >
                        Lisää suora linkki
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {alerts.length > 0 && (
        <section class="section" aria-labelledby="h-alerts">
          <h2 id="h-alerts">Hälytykset</h2>
          <div class="stack-sm">
            {alerts.map((a) => (
              <div key={a.id} class={`alert-row ${a.read ? "read" : "unread"} ${a.level}`}>
                <span class="dot" aria-hidden="true" />
                <div>
                  <div class="title">{RULE_LABELS[a.rule as RuleName] ?? a.rule}{a.read ? "" : " (uusi)"}</div>
                  <div class="muted">{a.seller ? `${a.seller}: ` : ""}{a.message}</div>
                  <div class="meta">{dateTime(a.ts)}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div>
        <EditPanel item={item} onSaved={reload} />
        <RulesPanel item={item} onSaved={reload} />
        <details class="panel" open={links.length === 0}>
          <summary>
            Linkit
            <span class="summary-meta">
              {activeLinks.length}{failingLinks > 0 ? ` · ${failingLinks} ongelma` : ""}{eans.length > 1 ? " · eri EAN" : ""}
            </span>
          </summary>
          <div class="stack">
            {eans.length > 1 && (
              <div class="notice warn">
                <strong>Linkeillä on eri EAN-koodit</strong> ({eans.join(", ")}). Tarkista, että kaikki linkit ovat samaa mallia.
              </div>
            )}
            <div class="actions">
              <a class="btn" href={`#/add?item=${id}`}><IconPlus /> Lisää linkki</a>
            </div>
            {links.length === 0 && <p class="muted">Ei linkkejä.</p>}
            <div>
              {links.map((l) => <LinkRow key={l.id} link={l} onChange={reload} />)}
            </div>
            {links.length > 0 && <FindOffers itemId={id} itemEans={eans as string[]} onAdded={reload} />}
          </div>
        </details>
      </div>
    </div>
  );
}

const STATUS: Record<string, [string, string]> = {
  ok: ["good", "Toimii"],
  error: ["bad", "Virhe"],
  blocked: ["bad", "Estetty"],
  no_data: ["warn", "Ei hintaa"],
};

function LinkRow({ link: l, onChange }: { link: ProductLink; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sellers, setSellers] = useState((l.sellers ?? []).join(", "));
  const isAggregator = l.shops?.strategy === "aggregator";
  const [cls, label] = l.last_status ? STATUS[l.last_status] : ["neutral", "Odottaa hakua"];

  const act = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) toast(error.message);
    else {
      toast(ok);
      onChange();
    }
  };

  return (
    <div class="link-row">
      <div class="row" style="align-items:flex-start">
        <div style="min-width:0">
          <strong>{l.shops?.name ?? hostOf(l.url)}{isAggregator ? " · vertailusivu" : ""}</strong>
          <div class="url">{l.model_name ?? l.url}</div>
        </div>
        <span class={`chip ${cls}`} style="flex:none">{label}</span>
      </div>
      <p class="meta">
        Haettu {ago(l.last_fetched_at)}{l.ean ? ` · EAN ${l.ean}` : ""}{l.active ? "" : " · pois käytöstä"}
      </p>
      {l.last_error && l.last_status !== "ok" && <p class="meta">{l.last_error}</p>}
      {isAggregator && (
        <p class="meta">
          Yksi haku tältä sivulta tallentaa {l.sellers?.length ? `${l.sellers.length} kaupan hinnat: ${l.sellers.join(", ")}` : "kaikkien sivulla olevien kauppojen hinnat"}.
        </p>
      )}
      {isAggregator && (
        <label class="field">
          <span>Tallennettavat kaupat</span>
          <input
            value={sellers}
            placeholder="Kaikki kaupat"
            onChange={(e) => setSellers((e.target as HTMLInputElement).value)}
            onBlur={() => {
              const list = sellers.split(",").map((s) => s.trim()).filter(Boolean);
              if (list.join(",") === (l.sellers ?? []).join(",")) return;
              act(() => supabase.from("product_links").update({ sellers: list.length ? list : null }).eq("id", l.id), "Kauppavalinta tallennettu");
            }}
          />
          <span class="hint">Pilkulla eroteltuna, esim. Gigantti. Tyhjä = kaikki vertailusivun kaupat.</span>
        </label>
      )}
      <div class="actions">
        <a class="btn" href={l.url} target="_blank" rel="noopener noreferrer"><IconExternal /> Avaa</a>
        <button class="btn" disabled={busy} onClick={() => act(() => supabase.from("product_links").update({ active: !l.active }).eq("id", l.id), l.active ? "Linkki poistettu käytöstä" : "Linkki otettu käyttöön")}>
          {l.active ? "Poista käytöstä" : "Ota käyttöön"}
        </button>
        <button class="btn danger" disabled={busy} onClick={() => {
          if (confirm("Poistetaanko linkki ja sen hintahistoria?")) {
            act(() => supabase.from("product_links").delete().eq("id", l.id), "Linkki poistettu");
          }
        }}>Poista</button>
      </div>
    </div>
  );
}

function EditPanel({ item, onSaved }: { item: WishSummary; onSaved: () => void }) {
  const [name, setName] = useState(item.name);
  const [tags, setTags] = useState<string[]>(item.tags);
  const [target, setTarget] = useState(centsToInput(item.target_price_cents));
  const [priority, setPriority] = useState(item.priority);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [active, setActive] = useState(item.active);
  const [busy, setBusy] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    if (target.trim() && parseEurInput(target) == null) return toast("Tavoitehinta ei ole kelvollinen luku");
    setBusy(true);
    const { error } = await supabase.from("wish_items").update({
      name: name.trim(),
      tags,
      target_price_cents: parseEurInput(target),
      priority,
      notes: notes.trim() || null,
      active,
    }).eq("id", item.id);
    setBusy(false);
    if (error) toast(error.message);
    else {
      toast("Tallennettu");
      onSaved();
    }
  };

  const remove = async () => {
    if (!confirm(`Poistetaanko "${item.name}" ja kaikki sen hintatiedot?`)) return;
    const { error } = await supabase.from("wish_items").delete().eq("id", item.id);
    if (error) toast(error.message);
    else {
      toast("Poistettu");
      go("#/");
    }
  };

  return (
    <details class="panel">
      <summary>Muokkaa tietoja</summary>
      <form class="stack" onSubmit={save}>
        <label class="field"><span>Nimi</span>
          <input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <div class="row">
          <label class="field"><span>Tavoitehinta (€)</span>
            <input inputMode="decimal" value={target} placeholder="Ei tavoitetta" onInput={(e) => setTarget((e.target as HTMLInputElement).value)} />
          </label>
          <label class="field"><span>Prioriteetti</span>
            <select value={priority} onChange={(e) => setPriority(Number((e.target as HTMLSelectElement).value) as 1 | 2 | 3)}>
              {[1, 2, 3].map((p) => <option value={p}>{PRIORITY[p]}</option>)}
            </select>
          </label>
        </div>
        <div class="field">
          <label for="edit-tags"><span>Tagit</span></label>
          <TagInput id="edit-tags" value={tags} onChange={setTags} />
        </div>
        <label class="field"><span>Muistiinpanot</span>
          <textarea value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
        </label>
        <label class="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive((e.target as HTMLInputElement).checked)} />
          Seuranta käytössä
        </label>
        <div class="actions">
          <button class="btn primary" disabled={busy}>Tallenna</button>
          <button type="button" class="btn danger" onClick={remove}>Poista toiveasia</button>
        </div>
      </form>
    </details>
  );
}

function RulesPanel({ item, onSaved }: { item: WishSummary; onSaved: () => void }) {
  const [household, setHousehold] = useState<unknown>({});
  const base = mergeRules(household);
  const custom = Object.keys((item.rules ?? {}) as object).length > 0;
  const [editing, setEditing] = useState(custom);
  const [r, setR] = useState<Rules>(mergeRules(household, item.rules));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from("households").select("default_rules").maybeSingle().then(({ data }) => {
      setHousehold(data?.default_rules ?? {});
      setR(mergeRules(data?.default_rules ?? {}, item.rules));
    });
  }, [item.id]);

  const store = async (rules: unknown, msg: string) => {
    setBusy(true);
    const { error } = await supabase.from("wish_items").update({ rules }).eq("id", item.id);
    setBusy(false);
    if (error) toast(error.message);
    else {
      toast(msg);
      onSaved();
    }
  };

  const effective = custom ? mergeRules(household, item.rules) : base;
  return (
    <details class="panel">
      <summary>
        Hälytyssäännöt
        <span class="summary-meta">{custom ? "mukautettu" : "yleiset"}</span>
      </summary>
      <div class="stack">
        <p class="muted">
          {custom ? "Tällä tuotteella on omat säännöt: " : "Käytössä yleiset säännöt (Asetukset → Hälytykset): "}
          {rulesSummary(effective)}.
        </p>
        {!editing ? (
          <div class="actions">
            <button class="btn" onClick={() => { setR(effective); setEditing(true); }}>Mukauta tälle tuotteelle</button>
            <a class="btn ghost" href="#/settings">Yleiset säännöt</a>
          </div>
        ) : (
          <form class="stack" onSubmit={(e) => { e.preventDefault(); store(diffRules(r, base), "Säännöt tallennettu tälle tuotteelle"); }}>
            <RulesForm value={r} onChange={setR} targetSet={item.target_price_cents != null} />
            <div class="actions">
              <button class="btn primary" disabled={busy}>Tallenna</button>
              <button type="button" class="btn ghost" disabled={busy}
                onClick={() => { setEditing(false); store({}, "Palautettu yleisiin sääntöihin"); }}>
                {custom ? "Palauta yleiset" : "Peru"}
              </button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}
