import { useEffect, useState } from "preact/hooks";
import { invoke, supabase } from "../lib/supabase.ts";
import type { Preview } from "../lib/types.ts";
import { AVAILABILITY, eur, parseEurInput } from "../lib/format.ts";
import { go } from "../lib/router.ts";
import { dataVersion, toast } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconClipboard } from "../components/icons.tsx";
import { TagInput } from "../components/TagInput.tsx";
import { findUrl } from "@shared/url.ts";

type ItemOpt = { id: string; name: string; eans: string[] };

export function AddView(props: { url: string | null; item: string | null }) {
  const [url, setUrl] = useState(props.url ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ItemOpt[]>([]);
  const [mode, setMode] = useState<"new" | "existing">(props.item ? "existing" : "new");
  const [itemId, setItemId] = useState(props.item ?? "");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [sellers, setSellers] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from("wish_items").select("id, name, product_links(ean)").order("name").then(({ data }) => {
      const opts = (data ?? []).map((w: { id: string; name: string; product_links: { ean: string | null }[] }) => ({
        id: w.id,
        name: w.name,
        eans: [...new Set(w.product_links.map((l) => l.ean).filter((e): e is string => Boolean(e)))],
      }));
      setItems(opts);
      if (!itemId && opts[0]) setItemId(opts[0].id);
      if (opts.length === 0) setMode("new");
    });
    if (props.url) runPreview(props.url);
  }, []);

  async function runPreview(raw: string) {
    const u = findUrl(raw) ?? raw.trim();
    if (!u) return;
    setUrl(u);
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const p = await invoke<Preview>("preview-product", { url: u });
      setPreview(p);
      setName(p.page?.name ?? "");
      setSellers(new Set((p.page?.offers ?? []).map((o) => o.seller).filter((s): s is string => Boolean(s))));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) runPreview(t);
    } catch {
      toast("Leikepöydän luku ei ole sallittu. Liitä linkki kenttään.");
    }
  };

  const page = preview?.page;
  const isAggregator = page?.kind === "aggregator";
  const offer = page?.offers[0];
  const canSave = Boolean(page && page.offers.length > 0 && preview?.shop && (mode === "new" ? name.trim() : itemId));
  const chosen = items.find((i) => i.id === itemId);
  const eanMismatch = mode === "existing" && page?.ean && chosen && chosen.eans.length > 0 && !chosen.eans.includes(page.ean);

  const save = async (e: Event) => {
    e.preventDefault();
    if (!preview || !page || !preview.shop) return;
    if (target.trim() && parseEurInput(target) == null) return toast("Tavoitehinta ei ole kelvollinen luku");
    setSaving(true);
    try {
      let wid = itemId;
      if (mode === "new") {
        const { data, error } = await supabase
          .from("wish_items")
          .insert({ name: name.trim(), target_price_cents: parseEurInput(target), tags })
          .select("id")
          .single();
        if (error) throw error;
        wid = data.id;
      }
      const allSellers = page.offers.map((o) => o.seller).filter(Boolean);
      const chosenSellers = isAggregator && sellers.size < allSellers.length ? [...sellers] : null;
      const { data: link, error } = await supabase
        .from("product_links")
        .insert({
          wish_item_id: wid,
          shop_id: preview.shop.id,
          url: preview.url,
          ean: page.ean,
          model_name: page.name?.slice(0, 200) ?? null,
          sellers: chosenSellers,
        })
        .select("id")
        .single();
      if (error) {
        if (error.code === "23505") throw new Error("Tämä linkki on jo tällä toiveasialla.");
        throw error;
      }
      toast("Tallennettu, haetaan ensimmäinen hinta…");
      go(`#/item/${wid}`);
      invoke("fetch-prices", { link_ids: [link.id] })
        .then(() => {
          toast("Ensimmäinen hinta tallennettu");
          dataVersion.value++;
        })
        .catch((err) => toast(`Haku epäonnistui: ${(err as Error).message}`));
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="page stack-lg">
      <div class="stack">
        <TopBar title="Lisää tuote" parent={props.item ? `#/item/${props.item}` : "#/"} />
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            runPreview(url);
          }}
        >
          <label class="field">
            <span>Tuotesivun linkki</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://…"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
            />
            <span class="hint">Mikä tahansa verkkokauppa, tai hintaopas.fi / hinta.fi, jos kauppa estää haut. Voit myös jakaa linkin tähän sovellukseen puhelimen jakovalikosta.</span>
          </label>
          <div class="actions">
            <button class={`btn${preview ? "" : " primary"}`} disabled={loading || !url.trim()}>{loading ? "Haetaan…" : "Hae tiedot"}</button>
            {"clipboard" in navigator && (
              <button type="button" class="btn" onClick={paste}><IconClipboard /> Liitä</button>
            )}
          </div>
        </form>
      </div>

      {error && <div class="notice bad">{error}</div>}

      {preview && (
        <section class="stack" aria-label="Esikatselu">
          {preview.suggestion && (
            <div class={`notice ${page ? "warn" : "bad"}`}>
              <strong>{preview.domain}:</strong> {preview.suggestion}
              {preview.botMarkers.length > 0 && <div class="meta">Tunnistettu: {preview.botMarkers.join(", ")}</div>}
            </div>
          )}

          {page && page.offers.length > 0 && (
            <div class="card stack-sm">
              <strong>{page.name ?? "Nimetön tuote"}</strong>
              <span class="meta">
                {preview.domain}{page.ean ? ` · EAN ${page.ean}` : ""}{isAggregator ? " · hintavertailu" : ""}
              </span>
              {!isAggregator && offer && (
                <div class="price-row" style="display:flex;gap:12px;align-items:baseline">
                  <span class="num" style="font-family:var(--font-display);font-size:28px;font-weight:700">{eur(offer.priceCents!)}</span>
                  <span class="muted">{AVAILABILITY[offer.availability]}</span>
                </div>
              )}
            </div>
          )}

          {page && isAggregator && (
            <fieldset class="card stack-sm" style="margin:0">
              <legend class="visually-hidden">Tallennettavat kaupat</legend>
              <h3>Mitkä kaupat tallennetaan?</h3>
              <p class="meta">Valitse vain kaupat, joita et seuraa suoraan, niin samat hinnat eivät tallennu kahteen kertaan.</p>
              {page.offers.map((o) => (
                <label class="check" key={o.seller}>
                  <input
                    type="checkbox"
                    checked={sellers.has(o.seller!)}
                    onChange={(e) => {
                      const next = new Set(sellers);
                      if ((e.target as HTMLInputElement).checked) next.add(o.seller!);
                      else next.delete(o.seller!);
                      setSellers(next);
                    }}
                  />
                  <span style="flex:1">{o.seller}</span>
                  <span class="num">{eur(o.priceCents!)}</span>
                </label>
              ))}
            </fieldset>
          )}

          {page && page.offers.length > 0 && (
            <form class="stack" onSubmit={save}>
              {items.length > 0 && (
                <div class="seg" role="group" aria-label="Minne lisätään">
                  <button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>Uusi toiveasia</button>
                  <button type="button" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>Olemassa olevaan</button>
                </div>
              )}
              {mode === "new" ? (
                <>
                  <label class="field"><span>Nimi</span>
                    <input required value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
                  </label>
                  <label class="field"><span>Tavoitehinta (€, valinnainen)</span>
                    <input inputMode="decimal" value={target} placeholder="esim. 999" onInput={(e) => setTarget((e.target as HTMLInputElement).value)} />
                  </label>
                  <div class="field">
                    <label for="add-tags"><span>Tagit (valinnainen)</span></label>
                    <TagInput id="add-tags" value={tags} onChange={setTags} />
                  </div>
                </>
              ) : (
                <label class="field"><span>Toiveasia</span>
                  <select value={itemId} onChange={(e) => setItemId((e.target as HTMLSelectElement).value)}>
                    {items.map((i) => <option value={i.id}>{i.name}</option>)}
                  </select>
                </label>
              )}
              {eanMismatch && (
                <div class="notice warn">
                  <strong>Eri EAN kuin muilla linkeillä</strong> ({page.ean} vs {chosen!.eans.join(", ")}). Tämä voi olla eri malli tai kokoversio.
                </div>
              )}
              <button class="btn primary block" disabled={!canSave || saving}>{saving ? "Tallennetaan…" : "Aloita seuranta"}</button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
