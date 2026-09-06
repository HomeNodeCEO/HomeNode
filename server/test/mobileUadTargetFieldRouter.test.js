import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import express from "express";

if (Object.hasOwn(process.env, "DATABASE_URL")) {
  throw new Error("mobile_uad_target_field_router_test_requires_database_url_absent");
}
const { createMobileRouter } = await import("../src/modules/mobile/router.js");
const { getUadEditorSections } = await import("../src/modules/uad/fieldCatalog.js");
const { canonicalJson } = await import("../src/modules/mobile/sync.js");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const WORKFILE_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const PROPOSAL_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const FIELD_ID = "88888888-8888-4888-8888-888888888888";
const REPORT_ID = "99999999-9999-4999-8999-999999999999";
const ISSUER = "https://identity.example.test";
const SUBJECT = "synthetic-mobile-appraiser";
const TOKEN = "synthetic-mobile-bearer";
const NOW = "2026-09-06T00:00:00.000Z";
const RC = "BEGIN ISOLATION LEVEL READ COMMITTED";
const normalizeSql = (sql) => String(sql).replace(/\s+/g, " ").trim();
const copy = (value) => structuredClone(value);
const hashRequest = (decision) => createHash("sha256")
  .update(canonicalJson({ proposal_id: PROPOSAL_ID, decision })).digest("hex");

// Pin a genuine optional scalar in the actual catalog: this also exercises the
// real definition/target_reference comparison, not a manufactured catalog seam.
const FIELD = getUadEditorSections().flatMap((section) => section.groups)
  .flatMap((group) => group.fields)
  .find((field) => field.contextKey === "assignment_commentary" && field.uid === "0100.0044");
assert.ok(FIELD);
assert.equal(FIELD.entityType, undefined);
assert.equal(Boolean(FIELD.required), false);
const FIELD_PATH = "uad.assignment.assignment_commentary.f0100_0044";
const REFERENCE = { kind: "uad_field_value", section: FIELD.section, context_key: FIELD.contextKey,
  uid: FIELD.uid, report_field_id: FIELD.reportFieldId, entity_id: null };

