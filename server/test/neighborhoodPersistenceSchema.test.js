import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const sql = await fs.readFile(new URL("../migrations/20261010_neighborhood_assessment_persistence.sql", import.meta.url), "utf8");
// These are structural guardrails, NOT PostgreSQL runtime/concurrency evidence.
// The released migration requires the separately isolated real-PG acceptance set.
test("migration persists only new neighborhood tables with explicit canonical prerequisites", () => {
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map(match => match[1]);
  assert.equal(tables.length, 8);
  assert.ok(tables.every(name => /^app\.neighborhood_assessment/.test(name)));
  for (const dependency of ["app_auth.organizations", "app_auth.users", "core.accounts", "app.appraisal_cases",
    "app.appraisal_subject_snapshots", "app.report_files", "app.assignment_files", "appraisal.uad_workfiles",
    "appraisal.uad_revisions", "appraisal.uad_audit_events"]) {
    assert.ok(sql.includes(`'${dependency}'`));
  }
  assert.match(sql, /neighborhood_identity_prerequisite_missing/);
  assert.doesNotMatch(sql, /(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:gis\.|app\.report_files\b|app\.appraisal_cases\b|app\.appraisal_subject_snapshots\b)/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK);/m);
});

test("scope is immutable, parent-locked and uses explicit captured date resolution", () => {
  assert.match(sql, /FOR SHARE OF c, s/);
  assert.match(sql, /canonical\.organization_id IS DISTINCT FROM organization/);
  assert.match(sql, /canonical\.account_id IS DISTINCT FROM account/);
  assert.match(sql, /neighborhood_scope_immutable/);
  assert.match(sql, /COALESCE\(canonical\.snapshot_date, canonical\.case_date\)/);
  assert.match(sql, /neighborhood_unresolved_effective_date/);
  assert.match(sql, /canonical\.snapshot_date <> canonical\.case_date/);
});

test("heads, jobs, revisions and members use same-assessment composite identities", () => {
  assert.match(sql, /UNIQUE \(assessment_id, input_signature_sha256\)/);
  assert.match(sql, /FOREIGN KEY \(id, requested_job_id\) REFERENCES app\.neighborhood_assessment_jobs\(assessment_id, id\)/);
  assert.match(sql, /FOREIGN KEY \(id, current_revision\) REFERENCES app\.neighborhood_assessment_revisions\(assessment_id, revision\)/);
  assert.match(sql, /FOREIGN KEY \(assessment_id, revision, population_id, member_unit\)\s+REFERENCES app\.neighborhood_assessment_populations\(assessment_id, revision, population_id, member_unit\)/);
  assert.match(sql, /PRIMARY KEY \(assessment_id, revision, population_id, member_id\)/);
  assert.match(sql, /neighborhood_valid_member_accounts/);
  assert.match(sql, /count\(\*\) = count\(DISTINCT account_id\)/);
  assert.match(sql, /population->>'kind' = 'transactions' AND member_unit IN \('canonical_transaction', 'allocated_property_sale'\)/);
});

test("publication cannot bypass staging, child completeness or source manifests", () => {
  for (const code of ["neighborhood_revision_must_stage", "neighborhood_revision_immutable",
    "neighborhood_published_child_immutable", "neighborhood_population_manifest_mismatch",
    "neighborhood_source_manifest_mismatch", "neighborhood_source_reference_missing",
    "neighborhood_exact_member_counts_mismatch", "neighborhood_current_revision_not_published"]) assert.ok(sql.includes(code));
  assert.match(sql, /sum\(cardinality\(account_ids\)\)/);
  assert.match(sql, /count\(DISTINCT account_id\) INTO properties/);
  assert.match(sql, /population_row\.member_count <> members/);
  assert.match(sql, /population_row\.property_link_count <> links/);
  assert.match(sql, /population_row\.unique_property_count <> properties/);
  assert.match(sql, /NEW\.published_at := clock_timestamp\(\)/);
});

