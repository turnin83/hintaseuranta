import { useEffect } from "preact/hooks";
import { route } from "./lib/router.ts";
import { refreshUnread, session } from "./lib/store.ts";
import { configMissing } from "./lib/supabase.ts";
import { updateReady } from "./lib/version.ts";
import { TabBar, Toast } from "./components/chrome.tsx";
import { ListView } from "./views/ListView.tsx";
import { ItemView } from "./views/ItemView.tsx";
import { AlertsView } from "./views/AlertsView.tsx";
import { DealsView } from "./views/DealsView.tsx";
import { AddView } from "./views/AddView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { LoginView } from "./views/LoginView.tsx";

export function App() {
  const s = session.value;

  useEffect(() => {
    if (!s) return;
    refreshUnread();
    const onVisible = () => document.visibilityState === "visible" && refreshUnread();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [s?.user.id]);

  if (configMissing) {
    return (
      <main class="login">
        <h1>Asetukset puuttuvat</h1>
        <p class="muted">Aseta VITE_SUPABASE_URL ja VITE_SUPABASE_ANON_KEY (ks. web/.env.example ja README).</p>
      </main>
    );
  }
  if (s === undefined) return null;
  if (s === null) return <LoginView />;

  const r = route.value;
  return (
    <div class="app">
      <main>
        {r.name === "list" && <ListView />}
        {r.name === "item" && <ItemView key={r.id} id={r.id} />}
        {r.name === "deals" && <DealsView />}
        {r.name === "alerts" && <AlertsView />}
        {r.name === "add" && <AddView key={`${r.url}|${r.item}`} url={r.url} item={r.item} />}
        {r.name === "settings" && <SettingsView />}
      </main>
      <TabBar />
      <Toast />
      {updateReady.value && (
        <div class="update-bar" role="status">
          <span>Uusi versio saatavilla</span>
          <button class="btn primary" onClick={() => location.reload()}>Päivitä</button>
        </div>
      )}
    </div>
  );
}
