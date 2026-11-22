// Work-list rows the user has dismissed ("Ohita", "Sama tuote", "Eri tuotteet"), per user in this browser.
// Shared by the Links view and the item page, so a link marked as the same product stops warning in both.
import { useState } from "preact/hooks";
import { session } from "./store.ts";

const storeKey = () => `${session.value?.user.id ?? "anon"}:links-skip`;

export function readSkipped(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storeKey()) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function addSkipped(key: string): Set<string> {
  const next = readSkipped().add(key);
  try {
    localStorage.setItem(storeKey(), JSON.stringify([...next]));
  } catch { /* private mode */ }
  return next;
}

export function useSkipped(): [Set<string>, (key: string) => void] {
  const [skipped, setSkipped] = useState<Set<string>>(readSkipped);
  return [skipped, (key: string) => setSkipped(addSkipped(key))];
}
