-- A shop that blocks us is left alone for a while instead of being asked again every 15 minutes
-- (hinta.fi blocked the server during Singles Day and every retry kept the block going).
-- fetch-prices sets these: 6 h after the first block, doubling up to 48 h while the block lasts.
alter table public.shops
  add column blocked_until timestamptz,
  add column block_count int not null default 0;

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
    and not exists (select 1 from public.shops s where s.id = l.shop_id and s.blocked_until > now())
$$;

-- hinta.fi has blocked us since 10.11.: give it a day's rest now (the next block means 48 h).
update public.shops
set block_count = 3, blocked_until = now() + interval '24 hours'
where domain = 'hinta.fi' and last_error like 'blocked:%';
