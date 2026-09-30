// preview-product: POST {url} (signed-in user) -> name, price(s), EAN and shop diagnostics for the add view.
// Also registers the shop domain for the household (or refreshes its probe data).
import { adminClient, CORS, json, userFromRequest } from "../_shared/http.ts";
import { createRobotsCache, fetchPage } from "../_shared/fetcher.ts";
import { extractPage } from "../_shared/extract.ts";
import { domainOf, findUrl, normalizeUrl } from "../_shared/url.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const admin = adminClient();
  const user = await userFromRequest(req, admin);
  if (!user) return json({ error: "unauthorized" }, 401);

  const { data: member } = await admin.from("household_members").select("household_id").eq("user_id", user.id).maybeSingle();
  if (!member) return json({ error: "Käyttäjä ei kuulu kotitalouteen" }, 403);
  const householdId = member.household_id as string;

  const body = await req.json().catch(() => ({})) as { url?: string };
  let url: string;
  try {
    url = normalizeUrl(findUrl(body.url) ?? body.url ?? "");
  } catch {
    return json({ error: "Virheellinen URL" }, 400);
  }
  const domain = domainOf(url);

  const f = await fetchPage(url, createRobotsCache(), 15_000);
  const page = f.html && !f.blocked ? extractPage(f.html, url) : null;

  let suggestion: string | null = null;
  if (f.robotsAllowed === false) suggestion = "Kaupan robots.txt kieltää tämän sivun haun.";
  else if (f.blocked) {
    suggestion = "Kauppa estää automaattiset haut. Lisää sama tuote hintaopas.fi- tai hinta.fi-linkillä ja valitse kauppa listasta.";
  } else if (!page || page.offers.length === 0) {
    suggestion = "Sivulta ei löytynyt hintaa (ei schema.org Product -tietoa). Kokeile vertailusivun linkkiä.";
  }

  const probe = {
    at: new Date().toISOString(),
    status: f.status,
    blocked: f.blocked,
    botMarkers: f.botMarkers,
    robotsAllowed: f.robotsAllowed,
    source: page?.source ?? null,
    error: f.error,
  };
  const strategy = f.blocked ? "blocked" : page?.kind === "aggregator" ? "aggregator" : "direct";

  const { data: existing } = await admin.from("shops").select("*").eq("household_id", householdId).eq("domain", domain).maybeSingle();
  let shop = existing;
  if (existing) {
    const { data } = await admin.from("shops").update({ last_probe: probe }).eq("id", existing.id).select("*").single();
    shop = data ?? existing;
  } else {
    const { data } = await admin.from("shops")
      .insert({ household_id: householdId, user_id: user.id, domain, name: domain, strategy, last_probe: probe })
      .select("*").single();
    shop = data;
  }

  return json({
    url,
    domain,
    shop,
    status: f.status,
    blocked: f.blocked,
    botMarkers: f.botMarkers,
    robotsAllowed: f.robotsAllowed,
    error: f.error,
    page,
    suggestion,
  });
});
