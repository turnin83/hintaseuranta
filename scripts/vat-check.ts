/** Does the page also show this price + Finnish VAT? Then the price we read is probably without VAT. */
export function showsPriceWithVat(html: string, priceCents: number): boolean {
  const withVat = (Math.round(priceCents * 1.255) / 100).toFixed(2).replace(".", ",");
  return new RegExp(`[^0-9]${withVat}[^0-9]`).test(html.replace(/&nbsp;|\s/g, ""));
}
