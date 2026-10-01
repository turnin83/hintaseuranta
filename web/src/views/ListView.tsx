import { useEffect, useMemo, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { WishSummary } from "../lib/types.ts";
import { AVAILABILITY, ago, eur, pctDelta, signedPct } from "../lib/format.ts";
import { countTags, hasTag } from "../lib/tags.ts";
import { session } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconPlus } from "../components/icons.tsx";

type Mode = "list" | "groups";
type Density = "cards" | "compact";
const UNTAGGED = "\u0000untagged";

// View preferences: stored on this device, per signed-in user (never shared with the household).
function usePref<T extends string>(name: string, initial: T): [T, (v: T) => void] {
  const key = `${session.value?.user.id ?? "anon"}:${name}`;
  const [v, setV] = useState<T>(() => {
    try {
      // Fallback: unprefixed key from versions before per-user prefs.
      return (localStorage.getItem(key) ?? localStorage.getItem(name) ?? initial) as T;
    } catch {
      return initial;
    }
  });
  return [v, (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch { /* private mode */ }
  }];
}

export function ListView() {
  const [items, setItems] = useState<WishSummary[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = usePref<Mode>("list-mode", "list");
  const [tag, setTag] = usePref<string>("list-tag", "");
  const [density, setDensity] = usePref<Density>("list-density", "cards");
  const [query, setQuery] = useState("");

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

  const base = (items ?? []).filter((i) => showInactive || i.active);
  const tagCounts = useMemo(() => countTags(base), [items, showInactive]);
  const untaggedCount = base.filter((i) => i.tags.length === 0).length;
  // A remembered tag that no longer exists falls back to "all".
  const activeTag = tag === UNTAGGED ? (untaggedCount ? tag : "") : tagCounts.some((t) => t.tag === tag) ? tag : "";

  const q = query.trim().toLocaleLowerCase("fi");
  const visible = base
    .filter((i) => !activeTag || (activeTag === UNTAGGED ? i.tags.length === 0 : hasTag(i.tags, activeTag)))
    .filter((i) => !q || i.name.toLocaleLowerCase("fi").includes(q) || i.tags.some((t) => t.toLocaleLowerCase("fi").includes(q)))
    .sort((a, b) => Number(b.unread_alerts > 0) - Number(a.unread_alerts > 0) || a.priority - b.priority);

  const inactiveCount = (items ?? []).filter((i) => !i.active).length;
  const lastFetch = (items ?? []).map((i) => i.last_fetched_at).filter(Boolean).sort().at(-1) ?? null;
  const hasTags = tagCounts.length > 0;
  const showSearch = (items?.length ?? 0) > 6;

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

      {items && items.length > 0 && (
        <div class="stack-sm">
          {showSearch && (
            <input
              type="search"
              placeholder="Hae nimellä tai tagilla"
              aria-label="Hae toiveista"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
          )}
          {hasTags && (
            <div class="list-controls">
              <div class="chips-scroll" role="group" aria-label="Suodata tagilla">
                <button class="filter-chip" aria-pressed={!activeTag} onClick={() => setTag("")}>
                  Kaikki <span class="n">{base.length}</span>
                </button>
                {tagCounts.map((t) => (
                  <button key={t.tag} class="filter-chip" aria-pressed={activeTag === t.tag} onClick={() => setTag(activeTag === t.tag ? "" : t.tag)}>
                    {t.tag} <span class="n">{t.count}</span>
                  </button>
                ))}
                {untaggedCount > 0 && (
                  <button class="filter-chip" aria-pressed={activeTag === UNTAGGED} onClick={() => setTag(activeTag === UNTAGGED ? "" : UNTAGGED)}>
                    Ilman tagia <span class="n">{untaggedCount}</span>
                  </button>
                )}
              </div>
            </div>
          )}
          <div class="view-controls">
            {hasTags ? (
              <div class="seg" role="group" aria-label="Ryhmittely">
                <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>Lista</button>
                <button aria-pressed={mode === "groups"} onClick={() => setMode("groups")}>Ryhmät</button>
              </div>
            ) : <span />}
            <div class="seg" role="group" aria-label="Tiiviys">
              <button aria-pressed={density === "cards"} onClick={() => setDensity("cards")}>Kortit</button>
              <button aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>Tiivis</button>
            </div>
          </div>
          <p class="meta">Viimeisin haku {ago(lastFetch)}</p>
        </div>
      )}

      {items && items.length > 0 && visible.length === 0 && (
        <p class="muted">Ei osumia{q ? ` haulla "${query.trim()}"` : ""}.</p>
      )}

      {visible.length > 0 && (mode === "groups" && hasTags
        ? <Groups items={visible} order={tagCounts.map((t) => t.tag)} density={density} />
        : <Items items={visible} density={density} />)}

      {inactiveCount > 0 && (
        <button class="btn ghost" onClick={() => setShowInactive(!showInactive)}>
          {showInactive ? "Piilota pois käytöstä olevat" : `Näytä pois käytöstä olevat (${inactiveCount})`}
        </button>
      )}
    </div>
  );
}

