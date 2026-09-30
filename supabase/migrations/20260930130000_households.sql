-- Shared households: all members see and edit the same wish list, links, history and alerts.
-- Access = membership. Users are created by the admin (dashboard, sign-ups disabled) and join the
-- household automatically. Alert read state and push subscriptions stay per user.

-- ---------------------------------------------------------------------------
-- Households & membership
-- ---------------------------------------------------------------------------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Koti',
  -- How often each link is fetched. 720 = twice a day; 60 for Black Friday week.
  fetch_interval_minutes int not null default 720 check (fetch_interval_minutes between 30 and 10080),
  created_at timestamptz not null default now()
);

create table public.household_members (
  user_id uuid primary key references auth.users on delete cascade, -- one household per user
  household_id uuid not null references public.households on delete cascade,
  email text,
  joined_at timestamptz not null default now()
);
create index household_members_household_idx on public.household_members (household_id);

create function public.my_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select household_id from public.household_members where user_id = auth.uid()
$$;
revoke execute on function public.my_household() from public, anon;
grant execute on function public.my_household() to authenticated, service_role;

-- New auth users join the first household (created on demand).
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_household uuid;
begin
  select id into v_household from public.households order by created_at limit 1;
  if v_household is null then
    insert into public.households default values returning id into v_household;
  end if;
  insert into public.household_members (household_id, user_id, email)
  values (v_household, new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill users that existed before this migration.
insert into public.households (name)
  select 'Koti' where exists (select 1 from auth.users) and not exists (select 1 from public.households);
insert into public.household_members (household_id, user_id, email)
  select (select id from public.households order by created_at limit 1), u.id, u.email
  from auth.users u
  on conflict (user_id) do nothing;

alter table public.households enable row level security;
alter table public.household_members enable row level security;

create policy "read own household" on public.households for select to authenticated
  using (id = (select public.my_household()));
create policy "update own household" on public.households for update to authenticated
  using (id = (select public.my_household())) with check (id = (select public.my_household()));
create policy "read household members" on public.household_members for select to authenticated
  using (household_id = (select public.my_household()));

-- ---------------------------------------------------------------------------
-- household_id on all shared tables (user_id stays as "created by")
-- ---------------------------------------------------------------------------
drop view public.v_wish_summary;
drop view public.v_series;

do $$
declare
  t text;
begin
  foreach t in array array['shops', 'wish_items', 'product_links', 'price_observations', 'alert_events', 'fetch_runs'] loop
    execute format('alter table public.%I add column household_id uuid references public.households on delete cascade', t);
    execute format(
      'update public.%I x set household_id = m.household_id from public.household_members m where m.user_id = x.user_id', t);
    execute format('alter table public.%I alter column household_id set not null', t);
    execute format('create index %I on public.%I (household_id)', t || '_household_idx', t);
  end loop;
end $$;

-- Client-created rows get the caller's household automatically.
alter table public.shops alter column household_id set default public.my_household();
alter table public.wish_items alter column household_id set default public.my_household();
alter table public.product_links alter column household_id set default public.my_household();

alter table public.shops drop constraint shops_user_id_domain_key;
alter table public.shops add constraint shops_household_domain_key unique (household_id, domain);

-- A cron run is not triggered by a user.
alter table public.fetch_runs alter column user_id drop not null;

-- Fetch cadence moves to the household.
drop table public.user_settings;

-- ---------------------------------------------------------------------------
-- Per-user read state for shared alerts
-- ---------------------------------------------------------------------------
alter table public.alert_events drop column read;

create table public.alert_reads (
  alert_id bigint not null references public.alert_events on delete cascade,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  read_at timestamptz not null default now(),
  primary key (alert_id, user_id)
);
alter table public.alert_reads enable row level security;
create policy "own alert reads" on public.alert_reads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.alert_events a where a.id = alert_id and a.household_id = (select public.my_household()))
  );

