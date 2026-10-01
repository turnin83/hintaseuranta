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
// Alerts: series rules (drop, back in stock, suspicious discount) per fetched shop/seller; item rules
// (below target, all-time low, below 30 d median) once per fetched item on its best current price.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS, isCronRequest, json, userFromRequest } from "../_shared/http.ts";
import { createRobotsCache, fetchPage, sleep, type RobotsCache } from "../_shared/fetcher.ts";
import { extractPage, sellerKey } from "../_shared/extract.ts";
import {
  type AlertCandidate,
  dailyMinMedian,
  describeAlert,
  evaluateItemRules,
  evaluateSeriesRules,
  mergeRules,
  type Obs,
  passesCooldown,
  type Rules,
} from "../_shared/rules.ts";
import type { Availability } from "../_shared/types.ts";
import { pushToHousehold } from "../_shared/push.ts";

const TIME_BUDGET_MS = 110_000; // wall clock limit on the free plan is 150 s
const MAX_LINKS = 150;
const DOMAIN_CONCURRENCY = 4;
const HISTORY_LIMIT = 1000;
const FRESH_MS = 3 * 86_400_000; // an offer older than this is not a "current" price

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
};
type ShopRow = { id: number; domain: string; name: string | null; strategy: string; min_delay_ms: number };
type ItemRow = { id: string; household_id: string; name: string; target_price_cents: number | null; rules: unknown };
type SeriesRow = {
  product_link_id: string;
  seller: string;
  seller_name: string;
  price_cents: number;
  ts: string;
  availability: Availability;
};

type PendingAlert = { id: number; itemId: string; itemName: string; seller: string; message: string };
type Ctx = { ok: number; fail: number; alerts: PendingAlert[]; errors: { url: string; error: string }[] };
type ObsRow = { ts: string; price_cents: number; availability: string; lowest_30d_cents: number | null };

const toObs = (r: ObsRow): Obs => ({
  ts: Date.parse(r.ts),
  priceCents: r.price_cents,
  availability: r.availability as Availability,
  lowest30dCents: r.lowest_30d_cents,
});

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

  if (links.length === 0) return json({ trigger, links: 0 });

  const [shops, items, households] = await Promise.all([
    admin.from("shops").select("id, domain, name, strategy, min_delay_ms").in("id", [...new Set(links.map((l) => l.shop_id))]),
    admin.from("wish_items").select("id, household_id, name, target_price_cents, rules").in("id", [...new Set(links.map((l) => l.wish_item_id))]),
    admin.from("households").select("id, default_rules").in("id", [...new Set(links.map((l) => l.household_id))]),
  ]);
  const shopById = new Map((shops.data as ShopRow[] ?? []).map((s) => [s.id, s]));
  const itemById = new Map((items.data as ItemRow[] ?? []).map((i) => [i.id, i]));
  const householdRules = new Map((households.data ?? []).map((h) => [h.id as string, h.default_rules as unknown]));
  const rulesFor = (item: ItemRow): Rules => mergeRules(householdRules.get(item.household_id), item.rules);

  // Results are collected per household (shared data, shared pushes, one run log each).
  const ctxByHousehold = new Map<string, Ctx>();
  const ctxFor = (hid: string) => {
    if (!ctxByHousehold.has(hid)) ctxByHousehold.set(hid, { ok: 0, fail: 0, alerts: [], errors: [] });
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
        if (await processLink(admin, robots, link, shop, item, rulesFor(item), ctx)) touchedItems.add(item.id);
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

  // Item-level rules, once per item that got new prices in this run.
  for (const itemId of touchedItems) {
    const item = itemById.get(itemId)!;
    const ctx = ctxFor(item.household_id);
    try {
      await evaluateItem(admin, item, rulesFor(item), started, ctx);
    } catch (e) {
      ctx.errors.push({ url: `item ${item.name}`, error: String(e) });
    }
  }

  // Push + run log per household.
  for (const [householdId, ctx] of ctxByHousehold) {
    if (ctx.alerts.length) {
      try {
        const res = await sendAlertPushes(admin, householdId, ctx.alerts);
        if (res.sent > 0) {
          await admin.from("alert_events").update({ push_sent: true }).in("id", ctx.alerts.map((a) => a.id));
        }
        if (res.errors.length) ctx.errors.push(...res.errors.map((e) => ({ url: "push", error: e })));
      } catch (e) {
        ctx.errors.push({ url: "push", error: String(e) });
      }
    }
    await admin.from("fetch_runs").insert({
      household_id: householdId,
      user_id: triggeredBy,
      trigger,
      started_at: started.toISOString(),
      ok_count: ctx.ok,
      fail_count: ctx.fail,
      alert_count: ctx.alerts.length,
      errors: ctx.errors.slice(0, 50),
    });
  }

  const totals = [...ctxByHousehold.values()].reduce(
    (a, c) => ({ ok: a.ok + c.ok, fail: a.fail + c.fail, alerts: a.alerts + c.alerts.length }),
    { ok: 0, fail: 0, alerts: 0 },
  );
  return json({ trigger, links: links.length, deferred: released.length, ...totals, ms: Date.now() - started.getTime() });
});

