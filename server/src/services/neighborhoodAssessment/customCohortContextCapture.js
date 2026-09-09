import { performance } from 'node:perf_hooks';
import { decideAssignmentAccess } from '../../security/assignmentAccess.js';
import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { authorizePublicCadastralCatalogRead } from '../../security/publicCadastralCatalog.js';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodCohortBlobRepository } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { createCustomCohortContextRepository } from './customCohortContextRepository.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { captureNeighborhoodSpatialMembership } from './cachedSpatialMembership.js';
import { resolveNeighborhoodCachedTransactionClosure } from './cachedTransactionClosureReader.js';
import { createNeighborhoodCachedReadAccess, describeNeighborhoodCachedMarketDataPurpose,
  describeNeighborhoodSaleWitnessMarketDataPurpose } from './cachedReadAccess.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from './cachedSourceReader.js';
import { NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, prepareNeighborhoodSelectorInputV1 } from './selectorInputProfile.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs,
  loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview, CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { buildCustomCohortParcelMap } from './customCohortParcelMap.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers } from './customCohortPreviewPresentation.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } from './customCohortPocketCatalog.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createCustomCohortReviewRepository } from './customCohortReviewRepository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TARGET_FIELDS = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const DEPENDENCIES = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const LIMITS = Object.freeze({ duration_ms: 60_000, connect_ms: 3000, query_ms: 6000, cleanup_ms: 1000 });
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason, detail) {
  throw Object.assign(new Error(`custom_cohort_capture_${reason}`), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason, ...(detail ? { detail } : {}),
  });
}
function exactKeys(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail('invalid_input');
}
function identityOf(input) {
  const { accountId, assignmentFileId } = input;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 64 || accountId.trim() !== accountId
    || /[\u0000-\u001f\u007f]/.test(accountId)) fail('invalid_account');
  if (typeof assignmentFileId !== 'string' || !/^[1-9]\d{0,18}$/.test(assignmentFileId)
    || BigInt(assignmentFileId) > 9223372036854775807n) fail('invalid_assignment');
  if (typeof input.auth?.userId !== 'string' || !input.auth.userId.trim()) fail('authentication_required');
  // Admit/copy only the existing authorization policy's fields before awaiting.
  const auth = JSON.parse(canonicalAssessmentJson({ userId: input.auth.userId,
    organizations: input.auth.organizations ?? [] }));
  return freeze({ auth, accountId, assignmentFileId });
}
function inputOf(input) {
  // This is an internal service. The HTTP owner must supply its authenticated
  // principal separately from body fields; no body-auth or source-roster API.
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'operationId', 'observationPeriod']);
  const identity = identityOf(input), { operationId } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('invalid_operation');
  exactKeys(input.observationPeriod, ['start_date', 'end_date']);
  const period = Object.fromEntries(Object.entries(input.observationPeriod).map(([key, value]) => [key, assessmentDate(value)]));
  if (period.start_date > period.end_date) fail('invalid_period');
  return freeze({ ...identity, operationId, observationPeriod: period });
}
function previewInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'contextRef', 'selection']);
  const identity = identityOf(input);
  const contextRef = prepareCustomCohortContextReference(canonicalAssessmentJson(input.contextRef));
  // Detach the bounded selection before any await; changing a caller's object
  // while evidence loads must not change which map/statistics pair is returned.
  const selection = JSON.parse(canonicalAssessmentJson(input.selection));
  exactKeys(selection, ['revision', 'pockets']);
  if (!Number.isSafeInteger(selection.revision) || selection.revision < 1
    || !Array.isArray(selection.pockets) || selection.pockets.length > CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS.pockets) fail('invalid_selection');
  return freeze({ ...identity, contextRef, selection });
}
function reviewInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'commandJson']);
  const identity = identityOf(input);
  const admitted = prepareCohortDecisionCommandV1(input.commandJson);
  if (admitted.status !== 'syntax_valid' || admitted.command.target_ref.workflow_type !== 'custom_appraisal'
    || admitted.command.target_ref.workflow_target_id !== identity.assignmentFileId) fail('invalid_review_command');
  return freeze({ ...identity, commandJson: input.commandJson, command: admitted.command });
}
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('target_unavailable');
  return result.rows[0];
}
async function databaseTime(client) {
  const value = one(await client.query(`/* custom-cohort-capture:time */
    SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`)).value;
  if (!TIMESTAMP.test(value ?? '')) fail('database_time_unavailable');
  return value;
}

