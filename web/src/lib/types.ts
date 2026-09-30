import type { Availability, PageData } from "@shared/types.ts";

export type WishSummary = {
  id: string;
  name: string;
  tags: string[];
  target_price_cents: number | null;
  priority: 1 | 2 | 3;
  active: boolean;
  notes: string | null;
  rules: unknown;
  created_at: string;
  best_seller: string | null;
  best_price_cents: number | null;
  best_url: string | null;
  best_availability: Availability | null;
  best_ts: string | null;
  min_all_cents: number | null;
  median_30d_cents: number | null;
  link_count: number;
  failing_links: number;
  last_fetched_at: string | null;
  unread_alerts: number;
};

export type Shop = {
  id: number;
  domain: string;
  name: string | null;
  strategy: "direct" | "aggregator" | "blocked";
  min_delay_ms: number;
  last_probe: { at: string; status: number | null; blocked: boolean; botMarkers: string[]; source: string | null; error: string | null } | null;
  last_ok_at: string | null;
  last_error: string | null;
  notes: string | null;
};

export type ProductLink = {
  id: string;
  wish_item_id: string;
  shop_id: number;
  url: string;
  model_name: string | null;
  ean: string | null;
  active: boolean;
  sellers: string[] | null;
  last_fetched_at: string | null;
  last_status: "ok" | "error" | "blocked" | "no_data" | null;
  last_error: string | null;
  created_at: string;
  shops?: Pick<Shop, "domain" | "name" | "strategy">;
};

export type Series = {
  product_link_id: string;
  wish_item_id: string;
  url: string;
  link_active: boolean;
  domain: string;
  seller: string;
  seller_name: string;
  price_cents: number;
  ts: string;
  availability: Availability;
  lowest_30d_cents: number | null;
  min_all: number;
  min_30d: number | null;
  median_30d: number | null;
  obs_count: number;
};

export type AlertEvent = {
  id: number;
  wish_item_id: string;
  product_link_id: string;
  seller: string;
  rule: string;
  level: "alert" | "info";
  price_cents: number;
  ref_cents: number | null;
  message: string;
  ts: string;
  read: boolean; // per signed-in user (v_alerts)
  item_name: string;
};

export type Household = { id: string; name: string; fetch_interval_minutes: number };

export type FetchRun = {
  id: number;
  trigger: "cron" | "manual";
  started_at: string;
  finished_at: string;
  ok_count: number;
  fail_count: number;
  alert_count: number;
  errors: { url: string; error: string }[];
};

export type Preview = {
  url: string;
  domain: string;
  shop: Shop | null;
  status: number | null;
  blocked: boolean;
  botMarkers: string[];
  robotsAllowed: boolean | null;
  error: string | null;
  page: PageData | null;
  suggestion: string | null;
};
