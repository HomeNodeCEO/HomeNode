import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.resolve(directory, relativePath), "utf8");

test("application organization bootstrap is dry-run first and production-confirmed", () => {
  const source = read("../scripts/bootstrapApplicationOrganization.js");
  assert.match(source, /process\.argv\.includes\("--apply"\)/);
  assert.match(source, /--confirm-production must exactly match --organization-legal-name/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /await client\.query\("ROLLBACK"\)/);
  assert.match(source, /oidc_identity_configured: false/);
  assert.match(source, /VALUES \(\$1, \$2, 'session', 'active'/);
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
});

test("legacy ownership migration refuses stale counts and unconfirmed production writes", () => {
  const source = read("../scripts/migrateLegacyAppraisalOrganization.js");
  assert.match(source, /--expected-assignment-files is required with --apply/);
  assert.match(source, /legacy assignment count changed after dry run/);
  assert.match(source, /--confirm-production must exactly match --organization-legal-name/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /app\.appraisal_cases/);
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
});

test("authenticated mobile discovery and replication exclude organization-less legacy files", () => {
  const reports = read("../src/modules/mobile/reportFiles.js");
  const properties = read("../src/modules/mobile/properties.js");
  assert.doesNotMatch(reports, /organization_id IS NULL AND report_file\.workflow_type = 'custom_appraisal'/);
  assert.doesNotMatch(reports, /organization_id IS NULL AND workflow_type = 'custom_appraisal'/);
  assert.doesNotMatch(properties, /organization_id IS NULL AND report_file\.workflow_type = 'custom_appraisal'/);
  assert.match(reports, /WHERE organization_id = \$1/);
  assert.match(reports, /organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id/);
});

test("desktop latest-file lookups remain organization scoped after authentication", () => {
  const server = read("../src/oldServer.js");
  const propertyTax = read("../src/modules/mobile/desktopPropertyTax.js");
  assert.match(server, /AND \(\$2::uuid IS NULL OR organization_id = \$2\)/);
  assert.match(propertyTax, /report_file\.organization_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(server, /\{ organizationIds \}/);
  assert.match(server, /legacy_assignment_details: applicationAuthenticationRequired && req\.mobileAuth/);
  assert.match(server, /if \(!applicationAuthenticationRequired \|\| !req\.mobileAuth\) \{\s+await mirrorLatestAssignmentDetails/);
});

test("previous-appraisal history, completion, and replication enforce canonical ownership", () => {
  const server = read("../src/oldServer.js");
  const history = read("../src/services/appraisalHistory.js");
  const replication = read("../src/services/appraisalReplication.js");
  assert.match(server, /buildAppraisalHistoryAccessScope/);
  assert.match(server, /authorizeAppraisalReportFile/);
  assert.match(history, /customOrganizationWideReadIds/);
  assert.match(history, /uadOrganizationWideReadIds/);
  assert.match(replication, /organization_id IS NOT DISTINCT FROM \$3::uuid/);
  assert.match(replication, /organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id/);
  assert.match(replication, /actor_user_id, event_type/);
});

test("assignment photos and documents require assignment-level access after activation", () => {
  const server = read("../src/oldServer.js");
  const documents = read("../src/services/assignmentDocuments.js");
  assert.match(server, /requireAssignmentDocumentAccess/);
  assert.match(server, /assignment_document_access_denied/);
  assert.match(server, /assignment_file_required/);
  assert.match(server, /requireCustomAssignmentAccess\(req, res, accountId, assignmentFileId, "read"\)/);
  assert.match(server, /requireCustomAssignmentAccess\(req, res, accountId, assignmentFileId, "write"\)/);
  assert.match(documents, /includePropertyEvidence/);
  assert.match(documents, /organizations\/\$\{organization\}\/custom-appraisal/);
});

test("custom appraisal signatures are identity-bound, authenticated, and append-only", () => {
  const server = read("../src/oldServer.js");
  const workfiles = read("../src/services/customAppraisalWorkfiles.js");
  const migration = read("../migrations/20260929_custom_appraisal_signature_hardening.sql");
  assert.match(server, /APP_SIGNING_SECRET/);
  assert.match(server, /authenticated_signer_required/);
  assert.match(workfiles, /custom_appraisal_signer_not_assigned/);
  assert.match(workfiles, /createHmac\("sha256", signingSecret\)/);
  assert.match(workfiles, /signature_event_id/);
  assert.match(workfiles, /verifyCustomAppraisalSignedSnapshot/);
  assert.match(workfiles, /custom_appraisal_signed_snapshot_integrity_failed/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /custom_appraisal_signed_snapshot_append_only/);
});

test("rollout audit covers identity, ownership, and canonical registry consistency", () => {
  const source = read("../scripts/auditApplicationAuthRollout.js");
  for (const expected of [
    "active_memberships",
    "oidc_identities",
    "custom_assignment_files_unassigned",
    "uad_workfiles_unassigned",
    "property_tax_report_files_unassigned",
    "custom_registry_mismatches",
    "uad_registry_mismatches",
    "property_tax_registry_mismatches",
    "documents_without_owned_assignment",
    "activation_ready",
  ]) assert.match(source, new RegExp(expected));
});

test("mandatory unified authentication fails closed across the legacy API surface", () => {
  const server = read("../src/oldServer.js");
  const authMe = server.indexOf('app.get("/api/auth/me"');
  const legacyGate = server.indexOf('app.use("/api", (req, res, next) =>', authMe);
  const accountRead = server.indexOf('app.get("/api/accounts/:id"');
  assert.ok(authMe >= 0 && legacyGate > authMe && accountRead > legacyGate);
  assert.match(server.slice(legacyGate, accountRead), /applicationAuthenticationRequired/);
  assert.match(server.slice(legacyGate, accountRead), /req\.mobileAuth/);
  assert.match(server.slice(legacyGate, accountRead), /x-homenode-editor-key/);
  assert.match(server.slice(legacyGate, accountRead), /authentication_required/);
});
