import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from "../../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { captureCustomNeighborhoodDraftReportBinding } from "../../src/services/neighborhoodAssessment/customDraftReportBinding.js";

/** Native PostgreSQL checks, called only by the existing guarded integration
 * harness after its atomic-save/editor-read checks. Both clients are real and
 * idle on entry; no query doubles, alternate database bootstraps or migrations.
 * All mutation probes roll back. These checks are not execution evidence until
 * the ordinary native integration path actually runs them successfully.
 */
export async function checkCustomNeighborhoodDraftBindingDatabase(client, observer, identity) {
  const checks = [];
  const assignmentFileId = identity.customId, accountId = identity.scope.account_id;
  const sectionKey = CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION;
  // The preceding editor-read check commits a second group. Read the actual
  // current row, never the initial acceptance or a latest account-level result.
  const current = await observer.query(`SELECT revision,section_value
    FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key=$2`,
  [assignmentFileId, sectionKey]);
  assert.equal(current.rowCount, 1);
  const section = { revision: Number(current.rows[0].revision), value: current.rows[0].section_value };
  assert.equal(section.revision, section.value.accepted_editor_revision);
  assert.ok(section.revision > 1, "The draft binding checks must use the newly committed editor-read group");
  const input = { assignmentFileId, accountId, section };
  const expected = { report_files: [{ id: identity.customReportId, organization_id: identity.scope.organization_id,
    account_id: accountId, workflow_type: "custom_appraisal", custom_assignment_file_id: assignmentFileId,
    uad_workfile_id: null, tax_protest_file_id: null }] };
  const assertBinding = async connection => {
    const binding = await captureCustomNeighborhoodDraftReportBinding(connection, input);
    assert.equal(binding.report_files.length, 1);
    assert.deepEqual({ report_files: binding.report_files.map(row => ({ ...row,
      custom_assignment_file_id: Number(row.custom_assignment_file_id) })) }, expected);
  };
  const persistedState = async () => (await observer.query(`SELECT to_jsonb(f) AS assignment,
    (SELECT to_jsonb(w) FROM app.custom_appraisal_workfiles w WHERE w.assignment_file_id=f.id) AS workfile,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.section_key) FROM app.custom_appraisal_workfile_sections s WHERE s.assignment_file_id=f.id) AS sections,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM app.custom_appraisal_workfile_section_history h WHERE h.assignment_file_id=f.id) AS history,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM app.custom_neighborhood_acceptances a WHERE a.assignment_file_id=f.id) AS acceptances,
    (SELECT to_jsonb(r) FROM app.report_files r WHERE r.id=$2) AS report,
    (SELECT to_jsonb(c) FROM app.appraisal_cases c WHERE c.id=$3) AS appraisal_case,
    (SELECT to_jsonb(s) FROM app.appraisal_subject_snapshots s WHERE s.id=$4) AS subject_snapshot
    FROM app.assignment_files f WHERE f.id=$1`,
  [assignmentFileId, identity.customReportId, identity.scope.appraisal_case_id, identity.scope.subject_snapshot_id])).rows[0];
  const original = await persistedState();
  assert.ok(original);
  assert.ok(original.acceptances.some(row => row.operation_id === section.value.operation_id
    && row.accepted_editor_revision === section.revision));
  assert.equal(original.report.id, identity.customReportId);
  assert.equal(original.report.organization_id, identity.scope.organization_id);
  assert.equal(original.report.account_id, accountId);
  assert.equal(Number(original.report.custom_assignment_file_id), assignmentFileId);
  const rollbackProbe = async (action, { readOnly = false } = {}) => {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    try { await action(); }
    finally { await client.query("ROLLBACK"); }
    assert.deepEqual(await persistedState(), original, "The probe must leave the entire persisted group and identity unchanged");
    await assertBinding(observer);
  };
  const rejectsBinding = options => assert.rejects(
    captureCustomNeighborhoodDraftReportBinding(client, options),
    /custom_neighborhood_saved_group_unavailable/,
  );

  await rollbackProbe(async () => {
    const mode = (await client.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0];
    assert.equal(mode.read_only, "on");
    await assertBinding(client);
  }, { readOnly: true });
  checks.push("draft_binding_exact_current_group_matches_independent_report_identity_read_only");

  await rollbackProbe(() => rejectsBinding({ ...input, section: undefined }), { readOnly: true });
  checks.push("draft_binding_absent_response_cannot_hide_present_current_group");

  await rollbackProbe(async () => {
    assert.equal((await client.query(`DELETE FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1 AND section_key=$2`, [assignmentFileId, sectionKey])).rowCount, 1);
    const retained = (await client.query(`SELECT count(*)::int AS count FROM app.custom_neighborhood_acceptances
      WHERE assignment_file_id=$1`, [assignmentFileId])).rows[0].count;
    assert.equal(retained, original.acceptances.length);
    await rejectsBinding({ ...input, section: undefined });
    await rejectsBinding(input);
  });
  checks.push("draft_binding_missing_current_section_with_retained_acceptance_never_enables_legacy");

  for (const [name, changed] of [
    ["changed_section_value", { ...input, section: { ...section, value: { ...section.value, native_probe: true } } }],
    // Keep the input wrapper internally consistent so PostgreSQL, not just the
    // helper's representation check, must reject this different saved revision.
    ["changed_section_revision", { ...input, section: { revision: section.revision + 1,
      value: { ...section.value, accepted_editor_revision: section.revision + 1 } } }],
    ["changed_operation", { ...input, section: { ...section, value: { ...section.value, operation_id: randomUUID() } } }],
    ["other_account", { ...input, accountId: identity.accounts[1] }],
  ]) {
    await rollbackProbe(() => rejectsBinding(changed), { readOnly: true });
    checks.push(`draft_binding_rejects_${name}_without_mutation`);
  }

  // Allocate an isolated never-accepted file only within this rollback probe,
  // using the harness's existing synthetic organization/account/user identity.
  // No existing assignment or acceptance is erased to manufacture legacy state.
  let legacyAssignmentFileId;
  await rollbackProbe(async () => {
    const created = (await client.query(`INSERT INTO app.assignment_files
      (organization_id,account_id,file_number,created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [identity.scope.organization_id, accountId, `PG-draft-legacy-${randomUUID()}`, identity.actor_user_id])).rows[0];
    legacyAssignmentFileId = Number(created.id);
    await client.query(`INSERT INTO app.custom_appraisal_workfiles (assignment_file_id,canonical_file_name)
      VALUES ($1,$2)`, [legacyAssignmentFileId, `synthetic-draft-legacy-${randomUUID()}`]);
    const legacyInput = { assignmentFileId: legacyAssignmentFileId, accountId, section: undefined };
    assert.equal(await captureCustomNeighborhoodDraftReportBinding(client, legacyInput), null);
    await rejectsBinding({ ...legacyInput, section });
  });
  assert.equal((await observer.query("SELECT id FROM app.assignment_files WHERE id=$1", [legacyAssignmentFileId])).rowCount, 0);
  checks.push("draft_binding_never_accepted_legacy_file_has_authoritative_absence");
  checks.push("draft_binding_same_account_other_assignment_cannot_reuse_saved_group");

  for (const [name, mutate] of [
    ["case_date_changed", async () => {
      assert.equal((await client.query("UPDATE app.appraisal_cases SET effective_date=effective_date+1 WHERE id=$1",
        [identity.scope.appraisal_case_id])).rowCount, 1);
    }],
    ["snapshot_date_changed", async () => {
      assert.equal((await client.query("UPDATE app.appraisal_subject_snapshots SET effective_date=effective_date+1 WHERE id=$1",
        [identity.scope.subject_snapshot_id])).rowCount, 1);
    }],
    ["both_dates_changed_consistently", async () => {
      assert.equal((await client.query("UPDATE app.appraisal_cases SET effective_date=effective_date+1 WHERE id=$1",
        [identity.scope.appraisal_case_id])).rowCount, 1);
      assert.equal((await client.query("UPDATE app.appraisal_subject_snapshots SET effective_date=effective_date+1 WHERE id=$1",
        [identity.scope.subject_snapshot_id])).rowCount, 1);
    }],
    ["effective_date_unresolved", async () => {
      assert.equal((await client.query("UPDATE app.appraisal_cases SET effective_date=NULL WHERE id=$1",
        [identity.scope.appraisal_case_id])).rowCount, 1);
      assert.equal((await client.query("UPDATE app.appraisal_subject_snapshots SET effective_date=NULL WHERE id=$1",
        [identity.scope.subject_snapshot_id])).rowCount, 1);
    }],
  ]) {
    await rollbackProbe(async () => { await mutate(); await rejectsBinding(input); });
    checks.push(`draft_binding_rejects_${name}_and_rollback_restores_original_binding`);
  }
  return checks;
}
