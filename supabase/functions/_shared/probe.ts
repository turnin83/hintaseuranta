// Diagnostic probe for one URL: robots, status, bot markers, JSON-LD and extracted offers.
import { normalizeUrl, domainOf } from "./url.ts";
import { createRobotsCache, fetchPage, type RobotsCache } from "./fetcher.ts";
import { parseJsonLdPage } from "./jsonld.ts";
import { extractPage } from "./extract.ts";
import type { PageData } from "./types.ts";

export type ProbeResult = {
  url: string;
  domain: string;
  status: number | null;
  elapsedMs: number;
  robotsAllowed: boolean | null;
  jsonLd: { blocks: number; productFound: boolean; parseErrors: number };
  page: PageData | null;
  botMarkers: string[];
  blocked: boolean;
  error: string | null;
};

export async function probe(rawUrl: string, robots: RobotsCache = createRobotsCache()): Promise<ProbeResult> {
  const url = normalizeUrl(rawUrl);
  const f = await fetchPage(url, robots);
  const ld = f.html ? parseJsonLdPage(f.html) : { page: null, blocks: 0, errors: 0 };
  return {
    url,
    domain: domainOf(url),
    status: f.status,
    elapsedMs: f.elapsedMs,
    robotsAllowed: f.robotsAllowed,
    jsonLd: { blocks: ld.blocks, productFound: ld.page != null, parseErrors: ld.errors },
    page: f.html && !f.blocked ? extractPage(f.html, url) : null,
    botMarkers: f.botMarkers,
    blocked: f.blocked,
    error: f.error,
  };
}
