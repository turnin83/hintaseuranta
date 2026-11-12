-- hintaopas.fi now keeps the sellers it shares with hinta.fi (fetch-prices dropDuplicateSellers). Until
-- now the older link won, usually hinta.fi, and while hinta.fi is paused those shops (Gigantti, Hobby Hall,
-- Proshop, ...) were missing. Give the hintaopas links back the sellers that hinta.fi followed; ones that
-- hintaopas does not list, or that the item follows directly, are dropped again on its next fetch.
with hf as (
  select l.wish_item_id, array_agg(distinct o.seller) as sellers
  from public.price_observations o
  join public.product_links l on l.id = o.product_link_id
  join public.shops s on s.id = l.shop_id
  where s.domain = 'hinta.fi' and o.seller not in ('', '#history') and o.ts > now() - interval '30 days'
  group by 1
)
update public.product_links ho
set sellers = (select array_agg(distinct x order by x) from unnest(ho.sellers || hf.sellers) as x)
from public.shops s, hf
where s.id = ho.shop_id and s.domain = 'hintaopas.fi' and ho.active and ho.sellers is not null
  and hf.wish_item_id = ho.wish_item_id;
