import assert from "node:assert/strict";
import test from "node:test";

import {
  auditSalesAutoReconciliation,
  cityHintFromSalesSource,
  runSalesAutoReconciliationBatch,
  salesAddressMatchEvidence,
} from "../src/services/salesAutoReconciliation.js";

test("sales address evidence canonicalizes MLS suffixes and place names", () => {
  assert.deepEqual(
    salesAddressMatchEvidence({
      Address: "3901 Greensboro Circle, Garland, TX 75044",
      County: "Dallas County",
    }),
    {
      address_hint: "3901 Greensboro Circle, Garland, TX 75044",
      address_key: "3901 GREENSBORO CIR",
      city_key: "GARLAND",
      city_source: "address",
      county_key: "DALLAS",
      postal_code5: "75044",
    },
  );
});

test("sales source filenames supply a conservative city fallback", () => {
  assert.equal(
    cityHintFromSalesSource("MLS sales export", ["University Park Two Year Sales.csv"]),
    "UNIVERSITY PARK",
  );
  assert.equal(cityHintFromSalesSource("MLS sales export", ["unknown.csv"]), null);
});

test("unit fragments are not mistaken for a city", () => {
  const evidence = salesAddressMatchEvidence({
    Address: "4831 Fuller Court, #1104, Irving, TX 75038",
  });
  assert.equal(evidence.city_key, "IRVING");
  assert.equal(evidence.city_source, "address");
});

