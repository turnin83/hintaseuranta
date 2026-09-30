// Web Push (VAPID, RFC 8291/8292) via @negrel/webpush (Web Crypto, works in Deno).
// Secrets: VAPID_KEYS_JSON (output of `npm run vapid`), VAPID_SUBJECT (mailto:you@example.com).
import * as webpush from "jsr:@negrel/webpush@0.5";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type PushPayload = { title: string; body: string; url: string; tag?: string };

let server: Promise<webpush.ApplicationServer> | null = null;

function appServer(): Promise<webpush.ApplicationServer> {
  server ??= (async () => {
    const raw = Deno.env.get("VAPID_KEYS_JSON");
    if (!raw) throw new Error("VAPID_KEYS_JSON secret missing");
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(raw), { extractable: false });
    return webpush.ApplicationServer.new({
      contactInformation: Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
      vapidKeys,
    });
  })();
  return server;
}

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string; fail_count: number };

/** Sends a payload to all devices of every member of a household. */
export async function pushToHousehold(admin: SupabaseClient, householdId: string, payload: PushPayload) {
  const { data, error } = await admin.from("household_members").select("user_id").eq("household_id", householdId);
  if (error) throw error;
  return pushToUsers(admin, (data ?? []).map((m) => m.user_id as string), payload);
}

/** Sends a payload to all subscriptions of the given users. Removes subscriptions the push service reports gone. */
export async function pushToUsers(
  admin: SupabaseClient,
  userIds: string[],
  payload: PushPayload,
): Promise<{ sent: number; failed: number; errors: string[] }> {
  if (userIds.length === 0) return { sent: 0, failed: 0, errors: [] };
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, fail_count")
    .in("user_id", userIds);
  if (error) throw error;
  const result = { sent: 0, failed: 0, errors: [] as string[] };
  if (!subs?.length) return result;
  const as = await appServer();
  for (const s of subs as SubRow[]) {
    try {
      await as.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
        .pushTextMessage(JSON.stringify(payload), { urgency: webpush.Urgency.High, ttl: 24 * 3600, topic: payload.tag?.slice(0, 32) });
      result.sent++;
      await admin.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), fail_count: 0 }).eq("id", s.id);
    } catch (e) {
      result.failed++;
      if (e instanceof webpush.PushMessageError && e.isGone()) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
        result.errors.push("subscription gone (removed)");
      } else {
        result.errors.push(String(e));
        await admin.from("push_subscriptions").update({ fail_count: s.fail_count + 1 }).eq("id", s.id);
      }
    }
  }
  return result;
}