const SQL = Object.fromEntries(Object.entries({
  identity: `SELECT users.id AS user_id, users.email, users.display_name,
    memberships.organization_id, organizations.display_name AS organization_display_name, roles.role_code
    FROM app_auth.oidc_identities identities
    JOIN app_auth.users users ON users.id = identities.user_id AND users.active = true
    LEFT JOIN app_auth.organization_memberships memberships
      ON memberships.user_id = users.id AND memberships.status = 'active'
    LEFT JOIN app_auth.membership_roles roles
      ON roles.organization_id = memberships.organization_id AND roles.user_id = memberships.user_id
    LEFT JOIN app_auth.organizations organizations ON organizations.id = memberships.organization_id
    WHERE identities.issuer = $1 AND identities.subject = $2
    ORDER BY memberships.organization_id, roles.role_code`,
  identityTouch: `UPDATE app_auth.oidc_identities SET last_authenticated_at = now(), updated_at = now()
    WHERE issuer = $1 AND subject = $2`,
  session: `SELECT session.*, report_file.workflow_type, report_file.account_id,
    report_file.file_number, report_file.registry_revision, report_file.uad_workfile_id, report_file.tax_protest_file_id
    FROM app.inspection_sessions session JOIN app.report_files report_file ON report_file.id = session.report_file_id
    WHERE session.id = $1 AND session.organization_id = ANY($2::uuid[]) AND session.appraiser_user_id = $3
    FOR UPDATE OF session, report_file`,
  operation: `SELECT request_sha256, result FROM app.mobile_target_review_operations
    WHERE inspection_session_id = $1 AND client_operation_id = $2`,
  proposal: `SELECT * FROM app.mobile_target_field_proposals WHERE id = $1 AND inspection_session_id = $2 FOR UPDATE`,
  workfile: `SELECT id, current_revision, status, specification_release_key
    FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
  workfileSignedAt: `SELECT id, current_revision, status, specification_release_key, signed_at
    FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
  signatures: `SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures`,
  values: `SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY created_at, id`,
  entities: `SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, created_at, id`,
  deleteValue: `DELETE FROM appraisal.uad_field_values WHERE workfile_id = $1 AND field_context = $2 AND uad_uid = $3
    AND entity_id IS NOT DISTINCT FROM $4::uuid`,
  updateValue: `UPDATE appraisal.uad_field_values SET value = $2::jsonb, report_field_id = $3, source_type = 'appraiser',
    source_reference = 'mobile_target_adapter', is_appraiser_confirmed = true, is_override = $4, override_reason = $5,
    updated_by_user_id = $6, updated_at = now() WHERE id = $1`,
  insertValue: `INSERT INTO appraisal.uad_field_values (
    id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value, source_type,
    source_reference, is_appraiser_confirmed, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser', 'mobile_target_adapter', true, $8)`,
  updateWorkfile: `UPDATE appraisal.uad_workfiles SET current_revision = $2, status = 'draft',
    updated_by_user_id = $3, updated_at = now() WHERE id = $1`,
  revision: `INSERT INTO appraisal.uad_revisions (
    id, workfile_id, revision_number, specification_release_key, document, change_summary, created_by_user_id
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
  audit: `INSERT INTO appraisal.uad_audit_events (
    workfile_id, actor_user_id, event_type, entity_type, entity_id, before_data, after_data, metadata
    ) VALUES ($1, $2, 'uad_mobile_field.accepted', 'uad_field', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
  report: `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
    WHERE id = $1 RETURNING registry_revision`,
  reportEvent: `INSERT INTO app.report_file_events (
    report_file_id, actor_user_id, event_type, prior_registry_revision, next_registry_revision, changed_fields, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb)`,
  sessionRevision: `UPDATE app.inspection_sessions SET base_report_revision = $2, updated_at = now() WHERE id = $1`,
  accepted: `UPDATE app.mobile_target_field_proposals SET status = 'accepted', reviewed_by_user_id = $2,
    reviewed_at = now(), applied_target_revision = $3, updated_at = now() WHERE id = $1 RETURNING *`,
  rejected: `UPDATE app.mobile_target_field_proposals SET status = 'rejected', reviewed_by_user_id = $2,
    reviewed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
  conflict: `UPDATE app.mobile_target_field_proposals SET status = 'conflict', conflict = $2::jsonb,
    reviewed_by_user_id = $3, reviewed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
  event: `INSERT INTO app.mobile_target_adapter_events (
    inspection_session_id, report_file_id, proposal_id, workflow_type, actor_user_id, event_type, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
  insertOperation: `INSERT INTO app.mobile_target_review_operations (
    inspection_session_id, proposal_id, client_operation_id, request_sha256, decision, status, result, actor_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
  pending: `SELECT EXISTS (
    SELECT 1 FROM app.mobile_target_field_proposals WHERE inspection_session_id = $1 AND status IN ('pending', 'conflict')
    UNION ALL SELECT 1 FROM app.mobile_uad_entity_proposals WHERE inspection_session_id = $1 AND status IN ('pending', 'conflict')
    UNION ALL SELECT 1 FROM app.mobile_sync_operations WHERE inspection_session_id = $1 AND status = 'conflict' AND resolved_at IS NULL
    ) AS pending`,
  sessionStatus: `UPDATE app.inspection_sessions
    SET status = CASE WHEN $2 THEN 'review_required' ELSE 'synchronized' END,
    review_required_at = CASE WHEN $2 THEN COALESCE(review_required_at, now()) ELSE NULL END, updated_at = now()
    WHERE id = $1 AND status <> 'completed'`,
  tax: `SELECT id, workfile_data, revision, status FROM app.tax_protest_files WHERE id = $1 FOR UPDATE`,
  updateTax: `UPDATE app.tax_protest_files SET workfile_data = $2::jsonb, revision = $3, status = 'in_progress',
    updated_by_user_id = $4, updated_at = now() WHERE id = $1 RETURNING workfile_data, revision, status`,
  taxHistory: `INSERT INTO app.tax_protest_file_history (
    tax_protest_file_id, revision, workfile_data, status, changed_by_user_id, change_summary
    ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
}).map(([name, sql]) => [name, normalizeSql(sql)]));

// Stateful SQL contract, not a PostgreSQL concurrency simulation. All old writer
// SQL is implemented so a missing lifecycle guard yields a real successful write,
// not an unknown-query error disguised as an expected refusal. Only the external
// token verifier is doubled; identity, role, router, review, catalog and guards run.
function fixture({ branch = "update", status = "ready", signedAt = null, signatureRevision = null,
  workflow = "uad_3_6", role = "appraiser", provisioned = true, foreignOrganization = false,
  wrongActor = false, stale = false, failBeforeCommit = false, signatureResult = null,
  signatureFailure = null } = {}) {
  const path = workflow === "uad_3_6" ? FIELD_PATH : "property_tax_protest.subject.condition_notes";
  const reference = workflow === "uad_3_6" ? REFERENCE : { kind: "property_tax_protest", target_path: ["subject", "condition_notes"] };
  const proposed = branch === "delete" ? { exists: false }
    : { exists: true, value: branch === "equal" ? "Original synthetic observation" : "Accepted synthetic observation" };
  const base = branch === "insert" ? { exists: false } : { exists: true, value: "Original synthetic observation" };
  let data = {
    workfile: { id: WORKFILE_ID, current_revision: 2, status, signed_at: signedAt,
      specification_release_key: "synthetic-release", updated_by_user_id: OTHER_ID, updated_at: NOW },
    signatures: signatureRevision === null ? [] : [{ id: OTHER_ID, workfile_id: WORKFILE_ID,
      revision_number: signatureRevision, signer_role: "appraiser", signer_user_id: OTHER_ID, signed_at: NOW }],
    values: branch === "insert" ? [] : [{ id: FIELD_ID, workfile_id: WORKFILE_ID, entity_id: null,
      field_context: FIELD.contextKey, uad_uid: FIELD.uid, report_field_id: FIELD.reportFieldId,
      value: stale ? "Concurrent desktop observation" : base.value, source_type: "document",
      source_reference: "synthetic-document", is_appraiser_confirmed: false, is_override: false,
      override_reason: null, updated_by_user_id: OTHER_ID, created_at: NOW, updated_at: NOW }],
    entities: [{ id: OTHER_ID, workfile_id: WORKFILE_ID, entity_type: "assignment_seller",
      entity_identifier: "seller-1", ordinal: 1, label: "Unrelated synthetic seller", created_at: NOW }],
    revisions: [{ id: OTHER_ID, workfile_id: WORKFILE_ID, revision_number: 2, document: { marker: "existing-history" } }],
    audit: [{ workfile_id: WORKFILE_ID, event_type: "synthetic_prior_event", actor_user_id: OTHER_ID }],
    artifacts: [{ id: OTHER_ID, workfile_id: WORKFILE_ID, revision_number: 1, artifact_type: "signed_snapshot" }],
    report: { id: REPORT_ID, registry_revision: 3, updated_at: NOW },
    session: { id: SESSION_ID, report_file_id: REPORT_ID, organization_id: ORGANIZATION_ID,
      appraiser_user_id: USER_ID, status: "review_required", base_report_revision: 3, review_required_at: NOW, updated_at: NOW },
    proposal: { id: PROPOSAL_ID, inspection_session_id: SESSION_ID, report_file_id: REPORT_ID,
      field_edit_id: OTHER_ID, workflow_type: workflow, field_path: path, target_reference: copy(reference),
      base_target_revision: 2, base_exists: base.exists, base_value: base.value ?? null,
      proposed_exists: proposed.exists, proposed_value: proposed.value ?? null,
      source_type: "appraiser", appraiser_confirmed: true, status: "pending", conflict: null,
      reviewed_by_user_id: null, reviewed_at: null, applied_target_revision: null, created_at: NOW, updated_at: NOW },
    operations: [], events: [], reportEvents: [],
    tax: { id: OTHER_ID, revision: 2, status: "in_progress", workfile_data: { subject: { condition_notes: base.value }, untouched: true } },
    taxHistory: [],
  };
  const queries = [], authQueries = [], failures = [];
  let active = false, connected = false, snapshot = null, workfileLocked = false;
  let connections = 0, releases = 0, verified = 0, signatureFaults = 0;
  const userId = wrongActor ? OTHER_ID : USER_ID;
  const organizationId = foreignOrganization ? OTHER_ID : ORGANIZATION_ID;
  const rows = (items = []) => ({ rows: copy(items), rowCount: items.length });
  const expect = (params, expected) => assert.deepEqual(params, expected);
  const client = {
    async query(raw, params = []) {
      const sql = normalizeSql(raw);
      queries.push({ sql, params: copy(params) });
      try {
        assert.equal(this, client); assert.equal(connected, true);
        if (sql === "BEGIN" || sql === RC) {
          expect(params, []); assert.equal(active, false);
          snapshot = copy(data); active = true; workfileLocked = false; return rows();
        }
        assert.equal(active, true, "all review SQL must use the same owned transaction client");
        if (sql === "ROLLBACK") {
          expect(params, []); data = snapshot; snapshot = null; active = false; return rows();
        }
        if (sql === "COMMIT") {
          expect(params, []);
          if (failBeforeCommit) throw commitFailure;
          snapshot = null; active = false; return rows();
        }
        if (sql === SQL.session) {
          expect(params, [SESSION_ID, [organizationId], userId]);
          return rows(foreignOrganization || wrongActor ? [] : [{ ...data.session,
            workflow_type: workflow, account_id: "synthetic-account", file_number: "synthetic-file",
            registry_revision: data.report.registry_revision,
            uad_workfile_id: workflow === "uad_3_6" ? WORKFILE_ID : null,
            tax_protest_file_id: workflow === "property_tax_protest" ? OTHER_ID : null }]);
        }
        if (sql === SQL.operation) {
          expect(params, [SESSION_ID, OPERATION_ID]); return rows(data.operations.filter((item) => item.client_operation_id === params[1]));
        }
        if (sql === SQL.proposal) { expect(params, [PROPOSAL_ID, SESSION_ID]); return rows([data.proposal]); }
        if (sql === SQL.workfile || sql === SQL.workfileSignedAt) {
          expect(params, [WORKFILE_ID]); assert.equal(workflow, "uad_3_6"); workfileLocked = true;
          const { id, current_revision, status: rowStatus, specification_release_key, signed_at } = data.workfile;
          return rows([{ id, current_revision, status: rowStatus, specification_release_key,
            ...(sql === SQL.workfileSignedAt ? { signed_at } : {}) }]);
        }
        if (sql === SQL.signatures) {
          expect(params, [WORKFILE_ID]); assert.equal(workfileLocked, true, "signature observation follows the owned workfile lock");
          assert.equal(queries.some((item) => /^(INSERT|UPDATE|DELETE)\b/.test(item.sql)), false,
            "signature guard runs before any review write");
          if (signatureFailure) { signatureFaults += 1; throw signatureFailure; }
          if (signatureResult !== null) return copy(signatureResult);
          return rows([{ has_signatures: data.signatures.some((item) => item.workfile_id === WORKFILE_ID) }]);
        }
        if (sql === SQL.values || sql === SQL.entities) {
          expect(params, [WORKFILE_ID]); assert.equal(workfileLocked, true);
          return rows(sql === SQL.values ? data.values : data.entities);
        }
        if (sql === SQL.deleteValue) {
          expect(params, [WORKFILE_ID, FIELD.contextKey, FIELD.uid, null]);
          data.values = data.values.filter((item) => !(item.workfile_id === params[0]
            && item.field_context === params[1] && item.uad_uid === params[2] && item.entity_id === params[3])); return rows();
        }
        if (sql === SQL.updateValue) {
          assert.equal(params.length, 6); assert.equal(params[0], FIELD_ID); assert.equal(params[2], FIELD.reportFieldId);
          assert.equal(typeof params[3], "boolean"); assert.equal(params[5], USER_ID);
          Object.assign(data.values.find((item) => item.id === params[0]), { value: JSON.parse(params[1]), report_field_id: params[2],
            source_type: "appraiser", source_reference: "mobile_target_adapter", is_appraiser_confirmed: true,
            is_override: params[3], override_reason: params[4], updated_by_user_id: params[5], updated_at: NOW }); return rows();
        }
        if (sql === SQL.insertValue) {
          assert.equal(params.length, 8); assert.match(params[0], /^[0-9a-f-]{36}$/);
          expect(params.slice(1, 6), [WORKFILE_ID, null, FIELD.contextKey, FIELD.uid, FIELD.reportFieldId]); assert.equal(params[7], USER_ID);
          data.values.push({ id: params[0], workfile_id: params[1], entity_id: params[2], field_context: params[3],
            uad_uid: params[4], report_field_id: params[5], value: JSON.parse(params[6]), source_type: "appraiser",
            source_reference: "mobile_target_adapter", is_appraiser_confirmed: true, updated_by_user_id: params[7],
            is_override: false, override_reason: null, created_at: NOW, updated_at: NOW }); return rows();
        }
        if (sql === SQL.updateWorkfile) {
          expect(params, [WORKFILE_ID, 3, USER_ID]); Object.assign(data.workfile,
            { current_revision: params[1], status: "draft", updated_by_user_id: params[2], updated_at: NOW }); return rows();
        }
        if (sql === SQL.revision) {
          assert.equal(params.length, 7); assert.match(params[0], /^[0-9a-f-]{36}$/);
          expect([params[1], params[2], params[3], params[5], params[6]],
            [WORKFILE_ID, 3, "synthetic-release", `Accepted mobile field ${path}`, USER_ID]);
          data.revisions.push({ id: params[0], workfile_id: params[1], revision_number: params[2], specification_release_key: params[3],
            document: JSON.parse(params[4]), change_summary: params[5], created_by_user_id: params[6] }); return rows();
        }
        if (sql === SQL.audit) {
          assert.equal(params.length, 6); expect(params.slice(0, 3), [WORKFILE_ID, USER_ID, null]);
          data.audit.push({ workfile_id: params[0], actor_user_id: params[1], event_type: "uad_mobile_field.accepted",
            entity_type: "uad_field", entity_id: params[2], before_data: JSON.parse(params[3]),
            after_data: JSON.parse(params[4]), metadata: JSON.parse(params[5]) }); return rows();
        }
        if (sql === SQL.report) {
          expect(params, [REPORT_ID]); data.report.registry_revision += 1; data.report.updated_at = NOW;
          return rows([{ registry_revision: data.report.registry_revision }]);
        }
        if (sql === SQL.reportEvent) {
          assert.equal(params.length, 7); expect(params.slice(0, 6), [REPORT_ID, USER_ID, `${workflow}.mobile_field_accepted`, 3, 4, [path]]);
          data.reportEvents.push({ report_file_id: params[0], actor_user_id: params[1], event_type: params[2],
            prior_registry_revision: params[3], next_registry_revision: params[4], changed_fields: params[5], metadata: JSON.parse(params[6]) }); return rows();
        }
        if (sql === SQL.sessionRevision) {
          expect(params, [SESSION_ID, 4]); data.session.base_report_revision = params[1]; data.session.updated_at = NOW; return rows();
        }
        if ([SQL.accepted, SQL.rejected, SQL.conflict].includes(sql)) {
          if (sql === SQL.accepted) { expect(params, [PROPOSAL_ID, USER_ID, 3]); data.proposal.applied_target_revision = params[2]; }
          if (sql === SQL.rejected) expect(params, [PROPOSAL_ID, USER_ID]);
          if (sql === SQL.conflict) {
            assert.equal(params.length, 3); expect([params[0], params[2]], [PROPOSAL_ID, USER_ID]); data.proposal.conflict = JSON.parse(params[1]);
          }
          Object.assign(data.proposal, { status: sql === SQL.accepted ? "accepted" : sql === SQL.rejected ? "rejected" : "conflict",
            reviewed_by_user_id: USER_ID, reviewed_at: NOW, updated_at: NOW }); return rows([data.proposal]);
        }
        if (sql === SQL.event) {
          assert.equal(params.length, 7); expect(params.slice(0, 5), [SESSION_ID, REPORT_ID, PROPOSAL_ID, workflow, USER_ID]);
          assert.ok(["target_adapter.proposal_accepted", "target_adapter.proposal_rejected", "target_adapter.proposal_conflict"].includes(params[5]));
          data.events.push({ inspection_session_id: params[0], report_file_id: params[1], proposal_id: params[2],
            workflow_type: params[3], actor_user_id: params[4], event_type: params[5], metadata: JSON.parse(params[6]) }); return rows();
        }
        if (sql === SQL.insertOperation) {
          assert.equal(params.length, 8); expect(params.slice(0, 3), [SESSION_ID, PROPOSAL_ID, OPERATION_ID]);
          assert.equal(params[3], hashRequest(params[4])); assert.ok(["accept", "reject"].includes(params[4]));
          assert.ok(["applied", "conflict"].includes(params[5])); assert.equal(params[7], USER_ID); assert.equal(data.operations.length, 0);
          data.operations.push({ inspection_session_id: params[0], proposal_id: params[1], client_operation_id: params[2],
            request_sha256: params[3], decision: params[4], status: params[5], result: JSON.parse(params[6]), actor_user_id: params[7] }); return rows();
        }
        if (sql === SQL.pending) { expect(params, [SESSION_ID]); return rows([{ pending: ["pending", "conflict"].includes(data.proposal.status) }]); }
        if (sql === SQL.sessionStatus) {
          expect(params, [SESSION_ID, ["pending", "conflict"].includes(data.proposal.status)]);
          if (data.session.status !== "completed") Object.assign(data.session, { status: params[1] ? "review_required" : "synchronized",
            review_required_at: params[1] ? data.session.review_required_at || NOW : null, updated_at: NOW }); return rows();
        }
        if (sql === SQL.tax) { expect(params, [OTHER_ID]); assert.equal(workflow, "property_tax_protest"); return rows([data.tax]); }
        if (sql === SQL.updateTax) {
          assert.equal(params.length, 4); expect([params[0], params[2], params[3]], [OTHER_ID, 3, USER_ID]);
          Object.assign(data.tax, { workfile_data: JSON.parse(params[1]), revision: params[2], status: "in_progress",
            updated_by_user_id: params[3], updated_at: NOW }); return rows([data.tax]);
        }
        if (sql === SQL.taxHistory) {
          assert.equal(params.length, 6); expect([params[0], params[1], params[3], params[4], params[5]],
            [OTHER_ID, 3, "in_progress", USER_ID, `Accepted mobile field ${path}`]);
          data.taxHistory.push({ tax_protest_file_id: params[0], revision: params[1], workfile_data: JSON.parse(params[2]),
            status: params[3], changed_by_user_id: params[4], change_summary: params[5] }); return rows();
        }
        assert.fail(`unexpected mobile target-field SQL: ${sql}`);
      } catch (error) {
        if (error !== commitFailure && error !== signatureFailure) failures.push(error);
        throw error;
      }
    },
    release() {
      try { assert.equal(this, client); assert.equal(connected, true); assert.equal(active, false); connected = false; releases += 1; }
      catch (error) { failures.push(error); throw error; }
    },
  };
  const commitFailure = new Error("synthetic_pre_commit_failure_private_detail");
  const pool = {
    async connect() {
      try { assert.equal(connected, false); assert.equal(authQueries.at(-1), SQL.identityTouch); connected = true; connections += 1; return client; }
      catch (error) { failures.push(error); throw error; }
    },
    async query(raw, params = []) {
      const sql = normalizeSql(raw); authQueries.push(sql);
      try {
        assert.equal(connected, false, "only authentication may query the pool outside a transaction"); expect(params, [ISSUER, SUBJECT]);
        if (sql === SQL.identity) return rows(provisioned ? [{ user_id: userId, email: "synthetic@example.test",
          display_name: "Synthetic appraiser", organization_id: organizationId,
          organization_display_name: "Synthetic organization", role_code: role }] : []);
        if (sql === SQL.identityTouch) return rows();
        assert.fail(`unexpected mobile authentication SQL: ${sql}`);
      } catch (error) { failures.push(error); throw error; }
    },
  };
  return {
    pool, queries, authQueries, base, proposed, path, reference,
    verifier: { configured: true, async verify(token) {
      try { assert.equal(token, TOKEN); verified += 1; return { iss: ISSUER, sub: SUBJECT }; }
      catch (error) { failures.push(error); throw error; }
    } },
    snapshot: () => copy(data),
    signAfterReview() {
      assert.equal(active, false); data.workfile.status = "signed"; data.workfile.signed_at = NOW;
      data.signatures.push({ id: FIELD_ID, workfile_id: WORKFILE_ID, revision_number: data.workfile.current_revision,
        signer_role: "appraiser", signer_user_id: USER_ID, signed_at: NOW });
    },
    assertHealthy() { assert.deepEqual(failures, [], "fixture failures must not masquerade as expected HTTP errors"); },
    signatureFaults: () => signatureFaults,
    ownership: () => ({ verified, connections, releases, active, connected }),
  };
}

async function reviewer(context, state) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/mobile", createMobileRouter({ pool: state.pool, verifier: state.verifier,
    enabled: true, security: { apiRateLimitEnabled: false } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  return async ({ decision = "accept", anonymous = false } = {}) => {
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mobile/inspection-sessions/${SESSION_ID}/target-fields/proposals/${PROPOSAL_ID}/review`, {
        method: "POST", headers: { "content-type": "application/json", ...(anonymous ? {} : { authorization: `Bearer ${TOKEN}` }) },
        body: JSON.stringify({ client_operation_id: OPERATION_ID, decision }), signal: AbortSignal.timeout(5_000),
      });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() };
    } finally { state.assertHealthy(); }
  };
}

