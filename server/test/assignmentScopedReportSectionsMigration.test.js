import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../migrations/20261007_assignment_scoped_report_sections.sql", import.meta.url),
  "utf8",
);
const migrationRunner = fs.readFileSync(
  new URL("../src/database/mobileMigrations.js", import.meta.url),
  "utf8",
);

test("assignment-scoped report sections expand the existing revisioned audit tables additively", () => {
  assert.match(migrationRunner, /20261007_assignment_scoped_report_sections\.sql/);
  for (const key of [
    "report.subject_identification",
    "report.exemptions",
    "report.sales_history",
    "report.property_characteristics",
    "report.land_details",
    "report.appraisal_values",
  ]) {
    assert.match(migration, new RegExp(key.replace(".", "\\.")));
  }
  assert.doesNotMatch(migration, /report\.assignment_details/);
  assert.match(migration, /ALTER COLUMN inspection_session_id DROP NOT NULL/);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|SCHEMA|DATABASE)|DELETE\s+FROM|TRUNCATE/i);
});
