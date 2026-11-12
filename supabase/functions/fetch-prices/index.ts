// fetch-prices: fetch due product links, store observations, evaluate alert rules, send Web Push.
//
// Triggers:
//   - pg_cron (header x-cron-secret = CRON_SECRET): claims links that are due for all users.
//   - signed-in user (Authorization: Bearer <jwt>): body {link_ids?: string[], wish_item_id?: string}
//     fetches that user's household links right away (e.g. after adding a link, or "Päivitä nyt").
//
// Politeness: links are grouped per shop domain; one domain is fetched sequentially with the shop's
// min_delay_ms between requests; a few domains run in parallel. A run stops starting new fetches when
// the time budget is used up; unfinished links stay due and are picked up by the next tick.
//
// Alerts: shop-level reasons (drop, back in stock) are collected while links are fetched; after the
// fetches each touched item gets its item-level reasons (below target, all-time low, below usual price)
// and everything is merged into ONE event per item (rules.ts buildEvent). Only significant events are
// pushed. Sellers without a known shop (comparison page lows), muted sellers and duplicates of a shop the
// item already follows directly are left out of alerts.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS, isCronRequest, json, userFromRequest } from "../_shared/http.ts";
import { createRobotsCache, fetchPage, sleep, type RobotsCache } from "../_shared/fetcher.ts";
import { extractPage } from "../_shared/extract.ts";
import { sellerKey, sellerMatchesShop } from "../_shared/search.ts";
import {
  bigDrops,
  CAMPAIGN_NIGHT_RULES,
  claimCheck,
  confirmDrops,
  describeClaim,
  eur,
  evaluateAfterPurchase,
  evaluateItemRules,
  evaluateSeriesRules,
  type EventDraft,
  expandHistory,
  HISTORY_SELLER,
  type ItemAlertState,
  buildEvent,
  meaningfulDrop,
  mergeRules,
  type Obs,
  ownLow30d,
  passesCooldown,
  type PrevAlert,
  type Reason,
  type RuleName,
  type Rules,
} from "../_shared/rules.ts";
import type { Availability, Offer, PageData, PricePoint } from "../_shared/types.ts";
import { pushToHousehold } from "../_shared/push.ts";
import { enrichPage } from "../_shared/enrich.ts";
import {
  type Cooldown,
  COOLDOWN_DOMAINS,
  cooldownMessage,
  fiUntil,
  getCooldown,
  isCoolingDown,
  startCooldown,
} from "../_shared/cooldown.ts";

const TIME_BUDGET_MS = 110_000; // wall clock limit on the free plan is 150 s
const MAX_LINKS = 150;
const DOMAIN_CONCURRENCY = 4;
const HISTORY_LIMIT = 1000;
const FRESH_MS = 36 * 3_600_000; // an offer older than this is not a "current" price (same as v_wish_summary)
const DAY = 86_400_000;

type LinkRow = {
  id: string;
  user_id: string;
  household_id: string;
  wish_item_id: string;
  shop_id: number;
  url: string;
  ean: string | null;
  model_name: string | null;
  sellers: string[] | null;
  fail_count: number;
  failing_since: string | null;
  last_status: string | null;
  created_at: string;
};
type ShopRow = { id: number; household_id: string; domain: string; name: string | null; strategy: string; min_delay_ms: number };
type ItemRow = {
  id: string;
  household_id: string;
  name: string;
  target_price_cents: number | null;
  rules: unknown;
  purchased_at: string | null;
  purchased_price_cents: number | null;
  alert_state: ItemAlertState | null;
};
type SeriesRow = {
  product_link_id: string;
  seller: string;
  seller_name: string;
  shop_strategy: string;
  price_cents: number;
  ts: string;
  availability: Availability;
  lowest_30d_cents: number | null;
  own_low_30d_cents: number | null;
};

type PendingPush = {
  id: number;
  itemId: string;
  itemName: string;
  seller: string;
  message: string;
  urgent?: boolean; // pushed at once during campaign nights (CAMPAIGN_NIGHT_RULES)
};
type Ctx = {
  ok: number;
  fail: number;
  events: number;
  alerts: PendingPush[]; // events to push
  reasons: Map<string, Reason[]>; // shop-level reasons per item, merged after the fetches
  errors: { url: string; error: string }[];
};
type HouseholdRow = {
  id: string;
  default_rules: unknown;
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
  timezone: string;
  muted_sellers: string[];
};
const HOUSEHOLD_COLS = "id, default_rules, quiet_enabled, quiet_start, quiet_end, timezone, muted_sellers";
type IsMuted = (sellerName: string) => boolean;

/** Quiet hours in the household's time zone (start inclusive, end exclusive; may wrap midnight). */
function inQuietHours(h: HouseholdRow | undefined, at = new Date()): boolean {
  if (!h?.quiet_enabled || h.quiet_start === h.quiet_end) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: h.timezone }).format(at));
  return h.quiet_start < h.quiet_end
    ? hour >= h.quiet_start && hour < h.quiet_end
    : hour >= h.quiet_start || hour < h.quiet_end;
}

