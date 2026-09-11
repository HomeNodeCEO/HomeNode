import { performance } from 'node:perf_hooks';
import { CUSTOM_COHORT_OPERATION_LIMITS } from './customCohortOperationLimits.js';
import { createCustomCapturePhaseTiming } from './customCapturePhaseTiming.js';
import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { decideAssignmentAccess } from '../../security/assignmentAccess.js';
import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { customNeighborhoodPrivateSalesPurpose } from '../../security/customNeighborhoodPrivateSalesPolicy.js';
import { captureAssignmentSalesCsv, recheckAssignmentSalesCsvCapture } from '../assignmentSalesCsv/capture.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations } from './customCohortPrivateSales.js';
import { authorizePublicCadastralCatalogRead } from '../../security/publicCadastralCatalog.js';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodCohortBlobRepository } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { createCustomCohortContextRepository } from './customCohortContextRepository.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { captureNeighborhoodSpatialMembershipStream } from './cachedSpatialMembership.js';
import { resolveNeighborhoodCachedTransactionClosure } from './cachedTransactionClosureReader.js';
import { createNeighborhoodCadEvidenceReadAccess, describeNeighborhoodCachedMarketDataPurpose,
  describeNeighborhoodSaleWitnessMarketDataPurpose } from './cachedReadAccess.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, consumeNeighborhoodCachedAcquisition } from './cachedSourceReader.js';
import { NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, prepareNeighborhoodSelectorInput,
  prepareNeighborhoodDiscoveryChoice, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY,
  NEIGHBORHOOD_CITY_PARCEL_PREDICATE } from './selectorInputProfile.js';
import { loadInstalledCustomCityDiscovery } from './customCityDiscovery.js';
import { prepareCustomCohortCaptureInputsBatched, persistCustomCohortCaptureInputs,
  loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreviewBatched,
  CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { buildCustomCohortParcelMapBatched } from './customCohortParcelMap.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers, customCohortPreviewBinding } from './customCohortPreviewPresentation.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog, CUSTOM_COHORT_POCKET_CATALOG_LIMITS,
  CUSTOM_COHORT_DENSE_CATALOG_VERSION } from './customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendationPresentation } from './customCohortPocketRecommendationPresentation.js';
import { deriveCustomCohortRecordedProximity } from './customCohortRecordedProximity.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createCustomCohortReviewRepository } from './customCohortReviewRepository.js';
import { buildCustomCohortSupportedInputs } from './customCohortSupportedInputs.js';
import { customCohortCurrentStockSupport } from './customCohortTemporalSupport.js';
import { buildCustomCohortReportPreparation } from './customCohortReportPreparation.js';
import { buildCustomCohortReportedAssessment } from './customCohortReportedAssessment.js';
import { createNeighborhoodAssessmentRepositoryInTransaction } from './assessmentRepository.js';
import { getNeighborhoodAttachment, persistNeighborhoodAttachment } from './applicationRepository.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply,
  prepareCustomNeighborhoodReportReplacement, CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION } from './customReportMapping.js';
import { buildNeighborhoodApplicationReceipt } from './applicationGroup.js';
import { getCustomNeighborhoodAcceptance } from './customAcceptanceRepository.js';
import { saveCustomNeighborhoodAcceptanceInTransaction } from './customAcceptanceSave.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography,
  CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS, CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS } from './customCohortReportGeography.js';
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from './customAcceptanceSnapshot.js';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, CUSTOM_NEIGHBORHOOD_DENSE_WORKSPACE_CHECKPOINT_LIMITS,
  readCustomNeighborhoodWorkspaceCheckpoint, customWorkspaceCatalogVersion } from './customWorkspaceCheckpoint.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const TARGET_FIELDS = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const DEPENDENCIES = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const LIMITS = Object.freeze({ ...CUSTOM_COHORT_OPERATION_LIMITS, connect_ms: 3000, query_ms: 6000, cleanup_ms: 1000 });
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason, detail, captureCounts) {
  throw Object.assign(new Error(`custom_cohort_capture_${reason}`), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason, ...(detail ? { detail } : {}),
    ...(captureCounts ? { capture_counts: captureCounts } : {}),
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
  const hasPrivate = Object.hasOwn(input, 'privateSalesImport');
  const hasDiscovery = Object.hasOwn(input, 'discovery');
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'operationId', 'observationPeriod',
    ...(hasPrivate ? ['privateSalesImport'] : []), ...(hasDiscovery ? ['discovery'] : [])]);
  const identity = identityOf(input), { operationId } = input;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('invalid_operation');
  exactKeys(input.observationPeriod, ['start_date', 'end_date']);
  const period = Object.fromEntries(Object.entries(input.observationPeriod).map(([key, value]) => [key, assessmentDate(value)]));
  if (period.start_date > period.end_date) fail('invalid_period');
  let privateSalesImport;
  let discovery;
  if (hasDiscovery) {
    try { discovery = prepareNeighborhoodDiscoveryChoice(input.discovery); }
    catch { fail('invalid_discovery'); }
  }
  if (hasPrivate) {
    try {
      const purpose = customNeighborhoodPrivateSalesPurpose(input.privateSalesImport);
      privateSalesImport = { batch_id: purpose.batch_id, expected_review_revision: purpose.expected_review_revision };
    } catch { fail('invalid_private_sales_import'); }
  }
  return freeze({ ...identity, operationId, observationPeriod: period,
    ...(hasPrivate ? { privateSalesImport } : {}), ...(hasDiscovery ? { discovery } : {}) });
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
function reviewedInputsInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'contextRef',
    'expectedWorkspaceRevision', 'expectedReviewGeneration']);
  const identity = identityOf(input);
  const contextRef = prepareCustomCohortContextReference(canonicalAssessmentJson(input.contextRef));
  const { expectedWorkspaceRevision, expectedReviewGeneration } = input;
  if (!Number.isInteger(expectedWorkspaceRevision) || expectedWorkspaceRevision < 1
    || expectedWorkspaceRevision > 2_147_483_647
    || typeof expectedReviewGeneration !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(expectedReviewGeneration)
    || BigInt(expectedReviewGeneration) > 9223372036854775807n) fail('invalid_reviewed_input_revision');
  return freeze({ ...identity, contextRef, expectedWorkspaceRevision, expectedReviewGeneration });
}
function reportedInputOf(value, applying = false) {
  if (utilTypes.isProxy(value)) fail('invalid_reported_input');
  const replacing = value && Object.hasOwn(value, 'replacement');
  exactKeys(value, ['auth', 'accountId', 'assignmentFileId', 'contextRef', 'expectedWorkspaceRevision',
    'expectedEditorRevision', 'operationId', ...(applying ? ['proposalOperationId', 'attachmentId',
      'attachmentRevision', 'bindingDigest', 'adopt'] : []), ...(replacing ? ['replacement'] : [])]);
  const identity = identityOf(value);
  const input = { ...identity, contextRef: prepareCustomCohortContextReference(canonicalAssessmentJson(value.contextRef)),
    expectedWorkspaceRevision: value.expectedWorkspaceRevision, expectedEditorRevision: value.expectedEditorRevision,
    operationId: value.operationId };
  if (!Number.isInteger(input.expectedWorkspaceRevision) || input.expectedWorkspaceRevision < 1
    || input.expectedWorkspaceRevision > 2147483647 || !Number.isInteger(input.expectedEditorRevision)
    || input.expectedEditorRevision < 0 || input.expectedEditorRevision >= 2147483647
    || typeof input.operationId !== 'string' || !UUID.test(input.operationId)
    || !UUID.test(identity.auth.userId) || BigInt(identity.assignmentFileId) > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_reported_input');
  if (applying) {
    if (value.adopt !== true || typeof value.proposalOperationId !== 'string' || !UUID.test(value.proposalOperationId)
      || typeof value.attachmentId !== 'string' || !UUID.test(value.attachmentId)
      || !Number.isInteger(value.attachmentRevision) || value.attachmentRevision < 1 || value.attachmentRevision > 2147483647
      || typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingDigest)) fail('invalid_reported_input');
    Object.assign(input, { proposalOperationId: value.proposalOperationId, attachmentId: value.attachmentId,
      attachmentRevision: value.attachmentRevision, bindingDigest: value.bindingDigest, adopt: true });
  }
  if (replacing) {
    try {
      const dataObject = (raw, keys) => {
        if (!raw || utilTypes.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail('invalid_reported_input');
        const descriptors = Object.getOwnPropertyDescriptors(raw);
        if (Reflect.ownKeys(descriptors).length !== keys.length
          || !keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')
            && descriptors[key].enumerable)) fail('invalid_reported_input');
        return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
      };
      const supplied = Object.getOwnPropertyDescriptor(value, 'replacement');
      if (!supplied || !Object.hasOwn(supplied, 'value')) fail('invalid_reported_input');
      const replacement = dataObject(supplied.value, applying ? ['kind', 'predecessor'] : ['kind']);
      if (replacement.kind !== 'accepted_custom_reported_group') fail('invalid_reported_input');
      if (applying) {
        replacement.predecessor = dataObject(replacement.predecessor,
          ['acceptance_id', 'operation_id', 'accepted_editor_revision', 'section_value_sha256']);
        const p = replacement.predecessor;
        if (typeof p.acceptance_id !== 'string' || !UUID.test(p.acceptance_id)
          || typeof p.operation_id !== 'string' || !UUID.test(p.operation_id)
          || !Number.isInteger(p.accepted_editor_revision) || p.accepted_editor_revision < 1 || p.accepted_editor_revision >= 2147483647
          || typeof p.section_value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.section_value_sha256)) fail('invalid_reported_input');
      }
      input.replacement = replacement;
    } catch { fail('invalid_reported_input'); }
  }
  return freeze(input);
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

