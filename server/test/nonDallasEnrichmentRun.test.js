import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  enrichNonDallasAccount,
  nonDallasEnrichmentFailureCode,
  runNonDallasEnrichmentBatch,
} from "../src/services/nonDallasEnrichmentWorker.js";

function accountEnrichmentFixture({
  failureStage = null, rollbackFails = false, rollbackThrows = false, releaseError,
  beforeRollback = () => undefined, beforeProvider = () => undefined,
  providerError = null, connectError = null,
} = {}) {
  const primaryError = new Error("private account write detail");
  const rollbackError = new Error("private rollback connection detail");
  const queries = [], statements = [], releases = [], events = [], providerCalls = [];
  let connections = 0;
  let injectedFailures = 0;
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.startsWith("INSERT INTO app.enrichment_runs")) return { rows: [{ id: 17 }] };
      if (sql.startsWith("UPDATE app.enrichment_runs")) return { rows: [] };
      if (sql.includes("FROM core.accounts a")) {
        return { rows: [{
          account_id: values[0], county: "Collin County",
          listing_key: `listing-${values[0]}`, listing_id: `MLS-${values[0]}`,
          bedrooms: 5, bathrooms_full: 3, pool: true, year_built: 1985,
        }] };
      }
      if (sql.includes("FROM app.property_attribute_manual_values")) {
        return { rows: [{ attribute_key: "bedrooms", attribute_value: 0 }] };
      }
      assert.fail("unexpected pool query in account enrichment fixture");
    },
    async connect() {
      const clientId = ++connections;
      events.push({ type: "connect", clientId });
      if (connectError) throw connectError;
      return {
        query(sql, values) {
          let stage = sql;
          if (sql.includes("INSERT INTO app.property_attribute_observations")) stage = "observation insert";
          else if (sql.includes("INSERT INTO app.enrichment_review_queue")) stage = "review insert";
          else if (sql.includes("UPDATE app.enrichment_review_queue")) stage = "review resolution";
          assert.ok(["BEGIN", "COMMIT", "ROLLBACK", "observation insert", "review insert", "review resolution"].includes(stage));
          statements.push({ clientId, stage, sql, values });
          events.push({ type: "query", clientId, stage });
          if (clientId === 1 && stage === "ROLLBACK") {
            if (rollbackThrows) throw rollbackError;
            return Promise.resolve(beforeRollback()).then(() => {
              if (rollbackFails) throw rollbackError;
              return { rows: [] };
            });
          }
          if (clientId === 1 && stage === failureStage) {
            injectedFailures += 1;
            return Promise.reject(primaryError);
          }
          return Promise.resolve({ rows: [] });
        },
        release(error) {
          releases.push({ clientId, error });
          events.push({ type: "release", clientId, error });
          if (releaseError !== undefined) throw releaseError;
        },
      };
    },
  };
  const trestleClient = {
    async findProperty(input) {
      providerCalls.push(input);
      events.push({ type: "provider", listingKey: input.listingKey });
      await beforeProvider();
      if (providerError) throw providerError;
      return {
        attributes: { bedrooms: 4, bathrooms_full: 2, pool: false },
        raw: { ListingKey: input.listingKey, ListingId: input.listingId },
      };
    },
  };
  return {
    pool, trestleClient, primaryError, rollbackError, queries, statements, releases, events, providerCalls,
    get connections() { return connections; },
    get injectedFailures() { return injectedFailures; },
  };
}