function auditPool() {
  return {
    async query(sql, params) {
      const statement = String(sql);
      if (
        statement.includes("CREATE TABLE IF NOT EXISTS app.sales_auto_reconciliation_history") ||
        statement.includes("CREATE TABLE IF NOT EXISTS app.account_address_aliases")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes("source.has_unresolved_parcel = true")) {
        return {
          rows: [{
            source_record_id: 3901,
            primary_account_id: "26572500130160000",
            match_status: "address",
            parcel_number_raw: "265725500130160000",
          }],
          rowCount: 1,
        };
      }
      if (statement.includes("source.match_status = 'unmatched'")) {
        return {
          rows: [
            {
              source_record_id: 44,
              match_status: "unmatched",
              parcel_number_raw: "000",
              raw_payload: { Address: "100 Main Street", City: "Garland" },
            },
            {
              source_record_id: 45,
              match_status: "unmatched",
              parcel_number_raw: "BAD-ID",
              raw_payload: { Address: "200 Oak Road", City: "Garland" },
            },
          ],
          rowCount: 2,
        };
      }
      if (statement.includes("app.account_address_aliases")) {
        const requested = JSON.parse(params[0]);
        assert.equal(requested[0].address_key, "100 MAIN ST");
        assert.equal(requested[1].address_key, "200 OAK RD");
        return {
          rows: [{ request_id: "44", account_id: "00000000000000044" }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected query: ${statement.slice(0, 80)}`);
    },
  };
}

test("dry-run audit separates trusted links from unique exact address matches", async () => {
  const result = await auditSalesAutoReconciliation(auditPool(), { batchSize: 25 });
  assert.equal(result.dry_run, true);
  assert.equal(result.trusted_existing_links, 1);
  assert.equal(result.unique_exact_addresses, 1);
  assert.equal(result.inspected_unmatched_addresses, 2);
  assert.equal(result.total_auto_resolvable, 2);
  assert.deepEqual(
    result.sample.map((item) => item.resolution_method),
    ["trusted_existing_link", "unique_exact_address"],
  );
});

test("batch dry run never opens a write transaction", async () => {
  const pool = auditPool();
  pool.connect = async () => {
    throw new Error("dry run must not connect for writes");
  };
  const result = await runSalesAutoReconciliationBatch(pool, {
    batchSize: 25,
    dryRun: true,
  });
  assert.equal(result.resolved, 0);
  assert.equal(result.remaining_candidate_count, 2);
});

const TRANSACTION_STAGES = [
  "BEGIN", "source lock", "parcel update", "parcel insert", "source update",
  "sale update", "sale insert", "history insert", "COMMIT",
];

function writeStage(sql) {
  if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return sql;
  if (sql.includes("FOR UPDATE OF source")) return "source lock";
  if (sql.includes("UPDATE core.sale_parcels parcel")) return "parcel update";
  if (sql.includes("INSERT INTO core.sale_parcels")) return "parcel insert";
  if (sql.includes("UPDATE core.sales_source_records source")) return "source update";
  if (sql.includes("UPDATE core.sales sale")) return "sale update";
  if (sql.includes("INSERT INTO core.sales (")) return "sale insert";
  if (sql.includes("INSERT INTO app.sales_auto_reconciliation_history")) return "history insert";
  assert.fail("unexpected query in sales auto-reconciliation transaction");
}

function transactionPool({
  failureStage = null, rollbackFails = false, lockedIds = [44], noCandidates = false, connectError = null,
  rollbackThrows = false, beforeRollback = () => undefined, releaseError,
} = {}) {
  const reads = auditPool();
  const primaryError = new Error("private reconciliation operation detail");
  const rollbackError = new Error("private rollback connection detail");
  const statements = [], releases = [], events = [];
  let connections = 0, injectedFailures = 0;
  const pool = {
    async query(sql, params) {
      if (noCandidates && (sql.includes("source.has_unresolved_parcel = true")
          || sql.includes("source.match_status = 'unmatched'"))) return { rows: [], rowCount: 0 };
      return reads.query(sql, params);
    },
    async connect() {
      connections += 1;
      events.push("connect");
      if (connectError) throw connectError;
      return {
        query(sql, params) {
          const stage = writeStage(sql);
          statements.push({ stage, sql, params });
          events.push(stage);
          if (stage === "ROLLBACK") {
            if (rollbackThrows) throw rollbackError;
            return Promise.resolve(beforeRollback()).then(() => {
              if (rollbackFails) throw rollbackError;
              return { rows: [] };
            });
          }
          if (stage === failureStage) {
            injectedFailures += 1;
            return Promise.reject(primaryError);
          }
          if (stage === "source lock") return Promise.resolve({ rows: lockedIds.map(id => ({ id })) });
          return Promise.resolve({ rows: [], rowCount: stage === "source update" ? lockedIds.length : 0 });
        },
        release(error) {
          releases.push(error); events.push("release");
          if (releaseError !== undefined) throw releaseError;
        },
      };
    },
  };
  return {
    pool, primaryError, rollbackError, statements, releases, events,
    get connections() { return connections; },
    get injectedFailures() { return injectedFailures; },
  };
}

for (const failureStage of TRANSACTION_STAGES) {
  for (const rollbackFails of [false, true]) {
    test(`sales auto-reconciliation ${failureStage} failure preserves its error and ${rollbackFails ? "retires" : "reuses"} the client`, async () => {
      const fixture = transactionPool({ failureStage, rollbackFails });
      let caught;
      try {
        await runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 });
      } catch (error) {
        caught = error;
      }
      assert.equal(fixture.injectedFailures, 1);
      assert.equal(fixture.connections, 1);
      assert.deepEqual(fixture.statements.map(({ stage }) => stage), [
        ...TRANSACTION_STAGES.slice(0, TRANSACTION_STAGES.indexOf(failureStage) + 1), "ROLLBACK",
      ]);
      assert.equal(fixture.releases.length, 1);
      assert.equal(caught, fixture.primaryError, "rollback failure must not replace the original operation error");
      if (rollbackFails) {
        assert.ok(fixture.releases[0] instanceof Error);
        assert.equal(fixture.releases[0].message, "sales_auto_reconciliation_rollback_failed");
        assert.notEqual(fixture.releases[0], fixture.primaryError);
        assert.notEqual(fixture.releases[0], fixture.rollbackError);
      } else {
        assert.equal(fixture.releases[0], undefined);
      }
    });
  }
}

test("actual sales batch applies all six writes in order to only the source rows retained by the lock", async () => {
  const fixture = transactionPool();
  const result = await runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 });
  assert.deepEqual(result, {
    dry_run: false, trusted_existing_links: 1, unique_exact_addresses: 1,
    inspected_unmatched_addresses: 2, resolved: 1,
  });
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), TRANSACTION_STAGES);
  const lock = fixture.statements[1];
  assert.deepEqual(JSON.parse(lock.params[0]).map(item => item.source_record_id), [3901, 44]);
  const eligible = [{
    source_record_id: 44,
    account_id: "00000000000000044",
    resolution_method: "unique_exact_address",
    previous_match_status: "unmatched",
    raw_parcel_number: "000",
    address_key: "100 MAIN ST",
    city_key: "GARLAND",
    postal_code5: null,
  }];
  const writes = fixture.statements.slice(2, -1);
  assert.equal(writes.length, 6);
  for (const write of writes) {
    assert.equal(write.params.length, 1);
    assert.deepEqual(JSON.parse(write.params[0]), eligible, `${write.stage} must use only locked eligible resolutions`);
  }
  assert.equal(fixture.connections, 1);
  assert.deepEqual(fixture.releases, [undefined]);
});

test("a sales batch whose locked rows are no longer eligible commits without writes and releases normally", async () => {
  const fixture = transactionPool({ lockedIds: [] });
  const result = await runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 });
  assert.deepEqual(result, {
    dry_run: false, trusted_existing_links: 1, unique_exact_addresses: 1,
    inspected_unmatched_addresses: 2, resolved: 0,
  });
  assert.deepEqual(fixture.statements.map(({ stage }) => stage), ["BEGIN", "source lock", "COMMIT"]);
  assert.equal(fixture.connections, 1);
  assert.deepEqual(fixture.releases, [undefined]);
});

test("sales batches without candidates never check out a transaction client", async () => {
  const fixture = transactionPool({ noCandidates: true, connectError: new Error("must not connect without candidates") });
  const result = await runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 });
  assert.deepEqual(result, {
    dry_run: false, trusted_existing_links: 0, unique_exact_addresses: 0,
    inspected_unmatched_addresses: 0, resolved: 0, remaining_candidate_count: 0, sample: [],
  });
  assert.equal(fixture.connections, 0);
  assert.deepEqual(fixture.statements, []);
  assert.deepEqual(fixture.releases, []);
});

test("sales batch checkout failure preserves its cause without transaction cleanup", async () => {
  const connectError = new Error("private connection failure");
  const fixture = transactionPool({ connectError });
  await assert.rejects(runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 }), error => error === connectError);
  assert.equal(fixture.connections, 1);
  assert.deepEqual(fixture.statements, []);
  assert.deepEqual(fixture.releases, []);
});

function assertSalesCleanupRelease(fixture, discarded) {
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases.length, 1);
  const [error] = fixture.releases;
  if (!discarded) return assert.equal(error, undefined);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "sales_auto_reconciliation_rollback_failed");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.deepEqual(Object.keys(error), []);
  assert.equal(error.stack.includes("private"), false);
  assert.notEqual(error, fixture.primaryError);
  assert.notEqual(error, fixture.rollbackError);
}

for (const failureStage of TRANSACTION_STAGES) {
  test(`sales auto-reconciliation ${failureStage} failure survives a synchronous rollback throw`, async () => {
    const fixture = transactionPool({ failureStage, rollbackThrows: true });
    await assert.rejects(runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 }), error => error === fixture.primaryError);
    assert.equal(fixture.injectedFailures, 1);
    assert.deepEqual(fixture.events, [
      "connect", ...TRANSACTION_STAGES.slice(0, TRANSACTION_STAGES.indexOf(failureStage) + 1), "ROLLBACK", "release",
    ]);
    assertSalesCleanupRelease(fixture, true);
  });
}

for (const outcome of [
  { name: "COMMIT" },
  { name: "primary failure and successful rollback", failureStage: "history insert" },
  { name: "primary failure and failed rollback", failureStage: "history insert", rollbackFails: true },
]) {
  for (const [kind, releaseError] of [
    ["Error", new Error("release failed")],
    ["Symbol", Symbol("release failed")],
    ["object", Object.freeze({ release: "failed" })],
  ]) {
    test(`sales auto-reconciliation release-thrown ${kind} retains precedence after ${outcome.name}`, async () => {
      const fixture = transactionPool({ ...outcome, releaseError });
      await assert.rejects(runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 }), error => error === releaseError);
      assert.equal(fixture.injectedFailures, outcome.failureStage ? 1 : 0);
      assert.deepEqual(fixture.events, [
        "connect", ...TRANSACTION_STAGES.slice(0, -1), outcome.failureStage ? "ROLLBACK" : "COMMIT", "release",
      ]);
      assertSalesCleanupRelease(fixture, Boolean(outcome.rollbackFails));
    });
  }
}

for (const rollbackFails of [false, true]) {
  test(`sales auto-reconciliation awaits rollback ${rollbackFails ? "failure" : "success"} before releasing or rejecting`, async () => {
    let finishRollback;
    const gate = new Promise(resolve => { finishRollback = resolve; });
    const fixture = transactionPool({ failureStage: "history insert", rollbackFails, beforeRollback: () => gate });
    let settled = false;
    const pending = runSalesAutoReconciliationBatch(fixture.pool, { batchSize: 25 }).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fixture.events, ["connect", ...TRANSACTION_STAGES.slice(0, -1), "ROLLBACK"]);
      assert.deepEqual(fixture.releases, []);
      assert.equal(fixture.connections, 1);
      assert.equal(settled, false);
      finishRollback();
      assert.equal((await pending).error, fixture.primaryError);
      assert.deepEqual(fixture.events, ["connect", ...TRANSACTION_STAGES.slice(0, -1), "ROLLBACK", "release"]);
      assertSalesCleanupRelease(fixture, rollbackFails);
    } finally {
      finishRollback();
      await pending;
    }
  });
}
