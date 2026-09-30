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
import { DEFAULT_RULES, mergeRules, RULE_LABELS, type RuleName, type Rules } from "@shared/rules.ts";

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
        supabase.from("v_series").select("*").eq("wish_item_id", id),
        supabase.from("v_alerts").select("*").eq("wish_item_id", id).order("ts", { ascending: false }).limit(10),
      ]);
      if (!it.data) {
        setMissing(true);
        return;
      }
      setItem(it.data as WishSummary);
      setLinks((ls.data ?? []) as ProductLink[]);
      setSeries((se.data ?? []) as Series[]);
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
  const colorOf = new Map(chartSeries.map((s) => [s.key, s.colorVar]));

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

      {item.best_url && (
        <a class="btn primary block" href={item.best_url} target="_blank" rel="noopener noreferrer">
          <IconExternal /> Avaa {item.best_seller ?? "kauppa"}
        </a>
      )}

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
              return (
                <div class="series-row" role="row" key={key}>
                  <span class="swatch" style={{ background: color ? `var(${color})` : "var(--line)" }} aria-hidden="true" />
                  <div class="who" role="cell">
                    <strong>{s.seller_name}</strong>
                    <span class="meta">
                      {AVAILABILITY[s.availability]} · alin {eur(s.min_all)} · {ago(s.ts)}
                      {s.seller ? ` · via ${s.domain}` : ""}
                    </span>
                  </div>
                  <div class="val" role="cell">
                    <strong class="num">{eur(s.price_cents)}</strong>
                    {s.lowest_30d_cents != null && (
                      <div class="meta num">ilmoitettu {eur(s.lowest_30d_cents)}</div>
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

      <section class="section" aria-labelledby="h-links">
        <div class="section-head">
          <h2 id="h-links">Linkit</h2>
          <a class="btn" href={`#/add?item=${id}`}><IconPlus /> Lisää linkki</a>
        </div>
        {eans.length > 1 && (
          <div class="notice warn">
            <strong>Linkeillä on eri EAN-koodit</strong> ({eans.join(", ")}). Tarkista, että kaikki linkit ovat samaa mallia.
          </div>
        )}
        {links.length === 0 && <p class="muted">Ei linkkejä.</p>}
        <div>
          {links.map((l) => <LinkRow key={l.id} link={l} onChange={reload} />)}
        </div>
        {links.length > 0 && <FindOffers itemId={id} itemEans={eans as string[]} onAdded={reload} />}
      </section>

      <EditPanel item={item} onSaved={reload} />
      <RulesPanel item={item} onSaved={reload} />
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
          <strong>{l.shops?.name ?? hostOf(l.url)}</strong>
          <div class="url">{l.model_name ?? l.url}</div>
        </div>
        <span class={`chip ${cls}`} style="flex:none">{label}</span>
      </div>
      <p class="meta">
        Haettu {ago(l.last_fetched_at)}{l.ean ? ` · EAN ${l.ean}` : ""}{l.active ? "" : " · pois käytöstä"}
      </p>
      {l.last_error && l.last_status !== "ok" && <p class="meta">{l.last_error}</p>}
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
  const [r, setR] = useState<Rules>(mergeRules(item.rules));
  const [busy, setBusy] = useState(false);
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const chk = (e: Event) => (e.target as HTMLInputElement).checked;

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.from("wish_items").update({ rules: r }).eq("id", item.id);
    setBusy(false);
    if (error) toast(error.message);
    else {
      toast("Säännöt tallennettu");
      onSaved();
    }
  };

  return (
    <details class="panel">
      <summary>Hälytyssäännöt</summary>
      <form class="stack" onSubmit={save}>
        <label class="check">
          <input type="checkbox" checked={r.below_target} onChange={(e) => setR({ ...r, below_target: chk(e) })} />
          {RULE_LABELS.below_target}{item.target_price_cents == null ? " (aseta tavoitehinta)" : ""}
        </label>
        <div class="stack-sm">
          <label class="check">
            <input type="checkbox" checked={r.all_time_low.enabled} onChange={(e) => setR({ ...r, all_time_low: { ...r.all_time_low, enabled: chk(e) } })} />
            {RULE_LABELS.all_time_low}
          </label>
          <label class="field"><span>Vaadi vähintään havaintoja</span>
            <input type="number" min={2} max={100} value={r.all_time_low.min_obs} onInput={(e) => setR({ ...r, all_time_low: { ...r.all_time_low, min_obs: num(e) } })} />
          </label>
        </div>
        <div class="stack-sm">
          <label class="check">
            <input type="checkbox" checked={r.below_median.enabled} onChange={(e) => setR({ ...r, below_median: { ...r.below_median, enabled: chk(e) } })} />
            {RULE_LABELS.below_median}
          </label>
          <label class="field"><span>Vähintään % alle mediaanin</span>
            <input type="number" min={1} max={90} value={r.below_median.pct} onInput={(e) => setR({ ...r, below_median: { ...r.below_median, pct: num(e) } })} />
          </label>
        </div>
        <div class="stack-sm">
          <label class="check">
            <input type="checkbox" checked={r.drop.enabled} onChange={(e) => setR({ ...r, drop: { ...r.drop, enabled: chk(e) } })} />
            {RULE_LABELS.drop} edellisestä havainnosta
          </label>
          <label class="field"><span>Vähintään % pudotus</span>
            <input type="number" min={1} max={90} value={r.drop.pct} onInput={(e) => setR({ ...r, drop: { ...r.drop, pct: num(e) } })} />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" checked={r.back_in_stock} onChange={(e) => setR({ ...r, back_in_stock: chk(e) })} />
          {RULE_LABELS.back_in_stock}
        </label>
        <label class="check">
          <input type="checkbox" checked={r.suspicious} onChange={(e) => setR({ ...r, suspicious: chk(e) })} />
          {RULE_LABELS.suspicious_discount} (vain listaan, ei ilmoitusta)
        </label>
        <label class="field"><span>Saman hälytyksen toisto aikaisintaan (h)</span>
          <input type="number" min={1} max={720} value={r.cooldown_hours} onInput={(e) => setR({ ...r, cooldown_hours: num(e) })} />
          <span class="hint">Aiemmin, jos hinta laskee edelleen.</span>
        </label>
        <div class="actions">
          <button class="btn primary" disabled={busy}>Tallenna säännöt</button>
          <button type="button" class="btn ghost" onClick={() => setR(DEFAULT_RULES)}>Oletukset</button>
        </div>
      </form>
    </details>
  );
}
