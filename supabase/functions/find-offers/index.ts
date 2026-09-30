// find-offers: find the same product in other shops via hinta.fi.
// POST {wish_item_id, query?, product_url?} (signed-in household member)
//   - without product_url: searches hinta.fi by the item's EAN (or name / query) and, when the match is
//     unambiguous, also loads the product page.
//   - with product_url (a hinta.fi product page picked from the results): loads that page.
// Returns the sellers and prices, each flagged `tracked` when the item already follows that shop.
import { adminClient, CORS, json, userFromRequest } from "../_shared/http.ts";
import { createRobotsCache, fetchPage, sleep } from "../_shared/fetcher.ts";
import { extractPage } from "../_shared/extract.ts";
import { HINTAFI, hintaFiSearchUrl, parseHintaFiSearch, sellerKey, sellerMatchesShop, type SearchHit } from "../_shared/search.ts";

type LinkRow = {
  id: string;
  url: string;
  ean: string | null;
  sellers: string[] | null;
  shops: { domain: string; name: string | null; strategy: string } | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const admin = adminClient();
  const user = await userFromRequest(req, admin);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { data: member } = await admin.from("household_members").select("household_id").eq("user_id", user.id).maybeSingle();
  if (!member) return json({ error: "Käyttäjä ei kuulu kotitalouteen" }, 403);
  const householdId = member.household_id as string;

  const body = await req.json().catch(() => ({})) as { wish_item_id?: string; query?: string; product_url?: string };
  const { data: item } = await admin.from("wish_items").select("id, name")
    .eq("id", body.wish_item_id ?? "").eq("household_id", householdId).maybeSingle();
  if (!item) return json({ error: "Toiveasiaa ei löytynyt" }, 404);

  const { data: linkData } = await admin.from("product_links")
    .select("id, url, ean, sellers, shops(domain, name, strategy)").eq("wish_item_id", item.id);
  const links = (linkData ?? []) as unknown as LinkRow[];
  const { data: seriesData } = await admin.from("v_series").select("seller_name").eq("wish_item_id", item.id);

  // Sellers already followed: direct shops, sellers seen in history, sellers selected on aggregator links.
  const directShops = links.filter((l) => l.shops && l.shops.strategy !== "aggregator").map((l) => l.shops!);
  const knownSellers = new Set([
    ...(seriesData ?? []).map((s) => sellerKey(s.seller_name as string)),
    ...links.flatMap((l) => l.sellers ?? []).map(sellerKey),
  ]);
  const isTracked = (seller: string) =>
    knownSellers.has(sellerKey(seller)) || directShops.some((s) => sellerMatchesShop(seller, s));

  const ean = links.map((l) => l.ean).find((e): e is string => Boolean(e)) ?? null;
  const query = (body.query ?? ean ?? item.name).trim();
  const byEan = !body.query && Boolean(ean);
  const robots = createRobotsCache();

  let results: SearchHit[] = [];
  let target: string | null = null;
  if (body.product_url) {
    if (!body.product_url.startsWith(HINTAFI + "/")) return json({ error: "Vain hinta.fi-tuotesivut" }, 400);
    target = body.product_url;
  } else {
    const s = await fetchPage(hintaFiSearchUrl(query), robots, 15_000);
    if (s.error) return json({ error: `hinta.fi-haku epäonnistui: ${s.error}` }, 502);
    results = parseHintaFiSearch(s.html).slice(0, 12);
    // An EAN search is exact enough to take the first hit; a name search needs the user's pick.
    if (results.length === 1 || (byEan && results.length > 0)) target = results[0].url;
  }

  let product = null;
  if (target) {
    if (results.length) await sleep(1000);
    const p = await fetchPage(target, robots, 15_000);
    if (p.error) return json({ error: `hinta.fi-tuotesivu epäonnistui: ${p.error}` }, 502);
    const page = extractPage(p.html, target);
    product = {
      url: target,
      name: page?.name ?? null,
      ean: page?.ean ?? null,
      offers: (page?.offers ?? [])
        .filter((o) => o.seller)
        .map((o) => ({ seller: o.seller!, priceCents: o.priceCents, availability: o.availability, tracked: isTracked(o.seller!) }))
        .sort((a, b) => (a.priceCents ?? 0) - (b.priceCents ?? 0)),
    };
  }

  // hinta.fi as a shop of this household (aggregator), created on first use.
  let { data: shop } = await admin.from("shops").select("id").eq("household_id", householdId).eq("domain", "hinta.fi").maybeSingle();
  if (!shop) {
    ({ data: shop } = await admin.from("shops")
      .insert({ household_id: householdId, user_id: user.id, domain: "hinta.fi", name: "hinta.fi", strategy: "aggregator" })
      .select("id").single());
  }

  return json({
    query,
    byEan,
    results,
    product,
    shopId: shop?.id ?? null,
    existingLink: product ? links.find((l) => l.url === product.url) ?? null : null,
  });
});