create function public.mark_alerts_read(p_wish_item uuid default null) returns int
language sql security invoker set search_path = '' as $$
  with ins as (
    insert into public.alert_reads (alert_id, user_id)
    select a.id, auth.uid()
    from public.alert_events a
    where (p_wish_item is null or a.wish_item_id = p_wish_item)
      and not exists (select 1 from public.alert_reads r where r.alert_id = a.id and r.user_id = auth.uid())
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins
$$;
revoke execute on function public.mark_alerts_read(uuid) from public, anon;
grant execute on function public.mark_alerts_read(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: household instead of user
-- ---------------------------------------------------------------------------
drop policy "own shops" on public.shops;
drop policy "own wish items" on public.wish_items;
drop policy "own links" on public.product_links;
drop policy "read own observations" on public.price_observations;
drop policy "delete own observations" on public.price_observations;
drop policy "read own alerts" on public.alert_events;
drop policy "mark own alerts" on public.alert_events;
drop policy "delete own alerts" on public.alert_events;
drop policy "read own runs" on public.fetch_runs;

create policy "household shops" on public.shops for all to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

create policy "household wish items" on public.wish_items for all to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

create policy "household links" on public.product_links for all to authenticated
  using (household_id = (select public.my_household()))
  with check (
    household_id = (select public.my_household())
    and exists (select 1 from public.wish_items w where w.id = wish_item_id and w.household_id = (select public.my_household()))
    and exists (select 1 from public.shops s where s.id = shop_id and s.household_id = (select public.my_household()))
  );

create policy "household observations read" on public.price_observations for select to authenticated
  using (household_id = (select public.my_household()));
create policy "household observations delete" on public.price_observations for delete to authenticated
  using (household_id = (select public.my_household()));

create policy "household alerts read" on public.alert_events for select to authenticated
  using (household_id = (select public.my_household()));
create policy "household alerts delete" on public.alert_events for delete to authenticated
  using (household_id = (select public.my_household()));
revoke update on public.alert_events from authenticated;

create policy "household runs read" on public.fetch_runs for select to authenticated
  using (household_id = (select public.my_household()));

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create view public.v_series with (security_invoker = true) as
with latest as (
  select distinct on (o.product_link_id, o.seller)
    o.product_link_id, o.seller, o.price_cents, o.ts, o.availability, o.lowest_30d_cents
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
  s.domain,
  lt.seller,
  coalesce(nullif(lt.seller, ''), s.name, s.domain) as seller_name,
  lt.price_cents,
  lt.ts,
  lt.availability,
  lt.lowest_30d_cents,
  st.min_all,
  st.min_30d,
  round(st.median_30d)::int as median_30d,
  st.obs_count
from latest lt
join stats st on st.product_link_id = lt.product_link_id and st.seller = lt.seller
join public.product_links l on l.id = lt.product_link_id
join public.shops s on s.id = l.shop_id;

-- Alerts with the caller's own read flag.
create view public.v_alerts with (security_invoker = true) as
select
  a.*,
  w.name as item_name,
  exists (select 1 from public.alert_reads r where r.alert_id = a.id and r.user_id = (select auth.uid())) as read
from public.alert_events a
join public.wish_items w on w.id = a.wish_item_id;

create view public.v_wish_summary with (security_invoker = true) as
select
  w.id,
  w.household_id,
  w.name,
  w.category,
  w.target_price_cents,
  w.priority,
  w.active,
  w.notes,
  w.rules,
  w.created_at,
  best.seller_name as best_seller,
  best.price_cents as best_price_cents,
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
  select v.seller_name, v.price_cents, v.url, v.availability, v.ts
  from public.v_series v
  where v.wish_item_id = w.id and v.link_active and v.ts > now() - interval '3 days'
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

-- ---------------------------------------------------------------------------
-- Scheduling reads the household cadence
-- ---------------------------------------------------------------------------
create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  join public.households h on h.id = l.household_id
  where l.active and w.active
    and (l.claimed_until is null or l.claimed_until < now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => h.fetch_interval_minutes) + interval '10 minutes'
    )
$$;
