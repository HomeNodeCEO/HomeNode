import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const service = fs.readFileSync(new URL("../src/services/assignmentDocuments.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
const router = fs.readFileSync(
  new URL("../src/modules/mobile/desktopPropertyTaxRouter.js", import.meta.url),
  "utf8",
);
const customDocumentRouter = fs.readFileSync(
  new URL("../src/modules/assignmentFiles/documentRouter.js", import.meta.url),
  "utf8",
);
const mobileMigrations = fs.readFileSync(
  new URL("../src/database/mobileMigrations.js", import.meta.url),
  "utf8",
);
const migration = fs.readFileSync(
  new URL("../migrations/20261004_assignment_document_property_tax_evidence.sql", import.meta.url),
  "utf8",
);

test("Property Tax documents have a dedicated canonical-file scope", () => {
  assert.match(service, /taxProtestFileId/);
  assert.match(service, /document\.tax_protest_file_id = \$2/);
  assert.match(service, /organizations\/\$\{organization\}\/property-tax\/accounts/);
  assert.match(migration, /FOREIGN KEY \(tax_protest_file_id\)/);
  assert.match(migration, /REFERENCES app\.tax_protest_files\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /num_nonnulls\(assignment_file_id, uad_workfile_id, tax_protest_file_id\) <= 1/);
  assert.match(mobileMigrations, /20261004_assignment_document_property_tax_evidence\.sql/);
});

test("Property Tax document routes verify both protest and report identities", () => {
  assert.match(router, /property-tax-protest\/:fileId\/documents/);
  assert.match(router, /tax_protest_file_id = \$2 AND report_file_id = \$3/);
  assert.match(router, /propertyTaxDocumentScope\(req, requestedId, "read"\)/);
  assert.match(router, /propertyTaxDocumentScope\(req, requestedId, "write"\)/);
  assert.match(router, /requireWorkflowAccess\(req, res, WORKFLOW, "write"\)/);
  assert.match(router, /\{ organizationIds: null \}/);
  assert.match(router, /!decideAccess\(req\.mobileAuth, file, permission\)/);
  assert.doesNotMatch(server, /property-tax-protest\/:fileId\/documents/);
});

test("Property Tax uploads never receive Custom Appraisal or UAD target IDs", () => {
  const routeStart = router.indexOf('/api/accounts/:id/property-tax-protest/:fileId/documents');
  const routes = router.slice(routeStart);
  assert.match(routes, /taxProtestFileId: file\.tax_protest_file_id/);
  assert.match(routes, /reportFileId: file\.report_file_id/);
  assert.doesNotMatch(routes, /assignmentFileId:/);
  assert.doesNotMatch(routes, /uadWorkfileId:/);
});

test("legacy Custom Appraisal document routes exclude other workflow documents", () => {
  assert.match(service, /document\.uad_workfile_id IS NULL/);
  assert.match(service, /document\.tax_protest_file_id IS NULL/);

  const accessStart = customDocumentRouter.indexOf("async function requireDocumentAccess");
  const accessEnd = customDocumentRouter.indexOf("/** List assignment PDFs", accessStart);
  const accessGuard = customDocumentRouter.slice(accessStart, accessEnd);
  assert.match(accessGuard, /if \(!authenticationRequired\)/);
  assert.match(accessGuard, /if \(!rows\[0\]\.assignment_file_id/);
  assert.match(accessGuard, /assignment_document_access_denied/);
});