function mutedMatcher(names: string[] | undefined): IsMuted {
  const list = names ?? [];
  return (name) => list.some((m) => sellerKey(m) === sellerKey(name) || sellerMatchesShop(name, { domain: m, name: m }));
}

/** Can this offer raise alerts? Not a comparison page's anonymous low price, not a muted seller. */
function alertable(s: SeriesRow, isMuted: IsMuted): boolean {
  return !(s.shop_strategy === "aggregator" && s.seller === "") && !isMuted(s.seller_name);
}

type ObsRow = { ts: string; price_cents: number; availability: string; lowest_30d_cents: number | null };

/** SQL: item_price_stats. The item's usual price and lowest price of the last 90 days. */
type ItemStats = {
  usual_cents: number | null;
  usual_days: number;
  low_cents: number | null;
  low_ts: string | null;
  low_shop: string | null;
  has_history: boolean;
};

const toObs = (r: ObsRow): Obs => ({
  ts: Date.parse(r.ts),
  priceCents: r.price_cents,
  availability: r.availability as Availability,
  lowest30dCents: r.lowest_30d_cents,
});

const fiDay = (ts: string) => {
  const d = new Date(ts);
  return `${d.getDate()}.${d.getMonth() + 1}.`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const admin = adminClient();
  const body = await req.json().catch(() => ({})) as { link_ids?: string[]; wish_item_id?: string };
  const started = new Date();
  let trigger: "cron" | "manual";
  let links: LinkRow[];
  let triggeredBy: string | null = null;

  if (isCronRequest(req)) {
    trigger = "cron";
    const { data, error } = await admin.rpc("claim_due_links", { max_links: MAX_LINKS });
    if (error) return json({ error: error.message }, 500);
    links = data ?? [];
  } else {
    const user = await userFromRequest(req, admin);
    if (!user) return json({ error: "unauthorized" }, 401);
    trigger = "manual";
    triggeredBy = user.id;
    const { data: member } = await admin.from("household_members").select("household_id").eq("user_id", user.id).maybeSingle();
    if (!member) return json({ error: "Käyttäjä ei kuulu kotitalouteen" }, 403);
    let q = admin.from("product_links").select("*").eq("household_id", member.household_id).eq("active", true);
    if (body.link_ids?.length) q = q.in("id", body.link_ids);
    else if (body.wish_item_id) q = q.eq("wish_item_id", body.wish_item_id);
    const { data, error } = await q.limit(MAX_LINKS);
    if (error) return json({ error: error.message }, 500);
    links = data ?? [];
    if (links.length) {
      await admin.from("product_links")
        .update({ claimed_until: new Date(Date.now() + 10 * 60_000).toISOString() })
        .in("id", links.map((l) => l.id));
    }
  }

  if (links.length === 0) {
    // Nothing to fetch, but a quiet-hours summary may be waiting.
    const digests = trigger === "cron" ? await deliverDeferredOnly(admin) : 0;
    return json({ trigger, links: 0, digests });
  }

  const [shops, items, households] = await Promise.all([
    admin.from("shops").select("id, household_id, domain, name, strategy, min_delay_ms").in("id", [...new Set(links.map((l) => l.shop_id))]),
    admin.from("wish_items")
      .select("id, household_id, name, target_price_cents, rules, purchased_at, purchased_price_cents, alert_state")
      .in("id", [...new Set(links.map((l) => l.wish_item_id))]),
    admin.from("households").select(HOUSEHOLD_COLS).in("id", [...new Set(links.map((l) => l.household_id))]),
  ]);
  const shopById = new Map((shops.data as ShopRow[] ?? []).map((s) => [s.id, s]));
  const itemById = new Map((items.data as ItemRow[] ?? []).map((i) => [i.id, i]));
  const householdById = new Map(((households.data ?? []) as HouseholdRow[]).map((h) => [h.id, h]));
  const rulesFor = (item: ItemRow): Rules => mergeRules(householdById.get(item.household_id)?.default_rules, item.rules);
  const mutedFor = new Map([...householdById.values()].map((h) => [h.id, mutedMatcher(h.muted_sellers)]));
  const isMutedFor = (hid: string): IsMuted => mutedFor.get(hid) ?? (() => false);

  // Results are collected per household (shared data, shared pushes, one run log each).
  const ctxByHousehold = new Map<string, Ctx>();
  const ctxFor = (hid: string) => {
    if (!ctxByHousehold.has(hid)) {
      ctxByHousehold.set(hid, { ok: 0, fail: 0, events: 0, alerts: [], reasons: new Map(), errors: [] });
    }
    return ctxByHousehold.get(hid)!;
  };
  const touchedItems = new Set<string>();

  // Group links per shop domain.
  const queues = new Map<number, LinkRow[]>();
  for (const l of links) queues.set(l.shop_id, [...(queues.get(l.shop_id) ?? []), l]);

  const deadline = Date.now() + TIME_BUDGET_MS;
  const robots = createRobotsCache();
  const released: string[] = [];

  const runQueue = async (shopId: number) => {
    const shop = shopById.get(shopId)!;
    const queue = queues.get(shopId)!;
    // A site that banned us (hinta.fi) is left alone until its pause ends; the links stay due.
    const paused = COOLDOWN_DOMAINS.has(shop.domain) ? await getCooldown(admin, shop.domain) : null;
    if (isCoolingDown(paused)) {
      released.push(...queue.map((l) => l.id));
      for (const hid of new Set(queue.map((l) => l.household_id))) {
        ctxFor(hid).errors.push({ url: shop.domain, error: cooldownMessage(shop.domain, paused!.until) });
      }
      return;
    }
    for (let i = 0; i < queue.length; i++) {
      const link = queue[i];
      if (Date.now() > deadline) {
        released.push(...queue.slice(i).map((l) => l.id));
        return;
      }
      const item = itemById.get(link.wish_item_id);
      if (!item) continue;
      const ctx = ctxFor(link.household_id);
      try {
        const r = await processLink(admin, robots, link, shop, item, rulesFor(item), isMutedFor(item.household_id), ctx);
        if (r === true) touchedItems.add(item.id);
        if (r === "blocked") {
          if (COOLDOWN_DOMAINS.has(shop.domain)) {
            const before = await getCooldown(admin, shop.domain);
            const c = await startCooldown(admin, shop.domain, `Bot protection on ${link.url}`);
            if (!isCoolingDown(before) && c.hits === 1) await notifyPause(admin, shop, c, householdById.get(shop.household_id));
          }
          // The shop blocks us: leave its other links to a later tick instead of insisting.
          released.push(...queue.slice(i + 1).map((l) => l.id));
          return;
        }
      } catch (e) {
        ctx.fail++;
        ctx.errors.push({ url: link.url, error: String(e) });
        await admin.from("product_links").update({
          last_status: "error",
          last_error: String(e).slice(0, 500),
          fail_count: link.fail_count + 1,
          claimed_until: null,
        }).eq("id", link.id);
      }
      if (i < queue.length - 1) await sleep(shop.min_delay_ms);
    }
  };

  // Simple pool: DOMAIN_CONCURRENCY domains at a time.
  const shopIds = [...queues.keys()];
  await Promise.all(
    Array.from({ length: Math.min(DOMAIN_CONCURRENCY, shopIds.length) }, async () => {
      while (shopIds.length) await runQueue(shopIds.shift()!);
    }),
  );

  if (released.length) await admin.from("product_links").update({ claimed_until: null }).in("id", released);

  // One event per item that got new prices in this run.
  for (const itemId of touchedItems) {
    const item = itemById.get(itemId)!;
    const ctx = ctxFor(item.household_id);
    try {
      await evaluateItem(admin, item, rulesFor(item), isMutedFor(item.household_id), started, ctx);
    } catch (e) {
      ctx.errors.push({ url: `item ${item.name}`, error: String(e) });
    }
  }

  // Push (or defer during quiet hours) + run log per household.
  for (const [householdId, ctx] of ctxByHousehold) {
    try {
      await deliverPushes(admin, householdById.get(householdId), householdId, ctx.alerts, ctx);
    } catch (e) {
      ctx.errors.push({ url: "push", error: String(e) });
    }
    await admin.from("fetch_runs").insert({
      household_id: householdId,
      user_id: triggeredBy,
      trigger,
      started_at: started.toISOString(),
      ok_count: ctx.ok,
      fail_count: ctx.fail,
      alert_count: ctx.events,
      errors: ctx.errors.slice(0, 50),
    });
  }

  const totals = [...ctxByHousehold.values()].reduce(
    (a, c) => ({ ok: a.ok + c.ok, fail: a.fail + c.fail, alerts: a.alerts + c.events, pushed: a.pushed + c.alerts.length }),
    { ok: 0, fail: 0, alerts: 0, pushed: 0 },
  );
  return json({ trigger, links: links.length, deferred: released.length, ...totals, ms: Date.now() - started.getTime() });
});

