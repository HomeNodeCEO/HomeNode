import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUadSmokeBaseUrl,
  runUadStagingSmoke,
  uadStagingSmokeInternals,
} from "../src/modules/uad/uadStagingSmoke.js";

function response(body, status = 200, contentType = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function readyResponse(url) {
  if (url.endsWith("/health")) return response({ ok: true });
  if (url.endsWith("/api/uad/capabilities")) return response({
    enabled: true,
    specification_release_key: "uad-3.6-2026-08-13-h1.5",
    object_storage: { provider: "r2", configured: true },
    xml: { mapped_total_unique_ids: 857 },
  });
  if (url.endsWith("/api/uad/readiness")) return response({
    ok: true,
    status: "ready",
    local_delivery_ready: true,
    specification_release_key: "uad-3.6-2026-08-13-h1.5",
    blockers: [],
    checks: { compliance: { providers: {} } },
  });
  if (url.includes("/api/uad/accounts/")) return response({ workfiles: [{ id: "fixture" }] });
  if (url.includes("/uad-3.6/")) {
    return response('<div id="root"></div>', 200, "text/html; charset=utf-8");
  }
  throw new Error("unexpected request");
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
  const fetchImpl = async (url, init) => {
    requested.push(url);
    assert.equal(init.redirect, "error");
    assert.equal(init.signal instanceof AbortSignal, true);
    return readyResponse(url);
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
  const result = await runUadStagingSmoke({
    baseUrl: "https://staging.example.com",
    fetchImpl: async (url) => readyResponse(url),
    requireCompliance: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.external_compliance.required, true);
});

test("bounds and cancels oversized JSON and HTML responses", async () => {
  const cases = [
    {
      matches: (url) => url.endsWith("/api/uad/capabilities"),
      check: "capabilities",
      maximum: uadStagingSmokeInternals.MAX_JSON_RESPONSE_BYTES,
      contentType: "application/json",
    },
    {
      matches: (url) => url.includes("/uad-3.6/"),
      check: "web_app",
      maximum: uadStagingSmokeInternals.MAX_HTML_RESPONSE_BYTES,
      contentType: "text/html",
    },
  ];
  for (const fixture of cases) {
    let cancelled = false;
    const fetchImpl = async (url) => {
      if (!fixture.matches(url)) return readyResponse(url);
      return new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), {
        headers: {
          "content-length": String(fixture.maximum + 1),
          "content-type": fixture.contentType,
        },
      });
    };
    const result = await runUadStagingSmoke({
      baseUrl: "https://staging.example.com",
      appUrl: "https://app-staging.example.com",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks[fixture.check].error_code, "response_too_large");
    assert.equal(cancelled, true);
  }
});

test("keeps the timeout active through stalled response bodies", async () => {
  let aborted = false;
  let keepAlive;
  const fetchImpl = async (url, init) => {
    if (!url.endsWith("/api/uad/capabilities")) return readyResponse(url);
    return new Response(new ReadableStream({
      start(controller) {
        keepAlive = setTimeout(() => {}, 1_500);
        init.signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(keepAlive);
          controller.error(new Error("private staging transport detail"));
        }, { once: true });
      },
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await runUadStagingSmoke({
      baseUrl: "https://staging.example.com",
      fetchImpl,
      timeoutMs: 1_000,
    });
    assert.equal(aborted, true);
    assert.equal(result.ok, false);
    assert.equal(result.checks.capabilities.error_code, "request_failed");
    assert.equal(JSON.stringify(result).includes("private staging transport detail"), false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("cancels invalid and unsuccessful response bodies with stable diagnostics", async () => {
  for (const fixture of [
    {
      matches: (url) => url.endsWith("/api/uad/capabilities"),
      check: "capabilities",
      status: 503,
      contentType: "application/json",
      errorCode: "http_error",
    },
    {
      matches: (url) => url.endsWith("/api/uad/capabilities"),
      check: "capabilities",
      status: 200,
      contentType: "text/html",
      errorCode: "invalid_content_type",
    },
    {
      matches: (url) => url.includes("/uad-3.6/"),
      check: "web_app",
      status: 200,
      contentType: "application/json",
      errorCode: "invalid_content_type",
    },
    {
      matches: (url) => url.includes("/uad-3.6/"),
      check: "web_app",
      status: 503,
      contentType: "text/html",
      errorCode: "http_error",
    },
  ]) {
    let cancelled = false;
    const fetchImpl = async (url) => {
      if (!fixture.matches(url)) return readyResponse(url);
      return new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), {
        status: fixture.status,
        headers: { "content-type": fixture.contentType },
      });
    };
    const result = await runUadStagingSmoke({
      baseUrl: "https://staging.example.com",
      appUrl: "https://app-staging.example.com",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks[fixture.check].error_code, fixture.errorCode);
    assert.equal(cancelled, true);
  }
});
