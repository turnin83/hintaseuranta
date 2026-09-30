// push-test: POST (signed-in user) -> sends a test notification to all of the user's devices.
import { adminClient, CORS, json, userFromRequest } from "../_shared/http.ts";
import { pushToUsers } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const admin = adminClient();
  const user = await userFromRequest(req, admin);
  if (!user) return json({ error: "unauthorized" }, 401);

  try {
    const res = await pushToUsers(admin, [user.id], {
      title: "Testi-ilmoitus",
      body: "Ilmoitukset toimivat tällä laitteella.",
      url: "/#/settings",
      tag: "test",
    });
    return json(res);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
