// Run the probe locally: node scripts/probe-local.ts <url> [<url> ...]
import { probe } from "../supabase/functions/_shared/probe.ts";
import { createRobotsCache } from "../supabase/functions/_shared/fetcher.ts";

const robots = createRobotsCache();
for (const url of process.argv.slice(2)) {
  console.log(JSON.stringify(await probe(url, robots), null, 2));
  await new Promise((r) => setTimeout(r, 1500));
}
