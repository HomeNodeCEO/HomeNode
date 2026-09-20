import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { decideAssignmentAccess } from '../../security/assignmentAccess.js';

const RECOVERABLE_POINT_REASONS = new Set(['recorded_location_missing']);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function verifiedLocation(property, accountId) {
  const location = property?.location;
  return location?.account_id === accountId
    && location.status === 'matched'
    && location.source === 'dcad_parcel_query'
    && location.precision === 'parcel_centroid'
    && location.confidence === 'high'
    && location.match_method === 'parcel_id'
    && location.source_parcel_id === accountId
    && location.feature_count === 1
    && location.review_required === false
    && location.review_reason === null
    && location.metadata?.address_agreement === true
    && typeof location.latitude === 'number' && Number.isFinite(location.latitude)
    && typeof location.longitude === 'number' && Number.isFinite(location.longitude)
    && Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180;
}

/** Append a new immutable subject snapshot only when an appraiser explicitly
 * requested a neighborhood capture, the retained draft snapshot has no recorded
 * location, and the current CAD mirror has one unambiguous high-confidence
 * parcel-centroid match. Existing snapshots remain immutable and parent-linked.
 * Accepted/signed files are never rebound to newer evidence. */
export async function refreshCustomNeighborhoodSubjectEvidence(pool, input, {
  loadProperty = null,
  captureSnapshot = null,
} = {}) {
  if (typeof pool?.connect !== 'function') fail('custom_subject_evidence_dependencies_required');
  if (loadProperty === null || captureSnapshot === null) {
    const [propertyModule, historyModule] = await Promise.all([
      import('../customAppraisalReportPdf.js'), import('../appraisalHistory.js'),
    ]);
    loadProperty ??= propertyModule.loadCustomAppraisalPropertySnapshot;
    captureSnapshot ??= historyModule.captureAppraisalSubjectSnapshot;
  }
  if (typeof loadProperty !== 'function' || typeof captureSnapshot !== 'function') {
    fail('custom_subject_evidence_dependencies_required');
  }
  const accountId = input?.accountId, assignmentFileId = input?.assignmentFileId;
  if (typeof accountId !== 'string' || !accountId || typeof assignmentFileId !== 'string'
    || !/^[1-9]\d{0,18}$/.test(assignmentFileId)) fail('custom_subject_evidence_input_invalid');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); open = true;
    const workfile = await client.query(`/* custom-subject-evidence-recovery:workfile */
      SELECT status,signed_at,EXISTS(SELECT 1 FROM app.custom_appraisal_signed_snapshots s
        WHERE s.assignment_file_id=w.assignment_file_id) AS has_signed_snapshot
      FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1::bigint FOR UPDATE NOWAIT`, [assignmentFileId]);
    if (workfile.rowCount !== 1 || workfile.rows.length !== 1) fail('assignment_file_not_found');
    if (workfile.rows[0].status !== 'draft' || workfile.rows[0].signed_at !== null
      || workfile.rows[0].has_signed_snapshot !== false) fail('custom_appraisal_workfile_signed');
    const assignment = await client.query(`/* custom-subject-evidence-recovery:assignment */
      SELECT id::text AS assignment_file_id,account_id,organization_id,
        assigned_appraiser_user_id,supervisory_appraiser_user_id
      FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2 FOR UPDATE NOWAIT`, [assignmentFileId, accountId]);
    if (assignment.rowCount !== 1 || assignment.rows.length !== 1) fail('assignment_file_not_found');
    const target = assignment.rows[0];
    if (!hasApplicationPermission(input.auth, 'custom_appraisal', 'write', target.organization_id)
      || !decideAssignmentAccess(input.auth, target, 'write')) fail('assignment_access_denied');
    const report = await client.query(`/* custom-subject-evidence-recovery:report */
      SELECT id,subject_snapshot_id FROM app.report_files
      WHERE custom_assignment_file_id=$1::bigint AND account_id=$2 AND organization_id=$3
        AND workflow_type='custom_appraisal' AND uad_workfile_id IS NULL AND tax_protest_file_id IS NULL
      FOR UPDATE NOWAIT`, [assignmentFileId, accountId, target.organization_id]);
    if (report.rowCount !== 1 || report.rows.length !== 1) fail('custom_subject_evidence_report_unavailable');
    const accepted = await client.query(`/* custom-subject-evidence-recovery:accepted */
      SELECT EXISTS(SELECT 1 FROM app.custom_appraisal_workfile_sections
        WHERE assignment_file_id=$1::bigint AND section_key='neighborhood_assessment')
        OR EXISTS(SELECT 1 FROM app.custom_neighborhood_acceptances
          WHERE assignment_file_id=$1::bigint AND organization_id=$2 AND account_id=$3) AS present`,
    [assignmentFileId, target.organization_id, accountId]);
    if (accepted.rows[0]?.present !== false) fail('custom_subject_evidence_accepted_group_present');
    const property = await loadProperty(client, { accountId, assignmentFileId });
    if (!verifiedLocation(property, accountId)) fail('custom_subject_evidence_location_unavailable');
    const snapshot = await captureSnapshot(client, report.rows[0].id, {
      actorUserId: input.auth.userId,
      captureReason: 'neighborhood_capture_verified_subject_evidence_refresh',
    });
    if (!verifiedLocation(snapshot.subjectData?.custom_property_snapshot, accountId)) {
      fail('custom_subject_evidence_capture_invalid');
    }
    await client.query('COMMIT'); open = false;
    return Object.freeze({ refreshed: true, subject_snapshot_id: snapshot.id,
      snapshot_version: snapshot.snapshotVersion, verification_status: snapshot.verificationStatus });
  } catch (error) {
    if (open) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Preserve the complete cohort service contract and retry exactly once. The
 * first failed capture has rolled back; the original operation UUID, observation
 * period, source policy, deadline and cancellation signal remain unchanged. */
export function createCustomNeighborhoodSubjectEvidenceRecovery({
  pool,
  cohortService,
  refresh = refreshCustomNeighborhoodSubjectEvidence,
} = {}) {
  if (!cohortService || typeof cohortService.capture !== 'function' || typeof refresh !== 'function') {
    fail('custom_subject_evidence_recovery_dependencies_required');
  }
  return Object.freeze({ ...cohortService, async capture(input, options) {
    try { return await cohortService.capture(input, options); }
    catch (error) {
      if (error?.code !== 'CUSTOM_COHORT_CAPTURE_FAILED'
        || error.reason !== 'recorded_point_required'
        || !RECOVERABLE_POINT_REASONS.has(error.detail)) throw error;
      try { await refresh(pool, input); }
      catch { throw error; }
      return cohortService.capture(input, options);
    }
  } });
}
