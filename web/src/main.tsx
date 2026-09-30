import "./lib/share-target.ts"; // must run before the router reads the URL
import { render } from "preact";
import { App } from "./app.tsx";
import { supabase } from "./lib/supabase.ts";
import { session } from "./lib/store.ts";
import { watchForUpdates } from "./lib/version.ts";
import "./styles.css";

supabase.auth.getSession().then(({ data }) => (session.value = data.session));
supabase.auth.onAuthStateChange((_event, s) => {
  session.value = s;
  // Drop ?code=… left by the PKCE magic-link redirect.
  if (location.search.includes("code=")) history.replaceState(null, "", location.pathname + location.hash);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed", e));
  // Notification click on an already open app: the SW asks us to navigate.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "navigate" && typeof e.data.url === "string") {
      const u = new URL(e.data.url);
      location.hash = u.hash || "#/";
    }
  });
}

watchForUpdates();
render(<App />, document.getElementById("app")!);
