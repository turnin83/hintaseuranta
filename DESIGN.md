# DESIGN.md

Design rules for the Hintaseuranta PWA (read by impeccable.style and by anyone editing the UI).
Tokens live in `web/src/styles.css` (`:root`). Anything not listed here is outside the system.

## Character
Calm, operational, phone-first. The screen answers one question: *is now a good time to buy?*
The price is the loudest element; everything else supports it.

## Typography
| Role | Family | Size / weight |
|---|---|---|
| Display (h1, prices) | Bricolage Grotesque | h1 26/700, hero price 40/700, card price 28/700 |
| Section heading (h2) | Bricolage Grotesque | 20/600 |
| Sub-heading (h3, summary) | Bricolage Grotesque | 17/600 |
| Body | IBM Plex Sans | 16/400, line-height 1.5 |
| Secondary / meta | IBM Plex Sans | 14/400 |
| Chip, tab label | IBM Plex Sans | 13/600, 13/500 |

- Numbers always `font-variant-numeric: tabular-nums` (`.num`).
- Finnish money format: `1 299,90 €` (space thousands, comma decimals, `€` after).
- No text below 13px. Inputs are 16px (prevents iOS zoom).

## Color
Dark is the default; light follows the OS.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #121417 | #f7f7f5 | page |
| `--surface` | #1a1d21 | #ffffff | cards, inputs |
| `--surface-2` | #22262b | #f0f1f2 | secondary buttons, segmented control |
| `--line` | #2e333a | #dfe2e6 | borders, dividers, chart grid |
| `--text` / `--text-2` / `--text-3` | #eef0f2 / #b4bac2 / #8a929c | #15181c / #4a525c / #6b737d | ink levels |
| `--accent` | #4fd18b | #13824a | good deal, primary action, unread |
| `--warn` | #f2b84b | #8a5a00 | info-level alerts, failing links |
| `--bad` | #ef7a6f | #b8352a | price up, errors, destructive |

- Green = price went down / good; red = up / error. Never color alone: always an arrow icon, sign (−/+) or label.
- Chart series use the validated categorical palette `--s1…--s8` (dataviz reference palette; dark steps
  validated against `--surface`). Fixed order, max 8 series, color follows the (link, seller) entity.
  Light mode slots 3–5 are under 3:1 → the per-shop price table under the chart is mandatory.

## Shape & space
- Radius: fields/buttons 8px, cards 12px, chips 6px.
- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48. Page gutter 16px.
- Touch targets ≥ 48px. Bottom tab bar 64px + safe area.

## Motion
- Press: `scale(0.97)`, 160ms, `cubic-bezier(0.2,0,0,1)`. No bounce, no pulsing dots.
- Respect `prefers-reduced-motion`.

## Components
- **One primary button per screen** (filled accent). Everything else is secondary (surface-2) or ghost.
- **Item card**: name → big price + seller → one meta line (delta vs 30 d median, target). Chips only for
  state that needs attention (unread, target reached, failing link).
- **Alerts**: unread = surface card + accent dot + bold title; info level = amber dot. No side stripes.
- **Panels**: `<details>` with +/– for secondary editing (item fields, rules, shops).

## Don't
Inter/Geist, purple gradients, glassmorphism as decoration, nested cards, gradient text,
status-chip soup, all-caps body text, emoji icons.
