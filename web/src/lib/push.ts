import { supabase } from "./supabase.ts";

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export function platform() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone = matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { ios, standalone, supported, vapidConfigured: Boolean(VAPID) };
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!platform().supported) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Asks permission (must run from a user gesture), subscribes and stores the subscription. */
export async function enablePush(): Promise<void> {
  if (!VAPID) throw new Error("VITE_VAPID_PUBLIC_KEY puuttuu");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Ilmoituslupaa ei annettu. Salli ilmoitukset selaimen asetuksista.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID) });
  }
  const json = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      endpoint: sub.endpoint,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
      user_agent: navigator.userAgent.slice(0, 300),
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}