/** Current offers of an item: tracked, fresh, not out of stock. */
async function currentOffers(admin: SupabaseClient, itemId: string): Promise<SeriesRow[]> {
  const { data, error } = await admin.from("v_series")
    .select("product_link_id, seller, seller_name, shop_strategy, price_cents, ts, availability, lowest_30d_cents, own_low_30d_cents")
    .eq("wish_item_id", itemId).eq("tracked", true);
  if (error) throw error;
  const now = Date.now();
  return ((data ?? []) as SeriesRow[]).filter((s) => s.availability !== "out_of_stock" && now - Date.parse(s.ts) < FRESH_MS);
}

/** Latest earlier event that contained this reason (cooldowns of shop-level rules, purchase, broken link). */
async function lastReason(
  admin: SupabaseClient,
  itemId: string,
  rule: RuleName,
  link?: string,
  series?: string,
): Promise<PrevAlert | undefined> {
  const match: Record<string, string> = { rule };
  if (link) match.link = link;
  if (series !== undefined) match.series = series;
  const { data } = await admin.from("alert_events").select("ts, price_cents, details")
    .eq("wish_item_id", itemId).contains("details", { reasons: [match] })
    .order("ts", { ascending: false }).limit(1).maybeSingle();
  if (data) {
    const reasons = ((data.details as { reasons?: Record<string, unknown>[] } | null)?.reasons ?? []);
    const r = reasons.find((x) => Object.entries(match).every(([k, v]) => x[k] === v));
    return { ts: Date.parse(data.ts), priceCents: (r?.price as number | undefined) ?? data.price_cents };
  }
  // Events from before merged alerts (no details).
  let q = admin.from("alert_events").select("ts, price_cents").eq("wish_item_id", itemId).eq("rule", rule).is("details", null);
  if (link) q = q.eq("product_link_id", link);
  if (series !== undefined) q = q.eq("seller", series);
  const { data: old } = await q.order("ts", { ascending: false }).limit(1).maybeSingle();
  return old ? { ts: Date.parse(old.ts), priceCents: old.price_cents } : undefined;
}

