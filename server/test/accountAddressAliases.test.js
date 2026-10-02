import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAddressAliasEvidence,
  resolveUniqueAddressAliases,
  seedAccountAddressAliasBatch,
} from "../src/services/accountAddressAliases.js";

test("account alias evidence normalizes suffixes, county, and ZIP", () => {
  assert.deepEqual(normalizeAddressAliasEvidence({
    address: "3901 Greensboro Circle",
    city: "Garland (Dallas Co)",
    county: "Dallas County",
    postalCode: "75041-4947",
  }), {
    address_key: "3901 GREENSBORO CIR",
    city_key: "GARLAND",
    county_key: "DALLAS",
    postal_code5: "75041",
  });
});

test("address alias resolver sends all geographic safeguards to indexed lookup", async () => {
  const pool = {
    async query(sql, params) {
      const statement = String(sql);
      assert.match(statement, /app\.account_address_aliases/);
      assert.match(statement, /alias\.is_current = true/);
      assert.match(statement, /HAVING COUNT\(DISTINCT account_id\) = 1/);
      const requested = JSON.parse(params[0]);
      assert.deepEqual(requested[0], {
        request_id: "44",
        address_key: "3901 GREENSBORO CIR",
        city_key: "GARLAND",
        county_key: "DALLAS",
        postal_code5: "75041",
      });
      return { rows: [{ request_id: "44", account_id: "26572500130160000" }] };
    },
  };
  const result = await resolveUniqueAddressAliases(pool, [{
    request_id: "44",
    address_key: "3901 GREENSBORO CIR",
    city_key: "GARLAND",
    county_key: "DALLAS",
    postal_code5: "75041",
  }]);
  assert.equal(result.get("44"), "26572500130160000");
});

const SEED_STAGES = [
  "BEGIN", "advisory lock", "state insert", "state read", "refresh reset",
  "account scan", "alias retire", "alias upsert", "progress update", "COMMIT",
];
const ACCOUNT = Object.freeze({
  account_id: "26572500130160000", address: "3901 Greensboro Circle",
  city: "Garland (Dallas Co)", county: "Dallas County", postal_code: "75041-4947",
});
const COMPLETED_STATE = Object.freeze({
  last_account_id: "26572500130159999", cycle_completed_at: "2026-01-01T00:00:00Z",
  next_refresh_at: "2999-01-01T00:00:00Z",
});
const REFRESH_OPTIONS = Object.freeze({ batchSize: 2, forceRefresh: true, refreshDays: 14 });

function seedStage(sql) {
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return sql;
  if (sql.includes("pg_try_advisory_xact_lock")) return "advisory lock";
  if (sql.includes("INSERT INTO app.account_address_alias_seed_state")) return "state insert";
  if (sql.includes("SELECT * FROM app.account_address_alias_seed_state")) return "state read";
  if (sql.includes("SET last_account_id = NULL")) return "refresh reset";
  if (sql.includes("SELECT account_id, address, city, county, postal_code")) return "account scan";
  if (sql.includes("SET is_current = false")) return "alias retire";
  if (sql.includes("INSERT INTO app.account_address_aliases (")) return "alias upsert";
  if (sql.includes("SET last_account_id = $1")) return "progress update";
  assert.fail("unexpected address-alias transaction query");
}

function seedPool({
  failureStage = null, rollbackFails = false, rollbackErrors = null, lockAcquired = true,
  state = COMPLETED_STATE, accounts = [ACCOUNT], schemaError = null, connectError = null,
} = {}) {
  const primaryError = new Error("private alias seed operation detail");
  const rollbackError = new Error("private rollback connection detail");
  const cleanupErrors = rollbackErrors || (rollbackFails ? [rollbackError] : []);
  const statements = [], releases = [];
  let schemaQueries = 0, connections = 0, injectedFailures = 0, rollbacks = 0;
  const pool = {
    async query(sql) {
      schemaQueries += 1;
      assert.match(sql, /CREATE TABLE IF NOT EXISTS app\.account_address_aliases/);
      if (schemaError) throw schemaError;
      return { rows: [] };
    },
    async connect() {
      connections += 1;
      if (connectError) throw connectError;
      return {
        async query(sql, params) {
          const stage = seedStage(sql);
          statements.push({ stage, sql, params });
          if (stage === "ROLLBACK") {
            const error = cleanupErrors[rollbacks++];
            if (error) throw error;
          }
          if (stage === failureStage) { injectedFailures += 1; throw primaryError; }
          if (stage === "advisory lock") return { rows: [{ acquired: lockAcquired }] };
          if (stage === "state read") return { rows: [state] };
          if (stage === "account scan") return { rows: accounts };
          return { rows: [] };
        },
        release(error) { releases.push(error); },
      };
    },
  };
  return {
    pool, primaryError, rollbackError, statements, releases,
    get schemaQueries() { return schemaQueries; },
    get connections() { return connections; },
    get injectedFailures() { return injectedFailures; },
  };
}

