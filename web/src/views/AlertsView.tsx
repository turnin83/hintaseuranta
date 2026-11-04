import { useEffect, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { AlertEvent } from "../lib/types.ts";
import { dataVersion, refreshUnread, session, toast } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { AlertEntry } from "../components/AlertEntry.tsx";

type Mode = "list" | "items";

// Per-user view preference on this device (same pattern as the wish list).
function useMode(): [Mode, (m: Mode) => void] {
  const key = `${session.value?.user.id ?? "anon"}:alerts-mode`;
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return localStorage.getItem(key) === "items" ? "items" : "list";
    } catch {
      return "list";
    }
  });
  return [mode, (m) => {
    setMode(m);
    try {
      localStorage.setItem(key, m);
    } catch { /* private mode */ }
  }];
}

export function AlertsView() {
  const [alerts, setAlerts] = useState<AlertEvent[] | null>(null);
  const [mode, setMode] = useMode();

  useEffect(() => {
    supabase
      .from("v_alerts")
      .select("*")
      .gt("ts", new Date(Date.now() - 30 * 86_400_000).toISOString())
      .order("ts", { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) toast(error.message);
        setAlerts((data ?? []) as AlertEvent[]);
      });
  }, [dataVersion.value]);

  const markAll = async () => {
    const { error } = await supabase.rpc("mark_alerts_read", {});
    if (error) return toast(error.message);
    setAlerts((a) => a?.map((x) => ({ ...x, read: true })) ?? null);
    refreshUnread();
  };

  const open = async (a: AlertEvent) => {
    if (!a.read) {
      await supabase.from("alert_reads").insert({ alert_id: a.id });
      refreshUnread();
    }
    location.hash = `#/item/${a.wish_item_id}`;
  };

  const list = alerts ?? [];
  const unread = list.filter((a) => !a.read).length;

  // Per item: the newest event, how many earlier ones, unread if any is unread.
  const groups = [...list.reduce((m, a) => {
    const g = m.get(a.wish_item_id);
    if (!g) m.set(a.wish_item_id, { latest: a, count: 1, unread: !a.read });
    else {
      g.count++;
      g.unread ||= !a.read;
    }
    return m;
  }, new Map<string, { latest: AlertEvent; count: number; unread: boolean }>()).values()];

  return (
    <div class="page stack">
      <TopBar title="Hälytykset" />
      {list.length > 0 && (
        <div class="view-controls">
          <div class="seg" role="group" aria-label="Näkymä">
            <button aria-pressed={mode === "list"} onClick={() => setMode("list")}>Lista</button>
            <button aria-pressed={mode === "items"} onClick={() => setMode("items")}>Tuotteittain</button>
          </div>
          <button class="btn ghost" disabled={unread === 0} onClick={markAll}>Merkitse luetuiksi</button>
        </div>
      )}
      {alerts === null && <div class="skeleton" />}
      {alerts?.length === 0 && (
        <div class="empty">
          <h2>Ei hälytyksiä</h2>
          <p>Hälytys tulee, kun hinta alittaa tavoitteen, on uusi alin tai selvästi tavallista halvempi, tai tuote palaa varastoon. Säännöt löytyvät Asetuksista.</p>
        </div>
      )}
      <div class="stack-sm">
        {mode === "list"
          ? list.map((a) => (
            <a key={a.id} href={`#/item/${a.wish_item_id}`} class={`alert-row ${a.read ? "read" : "unread"}`}
              onClick={(e) => { e.preventDefault(); open(a); }}>
              <span class="dot" aria-hidden="true" />
              <AlertEntry alert={a} showItem />
            </a>
          ))
          : groups.map(({ latest, count, unread: u }) => (
            <a key={latest.wish_item_id} href={`#/item/${latest.wish_item_id}`} class={`alert-row ${u ? "unread" : "read"}`}
              onClick={(e) => { e.preventDefault(); open(latest); }}>
              <span class="dot" aria-hidden="true" />
              <AlertEntry alert={{ ...latest, read: !u }} showItem
                extra={count > 1 ? `${count - 1} aiempaa hälytystä 30 päivän ajalta` : undefined} />
            </a>
          ))}
      </div>
      {list.length > 0 && <p class="meta">Näytetään 30 päivää. Yli viikon vanhat merkitään luetuiksi automaattisesti.</p>}
    </div>
  );
}