/** Current offers of an item: tracked, fresh, not out of stock. */
async function currentOffers(admin: SupabaseClient, itemId: string): Promise<SeriesRow[]> {
  const { data, error } = await admin.from("v_series")
    .select("product_link_id, seller, seller_name, price_cents, ts, availability")
    .eq("wish_item_id", itemId).eq("tracked", true);
  if (error) throw error;
  const now = Date.now();
  return ((data ?? []) as SeriesRow[]).filter((s) => s.availability !== "out_of_stock" && now - Date.parse(s.ts) < FRESH_MS);
}

/** Inserts an alert unless its cooldown blocks it; queues pushes for alert-level events. */
async function raiseAlert(
  admin: SupabaseClient,
  ctx: Ctx,
  item: ItemRow,
  rules: Rules,
  c: AlertCandidate,
  at: { linkId: string; seller: string; sellerName: string; userId: string | null; itemWide: boolean },
) {
  let prevQ = admin.from("alert_events").select("ts, price_cents").eq("rule", c.rule);
  prevQ = at.itemWide
    ? prevQ.eq("wish_item_id", item.id)
    : prevQ.eq("product_link_id", at.linkId).eq("seller", at.seller);
  const { data: prev } = await prevQ.order("ts", { ascending: false }).limit(1).maybeSingle();
  const prevAlert = prev ? { ts: Date.parse(prev.ts), priceCents: prev.price_cents } : undefined;
  if (!passesCooldown(c, prevAlert, Date.now(), rules.cooldown_hours)) return;

  const message = describeAlert(c);
  const { data: ins, error } = await admin.from("alert_events").insert({
    user_id: at.userId,
    household_id: item.household_id,
    wish_item_id: item.id,
    product_link_id: at.linkId,
    seller: at.seller,
    rule: c.rule,
    level: c.level,
    price_cents: c.priceCents,
    ref_cents: c.refCents,
    message,
  }).select("id").single();
  if (error) throw error;
  if (c.level === "alert") {
    ctx.alerts.push({ id: ins.id, itemId: item.id, itemName: item.name, seller: at.sellerName, message });
  }
}

