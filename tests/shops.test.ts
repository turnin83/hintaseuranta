// Real pages of every shop in use (tests/fixtures/shops.json): the parser must keep reading them the same
// way. Refresh with `node scripts/shop-fixtures.ts capture`; check live shops with `... check`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { extractPage } from "../supabase/functions/_shared/extract.ts";
import { showsPriceWithVat } from "../scripts/vat-check.ts";

type Entry = {
  domain: string;
  url: string;
  fixture: string;
  expect: { kind: string; source: string; offers: number; seller: string | null; priceCents: number };
};
const entries: Entry[] = JSON.parse(readFileSync(new URL("./fixtures/shops.json", import.meta.url), "utf8"));

for (const e of entries) {
  test(`shop page: ${e.domain}`, () => {
    const html = gunzipSync(readFileSync(new URL(`./fixtures/${e.fixture}`, import.meta.url))).toString("utf8");
    const p = extractPage(html, e.url);
    assert.ok(p, "no product data");
    assert.equal(p.kind, e.expect.kind);
    assert.equal(p.source, e.expect.source);
    assert.equal(p.offers.length, e.expect.offers);
    assert.equal(p.offers[0].seller, e.expect.seller);
    assert.equal(p.offers[0].priceCents, e.expect.priceCents);
    assert.equal(p.offers[0].currency ?? "EUR", "EUR");
    if (e.expect.kind === "shop") assert.ok(!showsPriceWithVat(html, e.expect.priceCents), "price looks like one without VAT");
  });
}
