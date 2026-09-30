// probe: diagnostics from Supabase's own network (datacenter IPs).
// POST {"urls": ["https://..."]} with a signed-in user's JWT or the x-cron-secret header (admin diagnostics).
import { adminClient, CORS, isCronRequest, json, userFromRequest } from "../_shared/http.ts";
import { probe } from "../_shared/probe.ts";
import { createRobotsCache, sleep } from "../_shared/fetcher.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const admin = adminClient();
  if (!isCronRequest(req) && !(await userFromRequest(req, admin))) return json({ error: "unauthorized" }, 401);

  const { urls } = await req.json().catch(() => ({})) as { urls?: string[] };
  const robots = createRobotsCache();
  const results = [];
  for (const url of (urls ?? []).slice(0, 10)) {
    results.push(await probe(url, robots));
    await sleep(1500);
  }
  return json({ runtime: "supabase-edge", results });
});
