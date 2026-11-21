-- Purchases of several pieces: the price stays per piece, savings and spending are counted per piece × quantity.
alter table public.wish_items
  add column purchased_qty int not null default 1 check (purchased_qty between 1 and 999);

-- Same view, purchased_qty appended (create or replace allows new columns at the end).
create or replace view public.v_wish_summary with (security_invoker = true) as
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
  st.usual_cents,
  coalesce(lk.link_count, 0) as link_count,
  coalesce(lk.failing_links, 0) as failing_links,
  lk.last_fetched_at,
  coalesce(al.unread_alerts, 0) as unread_alerts,
  coalesce(hi.history_days, 0) as history_days,
  w.purchased_qty
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
left join lateral public.item_price_stats(w.id, now()) st on true
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
left join lateral (
  select count(*)::int as history_days
  from public.price_observations o
  join public.product_links l on l.id = o.product_link_id
  where l.wish_item_id = w.id and o.seller = '#history'
) hi on true
where w.deleted_at is null;