async function savedWorkspace(client, input) {
  // Existing saves/signing lock this parent before changing any section. Do not
  // call getCustomAppraisalWorkfile: that can create rows and use another pool
  // connection. Missing/invalid saved intent must never become broad defaults.
  const file = await client.query(`/* custom-cohort-capture:workspace-parent */
    SELECT assignment_file_id::text FROM app.custom_appraisal_workfiles
    WHERE assignment_file_id=$1::bigint FOR SHARE NOWAIT`, [input.assignmentFileId]);
  if (file?.rowCount !== 1 || file.rows?.length !== 1
    || file.rows[0].assignment_file_id !== input.assignmentFileId) fail('workspace_unavailable');
  const result = await client.query(`/* custom-cohort-capture:workspace */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= $3::integer
      THEN section_value ELSE NULL END AS value
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
    // JSONB's spaces are not the checkpoint's canonical representation. Bound
    // transport generously, then apply each saved version's exact canonical limit.
    CUSTOM_NEIGHBORHOOD_DENSE_WORKSPACE_CHECKPOINT_LIMITS.canonical_utf8_bytes * 2]);
  if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('workspace_unavailable');
  const restored = readCustomNeighborhoodWorkspaceCheckpoint(result.rows[0]);
  if (restored.status !== 'restored' || restored.checkpoint.active === null) fail('workspace_unavailable');
  if (restored.section_revision !== input.expectedWorkspaceRevision
    || !same(restored.checkpoint.active.context_ref, input.contextRef)) fail('workspace_changed');
  if (restored.checkpoint.pending_capture !== null) fail('workspace_capture_pending');
  return restored;
}

async function reportEditorState(client, input) {
  // The already-held workfile parent lock protects the absent-row case. Read
  // the actual reserved section, NOT the workspace/checkpoint revision. Only a
  // bounded hash crosses this boundary; existing accepted contents stay private.
  const result = await client.query(`/* custom-cohort-capture:report-editor */
    SELECT revision, CASE WHEN octet_length(section_value::text) <= 4000000
      THEN encode(sha256(convert_to(section_value::text,'UTF8')),'hex') ELSE NULL END AS value_sha256
    FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
  [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
  if (result?.rowCount === 0 && result.rows?.length === 0) return { editor_revision: 0, value_sha256: null };
  if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('report_editor_unavailable');
  const row = result.rows[0];
  if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2_147_483_647
    || typeof row.value_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.value_sha256)) fail('report_editor_unavailable');
  return { editor_revision: row.revision, value_sha256: row.value_sha256 };
}

async function reportGeographyState(client, input) {
  // resolveTarget already holds this exact assignment row. Select only saved
  // narrative-boundary fields, preserving missing keys versus explicit JSON null.
  // Neither the account-level fallback nor unrelated client/contract data enters
  // this capture. Meter the projection in PostgreSQL before sending any text.
  const row = one(await client.query(`/* custom-cohort-capture:report-geography */
    WITH projected AS MATERIALIZED (
      SELECT id::text AS assignment_file_id,account_id,revision AS assignment_revision,
        CASE WHEN assignment_details IS NULL THEN 'sql_null' ELSE jsonb_typeof(assignment_details) END AS details_type,
        CASE WHEN jsonb_typeof(assignment_details)='object' THEN (
          SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb)
          FROM jsonb_each(CASE WHEN jsonb_typeof(assignment_details)='object' THEN assignment_details ELSE '{}'::jsonb END)
          WHERE key=ANY($3::text[])) ELSE NULL END AS fields
      FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2
    ) SELECT assignment_file_id,account_id,assignment_revision,details_type,
      octet_length(fields::text) AS projected_utf8_bytes,
      CASE WHEN octet_length(fields::text)<=$4::integer
        THEN encode(sha256(convert_to(fields::text,'UTF8')),'hex') ELSE NULL END AS projected_sha256,
      CASE WHEN octet_length(fields::text)<=$4::integer THEN fields::text ELSE NULL END AS projected_json
    FROM projected`, [input.assignmentFileId, input.accountId, CUSTOM_COHORT_REPORT_GEOGRAPHY_FIELDS,
    CUSTOM_COHORT_REPORT_GEOGRAPHY_LIMITS.projected_utf8_bytes]));
  if (row.assignment_file_id !== input.assignmentFileId || row.account_id !== input.accountId) fail('report_geography_unavailable');
  return { assignment_revision: row.assignment_revision, projection: { details_type: row.details_type,
    projected_utf8_bytes: row.projected_utf8_bytes, projected_sha256: row.projected_sha256, projected_json: row.projected_json } };
}
async function reportGeometryTopology(client, geometry, point) {
  // Only the pure module's bounded structural Polygon admission reaches PostGIS.
  // Validate exactly those saved coordinates; never ST_MakeValid, snap or repair.
  // The point is represented from the SAME retained subject snapshot used for
  // discovery, not a mutable account location, browser input or geocoder result.
  // Keep border coverage distinct from strict interior containment. Do not run
  // spatial predicates on invalid geometry (including self-intersections).
  return one(await client.query(`/* custom-cohort-capture:report-geography-topology */
    WITH supplied AS MATERIALIZED (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom),
    checked AS MATERIALIZED (SELECT geom,ST_IsValid(geom) AS is_valid,
      ST_IsValidReason(geom) AS validation_reason,ST_GeometryType(geom) AS geometry_type,
      ST_IsEmpty(geom) AS is_empty,ST_NumGeometries(geom) AS component_count FROM supplied)
    SELECT is_valid,validation_reason,geometry_type,is_empty,component_count,
      postgis_lib_version() AS postgis_version,
      CASE WHEN is_valid AND NOT is_empty AND geometry_type='ST_Polygon' AND component_count=1
        AND $2::double precision IS NOT NULL AND $3::double precision IS NOT NULL
        THEN ST_Covers(geom,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326))
        ELSE NULL END AS covers_recorded_subject_point,
      CASE WHEN is_valid AND NOT is_empty AND geometry_type='ST_Polygon' AND component_count=1
        AND $2::double precision IS NOT NULL AND $3::double precision IS NOT NULL
        THEN ST_Contains(geom,ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326))
        ELSE NULL END AS contains_recorded_subject_point FROM checked`,
    [canonicalAssessmentJson(geometry), point?.coordinates[0] ?? null, point?.coordinates[1] ?? null]));
}