function operationBudget(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => !['signal', 'deadline'].includes(key))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.deadline !== undefined && !Number.isFinite(options.deadline))) fail('invalid_options');
  const finalDeadline = Math.min(performance.now() + LIMITS.duration_ms, options.deadline ?? Infinity);
  const deadline = finalDeadline - LIMITS.cleanup_ms;
  const check = () => {
    if (options.signal?.aborted) fail('cancelled');
    if (performance.now() >= deadline) fail('deadline_exceeded');
  };
  const remaining = maximum => { check(); return Math.max(1, Math.min(maximum, Math.ceil(deadline - performance.now()))); };
  return { check, remaining, deadline, signal: options.signal };
}

async function connect(pool, budget) {
  const timeout = budget.remaining(LIMITS.connect_ms);
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { clearTimeout(timer); budget.signal?.removeEventListener('abort', aborted); };
    const rejectOnce = reason => {
      if (finished) return;
      finished = true; cleanup();
      try { fail(reason); } catch (error) { reject(error); }
    };
    const aborted = () => rejectOnce('cancelled');
    const timer = setTimeout(() => rejectOnce('connection_timeout'), timeout);
    budget.signal?.addEventListener('abort', aborted, { once: true });
    // A late connection is released exactly once rather than abandoned in the
    // pool. A failed connect never enters transaction cleanup with no client.
    Promise.resolve().then(() => pool.connect()).then(client => {
      if (finished) {
        try { client.release(new Error('custom_cohort_late_connection')); } catch { /* Already failed; do not create an unhandled late rejection. */ }
        return;
      }
      finished = true; cleanup(); resolve(client);
    }, error => { if (!finished) { finished = true; cleanup(); reject(error); } });
    if (budget.signal?.aborted) aborted();
  });
}

async function transaction(pool, mode, budget, execute) {
  budget.check();
  const raw = await connect(pool, budget);
  let open = false, closed = false, discard = null, commitAttempted = false;
  const client = Object.freeze({
    query: async (sql, values) => {
      if (closed) fail('closed_operation');
      budget.check();
      const config = typeof sql === 'string' ? { text: sql, values } : { ...sql };
      config.query_timeout = Math.min(config.query_timeout ?? LIMITS.query_ms, budget.remaining(LIMITS.query_ms));
      try { const result = await raw.query(config); budget.check(); return result; }
      catch (error) { discard = error; throw error; }
    },
    release() { fail('transaction_owner_required'); },
  });
  try {
    open = true; // BEGIN timeout leaves uncertain state too.
    await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
    await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'");
    const result = await execute(client);
    budget.check(); commitAttempted = true;
    await client.query('COMMIT'); open = false;
    return result;
  } catch (error) {
    if (commitAttempted) {
      // A rejected COMMIT does not prove rollback. The operation UUID permits
      // a later authorized lookup of the immutable context; never blind retry.
      discard ||= error;
      throw Object.assign(error, { outcome_unknown: true });
    }
    if (open && !discard) {
      try { await raw.query({ text: 'ROLLBACK', query_timeout: LIMITS.cleanup_ms }); }
      catch (rollbackError) { discard = rollbackError; }
    }
    throw error;
  } finally {
    closed = true;
    try { raw.release(discard || undefined); }
    catch (releaseError) {
      if (commitAttempted) throw Object.assign(releaseError, { outcome_unknown: true });
      throw releaseError;
    }
  }
}

