-- Campaign calendar, purchased items, quiet hours for push, delivery fees.

-- ---------------------------------------------------------------------------
-- Campaign calendar: while a campaign runs, links are fetched at its (shorter) interval.
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.my_household() references public.households on delete cascade,
  name text not null check (length(name) between 1 and 60),
  starts_on date not null,
  ends_on date not null,
  fetch_interval_minutes int not null default 60 check (fetch_interval_minutes between 30 and 10080),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index campaigns_household_idx on public.campaigns (household_id, starts_on);
alter table public.campaigns enable row level security;
create policy "household campaigns" on public.campaigns for all to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

-- Default Finnish shopping campaigns for existing households.
insert into public.campaigns (household_id, name, starts_on, ends_on, fetch_interval_minutes)
select h.id, c.name, c.starts_on, c.ends_on, c.interval
from public.households h
cross join (values
  ('Singles Day', date '2026-11-10', date '2026-11-11', 60),
  ('Black Week', date '2026-11-20', date '2026-11-30', 60),
  ('Joulualet', date '2026-12-26', date '2027-01-06', 180)
) as c(name, starts_on, ends_on, interval);

-- ---------------------------------------------------------------------------
-- Quiet hours (no push at night; a morning summary instead) and household time zone
-- ---------------------------------------------------------------------------
alter table public.households
  add column quiet_enabled boolean not null default true,
  add column quiet_start smallint not null default 23 check (quiet_start between 0 and 23),
  add column quiet_end smallint not null default 7 check (quiet_end between 0 and 23),
  add column timezone text not null default 'Europe/Helsinki';

alter table public.alert_events add column push_deferred boolean not null default false;

create function public.in_quiet_hours(p_enabled boolean, p_start smallint, p_end smallint, p_tz text, p_at timestamptz default now())
returns boolean language sql stable set search_path = '' as $$
  select p_enabled and p_start <> p_end and (
    case when p_start < p_end
      then extract(hour from p_at at time zone p_tz) >= p_start and extract(hour from p_at at time zone p_tz) < p_end
      else extract(hour from p_at at time zone p_tz) >= p_start or extract(hour from p_at at time zone p_tz) < p_end
    end)
$$;

-- ---------------------------------------------------------------------------
-- Purchased items: tracking stops (active = false), savings vs the usual price at purchase
-- ---------------------------------------------------------------------------
alter table public.wish_items
  add column purchased_at timestamptz,
  add column purchased_price_cents int check (purchased_price_cents > 0),
  add column purchased_seller text,
  add column purchased_ref_cents int check (purchased_ref_cents > 0); -- usual (30 d median) price when bought

-- ---------------------------------------------------------------------------
-- Delivery fee per observation (side info; null = unknown, 0 = free)
-- ---------------------------------------------------------------------------
alter table public.price_observations add column shipping_cents int check (shipping_cents >= 0);

-- ---------------------------------------------------------------------------
-- Effective fetch interval: the shortest of the household setting and any running campaign
-- ---------------------------------------------------------------------------
create function public.effective_interval_minutes(p_household uuid) returns int
language sql stable security definer set search_path = '' as $$
  select least(
    h.fetch_interval_minutes,
    coalesce((
      select min(c.fetch_interval_minutes) from public.campaigns c
      where c.household_id = h.id and c.active
        and (now() at time zone h.timezone)::date between c.starts_on and c.ends_on
    ), h.fetch_interval_minutes))
  from public.households h where h.id = p_household
$$;
revoke execute on function public.effective_interval_minutes(uuid) from public, anon;
grant execute on function public.effective_interval_minutes(uuid) to authenticated, service_role;

create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  where l.active and w.active
    and (l.claimed_until is null or l.claimed_until < now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => public.effective_interval_minutes(l.household_id)) + interval '10 minutes'
    )
$$;

-- The tick also wakes the function when a deferred (quiet-hours) push summary can now be sent.
create or replace function public.invoke_fetch_prices() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_req bigint;
begin
  if not exists (select 1 from public.due_link_ids() limit 1)
     and not exists (
       select 1 from public.alert_events a join public.households h on h.id = a.household_id
       where a.push_deferred and not a.push_sent
         and not public.in_quiet_hours(h.quiet_enabled, h.quiet_start, h.quiet_end, h.timezone)
     ) then
    return null;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'invoke_fetch_prices: vault secrets project_url / cron_secret missing';
    return null;
  end if;
  select net.http_post(
    url := v_url || '/functions/v1/fetch-prices',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 150000
  ) into v_req;
  return v_req;
end $$;

-- ---------------------------------------------------------------------------
-- Views: delivery fee on series; purchase info and best offer's delivery fee on items
-- ---------------------------------------------------------------------------
drop view public.v_wish_summary;
drop view public.v_series;

create view public.v_series with (security_invoker = true) as
with latest as (
  select distinct on (o.product_link_id, o.seller)
    o.product_link_id, o.seller, o.price_cents, o.ts, o.availability, o.lowest_30d_cents, o.shipping_cents
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
  lt.seller,
  coalesce(nullif(lt.seller, ''), s.name, s.domain) as seller_name,
  lt.price_cents,
  lt.ts,
  lt.availability,
  lt.lowest_30d_cents,
  lt.shipping_cents,
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
) al on true;
