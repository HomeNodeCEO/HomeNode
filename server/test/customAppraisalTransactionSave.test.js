import assert from "node:assert/strict";
import test, { mock as nodeMock } from "node:test";

import {
  saveCustomAppraisalWorkfileSection,
  saveCustomAppraisalWorkfileSectionInTransaction,
} from "../src/services/customAppraisalWorkfiles.js";
import { normalizeCostApproachSection } from "../src/services/costApproach.js";
import { normalizeIncomeApproachSection } from "../src/services/incomeApproach.js";
import { normalizeFinalReconciliationSection } from "../src/services/finalReconciliation.js";
import { normalizeSalesComparisonQualitativeAnalysis } from "../src/util/qualitativeAnalysis.js";

const SAVED_AT = "2026-09-08T12:00:00.000Z";
const SAVEPOINT = "SAVEPOINT homenode_custom_section_save";
const RELEASE_SAVEPOINT = "RELEASE SAVEPOINT homenode_custom_section_save";
const baseInput = {
  accountId: 19,
  assignmentFileId: 41,
  sectionKey: "neighborhood",
  sectionValue: { summary: "Supported neighborhood observations" },
  expectedRevision: 2,
  saveReason: "manual_save",
  reviewer: "Reviewer One",
};

// Strict recording doubles deliberately reject SQL outside this save contract.
// They do not emulate PostgreSQL transaction/rollback behavior (covered natively).
function recordingDatabase(options = {}) {
  const events = [];
  const state = { connections: 0, releases: 0 };
  const rows = (values = []) => ({ rows: values });
  const client = {
    async query(statement, params = []) {
      const sql = statement.replace(/\s+/g, " ").trim();
      let operation;
      if (["BEGIN", "COMMIT", "ROLLBACK", SAVEPOINT, RELEASE_SAVEPOINT].includes(sql)) {
        operation = sql;
      } else if (sql.startsWith("SELECT assignment_file.id, assignment_file.file_number")) {
        operation = "assignment";
      } else if (sql.startsWith("INSERT INTO app.custom_appraisal_workfiles (")) {
        operation = "ensure-workfile";
      } else if (sql.startsWith("SELECT status FROM app.custom_appraisal_workfiles")) {
        operation = "status";
      } else if (sql.startsWith("SELECT revision FROM app.custom_appraisal_workfile_sections")) {
        operation = "revision";
      } else if (sql.startsWith("SELECT section_key, section_value, revision")) {
        operation = "sources";
      } else if (sql.startsWith("INSERT INTO app.custom_appraisal_workfile_sections (")) {
        operation = "section";
      } else if (sql.startsWith("INSERT INTO app.custom_appraisal_workfile_section_history (")) {
        operation = "history";
      } else if (sql.startsWith("UPDATE app.custom_appraisal_workfiles SET updated_at")) {
        operation = "touch-workfile";
      } else if (sql.startsWith("UPDATE app.assignment_files SET updated_at")) {
        operation = "touch-assignment";
      } else {
        assert.fail(`Unexpected client SQL: ${sql}`);
      }
      events.push({ channel: "client", operation, sql, params: structuredClone(params) });
      if (options.failAt === operation) throw options.failure;
      if (operation === "ROLLBACK" && options.rollbackFailure) throw options.rollbackFailure;
      if (operation === "assignment") {
        return rows(options.missingAssignment ? [] : [{ id: 41, file_number: "Test 41" }]);
      }
      if (operation === "status") return rows([{ status: options.status ?? "draft" }]);
      if (operation === "revision") {
        return rows(options.revision === null ? [] : [{ revision: options.revision ?? "2" }]);
      }
      if (operation === "sources") return rows(options.sourceRows ?? []);
      if (operation === "section") {
        return rows([{
          section_key: params[1],
          section_value: JSON.parse(params[2]),
          revision: String(params[3]),
          updated_by: params[4],
          updated_at: SAVED_AT,
        }]);
      }
      return rows();
    },
    release() {
      state.releases += 1;
      events.push({ channel: "client", operation: "release-client" });
    },
    connect() {
      assert.fail("The transaction helper must not connect a client");
    },
  };
  const pool = {
    async query(sql) {
      const statement = sql.replace(/\s+/g, " ").trim();
      if (statement.startsWith("CREATE SCHEMA IF NOT EXISTS app")) {
        events.push({ channel: "pool", operation: "schema" });
        if (options.schemaFailure) throw options.schemaFailure;
      } else {
        assert.match(statement, /^INSERT INTO app.custom_appraisal_workfiles \(/);
        assert.match(statement, /FROM app.assignment_files assignment_file/);
        events.push({ channel: "pool", operation: "schema-backfill" });
      }
      return rows();
    },
    async connect() {
      state.connections += 1;
      events.push({ channel: "pool", operation: "connect" });
      return client;
    },
  };
  return { client, pool, events, state };
}

const operations = (db) => db.events.map((event) => event.operation);
const eventFor = (db, operation) => db.events.find((event) => event.operation === operation);
const preparePath = ["schema", "schema-backfill", "connect"];
const writePath = [
  "assignment", "ensure-workfile", "status", "revision", "section", "history",
  "touch-workfile", "touch-assignment",
];
const sectionWrites = (db) => db.events.filter((event) => [
  "section", "history", "touch-workfile", "touch-assignment",
].includes(event.operation));

test("ordinary saves cannot replace the coherent neighborhood section", async () => {
  for (const sectionKey of ["neighborhood_assessment", " NEIGHBORHOOD_ASSESSMENT "]) {
    for (const saveReason of ["autosave", "manual_save", "legacy_import"]) {
      const db = recordingDatabase();
      await assert.rejects(saveCustomAppraisalWorkfileSection(db.pool,
        { ...baseInput, sectionKey, saveReason }), /custom_neighborhood_acceptance_workflow_required/);
      assert.deepEqual(db.events, [], "reject before schema, connection acquisition or any data write");
    }
  }
});

test("caller-owned helper preserves wrapper response and complete write path", async () => {
  const wrapper = recordingDatabase();
  const transaction = recordingDatabase();
  const input = { ...baseInput, sectionKey: " Neighborhood ", expectedRevision: "2",
    saveReason: " MANUAL_SAVE ", reviewer: " Reviewer One " };
  const original = structuredClone(input);
  const wrapped = await saveCustomAppraisalWorkfileSection(wrapper.pool, input);
  const saved = await saveCustomAppraisalWorkfileSectionInTransaction(transaction.client, input);

  assert.deepEqual(saved, {
    key: "neighborhood", value: baseInput.sectionValue, revision: 3,
    updated_by: "Reviewer One", updated_at: SAVED_AT,
  });
  assert.deepEqual(saved, wrapped);
  assert.deepEqual(input, original);
  assert.deepEqual(operations(wrapper), [...preparePath, "BEGIN", ...writePath, "COMMIT", "release-client"]);
  assert.deepEqual(operations(transaction), [SAVEPOINT, ...writePath, RELEASE_SAVEPOINT]);
  assert.deepEqual(transaction.events.filter((event) => writePath.includes(event.operation)),
    wrapper.events.filter((event) => writePath.includes(event.operation)));
  assert.deepEqual(wrapper.state, { connections: 1, releases: 1 });
  assert.deepEqual(transaction.state, { connections: 0, releases: 0 });
  assert.deepEqual(eventFor(transaction, "assignment").params, [41, 19]);
  assert.match(eventFor(transaction, "assignment").sql, /assignment_file.account_id = \$2/);
  assert.match(eventFor(transaction, "status").sql, /FOR UPDATE$/);
  assert.match(eventFor(transaction, "revision").sql, /FOR UPDATE$/);
  assert.deepEqual(eventFor(transaction, "section").params,
    [41, "neighborhood", JSON.stringify(baseInput.sectionValue), 3, "Reviewer One"]);
  assert.deepEqual(eventFor(transaction, "history").params,
    [41, "neighborhood", JSON.stringify(baseInput.sectionValue), 3, "manual_save", "Reviewer One"]);
});

test("invalid input is rejected before any query or pool acquisition", async (t) => {
  const cases = [
    ["section key", { sectionKey: "bad-key!" }, "invalid_custom_appraisal_section_key"],
    ["null section", { sectionValue: null }, "invalid_custom_appraisal_section_value"],
    ["array section", { sectionValue: [] }, "invalid_custom_appraisal_section_value"],
    ["oversized section", { sectionValue: { text: "x".repeat(850_001) } }, "custom_appraisal_section_too_large"],
    ["negative revision", { expectedRevision: -1 }, "invalid_custom_appraisal_section_revision"],
    ["fractional revision", { expectedRevision: 1.5 }, "invalid_custom_appraisal_section_revision"],
    ["unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, "invalid_custom_appraisal_section_revision"],
    ["save reason", { saveReason: "acceptance" }, "invalid_custom_appraisal_save_reason"],
    ["cost shape", { sectionKey: "cost_approach", sectionValue: [] }, "invalid_cost_approach_section"],
    ["income shape", { sectionKey: "income_approach", sectionValue: null }, "invalid_income_approach_section"],
  ];
  for (const [name, patch, message] of cases) {
    await t.test(name, async () => {
      for (const entry of ["wrapper", "transaction"]) {
        const db = recordingDatabase();
        const input = { ...baseInput, ...patch };
        await assert.rejects(() => entry === "wrapper"
          ? saveCustomAppraisalWorkfileSection(db.pool, input)
          : saveCustomAppraisalWorkfileSectionInTransaction(db.client, input), { message });
        assert.deepEqual(db.events, []);
        assert.deepEqual(db.state, { connections: 0, releases: 0 });
      }
    });
  }
});

test("transaction helper requires a query-capable client", async () => {
  for (const client of [null, undefined, {}, { query: true }]) {
    await assert.rejects(() => saveCustomAppraisalWorkfileSectionInTransaction(client, baseInput),
      { name: "TypeError", message: "custom_appraisal_transaction_client_required" });
  }
});

test("first revision and save-reason/reviewer defaults retain their existing semantics", async (t) => {
  for (const [name, patch, reason, reviewer] of [
    ["defaults", { saveReason: undefined, reviewer: undefined }, "autosave", "HomeNode editor"],
    ["blank reviewer", { saveReason: "legacy_import", reviewer: "   " }, "legacy_import", "HomeNode editor"],
    ["bounded reviewer", { reviewer: `  ${"R".repeat(210)} ` }, "manual_save", "R".repeat(200)],
  ]) {
    await t.test(name, async () => {
      for (const entry of ["wrapper", "transaction"]) {
        const db = recordingDatabase({ revision: null });
        const input = { ...baseInput, ...patch, expectedRevision: 0 };
        const saved = entry === "wrapper"
          ? await saveCustomAppraisalWorkfileSection(db.pool, input)
          : await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input);
        assert.equal(saved.revision, 1);
        assert.equal(saved.updated_by, reviewer);
        assert.deepEqual(eventFor(db, "history").params.slice(3), [1, reason, reviewer]);
      }
    });
  }
});

test("assignment, signed-state, and revision failures preserve transaction ownership", async (t) => {
  for (const [name, options, expected, path] of [
    ["absent assignment", { missingAssignment: true }, { message: "assignment_file_not_found" }, ["assignment"]],
    ["signed workfile", { status: "signed" }, { message: "custom_appraisal_workfile_signed" }, writePath.slice(0, 3)],
    ["stale revision", { revision: "7" }, { message: "custom_appraisal_section_revision_conflict", currentRevision: 7 }, writePath.slice(0, 4)],
  ]) {
    await t.test(name, async () => {
      const db = recordingDatabase(options);
      await assert.rejects(() => saveCustomAppraisalWorkfileSectionInTransaction(db.client, baseInput), expected);
      assert.deepEqual(operations(db), [SAVEPOINT, ...path]);
      assert.deepEqual(sectionWrites(db), []);
      assert.equal(db.state.releases, 0);
      const wrapper = recordingDatabase(options);
      await assert.rejects(() => saveCustomAppraisalWorkfileSection(wrapper.pool, baseInput), expected);
      assert.deepEqual(operations(wrapper), [...preparePath, "BEGIN", ...path, "ROLLBACK", "release-client"]);
      assert.deepEqual(sectionWrites(wrapper), []);
      assert.equal(wrapper.state.releases, 1);
    });
  }
});

test("write/history/timestamp failures propagate without helper rollback or release", async (t) => {
  for (const failAt of ["section", "history", "touch-workfile", "touch-assignment"]) {
    await t.test(failAt, async () => {
      const failure = new Error(`${failAt} failed`);
      const expectedPath = writePath.slice(0, writePath.indexOf(failAt) + 1);
      const transaction = recordingDatabase({ failAt, failure });
      await assert.rejects(() => saveCustomAppraisalWorkfileSectionInTransaction(transaction.client, baseInput),
        (error) => error === failure);
      assert.deepEqual(operations(transaction), [SAVEPOINT, ...expectedPath]);
      assert.deepEqual(transaction.state, { connections: 0, releases: 0 });
      const wrapper = recordingDatabase({ failAt, failure, rollbackFailure: new Error("rollback also failed") });
      await assert.rejects(() => saveCustomAppraisalWorkfileSection(wrapper.pool, baseInput),
        (error) => error === failure);
      assert.deepEqual(operations(wrapper), [...preparePath, "BEGIN", ...expectedPath, "ROLLBACK", "release-client"]);
      assert.equal(wrapper.state.releases, 1);
    });
  }
});

test("savepoint rejection prevents all reads and writes on an accidental autocommit client", async () => {
  const failure = Object.assign(new Error("SAVEPOINT can only be used in transaction blocks"), { code: "25P01" });
  const db = recordingDatabase({ failAt: SAVEPOINT, failure });
  await assert.rejects(() => saveCustomAppraisalWorkfileSectionInTransaction(db.client, baseInput),
    (error) => error === failure);
  assert.deepEqual(operations(db), [SAVEPOINT]);
  assert.deepEqual(db.state, { connections: 0, releases: 0 });
});

test("savepoint release failure is returned to the caller without managing its transaction", async () => {
  const failure = new Error("savepoint release failed");
  const db = recordingDatabase({ failAt: RELEASE_SAVEPOINT, failure });
  await assert.rejects(() => saveCustomAppraisalWorkfileSectionInTransaction(db.client, baseInput),
    (error) => error === failure);
  assert.deepEqual(operations(db), [SAVEPOINT, ...writePath, RELEASE_SAVEPOINT]);
  assert.equal(db.state.releases, 0);
});

test("wrapper handles schema, BEGIN and COMMIT failures at its existing lifecycle boundaries", async (t) => {
  for (const failAt of ["schema", "BEGIN", "COMMIT"]) {
    await t.test(failAt, async () => {
      const failure = new Error(`${failAt} failed`);
      const db = recordingDatabase(failAt === "schema" ? { schemaFailure: failure } : { failAt, failure });
      await assert.rejects(() => saveCustomAppraisalWorkfileSection(db.pool, baseInput), (error) => error === failure);
      const expected = failAt === "schema" ? ["schema"] : failAt === "BEGIN"
        ? [...preparePath, "BEGIN", "ROLLBACK", "release-client"]
        : [...preparePath, "BEGIN", ...writePath, "COMMIT", "ROLLBACK", "release-client"];
      assert.deepEqual(operations(db), expected);
      assert.equal(db.state.releases, failAt === "schema" ? 0 : 1);
    });
  }
});

test("both entry points persist the actual unchanged domain normalizers", async (t) => {
  const costInput = {
    living_area_sqft: "2000", cost_per_sqft: "150", site_value: "75000",
    effective_age: 10, economic_life: 50, local_multiplier: 1.1,
    source_name: " Cost source ", methodology: "Supported cost analysis",
    as_of_date: "2026-09-08", saved_at: SAVED_AT,
  };
  const incomeInput = {
    market_rent: "2500", vacancy_rate: 5, other_income_monthly: 100,
    cap_rate: 6, conclusion_method: "direct_capitalization",
    expense_lines: [{ label: "Taxes", annual_amount: 4000 }],
    as_of_date: "2026-09-08", saved_at: SAVED_AT,
  };
  const salesInput = {
    opinionOfValue: 999999, opinionAfterCostToCure: 999999, costToCure: { total: 5000 },
    comparables: [
      { sale: { sale_id: "low", sale_price: 300000, address: "1 Test Lane" } },
      { sale: { sale_id: "high", sale_price: 400000, address: "2 Test Lane" } },
    ],
    workspace: { qualitativeAnalysis: { applied: true, selections: [
      { comparable_key: "sale:low", classification: "inferior" },
      { comparable_key: "sale:high", classification: "superior" },
    ] } },
  };
  for (const scenario of [
    ["cost_approach", costInput, normalizeCostApproachSection],
    ["income_approach", incomeInput, normalizeIncomeApproachSection],
    ["sales_comparison", salesInput, normalizeSalesComparisonQualitativeAnalysis],
  ]) {
    const [sectionKey, sectionValue, normalize] = scenario;
    await t.test(sectionKey, async () => {
      // Compare every calculation field, including generated timestamps, using
      // the same deterministic clock for the reference and both entrypoints.
      const timers = nodeMock.timers;
      timers.enable({ apis: ["Date"], now: new Date(SAVED_AT) });
      try {
        const expected = normalize(sectionValue);
        assert.notDeepEqual(expected, sectionValue);
        const before = structuredClone(sectionValue);
        for (const entry of ["wrapper", "transaction"]) {
          const db = recordingDatabase();
          const input = { ...baseInput, sectionKey, sectionValue };
          const result = entry === "wrapper"
            ? await saveCustomAppraisalWorkfileSection(db.pool, input)
            : await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input);
          assert.deepEqual(result.value, expected);
          assert.deepEqual(JSON.parse(eventFor(db, "section").params[2]), expected);
          assert.deepEqual(JSON.parse(eventFor(db, "history").params[2]), expected);
          assert.equal(eventFor(db, "sources"), undefined);
        }
        assert.deepEqual(sectionValue, before);
      } finally {
        timers.reset();
      }
    });
  }
});

