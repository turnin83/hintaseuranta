// Detects bot-protection responses (challenge pages, WAF blocks).

export function detectBotMarkers(status: number, headers: Headers, html: string): string[] {
  const out: string[] = [];
  const h = (k: string) => headers.get(k);
  if (status === 403 || status === 429 || status === 503) out.push(`status ${status}`);
  if (h("x-vercel-mitigated")) out.push(`x-vercel-mitigated: ${h("x-vercel-mitigated")}`);
  if (h("cf-mitigated")) out.push(`cf-mitigated: ${h("cf-mitigated")}`);
  if (h("x-datadome")) out.push("datadome");
  const head = html.slice(0, 200_000);
  const bodyChecks: [RegExp, string][] = [
    [/Vercel Security Checkpoint/i, "Vercel Security Checkpoint"],
    [/<title>Just a moment\.\.\.<\/title>|cf-chl-bypass|challenge-platform\/h\//i, "Cloudflare challenge"],
    [/_Incapsula_Resource|incap_ses_/i, "Imperva/Incapsula"],
    [/px-captcha|_pxCaptcha/i, "PerimeterX"],
    [/geo\.captcha-delivery\.com/i, "DataDome captcha"],
    [/<title>Access Denied<\/title>[\s\S]*Reference #/i, "Akamai Access Denied"],
  ];
  for (const [re, label] of bodyChecks) if (re.test(head)) out.push(label);
  return out;
}

/** True when markers mean the page is a block/challenge (not just a CDN being present). */
export function isBlocked(status: number, markers: string[]): boolean {
  return markers.length > 0 && (status >= 400 || markers.some((m) => !m.startsWith("status")));
}
