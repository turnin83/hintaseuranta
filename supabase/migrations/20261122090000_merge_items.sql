-- One product tracked twice (e.g. added again from another shop's page): merge the second item into the
-- first. Its links, price history, alerts and purchases move over and the second item is removed.
-- The same page on both items becomes one link: of the dropped link's history only the rows from before the
-- kept link's first reading move (per seller), so overlapping hours are not counted twice.
-- Security definer: observations and alert events are not writable by users; both items must belong to the
-- caller's household.
create function public.merge_items(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_household uuid := public.my_household();
  k public.wish_items;
  d public.wish_items;
  l public.product_links;
  v_same uuid;
begin
  if p_keep = p_drop then raise exception 'cannot merge an item with itself'; end if;
  select * into k from public.wish_items
    where id = p_keep and household_id = v_household and deleted_at is null for update;
  select * into d from public.wish_items
    where id = p_drop and household_id = v_household and deleted_at is null for update;
  if k.id is null or d.id is null then raise exception 'item not found'; end if;

  for l in select * from public.product_links where wish_item_id = p_drop loop
    select id into v_same from public.product_links where wish_item_id = p_keep and url = l.url;
    if v_same is null then
      update public.product_links set wish_item_id = p_keep where id = l.id;
    else
      update public.price_observations o set product_link_id = v_same
      where o.product_link_id = l.id
        and o.ts < coalesce(
          (select min(x.ts) from public.price_observations x where x.product_link_id = v_same and x.seller = o.seller),
          'infinity');
      update public.alert_events set product_link_id = v_same where product_link_id = l.id;
      update public.product_links kl set
        active = kl.active or l.active,
        sellers = case when kl.sellers is null or l.sellers is null then null
                       else array(select distinct s from unnest(kl.sellers || l.sellers) as s) end,
        ean = coalesce(kl.ean, l.ean),
        model_name = coalesce(kl.model_name, l.model_name)
      where kl.id = v_same;
      delete from public.product_links where id = l.id;
    end if;
  end loop;

  update public.alert_events set wish_item_id = p_keep where wish_item_id = p_drop;
  delete from public.purchases p
    where p.wish_item_id = p_drop
      and exists (select 1 from public.purchases q where q.wish_item_id = p_keep and q.purchased_at = p.purchased_at);
  update public.purchases set wish_item_id = p_keep where wish_item_id = p_drop;

  -- The kept item's settings win; what it lacks comes from the other one.
  update public.wish_items set
    target_price_cents = coalesce(k.target_price_cents, d.target_price_cents),
    priority = least(k.priority, d.priority),
    tags = array(
      select t from unnest(k.tags || d.tags) with ordinality as u(t, ord)
      group by t order by min(ord) limit 10),
    notes = nullif(concat_ws(E'\n', k.notes, d.notes), ''),
    rules = d.rules || k.rules
  where id = p_keep;

  delete from public.wish_items where id = p_drop;
end $$;

revoke execute on function public.merge_items(uuid, uuid) from public, anon;
grant execute on function public.merge_items(uuid, uuid) to authenticated;