for (const failureStage of ["BEGIN", "observation insert", "review insert", "review resolution", "COMMIT"]) {
  for (const rollbackFails of [false, true]) {
    test(`non-Dallas ${failureStage} failure preserves its error and ${rollbackFails ? "retires" : "reuses"} the client`, async () => {
      const fixture = accountEnrichmentFixture({ failureStage, rollbackFails });
      await assert.rejects(enrichNonDallasAccount({
        pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1",
      }), error => error === fixture.primaryError);
      assert.equal(fixture.injectedFailures, 1, "the actual account implementation reaches the requested failure stage");
      assert.equal(fixture.connections, 1);
      assert.equal(fixture.statements.at(-1).stage, "ROLLBACK");
      assert.equal(fixture.statements.filter(({ stage }) => stage === "ROLLBACK").length, 1);
      assert.equal(fixture.releases.length, 1);
      const releaseError = fixture.releases[0].error;
      if (rollbackFails) {
        assert.ok(releaseError instanceof Error);
        assert.equal(releaseError.message, "non_dallas_enrichment_rollback_failed");
        assert.notEqual(releaseError, fixture.primaryError);
        assert.notEqual(releaseError, fixture.rollbackError);
      } else {
        assert.equal(releaseError, undefined);
      }
    });
  }
}

