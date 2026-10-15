-- Health watch, price drop after purchase, daily price trend for sparklines.

-- When a link started failing (cleared on success): a link broken for > 24 h raises one alert.
alter table public.product_links add column failing_since timestamptz;

-- Purchased items keep being fetched quietly for 30 days (price drop after purchase).
create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  where l.active
    and (w.active or (w.purchased_at is not null and w.purchased_at > now() - interval '30 days'))
    and (l.claimed_until is null or l.claimed_until < now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => public.effective_interval_minutes(l.household_id)) + interval '10 minutes'
    )
$$;

-- Minimal health status for the external watchdog (GitHub Actions, anon key): only timestamps / counts.
create function public.health() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'last_ok_fetch', (select max(last_fetched_at) from public.product_links where last_status = 'ok'),
    'active_links', (select count(*) from public.product_links where active),
    'broken_links', (select count(*) from public.product_links where active and failing_since < now() - interval '24 hours')
  )
$$;
revoke execute on function public.health() from public;
grant execute on function public.health() to anon, authenticated, service_role;

-- Daily minimum price per item (in-stock offers), for the 30-day sparkline on list cards.
create view public.v_item_daily with (security_invoker = true) as
select l.wish_item_id, date_trunc('day', o.ts)::date as day, min(o.price_cents) as min_cents
from public.price_observations o
join public.product_links l on l.id = o.product_link_id
where o.ts > now() - interval '30 days' and o.availability <> 'out_of_stock'
group by 1, 2;
