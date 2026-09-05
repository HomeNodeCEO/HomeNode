import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

const entrySource = await readFile(
  new URL("../src/features/uad/pages/UadWorkspaceEntry.tsx", import.meta.url),
  "utf8",
);
const apiSource = await readFile(new URL("../src/features/uad/api.ts", import.meta.url), "utf8");
assert.match(entrySource, /getAccount\(accountId\)/);
assert.doesNotMatch(entrySource, /getUadSubjectSummary/);
assert.doesNotMatch(apiSource, /public-cadastral|subject-summary/);

console.log(JSON.stringify({ ready: true, profile: "uad_browser_auth_bridge_v1" }));
