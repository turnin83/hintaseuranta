// Real shop pages as parser tests (tests/shops.test.ts), and a live check that the shops still parse.
//
//   node scripts/shop-fixtures.ts check            fetch every page in tests/fixtures/shops.json now and
//                                                  compare with the saved result (run before / during a
//                                                  campaign: a changed page layout shows up here first)
//   node scripts/shop-fixtures.ts capture [domain] save the pages again as fixtures and record what the
//                                                  parser reads from them (review the table, then commit)
//
// Fetches politely (robots.txt, honest User-Agent, one page per shop, 1.5 s apart).
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRobotsCache, fetchPage } from "../supabase/functions/_shared/fetcher.ts";
import { extractPage } from "../supabase/functions/_shared/extract.ts";
import type { PageData } from "../supabase/functions/_shared/types.ts";
import { showsPriceWithVat } from "./vat-check.ts";

type Expect = { kind: PageData["kind"]; source: string; offers: number; seller: string | null; priceCents: number };
type Entry = { domain: string; url: string; fixture: string; captured?: string; expect?: Expect };

const MANIFEST = new URL("../tests/fixtures/shops.json", import.meta.url);
const entries: Entry[] = JSON.parse(readFileSync(MANIFEST, "utf8"));
const [mode = "check", only] = process.argv.slice(2);
const robots = createRobotsCache();

const summarize = (p: PageData | null): Expect | null =>
  p && p.offers.length
    ? { kind: p.kind, source: p.source, offers: p.offers.length, seller: p.offers[0].seller, priceCents: p.offers[0].priceCents! }
    : null;
const eur = (c: number) => (c / 100).toFixed(2) + " €";

let problems = 0;
for (const e of entries) {
  if (only && e.domain !== only) continue;
  const f = await fetchPage(e.url, robots);
  const got = f.error || f.blocked ? null : summarize(extractPage(f.html, e.url));
  let note: string;
  if (!got) {
    problems++;
    note = `FAIL ${f.error ?? (f.blocked ? `bot protection ${f.botMarkers.join(", ")}` : "no price found")}`;
  } else if (mode === "capture") {
    writeFileSync(new URL(`../tests/fixtures/${e.fixture}`, import.meta.url), gzipSync(f.html));
    e.captured = new Date().toISOString().slice(0, 10);
    e.expect = got;
    note = `saved  ${got.kind} ${got.source} · ${got.offers} offer(s) · ${got.seller ?? "shop"} ${eur(got.priceCents)}`;
  } else {
    const was = e.expect;
    const changed = was && (was.kind !== got.kind || was.source !== got.source);
    if (changed) problems++;
    const pct = was ? Math.round((got.priceCents / was.priceCents - 1) * 100) : 0;
    note = `${changed ? "CHANGED" : "ok     "} ${got.source} · ${got.seller ?? "shop"} ${eur(got.priceCents)}` +
      (was ? ` (saved ${eur(was.priceCents)}${pct ? `, ${pct > 0 ? "+" : ""}${pct} %` : ""})` : "") +
      (Math.abs(pct) >= 30 ? "  <- check the page by hand" : "");
  }
  if (got?.kind === "shop" && showsPriceWithVat(f.html, got.priceCents)) {
    problems++;
    note += "  <- the page also shows this price + 25.5 %: is it without VAT?";
  }
  console.log(`${e.domain.padEnd(24)} ${note}`);
  await new Promise((r) => setTimeout(r, 1500));
}
if (mode === "capture") writeFileSync(MANIFEST, JSON.stringify(entries, null, 2) + "\n");
console.log(problems ? `\n${problems} shop(s) need a look` : "\nall shops parse as before");
process.exitCode = problems ? 1 : 0;