/** Stores one merged event; significant ones are queued for push. */
async function insertEvent(
  admin: SupabaseClient,
  ctx: Ctx,
  item: ItemRow,
  d: EventDraft,
  reasons: Reason[],
  userId: string | null,
) {
  const { data, error } = await admin.from("alert_events").insert({
    user_id: userId,
    household_id: item.household_id,
    wish_item_id: item.id,
    product_link_id: d.link,
    seller: d.seller,
    rule: d.rule,
    rules: d.rules,
    level: "alert",
    price_cents: d.priceCents,
    ref_cents: d.refCents,
    message: d.message,
    notify: d.notify,
    details: {
      headline: d.headline,
      lines: d.lines,
      line_rules: d.lineRules,
      warning: d.warning,
      seller: d.seller,
      reasons: reasons.map((r) => ({ rule: r.rule, link: r.link, series: r.series, price: r.priceCents })),
    },
  }).select("id").single();
  if (error) throw error;
  ctx.events++;
  if (d.notify) {
    ctx.alerts.push({
      id: data.id,
      itemId: item.id,
      itemName: item.name,
      seller: d.seller,
      message: d.message + (d.warning ? ` · Huom: ${d.warning}` : ""),
      urgent: d.rules.some((r) => CAMPAIGN_NIGHT_RULES.includes(r)),
    });
  }
}

type OtherLink = { id: string; created_at: string; shops: { domain: string; name: string | null; strategy: string } };

/** The item's other active links with their shops. */
async function otherLinks(admin: SupabaseClient, link: LinkRow): Promise<OtherLink[]> {
  const { data } = await admin.from("product_links").select("id, created_at, shops(domain, name, strategy)")
    .eq("wish_item_id", link.wish_item_id).eq("active", true).neq("id", link.id);
  return (data ?? []) as unknown as OtherLink[];
}

/**
 * Comparison page: remember what it shows for each of the item's direct shop links (product_links.xcheck).
 * The item page flags a clearly different price, so a misread shop page is caught before buying.
 */
async function noteCrossChecks(admin: SupabaseClient, others: OtherLink[], pageOffers: Offer[], via: string, ts: string) {
  for (const d of others.filter((o) => o.shops && o.shops.strategy !== "aggregator")) {
    const o = pageOffers.find((x) =>
      x.seller && x.priceCents != null && x.availability !== "out_of_stock" && sellerMatchesShop(x.seller, d.shops)
    );
    if (o) await admin.from("product_links").update({ xcheck: { cents: o.priceCents, via, ts } }).eq("id", d.id);
  }
}

/**
 * Aggregator pages: leave out sellers the item already follows elsewhere (its direct shop links, or a
 * comparison link that ranks first) so one price change is not recorded and alerted twice. The link's seller
 * selection is updated so the exclusion sticks; history is kept.
 */
