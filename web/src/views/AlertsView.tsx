import { useEffect, useState } from "preact/hooks";
import { supabase } from "../lib/supabase.ts";
import type { AlertEvent } from "../lib/types.ts";
import { dateTime } from "../lib/format.ts";
import { refreshUnread, toast } from "../lib/store.ts";
import { TopBar } from "../components/chrome.tsx";
import { RULE_LABELS, type RuleName } from "@shared/rules.ts";

export function AlertsView() {
  const [alerts, setAlerts] = useState<AlertEvent[] | null>(null);
  const [showInfo, setShowInfo] = useState(true);

  const load = () =>
    supabase
      .from("v_alerts")
      .select("*")
      .order("ts", { ascending: false })
      .limit(150)
      .then(({ data, error }) => {
        if (error) toast(error.message);
        setAlerts((data ?? []) as AlertEvent[]);
      });

  useEffect(() => {
    load();
  }, []);

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

  const visible = (alerts ?? []).filter((a) => showInfo || a.level === "alert");
  const unread = (alerts ?? []).filter((a) => !a.read).length;

  return (
    <div class="page stack">
      <TopBar title="Hälytykset" />
      {alerts && alerts.length > 0 && (
        <div class="actions">
          <button class="btn" disabled={unread === 0} onClick={markAll}>Merkitse kaikki luetuiksi</button>
          <label class="check" style="min-height:auto;margin-left:auto">
            <input type="checkbox" checked={showInfo} onChange={(e) => setShowInfo((e.target as HTMLInputElement).checked)} />
            Näytä epäilyttävät tarjoukset
          </label>
        </div>
      )}
      {alerts === null && <div class="skeleton" />}
      {alerts?.length === 0 && (
        <div class="empty">
          <h2>Ei hälytyksiä</h2>
          <p>Hälytys syntyy, kun hinta alittaa tavoitteen, putoaa selvästi tai tuote palaa varastoon. Säännöt voi säätää jokaiselle toiveasialle erikseen.</p>
        </div>
      )}
      <div class="stack-sm">
        {visible.map((a) => (
          <a
            key={a.id}
            href={`#/item/${a.wish_item_id}`}
            class={`alert-row ${a.read ? "read" : "unread"} ${a.level}`}
            onClick={(e) => {
              e.preventDefault();
              open(a);
            }}
          >
            <span class="dot" aria-hidden="true" />
            <div>
              <div class="title">
                {a.item_name}
                {!a.read && <span class="visually-hidden"> (lukematon)</span>}
              </div>
              <div class="muted">
                {RULE_LABELS[a.rule as RuleName] ?? a.rule}: {a.seller ? `${a.seller}, ` : ""}{a.message}
              </div>
              <div class="meta">{dateTime(a.ts)}{a.level === "info" ? " · tieto, ei ilmoitusta" : ""}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
