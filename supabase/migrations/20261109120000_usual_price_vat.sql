-- An item's usual price and lowest recent price in one place, and the prices of a shop that were stored
-- without VAT.

-- Usual price = the lower of the 30- and 90-day medians of the daily lowest in-stock price. When the cheap
-- sellers leave and one expensive shop remains, the 30-day figure jumps; the 90-day one keeps it honest. It
-- can only make a discount look smaller. Lowest = the lowest of those 90 days, and where it was. Done here
-- because the API returns at most 1000 rows, and busy items have more than that during a campaign.
-- A comparison page's anonymous low (aggregator link, seller '') is not a shop you can buy from.
create function public.item_price_stats(p_item uuid, p_before timestamptz default now())
returns table (
  usual_cents int,
  usual_days int,
  low_cents int,
  low_ts timestamptz,
  low_shop text,
  has_history boolean
)
language sql stable set search_path = '' as $$
  with obs as (
    select o.ts, o.price_cents, o.seller,
      case when o.seller = '#history' then o.history_shop else coalesce(nullif(o.seller, ''), s.name, s.domain) end as shop
    from public.price_observations o
    join public.product_links l on l.id = o.product_link_id
    join public.shops s on s.id = l.shop_id
    where l.wish_item_id = p_item
      and o.ts >= p_before - interval '90 days' and o.ts < p_before
      and o.availability <> 'out_of_stock'
      and not (o.seller = '' and s.strategy = 'aggregator')
  ), daily as (
    select date_trunc('day', ts) as day, min(price_cents) as low from obs group by 1
  ), usual as (
    select
      round(least(
        percentile_cont(0.5) within group (order by low) filter (where day >= p_before - interval '30 days'),
        percentile_cont(0.5) within group (order by low)
      ))::int as cents,
      count(*)::int as days
    from daily
  ), lowest as (
    select price_cents, ts, shop from obs order by price_cents, ts desc limit 1
  )
  select u.cents, u.days, lo.price_cents, lo.ts, lo.shop, exists (select 1 from obs where seller = '#history')
  from usual u left join lowest lo on true
$$;
revoke execute on function public.item_price_stats(uuid, timestamptz) from public, anon;
grant execute on function public.item_price_stats(uuid, timestamptz) to authenticated, service_role;

-- median_30d_cents -> usual_cents
drop view public.v_wish_summary;

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
  st.usual_cents,
  coalesce(lk.link_count, 0) as link_count,
  coalesce(lk.failing_links, 0) as failing_links,
  lk.last_fetched_at,
  coalesce(al.unread_alerts, 0) as unread_alerts,
  coalesce(hi.history_days, 0) as history_days
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

-- ---------------------------------------------------------------------------
-- kauppa.ykkospalvelu.fi: prices were read without VAT (25.5 %). Rows read since the fix have another source.
-- ---------------------------------------------------------------------------
update public.price_observations o
set price_cents = round(o.price_cents * 1.255)::int,
    own_low_30d_cents = round(o.own_low_30d_cents * 1.255)::int,
    lowest_30d_cents = round(o.lowest_30d_cents * 1.255)::int
where o.source = 'jsonld'
  and o.product_link_id in (
    select l.id from public.product_links l join public.shops s on s.id = l.shop_id
    where s.domain = 'kauppa.ykkospalvelu.fi'
  );

-- The one alert built on those prices: 129,99 -> 98,99, while the lowest elsewhere was 119,90.
create function pg_temp.vat_fixed(t text) returns text language sql immutable as $$
  select replace(replace(replace(replace(
    regexp_replace(t, '24(.%.alle tavallisen.)103,58', '17\1' || '119,90'),
    'aiempi 103,58', 'aiempi 119,90'),
    'Laski 103,58', 'Laski 129,99'),
    '78,88', '98,99'),
    '"price": 7888', '"price": 9899')
$$;

update public.alert_events a
set price_cents = 9899,
    message = pg_temp.vat_fixed(a.message),
    details = pg_temp.vat_fixed(a.details::text)::jsonb
where a.price_cents = 7888
  and a.product_link_id in (
    select l.id from public.product_links l join public.shops s on s.id = l.shop_id
    where s.domain = 'kauppa.ykkospalvelu.fi'
  );

-- The last alerted price, so that a real drop from 98,99 is noticed.
update public.wish_items w
set alert_state = replace(w.alert_state::text, '7888', '9899')::jsonb
where w.alert_state::text like '%7888%'
  and w.id in (
    select l.wish_item_id from public.product_links l join public.shops s on s.id = l.shop_id
    where s.domain = 'kauppa.ykkospalvelu.fi'
  );