test("actual non-Dallas account enrichment commits mixed manual, Trestle, CAD, and review results on a reusable client", async () => {
  const fixture = accountEnrichmentFixture();
  const result = await enrichNonDallasAccount({ pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1" });
  assert.equal(result.account_id, "A-1");
  assert.equal(result.county, "COLLIN");
  assert.equal(result.source_reference, "listing-A-1");
  assert.deepEqual(result.resolved.bedrooms, { value: 0, source: "manual_verified", review_required: false });
  assert.deepEqual(result.resolved.bathrooms_full, { value: 2, source: "trestle", review_required: false });
  assert.deepEqual(result.resolved.pool, { value: false, source: "trestle", review_required: false });
  assert.deepEqual(result.resolved.year_built, { value: 1985, source: "cad", review_required: false });
  assert.deepEqual(result.resolved.garage_spaces, {
    value: null, source: null, review_required: true, review_reason: "missing_from_trestle_and_cad",
  });
  assert.deepEqual(fixture.providerCalls, [{ listingKey: "listing-A-1", listingId: "MLS-A-1" }]);
  const observations = fixture.statements.filter(({ stage }) => stage === "observation insert");
  assert.deepEqual(observations.map(({ values }) => [values[2], JSON.parse(values[3])]), [
    ["bedrooms", 4], ["bathrooms_full", 2], ["pool", false],
  ]);
  const resolved = fixture.statements.filter(({ stage }) => stage === "review resolution");
  assert.deepEqual(resolved.map(({ values }) => values), [
    ["A-1", "bedrooms"], ["A-1", "bathrooms_full"], ["A-1", "pool"], ["A-1", "year_built"],
  ]);
  const review = fixture.statements.find(({ stage, values }) => stage === "review insert" && values[2] === "garage_spaces");
  assert.deepEqual(review.values.slice(0, 4), ["A-1", "COLLIN", "garage_spaces", "missing_from_trestle_and_cad"]);
  assert.deepEqual(JSON.parse(review.values[4]), { source_reference: "listing-A-1" });
  assert.equal(fixture.statements[0].stage, "BEGIN");
  assert.equal(fixture.statements.at(-1).stage, "COMMIT");
  assert.equal(fixture.statements.filter(({ stage }) => stage === "COMMIT").length, 1);
  assert.equal(fixture.statements.some(({ stage }) => stage === "ROLLBACK"), false);
  assert.deepEqual(fixture.releases, [{ clientId: 1, error: undefined }]);
});

test("non-Dallas provider failure precedes checkout and preserves the original error", async () => {
  const providerError = new Error("private provider failure");
  const fixture = accountEnrichmentFixture({ providerError });
  await assert.rejects(enrichNonDallasAccount({
    pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1",
  }), error => error === providerError);
  assert.equal(fixture.providerCalls.length, 1);
  assert.equal(fixture.connections, 0);
  assert.deepEqual(fixture.statements, []);
  assert.deepEqual(fixture.releases, []);
});

test("non-Dallas checkout failure preserves its error without issuing transaction cleanup", async () => {
  const connectError = new Error("private connection failure");
  const fixture = accountEnrichmentFixture({ connectError });
  await assert.rejects(enrichNonDallasAccount({
    pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1",
  }), error => error === connectError);
  assert.equal(fixture.providerCalls.length, 1);
  assert.equal(fixture.connections, 1);
  assert.deepEqual(fixture.statements, []);
  assert.deepEqual(fixture.releases, []);
});

test("actual non-Dallas batch retires a rollback-failed client before checking out the next account", async () => {
  const fixture = accountEnrichmentFixture({ failureStage: "observation insert", rollbackFails: true });
  const logs = [];
  const result = await runNonDallasEnrichmentBatch({
    pool: fixture.pool, trestleClient: fixture.trestleClient, county: "COLLIN", limit: 2,
    listCandidates: async () => ["A-1", "A-2"],
    logger: { error: (...args) => logs.push(args) },
  });
  assert.deepEqual(result, { run_id: 17, county: "COLLIN", processed: 1, resolved: 4, review: 20, errors: 1 });
  assert.equal(fixture.connections, 2);
  assert.equal(fixture.injectedFailures, 1);
  assert.deepEqual(fixture.providerCalls.map(({ listingKey }) => listingKey), ["listing-A-1", "listing-A-2"]);
  assert.equal(fixture.releases.length, 2);
  assert.equal(fixture.releases[0].clientId, 1);
  assert.equal(fixture.releases[0].error?.message, "non_dallas_enrichment_rollback_failed");
  assert.deepEqual(fixture.releases[1], { clientId: 2, error: undefined });
  const retiredAt = fixture.events.findIndex(event => event.type === "release" && event.clientId === 1 && event.error);
  const nextCheckoutAt = fixture.events.findIndex(event => event.type === "connect" && event.clientId === 2);
  assert.ok(retiredAt >= 0 && retiredAt < nextCheckoutAt);
  assert.equal(fixture.statements.filter(({ clientId, stage }) => clientId === 1 && stage === "ROLLBACK").length, 1);
  assert.equal(fixture.statements.filter(({ clientId, stage }) => clientId === 2 && stage === "COMMIT").length, 1);
  assert.deepEqual(fixture.queries.at(-1).values, [17, 1, 4, 20, 1]);
  assert.deepEqual(logs, [["[non-dallas-enrichment] A-1:", "non_dallas_enrichment_failed"]]);
});

function assertAccountCleanupRelease(fixture, discarded, expectedConnections = 1) {
  assert.equal(fixture.connections, expectedConnections);
  assert.equal(fixture.releases.length, expectedConnections);
  const [{ error }] = fixture.releases;
  if (!discarded) return assert.equal(error, undefined);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "non_dallas_enrichment_rollback_failed");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.deepEqual(Object.keys(error), []);
  assert.equal(error.stack.includes("private"), false);
  assert.notEqual(error, fixture.primaryError);
  assert.notEqual(error, fixture.rollbackError);
}

for (const failureStage of ["BEGIN", "observation insert", "review insert", "review resolution", "COMMIT"]) {
  test(`non-Dallas ${failureStage} failure survives a synchronous rollback throw`, async () => {
    const fixture = accountEnrichmentFixture({ failureStage, rollbackThrows: true });
    await assert.rejects(enrichNonDallasAccount({
      pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1",
    }), error => error === fixture.primaryError);
    assert.equal(fixture.injectedFailures, 1);
    assert.equal(fixture.providerCalls.length, 1);
    assert.deepEqual(fixture.statements.slice(-2).map(({ stage }) => stage), [failureStage, "ROLLBACK"]);
    assert.equal(fixture.statements.filter(({ stage }) => stage === "ROLLBACK").length, 1);
    assert.equal(fixture.events.at(-1).type, "release");
    assertAccountCleanupRelease(fixture, true);
  });
}

for (const outcome of [
  { name: "COMMIT" },
  { name: "primary failure and successful rollback", failureStage: "observation insert" },
  { name: "primary failure and failed rollback", failureStage: "observation insert", rollbackFails: true },
]) {
  for (const [kind, releaseError] of [
    ["Error", new Error("release failed")],
    ["Symbol", Symbol("release failed")],
    ["object", Object.freeze({ release: "failed" })],
  ]) {
    test(`non-Dallas release-thrown ${kind} retains precedence after ${outcome.name}`, async () => {
      const fixture = accountEnrichmentFixture({ ...outcome, releaseError });
      await assert.rejects(enrichNonDallasAccount({
        pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1",
      }), error => error === releaseError);
      assert.equal(fixture.injectedFailures, outcome.failureStage ? 1 : 0);
      assert.equal(fixture.providerCalls.length, 1);
      assert.equal(fixture.events[0].type, "provider");
      assert.equal(fixture.events[1].type, "connect");
      assert.equal(fixture.events.at(-1).type, "release");
      assert.equal(fixture.statements.filter(({ stage }) => stage === "BEGIN").length, 1);
      assert.equal(fixture.statements.filter(({ stage }) => stage === "ROLLBACK").length, outcome.failureStage ? 1 : 0);
      assert.equal(fixture.statements.at(-1).stage, outcome.failureStage ? "ROLLBACK" : "COMMIT");
      assertAccountCleanupRelease(fixture, Boolean(outcome.rollbackFails));
    });
  }
}

for (const rollbackFails of [false, true]) {
  test(`actual non-Dallas batch waits for rollback ${rollbackFails ? "failure" : "success"} and release before continuing`, async () => {
    let finishRollback;
    const gate = new Promise(resolve => { finishRollback = resolve; });
    const fixture = accountEnrichmentFixture({
      failureStage: "observation insert", rollbackFails, beforeRollback: () => gate,
    });
    const logs = [];
    let settled = false;
    const pending = runNonDallasEnrichmentBatch({
      pool: fixture.pool, trestleClient: fixture.trestleClient, county: "COLLIN", limit: 2,
      listCandidates: async () => ["A-1", "A-2"],
      logger: { error: (...args) => logs.push(args) },
    }).then(value => { settled = true; return value; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(fixture.connections, 1);
      assert.equal(fixture.queries.length, 3, "only run insertion and first account/manual reads happen before cleanup");
      assert.deepEqual(fixture.providerCalls.map(({ listingKey }) => listingKey), ["listing-A-1"]);
      assert.deepEqual(fixture.statements.map(({ stage }) => stage), ["BEGIN", "observation insert", "ROLLBACK"]);
      assert.deepEqual(fixture.releases, []);
      assert.deepEqual(logs, []);
      assert.equal(settled, false);
      finishRollback();
      assert.deepEqual(await pending, { run_id: 17, county: "COLLIN", processed: 1, resolved: 4, review: 20, errors: 1 });
      assert.equal(fixture.connections, 2);
      assert.equal(fixture.releases.length, 2);
      assert.equal(fixture.releases[0].clientId, 1);
      assertAccountCleanupRelease(fixture, rollbackFails, 2);
      assert.deepEqual(fixture.releases[1], { clientId: 2, error: undefined });
      assert.equal(fixture.statements.filter(({ stage }) => stage === "ROLLBACK").length, 1);
      const releasedAt = fixture.events.findIndex(event => event.type === "release" && event.clientId === 1);
      const nextProviderAt = fixture.events.findIndex(event => event.type === "provider" && event.listingKey === "listing-A-2");
      const nextCheckoutAt = fixture.events.findIndex(event => event.type === "connect" && event.clientId === 2);
      assert.ok(releasedAt >= 0 && releasedAt < nextProviderAt && nextProviderAt < nextCheckoutAt);
      assert.deepEqual(fixture.queries.at(-1).values, [17, 1, 4, 20, 1]);
      assert.deepEqual(logs, [["[non-dallas-enrichment] A-1:", "non_dallas_enrichment_failed"]]);
    } finally {
      finishRollback();
      await pending;
    }
  });
}

test("non-Dallas account waits for the provider before acquiring its transaction", async () => {
  let finishProvider;
  const gate = new Promise(resolve => { finishProvider = resolve; });
  const fixture = accountEnrichmentFixture({ beforeProvider: () => gate });
  const pending = enrichNonDallasAccount({ pool: fixture.pool, trestleClient: fixture.trestleClient, accountId: "A-1" });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(fixture.connections, 0);
    assert.deepEqual(fixture.statements, []);
    assert.deepEqual(fixture.releases, []);
    finishProvider();
    assert.equal((await pending).account_id, "A-1");
    assert.equal(fixture.providerCalls.length, 1);
    assert.equal(fixture.statements.at(-1).stage, "COMMIT");
    assertAccountCleanupRelease(fixture, false);
  } finally {
    finishProvider();
    await pending;
  }
});

function runPool(handler = async () => ({ rows: [] })) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.startsWith("INSERT INTO app.enrichment_runs")) return { rows: [{ id: 17 }] };
        return handler(sql, values);
      },
    },
  };
}

