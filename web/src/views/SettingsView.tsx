import { useEffect, useState } from "preact/hooks";
import { invoke, supabase } from "../lib/supabase.ts";
import type { FetchRun, Household, Shop } from "../lib/types.ts";
import { ago, dateTime } from "../lib/format.ts";
import { dataVersion, session, toast } from "../lib/store.ts";
import { currentSubscription, disablePush, enablePush, platform } from "../lib/push.ts";
import { TopBar } from "../components/chrome.tsx";
import { IconShare } from "../components/icons.tsx";

const INTERVALS = [
  { min: 720, label: "2 kertaa päivässä", hint: "Oletus" },
  { min: 360, label: "4 kertaa päivässä", hint: "" },
  { min: 180, label: "8 kertaa päivässä", hint: "" },
  { min: 60, label: "Tunnin välein", hint: "Black Friday -viikko" },
];

export function SettingsView() {
  return (
    <div class="page stack-lg">
      <TopBar title="Asetukset" />
      <NotificationsSection />
      <HouseholdSection />
      <IntervalSection />
      <ShopsSection />
      <RunsSection />
      <section class="section">
        <h2>Tili</h2>
        <p class="muted">{session.value?.user.email}</p>
        <button class="btn" onClick={() => supabase.auth.signOut()}>Kirjaudu ulos</button>
      </section>
    </div>
  );
}

