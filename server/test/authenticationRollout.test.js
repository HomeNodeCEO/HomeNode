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
  const assignmentList = read("../src/modules/assignmentFiles/listRouter.js");
  const assignmentMutations = read("../src/modules/assignmentFiles/mutationRouter.js");
  const propertyTax = read("../src/modules/mobile/desktopPropertyTax.js");
  const propertyTaxRouter = read("../src/modules/mobile/desktopPropertyTaxRouter.js");
  assert.match(assignmentMutations, /AND \(\$2::uuid IS NULL OR organization_id = \$2\)/);
  assert.match(propertyTax, /report_file\.organization_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(propertyTax, /requireCurrentWriteAccess\(client, row, actorAuth, normalizedActorUserId\)/);
  assert.match(propertyTax, /membership\.status = 'active'/);
  assert.match(propertyTax, /FOR SHARE OF app_user, membership, membership_role/);
  assert.match(server, /createDesktopPropertyTaxRouter/);
  assert.match(propertyTaxRouter, /organizationIds: exactFileId \? null : organizationIdsForRead\(req\)/);
  assert.match(propertyTaxRouter, /Exact-file routes must distinguish an absent file \(404\)/);
  assert.match(propertyTaxRouter, /authorizationRequired: authenticationRequired/);
  assert.match(assignmentList, /const enforcedIdentity = authenticationRequired && req\.mobileAuth/);
  assert.match(assignmentList, /legacy_assignment_details: enforcedIdentity/);
  assert.match(assignmentList, /queriedRows\.filter\(\(row\) => decideAccess\(req\.mobileAuth, row, "read"\)\)/);
  assert.match(assignmentMutations, /if \(!authenticationRequired \|\| !req\.mobileAuth\) \{\s+await mirrorLatestAssignmentDetails/);
});

test("previous-appraisal history, completion, and replication enforce canonical ownership", () => {
  const server = read("../src/oldServer.js");
  const router = read("../src/modules/accounts/appraisalHistoryRouter.js");
  const history = read("../src/services/appraisalHistory.js");
  const replication = read("../src/services/appraisalReplication.js");
  assert.match(server, /createAppraisalHistoryRouter/);
  assert.match(router, /buildAppraisalHistoryAccessScope/);
  assert.match(router, /authorizeAppraisalReportFile/);
  assert.match(history, /customOrganizationWideReadIds/);
  assert.match(history, /uadOrganizationWideReadIds/);
  assert.match(replication, /organization_id IS NOT DISTINCT FROM \$3::uuid/);
  assert.match(replication, /organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id/);
  assert.match(replication, /actor_user_id, event_type/);
});

test("assignment photos and documents require assignment-level access after activation", () => {
  const server = read("../src/oldServer.js");
  const documents = read("../src/services/assignmentDocuments.js");
  const documentRouter = read("../src/modules/assignmentFiles/documentRouter.js");
  assert.match(documentRouter, /requireDocumentAccess/);
  assert.match(documentRouter, /assignment_document_access_denied/);
  assert.match(documentRouter, /assignment_file_required/);
  assert.match(documentRouter, /requireAssignmentAccess\(req, res, accountId, assignmentFileId, "read"\)/);
  assert.match(documentRouter, /requireAssignmentAccess\([\s\S]*accountId,[\s\S]*assignmentFileId,[\s\S]*"write"/);
  assert.match(documents, /includePropertyEvidence/);
  assert.match(documents, /organizations\/\$\{organization\}\/custom-appraisal/);
  const deleteStart = documentRouter.indexOf('router.delete("/api/documents/:id"');
  const deleteEnd = documentRouter.indexOf("/** Retry text extraction", deleteStart);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
  const deleteRoute = documentRouter.slice(deleteStart, deleteEnd);
  assert.match(deleteRoute, /requireEditor\(req, res\)/);
  assert.match(deleteRoute, /requireDocumentAccess\(req, res, req\.params\.id, "write"\)/);
  assert.match(deleteRoute, /deleteDocument\(pool, objectStorage, req\.params\.id\)/);
});

test("custom appraisal signatures are identity-bound, authenticated, and append-only", () => {
  const server = read("../src/oldServer.js");
  const mutations = read("../src/modules/assignmentFiles/workfileMutationRouter.js");
  const workfiles = read("../src/services/customAppraisalWorkfiles.js");
  const migration = read("../migrations/20260929_custom_appraisal_signature_hardening.sql");
  assert.match(server, /createAssignmentWorkfileMutationRouter/);
  assert.match(mutations, /APP_SIGNING_SECRET/);
  assert.match(mutations, /authenticated_signer_required/);
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
    "property_tax_targets_without_registry",
    "property_tax_registry_without_target",
    "property_tax_files_missing_current_history",
    "property_tax_current_history_mismatches",
    "property_tax_authenticated_events_missing_actor",
    "appraisal_reports_missing_case",
    "appraisal_reports_missing_snapshot",
    "active_appraiser_profiles",
    "valid_appraiser_licenses",
    "activation_ready",
  ]) assert.match(source, new RegExp(expected));
});

