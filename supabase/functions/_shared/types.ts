// Shared types. Runtime-agnostic (Deno Edge Functions + Node tests).

export type Availability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "backorder"
  | "limited"
  | "unknown";

export type Offer = {
  seller: string | null; // null = the shop itself (direct link)
  priceCents: number | null;
  currency: string | null;
  availability: Availability;
  // Shop-reported comparison price ("alin hinta 30 pv" / original price in a campaign)
  lowest30dCents: number | null;
};

export type PageData = {
  kind: "shop" | "aggregator";
  source: string; // "jsonld" | "adapter:<name>"
  name: string | null;
  ean: string | null;
  model: string | null;
  sku: string | null;
  image: string | null;
  offers: Offer[];
};

export type FetchStrategy = "direct" | "aggregator" | "blocked";