function operationBudget(options = {}, durationMs = LIMITS.duration_ms) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => !['signal', 'deadline'].includes(key))
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    || (options.deadline !== undefined && !Number.isFinite(options.deadline))) fail('invalid_options');
  const finalDeadline = Math.min(performance.now() + durationMs, options.deadline ?? Infinity);
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
  let open = false, closed = false, discard = null, connectionError = null, commitAttempted = false;
  // A checked-out pg client can emit a socket/idle-timeout error while pure
  // work runs between queries. Own that event until release; never allow an
  // unhandled EventEmitter error to terminate the web process.
  const connectionFailed = error => { connectionError ||= error; discard ||= error; };
  raw.on?.('error', connectionFailed);
  const client = Object.freeze({
    query: async (sql, values) => {
      if (closed) fail('closed_operation');
      // A failed statement still permits the owner's savepoint cleanup; a
      // socket error does not. Both cause this connection to be discarded.
      if (connectionError) throw connectionError;
      budget.check();
      const config = typeof sql === 'string' ? { text: sql, values } : { ...sql };
      config.query_timeout = Math.min(config.query_timeout ?? LIMITS.query_ms, budget.remaining(LIMITS.query_ms));
      try { const result = await raw.query(config); if (connectionError) throw connectionError; budget.check(); return result; }
      catch (error) {
        discard = error;
        // A driver timeout can win the race with the aggregate clock. Classify
        // from our own deadline/signal, never from private driver error text.
        budget.check();
        throw error;
      }
    },
    release() { fail('transaction_owner_required'); },
  });
  try {
    open = true; // BEGIN timeout leaves uncertain state too.
    await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
    await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'; SET LOCAL jit=off");
    const result = await execute(client);
    if (discard) throw discard;
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
    finally { raw.off?.('error', connectionFailed); }
  }
}

