// Small "campaign running" pill with a one-time shimmer. Deliberately quiet: no banner, no pulsing.
import { fiDate, intervalLabel, runningCampaign } from "../lib/campaigns.ts";

export function CampaignBadge() {
  const c = runningCampaign.value;
  if (!c) return null;
  return (
    <a class="campaign-badge" href="#/settings" title={`Hinnat haetaan ${intervalLabel(c.fetch_interval_minutes)} kampanjan ajan`}>
      <span class="campaign-spark" aria-hidden="true" />
      {c.name} käynnissä · {fiDate(c.ends_on)} asti
    </a>
  );
}
