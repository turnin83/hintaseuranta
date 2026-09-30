// Generates VAPID keys for Web Push.
//   node scripts/generate-vapid.ts
// Prints:
//   - VAPID_KEYS_JSON  -> Supabase secret (private! JWK pair, format of @negrel/webpush exportVapidKeys)
//   - VITE_VAPID_PUBLIC_KEY -> web/.env (public applicationServerKey, base64url raw P-256 point)
const { subtle } = globalThis.crypto;

const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await subtle.exportKey("jwk", keys.publicKey);
const privateJwk = await subtle.exportKey("jwk", keys.privateKey);
const raw = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
const b64url = Buffer.from(raw).toString("base64url");

console.log("# Supabase secret (keep private):");
console.log(`VAPID_KEYS_JSON='${JSON.stringify({ publicKey: publicJwk, privateKey: privateJwk })}'`);
console.log();
console.log("# web/.env (public):");
console.log(`VITE_VAPID_PUBLIC_KEY=${b64url}`);
