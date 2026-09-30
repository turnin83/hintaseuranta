// Tag editor: selected tags as removable chips, free-text input, household tags as one-tap quick picks.
import { useState } from "preact/hooks";
import { hasTag, MAX_TAGS, normalizeTag, useHouseholdTags } from "../lib/tags.ts";
import { IconPlus } from "./icons.tsx";

export function TagInput(props: { value: string[]; onChange: (tags: string[]) => void; id?: string }) {
  const known = useHouseholdTags();
  const [text, setText] = useState("");
  const full = props.value.length >= MAX_TAGS;

  const add = (raw: string) => {
    const t = normalizeTag(raw, known.map((k) => k.tag));
    if (!t || hasTag(props.value, t) || full) return;
    props.onChange([...props.value, t]);
  };
  const remove = (t: string) => props.onChange(props.value.filter((x) => x !== t));

  const commit = () => {
    for (const part of text.split(",")) add(part);
    setText("");
  };

  const suggestions = known.filter((k) => !hasTag(props.value, k.tag)).slice(0, 12);

  return (
    <div class="stack-sm">
      {props.value.length > 0 && (
        <div class="tag-list">
          {props.value.map((t) => (
            <span class="tag" key={t}>
              {t}
              <button type="button" class="tag-remove" onClick={() => remove(t)} aria-label={`Poista tagi ${t}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <div class="row" style="gap:8px">
        <input
          id={props.id}
          value={text}
          disabled={full}
          placeholder={full ? `Enintään ${MAX_TAGS} tagia` : "Uusi tagi, esim. TV"}
          enterKeyHint="done"
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            if (v.includes(",")) {
              for (const part of v.split(",").slice(0, -1)) add(part);
              setText(v.split(",").at(-1) ?? "");
            } else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={() => text.trim() && commit()}
        />
        <button type="button" class="btn" style="flex:none" disabled={!text.trim() || full} onClick={commit} aria-label="Lisää tagi">
          <IconPlus />
        </button>
      </div>
      {suggestions.length > 0 && !full && (
        <div class="tag-list" aria-label="Käytetyt tagit">
          {suggestions.map((s) => (
            <button type="button" class="tag-pick" key={s.tag} onClick={() => add(s.tag)}>+ {s.tag}</button>
          ))}
        </div>
      )}
    </div>
  );
}
