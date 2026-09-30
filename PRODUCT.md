# PRODUCT.md

## Who
A household (the owner and family members created by the owner) sharing one wish list of things to buy from Finnish online shops. Used mostly on a
phone, often from a push notification, sometimes in a hurry (Black Friday 27.11.2026).

## Job
1. Collect a reliable price history per product and shop, starting well before Black Friday.
2. Say clearly when a *real* buying window opens (below target, all-time low, well under the 30-day
   median, big drop, back in stock) and flag fake discounts.
3. Get from the notification to the shop in two taps.

## Principles
- **Trust over cleverness**: show when data is stale or a link fails; never hide a fetch error.
- **Polite scraping**: honest User-Agent, robots.txt respected, per-shop delays, low frequency.
- **Any shop**: shops are data. JSON-LD first, adapters only when needed, comparison sites
  (hintaopas.fi, hinta.fi) as the fallback for shops that block bots.
- **Calm UI**: one primary action per screen; the price is the headline.

## Accessibility
Body 16px, tap targets 48px, AA contrast, colour never the only signal, dark + light themes,
reduced motion respected, chart values also available as a table.