for (const failureStage of SEED_STAGES) {
  for (const rollbackFails of [false, true]) {
    test(`alias seed ${failureStage} failure preserves its error and ${rollbackFails ? "retires" : "reuses"} the client`, async () => {
      const fixture = seedPool({ failureStage, rollbackFails });
      let caught;
      try { await seedAccountAddressAliasBatch(fixture.pool, REFRESH_OPTIONS); }
      catch (error) { caught = error; }
      assert.equal(fixture.schemaQueries, 1);
      assert.equal(fixture.connections, 1);
      assert.equal(fixture.injectedFailures, 1);
      assert.deepEqual(fixture.statements.map(({ stage }) => stage), [
        ...SEED_STAGES.slice(0, SEED_STAGES.indexOf(failureStage) + 1), "ROLLBACK",
      ]);
      assert.equal(fixture.releases.length, 1);
      assert.equal(caught, fixture.primaryError, "cleanup must preserve the primary operation error");
      if (rollbackFails) {
        assert.ok(fixture.releases[0] instanceof Error);
        assert.equal(fixture.releases[0].message, "account_address_alias_seed_rollback_failed");
        assert.notEqual(fixture.releases[0], fixture.primaryError);
        assert.notEqual(fixture.releases[0], fixture.rollbackError);
      } else {
        assert.equal(fixture.releases[0], undefined);
      }
    });
  }
}

for (const retryFails of [false, true]) {
  test(`a failed busy-lock rollback is retried and ${retryFails ? "retires" : "reuses"} the client without returning skipped`, async () => {
    const firstError = new Error("private initial busy-lock rollback detail");
    const retryError = new Error("private retry rollback detail");
    const fixture = seedPool({ lockAcquired: false, rollbackErrors: [firstError, ...(retryFails ? [retryError] : [])] });
    let returned, caught;
    try { returned = await seedAccountAddressAliasBatch(fixture.pool, REFRESH_OPTIONS); }
    catch (error) { caught = error; }
    assert.equal(returned, undefined);
    assert.deepEqual(fixture.statements.map(({ stage }) => stage), ["BEGIN", "advisory lock", "ROLLBACK", "ROLLBACK"]);
    assert.equal(fixture.releases.length, 1);
    assert.equal(caught, firstError, "a failed cleanup retry must preserve the first rollback error");
    if (retryFails) {
      assert.ok(fixture.releases[0] instanceof Error);
      assert.equal(fixture.releases[0].message, "account_address_alias_seed_rollback_failed");
      assert.notEqual(fixture.releases[0], firstError);
      assert.notEqual(fixture.releases[0], retryError);
    } else {
      assert.equal(fixture.releases[0], undefined);
    }
  });
}

test("forced alias refresh resets the cursor and commits normalized payload and completed progress", async () => {
  const fixture = seedPool();
  const result = await seedAccountAddressAliasBatch(fixture.pool, REFRESH_OPTIONS);
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), SEED_STAGES);
  const statement = stage => fixture.statements.find(item => item.stage === stage);
  assert.deepEqual(statement("advisory lock").params, [48_632_941, 20_260_821]);
  assert.deepEqual(statement("account scan").params, [null, 2]);
  assert.deepEqual(statement("alias retire").params, [[ACCOUNT.account_id]]);
  assert.deepEqual(JSON.parse(statement("alias upsert").params[0]), [{
    account_id: ACCOUNT.account_id, address_key: "3901 GREENSBORO CIR", city_key: "GARLAND",
    county_key: "DALLAS", postal_code5: "75041", raw_address: ACCOUNT.address, raw_city: ACCOUNT.city,
    source_type: "core_accounts", source_priority: 100,
  }]);
  assert.deepEqual(statement("progress update").params, [ACCOUNT.account_id, true, 14, 1, 1]);
  assert.deepEqual(result, { skipped: false, scanned: 1, written: 1, completed: true, last_account_id: ACCOUNT.account_id });
  assert.deepEqual(fixture.releases, [undefined]);
});