/** Fetches one link, stores observations and evaluates series rules. Returns true on success. */
async function processLink(
  admin: SupabaseClient,
  robots: RobotsCache,
  link: LinkRow,
  shop: ShopRow,
  item: ItemRow,
  rules: Rules,
  ctx: Ctx,
): Promise<boolean> {
  const now = new Date().toISOString();
  const fail = async (status: "error" | "blocked" | "no_data", error: string) => {
    ctx.fail++;
    ctx.errors.push({ url: link.url, error });
    await admin.from("product_links").update({
      last_fetched_at: now,
      last_status: status,
      last_error: error.slice(0, 500),
      fail_count: link.fail_count + 1,
      claimed_until: null,
    }).eq("id", link.id);
    await admin.from("shops").update({ last_error: `${status}: ${error}`.slice(0, 500) }).eq("id", shop.id);
    return false;
  };

  const f = await fetchPage(link.url, robots);
  if (f.blocked) return fail("blocked", `Bot protection: ${f.botMarkers.join(", ")}`);
  if (f.error) return fail("error", f.error);

  const page = extractPage(f.html, link.url);
  if (!page || page.offers.length === 0) return fail("no_data", "No price found (no Product JSON-LD / adapter data)");

  let offers = page.offers;
  if (page.kind === "aggregator" && link.sellers?.length) {
    const wanted = new Set(link.sellers.map(sellerKey));
    offers = offers.filter((o) => o.seller && wanted.has(sellerKey(o.seller)));
    if (offers.length === 0) return fail("no_data", `Selected sellers not listed: ${link.sellers.join(", ")}`);
  }
  if (page.kind === "shop") offers = offers.slice(0, 1).map((o) => ({ ...o, seller: null }));

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
    source: page.source,
  }));
  const { error: insErr } = await admin.from("price_observations").insert(rows);
  if (insErr) throw insErr;

  // Other shops' current offers (for "only when this shop is the cheapest").
  const offersNow = await currentOffers(admin, item.id);

  for (const row of rows) {
    const { data: hist, error } = await admin
      .from("price_observations")
      .select("ts, price_cents, availability, lowest_30d_cents")
      .eq("product_link_id", link.id)
      .eq("seller", row.seller)
      .lt("ts", now)
      .order("ts", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw error;
    const others = offersNow.filter((s) => !(s.product_link_id === link.id && s.seller === row.seller));
    const othersBestCents = others.length ? Math.min(...others.map((s) => s.price_cents)) : null;
    const candidates = evaluateSeriesRules({ current: toObs(row), history: (hist ?? []).map(toObs), othersBestCents, rules });
    for (const c of candidates) {
      await raiseAlert(admin, ctx, item, rules, c, {
        linkId: link.id,
        seller: row.seller,
        sellerName: row.seller || shop.name || shop.domain,
        userId: link.user_id,
        itemWide: false,
      });
    }
  }

  ctx.ok++;
  await admin.from("product_links").update({
    last_fetched_at: now,
    last_status: "ok",
    last_error: null,
    fail_count: 0,
    claimed_until: null,
    ...(link.ean == null && page.ean ? { ean: page.ean } : {}),
    ...(link.model_name == null && page.name ? { model_name: page.name.slice(0, 200) } : {}),
  }).eq("id", link.id);
  await admin.from("shops").update({ last_ok_at: now, last_error: null }).eq("id", shop.id);
  return true;
}

/** Item rules on the best current price across all shops, compared with history before this run. */
async function evaluateItem(admin: SupabaseClient, item: ItemRow, rules: Rules, started: Date, ctx: Ctx) {
  const offers = await currentOffers(admin, item.id);
  if (offers.length === 0) return;
  const best = offers.reduce((a, b) => (b.price_cents < a.price_cents ? b : a));

  const { data: linkRows } = await admin.from("product_links").select("id").eq("wish_item_id", item.id);
  const linkIds = (linkRows ?? []).map((l) => l.id as string);
  const before = started.toISOString();
  const since30 = new Date(started.getTime() - 30 * 86_400_000).toISOString();

  const [minQ, countQ, recentQ] = await Promise.all([
    admin.from("price_observations").select("price_cents").in("product_link_id", linkIds).lt("ts", before)
      .order("price_cents").limit(1).maybeSingle(),
    admin.from("price_observations").select("id", { count: "exact", head: true }).in("product_link_id", linkIds).lt("ts", before),
    admin.from("price_observations").select("ts, price_cents, availability, lowest_30d_cents").in("product_link_id", linkIds)
      .gte("ts", since30).lt("ts", before).limit(5000),
  ]);
  const med = dailyMinMedian(((recentQ.data ?? []) as ObsRow[]).map(toObs));

  const candidates = evaluateItemRules({
    bestCents: best.price_cents,
    prevMinCents: minQ.data?.price_cents ?? null,
    prevObsCount: countQ.count ?? 0,
    medianCents: med.median,
    medianDays: med.days,
    targetCents: item.target_price_cents,
  }, rules);

  for (const c of candidates) {
    await raiseAlert(admin, ctx, item, rules, c, {
      linkId: best.product_link_id,
      seller: best.seller,
      sellerName: best.seller_name,
      userId: null,
      itemWide: true,
    });
  }
}

async function sendAlertPushes(admin: SupabaseClient, householdId: string, alerts: PendingAlert[]) {
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
