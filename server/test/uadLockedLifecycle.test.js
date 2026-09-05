import assert from "node:assert/strict";
import test from "node:test";

import { applyUadCompletionSuggestions } from "../src/modules/uad/completionApply.js";
import { UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION } from "../src/modules/uad/completionSuggestions.js";
import { saveUadSection } from "../src/modules/uad/editor.js";
import { assertLockedUadWorkfileMutable } from "../src/modules/uad/workfileLifecycle.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_REVISION = 7;
const LOCKED_ERROR = "uad_workfile_status_locked";
const BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const UNSIGNED = {
  id: WORKFILE_ID,
  current_revision: CURRENT_REVISION,
  specification_release_key: "uad-3.6-2026-08-13-h1.5",
  status: "draft",
  signed_at: null,
};

function without(record, key) {
  const result = { ...record };
  delete result[key];
  return result;
}

function signatureQuery(statement, parameters) {
  assert.match(statement, /^SELECT EXISTS\s*\(/i);
  assert.match(statement, /FROM appraisal\.uad_signatures\b/i);
  assert.match(statement, /WHERE workfile_id = \$1\b/i);
  assert.match(statement, /AS has_signatures\b/i);
  assert.doesNotMatch(statement, /\brevision_number\b/i);
  assert.deepEqual(parameters, [WORKFILE_ID]);
  assert.equal(statement.includes(WORKFILE_ID), false);
}

function writerPool(lockedRow, { signatures = [], queryResult } = {}) {
  const calls = [];
  let released = 0;
  let connected = 0;
  let locked = false;
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ statement, parameters });
      if ([BEGIN, "ROLLBACK"].includes(statement)) return { rows: [] };
      if (statement.includes("FROM appraisal.uad_workfiles")) {
        assert.equal(calls[0].statement, BEGIN);
        assert.match(statement, /\bstatus\b/);
        assert.match(statement, /\bsigned_at\b/);
        assert.match(statement, /FOR UPDATE$/);
        assert.deepEqual(parameters, [WORKFILE_ID]);
        locked = true;
        return { rows: [lockedRow] };
      }
      if (statement.includes("FROM appraisal.uad_signatures")) {
        assert.equal(locked, true, "signature evidence must be read after the workfile lock");
        signatureQuery(statement, parameters);
        return queryResult
          ? queryResult()
          : { rows: [{ has_signatures: signatures.some((row) => row.workfile_id === WORKFILE_ID) }] };
      }
      throw new Error(`unexpected_lifecycle_test_query:${statement.slice(0, 100)}`);
    },
    release() { released += 1; },
  };
  return {
    pool: { async connect() { connected += 1; return client; } },
    assertDenied() {
      assert.equal(connected, 1);
      assert.equal(released, 1);
      assert.equal(calls[0].statement, BEGIN);
      assert.equal(calls.at(-1).statement, "ROLLBACK");
      assert.equal(calls.filter(({ statement }) => statement === "ROLLBACK").length, 1);
      assert.equal(calls.some(({ statement }) => statement === "COMMIT"), false);
      assert.equal(calls.some(({ statement }) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
      assert.equal(calls.some(({ statement }) => /appraisal\.(uad_field_values|uad_entities|uad_assets|uad_revisions|uad_audit_events)\b/.test(statement)), false);
      assert.ok(calls.every(({ statement }) => [BEGIN, "ROLLBACK"].includes(statement)
        || statement.includes("FROM appraisal.uad_workfiles")
        || statement.includes("FROM appraisal.uad_signatures")), "no source-plan or canonical reads before refusal");
    },
  };
}

const writers = [
  ["section autosave", (pool) => saveUadSection(pool, WORKFILE_ID, "assignment", {
    expected_revision: CURRENT_REVISION,
    save_reason: "autosave",
    values: [{ context_key: "assignment", uid: "1000.0158", value: "TraditionalAppraisal" }],
  }, ACTOR_ID)],
  ["completion apply", (pool) => applyUadCompletionSuggestions(pool, WORKFILE_ID, {
    expected_revision: CURRENT_REVISION,
    expected_source_digest_sha256: "a".repeat(64),
    expected_adapter_version: UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
    selected_suggestion_ids: ["field:market:1700.0001"],
    preserve_existing: true,
    confirmed: true,
  }, ACTOR_ID)],
];

const refusedRows = [
  ...["signed", "exported", "submitted", "cancelled", "unknown", ""].map((status) => (
    [`status ${JSON.stringify(status)}`, { ...UNSIGNED, status }]
  )),
  ["missing status", without(UNSIGNED, "status")],
  ...[null, 1, true, ["draft"], {}].map((status) => (
    [`malformed status ${JSON.stringify(status)}`, { ...UNSIGNED, status }]
  )),
  ["ready with signing timestamp", { ...UNSIGNED, status: "ready", signed_at: "2026-09-05T12:00:00Z" }],
  ["missing signing timestamp column", without(UNSIGNED, "signed_at")],
  ...[undefined, false, 0, "", {}, []].map((signed_at) => (
    [`malformed signing timestamp ${JSON.stringify(signed_at)}`, { ...UNSIGNED, signed_at }]
  )),
];

const malformedEvidence = [
  ["missing query result", undefined],
  ["null query result", null],
  ["missing rows", {}],
  ["null rows", { rows: null }],
  ["non-array rows", { rows: { 0: { has_signatures: false }, length: 1 } }],
  ["empty rows", { rows: [] }],
  ["multiple rows", { rows: [{ has_signatures: false }, { has_signatures: false }] }],
  ["missing boolean", { rows: [{}] }],
  ...[null, undefined, 0, "false", "true", [], {}].map((has_signatures) => (
    [`non-boolean signature result ${JSON.stringify(has_signatures)}`, { rows: [{ has_signatures }] }]
  )),
];

for (const [writerName, write] of writers) {
  for (const [caseName, row] of refusedRows) {
    test(`${writerName} rejects ${caseName} before canonical work`, async () => {
      const harness = writerPool(row);
      await assert.rejects(() => write(harness.pool), { message: LOCKED_ERROR });
      harness.assertDenied();
    });
  }
  for (const [caseName, revision_number] of [
    ["partial current-revision signature", CURRENT_REVISION],
    ["historical signature despite revised mutable status", CURRENT_REVISION - 1],
  ]) {
    test(`${writerName} rejects ${caseName}`, async () => {
      const harness = writerPool({ ...UNSIGNED, status: revision_number === CURRENT_REVISION ? "ready" : "revised" }, {
        signatures: [{ workfile_id: WORKFILE_ID, revision_number }],
      });
      await assert.rejects(() => write(harness.pool), { message: LOCKED_ERROR });
      harness.assertDenied();
    });
  }
  for (const [caseName, result] of malformedEvidence) {
    test(`${writerName} fails closed for ${caseName}`, async () => {
      const harness = writerPool(UNSIGNED, { queryResult: () => result });
      await assert.rejects(() => write(harness.pool), { message: LOCKED_ERROR });
      harness.assertDenied();
    });
  }
}

for (const status of ["draft", "validating", "ready", "revised"]) {
  test(`locked lifecycle guard permits unsigned ${status} with bound whole-workfile signature lookup`, async () => {
    const calls = [];
    const client = {
      async query(sql, parameters) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        signatureQuery(statement, parameters);
        calls.push(statement);
        return { rows: [{ has_signatures: false }] };
      },
    };
    await assert.doesNotReject(() => assertLockedUadWorkfileMutable(client, { ...UNSIGNED, status }));
    assert.equal(calls.length, 1, "helper neither owns the transaction nor reads canonical data");
  });
}
