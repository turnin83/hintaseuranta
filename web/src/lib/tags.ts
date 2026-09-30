import { useEffect, useState } from "preact/hooks";
import { supabase } from "./supabase.ts";
import { dataVersion } from "./store.ts";

export const MAX_TAGS = 10;
const MAX_LEN = 30;

/** Trims, collapses spaces and reuses the household's existing spelling ("tv" -> "TV"). */
export function normalizeTag(raw: string, known: string[]): string | null {
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
  if (!t) return null;
  return known.find((k) => k.toLocaleLowerCase("fi") === t.toLocaleLowerCase("fi")) ?? t;
}

export function hasTag(tags: string[], tag: string): boolean {
  const l = tag.toLocaleLowerCase("fi");
  return tags.some((t) => t.toLocaleLowerCase("fi") === l);
}

export type TagCount = { tag: string; count: number };

/** Counts tags over the given items; most used first, then alphabetical. */
export function countTags(items: { tags: string[] }[]): TagCount[] {
  const m = new Map<string, TagCount>();
  for (const i of items) {
    for (const t of i.tags ?? []) {
      const k = t.toLocaleLowerCase("fi");
      const c = m.get(k);
      if (c) c.count++;
      else m.set(k, { tag: t, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "fi"));
}

/** Tags used anywhere in the household (quick picks). */
export function useHouseholdTags(): TagCount[] {
  const [tags, setTags] = useState<TagCount[]>([]);
  useEffect(() => {
    supabase.from("wish_items").select("tags").then(({ data }) => setTags(countTags((data ?? []) as { tags: string[] }[])));
  }, [dataVersion.value]);
  return tags;
}
