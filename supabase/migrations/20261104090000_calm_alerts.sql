-- Calmer alerts:
-- * one event per item and run (alert_events.rules / details / notify), pushed only when significant
-- * item rules are state based (wish_items.alert_state), shop rules ignore bounces
-- * the shop's "before" price is checked against our own 30-day low (price_observations.own_low_30d_cents)
--   and shown next to the price instead of as "suspicious discount" alerts (old ones removed)
-- * muted sellers per household; alerts older than 7 days count as read

alter table public.alert_events
  add column rules text[] not null default '{}',
  add column details jsonb,
  add column notify boolean not null default true;
update public.alert_events set rules = array[rule];
create index alert_events_details_idx on public.alert_events using gin (details jsonb_path_ops);

delete from public.alert_events where rule = 'suspicious_discount';

alter table public.wish_items add column alert_state jsonb;
alter table public.households add column muted_sellers text[] not null default '{}';
alter table public.price_observations add column own_low_30d_cents int;

drop view public.v_wish_summary;
drop view public.v_series;
drop view public.v_alerts;

create view public.v_series with (security_invoker = true) as
with latest as (
  select distinct on (o.product_link_id, o.seller)
    o.product_link_id, o.seller, o.price_cents, o.ts, o.availability, o.lowest_30d_cents, o.shipping_cents, o.own_low_30d_cents
  from public.price_observations o
  order by o.product_link_id, o.seller, o.ts desc
), stats as (
  select
    o.product_link_id,
    o.seller,
    min(o.price_cents) as min_all,
    count(*)::int as obs_count,
    min(o.price_cents) filter (where o.ts > now() - interval '30 days') as min_30d,
    percentile_cont(0.5) within group (order by o.price_cents)
      filter (where o.ts > now() - interval '30 days') as median_30d
  from public.price_observations o
  group by o.product_link_id, o.seller
)
select
  l.id as product_link_id,
  l.wish_item_id,
  l.household_id,
  l.url,
  l.active as link_active,
  (l.active and (lt.seller = '' or l.sellers is null or lt.seller = any (l.sellers))) as tracked,
  s.domain,
  s.strategy as shop_strategy,
  lt.seller,
  coalesce(nullif(lt.seller, ''), s.name, s.domain) as seller_name,
  lt.price_cents,
  lt.ts,
  lt.availability,
  lt.lowest_30d_cents,
  lt.shipping_cents,
  lt.own_low_30d_cents,
  st.min_all,
  st.min_30d,
  round(st.median_30d)::int as median_30d,
  st.obs_count
from latest lt
join stats st on st.product_link_id = lt.product_link_id and st.seller = lt.seller
join public.product_links l on l.id = lt.product_link_id
join public.shops s on s.id = l.shop_id;

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
  best.lowest_30d_cents as best_claim_cents,
  best.own_low_30d_cents as best_own_low_cents,
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
  select v.seller_name, v.price_cents, v.shipping_cents, v.lowest_30d_cents, v.own_low_30d_cents, v.url, v.availability, v.ts
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

create view public.v_alerts with (security_invoker = true) as
select
  a.*,
  w.name as item_name,
  (a.ts < now() - interval '7 days'
   or exists (select 1 from public.alert_reads r where r.alert_id = a.id and r.user_id = (select auth.uid()))) as read
from public.alert_events a
join public.wish_items w on w.id = a.wish_item_id
where w.deleted_at is null;
