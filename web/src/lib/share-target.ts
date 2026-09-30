// Web Share Target: the OS opens /share?title=..&text=..&url=.. ; turn it into #/add?url=..
import { findUrl } from "@shared/url.ts";

if (location.pathname === "/share") {
  const q = new URLSearchParams(location.search);
  const shared = findUrl(q.get("url")) ?? findUrl(q.get("text")) ?? findUrl(q.get("title"));
  history.replaceState(null, "", "/#/add" + (shared ? `?url=${encodeURIComponent(shared)}` : ""));
}
