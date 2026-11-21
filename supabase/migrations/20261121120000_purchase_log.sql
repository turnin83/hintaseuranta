-- Purchases get their own log, so that an item can go back on the wish list (to buy again) without losing
-- what was bought and saved. wish_items.purchased_* stays the item's open purchase (bought, not on the list).
create table public.purchases (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.my_household() references public.households on delete cascade,
  wish_item_id uuid not null references public.wish_items on delete cascade,
  purchased_at timestamptz not null,
  price_cents int not null check (price_cents > 0), -- per piece
  qty int not null default 1 check (qty between 1 and 999),
  seller text,
  ref_cents int check (ref_cents > 0), -- usual price per piece when bought
  created_at timestamptz not null default now(),
  unique (wish_item_id, purchased_at)
);
create index purchases_household_idx on public.purchases (household_id, purchased_at desc);
alter table public.purchases enable row level security;
create policy "household purchases" on public.purchases for all to authenticated
  using (household_id = (select public.my_household()))
  with check (household_id = (select public.my_household()));

insert into public.purchases (household_id, wish_item_id, purchased_at, price_cents, qty, seller, ref_cents)
select w.household_id, w.id, w.purchased_at, w.purchased_price_cents, w.purchased_qty, w.purchased_seller, w.purchased_ref_cents
from public.wish_items w
where w.purchased_at is not null and w.purchased_price_cents is not null;

-- The item and its log row change together. Security invoker: row level security applies.
create function public.mark_purchased(p_item uuid, p_at timestamptz, p_price int, p_qty int, p_seller text, p_ref int)
returns void language plpgsql set search_path = '' as $$
begin
  update public.wish_items
  set purchased_at = p_at, purchased_price_cents = p_price, purchased_qty = p_qty,
      purchased_seller = p_seller, purchased_ref_cents = p_ref, active = false
  where id = p_item;
  if not found then raise exception 'item not found'; end if;
  insert into public.purchases (household_id, wish_item_id, purchased_at, price_cents, qty, seller, ref_cents)
  select w.household_id, w.id, p_at, p_price, p_qty, p_seller, p_ref from public.wish_items w where w.id = p_item
  on conflict (wish_item_id, purchased_at) do update
    set price_cents = excluded.price_cents, qty = excluded.qty, seller = excluded.seller, ref_cents = excluded.ref_cents;
end $$;

-- Quantity and usual price of the open purchase.
create function public.update_purchase(p_item uuid, p_qty int, p_ref int)
returns void language sql set search_path = '' as $$
  update public.purchases p set qty = p_qty, ref_cents = p_ref
  from public.wish_items w
  where w.id = p_item and p.wish_item_id = w.id and p.purchased_at = w.purchased_at;
  update public.wish_items set purchased_qty = p_qty, purchased_ref_cents = p_ref where id = p_item;
$$;

-- p_keep = true: buy again (the purchase stays in the log). false: returned / a mistake (the purchase goes).
create function public.reopen_item(p_item uuid, p_keep boolean)
returns void language sql set search_path = '' as $$
  delete from public.purchases p
  using public.wish_items w
  where not p_keep and w.id = p_item and p.wish_item_id = w.id and p.purchased_at = w.purchased_at;
  update public.wish_items
  set purchased_at = null, purchased_price_cents = null, purchased_seller = null, purchased_ref_cents = null,
      purchased_qty = 1, active = true
  where id = p_item;
$$;

revoke execute on function public.mark_purchased(uuid, timestamptz, int, int, text, int) from public, anon;
revoke execute on function public.update_purchase(uuid, int, int) from public, anon;
revoke execute on function public.reopen_item(uuid, boolean) from public, anon;
grant execute on function public.mark_purchased(uuid, timestamptz, int, int, text, int) to authenticated;
grant execute on function public.update_purchase(uuid, int, int) to authenticated;
grant execute on function public.reopen_item(uuid, boolean) to authenticated;

-- Bought items are no longer dropped after 30 days: they are fetched once a day from then on, so the price
-- history goes on for a later purchase. During the 30 days (return right) the normal interval holds.
create or replace function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  join public.shops s on s.id = l.shop_id
  where l.active
    and w.deleted_at is null
    and (w.active or w.purchased_at is not null)
    and (l.claimed_until is null or l.claimed_until < now())
    and not exists (select 1 from public.host_cooldowns c where c.domain = s.domain and c.until > now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => greatest(
           public.effective_interval_minutes(l.household_id),
           case when s.domain = 'hinta.fi' then 360 when s.strategy = 'aggregator' then 240 else 0 end,
           case when w.purchased_at is not null and w.purchased_at < now() - interval '30 days' then 1440 else 0 end
         )) + interval '10 minutes'
    )
$$;
