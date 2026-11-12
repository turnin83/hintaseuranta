-- Two fixes for hinta.fi's Singles Day block were made in parallel (20261110120000_host_cooldowns and
-- 20261112090000_shop_backoff). host_cooldowns is the one pause from here on; comparison sites are paced.

-- The pause set by 20261112090000 (shops.blocked_until) moves to host_cooldowns.
insert into public.host_cooldowns (domain, until, hits, reason)
select s.domain, max(s.blocked_until), 3, 'Singles Day 2026: blocked the server'
from public.shops s
where s.blocked_until > now()
group by s.domain
on conflict (domain) do update
  set until = greatest(public.host_cooldowns.until, excluded.until),
      hits = greatest(public.host_cooldowns.hits, excluded.hits),
      updated_at = now();

-- Comparison sites (one page lists many shops) are asked less often than shops, campaigns included:
-- hinta.fi at most every 6 h (it banned us), the others every 4 h. A paused site is not asked at all.
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
      or l.last_fetched_at < now() - make_interval(mins => greatest(
           public.effective_interval_minutes(l.household_id),
           case when s.domain = 'hinta.fi' then 360 when s.strategy = 'aggregator' then 240 else 0 end
         )) + interval '10 minutes'
    )
$$;

-- Batches instead of bursts: one run claims at most 3 hinta.fi links and 5 of another comparison site,
-- oldest first, so their requests spread over the 15-minute ticks. Shops' own links are not limited.
-- (A window function cannot be combined with FOR UPDATE; the claimed_until check in the UPDATE keeps two
-- overlapping runs from taking the same link.)
create or replace function public.claim_due_links(max_links int default 150)
returns setof public.product_links
language sql security definer set search_path = '' as $$
  with due as (
    select l.id, l.last_fetched_at,
      row_number() over (partition by l.shop_id order by l.last_fetched_at nulls first, l.id) as nth,
      case when s.domain = 'hinta.fi' then 3 when s.strategy = 'aggregator' then 5 end as per_run
    from public.product_links l
    join public.shops s on s.id = l.shop_id
    where l.id in (select public.due_link_ids())
  ), picked as (
    select id from due
    where per_run is null or nth <= per_run
    order by last_fetched_at nulls first
    limit max_links
  )
  update public.product_links l
  set claimed_until = now() + interval '10 minutes'
  where l.id in (select id from picked)
    and (l.claimed_until is null or l.claimed_until < now())
  returning l.*;
$$;