async function dropDuplicateSellers(
  admin: SupabaseClient,
  link: LinkRow,
  domain: string,
  offers: Offer[],
  others: OtherLink[],
): Promise<Offer[]> {
  const sellers = offers.map((o) => o.seller).filter((s): s is string => Boolean(s));
  if (sellers.length === 0) return offers;
  const direct = others.filter((o) => o.shops?.strategy !== "aggregator").map((o) => o.shops);
  // Another comparison link keeps a shared seller when it ranks first: hintaopas.fi before the others
  // (hinta.fi bans the server when asked often), then the older link.
  const rank = (d: string | undefined) => (d === "hintaopas.fi" ? 0 : 1);
  const earlierAgg = others.filter((o) =>
    o.shops?.strategy === "aggregator" &&
    (rank(o.shops.domain) < rank(domain) || (rank(o.shops.domain) === rank(domain) && o.created_at < link.created_at))
  ).map((o) => o.id);
  let earlierKeys = new Set<string>();
  if (earlierAgg.length) {
    const { data: tracked } = await admin.from("v_series").select("seller").in("product_link_id", earlierAgg).eq("tracked", true).neq("seller", "");
    earlierKeys = new Set((tracked ?? []).map((t) => sellerKey(t.seller as string)));
  }
  const dupes = new Set(sellers.filter((s) => direct.some((shop) => sellerMatchesShop(s, shop)) || earlierKeys.has(sellerKey(s))));
  if (dupes.size === 0) return offers;
  const keep = (link.sellers ?? sellers).filter((s) => !dupes.has(s) && ![...dupes].some((d) => sellerKey(d) === sellerKey(s)));
  await admin.from("product_links").update(keep.length ? { sellers: keep } : { active: false }).eq("id", link.id);
  return offers.filter((o) => o.seller && !dupes.has(o.seller));
}

type ReadResult =
  | { ok: true; page: PageData; offers: Offer[] }
  | { ok: false; status: "error" | "blocked" | "no_data"; error: string };

/** Reads the link's page: the offers to record (comparison page: the selected sellers; shop: its price). */
async function readOffers(link: LinkRow, robots: RobotsCache): Promise<ReadResult> {
  const f = await fetchPage(link.url, robots);
  if (f.blocked) return { ok: false, status: "blocked", error: `Bot protection: ${f.botMarkers.join(", ")}` };
  if (f.error) return { ok: false, status: "error", error: f.error };

  const parsed = extractPage(f.html, link.url);
  const page = parsed ? await enrichPage(parsed, link.url) : null;
  if (!page || page.offers.length === 0) {
    return { ok: false, status: "no_data", error: "No price found (no Product JSON-LD / adapter data)" };
  }
  let offers = page.offers;
  if (page.kind === "aggregator" && link.sellers?.length) {
    const wanted = new Set(link.sellers.map(sellerKey));
    offers = offers.filter((o) => o.seller && wanted.has(sellerKey(o.seller)));
    if (offers.length === 0) return { ok: false, status: "no_data", error: `Selected sellers not listed: ${link.sellers.join(", ")}` };
  }
  if (page.kind === "shop") offers = offers.slice(0, 1).map((o) => ({ ...o, seller: null }));
  return { ok: true, page, offers };
}

/**
 * Comparison page with a price history (hintaopas.fi): once per link, store the market's daily lowest
 * price for the days before the item was first tracked (HISTORY_SELLER), so a product added in the middle
 * of a sale is judged against the price before the sale.
 */
async function backfillHistory(admin: SupabaseClient, link: LinkRow, points: PricePoint[]) {
  const { count } = await admin.from("price_observations").select("id", { count: "exact", head: true })
    .eq("product_link_id", link.id).eq("seller", HISTORY_SELLER);
  if (count) return;
  const { data: ids } = await admin.from("product_links").select("id").eq("wish_item_id", link.wish_item_id);
  const { data: first } = await admin.from("price_observations").select("ts")
    .in("product_link_id", (ids ?? []).map((r) => r.id as string)).neq("seller", HISTORY_SELLER)
    .order("ts").limit(1).maybeSingle();
  const days = expandHistory(points, first ? Date.parse(first.ts) : Date.now());
  if (days.length === 0) return;
  const { error } = await admin.from("price_observations").insert(days.map((d) => ({
    user_id: link.user_id,
    household_id: link.household_id,
    product_link_id: link.id,
    seller: HISTORY_SELLER,
    ts: d.ts,
    price_cents: d.priceCents,
    currency: "EUR",
    availability: "in_stock",
    source: "history",
    history_shop: d.shop,
  })));
  if (error) throw error;
}

/**
 * Fetches one link, stores observations and collects shop-level reasons. Returns true on success and
 * "blocked" when the shop's bot protection answered.
 */