test("non-Dallas batch keeps counts while bounding item diagnostics", async () => {
  const { pool, queries } = runPool();
  const logs = [];
  const trestleClient = {};
  const result = await runNonDallasEnrichmentBatch({
    pool, trestleClient, county: "COLLIN", limit: 2,
    listCandidates: async (queryable, options) => {
      assert.equal(queryable, pool);
      assert.deepEqual(options, { county: "COLLIN", limit: 2 });
      return ["A-1", "A-2"];
    },
    enrichAccount: async (input) => {
      assert.equal(input.pool, pool);
      assert.equal(input.trestleClient, trestleClient);
      if (input.accountId === "A-2") throw new Error("token=private-value");
      return { resolved: { bedrooms: { review_required: false }, pool: { review_required: true } } };
    },
    logger: { error: (...args) => logs.push(args) },
  });
  assert.deepEqual(result, {
    run_id: 17, county: "COLLIN", processed: 1, resolved: 1, review: 1, errors: 1,
  });
  assert.deepEqual(logs, [["[non-dallas-enrichment] A-2:", "non_dallas_enrichment_failed"]]);
  assert.deepEqual(queries[1].values, [17, 1, 1, 1, 1]);
  assert.equal(JSON.stringify({ result, logs, queries }).includes("private-value"), false);
});

