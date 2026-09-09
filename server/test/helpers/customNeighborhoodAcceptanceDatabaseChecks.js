import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { buildNeighborhoodAttachment, canonicalAssessmentJson } from "../../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest,
  prepareNeighborhoodApplicationGroup } from "../../src/services/neighborhoodAssessment/applicationGroup.js";
import { persistNeighborhoodAttachment } from "../../src/services/neighborhoodAssessment/applicationRepository.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "../../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { getCustomNeighborhoodAcceptance, recordCustomNeighborhoodAcceptance } from "../../src/services/neighborhoodAssessment/customAcceptanceRepository.js";
import { neighborhoodTargetFixture } from "../fixtures/neighborhoodAssessmentFixture.js";
import { saveCustomNeighborhoodAcceptanceInTransaction } from "../../src/services/neighborhoodAssessment/customAcceptanceSave.js";
import { saveCustomAppraisalWorkfileSection } from "../../src/services/customAppraisalWorkfiles.js";

/** Real published synthetic assessment/identity supplied by the native harness.
 * Direct section/history SQL below simulates the owner transaction only. These
 * assertions do not claim route authorization, real catalog validation, or live
 * integration with the separately reviewed transaction-save entrypoint.
 */
export async function checkCustomNeighborhoodAcceptanceDatabase(pool, identity, assessment, { atomicSave = false } = {}) {
  const group = assessment.application_group;
  const mappedSuggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: "North Road", dependency_ids: ["source"],
      evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["boundary", "source"],
      evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:market-source", value: "Synthetic neighborhood source", dependency_ids: [],
      evidence_refs: group.source_refs.map(id => `source:${id}`), application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, { ...neighborhoodTargetFixture("custom_appraisal"),
    scope: identity.scope, attachment_id: randomUUID(), report_file_id: identity.customReportId,
    custom_assignment_file_id: identity.customId, editor_revision: 0,
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(mappedSuggestions) });
  const plan = prepareNeighborhoodApplicationGroup({ attachment, group, suggestions: mappedSuggestions,
    selected_ids: mappedSuggestions.map(item => item.id), expected_binding_digest: attachment.binding_digest_sha256,
    current_application_identity_sha256: attachment.application_identity_sha256, current_editor_revision: 0,
    existing_values: mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    validate_final_group: () => ({ valid: true, issues: [] }) });
  assert.equal(plan.status, "ready");
  const operationId = randomUUID(), receipt = buildNeighborhoodApplicationReceipt(plan, 1);
  const snapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment, mappedSuggestions,
    actorUserId: identity.actor_user_id, operationId, receipt });
  const lookup = { organizationId: identity.scope.organization_id, reportFileId: identity.customReportId,
    assignmentFileId: identity.customId, operationId };
  const input = { ...lookup, actorUserId: identity.actor_user_id, attachmentId: attachment.attachment_id,
    attachmentRevision: attachment.attachment_revision, receipt, sectionHistoryId: "1" };
  const client = await pool.connect(), other = await pool.connect();
  const checks = [];
  const count = async () => Number((await other.query("SELECT count(*) AS count FROM app.custom_neighborhood_acceptances WHERE report_file_id=$1", [identity.customReportId])).rows[0].count);
  const beginOwner = async (sectionValue = snapshot.section_value) => {
    await client.query("BEGIN");
    await client.query(`INSERT INTO app.custom_appraisal_workfiles (assignment_file_id,canonical_file_name)
      VALUES ($1,$2) ON CONFLICT (assignment_file_id) DO NOTHING`, [identity.customId, `Synthetic acceptance ${randomUUID()}`]);
    await client.query(`INSERT INTO app.custom_appraisal_workfile_sections
      (assignment_file_id,section_key,section_value,revision,updated_by) VALUES ($1,$2,$3::jsonb,1,'Synthetic reviewer')`,
    [identity.customId, snapshot.section_key, canonicalAssessmentJson(sectionValue)]);
    const history = (await client.query(`INSERT INTO app.custom_appraisal_workfile_section_history
      (assignment_file_id,section_key,section_value,revision,event_type,changed_by)
      VALUES ($1,$2,$3::jsonb,1,'manual_save','Synthetic reviewer') RETURNING id`,
    [identity.customId, snapshot.section_key, canonicalAssessmentJson(sectionValue)])).rows[0];
    return { ...input, sectionHistoryId: String(history.id) };
  };
  const rejectedInTransaction = async (action, expected) => {
    await client.query("BEGIN");
    try { await assert.rejects(action, expected); }
    finally { await client.query("ROLLBACK"); }
  };
  // Deliberately bypass the JS writer: the native SQL boundary must reject
  // malformed persisted decisions before making their history immutable.
  const directInsert = async (owner, sectionValue, text = JSON.stringify(sectionValue), identifiers = {}) => client.query(`
    INSERT INTO app.custom_neighborhood_acceptances
      (id,organization_id,report_file_id,assignment_file_id,account_id,attachment_id,attachment_revision,
       application_identity_sha256,operation_id,actor_user_id,section_key,section_history_id,
       accepted_editor_revision,section_bytes_sha256,section_json_utf8,decision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
  [identifiers.id ?? randomUUID(), identifiers.organization_id ?? identity.scope.organization_id,
    identifiers.report_file_id ?? identity.customReportId, identity.customId, assessment.scope.account_id,
    identifiers.attachment_id ?? attachment.attachment_id, attachment.attachment_revision, attachment.application_identity_sha256,
    identifiers.operation_id ?? operationId, identifiers.actor_user_id ?? identity.actor_user_id,
    snapshot.section_key, owner.sectionHistoryId, 1,
    createHash("sha256").update(text, "utf8").digest("hex"), text, JSON.stringify(sectionValue.decision)]);
  try {
    await client.query("BEGIN");
    await persistNeighborhoodAttachment(client, { assessment, attachment, mappedSuggestions });
    await client.query("COMMIT");
    if (atomicSave) {
      const { sectionHistoryId: _history, ...request } = input;
      return await checkAtomicSave(client, other, request, snapshot, lookup);
    }
    await assert.rejects(recordCustomNeighborhoodAcceptance(client, input), /SAVEPOINT can only be used in transaction blocks/i);
    assert.equal(await count(), 0);
    checks.push("explicit_transaction_required");

    for (const field of ["id", "operation_id", "organization_id", "report_file_id", "attachment_id", "actor_user_id"]) {
      for (const invalid of ["00000000-0000-0000-0000-000000000000",
        "00000000-0000-9000-8000-000000000001", "00000000-0000-4000-7000-000000000001"]) {
        const changed = structuredClone(snapshot.section_value);
        if (Object.hasOwn(changed, field)) changed[field] = invalid;
        const owner = await beginOwner(changed);
        try {
          await assert.rejects(directInsert(owner, changed, JSON.stringify(changed), { [field]: invalid }),
            /custom_neighborhood_acceptance_invalid_identifier/);
        } finally { await client.query("ROLLBACK"); }
        assert.equal(await count(), 0);
      }
      checks.push(`direct_sql_rejects_invalid_${field}`);
    }
    const versionEightOwner = await beginOwner();
    const versionEightId = "00000000-0000-8000-8000-000000000001";
    try {
      await directInsert(versionEightOwner, snapshot.section_value, JSON.stringify(snapshot.section_value), { id: versionEightId });
      const versionEight = await getCustomNeighborhoodAcceptance(client, lookup);
      assert.equal(versionEight.id, versionEightId);
      assert.deepEqual(versionEight.snapshot, snapshot);
    } finally { await client.query("ROLLBACK"); }
    assert.equal(await count(), 0);
    checks.push("direct_sql_valid_uuid_version_eight_reopens");

    for (const [name, mutate] of [
      ["injected_receipt", value => { value.receipt = { ...receipt, receipt_digest_sha256: "0".repeat(64) }; }],
      ["extra_decision_keys", value => { value.decision.receipt_digest_sha256 = "a".repeat(64); }],
      ["extra_manifest_keys", value => { value.decision.acceptance_manifest = receipt.acceptance_manifest; }],
      ["missing_member", value => { delete value.decision.applied.boundary; }],
      ["overlapping_member", value => { value.decision.reused.boundary = true; }],
      ["false_member", value => { value.decision.applied.boundary = false; }],
      ["unknown_member", value => { value.decision.applied.unknown = true; }],
      ["no_applied_members", value => { value.decision.reused = value.decision.applied; value.decision.applied = {}; }],
      ["changed_mapped_value", value => { value.mapped_values.median.value += 1; }],
      ["extra_mapped_field", value => { value.mapped_values.median.provenance_digest = "a".repeat(64); }],
      ["missing_mapped_value", value => { delete value.mapped_values.boundary; }],
      ["invalid_membership_type", value => { value.decision.applied = ["boundary", "median", "source"]; }],
    ]) {
      const changed = structuredClone(snapshot.section_value); mutate(changed);
      const owner = await beginOwner(changed);
      try { await assert.rejects(directInsert(owner, changed), /custom_neighborhood_acceptance_/); }
      finally { await client.query("ROLLBACK"); }
      assert.equal(await count(), 0);
      checks.push(`direct_sql_rejects_${name}`);
    }
    const directOwner = await beginOwner();
    // Equivalent exponent spelling and whitespace are not canonical JS bytes.
    const formatted = JSON.stringify(snapshot.section_value, null, 2).replace('330000', '3.3e5');
    try {
      await directInsert(directOwner, snapshot.section_value, formatted);
      assert.deepEqual((await getCustomNeighborhoodAcceptance(client, lookup)).snapshot, snapshot);
    } finally { await client.query("ROLLBACK"); }
    assert.equal(await count(), 0);
    checks.push("direct_sql_equivalent_json_reconstructs_exact_shared_receipt");

    const rolledBack = await beginOwner();
    assert.equal((await recordCustomNeighborhoodAcceptance(client, rolledBack)).reused, false);
    assert.equal(await count(), 0);
    assert.equal(await getCustomNeighborhoodAcceptance(other, lookup), null);
    checks.push("uncommitted_group_invisible");
    await assert.rejects(client.query("SELECT 1/0"), /division by zero/);
    await client.query("ROLLBACK");
    assert.equal(await count(), 0);
    assert.equal(Number((await other.query("SELECT count(*) AS count FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1", [identity.customId])).rows[0].count), 0);
    checks.push("late_failure_rolls_back_section_history_acceptance");

    const committedInput = await beginOwner();
    // Establish history before the second connection's old snapshot. In the live
    // workflow these writes commit together; this raw-SQL edge proves the guard
    // independently of that route convention and prevents later history tampering.
    await client.query("COMMIT");
    await rejectedInTransaction(() => client.query(
      "UPDATE app.custom_appraisal_workfile_section_history SET section_key='renamed' WHERE id=$1",
      [committedInput.sectionHistoryId]), /custom_neighborhood_accepted_history_immutable/);
    checks.push("unaccepted_neighborhood_history_already_append_only");
    await other.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal((await other.query("SELECT id FROM app.custom_appraisal_workfile_section_history WHERE id=$1",
      [committedInput.sectionHistoryId])).rowCount, 1);
    await client.query("BEGIN");
    const created = await recordCustomNeighborhoodAcceptance(client, committedInput);
    await client.query("COMMIT");
    try {
      await assert.rejects(other.query(
        "UPDATE app.custom_appraisal_workfile_section_history SET changed_by='old-snapshot-tamper' WHERE id=$1",
        [committedInput.sectionHistoryId]), /custom_neighborhood_accepted_history_immutable/);
    } finally { await other.query("ROLLBACK"); }
    checks.push("repeatable_read_history_immutable_after_acceptance");
    assert.equal(await count(), 1);
    const reopened = await getCustomNeighborhoodAcceptance(other, lookup);
    assert.equal(reopened.id, created.id);
    assert.deepEqual(reopened.snapshot, snapshot);
    checks.push("complete_group_commit_and_exact_reopen");

    await client.query("BEGIN");
    const replay = await recordCustomNeighborhoodAcceptance(client, committedInput);
    assert.equal(replay.reused, true); assert.equal(replay.id, created.id);
    await client.query("COMMIT");
    assert.equal(await count(), 1);
    checks.push("exact_operation_reuse");
    assert.equal(await getCustomNeighborhoodAcceptance(other, { ...lookup, organizationId: randomUUID() }), null);
    assert.equal(await getCustomNeighborhoodAcceptance(other, { ...lookup, operationId: randomUUID() }), null);
    checks.push("exact_tenant_and_operation_scope");
    await rejectedInTransaction(() => recordCustomNeighborhoodAcceptance(client, { ...committedInput, sectionHistoryId: "9223372036854775807" }), /query returned no rows|custom_neighborhood_acceptance/);
    await rejectedInTransaction(() => recordCustomNeighborhoodAcceptance(client, { ...committedInput, actorUserId: randomUUID() }), /custom_neighborhood_acceptance/);
    checks.push("changed_actor_or_history_rejected");

    await rejectedInTransaction(async () => {
      await client.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=now() WHERE assignment_file_id=$1", [identity.customId]);
      await recordCustomNeighborhoodAcceptance(client, committedInput);
    }, /custom_neighborhood_acceptance_target_not_editable/);
    checks.push("signed_target_rejected");
    await rejectedInTransaction(async () => {
      await client.query("UPDATE app.custom_appraisal_workfile_sections SET revision=2 WHERE assignment_file_id=$1 AND section_key=$2", [identity.customId, snapshot.section_key]);
      await getCustomNeighborhoodAcceptance(client, lookup);
    }, /custom_neighborhood_acceptance_not_current_section/);
    checks.push("old_group_cannot_replace_newer_section");
    await rejectedInTransaction(() => client.query("UPDATE app.custom_appraisal_workfile_section_history SET changed_by='tampered' WHERE id=$1", [committedInput.sectionHistoryId]), /custom_neighborhood_accepted_history_immutable/);
    await rejectedInTransaction(() => client.query("DELETE FROM app.custom_neighborhood_acceptances WHERE id=$1", [created.id]), /custom_neighborhood_acceptance_immutable/);
    checks.push("accepted_history_and_record_immutable");

    await client.query("BEGIN");
    const unrelated = (await client.query(`INSERT INTO app.custom_appraisal_workfile_section_history
      (assignment_file_id,section_key,section_value,revision,event_type,changed_by)
      VALUES ($1,'legal_description','{}'::jsonb,1,'manual_save','Synthetic reviewer') RETURNING id`,
    [identity.customId])).rows[0];
    assert.equal((await client.query("UPDATE app.custom_appraisal_workfile_section_history SET changed_by='Unrelated edit' WHERE id=$1",
      [unrelated.id])).rowCount, 1);
    assert.equal((await client.query("DELETE FROM app.custom_appraisal_workfile_section_history WHERE id=$1", [unrelated.id])).rowCount, 1);
    await client.query("ROLLBACK");
    checks.push("unrelated_legacy_history_behavior_preserved");

    await client.query("BEGIN");
    await client.query("SELECT revision FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key=$2 FOR UPDATE", [identity.customId, snapshot.section_key]);
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout='100ms'");
    try { await assert.rejects(recordCustomNeighborhoodAcceptance(other, committedInput), /lock timeout/); }
    finally { await other.query("ROLLBACK"); await client.query("ROLLBACK"); }
    assert.deepEqual((await getCustomNeighborhoodAcceptance(other, lookup)).snapshot, snapshot);
    checks.push("competing_editor_lock_rejected_without_partial_write");
    return { status: "passed", checks };
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* Keep cleanup of the independent second client reachable. */ }
    try { await other.query("ROLLBACK"); } catch { /* Pool disposal remains the native harness's responsibility. */ }
    client.release(); other.release();
  }
}

// Unlike the direct-SQL guard cases above, these use the actual Custom section
// writer and the combined persistence service. Authorization/source freshness
// and browser behavior still belong to the eventual owning route's tests.
async function checkAtomicSave(client, other, input, snapshot, lookup) {
  const checks = [], id = input.assignmentFileId;
  const state = async connection => (await connection.query(`SELECT
    (SELECT count(*)::int FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1) AS workfiles,
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1) AS sections,
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_section_history WHERE assignment_file_id=$1) AS history,
    (SELECT count(*)::int FROM app.custom_neighborhood_acceptances WHERE assignment_file_id=$1) AS acceptances,
    (SELECT updated_at::text FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1) AS workfile_updated,
    (SELECT updated_at::text FROM app.assignment_files WHERE id=$1) AS assignment_updated`, [id])).rows[0];
  const original = await state(other);
  assert.equal(original.sections, 0); assert.equal(original.history, 0); assert.equal(original.acceptances, 0);
  for (const saveReason of ["autosave", "manual_save", "legacy_import"]) {
    // A client can implement pool.query, but the reserved-key rejection must
    // happen before schema initialization or acquiring a transaction connection.
    await assert.rejects(saveCustomAppraisalWorkfileSection(client, {
      accountId: "unused-for-rejected-save", assignmentFileId: id,
      sectionKey: "neighborhood_assessment", sectionValue: snapshot.section_value,
      expectedRevision: 0, saveReason, reviewer: input.actorUserId,
    }), /custom_neighborhood_acceptance_workflow_required/);
    assert.deepEqual(await state(other), original);
  }
  checks.push("ordinary_saves_cannot_replace_reserved_group");
  await assert.rejects(saveCustomNeighborhoodAcceptanceInTransaction(client, input), error => error.code === "25P01");
  assert.deepEqual(await state(other), original);
  checks.push("real_save_requires_caller_transaction");

  await client.query("BEGIN");
  const pending = await saveCustomNeighborhoodAcceptanceInTransaction(client, input);
  assert.equal(pending.reused, false); assert.deepEqual(pending.snapshot, snapshot);
  assert.deepEqual(await state(other), original);
  assert.equal(await getCustomNeighborhoodAcceptance(other, lookup), null);
  await assert.rejects(client.query("SELECT 1/0"), error => error.code === "22012");
  await client.query("ROLLBACK");
  assert.deepEqual(await state(other), original);
  checks.push("real_section_history_acceptance_and_timestamps_rollback_together");

  await client.query("BEGIN");
  // A valid UUID absent from app_auth.users passes representation but fails the
  // actual acceptance FK AFTER section/history writes. The service must undo
  // those writes, even if its caller erroneously commits the remaining transaction.
  await client.query("CREATE TEMP TABLE custom_atomic_owner_marker (label text) ON COMMIT DROP");
  await client.query("INSERT INTO custom_atomic_owner_marker VALUES ('earlier owner write')");
  await assert.rejects(saveCustomNeighborhoodAcceptanceInTransaction(client,
    { ...input, actorUserId: randomUUID() }), error => error.code === "23503");
  assert.deepEqual(await state(client), original);
  assert.deepEqual((await client.query("SELECT label FROM custom_atomic_owner_marker")).rows,
    [{ label: "earlier owner write" }]);
  await client.query("COMMIT");
  assert.deepEqual(await state(other), original);
  checks.push("late_native_acceptance_failure_cannot_commit_partial_group");
  checks.push("group_rollback_preserves_earlier_owner_writes");

  await client.query("BEGIN");
  const accepted = await saveCustomNeighborhoodAcceptanceInTransaction(client, input);
  await other.query("BEGIN");
  await other.query("SET LOCAL lock_timeout='200ms'");
  try {
    await assert.rejects(saveCustomNeighborhoodAcceptanceInTransaction(other, input), error => error.code === "55P03");
  } finally { await other.query("ROLLBACK"); }
  await client.query("COMMIT");
  assert.deepEqual((await getCustomNeighborhoodAcceptance(other, lookup)).snapshot, snapshot);
  const committed = await state(other);
  assert.equal(committed.sections, 1); assert.equal(committed.history, 1); assert.equal(committed.acceptances, 1);
  checks.push("real_competing_save_serialized_and_complete_group_reopens");

  await client.query("BEGIN");
  const retry = await saveCustomNeighborhoodAcceptanceInTransaction(client, input);
  assert.equal(retry.reused, true); assert.equal(retry.id, accepted.id);
  await client.query("COMMIT");
  assert.deepEqual(await state(other), committed);
  checks.push("retry_preserves_revision_history_and_timestamps");

  for (const [name, setup, changed, expected] of [
    ["signed_file", () => client.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=now() WHERE assignment_file_id=$1", [id]),
      input, /target_not_editable/],
    ["stale_group", () => client.query("UPDATE app.custom_appraisal_workfile_sections SET revision=revision+1 WHERE assignment_file_id=$1 AND section_key=$2", [id, snapshot.section_key]),
      input, /not_current_section/],
    ["wrong_organization", async () => {}, { ...input, organizationId: randomUUID() }, /attachment_not_found/],
    ["changed_actor", async () => {}, { ...input, actorUserId: randomUUID() }, /acceptance_/],
  ]) {
    await client.query("BEGIN");
    try { await setup(); await assert.rejects(saveCustomNeighborhoodAcceptanceInTransaction(client, changed), expected); }
    finally { await client.query("ROLLBACK"); }
    assert.deepEqual(await state(other), committed);
    assert.deepEqual((await getCustomNeighborhoodAcceptance(other, lookup)).snapshot, snapshot);
    checks.push(`real_save_rejects_${name}_without_changing_group`);
  }
  return { status: "passed", checks };
}