async function resolveTarget(client, input, locked, permission = 'write') {
  const assignment = one(await client.query(`/* custom-cohort-capture:assignment */
    SELECT id::text AS assignment_file_id,account_id,organization_id,
      assigned_appraiser_user_id,supervisory_appraiser_user_id
    FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2
    ${locked ? 'FOR UPDATE NOWAIT' : ''}`, [input.assignmentFileId, input.accountId]));
  if (assignment.assignment_file_id !== input.assignmentFileId || assignment.account_id !== input.accountId
    || !hasApplicationPermission(input.auth, 'custom_appraisal', permission, assignment.organization_id)
    || !decideAssignmentAccess(input.auth, assignment, permission)) fail('assignment_access_denied');
  const report = one(await client.query(`/* custom-cohort-capture:report */
    SELECT id AS report_file_id,appraisal_case_id,subject_snapshot_id
    FROM app.report_files WHERE custom_assignment_file_id=$1::bigint AND account_id=$2 AND organization_id=$3
      AND workflow_type='custom_appraisal' AND uad_workfile_id IS NULL AND tax_protest_file_id IS NULL`,
  [input.assignmentFileId, input.accountId, assignment.organization_id]));
  return freeze({ ...Object.fromEntries(TARGET_FIELDS.filter(key => key !== 'report_file_id').map(key => [key, assignment[key]])), ...report });
}
function assertTarget(current, original) {
  if ([...TARGET_FIELDS, 'appraisal_case_id', 'subject_snapshot_id'].some(key => current[key] !== original[key])) fail('target_changed');
}
function contextOf(subject) {
  const t = subject.target;
  return freeze({ target: { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id },
    scope: { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id,
      subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id }, effective_date: subject.effective_date });
}
function policyDecision(value) {
  if (!value || value.allowed !== true || typeof value.decision_id !== 'string' || !value.decision_id
    || typeof value.policy_revision !== 'string' || !value.policy_revision) fail('market_data_access_denied');
  return freeze({ allowed: true, decision_id: value.decision_id, policy_revision: value.policy_revision });
}
async function boundedPolicy(policy, client, auth, context, purpose, budget, exposure = 'none') {
  budget.check();
  let timer, aborted;
  const expired = new Promise((_, reject) => {
    const rejectWith = reason => { try { fail(reason); } catch (error) { reject(error); } };
    timer = setTimeout(() => rejectWith('policy_timeout'), budget.remaining(LIMITS.duration_ms));
    aborted = () => rejectWith('cancelled');
    budget.signal?.addEventListener('abort', aborted, { once: true });
  });
  try {
    // The trusted policy receives only the transaction's bounded client. Late
    // work cannot issue another query after its owner closes that client. Join
    // rejections through Promise.race; never leave an unhandled late rejection.
    const result = await Promise.race([Promise.resolve().then(() =>
      policy(client, auth, context, purpose, { retention: true, exposure })), expired]);
    budget.check(); return policyDecision(result);
  } finally { clearTimeout(timer); budget.signal?.removeEventListener('abort', aborted); }
}
function captured(value, stage) {
  if (value?.status !== 'captured' || value.query_complete !== true) fail(`${stage}_incomplete`,
    value?.reason ?? value?.incomplete_reasons ?? 'unavailable');
  return value;
}

async function authorizedRetainedInputs(client, { scopeJson, reference, input, authorizeMarketData, budget, study = null, exposure = 'none', loadInputs = true }) {
  const previous = await createCustomCohortContextRepository(client, scopeJson).get(canonicalAssessmentJson(reference));
  if (!previous) fail('context_unavailable');
  const refs = Object.fromEntries(DEPENDENCIES.map(key => [key, previous.body[key]]));
  const context = { target: {
    report_file_id: previous.body.target.report_file_id, workflow_type: 'custom_appraisal',
    workflow_target_id: previous.body.target.workflow_target_id,
  }, scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .map(key => [key, previous.body.target[key]])), effective_date: previous.body.effective_date };
  const blobs = createNeighborhoodCohortBlobRepository(client, context.scope.organization_id);
  const readMetadata = async ref => {
    const text = await blobs.get(ref?.content_sha256, ref?.canonical_utf8_bytes);
    if (text === null) fail('retained_inputs_unavailable');
    return JSON.parse(text);
  };
  // Only the bounded request directory is opened before current licensing.
  // Never read full source rows simply because this operation was allowed before.
  const directory = await readMetadata(refs.selection_input);
  const requestMetadata = await readMetadata(directory.request?.metadata);
  const compact = await readMetadata(directory.compact_metadata);
  if (!same(requestMetadata.target, context.target) || !same(requestMetadata.scope, context.scope)
    || (study && !same(requestMetadata.observation_period, study.observation_period))
    || requestMetadata.effective_date !== context.effective_date || requestMetadata.knowledge_cutoff !== null) fail('operation_conflict');
  // Choose the source projection from its original immutable query metadata,
  // never today's producer default. v3 cannot reopen under a narrower v2 grant.
  if (compact.reader_version !== 'local-capture-v3' || ![1, 2, 3].includes(compact.mapping_version)
    || !same(compact.scope, requestMetadata.scope) || compact.effective_date !== requestMetadata.effective_date
    || !same(compact.authorization?.target, requestMetadata.target)
    || !same(compact.authorization?.market_decision, requestMetadata.market_decision)) fail('operation_conflict');
  const purpose = compact.mapping_version === 3 ? describeNeighborhoodSaleWitnessMarketDataPurpose(requestMetadata)
    : describeNeighborhoodCachedMarketDataPurpose(requestMetadata);
  const decision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget, exposure);
  if (!same({ decision_id: decision.decision_id, policy_revision: decision.policy_revision }, requestMetadata.market_decision)) fail('market_policy_changed');
  // Review persistence will reopen the original graph in this same transaction.
  // Keep its preceding rights check, without allocating/validating it twice.
  const retained = loadInputs ? await loadCustomCohortCaptureInputs(client, scopeJson, refs) : null;
  return { context, retained, purpose, decision };
}

