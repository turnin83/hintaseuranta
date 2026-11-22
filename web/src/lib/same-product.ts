// Same product or not? Finds (1) items that track one product twice and (2) links that point to another
// product than the rest of their item: another screen size, capacity, volume, pack size, colour or EAN.
// A wrong link is worse than a missing one: its prices count in the item's lowest and usual price, and
// in its alerts (e.g. a 65" TV in a 75" item gave "Uusi alin hinta").
// Pure functions: used by the Links view, the item page and the add view, and imported by the Node tests.
// Relative path (not @shared) so the Node unit tests can import this module too.
import { sellerKey } from "../../../supabase/functions/_shared/search.ts";

export type LinkLike = { id: string; url: string; ean: string | null; model_name: string | null };
export type ItemLike = { id: string; name: string; created_at: string };

/** A real GTIN (EAN-8, UPC-12, EAN-13, GTIN-14 with a valid check digit) as 14 digits, else null. */
export function gtin(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(d.length) || /^0+$/.test(d)) return null;
  const p = d.padStart(14, "0");
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(p[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(p[13]) ? p : null;
}

/** The code as shops print it (EAN-13 when it fits). */
export const showGtin = (g: string) => g.replace(/^0(?=\d{13}$)/, "");

const TRACKING = /^(utm_|gclid$|fbclid$|srsltid$|at_gd$|campaign_id$|adgroup_id$|ad_|listname$|shopping_)/i;

/** One key per product page: host without www, path without trailing slash, query without tracking. */
export function productUrlKey(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const q = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${q}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

// ---------- What a product title tells ----------

type Kind = "inch" | "storage" | "volume" | "pack" | "colour";
type Features = Record<Kind, Set<string>>;

const num = (s: string) => Number(s.replace(",", "."));

const COLOURS: [RegExp, string][] = [
  // Finnish stems (compounds such as "tummanharmaa" count), English as whole words ("Bluetooth" is not blue).
  [/(?<![a-zåäö])(?:tumman|vaalean)?(?:valkoi|valkea)|\bwhite\b|\bporcelain\b/i, "valkoinen"],
  [/(?<![a-zåäö])(?:tumman|matta)?musta|\bblack\b/i, "musta"],
  [/(?<![a-zåäö])(?:tumman|vaalean)?harmaa|\bgr[ae]y\b|\bgraphite\b|(?<![a-zåäö])grafiitti/i, "harmaa"],
  [/(?<![a-zåäö])hopea|\bsilver\b/i, "hopea"],
  [/(?<![a-zåäö])(?:tumman|vaalean)?sinin|\bblue\b|\bnavy\b/i, "sininen"],
  [/(?<![a-zåäö])punai|\bred\b/i, "punainen"],
  [/(?<![a-zåäö])vihre|\bgreen\b/i, "vihreä"],
  [/(?<![a-zåäö])keltai|\byellow\b/i, "keltainen"],
  [/(?<![a-zåäö])(?:pinkki|vaaleanpunai)|\bpink\b|\brose\b/i, "pinkki"],
  [/(?<![a-zåäö])violetti|\bpurple\b/i, "violetti"],
  [/(?<![a-zåäö])ruskea|\bbrown\b/i, "ruskea"],
  [/(?<![a-zåäö])beige/i, "beige"],
];

export function features(title: string | null | undefined): Features {
  const t = (title ?? "").replace(/[”″“]/g, '"').replace(/''/g, '"');
  const f: Features = { inch: new Set(), storage: new Set(), volume: new Set(), pack: new Set(), colour: new Set() };
  for (const m of t.matchAll(/(?<![\d.,])(\d{2,3})(?:[.,]\d)?\s*(?:"|-?tuu?m|inch\b|in\b)/gi)) {
    const n = Number(m[1]);
    if (n >= 10 && n <= 120) f.inch.add(String(n));
  }
  for (const m of t.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s?(tb|tt|gb|gt)\b/gi)) {
    f.storage.add(String(Math.round(num(m[1]) * (/^t/i.test(m[2]) ? 1000 : 1))));
  }
  for (const m of t.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s?(ml|l|litra\w*)\b/gi)) {
    f.volume.add(String(Math.round(num(m[1]) * (/^ml$/i.test(m[2]) ? 1 : 1000))));
  }
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,3})\s?(?:-?kpl\b|-?pack\b|pcs\b|-?pakkaus\b)/gi)) f.pack.add(String(Number(m[1])));
  for (const [re, name] of COLOURS) if (re.test(t)) f.colour.add(name);
  return f;
}

const KINDS: Kind[] = ["inch", "storage", "volume", "pack", "colour"];
const show = (k: Kind, v: string): string =>
  k === "inch" ? `${v}″`
  : k === "storage" ? (Number(v) >= 1000 ? `${Number(v) / 1000} TB` : `${v} GB`)
  : k === "volume" ? (Number(v) >= 1000 ? `${(Number(v) / 1000).toString().replace(".", ",")} l` : `${v} ml`)
  : k === "pack" ? `${v} kpl`
  : v;
const list = (k: Kind, vals: Iterable<string>) => [...vals].map((v) => show(k, v)).join("/");

/** Value counts over links (each link counts a value once). */
function counts<T>(rows: Iterable<T>[]): Map<T, number> {
  const c = new Map<T, number>();
  for (const vals of rows) for (const v of new Set(vals)) c.set(v, (c.get(v) ?? 0) + 1);
  return c;
}