async function processLink(
  admin: SupabaseClient,
  robots: RobotsCache,
  link: LinkRow,
  shop: ShopRow,
  item: ItemRow,
  rules: Rules,
  isMuted: IsMuted,
  ctx: Ctx,
): Promise<boolean | "blocked"> {
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const fail = async (status: "error" | "blocked" | "no_data", error: string) => {
    ctx.fail++;
    ctx.errors.push({ url: link.url, error });
    const failingSince = link.failing_since ?? now;
    await admin.from("product_links").update({
      last_fetched_at: now,
      last_status: status,
      last_error: error.slice(0, 500),
      fail_count: link.fail_count + 1,
      failing_since: failingSince,
      claimed_until: null,
    }).eq("id", link.id);
    await admin.from("shops").update({ last_error: `${status}: ${error}`.slice(0, 500) }).eq("id", shop.id);
    // Broken for over a day: one alert per link per week (not for purchased items). A block is the shop's
    // doing and hits all its links at once: Settings shows it instead of an alert per link.
    if (status !== "blocked" && !item.purchased_at && nowMs - Date.parse(failingSince) > DAY) {
      const prev = await lastReason(admin, item.id, "link_broken", link.id);
      if (!prev || nowMs - prev.ts >= 7 * DAY) {
        const reason: Reason = {
          rule: "link_broken", level: "alert", priceCents: 0, refCents: null,
          seller: shop.name || shop.domain, link: link.id, series: "",
        };
        await insertEvent(admin, ctx, item, buildEvent([reason], { pushMinPct: rules.push_min_pct })!, [reason], link.user_id);
      }
    }
    return status === "blocked" ? "blocked" as const : false;
  };

  const read = await readOffers(link, robots);
  if (!read.ok) return fail(read.status, read.error);
  const page = read.page;
  let offers = read.offers;
  if (page.history?.length) await backfillHistory(admin, link, page.history);
  if (page.kind === "aggregator") {
    const others = await otherLinks(admin, link);
    await noteCrossChecks(admin, others, page.offers, shop.name || shop.domain, now);
    offers = await dropDuplicateSellers(admin, link, shop.domain, offers, others);
  }

  // History per series before this observation (own 30-day low + shop rules).
  const histories = new Map<string, Obs[]>();
  for (const o of offers) {
    const seller = o.seller ?? "";
    const { data: hist, error } = await admin.from("price_observations")
      .select("ts, price_cents, availability, lowest_30d_cents")
      .eq("product_link_id", link.id).eq("seller", seller).lt("ts", now)
      .order("ts", { ascending: false }).limit(HISTORY_LIMIT);
    if (error) throw error;
    histories.set(seller, ((hist ?? []) as ObsRow[]).map(toObs));
  }

  // A big drop is read again before it is recorded. Unconfirmed ones leave the link due, so the next
  // tick (15 min) tries again; fail_count (with status "ok") counts those tries, and after 3 the price
  // is recorded as read.
  const lastCents = new Map([...histories].filter(([, h]) => h.length > 0).map(([k, h]) => [k, h[0].priceCents]));
  const pendingTries = link.last_status === "ok" ? link.fail_count : 0;
  let unconfirmed: Offer[] = [];
  if (pendingTries < 3 && bigDrops(offers, lastCents).length) {
    await sleep(shop.min_delay_ms);
    const again = await readOffers(link, robots);
    ({ offers, unconfirmed } = confirmDrops(offers, lastCents, again.ok ? again.offers : null));
    if (unconfirmed.length) {
      ctx.errors.push({
        url: link.url,
        error: `Big drop not confirmed on re-read (${unconfirmed.map((o) => eur(o.priceCents!)).join(", ")}), retrying`,
      });
    }
  }

  const rows = offers.map((o) => ({
    user_id: link.user_id,
    household_id: link.household_id,
    product_link_id: link.id,
    seller: o.seller ?? "",
    ts: now,
    price_cents: o.priceCents!,
    currency: o.currency ?? "EUR",
    availability: o.availability,
    lowest_30d_cents: o.lowest30dCents,
    own_low_30d_cents: ownLow30d(histories.get(o.seller ?? "") ?? [], nowMs),
    shipping_cents: o.shippingCents ?? null,
    source: page.source,
  }));
  if (rows.length) {
    const { error: insErr } = await admin.from("price_observations").insert(rows);
    if (insErr) throw insErr;
  }

  if (!item.purchased_at && rows.length) {
    // Other shops' current offers (for "only when this shop is the cheapest").
    const offersNow = (await currentOffers(admin, item.id)).filter((s) => alertable(s, isMuted));
    for (const row of rows) {
      if (page.kind === "aggregator" && !row.seller) continue; // comparison page low: shop unknown
      const sellerName = row.seller || shop.name || shop.domain;
      if (isMuted(sellerName)) continue;
      const others = offersNow.filter((s) => !(s.product_link_id === link.id && s.seller === row.seller));
      const othersBestCents = others.length ? Math.min(...others.map((s) => s.price_cents)) : null;
      const candidates = evaluateSeriesRules({
        current: toObs(row), history: histories.get(row.seller) ?? [], othersBestCents, rules,
      });
      for (const c of candidates) {
        const prev = await lastReason(admin, item.id, c.rule, link.id, row.seller);
        if (!passesCooldown(c, prev, nowMs, rules.cooldown_hours)) continue;
        const list = ctx.reasons.get(item.id) ?? [];
        list.push({ ...c, seller: sellerName, link: link.id, series: row.seller });
        ctx.reasons.set(item.id, list);
      }
    }
  }

  ctx.ok++;
  await admin.from("product_links").update({
    ...(unconfirmed.length ? { fail_count: pendingTries + 1 } : { last_fetched_at: now, fail_count: 0 }),
    last_status: "ok",
    last_error: null,
    failing_since: null,
    claimed_until: null,
    ...(link.ean == null && page.ean ? { ean: page.ean } : {}),
    ...(link.model_name == null && page.name ? { model_name: page.name.slice(0, 200) } : {}),
  }).eq("id", link.id);
  await admin.from("shops").update({ last_ok_at: now, last_error: null }).eq("id", shop.id);
  return true;
}

