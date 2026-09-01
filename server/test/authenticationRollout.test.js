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
  assert.match(source, /signature_policy = EXCLUDED\.signature_policy/);
  assert.match(source, /--signature-policy must be session or reauthentication/);
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
});

test("legacy ownership migration covers Custom and UAD canonical records with guarded counts", () => {
  const source = read("../scripts/migrateLegacyAppraisalOrganization.js");
  assert.match(source, /expected-uad-workfiles/);
  assert.match(source, /expected-custom-registry-gaps/);
  assert.match(source, /expected-uad-registry-gaps/);
  assert.match(source, /expected-history-gaps/);
  assert.match(source, /--confirm-production must exactly match --organization-legal-name/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /appraisal\.uad_workfiles/);
  assert.match(source, /registerOriginalAppraisalReport/);
  assert.match(source, /assigned appraiser must resolve exactly once with an appraiser role/);
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
  const deleteStart = server.indexOf('app.delete("/api/documents/:id"');
  const deleteEnd = server.indexOf("/** Retry text extraction", deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const deleteRoute = server.slice(deleteStart, deleteEnd);
  assert.match(deleteRoute, /requireEditor\(req, res\)/);
  assert.match(deleteRoute, /requireAssignmentDocumentAccess\(req, res, req\.params\.id, "write"\)/);
  assert.match(deleteRoute, /deleteAssignmentDocument\(pool, sharedObjectStorage, req\.params\.id\)/);
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
  const source = [
    read("../scripts/auditApplicationAuthRollout.js"),
    read("../src/security/applicationAuthReadiness.js"),
  ].join("\n");
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
    "custom_assignment_files_invalid_appraiser_credentials",
    "uad_workfiles_invalid_appraiser_credentials",
    "custom_targets_without_registry",
    "uad_targets_without_registry",
    "appraisal_reports_missing_case",
    "appraisal_reports_missing_snapshot",
    "active_appraiser_profiles",
    "valid_appraiser_licenses",
    "activation_ready",
  ]) assert.match(source, new RegExp(expected));
});

test("hosted activation readiness is authenticated, administrator-only, and diagnostic-safe", () => {
  const server = read("../src/oldServer.js");
  const readiness = read("../src/security/applicationAuthReadiness.js");
  assert.match(server, /app\.get\("\/api\/auth\/readiness"/);
  assert.match(server, /if \(!req\.mobileAuth\).*authentication_required/);
  assert.match(server, /auth_readiness_access_denied/);
  assert.match(server, /auth_readiness_unavailable/);
  assert.doesNotMatch(server, /readiness audit unavailable.*error/i);
  assert.match(readiness, /organization_admin/);
  assert.match(readiness, /homenode_admin/);
  assert.match(readiness, /positiveCountBlockers/);
});

test("mandatory unified authentication fails closed across the legacy API surface", () => {
  const server = read("../src/oldServer.js");
  const authMe = server.indexOf('app.get("/api/auth/me"');
  const legacyGate = server.indexOf('app.use("/api", (req, res, next) =>', authMe);
  const accountRead = server.indexOf('app.get("/api/accounts/:id"');
  assert.ok(authMe >= 0 && legacyGate > authMe && accountRead > legacyGate);
  assert.match(server.slice(legacyGate, accountRead), /applicationAuthenticationRequired/);
  assert.match(server.slice(legacyGate, accountRead), /req\.mobileAuth/);
  assert.doesNotMatch(server.slice(legacyGate, accountRead), /x-homenode-editor-key|configuredEditorKey/);
  assert.match(server.slice(legacyGate, accountRead), /authentication_required/);
});

test("browser authentication bootstrap fails visibly instead of exposing an empty application", () => {
  const frontend = read("../../dcad-frontend/src/features/auth/ApplicationAuth.tsx");
  assert.match(frontend, /if \(!statusResponse\.ok\) throw new Error\('authentication_status_unavailable'\)/);
  assert.match(frontend, /sessionResponse\.status !== 401/);
  assert.match(frontend, /if \(auth\.bootstrapError\)/);
  assert.match(frontend, /Your appraisal data is unchanged; retry the connection/);
});

test("legacy property editors accept the authenticated workflow identity before editor-key fallback", () => {
  const server = read("../src/oldServer.js");
  const housingStart = server.indexOf('app.patch("/api/accounts/:id/housing-profile"');
  const housingEnd = server.indexOf('app.patch("/api/accounts/:id/report-manual-values"', housingStart);
  const zoningStart = server.indexOf('app.put("/api/accounts/:id/zoning-verification"');
  const zoningEnd = server.indexOf("function decodedDocumentHeader", zoningStart);
  assert.ok(housingStart >= 0 && housingEnd > housingStart);
  assert.ok(zoningStart >= 0 && zoningEnd > zoningStart);

  const housing = server.slice(housingStart, housingEnd);
  assert.match(housing, /requireWorkflowAccess\(req, res, "custom_appraisal", "write"\)/);
  assert.doesNotMatch(housing, /housing_profile_editor_not_configured|invalid_editor_key/);

  const zoning = server.slice(zoningStart, zoningEnd);
  assert.match(zoning, /requireWorkflowAccess\(req, res, "custom_appraisal", "write"\)/);
  assert.match(zoning, /assignment_file_required/);
  assert.match(zoning, /requireCustomAssignmentAccess\(req, res, accountId, assignmentFileId, "write"\)/);
  assert.doesNotMatch(zoning, /zoning_editor_not_configured|invalid_editor_key/);
});

test("the legacy editor key is inert whenever mandatory authentication is active", () => {
  const server = read("../src/oldServer.js");
  const helpers = [
    ["function requireEditor(req, res)", "/** Coordinate coverage", true],
    ["async function requireCustomAssignmentAccess", "async function requireAssignmentDocumentAccess", false],
    ["async function requireAssignmentDocumentAccess", "function requireWorkflowAccess", false],
    ["function requireWorkflowAccess", "function assignmentPhotoErrorStatus", true],
  ];
  for (const [startMarker, endMarker, retainsPreActivationFallback] of helpers) {
    const start = server.indexOf(startMarker);
    const end = server.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing authorization helper ${startMarker}`);
    const helper = server.slice(start, end);
    assert.match(helper, /applicationAuthenticationRequired/);
    if (retainsPreActivationFallback) {
      const enforcementCheck = helper.indexOf("if (applicationAuthenticationRequired)");
      const keyFallback = helper.indexOf("configuredEditorKey");
      assert.ok(enforcementCheck >= 0 && keyFallback > enforcementCheck,
        `${startMarker} may use the key only after mandatory enforcement is ruled out`);
    } else {
      assert.doesNotMatch(helper, /configuredEditorKey|x-homenode-editor-key/);
    }
  }
  assert.match(server.slice(
    server.indexOf("function requireWorkflowAccess"),
    server.indexOf("function assignmentPhotoErrorStatus"),
  ), /application_access_denied/);
});
