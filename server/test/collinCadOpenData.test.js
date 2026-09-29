import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCollinCadCrosswalkStats,
  fetchCollinCadPage,
} from "../src/services/collinCadOpenData.js";

const datasetId = "nne4-8riu";

test("Collin CAD page requests remain scoped and bounded", async () => {
  let requestedUrl;
  let requestedOptions;
  const rows = await fetchCollinCadPage({
    datasetId,
    appToken: "test-token",
    offset: 25,
    limit: 10,
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestedOptions = options;
      return new Response(JSON.stringify([{ propid: "123", geoid: "R-123" }]));
    },
  });
  assert.deepEqual(rows, [{ propid: "123", geoid: "R-123" }]);
  assert.equal(requestedUrl.origin, "https://data.texas.gov");
  assert.equal(requestedUrl.pathname, "/resource/nne4-8riu.json");
  assert.equal(requestedUrl.searchParams.get("$select"), "propid,geoid,situsconcat,propyear");
  assert.equal(requestedUrl.searchParams.get("$where"), "propid is not null and geoid like 'R%'");
  assert.equal(requestedUrl.searchParams.get("$order"), "propid");
  assert.equal(requestedUrl.searchParams.get("$limit"), "10");
  assert.equal(requestedUrl.searchParams.get("$offset"), "25");
  assert.equal(requestedOptions.headers["X-App-Token"], "test-token");
  assert.equal(requestedOptions.redirect, "error");
  assert.equal(requestedOptions.signal instanceof AbortSignal, true);
});

test("Collin CAD rejects oversized, malformed, and stalled pages", async () => {
  await assert.rejects(fetchCollinCadPage({
    datasetId, offset: 0, limit: 10,
    fetchImpl: async () => new Response("upstream details", { status: 503 }),
  }), /collin_cad_open_data_503/);
  await assert.rejects(fetchCollinCadPage({
    datasetId, offset: 0, limit: 10,
    fetchImpl: async () => { throw new Error("token=private"); },
  }), /collin_cad_open_data_unavailable/);
  await assert.rejects(fetchCollinCadPage({
    datasetId, offset: 0, limit: 10, maximumBytes: 8,
    fetchImpl: async () => new Response("[]", { headers: { "content-length": "1024" } }),
  }), /collin_cad_open_data_response_too_large/);
  await assert.rejects(fetchCollinCadPage({
    datasetId, offset: 0, limit: 10,
    fetchImpl: async () => new Response("{invalid"),
  }), /collin_cad_open_data_invalid_response/);
  await assert.rejects(fetchCollinCadPage({
    datasetId, offset: 0, limit: 10, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  }), /collin_cad_open_data_timeout/);
  await assert.rejects(fetchCollinCadPage({
    datasetId: "bad/path", offset: 0, limit: 10,
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }), /collin_cad_dataset_invalid/);
});

test("Collin CAD stats require one complete bounded count row", async () => {
  const stats = await fetchCollinCadCrosswalkStats({
    datasetId,
    fetchImpl: async () => new Response(JSON.stringify([{
      total: "12", distinct_propid: "12", distinct_geoid: "12",
    }])),
  });
  assert.deepEqual(stats, { total: 12, distinctPropertyIds: 12, distinctGeoIds: 12 });
  await assert.rejects(fetchCollinCadCrosswalkStats({
    datasetId,
    fetchImpl: async () => new Response(JSON.stringify([{}])),
  }), /collin_cad_open_data_stats_invalid_response/);
  await assert.rejects(fetchCollinCadCrosswalkStats({
    datasetId, maximumBytes: 8,
    fetchImpl: async () => new Response("[]", { headers: { "content-length": "1024" } }),
  }), /collin_cad_open_data_stats_response_too_large/);
});
