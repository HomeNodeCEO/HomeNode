import { canonicalAssessmentJson as json } from './contract.js';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, CUSTOM_NEIGHBORHOOD_V6_WORKSPACE_CHECKPOINT_LIMITS,
  readCustomNeighborhoodWorkspaceCheckpoint, prepareCustomNeighborhoodWorkspaceCheckpoint } from './customWorkspaceCheckpoint.js';
import { saveCustomNeighborhoodGroupWorkspaceInTransaction } from '../customAppraisalWorkfiles.js';
import { createCustomCohortGroupSelectionRepository } from './customCohortGroupSelectionRepository.js';

const same = (a, b) => json(a) === json(b);
function fail(reason) { throw new TypeError(`custom_cohort_group_workspace_${reason}`); }

async function readWorkspace(client, input, checkBudget, allowAbsent = false) {
  checkBudget();
  const rows = await client.query(`/* custom-cohort-group-workspace:read */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= $3::integer
      THEN section_value ELSE NULL END AS value
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR UPDATE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
    CUSTOM_NEIGHBORHOOD_V6_WORKSPACE_CHECKPOINT_LIMITS.canonical_utf8_bytes * 2]);
  checkBudget();
  if (allowAbsent && rows?.rowCount === 0 && rows.rows?.length === 0 && input.expectedWorkspaceRevision === 0
    && input.expectedWorkspaceCheckpoint.workspace_version === 7
    && input.expectedWorkspaceCheckpoint.active === null && input.expectedWorkspaceCheckpoint.pending_capture === null)
    return Object.freeze({ section_revision: 0, checkpoint: input.expectedWorkspaceCheckpoint });
  if (rows?.rowCount !== 1 || rows.rows?.length !== 1) fail('unavailable');
  const restored = readCustomNeighborhoodWorkspaceCheckpoint(rows.rows[0]);
  if (restored.status !== 'restored') fail('unavailable');
  return restored;
}

async function writeWorkspace(client, input, value, checkBudget) {
  const saved = await saveCustomNeighborhoodGroupWorkspaceInTransaction(client, {
    accountId: input.accountId, assignmentFileId: input.assignmentFileId, sectionKey: CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
    sectionValue: value, expectedRevision: input.expectedWorkspaceRevision, saveReason: 'manual_save', reviewer: input.auth.userId,
  });
  checkBudget();
  if (saved.revision !== input.expectedWorkspaceRevision + 1 || !same(saved.value, value)) fail('storage_conflict');
  return Object.freeze({ revision: saved.revision, value });
}

/** Only head metadata is inspected for pending editor intent. No old source
 * rows or catalog are opened and no source grant is inferred from the head.
 * The executable caller holds workfile then assignment locks; the repository
 * fences this exact scope/context with its existing NOWAIT ownership rules.
 */
async function checkPriorHead(client, scopeJson, checkpoint, checkBudget) {
  if (!checkpoint.active) return;
  const repository = createCustomCohortGroupSelectionRepository(client, scopeJson,
    json(checkpoint.active.context_ref), { checkBudget });
  const { selection_ref } = await repository.peekCurrent();
  if (!same(selection_ref, checkpoint.active.selection_ref)) fail('selection_changed');
}

/** Start/cancel only changes pending capture intent. An unavailable new study
 * never destroys the old active selection or applies statistics to a report.
 * Exact immediate-successor replay is read-only; a later edit cannot rewind.
 */
export async function saveCustomCohortGroupPendingCapture({ client, input, scopeJson, pendingCapture, checkBudget }) {
  const restored = await readWorkspace(client, input, checkBudget, pendingCapture !== null), prior = input.expectedWorkspaceCheckpoint;
  const value = prepareCustomNeighborhoodWorkspaceCheckpoint({ ...prior, pending_capture: pendingCapture });
  if (restored.section_revision === input.expectedWorkspaceRevision + 1 && same(restored.checkpoint, value)) {
    await checkPriorHead(client, scopeJson, prior, checkBudget);
    return Object.freeze({ status: 'reused', workspace: Object.freeze({ revision: restored.section_revision, value }) });
  }
  if (restored.section_revision !== input.expectedWorkspaceRevision) fail('revision_changed');
  if (!same(restored.checkpoint, prior)) fail('study_changed');
  await checkPriorHead(client, scopeJson, prior, checkBudget);
  return Object.freeze({ status: 'stored', workspace: await writeWorkspace(client, input, value, checkBudget) });
}

/** Bind completion to the exact registered new study, including its private
 * import/review purpose. Command v3 retains the entire tiny prior V7 intent so
 * loss of a COMMIT acknowledgment cannot be replayed against another study.
 */
export async function prepareCustomCohortGroupCaptureCompletion({ client, input, scopeJson,
  observationPeriod, discovery, privateSalesImport, checkBudget }) {
  const restored = await readWorkspace(client, input, checkBudget), prior = input.expectedWorkspaceCheckpoint;
  const pending = prior.pending_capture;
  if (pending.operation_id !== input.contextRef.context_id || !same(pending.observation_period, observationPeriod)
    || !same(pending.discovery ?? null, discovery ?? null)
    || !same(pending.private_sales_import ?? null, privateSalesImport ?? null)) fail('study_changed');
  const revision = input.expectedWorkspaceRevision;
  if (restored.section_revision !== revision && restored.section_revision !== revision + 1) fail('revision_changed');
  if (restored.section_revision === revision) {
    if (!same(restored.checkpoint, prior)) fail('study_changed');
    await checkPriorHead(client, scopeJson, prior, checkBudget);
  } else if (restored.checkpoint.workspace_version !== 7) fail('revision_changed');
  return Object.freeze({
    async save(result) {
      checkBudget();
      if (!['stored', 'reused'].includes(result?.status) || result.authority !== 'not_established'
        || result.operation_id !== input.operationId || !same(result.context_ref, input.contextRef)) fail('selection_changed');
      const value = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: 7,
        active: { context_ref: input.contextRef, observation_period: observationPeriod, selection_ref: result.selection_ref,
          ...(discovery == null ? {} : { discovery }) }, pending_capture: null });
      if (result.status === 'reused') {
        if (restored.section_revision !== revision + 1 || !same(restored.checkpoint, value)) fail('replay_changed');
        return Object.freeze({ revision: restored.section_revision, value });
      }
      if (restored.section_revision !== revision) fail('revision_changed');
      return writeWorkspace(client, input, value, checkBudget);
    },
  });
}

/** Caller-owned transaction only. The executable selection owner already holds
 * the exact writable workfile parent BEFORE assignment/context locks and has
 * freshly authorized the retained source metadata. This does not grant rights,
 * choose groups, accept statistics or COMMIT. Only the complete registered head
 * may be saved, and any later role/source/cancellation failure rolls back both.
 */
export async function prepareCustomCohortGroupWorkspaceSave({ client, input, observationPeriod, discovery, checkBudget }) {
  if (typeof client?.query !== 'function' || typeof checkBudget !== 'function') fail('owner_required');
  checkBudget();
  const rows = await client.query(`/* custom-cohort-group-workspace:read */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= $3::integer
      THEN section_value ELSE NULL END AS value
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR UPDATE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
    CUSTOM_NEIGHBORHOOD_V6_WORKSPACE_CHECKPOINT_LIMITS.canonical_utf8_bytes * 2]);
  checkBudget();
  if (rows?.rowCount !== 1 || rows.rows?.length !== 1) fail('unavailable');
  const restored = readCustomNeighborhoodWorkspaceCheckpoint(rows.rows[0]);
  const active = restored.checkpoint?.active;
  if (restored.status !== 'restored' || !active) fail('unavailable');
  if (!same(active.context_ref, input.contextRef) || !same(active.observation_period, observationPeriod)
    || (Object.hasOwn(active, 'discovery') && !same(active.discovery, discovery ?? null))) fail('study_changed');
  if (restored.checkpoint.pending_capture !== null) fail('capture_pending');
  const prior = input.expectedWorkspaceRevision;
  if (restored.section_revision !== prior && restored.section_revision !== prior + 1) fail('revision_changed');
  if (restored.section_revision === prior && restored.checkpoint.workspace_version === 7
    && !same(active.selection_ref, input.expectedSelectionRef)) fail('selection_changed');
  // The only tolerated successor is a possible exact lost-ACK replay. Its
  // original command binds prior in v2; the final equality below proves it.
  if (restored.section_revision === prior + 1 && restored.checkpoint.workspace_version !== 7) fail('revision_changed');
  return Object.freeze({
    async save(result) {
      checkBudget();
      if (!['stored', 'reused'].includes(result?.status) || result.authority !== 'not_established'
        || result.operation_id !== input.operationId || !same(result.context_ref, input.contextRef)) fail('selection_changed');
      const value = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: 7,
        active: { context_ref: input.contextRef, observation_period: observationPeriod, selection_ref: result.selection_ref,
          ...(discovery == null ? {} : { discovery }) }, pending_capture: null });
      if (result.status === 'reused') {
        if (restored.section_revision !== prior + 1 || !same(restored.checkpoint, value)) fail('replay_changed');
        return Object.freeze({ revision: restored.section_revision, value });
      }
      if (restored.section_revision !== prior) fail('revision_changed');
      const saved = await saveCustomNeighborhoodGroupWorkspaceInTransaction(client, {
        accountId: input.accountId, assignmentFileId: input.assignmentFileId, sectionKey: CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
        sectionValue: value, expectedRevision: prior, saveReason: 'manual_save', reviewer: input.auth.userId,
      });
      checkBudget();
      if (saved.revision !== prior + 1 || !same(saved.value, value)) fail('storage_conflict');
      return Object.freeze({ revision: saved.revision, value });
    },
  });
}
