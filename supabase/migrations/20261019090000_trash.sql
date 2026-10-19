-- Trash: deleting a wish item moves it to the trash (deleted_at) with its links, history and alerts
-- intact; it can be restored for 30 days, after which a daily job deletes it for good.

alter table public.wish_items add column deleted_at timestamptz;
create index wish_items_deleted_idx on public.wish_items (deleted_at) where deleted_at is not null;

drop view public.v_wish_summary;
drop view public.v_alerts;

create view public.v_alerts with (security_invoker = true) as
select
  a.*,
  w.name as item_name,
  exists (select 1 from public.alert_reads r where r.alert_id = a.id and r.user_id = (select auth.uid())) as read
from public.alert_events a
join public.wish_items w on w.id = a.wish_item_id
where w.deleted_at is null;

create view public.v_wish_summary with (security_invoker = true) as
select
  w.id,
  w.household_id,
  w.name,
  w.tags,
  w.target_price_cents,
  w.priority,
  w.active,
  w.notes,
  w.rules,
  w.created_at,
  w.purchased_at,
  w.purchased_price_cents,
  w.purchased_seller,
  w.purchased_ref_cents,
  w.deleted_at,
  best.seller_name as best_seller,
  best.price_cents as best_price_cents,
  best.shipping_cents as best_shipping_cents,
  best.url as best_url,
  best.availability as best_availability,
  best.ts as best_ts,
  mn.min_all_cents,
  med.median_30d_cents,
  coalesce(lk.link_count, 0) as link_count,
  coalesce(lk.failing_links, 0) as failing_links,
  lk.last_fetched_at,
  coalesce(al.unread_alerts, 0) as unread_alerts
from public.wish_items w
left join lateral (
  select v.seller_name, v.price_cents, v.shipping_cents, v.url, v.availability, v.ts
  from public.v_series v
  where v.wish_item_id = w.id and v.tracked and v.ts > now() - interval '36 hours'
  order by (v.availability = 'out_of_stock'), v.price_cents
  limit 1
) best on true
left join lateral (
  select min(o.price_cents) as min_all_cents
  from public.price_observations o
  join public.product_links l on l.id = o.product_link_id
  where l.wish_item_id = w.id
) mn on true
left join lateral (
  select round(percentile_cont(0.5) within group (order by d.day_min))::int as median_30d_cents
  from (
    select date_trunc('day', o.ts) as day, min(o.price_cents) as day_min
    from public.price_observations o
    join public.product_links l on l.id = o.product_link_id
    where l.wish_item_id = w.id
      and o.ts > now() - interval '30 days'
      and o.availability <> 'out_of_stock'
    group by 1
  ) d
) med on true
left join lateral (
  select
    count(*)::int as link_count,
    count(*) filter (where l.last_status in ('error', 'blocked', 'no_data'))::int as failing_links,
    max(l.last_fetched_at) as last_fetched_at
  from public.product_links l
  where l.wish_item_id = w.id and l.active
) lk on true
left join lateral (
  select count(*)::int as unread_alerts
  from public.alert_events a
  where a.wish_item_id = w.id and a.level = 'alert'
    and not exists (select 1 from public.alert_reads r where r.alert_id = a.id and r.user_id = (select auth.uid()))
) al on true
where w.deleted_at is null;

-- Items in the trash are never fetched.
create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  where l.active
    and w.deleted_at is null
    and (w.active or (w.purchased_at is not null and w.purchased_at > now() - interval '30 days'))
    and (l.claimed_until is null or l.claimed_until < now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => public.effective_interval_minutes(l.household_id)) + interval '10 minutes'
    )
$$;

-- Empty the trash after 30 days (cascades to links, observations and alerts).
select cron.schedule(
  'purge-trash',
  '41 3 * * *',
  $$delete from public.wish_items where deleted_at < now() - interval '30 days';$$
);
