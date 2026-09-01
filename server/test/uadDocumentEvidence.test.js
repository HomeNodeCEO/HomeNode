import assert from "node:assert/strict";
import test from "node:test";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";
import {
  parseUadClientAddress,
  uadDocumentPartyNameValues,
  uadDocumentCandidateIsApplicable,
  uadMlsListingValues,
} from "../src/modules/uad/documentEvidence.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { getUadEditorSections } from "../src/modules/uad/fieldCatalog.js";

test("UAD document evidence accepts only fields with reviewed canonical mappings", () => {
  for (const field of [
    "assignment_type", "buyer_name", "seller_name", "lender_client_name",
    "lender_client_address", "contract_price", "contract_date",
    "listing_status", "mls_number", "list_date", "listing_end_date",
    "days_on_market", "original_list_price", "list_price",
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

test("confirmed MLS evidence maps to one canonical Section 19 listing", () => {
  const entityId = "11111111-1111-4111-8111-111111111111";
  const fixed = [
    { uid: "0900.0004", context_key: "subject_listing_summary", value: true },
    { uid: "0900.0015", context_key: "subject_listing", entity_id: entityId, value: "MLS" },
  ];
  assert.deepEqual(uadMlsListingValues("listing_status", "Closed", entityId), [
    ...fixed,
    { uid: "0900.0013", context_key: "subject_listing", entity_id: entityId, value: "OffMarket" },
  ]);
  assert.deepEqual(uadMlsListingValues("mls_number", "21062330", entityId), [
    ...fixed,
    { uid: "0900.0011", context_key: "subject_listing", entity_id: entityId, value: "21062330" },
  ]);
  assert.deepEqual(uadMlsListingValues("list_date", "2026-08-01", entityId), [
    ...fixed,
    { uid: "0900.0012", context_key: "subject_listing", entity_id: entityId, value: "2026-08-01" },
  ]);
  assert.deepEqual(uadMlsListingValues("listing_end_date", "2026-08-31", entityId), [
    ...fixed,
    { uid: "0900.0010", context_key: "subject_listing", entity_id: entityId, value: "2026-08-31" },
  ]);
  assert.deepEqual(uadMlsListingValues("days_on_market", "31", entityId), [
    ...fixed,
    { uid: "0900.0007", context_key: "subject_listing", entity_id: entityId, value: 31 },
  ]);
  assert.deepEqual(uadMlsListingValues("original_list_price", "$525,000", entityId), [
    ...fixed,
    { uid: "0900.0009", context_key: "subject_listing", entity_id: entityId, value: 525000 },
  ]);
  assert.deepEqual(uadMlsListingValues("list_price", "$510,000", entityId), [
    ...fixed,
    { uid: "0900.0008", context_key: "subject_listing", entity_id: entityId, value: 510000 },
  ]);
});

test("confirmed borrower evidence populates the official borrower role and name fields", () => {
  assert.deepEqual(
    uadDocumentPartyNameValues("Jordan Freeman", "borrower"),
    [
      { uid: "1000.0103", context_key: "borrower", value: "Borrower" },
      { uid: "1000.0101", context_key: "borrower", value: "Jordan" },
      { uid: "1000.0102", context_key: "borrower", value: "Freeman" },
    ],
  );
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
  assert.match(source, /setEditorInitialSection\(result\.section \|\| "assignment"\)/);
  assert.match(source, /initialSection=\{editorInitialSection\}/);
  assert.ok(source.indexOf("<AssignmentDocumentCenter") < source.indexOf("<UadWorkfileEditor"));
});

test("the UAD editor bypasses browser caches after document evidence changes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../dcad-frontend/src/features/uad/api.ts", import.meta.url),
    "utf8",
  );
  const getEditor = source.slice(
    source.indexOf("export async function getUadEditor"),
    source.indexOf("export interface UadSectionSaveResult"),
  );
  assert.match(getEditor, /cache:\s*["']no-store["']/);
});
