import assert from "node:assert/strict";

globalThis.window = {};

const { getUadAccessToken, withUadAuthorization } = await import("../src/features/uad/auth.ts");

assert.equal(await getUadAccessToken(), null);
assert.deepEqual(await withUadAuthorization({ method: "GET" }), { method: "GET" });

window.homenodeAuth = { getAccessToken: async () => "  synthetic.test.token  " };
assert.equal(await getUadAccessToken(), "synthetic.test.token");

const authorized = await withUadAuthorization({
  headers: { accept: "application/json" },
  method: "POST",
});
assert.equal(new Headers(authorized.headers).get("authorization"), "Bearer synthetic.test.token");
assert.equal(new Headers(authorized.headers).get("accept"), "application/json");

const explicit = await withUadAuthorization({ headers: { authorization: "Bearer explicit.token" } });
assert.equal(new Headers(explicit.headers).get("authorization"), "Bearer explicit.token");

window.homenodeAuth = { getAccessToken: () => "   " };
assert.equal(await getUadAccessToken(), null);

console.log(JSON.stringify({ ready: true, profile: "uad_browser_auth_bridge_v1" }));
