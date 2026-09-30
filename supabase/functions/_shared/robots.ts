// Minimal robots.txt parser (groups, Allow/Disallow, * and $ wildcards, longest match wins).

export type RobotsGroup = { agents: string[]; rules: { allow: boolean; path: string }[] };

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "allow" || key === "disallow") {
        if (val === "") continue; // empty Disallow = allow all
        cur.rules.push({ allow: key === "allow", path: val });
      }
    }
  }
  return groups;
}

function ruleRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

export function robotsAllows(
  groups: RobotsGroup[],
  userAgent: string,
  pathAndQuery: string,
): { allowed: boolean; matchedRule: string | null } {
  const token = userAgent.toLowerCase().split(/[\/\s]/)[0];
  let group = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  group ??= groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matchedRule: null };
  let best: { allow: boolean; path: string } | null = null;
  for (const r of group.rules) {
    if (!ruleRegex(r.path).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) {
      best = r;
    }
  }
  if (!best) return { allowed: true, matchedRule: null };
  return { allowed: best.allow, matchedRule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}
