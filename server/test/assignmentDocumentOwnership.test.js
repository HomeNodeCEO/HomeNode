import assert from "node:assert/strict";
import test from "node:test";

import { reconcileLegacyAssignmentDocuments } from "../src/security/assignmentDocumentOwnership.js";

function database({ ambiguousAssignment = false, mismatchedDocument = false } = {}) {
  const statements = [];
  const client = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes("FROM app.assignment_files")) {
        const rows = [{
          id: 4,
          account_id: "26355500170360000",
          file_number: "2026-239-01",
          organization_id: "organization-1",
          assigned_appraiser_user_id: "appraiser-1",
        }];
        if (ambiguousAssignment) rows.push({ ...rows[0], id: 5 });
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM app.assignment_documents") && sql.includes("FOR UPDATE")) {
        const rows = [7, 8, 9].map((id) => ({
          id,
          account_id: mismatchedDocument && id === 9
            ? "99999999999999999"
            : "26355500170360000",
          assignment_file_id: null,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("INSERT INTO app.assignment_document_scope_history")) {
        return { rows: [], rowCount: 3 };
      }
      if (sql.includes("UPDATE app.assignment_documents")) {
        return { rows: [{ id: 7 }, { id: 8 }, { id: 9 }], rowCount: 3 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    statements,
    pool: { async connect() { return client; } },
  };
}

const request = Object.freeze({
  accountId: "26355500170360000",
  fileNumber: "2026-239-01",
  documentIds: [9, 7, 8, 8],
  actor: "security-reconciliation",
});

test("assignment document reconciliation is a locked dry-run by default", async () => {
  const fixture = database();
  const result = await reconcileLegacyAssignmentDocuments(fixture.pool, request);
  assert.deepEqual(result.document_ids, [7, 8, 9]);
  assert.equal(result.confirmed, false);
  assert.equal(result.assignment_file_id, 4);
  assert.equal(fixture.statements.some(({ sql }) => sql.includes("INSERT INTO")), false);
  assert.equal(fixture.statements.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("confirmed reconciliation writes history before assigning every document", async () => {
  const fixture = database();
  const result = await reconcileLegacyAssignmentDocuments(fixture.pool, {
    ...request,
    confirm: true,
  });
  assert.equal(result.confirmed, true);
  const history = fixture.statements.findIndex(({ sql }) =>
    sql.includes("INSERT INTO app.assignment_document_scope_history"));
  const update = fixture.statements.findIndex(({ sql }) =>
    sql.includes("UPDATE app.assignment_documents"));
  assert.ok(history >= 0);
  assert.ok(update > history);
  assert.equal(fixture.statements.at(-1).sql, "COMMIT");
});

test("reconciliation rejects ambiguous assignments and cross-account documents", async () => {
  await assert.rejects(
    () => reconcileLegacyAssignmentDocuments(database({ ambiguousAssignment: true }).pool, request),
    (error) => error?.code === "owned_assignment_not_unique",
  );
  await assert.rejects(
    () => reconcileLegacyAssignmentDocuments(database({ mismatchedDocument: true }).pool, request),
    (error) => error?.code === "assignment_document_account_mismatch",
  );
});
