-- Black Week readiness: cross-check of direct shop prices against comparison pages, campaign-aware health.

-- The price a comparison page last showed for this direct shop link: {cents, via, ts}. The comparison
-- page's own row for the shop is not recorded (duplicate seller), so this is the only trace of it.
alter table public.product_links add column xcheck jsonb;

-- health(): + campaign_running. The GitHub watchdog checks hourly and allows 3 h without a successful
-- fetch while a campaign runs (26 h otherwise).
create or replace function public.health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'last_ok_fetch', (select max(last_fetched_at) from public.product_links where last_status = 'ok'),
    'active_links', (select count(*) from public.product_links where active),
    'broken_links', (select count(*) from public.product_links where active and failing_since < now() - interval '24 hours'),
    'campaign_running', exists (
      select 1 from public.campaigns c join public.households h on h.id = c.household_id
      where c.active and (now() at time zone h.timezone)::date between c.starts_on and c.ends_on
    )
  )
$$;
