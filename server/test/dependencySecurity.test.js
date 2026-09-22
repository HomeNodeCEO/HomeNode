import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

/** Verify the proxy trust resolver remains pinned to the patched release. */
function verifyPatchedProxyAddrResolution() {
  const installed = require("proxy-addr/package.json");

  assert.equal(packageJson.overrides?.["proxy-addr"], "2.0.8");
  assert.equal(packageLock.packages?.["node_modules/proxy-addr"]?.version, "2.0.8");
  assert.equal(installed.version, "2.0.8");
}

test("Express resolves the patched proxy-addr release", verifyPatchedProxyAddrResolution);