/** Executable, Custom-only acquisition owner. No HTTP route, current-head
 * change, eligible-cohort decision, calculation, Apply or signing occurs here.
 * The review method retains exact authenticated reviewer commands only; stored
 * observations/assertions do not become certified facts or accepted statistics.
 * authorizeMarketData is a required SERVER policy and must explicitly cover
 * cached source rows, all-date one-hop identities and immutable retention. It
 * receives only this bounded client; it may not read a pool or a remote provider.
 * No default grant is inferred from assignment access, hashes or professional
 * licensing. Source completeness and historical support remain unknown.
 */
export function createCustomCohortContextCapture({ pool, authorizeMarketData } = {}) {
  if (typeof pool?.connect !== 'function' || typeof authorizeMarketData !== 'function') {
    throw new TypeError('custom_cohort_capture_dependencies_required');
  }
  async function runPreview(value, options, { includeMap = true, exposure = 'none', project } = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    const loaded = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      return { target, scopeJson, ...await authorizedRetainedInputs(client, {
        scopeJson, reference: input.contextRef, input, authorizeMarketData, budget, exposure,
      }) };
    });
    // All calculation/presentation happens outside the DB connection and before
    // the final current authorization check. Selection-only updates need not
    // decode/resend immutable geometry, nor disclose entire member arrays.
    budget.check();
    const preview = buildCustomCohortObservationPreview({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained_inputs, selection: input.selection });
    budget.check();
    const parcelMap = includeMap ? buildCustomCohortParcelMap({ retained_inputs: loaded.retained.retained_inputs,
      selected_account_ids: [...new Set(input.selection.pockets.flatMap(pocket => pocket.account_ids))] })
      : { status: 'omitted', reason: 'geometry_not_requested' };
    const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
    const content = project ? project(preview, expected, parcelMap, loaded.retained.retained_inputs) : { preview, parcel_map: parcelMap };
    budget.check();
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), loaded.target);
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.context, loaded.purpose, budget, exposure);
      if (!same(decision, loaded.decision)) fail('market_policy_changed');
      return freeze({ status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
        ...expected, subject_freshness: 'matched', ...content,
        apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
    });
  }
  return Object.freeze({ async capture(value, options = {}) {
    const input = inputOf(value), budget = operationBudget(options);
    budget.check();
    const study = freeze({ profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
      observation_period: input.observationPeriod, knowledge_cutoff: null });
    const phaseOne = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true);
      const scope = Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]]));
      const scopeJson = canonicalAssessmentJson(scope);
      const repository = createCustomCohortSubjectRepository(client, scopeJson);
      const existing = await client.query(`/* custom-cohort-capture:existing-context */
        SELECT context_sha256 FROM app.neighborhood_custom_cohort_contexts
        WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, input.operationId]);
      if (existing.rowCount) {
        if (existing.rowCount !== 1 || existing.rows.length !== 1) fail('operation_conflict');
        const reference = { context_id: input.operationId, context_revision: '1', context_sha256: existing.rows[0].context_sha256 };
        const { retained } = await authorizedRetainedInputs(client, {
          scopeJson, reference, input, authorizeMarketData, budget, study,
        });
        if (retained.acquisition_intent.body.actor_user_id !== input.auth.userId || !same(retained.study, study)) fail('operation_conflict');
        if ((await repository.compareCurrent(retained.subject_reference)).status !== 'matched') fail('subject_changed');
        // Replay confirms durable registration only, not a new source read or
        // eligible cohort. No raw market evidence is returned here.
        return { replay: freeze({ status: 'registered', reused: true, context_ref: reference,
          discovery: { radius_metres: retained.summary.radius_metres, parcel_count: retained.summary.parcel_count,
            account_count: retained.summary.account_count }, source_query_complete: true, provider_coverage: 'not_established',
          unsupported_capabilities: retained.retained_inputs.acquisition.capture_result.unsupported_capabilities }) };
      }
      const subjectReference = await repository.capture();
      const subject = await repository.load(subjectReference);
      if (study.observation_period.end_date > subject.effective_date) fail('period_after_effective_date');
      const point = await repository.loadRecordedPoint(subjectReference);
      if (point.status !== 'represented') fail('recorded_point_required', point.reason);
      const body = freeze({ intent_version: 1, operation_id: input.operationId, actor_user_id: input.auth.userId,
        subject_inputs: subjectReference, target: subject.target, effective_date: subject.effective_date,
        study, created_at: await databaseTime(client) });
      const reference = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalAssessmentJson(body));
      return { scope, scopeJson, subject, subjectReference, point, intent: { reference, body } };
    });
    if (phaseOne.replay) return phaseOne.replay;
    const { scope, scopeJson, subject, subjectReference, point, intent } = phaseOne;
    const context = contextOf(subject);
    let purpose, decision;
    const read = await transaction(pool, 'REPEATABLE READ READ ONLY', budget, async client => {
      assertTarget(await resolveTarget(client, input, false), subject.target);
      authorizePublicCadastralCatalogRead(input.auth, input.accountId, { workflows: ['custom_appraisal'],
        permissionChecker: (auth, workflow, permission) => hasApplicationPermission(auth, workflow, permission, scope.organization_id) });
      const startedAt = await databaseTime(client);
      const spatial = captured(await captureNeighborhoodSpatialMembership(client, point.geometry_input), 'spatial');
      const selector = prepareNeighborhoodSelectorInputV1({ profile_id: study.profile_id, ...context,
        selection: { id: input.operationId, revision: 1, source_sha256: spatial.membership_sha256 },
        geometry_input: point.geometry_input,
        discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
        roster: { complete: true, account_count: spatial.account_ids.length, account_ids: spatial.account_ids } });
      if (selector.status !== 'prepared') fail('selector_incomplete', selector.reason);
      const access = createNeighborhoodCachedReadAccess({
        resolveAuthorizedAssignment: async () => { assertTarget(await resolveTarget(client, input, false), subject.target); return context; },
        resolveTrustedSelection: async () => ({ ...selector.selection, account_ids: selector.account_roster.account_ids }),
        authorizeMarketData: async (auth, current, requestedPurpose) => {
          purpose = requestedPurpose;
          decision = await boundedPolicy(authorizeMarketData, client, auth, current, requestedPurpose, budget);
          budget.check(); return decision;
        },
        resolveTransactionClosure: async () => {
          const closure = captured(await resolveNeighborhoodCachedTransactionClosure(client, {
            selected_account_ids: spatial.account_ids, source_revision: `cached-identity-v1:${input.operationId}`,
          }, { deadline: budget.deadline, signal: budget.signal }), 'transaction_identity');
          if (!same(closure.snapshot, spatial.snapshot)) fail('snapshot_changed');
          return closure.transaction_closure;
        },
      });
      const grants = await access.prepare(input.auth, { target: context.target,
        selection_reference: { id: input.operationId, revision: 1 }, observation_period: input.observationPeriod, knowledge_cutoff: null });
      const reader = createNeighborhoodCachedSourceReader(pool, { access });
      const result = captured(await reader.captureInSnapshot(client, { ...grants.request, auth: input.auth,
        selection_grant: grants.selection_grant, market_grant: grants.market_grant },
      { deadline: budget.deadline, signal: budget.signal }), 'source');
      if (!same(result.snapshot, spatial.snapshot)) fail('snapshot_changed');
      return { spatial, selector, reader, result, startedAt, completedAt: await databaseTime(client) };
    });
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true), subject.target);
      const subjects = createCustomCohortSubjectRepository(client, scopeJson);
      if ((await subjects.compareCurrent(subjectReference)).status !== 'matched') fail('subject_changed');
      const freshDecision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget);
      if (!same(freshDecision, decision)) fail('market_policy_changed');
      budget.check();
      const acquisition = consumeNeighborhoodCachedAcquisition(read.reader, read.result);
      const prepared = prepareCustomCohortCaptureInputs({ acquisition, spatial: read.spatial, subject,
        subject_reference: subjectReference, selector: read.selector, study, acquisition_intent: intent,
        started_at: read.startedAt, completed_at: read.completedAt });
      const refs = await persistCustomCohortCaptureInputs(client, scopeJson, prepared);
      budget.check();
      const header = { context_version: 1, context_id: input.operationId, context_revision: '1',
        target: { ...context.target, ...context.scope, snapshot_version: subject.target.snapshot_version },
        effective_date: subject.effective_date, ...refs };
      const stored = await createCustomCohortContextRepository(client, scopeJson).put(canonicalAssessmentJson(header));
      return freeze({ status: 'registered', reused: stored.status === 'reused', context_ref: stored.context_ref,
        discovery: { radius_metres: '4828.032', parcel_count: read.spatial.parcels.length, account_count: read.spatial.account_ids.length },
        source_query_complete: true, provider_coverage: 'not_established',
        unsupported_capabilities: read.result.unsupported_capabilities });
    });
  }, async review(value, options = {}) {
    const input = reviewInputOf(value), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true, 'write');
      if (input.command.target_ref.report_file_id !== target.report_file_id) fail('operation_conflict');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.command.expected_context,
        input, authorizeMarketData, budget, loadInputs: false });
      budget.check();
      const saved = await createCustomCohortReviewRepository(client, scopeJson)
        .append(input.commandJson, input.auth.userId);
      budget.check();
      assertTarget(await resolveTarget(client, input, true, 'write'), target);
      const finalDecision = await boundedPolicy(authorizeMarketData, client, input.auth,
        licensed.context, licensed.purpose, budget);
      if (!same(finalDecision, licensed.decision)) fail('market_policy_changed');
      // Opaque operation metadata only: no retained MLS field, claim, reviewer
      // label or raw evidence is exposed by a retention-only rights decision.
      // transaction() delivers this value only after COMMIT; an uncertain COMMIT
      // throws with outcome_unknown, allowing a later exact authorized retry.
      return freeze({ status: 'review_recorded', reused: saved.status === 'reused',
        context_ref: input.command.expected_context, decision_ref: saved.decision_ref,
        generation: saved.generation, authority: 'not_established' });
    });
  }, preview(value, options = {}) {
    return runPreview(value, options);
  }, catalog(value, options = {}) {
    return runPreview(value, options, { includeMap: false, exposure: 'report_observation_catalog',
      project: (preview, expected, _parcelMap, retained_inputs) => ({ status: 'catalog',
        catalog: presentCustomCohortPocketCatalog({
          catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview }), preview, expected,
        }),
      }),
    });
  }, present(value, presentation = { includeMap: true }, options = {}) {
    exactKeys(presentation, ['includeMap']);
    if (typeof presentation.includeMap !== 'boolean') fail('invalid_input');
    return runPreview(value, options, { includeMap: presentation.includeMap, exposure: 'report_observation_summary',
      project: (preview, expected, parcelMap) => ({ summary: presentCustomCohortPreview({ preview, expected }), parcel_map: parcelMap }) });
  }, inspect(value, inspection, options = {}) {
    exactKeys(inspection, ['population', 'page']);
    const owned = freeze(JSON.parse(canonicalAssessmentJson(inspection)));
    return runPreview(value, options, { includeMap: false, exposure: 'report_observation_members',
      project: (preview, expected) => ({ status: 'members', page: inspectCustomCohortPreviewMembers({ preview, expected, ...owned }) }) });
  } });
}