test("final reconciliation uses locked authoritative sections and revisions, not client indications", async () => {
  const sourceRows = [
    { section_key: "sales_comparison", section_value: { opinionAfterCostToCure: 350000 }, revision: "8" },
    { section_key: "income_approach", section_value: { developed: true, rounded_indicated_value: 300000 }, revision: "5" },
    { section_key: "cost_approach", section_value: { developed: true, rounded_indicated_value: 400000 }, revision: "3" },
  ];
  const sourceSections = {
    sales_comparison: sourceRows[0].section_value, sales_comparison_revision: 8,
    income_approach: sourceRows[1].section_value, income_approach_revision: 5,
    cost_approach: sourceRows[2].section_value, cost_approach_revision: 3,
  };
  const sectionValue = {
    effective_date: "2026-09-08", saved_at: SAVED_AT,
    weights: { sales_comparison: 60, income_approach: 20, cost_approach: 20 },
    approaches: { sales_comparison: { indicated_value: 99999999, source_revision: 999 } },
    explanation: "Reconcile supported approaches", certification_confirmed: true,
  };
  const expected = normalizeFinalReconciliationSection(sectionValue, sourceSections);
  assert.equal(expected.final_value, 350000);
  assert.equal(expected.approaches.sales_comparison.source_revision, 8);
  for (const entry of ["wrapper", "transaction"]) {
    const db = recordingDatabase({ sourceRows });
    const input = { ...baseInput, sectionKey: "final_reconciliation", sectionValue };
    const saved = entry === "wrapper"
      ? await saveCustomAppraisalWorkfileSection(db.pool, input)
      : await saveCustomAppraisalWorkfileSectionInTransaction(db.client, input);
    assert.deepEqual(saved.value, expected);
    assert.deepEqual(JSON.parse(eventFor(db, "history").params[2]), expected);
    assert.match(eventFor(db, "sources").sql, /FOR SHARE$/);
    assert.deepEqual(eventFor(db, "sources").params,
      [41, ["sales_comparison", "income_approach", "cost_approach"]]);
    assert.ok(operations(db).indexOf("revision") < operations(db).indexOf("sources"));
    assert.ok(operations(db).indexOf("sources") < operations(db).indexOf("section"));
  }
});
