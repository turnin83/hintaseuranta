// Polite page fetcher: honest User-Agent, robots.txt check (cached per run), timeout, bot detection.
import { parseRobots, robotsAllows, type RobotsGroup } from "./robots.ts";
import { detectBotMarkers, isBlocked } from "./botcheck.ts";

export const USER_AGENT =
  "Hintaseuranta/1.0 (+personal price tracker; a few requests per day per product)";

const HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept": "text/html,application/xhtml+xml",
  "Accept-Language": "fi-FI,fi;q=0.9,en;q=0.5",
};

export type FetchOutcome = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  html: string;
  botMarkers: string[];
  blocked: boolean;
  robotsAllowed: boolean | null;
  robotsRule: string | null;
  error: string | null;
  elapsedMs: number;
};

export function createRobotsCache() {
  const cache = new Map<string, Promise<RobotsGroup[] | null>>();
  return async (origin: string): Promise<RobotsGroup[] | null> => {
    if (!cache.has(origin)) {
      cache.set(
        origin,
        fetch(`${origin}/robots.txt`, { headers: HEADERS, signal: AbortSignal.timeout(10_000) })
          .then(async (r) => (r.ok ? parseRobots(await r.text()) : (await r.body?.cancel(), null)))
          .catch(() => null),
      );
    }
    return cache.get(origin)!;
  };
}

export type RobotsCache = ReturnType<typeof createRobotsCache>;

export async function fetchPage(url: string, robots: RobotsCache, timeoutMs = 20_000): Promise<FetchOutcome> {
  const t0 = Date.now();
  const u = new URL(url);
  const out: FetchOutcome = {
    url,
    finalUrl: null,
    status: null,
    html: "",
    botMarkers: [],
    blocked: false,
    robotsAllowed: null,
    robotsRule: null,
    error: null,
    elapsedMs: 0,
  };
  try {
    const groups = await robots(u.origin);
    if (groups) {
      const r = robotsAllows(groups, USER_AGENT, u.pathname + u.search);
      out.robotsAllowed = r.allowed;
      out.robotsRule = r.matchedRule;
      if (!r.allowed) {
        out.error = `robots.txt disallows (${r.matchedRule})`;
        return out;
      }
    }
    const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    out.status = res.status;
    out.finalUrl = res.url;
    out.html = await res.text();
    out.botMarkers = detectBotMarkers(res.status, res.headers, out.html);
    out.blocked = isBlocked(res.status, out.botMarkers);
    if (!res.ok) out.error = `HTTP ${res.status}${out.blocked ? " (bot protection)" : ""}`;
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    out.elapsedMs = Date.now() - t0;
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
