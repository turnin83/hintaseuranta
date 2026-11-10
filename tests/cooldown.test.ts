// Pause after a site's block (hinta.fi "Pääsy rajoitettu"): length, escalation and the user's message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownMessage, isCoolingDown, nextCooldown } from "../supabase/functions/_shared/cooldown.ts";

const H = 3_600_000;
const now = Date.parse("2026-11-10T12:00:00Z");

test("first block pauses 6 hours", () => {
  assert.deepEqual(nextCooldown(null, now), { untilMs: now + 6 * H, hits: 1 });
});

test("a repeat block soon after the pause doubles it, up to 48 hours", () => {
  const prev = { until: new Date(now - 2 * H).toISOString(), hits: 1 };
  assert.deepEqual(nextCooldown(prev, now), { untilMs: now + 12 * H, hits: 2 });
  assert.equal(nextCooldown({ ...prev, hits: 5 }, now).untilMs, now + 48 * H);
});

test("a block long after the previous pause starts over", () => {
  const prev = { until: new Date(now - 72 * H).toISOString(), hits: 4 };
  assert.deepEqual(nextCooldown(prev, now), { untilMs: now + 6 * H, hits: 1 });
});

test("cooling down only until the end time", () => {
  const c = { domain: "hinta.fi", until: new Date(now + H).toISOString(), hits: 1, reason: null };
  assert.equal(isCoolingDown(c, now), true);
  assert.equal(isCoolingDown(c, now + 2 * H), false);
  assert.equal(isCoolingDown(null, now), false);
});

test("message names the site and the Finnish end time", () => {
  const today = cooldownMessage("hinta.fi", "2026-11-10T16:30:00Z", now);
  assert.match(today, /^hinta\.fi on rajoittanut hakuja tilapäisesti/);
  assert.match(today, /klo 18\.30 jälkeen/);
  assert.doesNotMatch(today, /11\.11\./);
  assert.match(cooldownMessage("hinta.fi", "2026-11-11T08:00:00Z", now), /11\.11\. klo 10\.00 jälkeen/);
});
