-- Scheduling: pg_cron ticks every 15 minutes; a tick only calls the Edge Function when some link is due.
-- "Due" depends on user_settings.fetch_interval_minutes (720 = 2x/day, 60 = hourly for BF week),
-- so the cadence is changed from the app's settings, not by editing the cron expression.
--
-- Requires two Vault secrets (see README):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<random string>', 'cron_secret');   -- same value as CRON_SECRET function secret

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- Links due for fetching (active link, active item, not claimed, interval elapsed with 10 min tolerance).
create function public.due_link_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select l.id
  from public.product_links l
  join public.wish_items w on w.id = l.wish_item_id
  left join public.user_settings us on us.user_id = l.user_id
  where l.active and w.active
    and (l.claimed_until is null or l.claimed_until < now())
    and (
      l.last_fetched_at is null
      or l.last_fetched_at < now() - make_interval(mins => coalesce(us.fetch_interval_minutes, 720)) + interval '10 minutes'
    )
$$;

-- Atomically claim up to max_links due links (oldest first) for one fetch run.
create function public.claim_due_links(max_links int default 150)
returns setof public.product_links
language sql security definer set search_path = '' as $$
  update public.product_links l
  set claimed_until = now() + interval '10 minutes'
  where l.id in (
    select l2.id
    from public.product_links l2
    where l2.id in (select public.due_link_ids())
    order by l2.last_fetched_at nulls first
    limit max_links
    for update skip locked
  )
  returning l.*;
$$;

create function public.invoke_fetch_prices() returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
  v_req bigint;
begin
  if not exists (select 1 from public.due_link_ids() limit 1) then
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

revoke execute on function public.due_link_ids() from public, anon, authenticated;
revoke execute on function public.claim_due_links(int) from public, anon, authenticated;
revoke execute on function public.invoke_fetch_prices() from public, anon, authenticated;
grant execute on function public.due_link_ids() to service_role;
grant execute on function public.claim_due_links(int) to service_role;
grant execute on function public.invoke_fetch_prices() to service_role;

select cron.schedule('fetch-prices-tick', '*/15 * * * *', $$select public.invoke_fetch_prices()$$);

-- Housekeeping: keep pg_cron / pg_net logs small on the free tier.
select cron.schedule(
  'cleanup-logs',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days';
    delete from net._http_response where created < now() - interval '2 days';$$
);
