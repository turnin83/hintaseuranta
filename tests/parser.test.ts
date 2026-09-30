import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extractPage } from "../supabase/functions/_shared/extract.ts";
import { decodeEntities, parseJsonLdPage, parsePrice, normalizeAvailability } from "../supabase/functions/_shared/jsonld.ts";
import { detectBotMarkers, isBlocked } from "../supabase/functions/_shared/botcheck.ts";
import { normalizeUrl, domainOf, findUrl } from "../supabase/functions/_shared/url.ts";
import { parseRobots, robotsAllows } from "../supabase/functions/_shared/robots.ts";
import { parseHintaFiSearch, sellerMatchesShop } from "../supabase/functions/_shared/search.ts";

const fixture = (name: string) =>
  gunzipSync(readFileSync(new URL(`./fixtures/${name}.html.gz`, import.meta.url))).toString("utf8");

test("verkkokauppa: JSON-LD product + adapter", () => {
  const p = extractPage(
    fixture("verkkokauppa-tcl65c8k"),
    "https://www.verkkokauppa.com/fi/product/991474/TCL-65-C8K-4K-QD-Mini-LED-Google-TV",
  )!;
  assert.equal(p.kind, "shop");
  assert.equal(p.source, "adapter:verkkokauppa");
  assert.equal(p.ean, "5901292525682");
  assert.equal(p.sku, "991474");
  assert.equal(p.offers.length, 1);
  assert.deepEqual(p.offers[0], {
    seller: null,
    priceCents: 229900,
    currency: "EUR",
    availability: "in_stock",
    lowest30dCents: null, // not in campaign
  });
});

test("power: JSON-LD product", () => {
  const p = extractPage(
    fixture("power-tcl65c8k"),
    "https://www.power.fi/tv-ja-audio/televisiot/tcl-65-4k-google-tv-65c8k/p-4249569/",
  )!;
  assert.equal(p.source, "jsonld");
  assert.equal(p.ean, "5901292525682");
  assert.match(p.name!, /TCL 65/);
  assert.equal(p.offers[0].priceCents, 129900);
  assert.equal(p.offers[0].currency, "EUR");
});

test("veikonkone: JSON-LD with full schema.org @type URLs", () => {
  const p = extractPage(fixture("veikonkone-tcl75c8l"), "https://www.veikonkone.fi/5901292529895-tcl-75c8l-75-4k-sqd-mini-led")!;
  assert.equal(p.ean, "5901292529895");
  assert.equal(p.offers[0].priceCents, 349900);
  assert.equal(p.offers[0].availability, "in_stock");
});

test("hintaopas: per-shop offers from flight data", () => {
  const p = extractPage(fixture("hintaopas-tcl65c8k"), "https://hintaopas.fi/product.php?p=14547508")!;
  assert.equal(p.kind, "aggregator");
  assert.equal(p.source, "adapter:hintaopas");
  const bySeller = Object.fromEntries(p.offers.map((o) => [o.seller, o]));
  assert.equal(bySeller["Gigantti"].priceCents, 249900);
  assert.equal(bySeller["Gigantti"].availability, "in_stock");
  assert.equal(bySeller["Power"].priceCents, 129900);
  assert.equal(bySeller["Power"].availability, "out_of_stock");
  assert.equal(bySeller["Verkkokauppa.com"].priceCents, 229900);
  assert.equal(p.offers.length, 6);
});

test("hinta.fi: per-seller offers straight from JSON-LD", () => {
  const p = extractPage(fixture("hintafi-rtx5090"), "https://hinta.fi/5133428/asus-rog-astral-rtx5090-o32g-gaming")!;
  assert.equal(p.kind, "aggregator");
  assert.equal(p.source, "jsonld");
  const g = p.offers.find((o) => o.seller === "Gigantti");
  assert.ok(g);
  assert.equal(g.priceCents, 559990);
  assert.ok(p.offers.some((o) => o.seller === "Jimm's PC-store"), "HTML entities decoded");
  assert.ok(p.offers.length >= 3);
});

test("gigantti: Vercel challenge detected, no product", () => {
  const html = fixture("gigantti-vercel-challenge");
  const markers = detectBotMarkers(429, new Headers({ "x-vercel-mitigated": "challenge" }), html);
  assert.ok(markers.includes("Vercel Security Checkpoint"));
  assert.ok(isBlocked(429, markers));
  assert.equal(parseJsonLdPage(html).page, null);
});

test("cloudflare presence alone is not a block", () => {
  assert.equal(isBlocked(200, detectBotMarkers(200, new Headers({ server: "cloudflare" }), "<html></html>")), false);
});

