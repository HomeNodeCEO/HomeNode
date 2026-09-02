import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createNeighborhoodRouter } from "../src/modules/accounts/neighborhoodRouter.js";

const pool = { query: async () => ({ rows: [] }) };

function options(overrides = {}) {
  return {
    pool,
    ensureAvailable: async () => {},
    resolveAccountId: async (_pool, accountId) => `canonical-${accountId}`,
    normalizeFileId: (value) => value ? `file-${value}` : null,
    getReadiness: async () => ({}),
    getBoundary: async () => null,
    generateBoundary: async () => null,
    reviewBoundary: async () => null,
    getRelevance: async () => null,
    generateRelevance: async () => null,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("neighborhood readiness waits for local schemas and preserves county selection", async (context) => {
  const calls = [];
  const readiness = { ready: true, candidate_count: 12 };
  const server = await startRouter(createNeighborhoodRouter(options({
    ensureAvailable: async () => { calls.push("ensure"); },
    getReadiness: async (receivedPool, input) => {
      calls.push([receivedPool, input]);
      return readiness;
    },
  })));
  context.after(server.close);

  const selected = await fetch(`${server.baseUrl}/api/neighborhood-engine/readiness?county=Collin`);
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), readiness);
  const defaults = await fetch(`${server.baseUrl}/api/neighborhood-engine/readiness`);
  assert.equal(defaults.status, 200);
  assert.deepEqual(calls, [
    "ensure",
    [pool, { county: "Collin" }],
    "ensure",
    [pool, { county: "Dallas" }],
  ]);
});

test("neighborhood readiness maps unsupported counties and hides diagnostics", async (context) => {
  const logs = [];
  const server = await startRouter(createNeighborhoodRouter(options({
    getReadiness: async (_pool, { county }) => {
      throw new Error(county === "Unknown"
        ? "neighborhood_engine_county_not_configured"
        : "database_diagnostic");
    },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const unsupported = await fetch(
    `${server.baseUrl}/api/neighborhood-engine/readiness?county=Unknown`,
  );
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await unsupported.json(), {
    error: "neighborhood_engine_county_not_configured",
  });
  const failed = await fetch(`${server.baseUrl}/api/neighborhood-engine/readiness?county=Dallas`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "neighborhood_engine_readiness_failed" });
  assert.equal(logs.length, 2);
});

test("boundary reads preserve canonical account and assignment scope", async (context) => {
  const inputs = [];
  const assessment = { assessment_id: "boundary-1" };
  const server = await startRouter(createNeighborhoodRouter(options({
    getBoundary: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/%2042%20/neighborhood-boundary?assignment_file_id=7`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account_id: "canonical-42", assessment });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
  }]]);
});

test("boundary generation preserves the independent discovery-radius control", async (context) => {
  const inputs = [];
  const assessment = { assessment_id: "boundary-2" };
  const server = await startRouter(createNeighborhoodRouter(options({
    generateBoundary: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/42/neighborhood-boundary/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignment_file_id: "7",
        search_profile: "complex",
        discovery_radius_miles: 18,
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    searchProfileKey: "complex",
    discoveryRadiusMiles: 18,
  }]]);
});

test("boundary review preserves appraiser confirmation inputs", async (context) => {
  const inputs = [];
  const assessment = { review_status: "confirmed" };
  const server = await startRouter(createNeighborhoodRouter(options({
    reviewBoundary: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/42/neighborhood-boundary/boundary-2`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignment_file_id: "7",
        confirmed: true,
        reviewer: "Appraiser",
        notes: "Verified against market evidence",
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assessmentId: "boundary-2",
    assignmentFileId: "file-7",
    confirmed: true,
    reviewer: "Appraiser",
    notes: "Verified against market evidence",
  }]]);
});

test("relevance read and generation preserve boundary lineage", async (context) => {
  const inputs = [];
  const assessment = { assessment_id: "relevance-1" };
  const server = await startRouter(createNeighborhoodRouter(options({
    getRelevance: async (receivedPool, input) => {
      inputs.push(["get", receivedPool, input]);
      return assessment;
    },
    generateRelevance: async (receivedPool, input) => {
      inputs.push(["generate", receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const read = await fetch(
    `${server.baseUrl}/api/accounts/42/neighborhood-relevance?assignment_file_id=7`,
  );
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { account_id: "canonical-42", assessment });

  const generated = await fetch(
    `${server.baseUrl}/api/accounts/42/neighborhood-relevance/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignment_file_id: "7",
        boundary_assessment_id: "boundary-2",
      }),
    },
  );
  assert.equal(generated.status, 200);
  assert.deepEqual(await generated.json(), {
    ok: true,
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(inputs, [
    ["get", pool, { accountId: "canonical-42", assignmentFileId: "file-7" }],
    ["generate", pool, {
      accountId: "canonical-42",
      assignmentFileId: "file-7",
      boundaryAssessmentId: "boundary-2",
    }],
  ]);
});

test("neighborhood routes retain stable client, not-found, and unavailable statuses", async (context) => {
  const logs = [];
  const server = await startRouter(createNeighborhoodRouter(options({
    getBoundary: async () => { throw new Error("invalid_assignment_file"); },
    generateBoundary: async () => { throw new Error("subject_parcel_geometry_unavailable"); },
    reviewBoundary: async () => { throw new Error("neighborhood_boundary_assessment_not_found"); },
    getRelevance: async () => { throw new Error("account_not_found"); },
    generateRelevance: async () => {
      throw new Error("neighborhood_relevance_candidates_unavailable");
    },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const requests = [
    ["GET", "/api/accounts/42/neighborhood-boundary", 400, "invalid_assignment_file"],
    ["POST", "/api/accounts/42/neighborhood-boundary/generate", 404,
      "subject_parcel_geometry_unavailable"],
    ["PATCH", "/api/accounts/42/neighborhood-boundary/boundary-2", 404,
      "neighborhood_boundary_assessment_not_found"],
    ["GET", "/api/accounts/42/neighborhood-relevance", 404, "account_not_found"],
    ["POST", "/api/accounts/42/neighborhood-relevance/generate", 422,
      "neighborhood_relevance_candidates_unavailable"],
  ];
  for (const [method, path, status, error] of requests) {
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      ...(method === "GET" ? {} : {
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    });
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(logs.length, 2);
});

test("neighborhood router validates composition and remains between context mounts", () => {
  assert.throws(() => createNeighborhoodRouter(), /neighborhood_router_pool_required/);
  assert.throws(
    () => createNeighborhoodRouter(options({ ensureAvailable: null })),
    /neighborhood_router_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const status = source.indexOf("app.use(createPropertyContextStatusRouter(");
  const neighborhood = source.indexOf("app.use(createNeighborhoodRouter(");
  const accountContext = source.indexOf("app.use(createAccountPropertyContextRouter(");
  assert.ok(status > 0);
  assert.ok(neighborhood > status);
  assert.ok(accountContext > neighborhood);
  assert.equal(source.includes('app.get("/api/neighborhood-engine/readiness"'), false);
  assert.equal(source.includes('app.get("/api/accounts/:id/neighborhood-boundary"'), false);
  assert.equal(
    source.includes('app.post("/api/accounts/:id/neighborhood-boundary/generate"'),
    false,
  );
  assert.equal(source.includes('app.get("/api/accounts/:id/neighborhood-relevance"'), false);
});