const statements = (state) => state.queries.map((query) => query.sql);
function assertReleased(state, requests = 1) {
  assert.deepEqual(state.ownership(), { verified: requests, connections: requests, releases: requests, active: false, connected: false });
}
function canonicalSnapshot(state) {
  const { workfile, signatures, values, entities, revisions, audit, artifacts, report, reportEvents, tax, taxHistory } = state.snapshot();
  return { workfile, signatures, values, entities, revisions, audit, artifacts, report, reportEvents, tax, taxHistory };
}

for (const [name, options] of [
  ["signed status / update", { status: "signed" }],
  ["signed_at under validating / insert", { status: "validating", signedAt: NOW, branch: "insert" }],
  ["partial current signature / update", { signatureRevision: 2 }],
  ["historical signature under revised / delete", { status: "revised", signatureRevision: 1, branch: "delete" }],
  ["partial signature / equal-value provenance", { signatureRevision: 2, branch: "equal" }],
  ["signed_at under draft / delete", { status: "draft", signedAt: NOW, branch: "delete" }],
  ["delivered terminal status / insert", { status: "delivered", branch: "insert" }],
  ["unknown status / update", { status: "unexpected_future_status" }],
]) {
  test(`mobile UAD scalar acceptance refuses ${name} with no-store 409 and unchanged complete state`, async (context) => {
    const state = fixture(options), before = state.snapshot();
    const result = await (await reviewer(context, state))();
    assert.deepEqual(result, { status: 409, cacheControl: "no-store", body: { error: "uad_workfile_status_locked" } });
    assert.deepEqual(state.snapshot(), before, "canonical/provenance/history/signatures/audits/proposals/operations remain unchanged");
    assert.equal(statements(state).some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
    assert.equal(statements(state).at(-1), "ROLLBACK"); assert.equal(statements(state).includes("COMMIT"), false);
    assertReleased(state);
  });
}

for (const branch of ["insert", "update", "delete", "equal"]) {
  test(`mobile UAD scalar unsigned ${branch} preserves acceptance, provenance, history and actor semantics`, async (context) => {
    const state = fixture({ branch }), before = state.snapshot();
    const result = await (await reviewer(context, state))();
    const after = state.snapshot();
    assert.equal(result.status, 200); assert.equal(result.body.proposal.status, "accepted");
    assert.deepEqual(result.body.proposal.current, state.proposed);
    assert.deepEqual(result.body.proposal.target_reference, REFERENCE);
    assert.equal(result.body.proposal.applied_target_revision, 3); assert.equal(result.body.report_registry_revision, 4);
    assert.equal(after.workfile.current_revision, 3); assert.equal(after.workfile.status, "draft");
    assert.equal(after.workfile.signed_at, null); assert.equal(after.workfile.updated_by_user_id, USER_ID);
    assert.equal(after.report.registry_revision, 4); assert.equal(after.session.base_report_revision, 4);
    assert.equal(after.session.status, "synchronized"); assert.equal(after.session.review_required_at, null);
    assert.deepEqual(after.signatures, before.signatures); assert.deepEqual(after.entities, before.entities);
    assert.deepEqual(after.artifacts, before.artifacts); assert.deepEqual(after.tax, before.tax); assert.deepEqual(after.taxHistory, []);
    if (branch === "delete") assert.deepEqual(after.values, []);
    else {
      assert.equal(after.values.length, 1);
      const value = after.values[0];
      assert.equal(value.value, state.proposed.value); assert.equal(value.source_type, "appraiser");
      assert.equal(value.source_reference, "mobile_target_adapter"); assert.equal(value.is_appraiser_confirmed, true);
      assert.equal(value.updated_by_user_id, USER_ID); assert.equal(value.is_override, branch === "update");
      assert.equal(value.override_reason, branch === "update" ? "Appraiser accepted a mobile inspection observation." : null);
      if (branch !== "insert") assert.equal(value.id, FIELD_ID);
    }
    assert.equal(after.revisions.length, before.revisions.length + 1);
    assert.deepEqual(after.revisions.slice(0, -1), before.revisions);
    assert.deepEqual(after.revisions.at(-1).document, { entities: after.entities,
      field_values: after.values.map((item) => ({ entity_id: item.entity_id, uid: item.uad_uid,
        context_key: item.field_context, report_field_id: item.report_field_id, value: item.value,
        source_type: item.source_type, is_appraiser_confirmed: item.is_appraiser_confirmed })) });
    assert.deepEqual(after.audit.slice(0, -1), before.audit);
    assert.deepEqual(after.audit.at(-1), { workfile_id: WORKFILE_ID, actor_user_id: USER_ID,
      event_type: "uad_mobile_field.accepted", entity_type: "uad_field", entity_id: null,
      before_data: { field_path: FIELD_PATH, state: state.base }, after_data: { field_path: FIELD_PATH, state: state.proposed },
      metadata: { revision_number: 3, proposal_id: PROPOSAL_ID, context_key: FIELD.contextKey, uid: FIELD.uid } });
    assert.equal(after.events.length, 1); assert.equal(after.events[0].actor_user_id, USER_ID);
    assert.equal(after.events[0].event_type, "target_adapter.proposal_accepted");
    assert.equal(after.reportEvents.length, 1); assert.equal(after.reportEvents[0].actor_user_id, USER_ID);
    assert.equal(after.proposal.reviewed_by_user_id, USER_ID);
    assert.deepEqual(after.operations, [{ inspection_session_id: SESSION_ID, proposal_id: PROPOSAL_ID,
      client_operation_id: OPERATION_ID, request_sha256: hashRequest("accept"), decision: "accept", status: "applied",
      result: result.body, actor_user_id: USER_ID }]);
    assert.equal(statements(state).at(-1), "COMMIT"); assertReleased(state);
  });
}

test("mobile UAD scalar review owns explicit READ COMMITTED before session/workfile reads", async (context) => {
  const state = fixture(); const result = await (await reviewer(context, state))();
  assert.equal(result.status, 200); assert.equal(statements(state)[0], RC);
  assert.equal(statements(state)[1], SQL.session); assertReleased(state);
});

test("mobile UAD scalar rejection after signing records review without canonical mutation", async (context) => {
  const state = fixture({ status: "signed", signedAt: NOW, signatureRevision: 2 });
  const before = canonicalSnapshot(state);
  const result = await (await reviewer(context, state))({ decision: "reject" });
  assert.equal(result.status, 200); assert.equal(result.body.proposal.status, "rejected");
  assert.deepEqual(canonicalSnapshot(state), before); assert.equal(result.body.report_registry_revision, 3);
  const after = state.snapshot(); assert.equal(after.proposal.reviewed_by_user_id, USER_ID);
  assert.equal(after.operations.length, 1); assert.equal(after.operations[0].request_sha256, hashRequest("reject"));
  assert.equal(after.events[0].event_type, "target_adapter.proposal_rejected");
  assert.equal(statements(state).includes(SQL.signatures), false); assertReleased(state);
});

for (const decision of ["accept", "reject"]) {
  test(`mobile UAD scalar exact ${decision} replay after signing returns stored result without new writes`, async (context) => {
    const state = fixture(), review = await reviewer(context, state);
    const original = await review({ decision }); assert.equal(original.status, 200);
    state.signAfterReview(); const before = state.snapshot(), queryStart = state.queries.length;
    const replay = await review({ decision }); assert.deepEqual(replay, original); assert.deepEqual(state.snapshot(), before);
    const replaySql = statements(state).slice(queryStart);
    assert.ok(["BEGIN", RC].includes(replaySql[0]));
    assert.deepEqual(replaySql.slice(1), [SQL.session, SQL.operation, "COMMIT"]); assertReleased(state, 2);
  });
}

test("mobile UAD scalar stale acceptance after signing records conflict but never changes canonical data", async (context) => {
  const state = fixture({ stale: true, status: "signed", signedAt: NOW, signatureRevision: 2 });
  const before = canonicalSnapshot(state), result = await (await reviewer(context, state))();
  assert.equal(result.status, 200); assert.equal(result.body.proposal.status, "conflict");
  assert.deepEqual(result.body.proposal.conflict.base, state.base);
  assert.deepEqual(result.body.proposal.conflict.current, { exists: true, value: "Concurrent desktop observation" });
  assert.ok(Number.isFinite(Date.parse(result.body.proposal.conflict.detected_at)));
  assert.deepEqual(canonicalSnapshot(state), before); assert.equal(result.body.report_registry_revision, 3);
  const after = state.snapshot(); assert.equal(after.operations[0].status, "conflict");
  assert.equal(after.events[0].event_type, "target_adapter.proposal_conflict");
  assert.equal(after.session.status, "review_required"); assert.equal(statements(state).includes(SQL.signatures), false);
  assertReleased(state);
});

for (const [name, options, request, expected, verified, authCount, connections] of [
  ["anonymous", {}, { anonymous: true }, { status: 401, error: "invalid_access_token" }, 0, 0, 0],
  ["unprovisioned", { provisioned: false }, {}, { status: 403, error: "mobile_identity_not_provisioned" }, 1, 1, 0],
  ["viewer", { role: "viewer" }, {}, { status: 403, error: "mobile_write_role_required" }, 1, 2, 0],
  ["wrong actor", { wrongActor: true }, {}, { status: 404, error: "target_field_session_not_found" }, 1, 2, 1],
  ["foreign organization", { foreignOrganization: true }, {}, { status: 404, error: "target_field_session_not_found" }, 1, 2, 1],
]) {
  test(`mobile UAD scalar ${name} denial precedes proposal and canonical access`, async (context) => {
    const state = fixture(options), before = state.snapshot();
    const result = await (await reviewer(context, state))(request);
    assert.equal(result.status, expected.status); assert.deepEqual(result.body, { error: expected.error });
    assert.deepEqual(state.snapshot(), before); assert.equal(state.authQueries.length, authCount);
    assert.deepEqual(state.ownership(), { verified, connections, releases: connections, active: false, connected: false });
    if (connections) assert.deepEqual(statements(state).slice(1), [SQL.session, "ROLLBACK"]);
    else assert.deepEqual(state.queries, []);
  });
}

test("mobile UAD scalar operation-id collision after signing rejects changed decision before target access", async (context) => {
  const state = fixture(), review = await reviewer(context, state);
  assert.equal((await review()).status, 200); state.signAfterReview();
  const before = state.snapshot(), queryStart = state.queries.length;
  const result = await review({ decision: "reject" });
  assert.equal(result.status, 409); assert.deepEqual(result.body, { error: "client_operation_id_conflict" });
  assert.deepEqual(state.snapshot(), before);
  assert.deepEqual(statements(state).slice(queryStart + 1), [SQL.session, SQL.operation, "ROLLBACK"]); assertReleased(state, 2);
});

test("mobile UAD scalar pre-COMMIT failure rolls back every modeled mutation and stays generic", async (context) => {
  const state = fixture({ failBeforeCommit: true }), before = state.snapshot();
  const result = await (await reviewer(context, state))();
  assert.equal(result.status, 500); assert.deepEqual(result.body, { error: "mobile_request_failed" });
  assert.ok(statements(state).includes(SQL.insertOperation), "failure happens after actual modeled canonical and review writes");
  assert.deepEqual(state.snapshot(), before); assert.deepEqual(statements(state).slice(-2), ["COMMIT", "ROLLBACK"]);
  assertReleased(state);
});

test("mobile Property Tax scalar acceptance remains independent of UAD lifecycle and preserves tax history", async (context) => {
  const state = fixture({ workflow: "property_tax_protest", status: "signed", signedAt: NOW, signatureRevision: 2 });
  const before = state.snapshot(), result = await (await reviewer(context, state))();
  const after = state.snapshot(); assert.equal(result.status, 200); assert.equal(result.body.proposal.status, "accepted");
  assert.equal(after.tax.workfile_data.subject.condition_notes, state.proposed.value); assert.equal(after.tax.workfile_data.untouched, true);
  assert.equal(after.tax.revision, 3); assert.equal(after.tax.updated_by_user_id, USER_ID);
  assert.equal(after.taxHistory.length, 1); assert.equal(after.taxHistory[0].changed_by_user_id, USER_ID);
  assert.deepEqual(after.taxHistory[0].workfile_data, after.tax.workfile_data);
  for (const key of ["workfile", "signatures", "values", "entities", "revisions", "audit", "artifacts"]) assert.deepEqual(after[key], before[key]);
  assert.equal(statements(state).some((sql) => sql.includes("appraisal.")), false);
  assert.equal(result.body.report_registry_revision, 4); assertReleased(state);
});

for (const [name, signatureResult] of [
  ["missing rows", {}],
  ["empty rows", { rows: [] }],
  ["missing boolean", { rows: [{}] }],
  ["non-boolean false", { rows: [{ has_signatures: "false" }] }],
  ["multiple rows", { rows: [{ has_signatures: false }, { has_signatures: false }] }],
]) {
  test(`mobile scalar supplemental malformed signature result ${name} refuses no-store 409 before writes`, async (context) => {
    const state = fixture({ signatureResult }), before = state.snapshot();
    const result = await (await reviewer(context, state))();
    assert.deepEqual(result, { status: 409, cacheControl: "no-store", body: { error: "uad_workfile_status_locked" } });
    assert.deepEqual(state.snapshot(), before);
    assert.equal(statements(state).filter((sql) => sql === SQL.signatures).length, 1);
    assert.equal(statements(state).some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
    assert.equal(statements(state).at(-1), "ROLLBACK"); assert.equal(state.signatureFaults(), 0); assertReleased(state);
  });
}

test("mobile scalar supplemental genuine signature-query failure remains generic 500 and rolls back before writes", async (context) => {
  const signatureFailure = new Error("synthetic_signature_query_private_detail");
  const state = fixture({ signatureFailure }), before = state.snapshot();
  const result = await (await reviewer(context, state))();
  // Existing shared router adds no-store only to the locked error, not arbitrary
  // backend failures. Preserve that boundary rather than enlarging this repair.
  assert.deepEqual(result, { status: 500, cacheControl: null, body: { error: "mobile_request_failed" } });
  assert.equal(state.signatureFaults(), 1, "the specifically injected query error must actually be reached");
  assert.deepEqual(state.snapshot(), before);
  assert.equal(statements(state).some((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
  assert.equal(statements(state).at(-1), "ROLLBACK"); assertReleased(state);
});

test("mobile scalar supplemental Property Tax rejection preserves tax data and history with zero UAD SQL", async (context) => {
  const state = fixture({ workflow: "property_tax_protest", status: "signed", signedAt: NOW, signatureRevision: 2 });
  const before = canonicalSnapshot(state);
  const result = await (await reviewer(context, state))({ decision: "reject" });
  assert.equal(result.status, 200); assert.equal(result.body.proposal.status, "rejected");
  assert.equal(result.body.report_registry_revision, 3); assert.deepEqual(canonicalSnapshot(state), before);
  const after = state.snapshot(); assert.equal(after.taxHistory.length, 0);
  assert.equal(after.operations.length, 1); assert.equal(after.operations[0].request_sha256, hashRequest("reject"));
  assert.equal(after.operations[0].actor_user_id, USER_ID); assert.deepEqual(after.operations[0].result, result.body);
  assert.equal(after.events.length, 1); assert.equal(after.events[0].event_type, "target_adapter.proposal_rejected");
  assert.equal(statements(state).some((sql) => sql.includes("appraisal.")), false); assertReleased(state);
});

for (const decision of ["accept", "reject"]) {
  test(`mobile scalar supplemental Property Tax exact ${decision} replay preserves history with zero UAD SQL`, async (context) => {
    const state = fixture({ workflow: "property_tax_protest", status: "signed", signedAt: NOW, signatureRevision: 2 });
    const review = await reviewer(context, state), original = await review({ decision });
    assert.equal(original.status, 200); assert.equal(original.body.proposal.status, decision === "accept" ? "accepted" : "rejected");
    const before = state.snapshot(), queryStart = state.queries.length;
    assert.equal(before.taxHistory.length, decision === "accept" ? 1 : 0);
    const replay = await review({ decision });
    assert.deepEqual(replay, original); assert.deepEqual(state.snapshot(), before);
    assert.deepEqual(statements(state).slice(queryStart + 1), [SQL.session, SQL.operation, "COMMIT"]);
    assert.equal(statements(state).some((sql) => sql.includes("appraisal.")), false); assertReleased(state, 2);
  });
}
