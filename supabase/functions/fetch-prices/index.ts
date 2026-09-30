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
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { adminClient, CORS, isCronRequest, json, userFromRequest } from "../_shared/http.ts";
import { createRobotsCache, fetchPage, sleep, type RobotsCache } from "../_shared/fetcher.ts";
import { extractPage, sellerKey } from "../_shared/extract.ts";
import { describeAlert, evaluateRules, mergeRules, passesCooldown, type Obs } from "../_shared/rules.ts";
import type { Availability } from "../_shared/types.ts";
import { pushToHousehold } from "../_shared/push.ts";

const TIME_BUDGET_MS = 110_000; // wall clock limit on the free plan is 150 s
const MAX_LINKS = 150;
const DOMAIN_CONCURRENCY = 4;
const HISTORY_LIMIT = 1000;

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
type ItemRow = { id: string; name: string; target_price_cents: number | null; rules: unknown };

type PendingAlert = { id: number; itemId: string; itemName: string; seller: string; message: string };
type UserCtx = { ok: number; fail: number; alerts: PendingAlert[]; errors: { url: string; error: string }[] };

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

  const [shops, items] = await Promise.all([
    admin.from("shops").select("id, domain, name, strategy, min_delay_ms").in("id", [...new Set(links.map((l) => l.shop_id))]),
    admin.from("wish_items").select("id, name, target_price_cents, rules").in("id", [...new Set(links.map((l) => l.wish_item_id))]),
  ]);
  const shopById = new Map((shops.data as ShopRow[] ?? []).map((s) => [s.id, s]));
  const itemById = new Map((items.data as ItemRow[] ?? []).map((i) => [i.id, i]));

  // Results are collected per household (shared data, shared pushes, one run log each).
  const ctxByHousehold = new Map<string, UserCtx>();
  const ctxFor = (hid: string) => {
    if (!ctxByHousehold.has(hid)) ctxByHousehold.set(hid, { ok: 0, fail: 0, alerts: [], errors: [] });
    return ctxByHousehold.get(hid)!;
  };

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
      try {
        await processLink(admin, robots, link, shop, item, ctxFor(link.household_id));
      } catch (e) {
        const ctx = ctxFor(link.household_id);
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

async function processLink(
  admin: SupabaseClient,
  robots: RobotsCache,
  link: LinkRow,
  shop: ShopRow,
  item: ItemRow,
  ctx: UserCtx,
) {
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

  const rules = mergeRules(item.rules);
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
    const toObs = (r: { ts: string; price_cents: number; availability: string; lowest_30d_cents: number | null }): Obs => ({
      ts: Date.parse(r.ts),
      priceCents: r.price_cents,
      availability: r.availability as Availability,
      lowest30dCents: r.lowest_30d_cents,
    });
    const candidates = evaluateRules({
      current: toObs(row),
      history: (hist ?? []).map(toObs),
      targetCents: item.target_price_cents,
      rules,
    });
    for (const c of candidates) {
      const { data: prev } = await admin
        .from("alert_events")
        .select("ts, price_cents")
        .eq("product_link_id", link.id)
        .eq("seller", row.seller)
        .eq("rule", c.rule)
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle();
      const prevAlert = prev ? { ts: Date.parse(prev.ts), priceCents: prev.price_cents } : undefined;
      if (!passesCooldown(c, prevAlert, Date.parse(now), rules.cooldown_hours)) continue;
      const message = describeAlert(c);
      const { data: ins, error: aErr } = await admin.from("alert_events").insert({
        user_id: link.user_id,
        household_id: link.household_id,
        wish_item_id: item.id,
        product_link_id: link.id,
        seller: row.seller,
        rule: c.rule,
        level: c.level,
        price_cents: c.priceCents,
        ref_cents: c.refCents,
        message,
      }).select("id").single();
      if (aErr) throw aErr;
      if (c.level === "alert") {
        ctx.alerts.push({ id: ins.id, itemId: item.id, itemName: item.name, seller: row.seller || shop.name || shop.domain, message });
      }
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
