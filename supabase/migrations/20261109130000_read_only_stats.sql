-- The CLI's read-only role (diagnostics) reads v_wish_summary, which calls item_price_stats.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    grant execute on function public.item_price_stats(uuid, timestamptz) to supabase_read_only_user;
  end if;
end $$;
