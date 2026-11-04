// One alert event, readable at a glance: a colour-coded tag for what happened, the price, the shop,
// the other reasons (each with the same colour marker as its tag) and a warning when the "deal" may
// mislead. Events from before merged alerts fall back to the rule label and plain text.
import type { AlertEvent } from "../lib/types.ts";
import { dateTime } from "../lib/format.ts";
import { RULE_LABELS, type RuleName } from "@shared/rules.ts";
import { IconAlert } from "./icons.tsx";

/** "Uusi alin hinta: 199 €" -> ["Uusi alin hinta", "199 €"] */
function splitHeadline(h: string): [string, string] {
  const i = h.indexOf(": ");
  return i < 0 ? [h, ""] : [h.slice(0, i), h.slice(i + 2)];
}

export function RuleTag(props: { rule: string; children: string }) {
  return <span class={`rule-tag rule-${props.rule}`}>{props.children}</span>;
}

export function AlertEntry(props: { alert: AlertEvent; showItem?: boolean; extra?: string }) {
  const a = props.alert;
  const d = a.details;
  // Rule of each reason line; older events stored only the rule list (same order when lengths match).
  const lineRules = d?.line_rules ?? (d && d.lines.length === a.rules.length ? a.rules : null);
  const [label, headValue] = d ? splitHeadline(d.headline) : [RULE_LABELS[a.rule as RuleName] ?? a.rule, ""];
  // "Linkki ei toimi: <kauppa>" names the shop, which the meta line already shows.
  const value = headValue === d?.seller ? "" : headValue;
  return (
    <div class="alert-body">
      {props.showItem && (
        <div class="alert-item">
          {a.item_name}
          {!a.read && <span class="visually-hidden"> (lukematon)</span>}
        </div>
      )}
      <div class="alert-head">
        <RuleTag rule={a.rule}>{label}</RuleTag>
        {value && <span class="alert-value num">{value}</span>}
      </div>
      {d ? (
        <>
          <div class="meta">
            {d.seller} · {dateTime(a.ts)}
            {!a.notify && " · ei puhelinilmoitusta"}
          </div>
          {d.lines.length > 0 && (
            <ul class="alert-reasons">
              {d.lines.map((l, i) => (
                <li key={i} class={`num rule-line rule-${lineRules?.[i] ?? "none"}`}>{l}</li>
              ))}
            </ul>
          )}
          {d.warning && (
            <p class="alert-warning">
              <IconAlert width={16} height={16} />
              <span>{d.warning}</span>
            </p>
          )}
        </>
      ) : (
        <>
          <div class="muted">{a.seller ? `${a.seller}: ` : ""}{a.message}</div>
          <div class="meta">{dateTime(a.ts)}</div>
        </>
      )}
      {props.extra && <div class="meta">{props.extra}</div>}
    </div>
  );
}