test("hosted activation readiness is authenticated, administrator-only, and diagnostic-safe", () => {
  const boundary = read("../src/security/applicationRouteBoundary.js");
  const readiness = read("../src/security/applicationAuthReadiness.js");
  assert.match(boundary, /app\.get\("\/api\/auth\/readiness"/);
  assert.match(boundary, /if \(!req\.mobileAuth\).*authentication_required/);
  assert.match(boundary, /auth_readiness_access_denied/);
  assert.match(boundary, /auth_readiness_unavailable/);
  assert.doesNotMatch(boundary, /readiness audit unavailable.*error/i);
  assert.match(readiness, /organization_admin/);
  assert.match(readiness, /homenode_admin/);
  assert.match(readiness, /positiveCountBlockers/);
});

test("mandatory unified authentication fails closed across the legacy API surface", () => {
  const server = read("../src/oldServer.js");
  const boundary = read("../src/security/applicationRouteBoundary.js");
  const boundaryMount = server.indexOf("mountApplicationRouteBoundary(app");
  const accountRead = server.indexOf("app.use(createAccountDetailRouter(");
  assert.ok(boundaryMount >= 0 && accountRead > boundaryMount);
  assert.match(boundary, /app\.use\("\/api", createLegacyApplicationAuthenticationGate/);
  assert.match(boundary, /authenticationPolicy\.authenticationRequired/);
  assert.match(boundary, /req\.mobileAuth/);
  assert.doesNotMatch(boundary, /x-homenode-editor-key|configuredEditorKey/);
  assert.match(boundary, /authentication_required/);
});

test("one startup policy controls HTTP, browser, and legacy enforcement without moving mobile", () => {
  const server = read("../src/oldServer.js");
  const policyCreation = server.indexOf(
    "const applicationAuthenticationPolicy = createApplicationAuthenticationPolicy()",
  );
  const databasePool = server.indexOf("const pool = new pg.Pool(");
  const mobileRouter = server.indexOf("const mobileRouter = createMobileRouter(");
  const boundaryMount = server.indexOf("mountApplicationRouteBoundary(app");
  assert.ok(policyCreation >= 0 && policyCreation < databasePool);
  assert.ok(mobileRouter > databasePool && boundaryMount > mobileRouter);
  assert.match(server, /createHttpSecurityConfiguration\(process\.env, \{\s+authenticationPolicy: applicationAuthenticationPolicy/);
  assert.match(server, /mountApplicationRouteBoundary\(app, \{\s+authenticationPolicy: applicationAuthenticationPolicy/);
  assert.match(server, /createWebAuthRouter\(\{\s+pool,\s+verifier: webOidcVerifier,\s+authenticationPolicy: applicationAuthenticationPolicy/);
  assert.doesNotMatch(
    server,
    /environmentFlag\(\s*process\.env\.APPLICATION_AUTHENTICATION_REQUIRED/,
  );
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
  const housingRouter = read("../src/modules/accounts/housingProfileRouter.js");
  const zoningRouter = read("../src/modules/accounts/zoningRouter.js");
  const housingStart = server.indexOf("app.use(createHousingProfileRouter(");
  const housingEnd = server.indexOf("app.use(createReportManualValuesRouter(", housingStart);
  const zoningStart = server.indexOf("app.use(createZoningRouter(");
  const zoningEnd = server.indexOf("app.use(createAssignmentPhotoRouter(", zoningStart);
  assert.ok(housingStart >= 0 && housingEnd > housingStart);
  assert.ok(zoningStart >= 0 && zoningEnd > zoningStart);

  assert.match(housingRouter, /requireWorkflowAccess\(req, res, "custom_appraisal", "write"\)/);
  assert.doesNotMatch(housingRouter, /housing_profile_editor_not_configured|invalid_editor_key/);

  const zoningMount = server.slice(zoningStart, zoningEnd);
  assert.match(zoningMount, /requireWorkflowAccess,/);
  assert.match(zoningMount, /requireAssignmentAccess: requireCustomAssignmentAccess/);
  assert.match(zoningMount, /authenticationRequired: applicationAuthenticationRequired/);
  assert.match(zoningRouter, /requireWorkflowAccess\(req, res, "custom_appraisal", "write"\)/);
  assert.match(zoningRouter, /assignment_file_required/);
  assert.match(
    zoningRouter,
    /requireAssignmentAccess\(req, res, accountId, assignmentFileId, "write"\)/,
  );
  assert.doesNotMatch(zoningRouter, /zoning_editor_not_configured|invalid_editor_key/);
});

test("the legacy editor key is inert whenever mandatory authentication is active", () => {
  const server = read("../src/oldServer.js");
  const guards = read("../src/security/applicationAccessGuards.js");
  assert.match(
    server,
    /createApplicationAccessGuards\(\{[\s\S]*?authenticationRequired: applicationAuthenticationRequired/,
  );
  const helpers = [
    ["function requireEditor(req, res)", "async function requireCustomAssignmentAccess", true],
    ["async function requireCustomAssignmentAccess", "function requireWorkflowAccess", false],
    ["function requireWorkflowAccess", "return Object.freeze", true],
  ];
  for (const [startMarker, endMarker, retainsPreActivationFallback] of helpers) {
    const start = guards.indexOf(startMarker);
    const end = guards.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing authorization helper ${startMarker}`);
    const helper = guards.slice(start, end);
    assert.match(helper, /authenticationRequired/);
    if (retainsPreActivationFallback) {
      const enforcementCheck = helper.indexOf("if (authenticationRequired)");
      const keyFallback = helper.indexOf("configuredEditorKey");
      assert.ok(enforcementCheck >= 0 && keyFallback > enforcementCheck,
        `${startMarker} may use the key only after mandatory enforcement is ruled out`);
    } else {
      assert.doesNotMatch(helper, /configuredEditorKey|x-homenode-editor-key/);
    }
  }
  assert.match(guards.slice(
    guards.indexOf("function requireWorkflowAccess"),
    guards.indexOf("return Object.freeze"),
  ), /application_access_denied/);
});