/** Item rules on the best current price, merged with the run's shop-level reasons into one event. */
async function evaluateItem(
  admin: SupabaseClient,
  item: ItemRow,
  rules: Rules,
  isMuted: IsMuted,
  started: Date,
  ctx: Ctx,
) {
  const offers = (await currentOffers(admin, item.id)).filter((s) => alertable(s, isMuted));
  const pending = ctx.reasons.get(item.id) ?? [];
  if (offers.length === 0) return;
  const best = offers.reduce((a, b) => (b.price_cents < a.price_cents ? b : a));
  const atBest = { seller: best.seller_name, link: best.product_link_id, series: best.seller };

  if (item.purchased_at) {
    const c = evaluateAfterPurchase(best.price_cents, item.purchased_price_cents);
    if (!c) return;
    const prev = await lastReason(admin, item.id, "price_after_purchase");
    if (prev && !(c.priceCents < prev.priceCents) && Date.now() - prev.ts < 72 * 3_600_000) return;
    const reason: Reason = { ...c, ...atBest };
    await insertEvent(admin, ctx, item, buildEvent([reason], { pushMinPct: rules.push_min_pct })!, [reason], null);
    return;
  }

  const { data: linkData } = await admin.from("product_links").select("id, shops(strategy)").eq("wish_item_id", item.id);
  const linkList = (linkData ?? []) as unknown as { id: string; shops: { strategy: string } | null }[];
  const linkIds = linkList.map((l) => l.id);
  const directIds = linkList.filter((l) => l.shops?.strategy !== "aggregator").map((l) => l.id);
  const before = started.toISOString();

  const [sellerMin, directMin, countQ, statsQ] = await Promise.all([
    admin.from("price_observations").select("price_cents").in("product_link_id", linkIds).neq("seller", "").lt("ts", before)
      .order("price_cents").limit(1).maybeSingle(),
    admin.from("price_observations").select("price_cents").in("product_link_id", directIds).lt("ts", before)
      .order("price_cents").limit(1).maybeSingle(),
    admin.from("price_observations").select("id", { count: "exact", head: true }).in("product_link_id", linkIds).lt("ts", before),
    admin.rpc("item_price_stats", { p_item: item.id, p_before: before }).single(),
  ]);
  if (statsQ.error) throw statsQ.error;
  const stats = statsQ.data as ItemStats;
  const prevMin = [sellerMin.data?.price_cents, directMin.data?.price_cents].filter((v): v is number => v != null);

  // A new item normally starts silently (no baseline yet). With the price history from before tracking
  // there is one, so a sale that was already on when the item was added is alerted at once.
  const { candidates, next } = evaluateItemRules({
    bestCents: best.price_cents,
    prevMinCents: prevMin.length ? Math.min(...prevMin) : null,
    prevObsCount: countQ.count ?? 0,
    medianCents: stats.usual_cents,
    medianDays: stats.usual_days,
    targetCents: item.target_price_cents,
  }, rules, item.alert_state ?? (stats.has_history ? {} : null));
  if (JSON.stringify(next) !== JSON.stringify(item.alert_state)) {
    await admin.from("wish_items").update({ alert_state: next }).eq("id", item.id);
  }

  const reasons: Reason[] = [...candidates.map((c) => ({ ...c, ...atBest })), ...pending];
  if (reasons.length === 0) return;

  // Warnings that keep a "deal" honest.
  const warnings: string[] = [];
  const claim = claimCheck(best.price_cents, best.lowest_30d_cents, best.own_low_30d_cents);
  if (claim && claim.kind !== "ok") warnings.push(describeClaim(claim));
  const inflated = stats.low_cents != null && meaningfulDrop(best.price_cents, stats.low_cents) &&
    best.price_cents > stats.low_cents * 1.05;
  if (inflated) {
    const where = stats.low_shop ? ` (${stats.low_shop})` : "";
    warnings.push(`Hinta oli alempi ${fiDay(stats.low_ts!)}: ${eur(stats.low_cents!)}${where}.`);
  }

  const draft = buildEvent(reasons, { pushMinPct: rules.push_min_pct, warnings, inflated });
  if (draft) await insertEvent(admin, ctx, item, draft, reasons, null);
}

/** A site started a pause (the first block in a while): one notice, so a silent outage is not missed. */
async function notifyPause(admin: SupabaseClient, shop: ShopRow, c: Cooldown, household: HouseholdRow | undefined) {
  if (inQuietHours(household)) return; // Settings shows it in the morning
  await pushToHousehold(admin, shop.household_id, {
    title: `${shop.domain} rajoittaa hakuja`,
    body: `Haut jatkuvat ${fiUntil(c.until)} jälkeen. Muiden kauppojen hinnat haetaan normaalisti.`,
    url: "/#/settings",
    tag: `pause-${shop.domain}`,
  }).catch(() => {});
}

