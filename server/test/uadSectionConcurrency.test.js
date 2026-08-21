import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeUadExpectedRevision,
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

test("a stale section save rolls back before reading or changing field values", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql).trim());
      if (String(sql).includes("SELECT id, current_revision")) {
        return { rows: [{ id: WORKFILE_ID, current_revision: 7, specification_release_key: "release" }] };
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
  assert.ok(queries.includes("BEGIN"));
  assert.ok(queries.includes("ROLLBACK"));
  assert.ok(queries.includes("RELEASE"));
  assert.equal(queries.some((sql) => sql.includes("appraisal.uad_field_values")), false);
  assert.equal(queries.some((sql) => sql.startsWith("UPDATE")), false);
});
