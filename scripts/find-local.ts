// Try the "find in other shops" lookup locally: node scripts/find-local.ts <EAN or search words> [...]
import { createRobotsCache, fetchPage, sleep } from "../supabase/functions/_shared/fetcher.ts";
import { extractPage } from "../supabase/functions/_shared/extract.ts";
import { eur } from "../supabase/functions/_shared/rules.ts";
import { hintaFiSearchUrl, parseHintaFiSearch } from "../supabase/functions/_shared/search.ts";

const robots = createRobotsCache();
for (const q of process.argv.slice(2)) {
  const s = await fetchPage(hintaFiSearchUrl(q), robots);
  const hits = parseHintaFiSearch(s.html);
  console.log(`\n${q}: ${hits.length} osumaa${s.error ? ` (${s.error})` : ""}`);
  if (hits[0]) {
    await sleep(1000);
    const p = await fetchPage(hits[0].url, robots);
    const page = p.html ? extractPage(p.html, hits[0].url) : null;
    console.log(`  ${hits[0].name} (EAN ${page?.ean ?? "?"})`);
    for (const o of page?.offers ?? []) console.log(`  - ${o.seller}: ${o.priceCents != null ? eur(o.priceCents) : "-"} ${o.availability}`);
  }
  await sleep(1000);
}
