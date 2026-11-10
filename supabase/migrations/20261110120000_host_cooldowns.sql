-- hinta.fi bans the server's address when it asks too often ("Pääsy rajoitettu", HTTP 404). Every
-- request during the ban prolongs it, so after a block the site is left alone for a while.

-- Global (the ban is on the server's address, not on a household). Written by the Edge Functions.
create table public.host_cooldowns (
  domain text primary key,
  until timestamptz not null,
  hits int not null default 1,          -- blocks in a row; each one doubles the pause (6 h .. 48 h)
  reason text,
  updated_at timestamptz not null default now()
);
alter table public.host_cooldowns enable row level security;
create policy host_cooldowns_read on public.host_cooldowns for select to authenticated using (true);

-- Gentler pace on hinta.fi: at least 10 s between its pages.
update public.shops set min_delay_ms = 10000 where domain = 'hinta.fi' and min_delay_ms < 10000;

-- Due links: hinta.fi links at most every 6 hours (even during campaigns), and no links of a site that
-- is paused.
create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  join public.shops s on s.id = l.shop_id
  where l.active
    and w.deleted_at is null
    and (w.active or (w.purchased_at is not null and w.purchased_at > now() - interval '30 days'))
    and (l.claimed_until is null or l.claimed_until < now())
    and not exists (select 1 from public.host_cooldowns c where c.domain = s.domain and c.until > now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => case
           when s.domain = 'hinta.fi' then greatest(public.effective_interval_minutes(l.household_id), 360)
           else public.effective_interval_minutes(l.household_id)
         end) + interval '10 minutes'
    )
$$;