/** One collapsible section per tag (most used first); an item with several tags appears in each. */
function Items({ items, density }: { items: WishSummary[]; density: Density }) {
  return density === "compact"
    ? <div class="rows">{items.map((i) => <CompactRow key={i.id} item={i} />)}</div>
    : <div class="list">{items.map((i) => <ItemCard key={i.id} item={i} />)}</div>;
}

/** Compact two-level row: name on top, price · change · shop underneath. */
function CompactRow({ item: i }: { item: WishSummary }) {
  const delta = i.best_price_cents != null && i.median_30d_cents ? pctDelta(i.best_price_cents, i.median_30d_cents) : null;
  const targetHit = i.best_price_cents != null && i.target_price_cents != null && i.best_price_cents <= i.target_price_cents;
  const out = i.best_availability === "out_of_stock";
  return (
    <a class={`row-item${i.active ? "" : " inactive"}`} href={`#/item/${i.id}`}>
      <span class={`row-dot${i.unread_alerts > 0 ? " on" : ""}`} aria-hidden="true" />
      <span class="row-main">
        <span class="row-name">
          {i.name}
          {i.unread_alerts > 0 && <span class="visually-hidden"> ({i.unread_alerts} uutta hälytystä)</span>}
        </span>
        <span class="row-sub">
          <span class={`row-price num${targetHit ? " is-hit" : ""}${out || i.best_price_cents == null ? " is-out" : ""}`}>
            {targetHit && <IconCheck aria-label="Tavoite alittui" />}
            {i.best_price_cents != null ? eur(i.best_price_cents) : (i.link_count ? "Ei hintaa vielä" : "Ei linkkejä")}
          </span>
          {delta != null && delta !== 0 && (
            <span class={`row-delta num ${delta < 0 ? "down" : "up"}`}>{signedPct(delta)}</span>
          )}
          {i.best_seller && <span class="row-seller">{i.best_seller}{out ? " · loppu" : ""}</span>}
          {i.failing_links > 0 && <IconAlert class="row-warn" aria-label="Linkki ei toimi" />}
        </span>
      </span>
    </a>
  );
}

function Groups({ items, order, density }: { items: WishSummary[]; order: string[]; density: Density }) {
  const groups = order
    .map((tag) => ({ tag, items: items.filter((i) => hasTag(i.tags, tag)) }))
    .filter((g) => g.items.length > 0);
  const untagged = items.filter((i) => i.tags.length === 0);
  if (untagged.length) groups.push({ tag: "Ilman tagia", items: untagged });

  return (
    <div class="stack">
      {groups.map((g) => {
        const unread = g.items.reduce((n, i) => n + i.unread_alerts, 0);
        return (
          <details class="group" open key={g.tag}>
            <summary>
              <h2>{g.tag}</h2>
              <span class="meta">{g.items.length} {g.items.length === 1 ? "tuote" : "tuotetta"}</span>
              {unread > 0 && <span class="chip good">{unread} uutta</span>}
            </summary>
            <Items items={g.items} density={density} />
          </details>
        );
      })}
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
      {i.tags.length > 0 && <p class="item-tags">{i.tags.join(" · ")}</p>}
    </a>
  );
}
