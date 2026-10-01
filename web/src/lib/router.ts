// Tiny hash router: #/ , #/item/<id>, #/deals, #/alerts, #/add?url=..&item=..&seller=.., #/settings
import { signal } from "@preact/signals";

export type Route =
  | { name: "list" }
  | { name: "item"; id: string }
  | { name: "deals" }
  | { name: "alerts" }
  | { name: "add"; url: string | null; item: string | null; seller: string | null }
  | { name: "settings" };

function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const q = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  switch (parts[0]) {
    case "item":
      return parts[1] ? { name: "item", id: parts[1] } : { name: "list" };
    case "deals":
      return { name: "deals" };
    case "alerts":
      return { name: "alerts" };
    case "add":
      return { name: "add", url: q.get("url"), item: q.get("item"), seller: q.get("seller") };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "list" };
  }
}

export const route = signal<Route>(parse(location.hash));

addEventListener("hashchange", () => {
  route.value = parse(location.hash);
  scrollTo(0, 0);
});

export function go(hash: string) {
  if (location.hash === hash) route.value = parse(hash);
  else location.hash = hash;
}

/** Back = the view's parent (predictable also when opened from a notification). */
export function back(parent = "#/") {
  go(parent);
}
