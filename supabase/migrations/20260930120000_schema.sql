-- Hintaseuranta: core schema + RLS.
-- Every table carries user_id; policies restrict rows to the signed-in user.
-- Edge Functions use the service role (bypasses RLS) and always set user_id explicitly.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  -- How often each link is fetched. 720 = twice a day; set 60 for Black Friday week.
  fetch_interval_minutes int not null default 720 check (fetch_interval_minutes between 30 and 10080),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Shops: one row per domain, with the fetch strategy that works for it.
-- ---------------------------------------------------------------------------
create table public.shops (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  domain text not null,                 -- e.g. 'verkkokauppa.com' (no www.)
  name text,                            -- display name, e.g. 'Verkkokauppa.com'
  strategy text not null default 'direct'
    check (strategy in ('direct', 'aggregator', 'blocked')),
  min_delay_ms int not null default 2000 check (min_delay_ms between 0 and 60000),
  last_probe jsonb,                     -- latest preview/probe diagnostics
  last_ok_at timestamptz,
  last_error text,
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, domain)
);

-- ---------------------------------------------------------------------------
-- Wish list
-- ---------------------------------------------------------------------------
create table public.wish_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(name) between 1 and 200),
  category text,
  target_price_cents int check (target_price_cents > 0),
  priority smallint not null default 2 check (priority between 1 and 3), -- 1 = high
  active boolean not null default true,
  notes text,
  rules jsonb not null default '{}'::jsonb,   -- overrides for DEFAULT_RULES (see _shared/rules.ts)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index wish_items_user_idx on public.wish_items (user_id, active);

create table public.product_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  wish_item_id uuid not null references public.wish_items on delete cascade,
  shop_id bigint not null references public.shops on delete restrict,
  url text not null,
  model_name text,
  ean text,
  active boolean not null default true,
  -- Aggregator links (hintaopas.fi, hinta.fi): which sellers to record. null = all sellers.
  sellers text[],
  last_fetched_at timestamptz,
  last_status text check (last_status in ('ok', 'error', 'blocked', 'no_data')),
  last_error text,
  fail_count int not null default 0,
  claimed_until timestamptz,            -- set while a fetch run owns the link
  created_at timestamptz not null default now(),
  unique (wish_item_id, url)
);
create index product_links_item_idx on public.product_links (wish_item_id);
create index product_links_due_idx on public.product_links (active, last_fetched_at);

-- ---------------------------------------------------------------------------
-- Observations. One row per (link, seller) per fetch. seller = '' for the shop itself.
-- ---------------------------------------------------------------------------
create table public.price_observations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  product_link_id uuid not null references public.product_links on delete cascade,
  seller text not null default '',
  ts timestamptz not null default now(),
  price_cents int not null check (price_cents > 0),
  currency text not null default 'EUR',
  availability text not null default 'unknown'
    check (availability in ('in_stock', 'out_of_stock', 'preorder', 'backorder', 'limited', 'unknown')),
  lowest_30d_cents int,                 -- shop-reported comparison price ("alin hinta 30 pv"), if any
  source text not null                  -- 'jsonld' | 'adapter:<name>'
);
create index price_obs_series_idx on public.price_observations (product_link_id, seller, ts desc);
create index price_obs_user_ts_idx on public.price_observations (user_id, ts desc);

-- ---------------------------------------------------------------------------
-- Alerts, runs, push subscriptions
-- ---------------------------------------------------------------------------
create table public.alert_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  wish_item_id uuid not null references public.wish_items on delete cascade,
  product_link_id uuid not null references public.product_links on delete cascade,
  seller text not null default '',
  rule text not null,
  level text not null default 'alert' check (level in ('alert', 'info')),
  price_cents int not null,
  ref_cents int,
  message text not null,
  ts timestamptz not null default now(),
  read boolean not null default false,
  push_sent boolean not null default false
);
create index alert_events_user_idx on public.alert_events (user_id, read, ts desc);
create index alert_events_cooldown_idx on public.alert_events (product_link_id, seller, rule, ts desc);

create table public.fetch_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  trigger text not null default 'cron' check (trigger in ('cron', 'manual')),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  ok_count int not null default 0,
  fail_count int not null default 0,
  alert_count int not null default 0,
  errors jsonb not null default '[]'::jsonb
);
create index fetch_runs_user_idx on public.fetch_runs (user_id, started_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  fail_count int not null default 0
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.user_settings enable row level security;
alter table public.shops enable row level security;
alter table public.wish_items enable row level security;
alter table public.product_links enable row level security;
alter table public.price_observations enable row level security;
alter table public.alert_events enable row level security;
alter table public.fetch_runs enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "own settings" on public.user_settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own shops" on public.shops for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own wish items" on public.wish_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Links may only point to the user's own wish item and shop.
create policy "own links" on public.product_links for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.wish_items w where w.id = wish_item_id and w.user_id = (select auth.uid()))
    and exists (select 1 from public.shops s where s.id = shop_id and s.user_id = (select auth.uid()))
  );

-- Observations and runs are written by Edge Functions only.
create policy "read own observations" on public.price_observations for select to authenticated
  using (user_id = (select auth.uid()));
create policy "delete own observations" on public.price_observations for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "read own alerts" on public.alert_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy "mark own alerts" on public.alert_events for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "delete own alerts" on public.alert_events for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "read own runs" on public.fetch_runs for select to authenticated
  using (user_id = (select auth.uid()));

create policy "own push subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Only the read flag of an alert is user-editable.
revoke update on public.alert_events from authenticated;
grant update (read) on public.alert_events to authenticated;

-- updated_at
create function public.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger wish_items_touch before update on public.wish_items
  for each row execute function public.touch_updated_at();
create trigger user_settings_touch before update on public.user_settings
  for each row execute function public.touch_updated_at();
