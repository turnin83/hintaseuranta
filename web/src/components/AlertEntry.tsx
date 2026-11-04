// One alert event, readable at a glance: what happened (headline), where (shop), why (reasons),
// and a warning when the "deal" may mislead. Older events without details fall back to plain text.
import type { AlertEvent } from "../lib/types.ts";
import { dateTime } from "../lib/format.ts";
import { RULE_LABELS, type RuleName } from "@shared/rules.ts";
import { IconAlert } from "./icons.tsx";

export function AlertEntry(props: { alert: AlertEvent; showItem?: boolean; extra?: string }) {
  const a = props.alert;
  const d = a.details;
  return (
    <div class="alert-body">
      {props.showItem && (
        <div class="alert-item">
          {a.item_name}
          {!a.read && <span class="visually-hidden"> (lukematon)</span>}
        </div>
      )}
      {d ? (
        <>
          <div class="alert-headline num">{d.headline}</div>
          <div class="meta">
            {d.seller} · {dateTime(a.ts)}
            {!a.notify && " · ei puhelinilmoitusta"}
          </div>
          {d.lines.length > 0 && (
            <ul class="alert-reasons">
              {d.lines.map((l, i) => <li key={i} class="num">{l}</li>)}
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
          <div class="alert-headline">{RULE_LABELS[a.rule as RuleName] ?? a.rule}</div>
          <div class="muted">{a.seller ? `${a.seller}: ` : ""}{a.message}</div>
          <div class="meta">{dateTime(a.ts)}</div>
        </>
      )}
      {props.extra && <div class="meta">{props.extra}</div>}
    </div>
  );
}
