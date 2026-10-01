// Alert rules editor, shared by Settings (household defaults) and the item view (item overrides).
import { RULE_LABELS, type Rules } from "@shared/rules.ts";

/** Short list of enabled rules, e.g. "Alle tavoitehinnan · Alin koskaan · Alle mediaanin −10 %". */
export function rulesSummary(r: Rules): string {
  const on: string[] = [];
  if (r.below_target) on.push("tavoitehinta");
  if (r.all_time_low.enabled) on.push("alin koskaan");
  if (r.below_median.enabled) on.push(`−${r.below_median.pct} % mediaanista`);
  if (r.drop.enabled) on.push(`pudotus ${r.drop.pct} %`);
  if (r.back_in_stock) on.push("varastoon");
  return on.length ? on.join(" · ") : "kaikki hälytykset pois";
}

export function RulesForm(props: { value: Rules; onChange: (r: Rules) => void; targetSet?: boolean }) {
  const r = props.value;
  const set = (patch: Partial<Rules>) => props.onChange({ ...r, ...patch });
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  const chk = (e: Event) => (e.target as HTMLInputElement).checked;

  return (
    <div class="stack">
      <div class="stack-sm">
        <h3>Tuotteen paras hinta</h3>
        <p class="meta">Arvioidaan halvimmasta saatavilla olevasta hinnasta kaikkien kauppojen yli. Yksi hälytys per tuote.</p>
        <label class="check">
          <input type="checkbox" checked={r.below_target} onChange={(e) => set({ below_target: chk(e) })} />
          <span>{RULE_LABELS.below_target}{props.targetSet === false ? <span class="meta"> · aseta tavoitehinta</span> : null}</span>
        </label>
        <label class="check">
          <input type="checkbox" checked={r.all_time_low.enabled} onChange={(e) => set({ all_time_low: { ...r.all_time_low, enabled: chk(e) } })} />
          {RULE_LABELS.all_time_low}
        </label>
        {r.all_time_low.enabled && (
          <label class="field indent"><span>Vaadi historiaa vähintään (havaintoa)</span>
            <input type="number" min={2} max={100} value={r.all_time_low.min_obs} onInput={(e) => set({ all_time_low: { ...r.all_time_low, min_obs: num(e) } })} />
          </label>
        )}
        <label class="check">
          <input type="checkbox" checked={r.below_median.enabled} onChange={(e) => set({ below_median: { ...r.below_median, enabled: chk(e) } })} />
          {RULE_LABELS.below_median}
        </label>
        {r.below_median.enabled && (
          <label class="field indent"><span>Vähintään % alle mediaanin</span>
            <input type="number" min={1} max={90} value={r.below_median.pct} onInput={(e) => set({ below_median: { ...r.below_median, pct: num(e) } })} />
          </label>
        )}
      </div>

      <div class="stack-sm">
        <h3>Yksittäinen kauppa</h3>
        <label class="check">
          <input type="checkbox" checked={r.drop.enabled} onChange={(e) => set({ drop: { ...r.drop, enabled: chk(e) } })} />
          {RULE_LABELS.drop} edellisestä hinnasta
        </label>
        {r.drop.enabled && (
          <label class="field indent"><span>Vähintään % pudotus</span>
            <input type="number" min={1} max={90} value={r.drop.pct} onInput={(e) => set({ drop: { ...r.drop, pct: num(e) } })} />
          </label>
        )}
        <label class="check">
          <input type="checkbox" checked={r.back_in_stock} onChange={(e) => set({ back_in_stock: chk(e) })} />
          {RULE_LABELS.back_in_stock}
        </label>
        <label class="check">
          <input type="checkbox" checked={r.only_cheapest} onChange={(e) => set({ only_cheapest: chk(e) })} />
          <span>Vain kun kauppa on tuotteen halvin<span class="meta"> · suositus, vähentää turhia hälytyksiä</span></span>
        </label>
        <label class="check">
          <input type="checkbox" checked={r.suspicious} onChange={(e) => set({ suspicious: chk(e) })} />
          <span>{RULE_LABELS.suspicious_discount}<span class="meta"> · vain listaan, ei ilmoitusta</span></span>
        </label>
      </div>

      <label class="field"><span>Saman hälytyksen toisto aikaisintaan (h)</span>
        <input type="number" min={1} max={720} value={r.cooldown_hours} onInput={(e) => set({ cooldown_hours: num(e) })} />
        <span class="hint">Aiemmin, jos hinta laskee edelleen.</span>
      </label>
    </div>
  );
}
