import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createMobileRouter } from "../src/modules/mobile/router.js";

test("mobile endpoints reject requests beyond the configured client limit", async (t) => {
  const app = express();
  app.use("/api/mobile", createMobileRouter({
    pool: { query: async () => ({ rows: [] }) },
    verifier: { configured: false, verify: async () => { throw new Error("unused"); } },
    enabled: false,
    security: {
      apiRateLimitEnabled: true,
      apiRateLimitWindowMs: 60_000,
      apiRateLimitMax: 1,
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/mobile/capabilities`;

  const accepted = await fetch(url);
  assert.equal(accepted.status, 200);
  const blocked = await fetch(url);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "mobile_rate_limit_exceeded" });
});
