// Host cooldowns: when a site blocks us for asking too often (hinta.fi's "Pääsy rajoitettu"), stop asking
// it for a while. Every request during a block only prolongs it. The ban is on the server's address, so
// the pause is global (table public.host_cooldowns), not per household.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fetchPage, type FetchOutcome, type RobotsCache } from "./fetcher.ts";

const HOUR = 3_600_000;
/** First pause after a block. */
export const COOLDOWN_BASE_MS = 6 * HOUR;
/** Longest pause: repeated blocks double the pause up to this. */
export const COOLDOWN_MAX_MS = 48 * HOUR;
/** A block within this time after the previous pause ended counts as a repeat. */
export const COOLDOWN_REPEAT_WINDOW_MS = 48 * HOUR;

/** Domains that ban the client's address after too many requests: a block there starts a pause. */
export const COOLDOWN_DOMAINS = new Set(["hinta.fi"]);

export type Cooldown = { domain: string; until: string; hits: number; reason: string | null };

/** Length of the next pause and the repeat count, given the previous pause (if any). */
export function nextCooldown(prev: { until: string; hits: number } | null, now: number): { untilMs: number; hits: number } {
  const repeat = prev != null && now - Date.parse(prev.until) < COOLDOWN_REPEAT_WINDOW_MS;
  const hits = repeat ? prev.hits + 1 : 1;
  const ms = Math.min(COOLDOWN_BASE_MS * 2 ** (hits - 1), COOLDOWN_MAX_MS);
  return { untilMs: now + ms, hits };
}

export const isCoolingDown = (c: Cooldown | null, now = Date.now()) => c != null && Date.parse(c.until) > now;

/** "klo 18.30" today, "11.11. klo 18.30" on another day (Finnish time). */
export function fiUntil(until: string, now = Date.now()): string {
  const tz = "Europe/Helsinki";
  const day = (ms: number) => new Intl.DateTimeFormat("fi-FI", { timeZone: tz, day: "numeric", month: "numeric" }).format(ms);
  const t = Date.parse(until);
  const time = new Intl.DateTimeFormat("fi-FI", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(t);
  return day(t) === day(now) ? `klo ${time}` : `${day(t)} klo ${time}`;
}

/** The message shown to the user while a site is paused. */
export function cooldownMessage(domain: string, until: string, now = Date.now()): string {
  return `${domain} on rajoittanut hakuja tilapäisesti (liian monta hakua). Haut jatkuvat automaattisesti ` +
    `${fiUntil(until, now)} jälkeen. Sillä välin voit lisätä tuotteen kaupan omalla tai hintaopas.fi-linkillä.`;
}

export async function getCooldown(admin: SupabaseClient, domain: string): Promise<Cooldown | null> {
  const { data } = await admin.from("host_cooldowns").select("domain, until, hits, reason").eq("domain", domain).maybeSingle();
  return (data as Cooldown | null) ?? null;
}

/** Starts (or extends) the pause after a block. Returns the stored cooldown. */
export async function startCooldown(admin: SupabaseClient, domain: string, reason: string): Promise<Cooldown> {
  const prev = await getCooldown(admin, domain);
  const now = Date.now();
  // Several requests can see the same block: an active pause is not escalated again.
  if (prev && isCoolingDown(prev, now)) return prev;
  const { untilMs, hits } = nextCooldown(prev, now);
  const row: Cooldown = { domain, until: new Date(untilMs).toISOString(), hits, reason: reason.slice(0, 300) };
  await admin.from("host_cooldowns").upsert({ ...row, updated_at: new Date(now).toISOString() });
  return row;
}

/**
 * fetchPage for a site that may be paused: does not ask it at all during a pause, and starts a pause when
 * it answers with a block. `error` is then a message for the user.
 */
export async function fetchRespectingCooldown(
  admin: SupabaseClient,
  url: string,
  robots: RobotsCache,
  timeoutMs?: number,
): Promise<{ page: FetchOutcome | null; cooldown: Cooldown | null; error: string | null }> {
  const domain = new URL(url).hostname.replace(/^www\./, "");
  if (!COOLDOWN_DOMAINS.has(domain)) return { page: await fetchPage(url, robots, timeoutMs), cooldown: null, error: null };
  const active = await getCooldown(admin, domain);
  if (isCoolingDown(active)) return { page: null, cooldown: active, error: cooldownMessage(domain, active!.until) };
  const page = await fetchPage(url, robots, timeoutMs);
  if (page.blocked) {
    const c = await startCooldown(admin, domain, `Bot protection: ${page.botMarkers.join(", ")}`);
    return { page, cooldown: c, error: cooldownMessage(domain, c.until) };
  }
  return { page, cooldown: null, error: null };
}
