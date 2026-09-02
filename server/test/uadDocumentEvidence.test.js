import assert from "node:assert/strict";
import test from "node:test";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";
import {
  buildUadSalesContractAnalysis,
  parseUadClientAddress,
  uadPurchaseContractAssignmentValues,
  uadPurchaseContractValues,
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
    "closing_date", "loan_amount", "down_payment", "earnest_money",
    "seller_concessions", "contract_property_condition", "contract_repairs",
    "listing_status", "mls_number", "list_date", "listing_end_date",
    "days_on_market", "original_list_price", "list_price",
  ]) {
    assert.equal(uadDocumentCandidateIsApplicable(field), true, field);
  }
  assert.equal(uadDocumentCandidateIsApplicable("subject_property_address"), false);
});

const hardyContractCandidates = [
  ["buyer_name", "Zachary Thames"],
  ["seller_name", "Lorenzo Jr Loredo and Andi Li-Kay Thompson"],
  ["contract_date", "2026-08-25"],
  ["contract_price", "282500.00"],
  ["down_payment", "8475.00"],
  ["loan_amount", "274025.00"],
  ["earnest_money", "2600.00"],
  ["closing_date", "2026-09-24"],
  ["seller_concessions", "0.00"],
  ["contract_property_condition", "as_is"],
].map(([field_key, confirmed_value], index) => ({
  id: index + 1,
  field_key,
  confirmed_value,
  review_status: "confirmed",
}));

test("reviewed Hardy contract evidence builds the complete UAD sales-contract analysis", () => {
  const analysis = buildUadSalesContractAnalysis(hardyContractCandidates);
  assert.match(analysis, /Contract buyer\(s\): Zachary Thames\./);
  assert.match(analysis, /Contract seller\(s\): Lorenzo Jr Loredo and Andi Li-Kay Thompson\./);
  assert.match(analysis, /fully executed on 2026-08-25/);
  assert.match(analysis, /agreed sales price is \$282,500\.00/);
  assert.match(analysis, /cash portion\/down payment is \$8,475\.00/);
  assert.match(analysis, /sum of financing is \$274,025\.00/);
  assert.match(analysis, /Earnest money is \$2,600\.00/);
  assert.match(analysis, /Closing is scheduled on or before 2026-09-24/);
  assert.match(analysis, /12A\(1\)\(b\) reports no seller concessions/);
  assert.match(analysis, /accepts the property as is/);
});

test("purchase-contract synchronization never infers the arm's-length conclusion", () => {
  const values = uadPurchaseContractValues(hardyContractCandidates);
  const byKey = new Map(values.map((value) => [`${value.context_key}:${value.uid}`, value.value]));
  assert.equal(byKey.get("sales_contract:0600.0016"), true);
  assert.equal(byKey.get("sales_contract:0600.0010"), true);
  assert.equal(byKey.get("sales_contract:0600.0008"), 282500);
  assert.equal(byKey.get("sales_contract:0600.0009"), "2026-08-25");
  assert.equal(byKey.get("sales_contract:0600.0006"), false);
  assert.equal(byKey.has("sales_contract:0600.0002"), false);
  assert.match(byKey.get("sales_contract_commentary:0600.0014"), /Earnest money/);
  assert.deepEqual(uadPurchaseContractAssignmentValues(hardyContractCandidates), [
    { uid: "1000.0034", context_key: "assignment", value: "Purchase" },
    { uid: "1000.0103", context_key: "borrower", value: "Borrower" },
    { uid: "1000.0101", context_key: "borrower", value: "Zachary" },
    { uid: "1000.0102", context_key: "borrower", value: "Thames" },
  ]);
});

test("classification-only contract synchronization does not invent unreviewed terms", () => {
  assert.deepEqual(uadPurchaseContractValues([]), [
    { uid: "0600.0016", context_key: "sales_contract", value: true },
    { uid: "0600.0010", context_key: "sales_contract", value: true },
  ]);
  assert.equal(buildUadSalesContractAnalysis([]), "");
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
  assert.deepEqual(uadMlsListingValues("listing_status", "P", entityId), [
    ...fixed,
    { uid: "0900.0013", context_key: "subject_listing", entity_id: entityId, value: "Pending" },
  ]);
  assert.deepEqual(uadMlsListingValues("listing_status", "AOC", entityId), [
    ...fixed,
    { uid: "0900.0013", context_key: "subject_listing", entity_id: entityId, value: "Pending" },
  ]);
  assert.deepEqual(uadMlsListingValues("listing_status", "SLD", entityId), [
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

test("the UAD arm's-length decision is visually marked as a permanent manual-review field", async () => {
  const { readFile } = await import("node:fs/promises");
  const [editorSource, catalogSource] = await Promise.all([
    readFile(
      new URL("../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/modules/uad/salesContractCatalog.js", import.meta.url), "utf8"),
  ]);
  assert.match(editorSource, /manualContractReview[\s\S]*0600\.0002/);
  assert.match(editorSource, /hn-evidence-reviewer-frame/);
  assert.match(catalogSource, /always requires the appraiser's manual review/);
});

test("UAD purchase contracts use one batch review request instead of per-field synchronization", async () => {
  const { readFile } = await import("node:fs/promises");
  const [centerSource, apiSource, routerSource] = await Promise.all([
    readFile(new URL("../../dcad-frontend/src/components/AssignmentDocumentCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../dcad-frontend/src/features/uad/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/uad/router.js", import.meta.url), "utf8"),
  ]);
  assert.match(centerSource, /confirmAllUadPurchaseContractCandidates/);
  assert.match(apiSource, /candidates\/confirm-all-purchase-contract/);
  assert.match(routerSource, /confirmAssignmentDocumentCandidates/);
  assert.match(routerSource, /synchronizeUadPurchaseContract/);
});
