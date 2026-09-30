// URL normalization: strip ad/tracking params and fragment so the same product maps to one link.

const TRACKING_PARAM =
  /^(utm_.*|gclid|gclsrc|gad_.*|gbraid|wbraid|dclid|fbclid|msclkid|yclid|pv2|_gl|srsltid|mc_[ce]id)$/i;

export function normalizeUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs");
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  return u.toString();
}

/** Registrable-ish domain used as shop key: strips leading "www." */
export function domainOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** Finds the first http(s) URL in free text (Web Share Target often puts it in `text`). */
export function findUrl(text: string | null | undefined): string | null {
  const m = text?.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}
