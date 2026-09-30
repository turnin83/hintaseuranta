import type { ComponentChildren } from "preact";
import { route } from "../lib/router.ts";
import { toastMsg, unreadCount } from "../lib/store.ts";
import { IconBack, IconBell, IconList, IconPlus, IconSettings } from "./icons.tsx";

export function TopBar(props: { title: string; parent?: string; children?: ComponentChildren }) {
  return (
    <header class="topbar">
      {props.parent && (
        <a class="icon-btn back" href={props.parent} aria-label="Takaisin">
          <IconBack />
        </a>
      )}
      <h1>{props.title}</h1>
      {props.children}
    </header>
  );
}

export function TabBar() {
  const r = route.value.name;
  const tab = (href: string, active: boolean, label: string, icon: ComponentChildren, extra?: ComponentChildren) => (
    <a class="tab" href={href} aria-current={active ? "page" : undefined}>
      {icon}
      <span>{label}</span>
      {extra}
    </a>
  );
  const n = unreadCount.value;
  return (
    <nav class="tabbar" aria-label="Päävalikko">
      {tab("#/", r === "list" || r === "item", "Toiveet", <IconList />)}
      {tab("#/alerts", r === "alerts", "Hälytykset", <IconBell />, n > 0 && (
        <span class="count" aria-label={`${n} lukematonta`}>{n > 99 ? "99+" : n}</span>
      ))}
      {tab("#/add", r === "add", "Lisää", <IconPlus />)}
      {tab("#/settings", r === "settings", "Asetukset", <IconSettings />)}
    </nav>
  );
}

export function Toast() {
  return toastMsg.value ? <div class="toast" role="status">{toastMsg.value}</div> : null;
}
