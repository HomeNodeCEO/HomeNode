import assert from "node:assert/strict";
import test from "node:test";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";
import {
  parseUadClientAddress,
  uadDocumentCandidateIsApplicable,
} from "../src/modules/uad/documentEvidence.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { getUadEditorSections } from "../src/modules/uad/fieldCatalog.js";

test("UAD document evidence accepts only fields with reviewed canonical mappings", () => {
  for (const field of [
    "assignment_type", "buyer_name", "seller_name", "lender_client_name",
    "lender_client_address", "contract_price", "contract_date",
  ]) {
    assert.equal(uadDocumentCandidateIsApplicable(field), true, field);
  }
  assert.equal(uadDocumentCandidateIsApplicable("subject_property_address"), false);
  assert.equal(uadDocumentCandidateIsApplicable("loan_amount"), false);
});

test("UAD client address parsing requires the official structured address components", () => {
  assert.deepEqual(
    parseUadClientAddress("100 North Tryon Street, Charlotte, nc 28255"),
    {
      addressLine: "100 North Tryon Street",
      city: "Charlotte",
      state: "NC",
      postalCode: "28255",
    },
  );
  assert.equal(parseUadClientAddress("100 North Tryon Street"), null);
});

test("UAD Assignment Information requires at least one complete client party", () => {
  const assignment = getUadEditorSections().find((section) => section.key === "assignment");
  const clients = assignment.groups.find((group) => group.entityType === "assignment_contact");
  assert.equal(clients.minItems, 1);
  assert.ok(clients.fields.some((field) => field.uid === "2400.0018" && field.required));
  assert.ok(clients.fields.some((field) => field.uid === "2400.0017" && field.required));
  assert.ok(validateCompleteSection("assignment", [], [], [], []).some(
    (error) => error.code === "client_party_required" && error.uid === "2400.0018",
  ));
});

test("the ordered migrations add official UAD fields before linking shared private evidence", async () => {
  const { readFile } = await import("node:fs/promises");
  const uadMigration = await readFile(
    new URL("../migrations/20261002_uad_document_evidence.sql", import.meta.url),
    "utf8",
  );
  const documentMigration = await readFile(
    new URL("../migrations/20261002_assignment_document_uad_evidence.sql", import.meta.url),
    "utf8",
  );
  const mobileManifest = await readFile(
    new URL("../src/database/mobileMigrations.js", import.meta.url),
    "utf8",
  );
  assert.ok(UAD_MIGRATION_NAMES.includes("20261002_uad_document_evidence.sql"));
  assert.match(mobileManifest, /20261002_assignment_document_uad_evidence\.sql/);
  assert.match(uadMigration, /uad_entities_entity_type_check/);
  assert.match(uadMigration, /'assignment_contact'/);
  assert.match(uadMigration, /2400\.0013/);
  assert.match(uadMigration, /1000\.0103/);
  assert.match(uadMigration, /1000\.0116/);
  assert.match(uadMigration, /Appendix B-1 URAR Implementation Guide v1\.4/);
  assert.doesNotMatch(uadMigration, /app\.assignment_documents/);
  assert.match(documentMigration, /uad_workfile_id uuid/);
  assert.match(documentMigration, /report_file_id uuid/);
  assert.match(documentMigration, /assignment_documents_workflow_checksum_uidx/);
  assert.match(documentMigration, /DROP INDEX IF EXISTS app\.assignment_documents_scope_checksum_uidx/);
});

test("the UAD workspace places the collapsed document loader before the active editor", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../dcad-frontend/src/features/uad/pages/UadWorkspaceEntry.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<AssignmentDocumentCenter/);
  assert.match(source, /uadWorkfileId=\{activeWorkfileId\}/);
  assert.ok(source.indexOf("<AssignmentDocumentCenter") < source.indexOf("<UadWorkfileEditor"));
});