test("an in-progress alias pass resumes its cursor and keeps a full batch incomplete", async () => {
  const state = { last_account_id: COMPLETED_STATE.last_account_id, cycle_completed_at: null, next_refresh_at: null };
  const fixture = seedPool({ state });
  const result = await seedAccountAddressAliasBatch(fixture.pool, { batchSize: 1, refreshDays: 14 });
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), SEED_STAGES.filter(stage => stage !== "refresh reset"));
  assert.deepEqual(fixture.statements.find(({ stage }) => stage === "account scan").params, [state.last_account_id, 1]);
  assert.deepEqual(fixture.statements.find(({ stage }) => stage === "progress update").params, [ACCOUNT.account_id, false, 14, 1, 1]);
  assert.deepEqual(result, { skipped: false, scanned: 1, written: 1, completed: false, last_account_id: ACCOUNT.account_id });
  assert.deepEqual(fixture.releases, [undefined]);
});

test("a current alias index commits its skip without scanning or modifying aliases", async () => {
  const fixture = seedPool();
  const result = await seedAccountAddressAliasBatch(fixture.pool);
  assert.deepEqual(result, {
    skipped: true, reason: "alias_index_current", scanned: 0, written: 0, next_refresh_at: COMPLETED_STATE.next_refresh_at,
  });
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), ["BEGIN", "advisory lock", "state insert", "state read", "COMMIT"]);
  assert.deepEqual(fixture.releases, [undefined]);
});

test("a busy alias lock rolls back once and returns a reusable skipped result", async () => {
  const fixture = seedPool({ lockAcquired: false });
  const result = await seedAccountAddressAliasBatch(fixture.pool, REFRESH_OPTIONS);
  assert.deepEqual(result, { skipped: true, reason: "alias_seed_already_running", scanned: 0, written: 0 });
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), ["BEGIN", "advisory lock", "ROLLBACK"]);
  assert.deepEqual(fixture.releases, [undefined]);
});

for (const rollbackFails of [false, true]) {
  test(`current alias index commit failure ${rollbackFails ? "retires" : "reuses"} the client and preserves its error`, async () => {
    const fixture = seedPool({ failureStage: "COMMIT", rollbackFails });
    await assert.rejects(seedAccountAddressAliasBatch(fixture.pool), error => error === fixture.primaryError);
    assert.equal(fixture.injectedFailures, 1);
    assert.deepEqual(fixture.statements.map(({ stage }) => stage), [
      "BEGIN", "advisory lock", "state insert", "state read", "COMMIT", "ROLLBACK",
    ]);
    assert.equal(fixture.releases.length, 1);
    if (rollbackFails) {
      assert.ok(fixture.releases[0] instanceof Error);
      assert.equal(fixture.releases[0].message, "account_address_alias_seed_rollback_failed");
      assert.equal(fixture.releases[0].cause, undefined);
    } else {
      assert.equal(fixture.releases[0], undefined);
    }
  });
}

for (const failureStage of ["schema", "connection"]) {
  test(`alias seed ${failureStage} failure preserves its cause without transaction cleanup`, async () => {
    const failure = new Error(`private ${failureStage} detail`);
    const fixture = seedPool(failureStage === "schema" ? { schemaError: failure } : { connectError: failure });
    await assert.rejects(seedAccountAddressAliasBatch(fixture.pool, REFRESH_OPTIONS), error => error === failure);
    assert.equal(fixture.schemaQueries, 1);
    assert.equal(fixture.connections, failureStage === "schema" ? 0 : 1);
    assert.deepEqual(fixture.statements, []);
    assert.deepEqual(fixture.releases, []);
  });
}