async function resolveTarget(client, input, locked, permission = 'write', lockReport = false) {
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
      AND workflow_type='custom_appraisal' AND uad_workfile_id IS NULL AND tax_protest_file_id IS NULL${lockReport ? ' FOR SHARE NOWAIT' : ''}`,
  [input.assignmentFileId, input.accountId, assignment.organization_id]));
  return freeze({ ...Object.fromEntries(TARGET_FIELDS.filter(key => key !== 'report_file_id').map(key => [key, assignment[key]])), ...report });
}
async function privateCaptureWorkfile(client, input) {
  // The upload/review and signing owners lock the workfile before assignment
  // rows. Follow that same order for this additive private-capture write path.
  await resolveTarget(client, input, false);
  return one(await client.query(`/* custom-cohort-capture:private-workfile */
    SELECT status,signed_at,EXISTS (SELECT 1 FROM app.custom_appraisal_signed_snapshots s
      WHERE s.assignment_file_id=w.assignment_file_id) AS has_signed_snapshot
    FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1::bigint FOR UPDATE NOWAIT`, [input.assignmentFileId]));
}
function privateDraft(workfile) {
  if (workfile.status !== 'draft' || workfile.signed_at !== null || workfile.has_signed_snapshot !== false) fail('private_source_read_only');
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
    value?.reason ?? value?.incomplete_reasons ?? 'unavailable', value?.counts);
  return value;
}

async function authorizedRetainedInputs(client, { scopeJson, reference, input, authorizeMarketData, authorizePrivateSales, budget, study = null,
  exposure = 'none', additionalExposures = [], loadInputs = true, privateSummary = false, beforeLoad = null }) {
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
  // never today's producer default. v3 cannot reopen under a narrower v2 grant;
  // CAD-only v4 keeps the original market-data purpose without MLS witnesses.
  if (compact.reader_version !== 'local-capture-v3' || ![1, 2, 3, 4].includes(compact.mapping_version)
    || !same(compact.scope, requestMetadata.scope) || compact.effective_date !== requestMetadata.effective_date
    || !same(compact.authorization?.target, requestMetadata.target)
    || !same(compact.authorization?.market_decision, requestMetadata.market_decision)) fail('operation_conflict');
  const purpose = compact.mapping_version === 3 ? describeNeighborhoodSaleWitnessMarketDataPurpose(requestMetadata)
    : describeNeighborhoodCachedMarketDataPurpose(requestMetadata);
  const decision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget, exposure);
  if (!same({ decision_id: decision.decision_id, policy_revision: decision.policy_revision }, requestMetadata.market_decision)) fail('market_policy_changed');
  for (const additional of additionalExposures) {
    const permitted = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget, additional);
    if (!same(permitted, decision)) fail('market_policy_changed');
  }
  let privateAuthorization = null;
  if (directory.selection_input_version === 2) {
    // Authorize the distinct private-data purpose before opening any row page.
    const metadata = await readMetadata(directory.private_sales?.metadata);
    const original = await readMetadata(directory.private_sales?.authorization);
    const privatePurpose = customNeighborhoodPrivateSalesPurpose({ batch_id: metadata.batch?.batch_id,
      expected_review_revision: metadata.review?.revision });
    const privateDecision = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget, exposure);
    if (!same(original, { decision_id: privateDecision.decision_id, policy_revision: privateDecision.policy_revision })) fail('market_policy_changed');
    for (const additional of new Set([...additionalExposures, ...(privateSummary ? ['report_observation_summary'] : [])])) {
      const permitted = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget, additional);
      if (!same(permitted, privateDecision)) fail('market_policy_changed');
    }
    privateAuthorization = { purpose: privatePurpose, decision: privateDecision };
  }
  // Review persistence will reopen the original graph in this same transaction.
  // Keep its preceding rights check, without allocating/validating it twice.
  const metadata = { context, purpose, decision, privateAuthorization, header: previous };
  const beforeLoadResult = beforeLoad === null ? null : await beforeLoad(metadata);
  const retained = loadInputs ? await loadCustomCohortCaptureInputs(client, scopeJson, refs) : null;
  // A checkpoint is editor intent, not authority to relabel a retained study.
  // Check the discovery binding as well as its dates before report preparation.
  if (study && retained && !same(study.discovery ?? null, retained.study.discovery ?? null)) fail('operation_conflict');
  return { ...metadata, retained, ...(beforeLoad === null ? {} : { beforeLoadResult }) };
}

/** Executable, Custom-only acquisition owner. No HTTP route, current-head
 * change, report publication, Apply or signing occurs here. The internal
 * prepareReviewedInputs method computes exact retained/reviewed inputs only;
 * no route may expose its source-bearing result under a retention-only grant.
 * The review method retains exact authenticated reviewer commands only; stored
 * observations/assertions do not become certified facts or accepted statistics.
 * authorizeMarketData is a required SERVER policy and must explicitly cover
 * cached source rows, all-date one-hop identities and immutable retention. It
 * receives only this bounded client; it may not read a pool or a remote provider.
 * No default grant is inferred from assignment access, hashes or professional
 * licensing. Source completeness and historical support remain unknown.
 */
export function createCustomCohortContextCapture({ pool, authorizeMarketData,
  authorizePrivateSales = async () => ({ allowed: false }),
  authorizeReportedObservations = async () => ({ allowed: false }) } = {}) {
  if (typeof pool?.connect !== 'function' || typeof authorizeMarketData !== 'function'
    || typeof authorizeReportedObservations !== 'function') {
    throw new TypeError('custom_cohort_capture_dependencies_required');
  }
  async function recheckPrivatePolicy(client, input, loaded, budget, exposures = ['none']) {
    if (!loaded.privateAuthorization) return;
    for (const exposure of exposures) {
      const decision = await boundedPolicy(authorizePrivateSales, client, input.auth, loaded.context,
        loaded.privateAuthorization.purpose, budget, exposure);
      if (!same(decision, loaded.privateAuthorization.decision)) fail('market_policy_changed');
    }
  }
  function reportPurpose(input, retained) {
    const privatePurpose = retained.privateAuthorization?.purpose;
    return { kind: 'custom_reported_observations_v2', context_ref: input.contextRef,
      shared_source_purpose: retained.purpose, private_sales_import: privatePurpose ? {
        batch_id: privatePurpose.batch_id, expected_review_revision: privatePurpose.expected_review_revision } : null };
  }
  async function reportPermission(client, input, retained, budget) {
    try {
      return await boundedPolicy(authorizeReportedObservations, client, input.auth, retained.context,
        reportPurpose(input, retained), budget, 'custom_report_observations');
    } catch (error) {
      if (error?.reason === 'market_data_access_denied') fail('report_observation_access_denied');
      throw error;
    }
  }
  function reportRequest(input, target) {
    return { actor_user_id: input.auth.userId, target: Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])),
      context_ref: input.contextRef, workspace_section_revision: input.expectedWorkspaceRevision,
      editor_revision: input.expectedEditorRevision, operation_id: input.proposalOperationId ?? input.operationId,
      ...(input.replacement ? { replacement: { kind: input.replacement.kind } } : {}) };
  }
  function reportFences(loaded) {
    return { workspace_sha256: assessmentEvidenceDigest(loaded.workspace), editor: loaded.reportEditor,
      boundary: { assignment_revision: loaded.savedBoundary.assignment_revision,
        ...Object.fromEntries(Object.entries(loaded.savedBoundary.projection).filter(([key]) => key !== 'projected_json')) },
      subject_reference: loaded.retained.retained.subject_reference,
      market_decision: loaded.retained.decision, private_decision: loaded.retained.privateAuthorization?.decision ?? null,
      report_decision: loaded.retained.beforeLoadResult,
      ...(loaded.replacement ? { replacement: loaded.replacement.fence } : {}) };
  }
  const attachmentTarget = (target, id, revision) => ({ organizationId: target.organization_id,
    reportFileId: target.report_file_id, workflowType: 'custom_appraisal', workflowTargetId: Number(target.assignment_file_id),
    attachmentId: id, attachmentRevision: revision });
  const publicReplacement = fence => ({ kind: 'accepted_custom_reported_group', predecessor: fence.predecessor });
  async function reportedPredecessor(client, input, target) {
    // The workfile/assignment/report locks are already held in that order. Read
    // only the current operation pointer, then verify its immutable acceptance,
    // attachment, complete section and exact history via the existing readers.
    const rows = await client.query(`/* custom-cohort-capture:reported-predecessor */
      SELECT revision,CASE WHEN octet_length(section_value::text)<=4000000
        THEN section_value->>'operation_id' ELSE NULL END AS operation_id
      FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
    [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
    if (rows?.rowCount !== 1 || rows.rows?.length !== 1
      || rows.rows[0].revision !== input.expectedEditorRevision
      || typeof rows.rows[0].operation_id !== 'string' || !UUID.test(rows.rows[0].operation_id)) fail('report_replacement_conflict');
    let accepted, stored;
    try {
      accepted = await getCustomNeighborhoodAcceptance(client, { organizationId: target.organization_id,
        reportFileId: target.report_file_id, assignmentFileId: Number(input.assignmentFileId), operationId: rows.rows[0].operation_id });
      if (!accepted) fail('report_replacement_conflict');
      stored = await getNeighborhoodAttachment(client, attachmentTarget(target, accepted.attachmentId, accepted.attachmentRevision));
    } catch (error) {
      // Preserve query cancellation/busy and other database failures; only the
      // existing integrity reader's fixed mismatch errors become this conflict.
      if (typeof error.code === 'string' && error.code.startsWith('custom_neighborhood_acceptance_')) fail('report_replacement_conflict');
      throw error;
    }
    const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
    if (!stored || stored.assessment.contract_version !== 2 || stored.attachment.mapper_version !== CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION
      || !same(stored.assessment.scope, scope) || accepted.acceptedEditorRevision !== input.expectedEditorRevision) fail('report_replacement_conflict');
    const descriptor = { acceptance_id: accepted.id, operation_id: accepted.operationId,
      accepted_editor_revision: accepted.acceptedEditorRevision, section_value_sha256: accepted.snapshot.section_value_sha256 };
    const fence = { predecessor: descriptor, section_history_id: accepted.sectionHistoryId,
      attachment_id: accepted.attachmentId, attachment_revision: accepted.attachmentRevision,
      application_identity_sha256: stored.attachment.application_identity_sha256,
      receipt_digest_sha256: accepted.snapshot.receipt.receipt_digest_sha256 };
    const existingValues = Object.values(accepted.snapshot.section_value.mapped_values).map(item => ({ ...item,
      target_exists: true, populated: true, provenance_digest: accepted.snapshot.receipt.acceptance_manifest.provenance_digest }));
    return { fence, stored, receipt: accepted.snapshot.receipt, existingValues };
  }
  async function storedReportProposal(client, input, target) {
    const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
      .map(key => [key, target[key]]));
    const rows = await client.query(`/* custom-cohort-capture:reported-operation */
      SELECT j.status,j.result_revision,j.input_signature_sha256,j.request_digest_sha256,
        r.request_digest_sha256 AS operation_digest,h.id AS assessment_id,
        j.effective_date::text,j.data_cutoff::text,j.max_attempts,
        CASE WHEN octet_length(j.request_payload::text)<=65536 THEN j.request_payload ELSE NULL END AS payload
      FROM app.neighborhood_assessment_requests r
      JOIN app.neighborhood_assessments h ON h.id=r.assessment_id
      JOIN app.neighborhood_assessment_jobs j ON j.id=r.job_id AND j.assessment_id=h.id
      WHERE h.organization_id=$1 AND h.appraisal_case_id=$2 AND h.subject_snapshot_id=$3 AND h.account_id=$4
        AND r.operation_id=$5`, [...Object.values(scope), input.proposalOperationId ?? input.operationId]);
    if (rows?.rowCount === 0 && rows.rows?.length === 0) return null;
    const row = one(rows), payload = row.payload;
    if (!payload || payload.proposal_version !== (input.replacement ? 2 : 1) || !same(payload.request, reportRequest(input, target))
      || row.status !== 'succeeded' || !Number.isInteger(row.result_revision) || row.result_revision < 1
      || row.max_attempts !== 3 || row.operation_digest !== row.request_digest_sha256
      || assessmentEvidenceDigest({ scope, effective_date: row.effective_date, data_cutoff: row.data_cutoff,
        input_signature_sha256: row.input_signature_sha256, payload, max_attempts: 3 }) !== row.request_digest_sha256) fail('operation_conflict');
    const stored = await getNeighborhoodAttachment(client, attachmentTarget(target, payload.attachment?.id, payload.attachment?.revision));
    if (!stored || stored.assessment.contract_version !== 2 || stored.assessment.id !== row.assessment_id
      || stored.assessment.revision !== row.result_revision || stored.assessment.input_signature_sha256 !== row.input_signature_sha256
      || stored.attachment.editor_revision !== input.expectedEditorRevision) fail('operation_conflict');
    if (input.replacement && (!payload.fences?.replacement
      || (input.proposalOperationId && !same(input.replacement, publicReplacement(payload.fences.replacement))))) fail('report_replacement_conflict');
    return { payload, stored };
  }
  async function loadReported(client, input, budget, { allowSigned = false, geography = true } = {}) {
    const workfile = await privateCaptureWorkfile(client, input);
    if (!allowSigned) privateDraft(workfile);
    const target = await resolveTarget(client, input, true, 'write', true);
    const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
    const workspace = await savedWorkspace(client, input);
    const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
      authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active,
      beforeLoad: metadata => reportPermission(client, input, metadata, budget) });
    const reportEditor = await reportEditorState(client, input), savedBoundary = await reportGeographyState(client, input);
    let reportGeography = null, derivedAt = null;
    if (geography) {
      derivedAt = new Date(Date.parse(await databaseTime(client))).toISOString();
      const admission = prepareCustomCohortReportGeography({ target: JSON.parse(scopeJson), ...savedBoundary,
        captured_at: derivedAt, retained_subject: retained.retained.retained_inputs.subject });
      reportGeography = completeCustomCohortReportGeography(admission, admission.geometry_for_validation === null ? null
        : await reportGeometryTopology(client, admission.geometry_for_validation, admission.subject_point_for_validation));
    }
    return { workfile, target, scopeJson, workspace, retained, reportEditor, savedBoundary, reportGeography, derivedAt };
  }
  async function recheckReported(client, input, loaded, budget, { acceptedReplay = false, editorAfterSave = false } = {}) {
    assertTarget(await resolveTarget(client, input, true, 'write', true), loaded.target);
    if (!same(await savedWorkspace(client, input), loaded.workspace)) fail('workspace_changed');
    if (!editorAfterSave && !same(await reportEditorState(client, input), loaded.reportEditor)) fail('report_editor_changed');
    if (!same(await reportGeographyState(client, input), loaded.savedBoundary)) fail('report_geography_changed');
    if (loaded.replacement && !acceptedReplay && !editorAfterSave
      && !same((await reportedPredecessor(client, input, loaded.target)).fence, loaded.replacement.fence)) fail('report_replacement_conflict');
    if (!acceptedReplay && (await createCustomCohortSubjectRepository(client, loaded.scopeJson)
      .compareCurrent(loaded.retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
    const privateCapture = loaded.retained.retained.retained_inputs.private_sales?.capture;
    if (privateCapture) await recheckAssignmentSalesCsvCapture(client.query.bind(client), privateCapture);
    const decision = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.retained.context,
      loaded.retained.purpose, budget);
    if (!same(decision, loaded.retained.decision)) fail('market_policy_changed');
    await recheckPrivatePolicy(client, input, loaded.retained, budget);
    if (!same(await reportPermission(client, input, loaded.retained, budget), loaded.retained.beforeLoadResult)) fail('report_policy_changed');
  }
  function proposalResponse(input, loaded, candidate, assessment, issues = [], reused = false) {
    const response = { status: candidate?.status === 'ready' ? 'proposed' : 'incomplete',
      target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId }, context_ref: input.contextRef,
      workspace_section_revision: input.expectedWorkspaceRevision, editor_revision: input.expectedEditorRevision,
      proposal_operation_id: input.operationId, reused,
      ...(input.replacement ? { replacement: publicReplacement(loaded.replacement.fence) } : {}),
      attachment_ref: candidate?.status === 'ready' ? { attachment_id: candidate.attachment.attachment_id,
        attachment_revision: candidate.attachment.attachment_revision, binding_digest: candidate.attachment.binding_digest_sha256 } : null,
      assessment: assessment ? { contract_version: 2, assessment_id: assessment.id, revision: assessment.revision,
        status: assessment.application_group.status, basis: 'reported_observations_not_verified_market_facts',
        statistics: assessment.statistics, populations: assessment.populations.map(pop => Object.fromEntries(
          ['id', 'kind', 'member_unit', 'member_count', 'unique_account_count', 'account_link_count'].map(key => [key, pop[key]]))),
        geography_status: assessment.geographic_neighborhood.status,
        boundary: { geometry: assessment.geographic_neighborhood.geometry,
          cardinal_summaries: assessment.geographic_neighborhood.cardinal_summaries } } : null,
      issues: issues.map(item => ({ code: typeof item.code === 'string' && item.code.length <= 200
        && /^[a-zA-Z0-9_:.-]+$/.test(item.code) ? item.code : 'report_preparation_incomplete' })) };
    // A summary never transports sources, member arrays or original CSV rows.
    if (Buffer.byteLength(JSON.stringify(response)) > 524288) fail('report_response_limit');
    return freeze(response);
  }
  async function runPreview(value, options, { includeMap = true, exposure = 'none', additionalExposures = [], outputLimit = null, project } = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    const loaded = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      return { target, scopeJson, ...await authorizedRetainedInputs(client, {
        scopeJson, reference: input.contextRef, input, authorizeMarketData, authorizePrivateSales, budget, exposure, additionalExposures, privateSummary: true,
      }) };
    });
    // Pure presentation happens outside the source-read connection and before
    // the final authorization check. Only an explicitly requested recommendation
    // may run bounded native computation over retained EWKB in a separate RO
    // transaction; it never rereads source tables. Ordinary selection previews
    // and member inspection do not invoke this derivation or resend geometry.
    budget.check();
    // Public summaries/pages/catalogs consume a genuinely indexed internal
    // view. Keep the raw internal preview API's v1 shape and ceiling unchanged.
    const buildPreview = project ? buildCustomCohortIndexedObservationPreviewBatched : buildCustomCohortObservationPreview;
    const preview = await buildPreview({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained_inputs, selection: input.selection }, { check: budget.check });
    budget.check();
    const parcelMap = includeMap ? await buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
      selected_account_ids: [...new Set(input.selection.pockets.flatMap(pocket => pocket.account_ids))] }, { check: budget.check })
      : { status: 'omitted', reason: 'geometry_not_requested' };
    const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
    const deriveProximity = () => transaction(pool, 'REPEATABLE READ READ ONLY', budget,
      client => deriveCustomCohortRecordedProximity((sql, parameters) => client.query(sql, parameters),
        { context_ref: input.contextRef, retained_inputs: loaded.retained.retained_inputs },
        { deadline: budget.deadline, signal: budget.signal }));
    const content = project ? await project(preview, expected, parcelMap, loaded.retained.retained_inputs, deriveProximity)
      : { preview, parcel_map: parcelMap };
    const privateCapture = loaded.retained.retained_inputs.private_sales?.capture;
    const privateObservations = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
      context_ref: input.contextRef, effective_date: loaded.context.effective_date,
      observation_period: loaded.retained.study.observation_period,
      selection: { revision: input.selection.revision, account_ids: [...new Set(input.selection.pockets.flatMap(pocket => pocket.account_ids))].sort() } }) : null;
    const privatePresentation = privateObservations ? presentCustomCohortPrivateSalesObservations({ observations: privateObservations,
      binding: customCohortPreviewBinding(preview, expected) }) : null;
    budget.check();
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), loaded.target);
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.context, loaded.purpose, budget, exposure);
      if (!same(decision, loaded.decision)) fail('market_policy_changed');
      for (const additional of additionalExposures) {
        const permitted = await boundedPolicy(authorizeMarketData, client, input.auth, loaded.context, loaded.purpose, budget, additional);
        if (!same(permitted, loaded.decision)) fail('market_policy_changed');
      }
      await recheckPrivatePolicy(client, input, loaded, budget, [...new Set([exposure, ...additionalExposures, 'report_observation_summary'])]);
      const response = { status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
        ...expected, subject_freshness: 'matched', ...content,
        ...(privatePresentation ? { private_sales: privatePresentation } : {}),
        apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      if (outputLimit !== null && Buffer.byteLength(JSON.stringify(response)) > outputLimit) fail('catalog_transport_limit');
      return freeze(response);
    });
  }
  return Object.freeze({ async capture(value, options = {}) {
    const input = inputOf(value), budget = operationBudget(options, LIMITS.capture_duration_ms);
    budget.check();
    const phase = createCustomCapturePhaseTiming();
    const study = freeze({ profile_id: input.discovery?.profile_id ?? NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
      ...(input.discovery ? { discovery: input.discovery } : {}),
      observation_period: input.observationPeriod, knowledge_cutoff: null });
    const phaseOne = await phase('subject', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const privateWorkfile = input.privateSalesImport ? await privateCaptureWorkfile(client, input) : null;
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
          scopeJson, reference, input, authorizeMarketData, authorizePrivateSales, budget, study,
        });
        if (retained.acquisition_intent.body.actor_user_id !== input.auth.userId || !same(retained.study, study)) fail('operation_conflict');
        if (!same(retained.acquisition_intent.body.private_sales_import ?? null, input.privateSalesImport ?? null)) fail('operation_conflict');
        if ((await repository.compareCurrent(retained.subject_reference)).status !== 'matched') fail('subject_changed');
        // Replay confirms durable registration only, not a new source read or
        // eligible cohort. No raw market evidence is returned here.
        return { replay: freeze({ status: 'registered', reused: true, context_ref: reference,
          discovery: { ...(retained.summary.discovery ?? { radius_metres: retained.summary.radius_metres }), parcel_count: retained.summary.parcel_count,
            account_count: retained.summary.account_count }, source_query_complete: true, provider_coverage: 'not_established',
          unsupported_capabilities: retained.retained_inputs.acquisition.capture_result.unsupported_capabilities,
          ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) }) };
      }
      if (privateWorkfile) privateDraft(privateWorkfile);
      const subjectReference = await repository.capture();
      const subject = await repository.load(subjectReference);
      if (study.observation_period.end_date > subject.effective_date) fail('period_after_effective_date');
      const point = await repository.loadRecordedPoint(subjectReference);
      if (point.status !== 'represented') fail('recorded_point_required', point.reason);
      const body = freeze({ intent_version: input.privateSalesImport ? 2 : 1, operation_id: input.operationId, actor_user_id: input.auth.userId,
        subject_inputs: subjectReference, target: subject.target, effective_date: subject.effective_date,
        study, created_at: await databaseTime(client),
        ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) });
      const reference = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalAssessmentJson(body));
      return { scope, scopeJson, subject, subjectReference, point, intent: { reference, body } };
    }));
    if (phaseOne.replay) return phaseOne.replay;
    const { scope, scopeJson, subject, subjectReference, point, intent } = phaseOne;
    // A saved operation replays its retained original before consulting today's
    // registry. A NEW city study accepts only an installed, dated local asset.
    const city = input.discovery?.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY
      ? await loadInstalledCustomCityDiscovery(input.discovery) : null;
    budget.check();
    const context = contextOf(subject);
    let purpose, decision;
    const read = await transaction(pool, 'REPEATABLE READ READ ONLY', budget, async client => {
      assertTarget(await resolveTarget(client, input, false), subject.target);
      authorizePublicCadastralCatalogRead(input.auth, input.accountId, { workflows: ['custom_appraisal'],
        permissionChecker: (auth, workflow, permission) => hasApplicationPermission(auth, workflow, permission, scope.organization_id) });
      const startedAt = await databaseTime(client);
      let privateSales = null;
      if (input.privateSalesImport) {
        const privatePurpose = customNeighborhoodPrivateSalesPurpose(input.privateSalesImport);
        const permission = await boundedPolicy(authorizePrivateSales, client, input.auth, context, privatePurpose, budget);
        const capture = await captureAssignmentSalesCsv(client.query.bind(client), { target: scope,
          batchId: input.privateSalesImport.batch_id, expectedReviewRevision: input.privateSalesImport.expected_review_revision });
        privateSales = { capture, authorization: { decision_id: permission.decision_id, policy_revision: permission.policy_revision } };
      }
      const spatial = await phase('spatial', async () => captured(await captureNeighborhoodSpatialMembershipStream(client, point.geometry_input, {}, input.discovery, city ?? undefined), 'spatial'));
      // Existing cached-source access requires the subject in the source roster.
      // Never add an outside-city subject to claim complete polygon membership.
      if (city && !spatial.account_ids.includes(scope.account_id)) fail('city_subject_outside_scope');
      const selector = prepareNeighborhoodSelectorInput({ profile_id: study.profile_id, ...context,
        selection: { id: input.operationId, revision: 1, source_sha256: spatial.membership_sha256 },
        geometry_input: point.geometry_input,
        discovery: city ? { city: city.choice.city, parcel_predicate: NEIGHBORHOOD_CITY_PARCEL_PREDICATE }
          : { radius_metres: spatial.radius_metres, distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
        roster: { complete: true, account_count: spatial.account_ids.length, account_ids: spatial.account_ids } });
      if (selector.status !== 'prepared') fail('selector_incomplete', selector.reason);
      // New Custom captures retain the installed CAD-field projection (mapping4).
      // Its market-data purpose and complete-sale closure are unchanged. Existing
      // contexts reopen using their original mapping version; no recapture or
      // retrospective relabeling is performed during read/retry.
      const access = createNeighborhoodCadEvidenceReadAccess({
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
      return phase('source', async () => {
        const grants = await access.prepare(input.auth, { target: context.target,
          selection_reference: { id: input.operationId, revision: 1 }, observation_period: input.observationPeriod, knowledge_cutoff: null });
        const reader = createNeighborhoodDenseCadEvidenceSourceReader(pool, { access });
        const result = captured(await reader.captureInSnapshot(client, { ...grants.request, auth: input.auth,
          selection_grant: grants.selection_grant, market_grant: grants.market_grant },
        { deadline: budget.deadline, signal: budget.signal }), 'source');
        if (!same(result.snapshot, spatial.snapshot)) fail('snapshot_changed');
        return { spatial, selector, reader, result, privateSales, startedAt, completedAt: await databaseTime(client) };
      });
    });
    // Pure original-evidence preparation owns no connection or database locks.
    // The source read has committed; registration below still takes fresh locks
    // and rechecks the subject, assignment, rights and private CSV review before
    // any prepared evidence/context is persisted. Never hold an idle write
    // transaction while encoding a dense area's evidence graph.
    budget.check();
    const prepared = await phase('preparation', () => {
      const acquisition = consumeNeighborhoodCachedAcquisition(read.reader, read.result);
      return prepareCustomCohortCaptureInputsBatched({ acquisition, spatial: read.spatial, subject,
        subject_reference: subjectReference, selector: read.selector, study, acquisition_intent: intent,
        started_at: read.startedAt, completed_at: read.completedAt,
        ...(read.privateSales ? { private_sales: read.privateSales } : {}) }, { check: budget.check });
    });
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      if (read.privateSales) privateDraft(await privateCaptureWorkfile(client, input));
      assertTarget(await resolveTarget(client, input, true), subject.target);
      const subjects = createCustomCohortSubjectRepository(client, scopeJson);
      if ((await subjects.compareCurrent(subjectReference)).status !== 'matched') fail('subject_changed');
      const freshDecision = await boundedPolicy(authorizeMarketData, client, input.auth, context, purpose, budget);
      if (!same(freshDecision, decision)) fail('market_policy_changed');
      if (read.privateSales) {
        const permission = await boundedPolicy(authorizePrivateSales, client, input.auth, context,
          customNeighborhoodPrivateSalesPurpose(input.privateSalesImport), budget);
        if (!same(read.privateSales.authorization, { decision_id: permission.decision_id, policy_revision: permission.policy_revision })) fail('market_policy_changed');
        await recheckAssignmentSalesCsvCapture(client.query.bind(client), read.privateSales.capture);
      }
      budget.check();
      const refs = await phase('retention', () => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
      budget.check();
      const header = { context_version: 1, context_id: input.operationId, context_revision: '1',
        target: { ...context.target, ...context.scope, snapshot_version: subject.target.snapshot_version },
        effective_date: subject.effective_date, ...refs };
      const stored = await phase('registration', () => createCustomCohortContextRepository(client, scopeJson).put(canonicalAssessmentJson(header)));
      return freeze({ status: 'registered', reused: stored.status === 'reused', context_ref: stored.context_ref,
        discovery: { ...(city ? city.choice : { radius_metres: read.spatial.radius_metres }),
          parcel_count: read.spatial.parcels.length, account_count: read.spatial.account_ids.length },
        source_query_complete: true, provider_coverage: 'not_established',
        unsupported_capabilities: read.result.unsupported_capabilities,
        ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) });
    });
  }, async review(value, options = {}) {
    const input = reviewInputOf(value), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true, 'write');
      if (input.command.target_ref.report_file_id !== target.report_file_id) fail('operation_conflict');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.command.expected_context,
        input, authorizeMarketData, authorizePrivateSales, budget, loadInputs: false });
      budget.check();
      const saved = await createCustomCohortReviewRepository(client, scopeJson)
        .append(input.commandJson, input.auth.userId);
      budget.check();
      assertTarget(await resolveTarget(client, input, true, 'write'), target);
      const finalDecision = await boundedPolicy(authorizeMarketData, client, input.auth,
        licensed.context, licensed.purpose, budget);
      if (!same(finalDecision, licensed.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, input, licensed, budget);
      // Opaque operation metadata only: no retained MLS field, claim, reviewer
      // label or raw evidence is exposed by a retention-only rights decision.
      // transaction() delivers this value only after COMMIT; an uncertain COMMIT
      // throws with outcome_unknown, allowing a later exact authorized retry.
      return freeze({ status: 'review_recorded', reused: saved.status === 'reused',
        context_ref: input.command.expected_context, decision_ref: saved.decision_ref,
        generation: saved.generation, authority: 'not_established' });
    });
  }, async prepareReportedObservations(value, options = {}) {
    const input = reportedInputOf(value), budget = operationBudget(options);
    const loaded = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const data = await loadReported(client, input, budget);
      if (data.reportEditor.editor_revision !== input.expectedEditorRevision) fail('report_editor_changed');
      if (input.replacement) data.replacement = await reportedPredecessor(client, input, data.target);
      const previous = await storedReportProposal(client, input, data.target);
      if (previous && !same(previous.payload.fences, reportFences(data))) fail('report_proposal_changed');
      await recheckReported(client, input, data, budget);
      return { ...data, previous };
    });
    if (loaded.previous) return proposalResponse(input, loaded, { status: 'ready',
      attachment: loaded.previous.stored.attachment }, loaded.previous.stored.assessment, [], true);
    const active = loaded.workspace.checkpoint.active;
    const target = { scope: loaded.retained.context.scope, report_file_id: loaded.target.report_file_id,
      custom_assignment_file_id: Number(input.assignmentFileId), editor_revision: input.expectedEditorRevision,
      effective_date: loaded.retained.context.effective_date, data_cutoff: loaded.retained.context.effective_date };
    const identity = { assessment_id: randomUUID(), assessment_revision: 1, attachment_id: randomUUID(), attachment_revision: 1 };
    budget.check();
    const prepared = buildCustomCohortReportedAssessment({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained.retained_inputs, selection: active.selection, target,
      catalog_version: customWorkspaceCatalogVersion(loaded.workspace.checkpoint),
      preparation_identity: identity, report_geography: loaded.reportGeography, derived_at: loaded.derivedAt,
      proposal_binding: { operation_id: input.operationId, actor_user_id: input.auth.userId,
        expected_editor_revision: input.expectedEditorRevision } });
    // Rehearse the exact public shape before any publication writes. The final
    // published identity is checked again after its actual revision is assigned.
    if (prepared.status === 'ready') proposalResponse(input, loaded, prepared.candidate, prepared.assessment);
    budget.check();
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      privateDraft(await privateCaptureWorkfile(client, input));
      await recheckReported(client, input, loaded, budget);
      // Another exact retry may have committed while this request assembled.
      const previous = await storedReportProposal(client, input, loaded.target);
      if (previous) {
        if (!same(previous.payload.fences, reportFences(loaded))) fail('report_proposal_changed');
        return proposalResponse(input, loaded, { status: 'ready', attachment: previous.stored.attachment }, previous.stored.assessment, [], true);
      }
      if (prepared.status !== 'ready') return proposalResponse(input, loaded, null, null, prepared.issues);
      const repository = createNeighborhoodAssessmentRepositoryInTransaction(client);
      const payload = { proposal_version: input.replacement ? 2 : 1, request: reportRequest(input, loaded.target), fences: reportFences(loaded),
        attachment: { id: identity.attachment_id, revision: identity.attachment_revision } };
      if (Buffer.byteLength(canonicalAssessmentJson(payload)) > 32000) fail('report_response_limit');
      const queued = await repository.enqueue(target.scope, { operation_id: input.operationId,
        effective_date: target.effective_date, data_cutoff: target.data_cutoff,
        input_signature_sha256: prepared.assessment.input_signature_sha256, payload });
      const claim = await repository.claimExact(target.scope,
        { job_id: queued.job.id, expected_request_generation: queued.request_generation });
      const published = await repository.publish(claim, prepared.assessment, prepared.publication_bundle.members,
        prepared.publication_bundle.sources.map(source => ({ id: source.snapshot.id, payload: source.payload })));
      if (!published.promoted) fail('report_proposal_changed');
      const candidate = buildCustomNeighborhoodReportCandidate({ assessment: published.assessment,
        target: { ...target, attachment_id: identity.attachment_id, attachment_revision: identity.attachment_revision,
          workflow_type: 'custom_appraisal', uad_workfile_id: null, specification_release: null } });
      if (candidate.status !== 'ready') fail('report_publication_incomplete');
      await persistNeighborhoodAttachment(client, { assessment: published.assessment,
        attachment: candidate.attachment, mappedSuggestions: candidate.suggestions });
      await recheckReported(client, input, loaded, budget);
      return proposalResponse(input, loaded, candidate, published.assessment);
    });
  }, async applyReportedObservations(value, options = {}) {
    const input = reportedInputOf(value, true), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const loaded = await loadReported(client, input, budget, { allowSigned: true, geography: false });
      const proposal = await storedReportProposal(client, input, loaded.target);
      if (!proposal || proposal.stored.attachment.attachment_id !== input.attachmentId
        || proposal.stored.attachment.attachment_revision !== input.attachmentRevision
        || proposal.stored.attachment.binding_digest_sha256 !== input.bindingDigest) fail('operation_conflict');
      const acceptanceTarget = { organizationId: loaded.target.organization_id, reportFileId: loaded.target.report_file_id,
        assignmentFileId: Number(input.assignmentFileId), operationId: input.operationId };
      const accepted = await getCustomNeighborhoodAcceptance(client, acceptanceTarget);
      if (accepted) {
        if (accepted.actorUserId !== input.auth.userId || accepted.attachmentId !== input.attachmentId
          || accepted.attachmentRevision !== input.attachmentRevision
          || accepted.acceptedEditorRevision !== loaded.reportEditor.editor_revision) fail('operation_conflict');
        // The accepted operation itself advanced only the reserved editor. All
        // other proposal bindings, current rights and exact target still apply.
      } else {
        privateDraft(loaded.workfile);
        if (loaded.reportEditor.editor_revision !== input.expectedEditorRevision) fail('report_editor_changed');
        if (input.replacement) {
          loaded.replacement = await reportedPredecessor(client, input, loaded.target);
          if (!same(input.replacement, publicReplacement(loaded.replacement.fence))) fail('report_replacement_conflict');
        } else {
          // Default first adoption retains its exact occupied/history refusal.
          // Explicit replacement never reaches these empty-slot assumptions.
          if (loaded.reportEditor.editor_revision !== 0) fail('report_group_conflict');
          const history = one(await client.query(`/* custom-cohort-capture:reported-never-accepted */
            SELECT EXISTS(SELECT 1 FROM app.custom_neighborhood_acceptances
              WHERE assignment_file_id=$1::bigint) AS has_acceptance`, [input.assignmentFileId]));
          if (history.has_acceptance !== false) fail('report_group_conflict');
        }
      }
      const fences = reportFences(loaded);
      if (accepted) {
        fences.editor = proposal.payload.fences.editor;
        // Replay belongs to the successor: its predecessor is now historical.
        // The immutable proposal and exact echoed descriptor bind the old group;
        // do not require it to be current again or overwrite the current successor.
        if (input.replacement) fences.replacement = proposal.payload.fences.replacement;
      }
      if (!same(fences, proposal.payload.fences)) fail('report_proposal_changed');
      await recheckReported(client, input, loaded, budget, { acceptedReplay: Boolean(accepted) });
      let result = accepted;
      if (!accepted) {
        const stored = proposal.stored, attachment = stored.attachment;
        const planInput = { assessment: stored.assessment, target: attachment,
          current_application_identity_sha256: attachment.application_identity_sha256,
          current_editor_revision: loaded.reportEditor.editor_revision,
          request: { selected_ids: stored.mappedSuggestions.map(item => item.id), binding_digest_sha256: input.bindingDigest } };
        const plan = input.replacement ? prepareCustomNeighborhoodReportReplacement({ ...planInput,
          existing_values: loaded.replacement.existingValues,
          predecessor: { assessment: loaded.replacement.stored.assessment, attachment: loaded.replacement.stored.attachment,
            receipt: loaded.replacement.receipt } })
          : prepareCustomNeighborhoodReportApply({ ...planInput,
            existing_values: stored.mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })) });
        if (plan.status !== 'ready') fail(input.replacement ? 'report_replacement_conflict' : 'report_group_conflict');
        result = await saveCustomNeighborhoodAcceptanceInTransaction(client, { ...acceptanceTarget,
          actorUserId: input.auth.userId, attachmentId: input.attachmentId, attachmentRevision: input.attachmentRevision,
          receipt: buildNeighborhoodApplicationReceipt(plan, input.expectedEditorRevision + 1) });
      }
      await recheckReported(client, input, loaded, budget, { acceptedReplay: Boolean(accepted), editorAfterSave: !accepted });
      return freeze({ status: 'accepted', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
        context_ref: input.contextRef, operation_id: input.operationId, proposal_operation_id: input.proposalOperationId,
        accepted_editor_revision: result.acceptedEditorRevision, reused: Boolean(accepted),
        ...(input.replacement ? { replacement: publicReplacement(proposal.payload.fences.replacement) } : {}) });
    });
  }, async prepareReviewedInputs(value, options = {}) {
    const input = reviewedInputsInputOf(value), budget = operationBudget(options);
    const loaded = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, true, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const workspace = await savedWorkspace(client, input);
      const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef,
        input, authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active });
      if ((await createCustomCohortSubjectRepository(client, scopeJson)
        .compareCurrent(retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const review = await createCustomCohortReviewRepository(client, scopeJson)
        .getCurrent(canonicalAssessmentJson(input.contextRef), input.expectedReviewGeneration);
      // The existing read-only preparation supports full bigint assignment IDs.
      // The report attachment contract intentionally uses safe integers; do not
      // coerce a larger ID or take away its existing evidence inspection path.
      const reportEditor = BigInt(input.assignmentFileId) <= BigInt(Number.MAX_SAFE_INTEGER)
        ? await reportEditorState(client, input) : null;
      const now = await databaseTime(client);
      // Normalize the actual owner clock to the source envelope's millisecond
      // precision and retain the original reading separately. Never round up
      // to invent a later instant; finer future evidence stays unavailable.
      const millis = Date.parse(now);
      if (!Number.isFinite(millis)) fail('database_time_unavailable');
      const derivedAt = new Date(millis).toISOString();
      let savedBoundary = null, reportGeography = null;
      if (reportEditor !== null) {
        savedBoundary = await reportGeographyState(client, input);
        const admitted = prepareCustomCohortReportGeography({
          target: { organization_id: target.organization_id, report_file_id: target.report_file_id,
            assignment_file_id: input.assignmentFileId, account_id: input.accountId },
          ...savedBoundary, captured_at: derivedAt, retained_subject: retained.retained.retained_inputs.subject });
        const topology = admitted.geometry_for_validation === null ? null
          : await reportGeometryTopology(client, admitted.geometry_for_validation, admitted.subject_point_for_validation);
        reportGeography = completeCustomCohortReportGeography(admitted, topology);
      }
      return { target, scopeJson, workspace, review, retained, reportEditor, savedBoundary, reportGeography, now, derivedAt };
    });
    budget.check();
    const active = loaded.workspace.checkpoint.active;
    const temporalSupport = customCohortCurrentStockSupport({
      effective_date: loaded.retained.retained.retained_inputs.subject.effective_date,
      retained_capture_at: loaded.retained.retained.retained_inputs.acquisition.capture_result.captured_at,
    });
    const historicalBlocked = temporalSupport.status === 'historical_stock_evidence_required';
    // Reviewer declarations cannot turn a later current-CAD mirror into dated
    // historical stock. Keep retained inspection intact, but do not compute or
    // prepare a report candidate from it. All final access/freshness fences below
    // still run on this unavailable path, including saved geography and reviews.
    const supported = historicalBlocked ? null : buildCustomCohortSupportedInputs({
      preparation_input: { context_header_json: loaded.retained.header.header_blob.canonical_json,
        expected: { context_ref: input.contextRef, target: JSON.parse(loaded.scopeJson),
          observation_period: active.observation_period },
        retained_inputs: loaded.retained.retained.retained_inputs, selection: active.selection,
        catalog_version: customWorkspaceCatalogVersion(loaded.workspace.checkpoint) },
      review_state: loaded.review, derived_at: loaded.derivedAt,
    });
    const reportPreparation = historicalBlocked
      ? freeze({ report_preparation_version: 1, status: 'incomplete', authority: 'not_established',
        identity_status: 'unpublished_preparation', assessment: null, publication_bundle: null, candidate: null,
        report_geography: loaded.reportGeography, temporal_support: temporalSupport,
        issues: [{ code: 'historical_stock_evidence_required' }],
        apply: { status: 'blocked', reasons: ['historical_stock_evidence_required'] } })
      : loaded.reportEditor === null
      ? freeze({ report_preparation_version: 1, status: 'incomplete', authority: 'not_established',
        identity_status: 'unpublished_preparation', assessment: null, publication_bundle: null, candidate: null,
        issues: [{ code: 'unsupported_assignment_identity' }],
        apply: { status: 'blocked', reasons: ['unsupported_assignment_identity'] } })
      : buildCustomCohortReportPreparation({ supported_inputs: supported,
        target: { scope: { organization_id: loaded.target.organization_id, appraisal_case_id: loaded.target.appraisal_case_id,
          subject_snapshot_id: loaded.target.subject_snapshot_id, account_id: loaded.target.account_id },
          report_file_id: loaded.target.report_file_id, custom_assignment_file_id: Number(input.assignmentFileId),
          editor_revision: loaded.reportEditor.editor_revision, effective_date: loaded.retained.retained.retained_inputs.subject.effective_date,
          data_cutoff: loaded.retained.retained.retained_inputs.subject.effective_date },
        preparation_identity: { assessment_id: randomUUID(), assessment_revision: 1,
          attachment_id: randomUUID(), attachment_revision: 1 }, report_geography: loaded.reportGeography });
    budget.check();
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), loaded.target);
      const workspace = await savedWorkspace(client, input);
      if (!same(workspace, loaded.workspace)) fail('workspace_changed');
      if (loaded.reportEditor !== null && !same(await reportEditorState(client, input), loaded.reportEditor)) fail('report_editor_changed');
      if (loaded.savedBoundary !== null && !same(await reportGeographyState(client, input), loaded.savedBoundary)) fail('report_geography_changed');
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const review = await createCustomCohortReviewRepository(client, loaded.scopeJson)
        .getCurrent(canonicalAssessmentJson(input.contextRef), input.expectedReviewGeneration);
      if (review.state_sha256 !== loaded.review.state_sha256) fail('review_state_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
        loaded.retained.context, loaded.retained.purpose, budget);
      if (!same(decision, loaded.retained.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, input, loaded.retained, budget);
      // Internal source-bearing computation only, never a public presentation
      // response or a publish/Apply authorization. No accepted section changes.
      return Object.freeze({ status: 'prepared_reviewed_inputs', authority: 'not_established',
        workspace_section_revision: workspace.section_revision, owner_clock_at: loaded.now,
        subject_freshness: 'matched', supported_inputs: supported, report_preparation: reportPreparation,
        apply: Object.freeze({ status: 'blocked', reason: historicalBlocked
          ? 'historical_stock_evidence_required' : 'owner_adoption_and_publication_required' }) });
    });
  }, preview(value, options = {}) {
    return runPreview(value, options);
  }, async catalog(value, options = {}) {
    // Preserve the original method/response when omitted. The optional summary
    // uses the two EXISTING exposures; no source-policy key/grant is widened.
    const requested = value && Object.hasOwn(value, 'includeRecommendation');
    const include = requested ? value.includeRecommendation : false;
    if (typeof include !== 'boolean') fail('invalid_input');
    const input = requested ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'includeRecommendation')) : value;
    return runPreview(input, options, { includeMap: false, exposure: 'report_observation_catalog',
      additionalExposures: include ? ['report_observation_summary'] : [],
      outputLimit: include ? CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes : null,
      project: async (preview, expected, _parcelMap, retained_inputs, deriveProximity) => {
        const catalog = presentCustomCohortPocketCatalog({
          catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview, catalog_version: CUSTOM_COHORT_DENSE_CATALOG_VERSION }), preview, expected,
        });
        const city = retained_inputs.study.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY;
        const response = { status: 'catalog', catalog, ...(city ? { discovery: retained_inputs.study.discovery } : {}) };
        if (!include) return response;
        // Do not spend native work on an unresolved catalog or pretend current
        // parcel locations establish a retrospective housing population.
        const current = customCohortCurrentStockSupport({ effective_date: retained_inputs.subject.effective_date,
          retained_capture_at: retained_inputs.acquisition.capture_result.captured_at });
        if (!catalog.catalog_complete || current.status === 'historical_stock_evidence_required'
          || catalog.pockets.length > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.pockets) return response;
        // A municipal polygon has no radius-calibrated proximity scale. Keep
        // that factor unknown instead of borrowing an arbitrary ten-mile radius.
        const recorded_proximity = city ? undefined : await deriveProximity();
        const recommendation = buildCustomCohortPocketRecommendationPresentation({ catalog, expected, retained_inputs, recorded_proximity });
        return { ...response, ...(recommendation ? { recommendation } : {}) };
      },
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