test("non-Dallas run stores a bounded failure code, not the original exception", async () => {
  const { pool, queries } = runPool();
  const failure = Object.assign(new Error("token=private-value"), { code: "ECONNRESET" });
  await assert.rejects(runNonDallasEnrichmentBatch({
    pool, county: "DENTON", limit: 1,
    listCandidates: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(queries[1].values[4], 1);
  assert.deepEqual(JSON.parse(queries[1].values[5]), { error: "ECONNRESET" });
  assert.equal(JSON.stringify(queries).includes("private-value"), false);
  assert.equal(nonDallasEnrichmentFailureCode(new Error("token=private-value")),
    "non_dallas_enrichment_failed");
});

test("a throwing diagnostic logger cannot interrupt non-Dallas batch settlement", async () => {
  const { pool, queries } = runPool();
  const result = await runNonDallasEnrichmentBatch({
    pool, county: "COLLIN", limit: 1,
    listCandidates: async () => ["A-1"],
    enrichAccount: async () => { throw new Error("private detail"); },
    logger: { error() { throw new Error("logger unavailable"); } },
  });
  assert.equal(result.errors, 1);
  assert.equal(queries[1].values[4], 1);
});

test("non-Dallas CLI fails with a fixed code and no exception stack", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/runNonDallasEnrichment.js", import.meta.url)),
    "token-private-county",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[non-dallas-enrichment\] failed non_dallas_enrichment_failed/);
  assert.equal(result.stderr.includes("token-private-county"), false);
  assert.equal(result.stderr.includes("Error:"), false);
});