/** Name of a campaign running today in the household's time zone, if any. */
async function runningCampaign(admin: SupabaseClient, h: HouseholdRow): Promise<string | null> {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: h.timezone }).format(new Date()); // YYYY-MM-DD
  const { data } = await admin.from("campaigns").select("name")
    .eq("household_id", h.id).eq("active", true).lte("starts_on", today).gte("ends_on", today)
    .limit(1).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

/**
 * Quiet hours: new alerts are marked deferred and not pushed, except target / all-time-low alerts while a
 * campaign runs (deals often start at midnight and sell out by morning). Otherwise deferred alerts from
 * the last 24 h are delivered together with the new ones as one morning summary.
 */
async function deliverPushes(
  admin: SupabaseClient,
  household: HouseholdRow | undefined,
  householdId: string,
  fresh: PendingPush[],
  ctx: { errors: { url: string; error: string }[] },
) {
  if (inQuietHours(household)) {
    const urgent = fresh.some((a) => a.urgent) && household && (await runningCampaign(admin, household))
      ? fresh.filter((a) => a.urgent)
      : [];
    const later = fresh.filter((a) => !urgent.includes(a));
    if (later.length) await admin.from("alert_events").update({ push_deferred: true }).in("id", later.map((a) => a.id));
    if (urgent.length) {
      const res = await sendAlertPushes(admin, householdId, urgent);
      if (res.sent > 0) await admin.from("alert_events").update({ push_sent: true }).in("id", urgent.map((a) => a.id));
      if (res.errors.length) ctx.errors.push(...res.errors.map((e) => ({ url: "push", error: e })));
    }
    return;
  }
  const { data: deferredRows } = await admin.from("alert_events")
    .select("id, wish_item_id, seller, message, wish_items(name)")
    .eq("household_id", householdId).eq("push_deferred", true).eq("push_sent", false)
    .gt("ts", new Date(Date.now() - DAY).toISOString());
  const deferred: PendingPush[] = ((deferredRows ?? []) as unknown as {
    id: number; wish_item_id: string; seller: string; message: string; wish_items: { name: string } | null;
  }[]).map((r) => ({ id: r.id, itemId: r.wish_item_id, itemName: r.wish_items?.name ?? "", seller: r.seller, message: r.message }));
  const all = [...deferred, ...fresh.filter((a) => !deferred.some((d) => d.id === a.id))];
  if (all.length === 0) return;

  const res = deferred.length
    ? await pushToHousehold(admin, householdId, {
      title: `Yön aikana ${all.length} ${all.length === 1 ? "hälytys" : "hälytystä"}`,
      body: [...new Set(all.map((a) => a.itemName))].slice(0, 5).join(", "),
      url: "/#/alerts",
      tag: "alerts-morning",
    })
    : await sendAlertPushes(admin, householdId, all);
  const ids = all.map((a) => a.id);
  await admin.from("alert_events").update({ push_deferred: false, ...(res.sent > 0 ? { push_sent: true } : {}) }).in("id", ids);
  if (res.errors.length) ctx.errors.push(...res.errors.map((e) => ({ url: "push", error: e })));
}

/** Cron tick with nothing to fetch: send waiting quiet-hours summaries. Returns households served. */
async function deliverDeferredOnly(admin: SupabaseClient): Promise<number> {
  const { data } = await admin.from("alert_events").select("household_id").eq("push_deferred", true).eq("push_sent", false);
  const ids = [...new Set((data ?? []).map((r) => r.household_id as string))];
  if (!ids.length) return 0;
  const { data: hs } = await admin.from("households").select(HOUSEHOLD_COLS).in("id", ids);
  let served = 0;
  for (const h of (hs ?? []) as HouseholdRow[]) {
    if (inQuietHours(h)) continue;
    await deliverPushes(admin, h, h.id, [], { errors: [] });
    served++;
  }
  return served;
}

async function sendAlertPushes(admin: SupabaseClient, householdId: string, alerts: PendingPush[]) {
  if (alerts.length <= 3) {
    const total = { sent: 0, failed: 0, errors: [] as string[] };
    for (const a of alerts) {
      const r = await pushToHousehold(admin, householdId, {
        title: a.itemName,
        body: `${a.seller}: ${a.message}`,
        url: `/#/item/${a.itemId}`,
        tag: `item-${a.itemId.slice(0, 24)}`,
      });
      total.sent += r.sent;
      total.failed += r.failed;
      total.errors.push(...r.errors);
    }
    return total;
  }
  const names = [...new Set(alerts.map((a) => a.itemName))];
  return pushToHousehold(admin, householdId, {
    title: `${alerts.length} hintahälytystä`,
    body: names.slice(0, 5).join(", ") + (names.length > 5 ? " …" : ""),
    url: "/#/alerts",
    tag: "alerts-summary",
  });
}
