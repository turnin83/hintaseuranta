import { signal } from "@preact/signals";

export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;
export const APP_BUILD_TIME = __APP_BUILD_TIME__;

/** "v1.1.0 · 27d1b8f · käännetty 1.10. klo 12.00" */
export function versionLabel(): string {
  const built = new Date(APP_BUILD_TIME).toLocaleString("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `v${APP_VERSION} · ${APP_COMMIT} · käännetty ${built}`;
}

/** True when the server has a newer deploy than the bundle running in this page. */
export const updateReady = signal(false);

async function checkForUpdate() {
  if (updateReady.value || APP_COMMIT === "dev") return;
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return;
    const remote = (await res.json()) as { commit?: string };
    if (remote.commit && remote.commit !== APP_COMMIT) updateReady.value = true;
  } catch { /* offline */ }
}

/** Check when the app comes to the foreground and every 30 min while open. */
export function watchForUpdates() {
  checkForUpdate();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && checkForUpdate());
  setInterval(checkForUpdate, 30 * 60_000);
}
