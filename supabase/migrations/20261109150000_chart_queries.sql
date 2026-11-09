-- Charts without the API's row limit (1000 rows per query by default), which cut off the newest prices.

-- Price chart: one JSON value, and only the rows where a shop's price changed plus each shop's latest.
-- The chart is a step line, so nothing is lost.
create function public.item_chart_points(p_item uuid, p_days int default null)
returns jsonb
language sql stable set search_path = '' as $$
  with obs as (
    select o.product_link_id, o.seller, o.ts, o.price_cents,
      lag(o.price_cents) over w as prev_cents,
      lead(o.ts) over w as next_ts
    from public.price_observations o
    join public.product_links l on l.id = o.product_link_id
    where l.wish_item_id = p_item
      and (p_days is null or o.ts >= now() - make_interval(days => p_days))
    window w as (partition by o.product_link_id, o.seller order by o.ts)
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'key', product_link_id::text || '|' || seller,
      'ts', ts,
      'price_cents', price_cents
    ) order by ts),
    '[]'::jsonb
  )
  from obs
  where prev_cents is distinct from price_cents or next_ts is null
$$;
revoke execute on function public.item_chart_points(uuid, int) from public, anon;
grant execute on function public.item_chart_points(uuid, int) to authenticated, service_role;

-- List sparklines: one row per item.
create view public.v_item_trend with (security_invoker = true) as
select wish_item_id, array_agg(min_cents order by day) as mins
from public.v_item_daily
group by 1;

-- Diagnostics role (see 20261109130000_read_only_stats.sql).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    grant execute on function public.item_chart_points(uuid, int) to supabase_read_only_user;
  end if;
end $$;
