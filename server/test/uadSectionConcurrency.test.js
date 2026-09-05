import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUadExpectedRevision,
  normalizeUadSaveReason,
  saveUadSection,
} from "../src/modules/uad/editor.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";

test("UAD section saves require a positive optimistic-concurrency revision", async () => {
  assert.equal(normalizeUadExpectedRevision("7"), 7);
  assert.throws(() => normalizeUadExpectedRevision(0), /invalid_uad_expected_revision/);
  assert.throws(() => normalizeUadExpectedRevision(1.5), /invalid_uad_expected_revision/);
  assert.throws(() => normalizeUadExpectedRevision(undefined), /invalid_uad_expected_revision/);

  let connected = false;
  await assert.rejects(
    () => saveUadSection({ connect() { connected = true; } }, WORKFILE_ID, "assignment", { values: [] }),
    /invalid_uad_expected_revision/,
  );
  assert.equal(connected, false);
});

test("UAD saves distinguish bounded autosaves from explicit section saves", () => {
  assert.equal(normalizeUadSaveReason(undefined), "manual_save");
  assert.equal(normalizeUadSaveReason("manual_save"), "manual_save");
  assert.equal(normalizeUadSaveReason("autosave"), "autosave");
  assert.throws(() => normalizeUadSaveReason("background"), /invalid_uad_save_reason/);
});

test("an empty autosave commits without manufacturing a new revision", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (statement.includes("AS has_signatures")) return { rows: [{ has_signatures: false }] };
      if (statement.includes("SELECT id, current_revision")) {
        return { rows: [{ id: WORKFILE_ID, current_revision: 7, specification_release_key: "release", status: "draft", signed_at: null }] };
      }
      return { rows: [] };
    },
    release() {
      queries.push("RELEASE");
    },
  };

  const result = await saveUadSection(
    { async connect() { return client; } },
    WORKFILE_ID,
    "assignment",
    { expected_revision: 7, save_reason: "autosave", values: [] },
  );

  assert.equal(result.current_revision, 7);
  assert.equal(result.changed_field_count, 0);
  assert.equal(result.save_reason, "autosave");
  assert.ok(queries.includes("COMMIT"));
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO appraisal.uad_revisions")), false);
  assert.equal(queries.some((sql) => sql.includes("UPDATE appraisal.uad_workfiles")), false);
});

test("a stale section save rolls back before reading or changing field values", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql).trim());
      if (String(sql).includes("AS has_signatures")) return { rows: [{ has_signatures: false }] };
      if (String(sql).includes("SELECT id, current_revision")) {
        return { rows: [{ id: WORKFILE_ID, current_revision: 7, specification_release_key: "release", status: "draft", signed_at: null }] };
      }
      return { rows: [] };
    },
    release() {
      queries.push("RELEASE");
    },
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(
    () => saveUadSection(pool, WORKFILE_ID, "assignment", { expected_revision: 6, values: [] }),
    (error) => error.message === "uad_section_stale_revision"
      && error.details?.current_revision === 7,
  );
  assert.ok(queries.includes("BEGIN ISOLATION LEVEL READ COMMITTED"));
  assert.ok(queries.includes("ROLLBACK"));
  assert.ok(queries.includes("RELEASE"));
  assert.equal(queries.some((sql) => sql.includes("appraisal.uad_field_values")), false);
  assert.equal(queries.some((sql) => sql.startsWith("UPDATE")), false);
});