test("generic JSON-LD: @graph, string price, ProductGroup", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"WebPage"},
    {"@type":"Product","name":"X","gtin13":"6417128100064",
     "offers":{"@type":"Offer","price":"1 299,90","priceCurrency":"EUR","availability":"https://schema.org/OutOfStock"}}]}</script>`;
  const p = extractPage(html, "https://example.fi/p/1")!;
  assert.equal(p.name, "X");
  assert.equal(p.offers[0].priceCents, 129990);
  assert.equal(p.offers[0].availability, "out_of_stock");

  const group = `<script type="application/ld+json">{"@type":"ProductGroup","name":"G",
    "hasVariant":[{"@type":"Product","sku":"v1","offers":{"@type":"Offer","price":49.5,"priceCurrency":"EUR"}}]}</script>`;
  const g = extractPage(group, "https://example.fi/g")!;
  assert.equal(g.sku, "v1");
  assert.equal(g.offers[0].priceCents, 4950);
});

test("parsePrice formats", () => {
  assert.equal(parsePrice("1.299,90"), 1299.9);
  assert.equal(parsePrice("1,299.90"), 1299.9);
  assert.equal(parsePrice("1299,90 €"), 1299.9);
  assert.equal(parsePrice("2 499"), 2499);
  assert.equal(parsePrice(11.99), 11.99);
  assert.equal(parsePrice(""), null);
  assert.equal(normalizeAvailability("http://schema.org/InStock"), "in_stock");
  assert.equal(normalizeAvailability("PreOrder"), "preorder");
  assert.equal(decodeEntities("Jimm&apos;s &amp; Co &#228;&#xE4; &unknown;"), "Jimm's & Co ää &unknown;");
});

test("url normalization strips tracking", () => {
  assert.equal(
    normalizeUrl("https://www.Power.fi/x/p-1/?gclsrc=aw.ds&gad_source=1&gclid=abc&keep=1#prices"),
    "https://www.power.fi/x/p-1/?keep=1",
  );
  assert.equal(normalizeUrl("https://hintaopas.fi/product.php?p=1&utm_campaign=x"), "https://hintaopas.fi/product.php?p=1");
  assert.equal(domainOf("https://www.verkkokauppa.com/fi/product/1"), "verkkokauppa.com");
  assert.equal(findUrl("Katso tämä TCL https://www.power.fi/a/p-1/ hyvä"), "https://www.power.fi/a/p-1/");
});

test("robots: longest match, wildcards", () => {
  const g = parseRobots(`User-agent: Googlebot\nDisallow: /fi/product/*\n\nUser-agent: *\nDisallow: /search/\nDisallow: /fi/s$\nAllow: /search/ok\n`);
  const ua = "Hintaseuranta/1.0";
  assert.equal(robotsAllows(g, ua, "/fi/product/1/x").allowed, true);
  assert.equal(robotsAllows(g, ua, "/search/tv").allowed, false);
  assert.equal(robotsAllows(g, ua, "/search/ok").allowed, true);
  assert.equal(robotsAllows(g, ua, "/fi/s").allowed, false);
  assert.equal(robotsAllows(g, ua, "/fi/sx").allowed, true);
});

test("hinta.fi search: EAN gives one hit", () => {
  const hits = parseHintaFiSearch(fixture("hintafi-search-ean"));
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    id: "5238122",
    url: "https://hinta.fi/5238122/tcl-c8k-65c8k",
    name: "TCL C8K 65C8K",
    group: "Televisiot",
    priceCents: 116312,
    totalCents: 128962,
    storeCount: 5,
    inStock: true,
  });
});

test("hinta.fi search: keyword page with many hits", () => {
  const hits = parseHintaFiSearch(fixture("hintafi-search-many"));
  assert.equal(hits.length, 20);
  assert.ok(hits.every((h) => h.url.startsWith("https://hinta.fi/") && h.name && h.priceCents));
});

test("seller matches tracked shop", () => {
  const shop = (domain: string, name: string | null = null) => ({ domain, name });
  assert.ok(sellerMatchesShop("Power", shop("power.fi")));
  assert.ok(sellerMatchesShop("Verkkokauppa.com", shop("verkkokauppa.com")));
  assert.ok(sellerMatchesShop("Gigantti", shop("gigantti.fi", "Gigantti")));
  assert.ok(sellerMatchesShop("Jimm's PC-store", shop("jimms.fi")));
  assert.ok(!sellerMatchesShop("Proshop", shop("power.fi")));
  assert.ok(!sellerMatchesShop("CDON", shop("hintaopas.fi", "Hintaopas")));
});