/** The most common value(s) and their count; several on a tie. */
function top<T>(c: Map<T, number>): { values: Set<T>; count: number } {
  const max = Math.max(0, ...c.values());
  return { values: new Set([...c].filter(([, n]) => n === max && max > 0).map(([v]) => v)), count: max };
}

/**
 * Links that look like another product than their item, with the reasons in plain words.
 * - EAN: the link's code is in the minority (more links share another code). A 1 vs 1 tie is not flagged.
 * - Size, capacity, volume, pack, colour: compared with the item's name when the name tells it, otherwise
 *   with the most common value among the links. A title that does not tell is not flagged.
 */
export function linkMismatches(itemName: string, links: LinkLike[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, why: string) => out.set(id, [...(out.get(id) ?? []), why]);

  const codes = new Map(links.map((l) => [l.id, gtin(l.ean)]));
  const codeCount = counts([...codes.values()].map((g) => (g ? [g] : [])));
  const main = top(codeCount);
  for (const l of links) {
    const g = codes.get(l.id);
    if (!g || main.values.has(g) || main.count <= (codeCount.get(g) ?? 0)) continue;
    add(l.id, `eri EAN ${showGtin(g)} (muilla ${[...main.values].map(showGtin).join(", ")})`);
  }

  const refs = featureRefs(itemName, links);
  for (const l of links) {
    for (const w of featureReasons(refs, features(l.model_name), true)) add(l.id, w);
  }
  return out;
}

type FeatureRef = { values: Set<string>; count: number; byLink: Map<string, number>; fromName: boolean };

/** Per kind: what the item is (its name, else the most common value among its links). */
function featureRefs(itemName: string, links: LinkLike[]): Map<Kind, FeatureRef> {
  const fromName = features(itemName);
  const feats = links.map((l) => features(l.model_name));
  const refs = new Map<Kind, FeatureRef>();
  for (const k of KINDS) {
    const byLink = counts(feats.map((f) => f[k]));
    const ref = fromName[k].size ? { values: fromName[k], count: Infinity } : top(byLink);
    if (ref.values.size) refs.set(k, { ...ref, byLink, fromName: fromName[k].size > 0 });
  }
  return refs;
}

/**
 * Where a title disagrees with the item. `counted`: the title is one of the links behind the reference, so
 * it is flagged only when more links agree with each other than with it (on a tie there is no side to pick).
 */
function featureReasons(refs: Map<Kind, FeatureRef>, own: Features, counted: boolean): string[] {
  const why: string[] = [];
  for (const [k, ref] of refs) {
    const vals = own[k];
    if (vals.size === 0 || [...vals].some((v) => ref.values.has(v))) continue;
    if (counted && ref.count <= Math.max(...[...vals].map((v) => ref.byLink.get(v) ?? 0))) continue;
    why.push(`${list(k, vals)}, ${ref.fromName ? "tuotteella" : "muilla"} ${list(k, ref.values)}`);
  }
  return why;
}

/**
 * A page about to be added to an existing item: does it look like another product? Any EAN the item does
 * not have yet counts, and the item's own links are not outvoted by the one new page.
 */
export function candidateMismatch(itemName: string, links: LinkLike[], page: { ean: string | null; name: string | null }): string[] {
  const why: string[] = [];
  const g = gtin(page.ean);
  const codes = new Set(links.map((l) => gtin(l.ean)).filter((x): x is string => Boolean(x)));
  if (g && codes.size && !codes.has(g)) why.push(`eri EAN ${showGtin(g)} (tuotteella ${[...codes].map(showGtin).join(", ")})`);
  return [...why, ...featureReasons(featureRefs(itemName, links), features(page.name), false)];
}

// ---------- One product tracked twice ----------

export type DuplicatePair<I extends ItemLike> = { older: I; newer: I; why: string[] };

/** The item's own EAN(s): the most common code of its links (several on a tie). */
function itemCodes(links: LinkLike[]): Set<string> {
  return top(counts(links.map((l) => gtin(l.ean)).map((g) => (g ? [g] : [])))).values;
}

/**
 * Pairs of items that are the same product: a shared product page, the same EAN, or the same name.
 * `items` should be the wish list (not bought, not deleted); each pair is listed once, older item first.
 */
export function findDuplicates<I extends ItemLike>(items: I[], linksOf: (itemId: string) => LinkLike[]): DuplicatePair<I>[] {
  const info = items.map((item) => {
    const links = linksOf(item.id);
    return {
      item,
      pages: new Map(links.map((l) => [productUrlKey(l.url), hostOf(l.url)])),
      codes: itemCodes(links),
      name: sellerKey(item.name),
    };
  });
  const pairs: DuplicatePair<I>[] = [];
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const [a, b] = [info[i], info[j]];
      const why: string[] = [];
      const sharedHosts = [...new Set([...a.pages.keys()].filter((k) => b.pages.has(k)).map((k) => a.pages.get(k)!))];
      if (sharedHosts.length) why.push(`sama linkki: ${sharedHosts.join(", ")}`);
      const sharedCodes = [...a.codes].filter((g) => b.codes.has(g));
      if (sharedCodes.length) why.push(`sama EAN ${sharedCodes.map(showGtin).join(", ")}`);
      if (a.name && a.name === b.name) why.push("sama nimi");
      if (!why.length) continue;
      const [older, newer] = a.item.created_at <= b.item.created_at ? [a.item, b.item] : [b.item, a.item];
      pairs.push({ older, newer, why });
    }
  }
  return pairs;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
