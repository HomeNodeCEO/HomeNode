import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUadSmokeBaseUrl,
  runUadStagingSmoke,
} from "../src/modules/uad/uadStagingSmoke.js";

function response(body, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return name.toLowerCase() === "content-type" ? contentType : null; } },
    async json() { return body; },
    async text() { return String(body); },
  };
}

test("accepts HTTPS and local HTTP staging URLs without credentials or query strings", () => {
  assert.equal(normalizeUadSmokeBaseUrl("https://staging.example.com/"), "https://staging.example.com");
  assert.equal(normalizeUadSmokeBaseUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
  assert.throws(() => normalizeUadSmokeBaseUrl("http://staging.example.com"), /invalid_uad_staging_base_url/);
  assert.throws(() => normalizeUadSmokeBaseUrl("https://user:secret@staging.example.com"), /invalid_uad_staging_base_url/);
  assert.throws(() => normalizeUadSmokeBaseUrl("https://staging.example.com/api"), /invalid_uad_staging_base_url/);
  assert.throws(() => normalizeUadSmokeBaseUrl("https://staging.example.com?token=secret"), /invalid_uad_staging_base_url/);
});

test("verifies health, release, storage, readiness, and the synthetic SFR fixture", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith("/health")) return response({ ok: true });
    if (url.endsWith("/api/uad/capabilities")) return response({
      enabled: true,
      specification_release_key: "uad-3.6-2026-08-13-h1.5",
      object_storage: { provider: "r2", configured: true },
      xml: { mapped_total: 857 },
    });
    if (url.endsWith("/api/uad/readiness")) return response({
      ok: true,
      status: "ready",
      local_delivery_ready: true,
      specification_release_key: "uad-3.6-2026-08-13-h1.5",
      blockers: [],
      checks: {
        compliance: {
          providers: {
            fannie: { enabled: false, configured: false, environment: "acpt", ready: false },
          },
        },
      },
    });
    if (url.includes("/api/uad/accounts/")) return response({ workfiles: [{ id: "fixture" }] });
    if (url.includes("/uad-3.6/")) return response('<div id="root"></div>', 200, "text/html; charset=utf-8");
    throw new Error("unexpected request");
  };

  const result = await runUadStagingSmoke({
    baseUrl: "https://staging.example.com",
    appUrl: "https://app-staging.example.com",
    fetchImpl,
    checkedAt: "2026-08-21T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.capabilities.mapped_field_count, 857);
  assert.equal(result.checks.synthetic_fixture.workfile_count, 1);
  assert.equal(result.checks.external_compliance.ready, false);
  assert.equal(result.checks.web_app.ready, true);
  assert.equal(requested.length, 5);
});

test("can require external compliance without exposing response bodies", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return response({ ok: true });
    if (url.endsWith("/api/uad/capabilities")) return response({
      enabled: true,
      specification_release_key: "uad-3.6-2026-08-13-h1.5",
      object_storage: { configured: true },
      xml: { mapped_total: 857 },
    });
    if (url.endsWith("/api/uad/readiness")) return response({
      ok: true,
      local_delivery_ready: true,
      specification_release_key: "uad-3.6-2026-08-13-h1.5",
      checks: { compliance: { providers: {} } },
    });
    return response({ workfiles: [{ id: "fixture" }] });
  };
  const result = await runUadStagingSmoke({
    baseUrl: "https://staging.example.com",
    fetchImpl,
    requireCompliance: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.external_compliance.required, true);
});