function NotificationsSection() {
  const p = platform();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const permission = "Notification" in window ? Notification.permission : "unsupported";

  useEffect(() => {
    currentSubscription().then((s) => setSubscribed(Boolean(s)));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      await enablePush();
      setSubscribed(true);
      toast("Ilmoitukset sallittu tällä laitteella");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    await disablePush().catch((e) => toast(String(e)));
    setSubscribed(false);
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await invoke<{ sent: number; failed: number; errors: string[] }>("push-test", {});
      toast(r.sent ? `Lähetetty ${r.sent} laitteelle` : `Ei lähetetty: ${r.errors[0] ?? "ei tilattuja laitteita"}`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="section" aria-labelledby="h-notif">
      <h2 id="h-notif">Ilmoitukset</h2>
      {p.ios && !p.standalone ? (
        <div class="notice">
          <strong>iPhonessa ilmoitukset toimivat vain kotinäytölle lisätyssä sovelluksessa.</strong>
          <ol>
            <li>Napauta Safarin jakopainiketta <IconShare width={16} height={16} style="vertical-align:-3px" />.</li>
            <li>Valitse <strong>Lisää Koti-valikkoon</strong>.</li>
            <li>Avaa Hinnat kotinäytöltä, kirjaudu ja palaa tähän näkymään.</li>
          </ol>
        </div>
      ) : !p.supported ? (
        <div class="notice warn">Tämä selain ei tue push-ilmoituksia.</div>
      ) : !p.vapidConfigured ? (
        <div class="notice warn">VAPID-avainta ei ole asetettu (VITE_VAPID_PUBLIC_KEY).</div>
      ) : (
        <>
          <p class="muted">
            {permission === "denied"
              ? "Ilmoitukset on estetty selaimen asetuksista. Salli ne sivuston asetuksista ja palaa tähän."
              : subscribed
              ? "Ilmoitukset ovat käytössä tällä laitteella."
              : "Saat ilmoituksen, kun hälytyssääntö täyttyy. Hyväksy lupa seuraavassa ikkunassa."}
          </p>
          <div class="actions">
            {subscribed
              ? <button class="btn" disabled={busy} onClick={disable}>Poista käytöstä tällä laitteella</button>
              : <button class="btn primary" disabled={busy || permission === "denied"} onClick={enable}>Salli ilmoitukset</button>}
            <button class="btn" disabled={busy || !subscribed} onClick={test}>Testaa ilmoitus</button>
          </div>
        </>
      )}
    </section>
  );
}

function HouseholdSection() {
  const [members, setMembers] = useState<{ user_id: string; email: string | null }[]>([]);
  useEffect(() => {
    supabase.from("household_members").select("user_id, email").order("joined_at").then(({ data }) => setMembers(data ?? []));
  }, []);
  if (members.length === 0) return null;
  const me = session.value?.user.id;
  return (
    <section class="section" aria-labelledby="h-household">
      <h2 id="h-household">Jaettu kotitalous</h2>
      <p class="muted">Kaikki jäsenet näkevät ja muokkaavat samaa toivelistaa. Ilmoitukset tulevat jokaisen omille laitteille, ja luettu-tila on henkilökohtainen.</p>
      <ul class="stack-sm" style="margin:0;padding-left:20px">
        {members.map((m) => <li key={m.user_id}>{m.email ?? m.user_id}{m.user_id === me ? " (sinä)" : ""}</li>)}
      </ul>
      <p class="meta">Uusi jäsen: luo käyttäjä Supabasen hallintapaneelissa (Authentication → Users → Add user). Hän liittyy tähän kotitalouteen automaattisesti.</p>
    </section>
  );
}

function IntervalSection() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [busy, setBusy] = useState(false);
  const value = household?.fetch_interval_minutes ?? null;

  useEffect(() => {
    supabase.from("households").select("id, name, fetch_interval_minutes").maybeSingle().then(({ data }) =>
      setHousehold(data as Household | null)
    );
  }, []);

  const change = async (min: number) => {
    if (!household) return;
    setHousehold({ ...household, fetch_interval_minutes: min });
    const { error } = await supabase.from("households").update({ fetch_interval_minutes: min }).eq("id", household.id);
    toast(error ? error.message : "Hakutiheys tallennettu");
  };

  const fetchAll = async () => {
    setBusy(true);
    try {
      const r = await invoke<{ links: number; ok?: number; fail?: number; deferred?: number }>("fetch-prices", {});
      toast(`Haettu ${r.ok ?? 0}/${r.links} linkkiä${r.fail ? `, ${r.fail} epäonnistui` : ""}${r.deferred ? `, ${r.deferred} siirtyi seuraavaan ajoon` : ""}`);
      dataVersion.value++;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="section" aria-labelledby="h-int">
      <h2 id="h-int">Hakutiheys</h2>
      <fieldset class="stack-sm" style="border:0;padding:0;margin:0">
        <legend class="visually-hidden">Kuinka usein hinnat haetaan</legend>
        {INTERVALS.map((o) => (
          <label class="check" key={o.min}>
            <input type="radio" name="interval" checked={value === o.min} onChange={() => change(o.min)} />
            <span>{o.label}{o.hint && <span class="meta"> · {o.hint}</span>}</span>
          </label>
        ))}
      </fieldset>
      <p class="meta">Ajastus tarkistaa 15 minuutin välein, onko jokin linkki erääntynyt. Kukin kauppa haetaan peräkkäin viiveellä.</p>
      <button class="btn" disabled={busy} onClick={fetchAll}>{busy ? "Haetaan…" : "Hae kaikki nyt"}</button>
    </section>
  );
}

function ShopsSection() {
  const [shops, setShops] = useState<Shop[]>([]);
  const load = () => supabase.from("shops").select("*").order("domain").then(({ data }) => setShops((data ?? []) as Shop[]));
  useEffect(() => {
    load();
  }, []);

  const update = async (id: number, patch: Partial<Shop>) => {
    const { error } = await supabase.from("shops").update(patch).eq("id", id);
    if (error) toast(error.message);
    else load();
  };

  if (shops.length === 0) return null;
  return (
    <section class="section" aria-labelledby="h-shops">
      <h2 id="h-shops">Kaupat</h2>
      <p class="meta">Kauppa lisätään automaattisesti ensimmäisen linkin yhteydessä.</p>
      <div>
        {shops.map((s) => (
          <details class="panel" key={s.id}>
            <summary>
              <span style="flex:1;min-width:0">
                {s.name ?? s.domain}
                <span class="meta" style="font-family:var(--font-body);font-weight:400">
                  {" · "}{s.strategy === "blocked" ? "estää haut" : s.last_error ? "virheitä" : s.last_ok_at ? `ok ${ago(s.last_ok_at)}` : "ei haettu"}
                </span>
              </span>
            </summary>
            <div class="stack">
              <label class="field"><span>Näyttönimi</span>
                <input value={s.name ?? ""} onChange={(e) => update(s.id, { name: (e.target as HTMLInputElement).value.trim() || null })} />
              </label>
              <label class="field"><span>Tila</span>
                <select value={s.strategy} onChange={(e) => update(s.id, { strategy: (e.target as HTMLSelectElement).value as Shop["strategy"] })}>
                  <option value="direct">Haetaan suoraan</option>
                  <option value="aggregator">Hintavertailusivu</option>
                  <option value="blocked">Estää haut (käytä vertailusivua)</option>
                </select>
              </label>
              <label class="field"><span>Viive pyyntöjen välillä (ms)</span>
                <input type="number" min={0} max={60000} step={500} value={s.min_delay_ms}
                  onChange={(e) => update(s.id, { min_delay_ms: Number((e.target as HTMLInputElement).value) })} />
              </label>
              <p class="meta">{s.domain}{s.last_error ? ` · ${s.last_error}` : ""}</p>
              {s.last_probe?.botMarkers?.length ? <p class="meta">Bottiesto: {s.last_probe.botMarkers.join(", ")}</p> : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function RunsSection() {
  const [runs, setRuns] = useState<FetchRun[]>([]);
  useEffect(() => {
    supabase.from("fetch_runs").select("*").order("started_at", { ascending: false }).limit(10).then(({ data }) =>
      setRuns((data ?? []) as FetchRun[])
    );
  }, [dataVersion.value]);
  if (runs.length === 0) return null;
  return (
    <section class="section" aria-labelledby="h-runs">
      <h2 id="h-runs">Viimeisimmät haut</h2>
      <div>
        {runs.map((r) => (
          <details class="panel" key={r.id}>
            <summary>
              <span style="flex:1;font-family:var(--font-body);font-size:16px;font-weight:500">
                {dateTime(r.started_at)} · {r.ok_count} ok{r.fail_count ? `, ${r.fail_count} virhettä` : ""}{r.alert_count ? `, ${r.alert_count} hälytystä` : ""}
                <span class="meta"> · {r.trigger === "cron" ? "ajastettu" : "käsin"}</span>
              </span>
            </summary>
            <div class="stack-sm">
              {r.errors.length === 0 ? <p class="meta">Ei virheitä.</p> : r.errors.map((e, i) => (
                <p class="meta" key={i} style="overflow-wrap:anywhere">{e.url}: {e.error}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
