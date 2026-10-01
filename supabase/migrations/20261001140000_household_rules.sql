-- Household-wide default alert rules (Settings → Hälytykset). Items store only their overrides in
-- wish_items.rules; effective rules = DEFAULT_RULES <- households.default_rules <- wish_items.rules.
alter table public.households add column default_rules jsonb not null default '{}'::jsonb;

-- Item-level alerts (below target, all-time low, below median) are not tied to one user's link.
alter table public.alert_events alter column user_id drop not null;