test("jobs store fresh claim authority but do not pretend a worker-name shape check is fencing", () => {
  // Required real-PG oracle: two clients overlap a head-locked publication with
  // heartbeat/reclaim. Assert no lock-order deadlock and no stale-token publish.
  assert.match(sql, /claim_token uuid/);
  assert.match(sql, /lease_expires_at timestamptz/);
  assert.match(sql, /request_generation integer NOT NULL CHECK/);
  assert.match(sql, /CHECK \(attempts <= max_attempts\)/);
  assert.match(sql, /status <> 'running' AND claim_token IS NULL AND lease_expires_at IS NULL/);
  assert.match(sql, /lease_expires_at IS NOT NULL AND attempts >= 1/);
  assert.match(sql, /WHERE status IN \('queued', 'retry'\)/);
  assert.match(sql, /repository UPDATE/);
  assert.doesNotMatch(sql, /worker_id\s+(?:text|uuid)/);
  const jobGuard = sql.slice(sql.indexOf("FUNCTION app.neighborhood_guard_job()"), sql.indexOf("FUNCTION app.neighborhood_guard_revision_child()"));
  assert.doesNotMatch(jobGuard, /FROM app\.neighborhood_assessments[^;]*FOR SHARE/);
});

test("sources are captured within revision scope and bounded independently of optional providers", () => {
  assert.match(sql, /PRIMARY KEY \(assessment_id, revision, source_id\)/);
  assert.match(sql, /source_payload jsonb NOT NULL CHECK \(jsonb_typeof\(source_payload\) = 'object' AND octet_length\(source_payload::text\) <= 1500000\)/);
  assert.match(sql, /neighborhood_private_source_scope_mismatch/);
  assert.doesNotMatch(sql, /REFERENCES\s+gis\./i);
  assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE EXTENSION/i);
});

test("target attachments check both report registry and actual workflow target", () => {
  assert.match(sql, /mapped_suggestions jsonb NOT NULL CHECK \(jsonb_typeof\(mapped_suggestions\) = 'array' AND octet_length\(mapped_suggestions::text\) <= 1500000\)/);
  assert.match(sql, /report\.subject_snapshot_id IS DISTINCT FROM head\.subject_snapshot_id/);
  assert.match(sql, /report\.appraisal_case_id IS DISTINCT FROM head\.appraisal_case_id/);
  assert.match(sql, /target_organization IS DISTINCT FROM head\.organization_id/);
  assert.match(sql, /target_account IS DISTINCT FROM head\.account_id/);
  assert.match(sql, /WHERE id = NEW\.custom_assignment_file_id FOR SHARE/);
  assert.match(sql, /WHERE id = NEW\.uad_workfile_id FOR SHARE/);
  assert.match(sql, /neighborhood_attachment_manifest_mismatch/);
});

test("receipts are immutable, exact-target-bound, operation-deduplicated and revision-typed", () => {
  assert.match(sql, /FOREIGN KEY \(attachment_id, attachment_revision, report_file_id, application_identity_sha256\)/);
  assert.match(sql, /UNIQUE \(report_file_id, operation_id\)/);
  assert.match(sql, /UNIQUE \(report_file_id, application_identity_sha256\)/);
  assert.match(sql, /neighborhood_application_immutable/);
  assert.match(sql, /NEW\.accepted_editor_revision <= base_revision/);
  assert.match(sql, /attachment_row\.workflow_type = 'uad_3_6' THEN 1 ELSE 0/);
  assert.doesNotMatch(sql, /registry_revision\s*(?:=|<>|>|<)/);
});

test("UAD receipts reference the exact accepted revision and actor audit event", () => {
  assert.match(sql, /uad_revision_id uuid REFERENCES appraisal\.uad_revisions\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /uad_audit_event_id bigint REFERENCES appraisal\.uad_audit_events\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /neighborhood_uad_acceptance_identity_required/);
  assert.match(sql, /uad_revision\.workfile_id IS DISTINCT FROM attachment_row\.uad_workfile_id/);
  assert.match(sql, /uad_revision\.revision_number IS DISTINCT FROM NEW\.accepted_editor_revision/);
  assert.match(sql, /uad_revision\.created_by_user_id IS DISTINCT FROM NEW\.actor_user_id/);
  assert.match(sql, /uad_event\.workfile_id IS DISTINCT FROM attachment_row\.uad_workfile_id/);
  assert.match(sql, /uad_event\.actor_user_id IS DISTINCT FROM NEW\.actor_user_id/);
  assert.match(sql, /neighborhood_custom_uad_identity_forbidden/);
});
