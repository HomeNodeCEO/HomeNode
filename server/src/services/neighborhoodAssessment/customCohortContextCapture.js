import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { CUSTOM_COHORT_OPERATION_LIMITS } from './customCohortOperationLimits.js';
import { checkCustomCohortMarketMembership } from './customCohortMarketMembership.js';
import { createCustomCapturePhaseTiming, createCustomReportPhaseTiming, createCustomPreviewPhaseTiming,
  createCustomCatalogPhaseTiming, createCustomPreparedCatalogPhaseTiming,
  createCustomPreparedCatalogProjectionTiming } from './customCapturePhaseTiming.js';
import { prepareCustomCohortOpeningGroups, prepareCustomCohortOpeningMode, customCohortOpeningGroupIds, customCohortOpeningSelection,
  CUSTOM_COHORT_OPENING_RESPONSE_BYTES, CUSTOM_COHORT_OPENING_PREVIEW_BYTES } from './customCohortOpeningPreview.js';
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
import { createCustomCohortCaptureJobRepository, prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { createNeighborhoodFrozenJobStockOriginals } from './neighborhoodFrozenJobStockOriginals.js';
import { createNeighborhoodFrozenJobSourceIdentity } from './neighborhoodFrozenJobSourceIdentity.js';
import { createNeighborhoodSharedJobCadImprovementPages,prepareNeighborhoodSharedJobCadPage,
  createNeighborhoodSharedJobCadAccountPages,prepareNeighborhoodSharedJobCadAccountPage }
  from './neighborhoodSharedJobCadImprovementPages.js';
import { describeNeighborhoodCadImprovementPurpose } from '../../security/customNeighborhoodCadImprovementSourcePolicy.js';
import { createNeighborhoodFrozenJobTypedOriginals } from './neighborhoodFrozenJobTypedOriginals.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { createNeighborhoodFrozenJobStockMetricPages, createNeighborhoodSharedJobStockMetricPages,
  createNeighborhoodSharedJobStockMetricPagesV2, prepareNeighborhoodFrozenStockMetricPage }
  from './neighborhoodFrozenJobStockMetricPages.js';
import { createNeighborhoodFrozenJobSourcePages,createNeighborhoodPreparedJobSourcePages } from './neighborhoodFrozenSourceClosurePages.js';
import { createNeighborhoodFrozenJobSourceSeeds } from './neighborhoodFrozenJobSourceSeeds.js';
import { createNeighborhoodSharedJobTransactionPagesV2,prepareNeighborhoodSharedTransactionPageV2 }
  from './neighborhoodSharedJobTransactionPagesV2.js';
import { createCohortOriginalSourceChainV1Store, COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS }
  from './cohortOriginalSourceChainV1.js';
import { verifyCohortOriginalSourceGraphStep } from './cohortOriginalSourceGraphV1.js';
import { createCohortOriginalSourceReferencesV2Store } from './cohortOriginalSourceReferencesV2.js';
import { verifyCohortOriginalSourceGraphV2Step } from './cohortOriginalSourceGraphV2.js';
import { createCustomCohortGraphV2AnchorRepository } from './customCohortGraphV2AnchorRepository.js';
import { createCustomCohortGeographicV2AnchorRepository } from './customCohortGeographicV2AnchorRepository.js';
import { prepareCohortGeographicOriginalReceiptV2 } from './cohortGeographicOriginalReceiptV2.js';
import { createCustomCohortIdentityV2AnchorRepository } from './customCohortIdentityV2AnchorRepository.js';
import { prepareCohortSourceIdentityReceiptV2 } from './cohortSourceIdentityReceiptV2.js';
import { createCustomCohortRecordedGroupSelectionOwner,
  reopenCustomCohortRecordedGroupSelectionOriginal } from './customCohortRecordedGroupSelectionOwner.js';
import { createCustomCohortPreparedCatalogOwner } from './customCohortPreparedCatalogOwner.js';
import { createCustomCohortPreparedSelectionRegistry } from './customCohortPreparedCatalogRegistry.js';
import { createCustomCohortGroupSelectionRepository } from './customCohortGroupSelectionRepository.js';
import { prepareCustomCohortGroupWorkspaceSave,
  prepareCustomCohortGroupCaptureCompletion } from './customCohortGroupWorkspaceSave.js';
import { resumeCustomCohortSubjectCheckpoint } from './customCohortCaptureSubjectCheckpoint.js';
import { resumeCustomCohortPreparationCheckpoint } from './customCohortCapturePreparationCheckpoint.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextHeader } from './customCohortContextContract.js';
import { captureNeighborhoodSpatialMembershipCompact } from './cachedSpatialMembership.js';
import { readCustomCohortPreparedSecondaryFacts } from './customCohortPreparedSecondaryMap.js';
import { resolveNeighborhoodCachedTransactionClosure } from './cachedTransactionClosureReader.js';
import { createNeighborhoodCadEvidenceReadAccess, describeNeighborhoodCachedMarketDataPurpose,
  describeNeighborhoodSaleWitnessMarketDataPurpose, createNeighborhoodCombinedEvidenceReadAccess,
  describeNeighborhoodCombinedEvidenceMarketDataPurpose } from './cachedReadAccess.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, createNeighborhoodDenseCombinedEvidenceSourceReader,
  consumeNeighborhoodCachedAcquisition } from './cachedSourceReader.js';
import { NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, prepareNeighborhoodSelectorInput,
  prepareNeighborhoodDiscoveryChoice, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY,
  NEIGHBORHOOD_CITY_PARCEL_PREDICATE } from './selectorInputProfile.js';
import { loadInstalledCustomCityDiscovery } from './customCityDiscovery.js';
import { prepareCustomCohortCaptureInputsBatched, persistCustomCohortCaptureInputs,
  loadCustomCohortCaptureInputs } from './customCohortCaptureInputs.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreviewBatched,
  reselectCustomCohortIndexedObservationPreview,
  CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS } from './customCohortObservationPreview.js';
import { createCustomCohortPreparedPreviewRepository, selectCustomCohortPreparedParcelMap,
  selectCustomCohortPreparedParcelViewportMap,
  selectCustomCohortPreparedTileViewportMap,
  customCohortPreparedParcelMapJsonBytes } from './customCohortPreparedPreviewRepository.js';
import { createCustomCohortPreparedCatalogRepository, rebindCustomCohortPreparedCatalog } from './customCohortPreparedCatalogRepository.js';
import { buildCustomCohortParcelMapBatched } from './customCohortParcelMap.js';
import { buildCustomCohortMapManifest } from './customCohortMapManifest.js';
import { createCustomCohortPreparedMapOpeningRepository } from './customCohortPreparedMapOpeningRepository.js';
import { presentCustomCohortGroupMapOpening } from './customCohortGroupMapOpening.js';
import { prepareCustomCohortViewport, projectCustomCohortViewportMap,
  presentCustomCohortSelectionViewportMap } from './customCohortViewportMap.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers, customCohortPreviewBinding } from './customCohortPreviewPresentation.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog, CUSTOM_COHORT_POCKET_CATALOG_LIMITS,
  CUSTOM_COHORT_DENSE_CATALOG_VERSION, customCohortCatalogGroupLimit,
  customCohortPocketCatalogBatches } from './customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendationPresentationBatched,
  CUSTOM_COHORT_DENSE_RECOMMENDATION_PRESENTATION_BYTES } from './customCohortPocketRecommendationPresentation.js';
import { buildCustomCohortMapScoresBatched } from './customCohortPocketRecommendation.js';
import { deriveCustomCohortRecordedProximity } from './customCohortRecordedProximity.js';
import { prepareCohortDecisionCommandV1 } from './cohortDecisionCommand.js';
import { createCustomCohortReviewRepository } from './customCohortReviewRepository.js';
import { buildCustomCohortSupportedInputs } from './customCohortSupportedInputs.js';
import { customCohortCurrentStockSupport } from './customCohortTemporalSupport.js';
import { buildCustomCohortReportPreparation } from './customCohortReportPreparation.js';
import { buildCustomCohortReportedAssessmentBatched, buildCustomCohortReportedAssessmentWitnessV2Batched } from './customCohortReportedAssessment.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from './customCohortReportedSaleWitnessV2.js';
import { getCustomCohortRecordedHousingInterpretation } from './customCohortRecordedHousingProfiles.js';
import { createNeighborhoodAssessmentRepositoryInTransaction, neighborhoodCallerCleanupFailure } from './assessmentRepository.js';
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
const OWNER_INTERRUPTION_REASONS = new WeakMap();
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
// Server-only discriminated stages. Flags and checkpoint admission travel
// together; callers cannot create combinations by shifting positional booleans.
const FROZEN_SOURCE_STAGES = freeze({
  prefix_v1: { allowedPhases: ['frozen_stock_v1', 'frozen_source_v1'] },
  prefix_refs_v2: { referencesV2: true, allowedPhases: ['frozen_stock_v1', 'frozen_source_refs_v2'] },
  verify_refs_v2: { referencesV2: true, verifying: true, allowedPhases: ['frozen_source_refs_v2', 'frozen_verify_refs_v2'] },
  geographic_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true,
    allowedPhases: ['frozen_verify_refs_v2', 'frozen_geo_verify_refs_v2'] },
  identity_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    allowedPhases: ['frozen_geo_verify_refs_v2', 'frozen_identity_refs_v2'] },
  verify_v1: { verifying: true, allowedPhases: ['frozen_source_v1', 'frozen_verify_v1'] },
  geographic_v1: { verifying: true, stockVerifying: true, allowedPhases: ['frozen_verify_v1', 'frozen_geo_verify_v1'] },
  identity_v1: { verifying: true, stockVerifying: true, identityVerifying: true,
    allowedPhases: ['frozen_geo_verify_v1', 'frozen_identity_v1'] },
  typed_v1: { verifying: true, stockVerifying: true, identityVerifying: true, typing: true,
    allowedPhases: ['frozen_identity_v1', 'frozen_typed_v1'] },
  stock_metrics_v1: { verifying: true, stockVerifying: true, identityVerifying: true, typing: true,
    readingStockMetrics: true, allowedPhases: ['frozen_typed_v1'] },
  shared_stock_metrics_v1: { verifying: true, stockVerifying: true, identityVerifying: true,
    readingSharedStockMetrics: true, allowedPhases: ['frozen_identity_v1', 'frozen_typed_v1'] },
  shared_stock_metrics_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingSharedStockMetrics: true, neutralSharedMetrics: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_CAD_pages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_CAD_accounts_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingCadPages: true, projectingCadAccounts: true, allowedPhases: ['frozen_identity_refs_v2'] },
  shared_transaction_pages_refs_v2: { referencesV2: true, verifying: true, stockVerifying: true, identityVerifying: true,
    readingTransactionPages: true, allowedPhases: ['frozen_identity_refs_v2'] },
});
function fail(reason, detail, captureCounts) {
  const error = Object.assign(new Error(`custom_cohort_capture_${reason}`), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason, ...(detail ? { detail } : {}),
    ...(captureCounts ? { capture_counts: captureCounts } : {}),
  });
  if (reason === 'deadline_exceeded' || reason === 'cancelled') OWNER_INTERRUPTION_REASONS.set(error, reason);
  throw error;
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
function captureJobInputOf(input) {
  exactKeys(input, ['auth', 'accountId', 'assignmentFileId', 'operationId']);
  const identity = identityOf(input);
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) fail('invalid_operation');
  return freeze({ ...identity, operationId: input.operationId });
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
  let open = false, closed = false, discard = null, connectionError = null, commitAttempted = false, outcomeUnknown = false;
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
    const cleanupFailure = neighborhoodCallerCleanupFailure(error);
    outcomeUnknown = Boolean(error?.outcome_unknown || cleanupFailure?.primary?.outcome_unknown
      || cleanupFailure?.cleanup?.outcome_unknown);
    if (open && !discard) {
      try { await raw.query({ text: 'ROLLBACK', query_timeout: LIMITS.cleanup_ms }); }
      catch (rollbackError) { discard = rollbackError; }
    }
    // Only after the existing outer cleanup/discard decision, preserve a typed
    // owner interruption hidden by our repository's failed savepoint cleanup.
    // Keep the aggregate and both children; never inspect arbitrary wrappers.
    if (outcomeUnknown) Object.assign(error, { outcome_unknown: true });
    else if (cleanupFailure) {
      const primary = cleanupFailure.primary, reason = OWNER_INTERRUPTION_REASONS.get(primary);
      if (reason && primary.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && primary.reason === reason) {
        Object.assign(error, { code: primary.code, reason });
      }
    }
    throw error;
  } finally {
    closed = true;
    try { raw.release(discard || undefined); }
    catch (releaseError) {
      if (commitAttempted || outcomeUnknown) throw Object.assign(releaseError, { outcome_unknown: true });
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
async function privateCaptureWorkfile(client, input, { permission = 'write', writeLock = true } = {}) {
  // The upload/review and signing owners lock the workfile before assignment
  // rows. Follow that same order for this additive private-capture write path.
  await resolveTarget(client, input, false, permission);
  return one(await client.query(`/* custom-cohort-capture:private-workfile */
    SELECT status,signed_at,EXISTS (SELECT 1 FROM app.custom_appraisal_signed_snapshots s
      WHERE s.assignment_file_id=w.assignment_file_id) AS has_signed_snapshot
    FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1::bigint FOR ${writeLock ? 'UPDATE' : 'SHARE'} NOWAIT`, [input.assignmentFileId]));
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
  exposure = 'none', additionalExposures = [], loadInputs = true, privateSummary = false, beforeLoad = null,
  stagedHeader = null, expectedIntent = null }) {
  // Only the private worker checkpoint path supplies a parsed original staged
  // header. It conveys no registered-context or source authority. Both paths
  // must authorize today's original source purpose before opening row pages.
  const previous = stagedHeader ?? await createCustomCohortContextRepository(client, scopeJson).get(canonicalAssessmentJson(reference));
  if (!previous) fail('context_unavailable');
  if (!same(previous.context_ref, reference)) fail('operation_conflict');
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
  if (expectedIntent && (!same(directory.acquisition_intent, expectedIntent)
    || !same(directory.subject_inputs, (await readMetadata(expectedIntent)).subject_inputs))) fail('checkpoint_conflict');
  const requestMetadata = await readMetadata(directory.request?.metadata);
  const compact = await readMetadata(directory.compact_metadata);
  if (!same(requestMetadata.target, context.target) || !same(requestMetadata.scope, context.scope)
    || (study && !same(requestMetadata.observation_period, study.observation_period))
    || requestMetadata.effective_date !== context.effective_date || requestMetadata.knowledge_cutoff !== null) fail('operation_conflict');
  // Choose the source projection from its original immutable query metadata,
  // never today's producer default. v3 cannot reopen under a narrower v2 grant;
  // CAD-only v4 keeps the original market-data purpose without MLS witnesses.
  if (compact.reader_version !== 'local-capture-v3' || ![1, 2, 3, 4, 5].includes(compact.mapping_version)
    || !same(compact.scope, requestMetadata.scope) || compact.effective_date !== requestMetadata.effective_date
    || !same(compact.authorization?.target, requestMetadata.target)
    || !same(compact.authorization?.market_decision, requestMetadata.market_decision)) fail('operation_conflict');
  // Metadata-only callers must also verify the persisted interpretation choice.
  // These bounded originals contain no source rows. A claimed compiled profile
  // is insufficient: the actual retained definition must exist and match.
  const studyOriginal = await readMetadata(refs.study_input);
  const marked = [2, 4].includes(studyOriginal.study_input_version);
  const housingMarked = [3, 4].includes(studyOriginal.study_input_version);
  const privateCapture = directory.selection_input_version === 2;
  if (![1, 2].includes(directory.selection_input_version)
    || Object.hasOwn(directory, 'private_sales') !== privateCapture
    || ![1, 2, 3, 4].includes(studyOriginal.study_input_version)
    || Object.hasOwn(studyOriginal, 'reported_sale_interpretation') !== marked
    || Object.hasOwn(studyOriginal, 'recorded_housing_interpretation') !== housingMarked) fail('operation_conflict');
  exactKeys(studyOriginal, ['study_input_version', 'usage', 'target', 'effective_date', 'settings', 'source_semantics', 'eligibility',
    ...(marked ? ['reported_sale_interpretation'] : []), ...(housingMarked ? ['recorded_housing_interpretation'] : [])]);
  if (studyOriginal.usage !== 'retained_custom_study_settings' || studyOriginal.eligibility !== 'not_established'
    || studyOriginal.effective_date !== context.effective_date
    || !same(studyOriginal.target, { ...context.scope, report_file_id: context.target.report_file_id,
      workflow_type: 'custom_appraisal', assignment_file_id: context.target.workflow_target_id,
      snapshot_version: previous.body.target.snapshot_version })
    || !same(studyOriginal.settings?.observation_period, requestMetadata.observation_period)
    || !same(studyOriginal.source_semantics, compact.semantics)) fail('operation_conflict');
  const intentOriginal = await readMetadata(directory.acquisition_intent);
  exactKeys(intentOriginal, ['intent_version', 'operation_id', 'actor_user_id', 'subject_inputs', 'target', 'effective_date', 'study', 'created_at',
    ...(privateCapture ? ['private_sales_import'] : []), ...(marked ? ['reported_sale_interpretation'] : []),
    ...(housingMarked ? ['recorded_housing_interpretation'] : [])]);
  if (intentOriginal.intent_version !== (privateCapture ? 2 : 1) + (marked ? 2 : 0) + (housingMarked ? 4 : 0)
    || intentOriginal.operation_id !== reference.context_id
    || !same(intentOriginal.subject_inputs, directory.subject_inputs)
    || !same(intentOriginal.target, studyOriginal.target) || intentOriginal.effective_date !== context.effective_date
    || !same(intentOriginal.study, studyOriginal.settings)) fail('operation_conflict');
  let reportedInterpretation = null;
  if (marked) {
    const installed = getCustomCohortReportedSaleWitnessV2Profile();
    const original = studyOriginal.reported_sale_interpretation;
    exactKeys(original, ['profile_ref', 'definition_blob']);
    if (compact.mapping_version !== 5 || !same(original.profile_ref, installed.profile_ref)
      || !same(intentOriginal.reported_sale_interpretation, installed.profile_ref)
      || !same(original.definition_blob, installed.definition_blob.ref)) fail('operation_conflict');
    const definition = await blobs.get(original.definition_blob.content_sha256, original.definition_blob.canonical_utf8_bytes);
    if (definition !== installed.definition_blob.canonical_json) fail('operation_conflict');
    reportedInterpretation = installed.profile_ref;
  }
  if (housingMarked) {
    if (![4, 5].includes(compact.mapping_version)) fail('operation_conflict');
    const installed = getCustomCohortRecordedHousingInterpretation(compact.mapping_version, 2);
    const original = studyOriginal.recorded_housing_interpretation;
    exactKeys(original, ['profile_ref', 'definition_blob']);
    if (!same(original.profile_ref, installed.profile_ref)
      || !same(intentOriginal.recorded_housing_interpretation, installed.profile_ref)
      || !same(original.definition_blob, installed.definition_blob.ref)) fail('operation_conflict');
    const definition = await blobs.get(original.definition_blob.content_sha256, original.definition_blob.canonical_utf8_bytes);
    if (definition !== installed.definition_blob.canonical_json) fail('operation_conflict');
  }
  const purpose = compact.mapping_version === 5 ? describeNeighborhoodCombinedEvidenceMarketDataPurpose(requestMetadata)
    : compact.mapping_version === 3 ? describeNeighborhoodSaleWitnessMarketDataPurpose(requestMetadata)
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
  const metadata = { context, purpose, decision, privateAuthorization, header: previous, reportedInterpretation };
  const beforeLoadResult = beforeLoad === null ? null : await beforeLoad(metadata);
  const retained = loadInputs ? await loadCustomCohortCaptureInputs(client, scopeJson, refs) : null;
  // A checkpoint is editor intent, not authority to relabel a retained study.
  // Check the discovery binding as well as its dates before report preparation.
  if (study && retained && !same(study.discovery ?? null, retained.study.discovery ?? null)) fail('operation_conflict');
  return { ...metadata, subjectReference: directory.subject_inputs, accountRosterRef: directory.request.account_ids,
    observationPeriod: requestMetadata.observation_period,
    discovery: studyOriginal.settings.discovery ?? null,
    retained, ...(beforeLoad === null ? {} : { beforeLoadResult }) };
}

/** Executable, Custom-only acquisition owner. No HTTP route, report
 * publication, Apply or signing occurs here. Internal recorded-group methods
 * retain context-bound selection intent and expose separately authorized
 * descriptive numeric summaries, not accepted report/workspace sections.
 * The internal
 * prepareReviewedInputs method computes exact retained/reviewed inputs only;
 * no route may expose its source-bearing result under a retention-only grant.
 * The review method retains exact authenticated reviewer commands only; stored
 * observations/assertions do not become certified facts or accepted statistics.
 * authorizeMarketData is a required SERVER policy and must explicitly cover
 * cached source rows, all-date one-hop identities and immutable retention. It
 * receives only this bounded client; it may not read a pool or a remote provider.
 * No default grant is inferred from assignment access, hashes or professional
 * licensing. Source completeness and historical support remain unknown.
 * The optional server-owned CAD policy defaults to absent; CAD pages require
 * its separate current decision in addition to the legacy source decision.
 */
export function createCustomCohortContextCapture({ pool, authorizeMarketData,
  authorizePrivateSales = async () => ({ allowed: false }),
  authorizeReportedObservations = async () => ({ allowed: false }), authorizeCadImprovementData = null, sourceMode = 'cad4' } = {}) {
  if (!['cad4', 'combined-witness2-v1'].includes(sourceMode)) throw new TypeError('custom_cohort_capture_source_mode_invalid');
  if (typeof pool?.connect !== 'function' || typeof authorizeMarketData !== 'function'
    || typeof authorizeReportedObservations !== 'function'
    || authorizeCadImprovementData!==null&&typeof authorizeCadImprovementData!=='function') {
    throw new TypeError('custom_cohort_capture_dependencies_required');
  }
  // Trusted constructor setting applies only to NEW attempts. Replays always
  // resolve the original source purpose and interpretation from retained blobs.
  const reportedProfile = sourceMode === 'combined-witness2-v1' ? getCustomCohortReportedSaleWitnessV2Profile().profile_ref : null;
  // Only NEW acquisitions get this server-selected interpretation. Registered
  // retries/reopens are selected from their immutable original study above.
  const housingProfile = getCustomCohortRecordedHousingInterpretation(reportedProfile ? 5 : 4, 2).profile_ref;
  const createReadAccess = reportedProfile ? createNeighborhoodCombinedEvidenceReadAccess : createNeighborhoodCadEvidenceReadAccess;
  const createSourceReader = reportedProfile ? createNeighborhoodDenseCombinedEvidenceSourceReader : createNeighborhoodDenseCadEvidenceSourceReader;
  async function recheckPrivatePolicy(client, input, loaded, budget, exposures = ['none']) {
    if (!loaded.privateAuthorization) return;
    for (const exposure of exposures) {
      const decision = await boundedPolicy(authorizePrivateSales, client, input.auth, loaded.context,
        loaded.privateAuthorization.purpose, budget, exposure);
      if (!same(decision, loaded.privateAuthorization.decision)) fail('market_policy_changed');
    }
  }
  async function executePreparedOriginal(originalInput, options, writing, work, projection = 'intent') {
      // Closed owner methods alone choose this projection. Catalog display
      // permission is never an implicit grant for individual membership.
      const selecting = ['intent', 'workspace', 'complete'].includes(projection);
      if ((!['catalog', 'membership'].includes(projection) && !selecting)
        || (!writing && ['workspace', 'complete'].includes(projection))) fail('invalid_input');
      const additionalExposures = projection === 'membership' || selecting ? ['report_observation_members'] : [];
      const budget = operationBudget(options), permission = writing ? 'write' : 'read';
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const initial = await resolveTarget(client, originalInput, false, permission);
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, initial.organization_id);
        const input = { ...originalInput, auth };
        assertTarget(await resolveTarget(client, input, false, permission), initial);
        // Match existing upload/sign/subject lock order without a SHARE upgrade.
        // Read permission is NOT widened by taking the same NOWAIT parent lock.
        const workfile = await privateCaptureWorkfile(client, input, { permission, writeLock: true });
        if (writing) privateDraft(workfile);
        const target = await resolveTarget(client, input, true, permission);
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false });
        // Original metadata establishes whether this was a private-source study.
        // Never inspect a shared derivative or compile a fallback for that case.
        if (licensed.privateAuthorization) fail('prepared_catalog_private_source_unsupported');
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
        if (selecting && writing && projection === 'intent') {
          const versions = await client.query(`/* custom-cohort-group-workspace:legacy-guard */
            SELECT section_value->>'workspace_version' AS workspace_version
            FROM app.custom_appraisal_workfile_sections
            WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
          [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]);
          if (versions?.rows?.some(row => row.workspace_version === '7')) fail('selection_workspace_workflow_required');
        }
        const selectionWorkspace = projection === 'workspace' ? await prepareCustomCohortGroupWorkspaceSave({
          client, input, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          checkBudget: budget.check,
        }) : projection === 'complete' ? await prepareCustomCohortGroupCaptureCompletion({
          client, input, scopeJson, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          privateSalesImport: null, checkBudget: budget.check,
        }) : null;
        const result = await work({ client, auth, scopeJson, budget, ...(selecting ? {
          blobs: createNeighborhoodCohortBlobRepository(client, target.organization_id), selectionWorkspace,
          retainedSelection: createCustomCohortPreparedSelectionRegistry(client, scopeJson,
            canonicalAssessmentJson(input.contextRef), { signal: budget.signal, checkBudget: budget.check }),
        } : {}) });
        // Reopen the SAME original context/dependencies and policy using fresh
        // database roles before delivery/COMMIT, including an ordinary cache miss.
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, permission), target);
        if (writing) privateDraft(await privateCaptureWorkfile(client, finalInput));
        const ending = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input: finalInput,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false });
        if (ending.privateAuthorization || !same(ending.header, licensed.header)
          || !same(ending.purpose, licensed.purpose) || !same(ending.decision, licensed.decision)
          || !same(ending.subjectReference, licensed.subjectReference)) fail('operation_conflict');
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(ending.subjectReference)).status !== 'matched') fail('subject_changed');
        budget.check(); return freeze(result);
      });
  }
  const preparedCatalog = createCustomCohortPreparedCatalogOwner({ identityOf, execute: executePreparedOriginal });
  // Explicit internal companions, not replacements for the installed routes or
  // legacy/private-source workflows. Neither display nor member counts are
  // cast into a map/statistical result; selected originals/head are still fully
  // verified by the unchanged selection repository in this same transaction.
  const retainedGroupSelection = createCustomCohortRecordedGroupSelectionOwner({ identityOf, execute: executePreparedOriginal });
  const recordedGroupSelection = createCustomCohortRecordedGroupSelectionOwner({ identityOf,
    executeWorkspaceTransition: async (originalInput, options, work) => {
      const budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const initial = await resolveTarget(client, originalInput, false, 'write');
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, initial.organization_id);
        const input = { ...originalInput, auth };
        assertTarget(await resolveTarget(client, input, false, 'write'), initial);
        privateDraft(await privateCaptureWorkfile(client, input));
        const target = await resolveTarget(client, input, true, 'write');
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        // Pending intent reads no old catalog/source facts. Revocation of an
        // old source license must not prevent setting aside an unfinished study.
        const result = await work({ client, auth, scopeJson, budget });
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, 'write'), target);
        privateDraft(await privateCaptureWorkfile(client, finalInput));
        budget.check(); return freeze(result);
      });
    },
    execute: async (originalInput, options, writing, work, projection = 'intent') => {
      if (!['intent', 'workspace', 'complete', 'summary', 'viewport', 'members', 'opening', 'market'].includes(projection)
        || (writing && !['intent', 'workspace', 'complete'].includes(projection))
        || (!writing && ['workspace', 'complete'].includes(projection))) fail('invalid_input');
      // Geometry uses the existing viewport's summary exposure, in addition to
      // catalog rights needed to re-derive the exact server-owned selection.
      const additionalExposures = projection === 'members' ? ['report_observation_members']
        : ['summary', 'viewport', 'opening', 'market'].includes(projection) ? ['report_observation_summary'] : [];
      const budget = operationBudget(options), permission = writing ? 'write' : 'read';
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const initial = await resolveTarget(client, originalInput, false, permission);
        const auth = await loadCurrentCustomCohortJobActor(client, originalInput.auth.userId, initial.organization_id);
        const input = { ...originalInput, auth };
        assertTarget(await resolveTarget(client, input, false, permission), initial);
        // Match upload/signing lock order. A saved selection may never mutate a
        // signed workfile or its accepted report. Reads remain current-authorized.
        // Subject freshness later locks this parent FOR UPDATE as well. Take
        // that mode first so concurrent NOWAIT readers cannot both acquire
        // SHARE and then fail while upgrading; permission still stays read.
        const workfile = await privateCaptureWorkfile(client, input, { permission, writeLock: true });
        if (writing) privateDraft(workfile);
        const target = await resolveTarget(client, input, true, permission);
        assertTarget(target, initial);
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
          additionalExposures, loadInputs: false, privateSummary: ['members', 'market'].includes(projection) });
        if (writing && projection === 'intent') {
          const versions = await client.query(`/* custom-cohort-group-workspace:legacy-guard */
            SELECT section_value->>'workspace_version' AS workspace_version
            FROM app.custom_appraisal_workfile_sections
            WHERE assignment_file_id=$1::bigint AND section_key=$2 FOR SHARE NOWAIT`,
          [input.assignmentFileId, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]);
          if (versions?.rows?.some(row => row.workspace_version === '7')) fail('selection_workspace_workflow_required');
        }
        const selectionWorkspace = projection === 'workspace' ? await prepareCustomCohortGroupWorkspaceSave({
          client, input, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          checkBudget: budget.check,
        }) : projection === 'complete' ? await prepareCustomCohortGroupCaptureCompletion({
          client, input, scopeJson, observationPeriod: licensed.observationPeriod, discovery: licensed.discovery,
          privateSalesImport: licensed.privateAuthorization ? {
            batch_id: licensed.privateAuthorization.purpose.batch_id,
            expected_review_revision: licensed.privateAuthorization.purpose.expected_review_revision,
          } : null, checkBudget: budget.check,
        }) : null;
        let catalog, roster, indexedPreview, neutralCatalog = null, retained = null;
        if (!licensed.privateAuthorization) {
          const cached = await createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef).read();
          const prepared = cached ? await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
            .read({ includeMap: false, useVerifiedPreviewCache: true }) : null;
          if (prepared) {
            if (!same(prepared.preview.observation_period, licensed.observationPeriod)
              || prepared.preview.effective_date !== licensed.context.effective_date) fail('operation_conflict');
            catalog = rebindCustomCohortPreparedCatalog(cached, 1).catalog;
            neutralCatalog = cached;
            roster = prepared.preview.all.account_ids;
            indexedPreview = prepared.preview;
          }
        }
        if (!catalog) {
          // Source rights were checked before these original row pages. Private
          // data still retains its own purpose/review; no shared-only cache may
          // stand in for a private-source capture.
          retained = await loadCustomCohortCaptureInputs(client, scopeJson,
            Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
          const preview = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref: input.contextRef,
            retained_inputs: retained.retained_inputs, selection: { revision: 1, pockets: [] } }, { check: budget.check });
          const expected = { context_ref: input.contextRef, selection_revision: 1 };
          const batches = customCohortPocketCatalogBatches({ retained_inputs: retained.retained_inputs, preview, catalog_version: 3 });
          let step;
          do { budget.check(); step = batches.next(); if (!step.done) await yieldToRequests(); } while (!step.done);
          budget.check();
          catalog = presentCustomCohortPocketCatalog({ catalog: step.value, preview, expected });
          roster = retained.retained_inputs.spatial.account_ids;
          indexedPreview = preview;
        }
        const selectionObservation = (accounts, selectionRef) => {
          budget.check();
          const selection = { revision: selectionRef.selection_revision, pockets: accounts.length
            ? [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts }] : [] };
          const preview = reselectCustomCohortIndexedObservationPreview(indexedPreview, selection);
          const expected = { context_ref: input.contextRef, selection_revision: selection.revision };
          const binding = customCohortPreviewBinding(preview, expected);
          if (binding.selection_sha256 !== selectionRef.selection_sha256) fail('operation_conflict');
          const privateCapture = retained?.retained_inputs.private_sales?.capture;
          const observations = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
            context_ref: input.contextRef, effective_date: licensed.context.effective_date,
            observation_period: licensed.observationPeriod,
            selection: { revision: selection.revision, account_ids: accounts } }) : null;
          const private_sales = observations ? presentCustomCohortPrivateSalesObservations({ observations, binding }) : null;
          budget.check(); return { preview, expected, private_sales };
        };
        const presentSelectionSummary = projection === 'summary' ? (accounts, selectionRef) => {
          const { preview, expected, private_sales } = selectionObservation(accounts, selectionRef);
          return { summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), ...(private_sales ? { private_sales } : {}) };
        } : undefined;
        const presentSelectionMembers = projection === 'members' ? (accounts, selectionRef, population, page) => {
          const { preview, expected, private_sales } = selectionObservation(accounts, selectionRef);
          return { page: inspectCustomCohortPreviewMembers({ preview, expected, population, page }),
            ...(private_sales ? { private_sales } : {}) };
        } : undefined;
        const presentSelectionMapOpening = projection === 'opening' ? async selectionRef => {
          budget.check();
          let manifest = neutralCatalog ? await createCustomCohortPreparedMapOpeningRepository(client, scopeJson, input.contextRef)
            .read(neutralCatalog) : null;
          if (!manifest) {
            let map;
            if (!licensed.privateAuthorization) {
              const prepared = await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
                .read({ includeMap: true, useVerifiedPreviewCache: true });
              if (prepared) map = prepared.parcel_map;
            }
            if (!map) {
              if (!retained) retained = await loadCustomCohortCaptureInputs(client, scopeJson,
                Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
              map = await buildCustomCohortParcelMapBatched({ retained_inputs: retained.retained_inputs,
                selected_account_ids: [] }, { check: budget.check });
            }
            manifest = buildCustomCohortMapManifest(catalog, map);
          }
          budget.check();
          return presentCustomCohortGroupMapOpening({ scopeJson, contextRef: input.contextRef, selectionRef, catalog, manifest });
        } : undefined;
        const presentSelectionViewport = projection === 'viewport' ? async (accounts, selectionRef, viewport) => {
          budget.check();
          let map;
          if (!licensed.privateAuthorization) {
            const repository = createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef);
            const tileMap = await repository.readViewportTiles(viewport, indexedPreview);
            if (tileMap) map = selectCustomCohortPreparedTileViewportMap(tileMap, accounts, roster);
            else {
              const prepared = await repository.read({ includeMap: true, useVerifiedPreviewCache: true });
              if (prepared) map = selectCustomCohortPreparedParcelViewportMap(prepared.parcel_map, accounts, viewport);
            }
          }
          if (!map) {
            if (!retained) retained = await loadCustomCohortCaptureInputs(client, scopeJson,
              Object.fromEntries(DEPENDENCIES.map(key => [key, licensed.header.body[key]])));
            map = await buildCustomCohortParcelMapBatched({ retained_inputs: retained.retained_inputs,
              selected_account_ids: accounts }, { check: budget.check });
          }
          budget.check();
          // No numeric recomputation and no viewport-filtered analytical union.
          // Membership comes from the complete verified original selection.
          return presentCustomCohortSelectionViewportMap({ status: 'preview',
            target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
            context_ref: input.contextRef, selection_revision: selectionRef.selection_revision,
            summary: { binding: { selection_sha256: selectionRef.selection_sha256 } }, parcel_map: map }, viewport);
        } : undefined;
        const result = await work({ client, auth, scopeJson, catalogJson: JSON.stringify(catalog),
          rosterJson: JSON.stringify({ account_ids: roster }), budget,
          ...(selectionWorkspace ? { selectionWorkspace } : {}),
          ...(presentSelectionSummary ? { presentSelectionSummary } : {}),
          ...(presentSelectionViewport ? { presentSelectionViewport } : {}),
          ...(presentSelectionMembers ? { presentSelectionMembers } : {}),
          ...(presentSelectionMapOpening ? { presentSelectionMapOpening } : {}),
          blobs: createNeighborhoodCohortBlobRepository(client, target.organization_id) });
        // Refresh request-time role claims again before COMMIT/delivery; original
        // actor receipts, cached facts and integrity hashes establish no grant.
        const finalAuth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id);
        const finalInput = { ...input, auth: finalAuth };
        assertTarget(await resolveTarget(client, finalInput, true, permission), target);
        if ((await createCustomCohortSubjectRepository(client, scopeJson)
          .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
        for (const exposure of ['report_observation_catalog', ...additionalExposures]) {
          const decision = await boundedPolicy(authorizeMarketData, client, finalAuth, licensed.context,
            licensed.purpose, budget, exposure);
          if (!same(decision, licensed.decision)) fail('market_policy_changed');
        }
        const privateCapture = retained?.retained_inputs.private_sales?.capture;
        if (privateCapture) await recheckAssignmentSalesCsvCapture(client.query.bind(client), privateCapture);
        await recheckPrivatePolicy(client, finalInput, licensed, budget,
          [...new Set(['report_observation_catalog', ...additionalExposures,
            ...(projection === 'members' ? ['report_observation_summary'] : [])])]);
        budget.check(); return freeze(result);
      });
    } });
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
  async function workspaceSelection(client, input, { scopeJson, workspace, retained }, budget) {
    if (workspace.checkpoint.workspace_version !== 7) return null;
    // The catalog grant must already have succeeded before retained row pages
    // are loaded. Rebuild only the exact retained catalog/independent roster,
    // never today's source tables, a viewport or browser-supplied memberships.
    let catalog, roster;
    if (!retained.privateAuthorization) {
      const cached = await createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef).read();
      const prepared = cached ? await createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
        .read({ includeMap: false, useVerifiedPreviewCache: true }) : null;
      if (prepared) {
        if (!same(prepared.preview.observation_period, retained.observationPeriod)
          || prepared.preview.effective_date !== retained.context.effective_date) fail('operation_conflict');
        catalog = rebindCustomCohortPreparedCatalog(cached, 1).catalog;
        roster = prepared.preview.all.account_ids;
      }
    }
    if (!catalog) {
      const preview = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref: input.contextRef,
        retained_inputs: retained.retained.retained_inputs, selection: { revision: 1, pockets: [] } }, { check: budget.check });
      const batches = customCohortPocketCatalogBatches({ retained_inputs: retained.retained.retained_inputs, preview, catalog_version: 3 });
      let step;
      do { budget.check(); step = batches.next(); if (!step.done) await yieldToRequests(); } while (!step.done);
      catalog = presentCustomCohortPocketCatalog({ catalog: step.value, preview,
        expected: { context_ref: input.contextRef, selection_revision: 1 } });
      roster = retained.retained.retained_inputs.spatial.account_ids;
    }
    const original = await reopenCustomCohortRecordedGroupSelectionOriginal({ client, scopeJson, budget,
      catalogJson: JSON.stringify(catalog), rosterJson: JSON.stringify({ account_ids: roster }),
      blobs: createNeighborhoodCohortBlobRepository(client, JSON.parse(scopeJson).organization_id) },
    { contextRef: input.contextRef, selectionRef: workspace.checkpoint.active.selection_ref });
    if (!original) fail('selection_changed');
    budget.check();
    return freeze({ reference: original.selection_ref, selection: { revision: original.selection_ref.selection_revision,
      included_recorded_group_ids: original.included_recorded_group_ids } });
  }
  async function recheckWorkspaceSelection(client, input, loaded, budget) {
    if (!loaded.workspaceSelection) return;
    budget.check();
    const current = await createCustomCohortGroupSelectionRepository(client, loaded.scopeJson,
      canonicalAssessmentJson(input.contextRef), { signal: budget.signal, checkBudget: budget.check }).peekCurrent();
    if (!same(current.selection_ref, loaded.workspaceSelection.reference)) fail('selection_changed');
    budget.check();
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
      ...(loaded.workspaceSelection ? { selection_ref: loaded.workspaceSelection.reference } : {}),
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
    const exactSelection = workspace.checkpoint.workspace_version === 7;
    const currentInput = exactSelection ? { ...input,
      auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id) } : input;
    if (exactSelection) assertTarget(await resolveTarget(client, currentInput, true, 'write', true), target);
    const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input: currentInput,
      authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active,
      additionalExposures: exactSelection ? ['report_observation_catalog'] : [],
      beforeLoad: metadata => reportPermission(client, currentInput, metadata, budget) });
    const selection = await workspaceSelection(client, currentInput, { scopeJson, workspace, retained }, budget);
    const reportEditor = await reportEditorState(client, input), savedBoundary = await reportGeographyState(client, input);
    let reportGeography = null, derivedAt = null;
    if (geography) {
      derivedAt = new Date(Date.parse(await databaseTime(client))).toISOString();
      const admission = prepareCustomCohortReportGeography({ target: JSON.parse(scopeJson), ...savedBoundary,
        captured_at: derivedAt, retained_subject: retained.retained.retained_inputs.subject });
      reportGeography = completeCustomCohortReportGeography(admission, admission.geometry_for_validation === null ? null
        : await reportGeometryTopology(client, admission.geometry_for_validation, admission.subject_point_for_validation));
    }
    return { workfile, target, scopeJson, workspace, retained, reportEditor, savedBoundary, reportGeography, derivedAt,
      ...(selection ? { workspaceSelection: selection } : {}) };
  }
  async function recheckReported(client, input, loaded, budget, { acceptedReplay = false, editorAfterSave = false } = {}) {
    if (loaded.workspaceSelection) input = { ...input,
      auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, loaded.target.organization_id) };
    assertTarget(await resolveTarget(client, input, true, 'write', true), loaded.target);
    if (!same(await savedWorkspace(client, input), loaded.workspace)) fail('workspace_changed');
    await recheckWorkspaceSelection(client, input, loaded, budget);
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
    if (loaded.workspaceSelection && !same(await boundedPolicy(authorizeMarketData, client, input.auth,
      loaded.retained.context, loaded.retained.purpose, budget, 'report_observation_catalog'), loaded.retained.decision)) fail('market_policy_changed');
    await recheckPrivatePolicy(client, input, loaded.retained, budget,
      loaded.workspaceSelection ? ['none', 'report_observation_catalog'] : ['none']);
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
  async function readPreparedCatalog(value, options, { catalogVersion, include, opening, groups, recommendedAreaOpening, manifestOpening }) {
    if (catalogVersion !== 3 || !include) return null;
    const input = previewInputOf(value), budget = operationBudget(options);
    // Catalog bindings describe an empty selection; a chosen group changes
    // only the opening summary and map, never the captured catalog itself.
    if (input.selection.pockets.length) return null;
    const timed = createCustomPreparedCatalogPhaseTiming();
    const cached = await transaction(pool, 'READ COMMITTED', budget, async client => {
      const resolved = await timed('target', async () => {
        const target = await resolveTarget(client, input, false, 'read');
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const catalogRepository = createCustomCohortPreparedCatalogRepository(client, scopeJson, input.contextRef);
        return await catalogRepository.exists() ? { target, scopeJson, catalogRepository } : null;
      });
      if (!resolved) return null;
      const { target, scopeJson, catalogRepository } = resolved;
      const licensed = await timed('authorization', () => authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
        authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_catalog',
        additionalExposures: ['report_observation_summary'], privateSummary: true, loadInputs: false }));
      if (licensed.privateAuthorization) return null;
      const payload = await timed('catalog_read', () => catalogRepository.read());
      const mapManifest = manifestOpening && payload ? await timed('map_opening_read', () =>
        createCustomCohortPreparedMapOpeningRepository(client, scopeJson, input.contextRef).read(payload)) : null;
      const prepared = await timed('preview_read', () => createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef)
        .read({ includeMap: opening && !mapManifest, useVerifiedPreviewCache: true }));
      return payload && prepared ? { target, scopeJson, licensed, payload, prepared, mapManifest } : null;
    });
    if (!cached) return null;
    const response = await timed('projection', () => {
      const projection = createCustomPreparedCatalogProjectionTiming();
      budget.check();
      if (!same(cached.prepared.preview.observation_period, cached.licensed.observationPeriod)
        || cached.prepared.preview.effective_date !== cached.licensed.context.effective_date) fail('operation_conflict');
      const stable = projection('binding', () => rebindCustomCohortPreparedCatalog(cached.payload, input.selection.revision));
      const catalog = stable.catalog, recommendation = stable.recommendation;
      projection('membership', () => {
        const accounts = [...catalog.pockets.flatMap(pocket => pocket.account_ids), ...catalog.unassigned.account_ids].sort();
        if (!same(accounts, [...cached.prepared.preview.all.account_ids].sort())) fail('operation_conflict');
      });
      const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
      const response = { status: 'catalog', target: { account_id: input.accountId,
        assignment_file_id: input.assignmentFileId }, ...expected, subject_freshness: 'matched',
        ...stable, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      let openingBytes = 0;
      if (opening) {
        const selected = projection('opening_selection', () => {
          const areaIds = recommendedAreaOpening && recommendation?.sales_aware_area?.status !== 'unavailable'
            && recommendation?.sales_aware_area?.selected_recorded_group_ids?.length
            ? recommendation.sales_aware_area.selected_recorded_group_ids : null;
          return customCohortOpeningSelection(catalog,
            groups ?? areaIds ?? customCohortOpeningGroupIds(catalog), expected.selection_revision);
        });
        const preview = projection('observation_reselect', () => reselectCustomCohortIndexedObservationPreview(cached.prepared.preview, selected));
        const map = manifestOpening ? { status: 'omitted', reason: 'viewport_required' }
          : projection('map_select', () => selectCustomCohortPreparedParcelMap(cached.prepared.parcel_map, preview.selected.account_ids));
        response.initial_preview = { status: 'preview', target: response.target, ...expected,
          subject_freshness: 'matched', summary: projection('summary_projection', () => presentCustomCohortPreview({ preview, expected, includeNarrative: true })), parcel_map: map,
          ...(manifestOpening ? { map_manifest: projection('map_manifest', () => cached.mapManifest
            ?? buildCustomCohortMapManifest(catalog, cached.prepared.parcel_map)) } : {}),
          apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      }
      projection('transport_guard', () => {
        if (opening) {
          // The verified map byte count includes the changed selection flags.
          // Preserve the same exact envelope limit without stringifying all
          // retained coordinates again before the final HTTP serialization.
          const mapBytes = customCohortPreparedParcelMapJsonBytes(response.initial_preview.parcel_map);
          openingBytes = Buffer.byteLength(JSON.stringify({ ...response.initial_preview, parcel_map: null })) - 4 + mapBytes;
          if (openingBytes > CUSTOM_COHORT_OPENING_PREVIEW_BYTES) fail('catalog_transport_limit');
        }
        const { initial_preview: _opening, ...catalogOnly } = response;
        const catalogBytes = Buffer.byteLength(JSON.stringify(catalogOnly));
        // A JSON object with one added key grows by exactly this delimiter plus
        // the already-measured opening. Do not serialize the full map a second
        // time solely for its guard; the HTTP layer serializes after recheck.
        const responseBytes = catalogBytes + (opening ? Buffer.byteLength(',"initial_preview":') + openingBytes : 0);
        if (catalogBytes > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes
          || responseBytes > (opening
            ? CUSTOM_COHORT_OPENING_RESPONSE_BYTES : CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes)) {
          fail('catalog_transport_limit');
        }
      });
      return response;
    });
    return timed('recheck', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      assertTarget(await resolveTarget(client, input, true, 'read'), cached.target);
      if ((await createCustomCohortSubjectRepository(client, cached.scopeJson)
        .compareCurrent(cached.licensed.subjectReference)).status !== 'matched') fail('subject_changed');
      for (const exposure of ['report_observation_catalog', 'report_observation_summary']) {
        const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
          cached.licensed.context, cached.licensed.purpose, budget, exposure);
        if (!same(decision, cached.licensed.decision)) fail('market_policy_changed');
      }
      budget.check();
      return freeze(response);
    }));
  }
  async function runPreview(value, options, { includeMap = true, exposure = 'none', additionalExposures = [], outputLimit = null,
    recommendedAreaOpening = false, preparedFast = false, preparedCatalog = false, manifestOpening = false, mapViewport = null, project } = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    if (preparedFast) {
      const cached = await transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, false, 'read');
        const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
        const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
          authorizeMarketData, authorizePrivateSales, budget, exposure, additionalExposures,
          privateSummary: true, loadInputs: false });
        // Private supplemental sales still follow their exact retained-source
        // path. Never silently omit them from the selected preview.
        if (licensed.privateAuthorization) return null;
        const repository = createCustomCohortPreparedPreviewRepository(client, scopeJson, input.contextRef);
        let prepared = await repository.read({ includeMap: includeMap && !mapViewport,
          useVerifiedPreviewCache: true });
        let tiled = false;
        if (prepared && includeMap && mapViewport) {
          const tileMap = await repository.readViewportTiles(mapViewport, prepared.preview);
          if (tileMap) { prepared = { ...prepared, parcel_map: tileMap }; tiled = true; }
          else prepared = await repository.read({ includeMap: true, useVerifiedPreviewCache: true });
        }
        return prepared ? { target, scopeJson, licensed, prepared, tiled } : null;
      });
      if (cached) {
        budget.check();
        if (!same(cached.prepared.preview.observation_period, cached.licensed.observationPeriod)
          || cached.prepared.preview.effective_date !== cached.licensed.context.effective_date) fail('operation_conflict');
        const preview = reselectCustomCohortIndexedObservationPreview(cached.prepared.preview, input.selection);
        const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
        const selectedMap = includeMap
          ? cached.tiled
            ? selectCustomCohortPreparedTileViewportMap(cached.prepared.parcel_map,
              preview.selected.account_ids, cached.prepared.preview.all.account_ids)
            : mapViewport
            ? selectCustomCohortPreparedParcelViewportMap(cached.prepared.parcel_map,
              preview.selected.account_ids, mapViewport)
            : selectCustomCohortPreparedParcelMap(cached.prepared.parcel_map, preview.selected.account_ids)
          : { status: 'omitted', reason: 'geometry_not_requested' };
        const content = { summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), parcel_map: selectedMap };
        return transaction(pool, 'READ COMMITTED', budget, async client => {
          assertTarget(await resolveTarget(client, input, true, 'read'), cached.target);
          if ((await createCustomCohortSubjectRepository(client, cached.scopeJson)
            .compareCurrent(cached.licensed.subjectReference)).status !== 'matched') fail('subject_changed');
          const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
            cached.licensed.context, cached.licensed.purpose, budget, exposure);
          if (!same(decision, cached.licensed.decision)) fail('market_policy_changed');
          for (const additional of additionalExposures) {
            const permitted = await boundedPolicy(authorizeMarketData, client, input.auth,
              cached.licensed.context, cached.licensed.purpose, budget, additional);
            if (!same(permitted, cached.licensed.decision)) fail('market_policy_changed');
          }
          budget.check();
          return freeze({ status: 'preview', target: { account_id: input.accountId,
            assignment_file_id: input.assignmentFileId }, ...expected,
            subject_freshness: 'matched', ...content,
            apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
        });
      }
    }
    let catalogPhaseTiming = null;
    const timed = ['report_observation_catalog', 'report_observation_summary'].includes(exposure)
      ? createCustomPreviewPhaseTiming() : (_phase, work) => work();
    const loaded = await timed('load', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      return { target, scopeJson, ...await authorizedRetainedInputs(client, {
        scopeJson, reference: input.contextRef, input, authorizeMarketData, authorizePrivateSales, budget, exposure, additionalExposures, privateSummary: true,
      }) };
    }));
    // Pure presentation happens outside the source-read connection and before
    // the final authorization check. Only an explicitly requested recommendation
    // may run bounded native computation over retained EWKB in a separate RO
    // transaction; it never rereads source tables. Ordinary selection previews
    // and member inspection do not invoke this derivation or resend geometry.
    budget.check();
    // Public summaries/pages/catalogs consume a genuinely indexed internal
    // view. Keep the raw internal preview API's v1 shape and ceiling unchanged.
    const buildPreview = project ? buildCustomCohortIndexedObservationPreviewBatched : buildCustomCohortObservationPreview;
    const preview = await timed('assembly', () => buildPreview({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained_inputs, selection: input.selection }, { check: budget.check }));
    budget.check();
    const parcelMap = includeMap ? await timed('map', () => buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
      selected_account_ids: [...new Set(input.selection.pockets.flatMap(pocket => pocket.account_ids))] }, { check: budget.check }))
      : { status: 'omitted', reason: 'geometry_not_requested' };
    const expected = { context_ref: input.contextRef, selection_revision: input.selection.revision };
    const deriveProximity = () => transaction(pool, 'REPEATABLE READ READ ONLY', budget,
      client => deriveCustomCohortRecordedProximity((sql, parameters) => client.query(sql, parameters),
        { context_ref: input.contextRef, retained_inputs: loaded.retained.retained_inputs },
        { deadline: budget.deadline, signal: budget.signal }));
    // A failed optional prepared lookup must not poison the existing
    // proximity transaction or the complete retained recommendation.
    const deriveSecondary = () => transaction(pool, 'REPEATABLE READ READ ONLY', budget,
      client => readCustomCohortPreparedSecondaryFacts(client.query.bind(client), loaded.retained.retained_inputs));
    const privateCapture = loaded.retained.retained_inputs.private_sales?.capture;
    let preparedOpening = null;
    const privateFor = (selection, view) => {
      const observations = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
      context_ref: input.contextRef, effective_date: loaded.context.effective_date,
      observation_period: loaded.retained.study.observation_period,
      selection: { revision: selection.revision, account_ids: [...new Set(selection.pockets.flatMap(pocket => pocket.account_ids))].sort() } }) : null;
      return observations ? presentCustomCohortPrivateSalesObservations({ observations,
        binding: customCohortPreviewBinding(view, expected) }) : null;
    };
    const envelope = content => ({ status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      ...expected, subject_freshness: 'matched', ...content, apply: { status: 'blocked', reasons: ['observation_preview_only'] } });
    // The optional opening projection shares ONLY this request's fully checked
    // retained graph. Its map/private rows/statistics use one exact union. Both
    // exposure grants and fresh material/assignment checks still gate delivery.
    const presentOpening = async selection => {
      const checked = previewInputOf({ ...input, selection }).selection;
      if (checked.revision !== input.selection.revision) fail('invalid_selection');
      // The catalog already built this immutable, exact observation index.
      // Reuse its members for the opening union rather than walking/hashing
      // the complete retained graph a second time. Final policy checks remain
      // below, and geometry still comes from the original retained parcels.
      budget.check();
      const selected = reselectCustomCohortIndexedObservationPreview(preview, checked);
      budget.check();
      const map = await buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
        selected_account_ids: [...new Set(checked.pockets.flatMap(p => p.account_ids))] }, { check: budget.check });
      if (map.status === 'available') preparedOpening = { preview: selected, map };
      const privateSales = privateFor(checked, selected);
      const result = envelope({ summary: presentCustomCohortPreview({ preview: selected, expected, includeNarrative: true }), parcel_map: map,
        ...(privateSales ? { private_sales: privateSales } : {}) });
      if (Buffer.byteLength(JSON.stringify(result)) > CUSTOM_COHORT_OPENING_PREVIEW_BYTES) fail('catalog_transport_limit');
      return result;
    };
    const content = project ? await timed('projection', () => project(preview, expected, parcelMap, loaded.retained.retained_inputs,
      deriveProximity, presentOpening, budget.check, deriveSecondary, timing => { catalogPhaseTiming = timing; }))
      : { preview, parcel_map: parcelMap };
    const privatePresentation = privateFor(input.selection, preview);
    budget.check();
    const response = await timed('authorization', () => transaction(pool, 'READ COMMITTED', budget, async client => {
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
      let response = envelope({ ...content, ...(privatePresentation ? { private_sales: privatePresentation } : {}) });
      if ([2, 3].includes(content.recommendation?.presentation_version)) {
        // The prepared-CAD overlay is disposable display support. Never drop
        // the established recommendation or exact opening just to carry it.
        const { initial_preview: _openingForOverlay, ...catalogWithOverlay } = response;
        if (Object.hasOwn(response, 'prepared_secondary_map')
          && Buffer.byteLength(JSON.stringify(catalogWithOverlay)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) {
          const { prepared_secondary_map: _overlay, ...withoutOverlay } = response;
          response = withoutOverlay;
        }
        const { initial_preview: _opening, ...catalogWithPrivateSales } = response;
        if (Buffer.byteLength(JSON.stringify(catalogWithPrivateSales)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) {
          // Final envelope accounting includes private-source summaries and owner
          // metadata. Keep the exact catalog/opening; omit only the whole optional
          // recommendation, never a subset of its groups or a private observation.
          const { recommendation: _recommendation, prepared_secondary_map: _overlay, ...withoutRecommendation } = response;
          response = withoutRecommendation;
          if (recommendedAreaOpening && Object.hasOwn(response, 'initial_preview')) {
            // A dropped recommendation cannot leave behind its private subset
            // preview: the client would restore the complete-catalog fallback.
            response.initial_preview = await catalogPhaseTiming('fallback_opening', () => presentOpening(customCohortOpeningSelection(response.catalog,
              customCohortOpeningGroupIds(response.catalog), expected.selection_revision)));
          }
        }
      }
      if (Object.hasOwn(content, 'initial_preview')) {
        const { initial_preview: _opening, ...catalogOnly } = response;
        if (Buffer.byteLength(JSON.stringify(catalogOnly)) > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) fail('catalog_transport_limit');
      }
      if (manifestOpening && response.initial_preview?.parcel_map?.status === 'available') {
        // A first authorized replay must honor the same geometry-free opening
        // as its prepared-cache reopens. Keep the original map internally for
        // write-through and viewport tiles; only its wire projection changes.
        response = { ...response, initial_preview: { ...response.initial_preview,
          map_manifest: buildCustomCohortMapManifest(response.catalog, response.initial_preview.parcel_map),
          parcel_map: { status: 'omitted', reason: 'viewport_required' } } };
      }
      if (outputLimit !== null && Object.hasOwn(response, 'prepared_secondary_map')
        && Buffer.byteLength(JSON.stringify(response)) > outputLimit) {
        const { prepared_secondary_map: _overlay, ...withoutOverlay } = response;
        response = withoutOverlay;
      }
      if (outputLimit !== null && Buffer.byteLength(JSON.stringify(response)) > outputLimit) fail('catalog_transport_limit');
      return freeze(response);
    }));
    let preparedCandidate = preparedOpening ?? (preparedFast && includeMap
      && content.parcel_map?.status === 'available' ? { preview, map: content.parcel_map } : null);
    if (!preparedCandidate && preparedFast && !includeMap && !loaded.privateAuthorization
      && budget.deadline - performance.now() > 7000) {
      // A saved opening may have used nearly its entire budget and missed its
      // write-through. Subsequent clicks request statistics only because the
      // browser already holds geometry. Prepare that geometry once from the
      // same authorized original graph so later clicks can use the fast path.
      try {
        const map = await buildCustomCohortParcelMapBatched({ retained_inputs: loaded.retained.retained_inputs,
          selected_account_ids: preview.selected.account_ids }, { check: budget.check });
        if (map.status === 'available') preparedCandidate = { preview, map };
      } catch { /* The exact response remains valid; no partial cache is stored. */ }
    }
    if (preparedCandidate && !loaded.privateAuthorization && budget.deadline - performance.now() > 3000) {
      // Optional write-through after a fully authorized original replay. Failure
      // leaves the exact response intact; later requests still use originals.
      try {
        await transaction(pool, 'READ COMMITTED', budget, async client => {
          const repository = createCustomCohortPreparedPreviewRepository(client, loaded.scopeJson, input.contextRef);
          if (!await repository.exists()) await repository.put(preparedCandidate.preview, preparedCandidate.map);
        });
      } catch (error) {
        // The optional cache must never change an authorized response, but a
        // silent failure would make every later click repeat the expensive
        // original replay. Emit only a bounded reason, never evidence/identity.
        const reason = /^custom_cohort_prepared_preview_[a-z_]+$/.test(error?.message)
          ? error.message : typeof error?.code === 'string' && /^[A-Z0-9_]{1,20}$/.test(error.code)
            ? error.code : 'unavailable';
        console.warn('[neighborhood] prepared-preview-write', { outcome: 'skipped', reason });
      }
    }
    if (preparedCatalog && !loaded.privateAuthorization && input.selection.pockets.length === 0
      && response.catalog?.catalog_complete === true && budget.deadline - performance.now() > 3000) {
      // Store no initial selection, private observations or authority. A later
      // opening derives its own exact union from the numeric/map read model.
      const publicCatalog = { catalog: response.catalog,
        ...(response.discovery ? { discovery: response.discovery } : {}),
        ...(response.recommendation ? { recommendation: response.recommendation } : {}),
        ...(response.prepared_secondary_map ? { prepared_secondary_map: response.prepared_secondary_map } : {}) };
      try {
        await transaction(pool, 'READ COMMITTED', budget, async client => {
          const repository = createCustomCohortPreparedCatalogRepository(client, loaded.scopeJson, input.contextRef);
          if (!await repository.exists({ currentOnly: true })) await repository.put(publicCatalog);
        });
      } catch (error) {
        const reason = /^custom_cohort_prepared_catalog_[a-z_]+$/.test(error?.message)
          ? error.message : typeof error?.code === 'string' && /^[A-Z0-9_]{1,20}$/.test(error.code)
            ? error.code : 'unavailable';
        console.warn('[neighborhood] prepared-catalog-write', { outcome: 'skipped', reason });
      }
    }
    return response;
  }
  /** One named internal stage owns its flags and phase admission. Every source
   * read/write is fenced by current rights at both transaction ends. V2 prefix
   * DATA has no verifier/typed/metric flags or legacy receipt conversion. CAD
   * reads require completed issued V2 prerequisites and a separate exact CAD
   * purpose/decision, without preparing a cache or advancing a checkpoint. */
  async function frozenCaptureJobSourceStage(value, options = {}, stage = 'prefix_v1') {
    if(typeof stage!=='string'||!Object.hasOwn(FROZEN_SOURCE_STAGES,stage))
      fail('frozen_source_representation_unsupported');
    const {referencesV2=false,verifying=false,stockVerifying=false,identityVerifying=false,
      typing=false,readingStockMetrics=false,readingSharedStockMetrics=false,neutralSharedMetrics=false,
      readingCadPages=false,projectingCadAccounts=false,readingTransactionPages=false,allowedPhases}=FROZEN_SOURCE_STAGES[stage];
    if(referencesV2){
      if(!options||utilTypes.isProxy(options)||Object.getPrototypeOf(options)!==Object.prototype)fail('invalid_options');
      const descriptors=Object.getOwnPropertyDescriptors(options),keys=Reflect.ownKeys(descriptors);
      const admittedKeys=['captureJobClaim','signal','deadline',...(readingSharedStockMetrics?['stockMetricPage']:[]),
        ...(readingCadPages?[projectingCadAccounts?'cadAccountPage':'cadImprovementPage']:[]),
        ...(readingTransactionPages?['transactionPage']:[])];
      if(keys.some(key=>!admittedKeys.includes(key)
        ||!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))fail('invalid_options');
      options=Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
    }
    if (!options || Object.getPrototypeOf(options)!==Object.prototype) fail('invalid_options');
    const {captureJobClaim:providedClaim,stockMetricPage,cadImprovementPage,cadAccountPage,transactionPage,...budgetOptions}=options;
    const metricPage=readingStockMetrics||readingSharedStockMetrics?prepareNeighborhoodFrozenStockMetricPage(stockMetricPage):null;
    const cadPage=readingCadPages?projectingCadAccounts?prepareNeighborhoodSharedJobCadAccountPage(cadAccountPage)
      :prepareNeighborhoodSharedJobCadPage(cadImprovementPage):null;
    const transactionInput=readingTransactionPages?prepareNeighborhoodSharedTransactionPageV2(transactionPage):null;
    if(!readingStockMetrics&&!readingSharedStockMetrics&&stockMetricPage!==undefined) fail('invalid_options');
    if(!readingCadPages&&cadImprovementPage!==undefined)fail('invalid_options');
    if(!readingTransactionPages&&transactionPage!==undefined)fail('invalid_options');
    const originalInput=inputOf(value),claim=prepareCustomCohortCaptureJobClaim(providedClaim);
    if(claim.operation_id!==originalInput.operationId.toLowerCase()) fail('operation_conflict');
    if(!reportedProfile) fail('frozen_source_profile_unsupported');
    if(originalInput.privateSalesImport || originalInput.discovery?.profile_id!=='custom-suburban-radius-v2') fail('frozen_discovery_unsupported');
    if(readingCadPages&&typeof authorizeCadImprovementData!=='function')fail('CAD_source_policy_required');
    const budget=operationBudget(budgetOptions,LIMITS.capture_duration_ms);
    return transaction(pool,'READ COMMITTED',budget,async client=>{
      const locator=one(await client.query(`/* custom-cohort-capture:job-organization */
        SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
      [originalInput.assignmentFileId,originalInput.accountId]));
      let input=freeze({...originalInput,operationId:claim.operation_id,
        auth:await loadCurrentCustomCohortJobActor(client,originalInput.auth.userId,locator.organization_id)});
      privateDraft(await privateCaptureWorkfile(client,input));
      const target=await resolveTarget(client,input,true),scope=Object.fromEntries(TARGET_FIELDS.map(key=>[key,target[key]]));
      const jobs=createCustomCohortCaptureJobRepository(client),jobOptions={scope,actorUserId:input.auth.userId};
      const requested={operation_id:input.operationId,observation_period:input.observationPeriod,discovery:input.discovery};
      if(!same(await jobs.readRequest(claim,jobOptions),requested)) fail('operation_conflict');
      const checkpoint=await jobs.readCheckpoint(claim,jobOptions);
      if(!checkpoint || !allowedPhases.includes(checkpoint.phase)
        ||checkpoint.evidence_refs.length!==({frozen_stock_v1:2,frozen_source_v1:3,frozen_source_refs_v2:3,frozen_verify_refs_v2:4,frozen_geo_verify_refs_v2:5,frozen_identity_refs_v2:6,frozen_verify_v1:4,frozen_geo_verify_v1:5,frozen_identity_v1:6,frozen_typed_v1:7}[checkpoint.phase]))
        fail('checkpoint_conflict');
      const subjects=createCustomCohortSubjectRepository(client,canonicalAssessmentJson(scope));
      const blobs=createNeighborhoodCohortBlobRepository(client,scope.organization_id);
      const study=freeze({profile_id:input.discovery.profile_id,discovery:input.discovery,
        observation_period:input.observationPeriod,knowledge_cutoff:null});
      const retained=await resumeCustomCohortSubjectCheckpoint({checkpoint:{phase:'subject',evidence_refs:[checkpoint.evidence_refs[0]]},
        blobs,subjects,input,study,reportedProfile,housingProfile});
      authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
        permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
      const stockOptions={claim,scope,actorUserId:input.auth.userId,geometryInput:retained.point.geometry_input,
        discovery:input.discovery,subjectIntent:retained.intent.reference,checkBudget:budget.check};
      const stockStore=createNeighborhoodFrozenJobStock(client,stockOptions),stock=await stockStore.read();
      const stockReference=checkpoint.evidence_refs[1];
      const stockBody={stock_stage_version:1,usage:'frozen_job_stock_only',subject_intent:retained.intent.reference,stock};
      if(await blobs.get(stockReference.content_sha256,stockReference.canonical_utf8_bytes)!==canonicalAssessmentJson(stockBody)) fail('checkpoint_conflict');
      // Explicit versioned selection preimage: actual owner-selected SQL
      // stock, scope, generation, original header/point definition and subject.
      // The old <=50k array/capability is never minted, spoofed or widened.
      const selection=freeze({selection_version:'frozen_job_stock_source_v1',scope,operation_id:input.operationId,
        subject_intent:retained.intent.reference,stock_reference:stockReference,generation_id:stock.generation_id,
        spatial_definition_sha256:stock.definition_sha256,source_original_sha256:stock.source_original_sha256,
        stock_population:stock.population});
      const context=contextOf(retained.subject),purpose=describeNeighborhoodCombinedEvidenceMarketDataPurpose({
        selection_sha256:assessmentEvidenceDigest(selection),effective_date:context.effective_date,
        observation_period:input.observationPeriod,knowledge_cutoff:null});
      // Same independently approved fixed mapping5/witness2, immutable
      // retention and all-date one-hop fields. Retained grant metadata is not
      // authority: current policy must allow before any licensed original.
      const decision=await boundedPolicy(authorizeMarketData,client,input.auth,context,purpose,budget);
      // The old seven-layer grant cannot authorize the companion projection.
      // This exact additional purpose is derived only from the actual reopened
      // stock/subject/selection, never a caller grant, date, field list or head.
      const cadPurpose=readingCadPages?describeNeighborhoodCadImprovementPurpose({
        selection_sha256:assessmentEvidenceDigest(selection),generation_id:stock.generation_id}):null;
      const cadDecision=readingCadPages?await boundedPolicy(authorizeCadImprovementData,client,input.auth,context,cadPurpose,budget):null;
      if(readingCadPages&&!/^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$/.test(cadDecision.policy_revision))
        fail('CAD_source_policy_required');
      const binding={...scope,operation_id:input.operationId,generation_id:stock.generation_id,
        spatial_definition_sha256:stock.definition_sha256,source_original_sha256:stock.source_original_sha256};
      const sourceVersion=referencesV2?2:1,sourceUsage=referencesV2?'frozen_source_reference_prefix_only':'frozen_source_prefix_only';
      const sourcePhase=referencesV2?'frozen_source_refs_v2':'frozen_source_v1';
      const chain=referencesV2?createCohortOriginalSourceReferencesV2Store(
        {put:text=>blobs.put(text),get:(hash,size)=>blobs.get(hash,size)},binding,{
          signal:budget.signal,checkBudget:budget.check,
          // Fixed old indexed closure against THIS live claim and pinned stock.
          // No caller callback, SQL plan, current/latest generation or fallback.
          // Prefix append/describe never invokes this adapter. The explicit
          // V2 graph owner starts at real heads and follows issued edges only.
          async readOriginal(request){
            if(request.plan!=='neighborhood_frozen_job_closure_v1')fail('checkpoint_conflict');
            const page=await createNeighborhoodFrozenJobSourcePages(client,{...stockOptions,signal:budget.signal})
              .page({kind:request.kind,cursor:request.after,rowLimit:request.row_limit});
            return JSON.stringify({binding,page});
          },
        }):createCohortOriginalSourceChainV1Store(blobs,binding,{signal:budget.signal,checkBudget:budget.check});
      let root,reference=checkpoint.evidence_refs[2]??null;
      if(reference) {
        const text=await blobs.get(reference.content_sha256,reference.canonical_utf8_bytes);
        if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
        let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
        exactKeys(previous,['source_stage_version','usage','selection','purpose','market_decision','root']);
        if(previous.source_stage_version!==sourceVersion||previous.usage!==sourceUsage
          ||!same(previous.selection,selection)||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
        root=previous.root;
      }else root=(await chain.create()).root;
      let prefix=await chain.describe(root);
      const kind=COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.find(key=>!prefix.layers[key].ended);
      let verification=null,verificationReference=checkpoint.evidence_refs[3]??null,
        stockVerification=null,stockVerificationReference=checkpoint.evidence_refs[4]??null,
        identityVerification=null,identityVerificationReference=checkpoint.evidence_refs[5]??null,
        typedOriginals=null,typedReference=checkpoint.evidence_refs[6]??null,stockMetricResult=null;
      if(!verifying&&kind) {
        // Current all-date one-hop source rights have already been checked.
        // Prepare only once per exact stock; later pages reopen the immutable
        // index without rediscovering all seeds. Ending owner checks roll back
        // first preparation with the source page/checkpoint on any refusal.
        await createNeighborhoodFrozenJobSourceSeeds(client,{...stockOptions,signal:budget.signal}).prepare();
        const page=await createNeighborhoodPreparedJobSourcePages(client,{...stockOptions,signal:budget.signal})
          .page({kind,cursor:prefix.layers[kind].cursor,rowLimit:250});
        root=(await chain.append({root,original_text:JSON.stringify({binding,page}),...(referencesV2?{row_limit:250}:{})})).root;
        prefix=await chain.describe(root);
        const body={source_stage_version:sourceVersion,usage:sourceUsage,selection,purpose,market_decision:decision,root};
        reference=await blobs.put(canonicalAssessmentJson(body));
        await jobs.saveCheckpoint(claim,jobOptions,{phase:sourcePhase,evidence_refs:[retained.intent.reference,stockReference,reference]});
      }
      let graphAnchorStore=null,graphAnchor=null;
      if(verifying&&referencesV2) {
        graphAnchorStore=createCustomCohortGraphV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root});
        graphAnchor=await graphAnchorStore.read();
        // The independent issued head is authoritative, not a free progress
        // blob, a valid hash or a caller-supplied continuation. Refuse a swapped
        // checkpoint BEFORE the fixed original adapter can read licensed data.
        if(checkpoint.phase==='frozen_source_refs_v2'?graphAnchor!==null
          :graphAnchor===null||!same(graphAnchor.receipt_reference,verificationReference)) fail('checkpoint_conflict');
        let issued=null;
        if(graphAnchor){
          const text=await blobs.get(graphAnchor.receipt_reference.content_sha256,graphAnchor.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          if(issued.sequence!==graphAnchor.sequence)fail('checkpoint_conflict');
        }
        // Geographic verification may only reopen the ACTUAL completed issued
        // graph, not advance an unfinished graph or accept a forged done blob.
        if(stockVerifying&&issued?.after?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length)
          fail('unfinished_graph_verification');
        verification=await verifyCohortOriginalSourceGraphV2Step({chain,binding,source_reference:reference,
          root,issued_receipt:issued,issued_reference:graphAnchor?.receipt_reference??null,checkBudget:budget.check});
        if(verification.advanced){
          verificationReference=await blobs.put(canonicalAssessmentJson(verification.receipt));
          graphAnchor=await graphAnchorStore.advance(graphAnchor,verificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_verify_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference]});
        }
      }
      if(verifying&&!referencesV2) {
        let progress=null;
        if(verificationReference) {
          const text=await blobs.get(verificationReference.content_sha256,verificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['verification_stage_version','usage','source_reference','selection','purpose','market_decision','progress']);
          if(previous.verification_stage_version!==1||previous.usage!=='frozen_original_graph_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        // The geographic stage cannot advance/rewrite an unfinished source
        // graph. Its actual owner must already have committed all seven layers.
        if(stockVerifying&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_graph_verification');
        const pages=createNeighborhoodFrozenJobSourcePages(client,{...stockOptions,signal:budget.signal});
        verification=await verifyCohortOriginalSourceGraphStep({chain,readSourcePage:page=>pages.page(page),
          root,progress,checkBudget:budget.check});
        if(verification.advanced) {
          const body={verification_stage_version:1,usage:'frozen_original_graph_progress_only',
            source_reference:reference,selection,purpose,market_decision:decision,progress:verification.progress};
          verificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_verify_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference]});
        }
      }
      let geographicAnchorStore=null,geographicAnchor=null;
      if(stockVerifying&&referencesV2){
        const expected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,stock_reference:stockReference};
        geographicAnchorStore=createCustomCohortGeographicV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,stock_reference:stockReference});
        geographicAnchor=await geographicAnchorStore.read();
        if(checkpoint.phase==='frozen_verify_refs_v2'?geographicAnchor!==null
          :geographicAnchor===null||!same(geographicAnchor.receipt_reference,stockVerificationReference))fail('checkpoint_conflict');
        let issued=null;
        if(geographicAnchor){
          const text=await blobs.get(geographicAnchor.receipt_reference.content_sha256,geographicAnchor.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareCohortGeographicOriginalReceiptV2(issued,expected);
          if(issued.sequence!==geographicAnchor.sequence)fail('checkpoint_conflict');
        }
        if(identityVerifying&&issued?.after.done!==true)fail('unfinished_geographic_verification');
        // The original stock FK/key/account/EWKB SQL and its independent final
        // per-account totals are unchanged. Only the provenance of continuation
        // is new: derive it exclusively from the independent issued geo head.
        stockVerification=await createNeighborhoodFrozenJobStockOriginals(client,stockOptions).step(issued?.after??null);
        if(stockVerification.advanced){
          const after=stockVerification.progress,before=issued?.after??{...after,after_object_id:null,
            verified_parcels:0,verified_unassociated:0,done:false};
          const receipt=prepareCohortGeographicOriginalReceiptV2({format:'cohort_geographic_original_receipt_v2',...expected,
            sequence:(geographicAnchor?.sequence??0)+1,previous:geographicAnchor?.receipt_reference??null,before,after},expected);
          stockVerificationReference=await blobs.put(canonicalAssessmentJson(receipt));
          geographicAnchor=await geographicAnchorStore.advance(geographicAnchor,stockVerificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_geo_verify_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference]});
        }
      }
      if(stockVerifying&&!referencesV2) {
        let progress=null;
        if(stockVerificationReference) {
          const text=await blobs.get(stockVerificationReference.content_sha256,stockVerificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['stock_verification_stage_version','usage','source_reference','graph_verification_reference',
            'selection','purpose','market_decision','progress']);
          if(previous.stock_verification_stage_version!==1||previous.usage!=='frozen_geographic_original_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.selection,selection)||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        // A later stage may verify a finished prerequisite, never advance it
        // and overwrite an identity checkpoint with a geographic continuation.
        if(identityVerifying&&progress?.done!==true) fail('unfinished_geographic_verification');
        stockVerification=await createNeighborhoodFrozenJobStockOriginals(client,stockOptions).step(progress);
        if(stockVerification.advanced) {
          const body={stock_verification_stage_version:1,usage:'frozen_geographic_original_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,selection,purpose,market_decision:decision,progress:stockVerification.progress};
          stockVerificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_geo_verify_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference]});
        }
      }
      let identityAnchorStore=null,identityAnchor=null;
      if(identityVerifying&&referencesV2){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const expected={binding,source_reference:reference,root,graph_verification_reference:verificationReference,
          stock_verification_reference:stockVerificationReference,stock_reference:stockReference,
          layer_counts:graph.layer_counts,stock_account_count:stock.population.account_count};
        identityAnchorStore=createCustomCohortIdentityV2AnchorRepository({client,claim,scope,actorUserId:input.auth.userId,
          source_reference:reference,root_reference:root,graph_reference:verificationReference,
          geographic_reference:stockVerificationReference,stock_reference:stockReference});
        identityAnchor=await identityAnchorStore.read();
        if(checkpoint.phase==='frozen_geo_verify_refs_v2'?identityAnchor!==null
          :identityAnchor===null||!same(identityAnchor.receipt_reference,identityVerificationReference))fail('checkpoint_conflict');
        let issued=null;
        if(identityAnchor){
          const text=await blobs.get(identityAnchor.receipt_reference.content_sha256,identityAnchor.receipt_reference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16000)fail('checkpoint_conflict');
          try{issued=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          issued=prepareCohortSourceIdentityReceiptV2(issued,expected);
          if(issued.sequence!==identityAnchor.sequence)fail('checkpoint_conflict');
        }
        if((readingSharedStockMetrics||readingCadPages||readingTransactionPages)&&issued?.after.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length)
          fail('unfinished_identity_verification');
        // Keep the original exact all-date one-hop identity SQL unchanged.
        // Its real stock/graph digest, native identities and coverage are not
        // established by DATA validation, a hash or a free DONE checkpoint.
        identityVerification=await createNeighborhoodFrozenJobSourceIdentity(client,stockOptions,graph).step(issued?.after??null);
        if(identityVerification.advanced){
          const after=identityVerification.progress,before=issued?.after??{...after,kind_index:0,after:'',layer_rows:0,
            unknown_parcel_origins:0,missing_account_count:null};
          const receipt=prepareCohortSourceIdentityReceiptV2({format:'cohort_source_identity_receipt_v2',...expected,
            sequence:(identityAnchor?.sequence??0)+1,previous:identityAnchor?.receipt_reference??null,before,after},expected);
          identityVerificationReference=await blobs.put(canonicalAssessmentJson(receipt));
          identityAnchor=await identityAnchorStore.advance(identityAnchor,identityVerificationReference);
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_identity_refs_v2',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference]});
        }
      }
      if(identityVerifying&&!referencesV2) {
        let progress=null;
        if(identityVerificationReference) {
          const text=await blobs.get(identityVerificationReference.content_sha256,identityVerificationReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['identity_stage_version','usage','source_reference','graph_verification_reference','stock_verification_reference',
            'selection','purpose','market_decision','progress']);
          if(previous.identity_stage_version!==1||previous.usage!=='frozen_source_identity_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.stock_verification_reference,stockVerificationReference)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          progress=previous.progress;
        }
        if((typing||readingSharedStockMetrics)&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_identity_verification');
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        identityVerification=await createNeighborhoodFrozenJobSourceIdentity(client,stockOptions,graph).step(progress);
        if(identityVerification.advanced) {
          const body={identity_stage_version:1,usage:'frozen_source_identity_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            selection,purpose,market_decision:decision,progress:identityVerification.progress};
          identityVerificationReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_identity_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference]});
        }
      }
      if(typing) {
        const profile=getNeighborhoodFrozenTypedOriginalV1Profile();let progress=null;
        if(typedReference) {
          const text=await blobs.get(typedReference.content_sha256,typedReference.canonical_utf8_bytes);
          if(text===null||Buffer.byteLength(text)>16_000) fail('checkpoint_conflict');
          let previous;try{previous=JSON.parse(text);}catch{fail('checkpoint_conflict');}
          exactKeys(previous,['typed_stage_version','usage','source_reference','graph_verification_reference','stock_verification_reference',
            'identity_verification_reference','profile_reference','selection','purpose','market_decision','progress']);
          if(previous.typed_stage_version!==1||previous.usage!=='frozen_typed_original_progress_only'
            ||!same(previous.source_reference,reference)||!same(previous.graph_verification_reference,verificationReference)
            ||!same(previous.stock_verification_reference,stockVerificationReference)||!same(previous.identity_verification_reference,identityVerificationReference)
            ||!same(previous.profile_reference,profile.definition_blob.ref)||!same(previous.selection,selection)
            ||!same(previous.purpose,purpose)||!same(previous.market_decision,decision)) fail('market_policy_changed');
          if(await blobs.get(previous.profile_reference.content_sha256,previous.profile_reference.canonical_utf8_bytes)!==profile.definition_blob.canonical_json)
            fail('checkpoint_conflict');
          progress=previous.progress;
        }
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        if(readingStockMetrics&&progress?.kind_index!==COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.length) fail('unfinished_typed_interpretation');
        typedOriginals=await createNeighborhoodFrozenJobTypedOriginals(client,stockOptions,graph,context.effective_date).step(progress);
        if(typedOriginals.advanced) {
          const profileReference=await blobs.put(profile.definition_blob.canonical_json);
          if(!same(profileReference,profile.definition_blob.ref)) fail('checkpoint_conflict');
          const body={typed_stage_version:1,usage:'frozen_typed_original_progress_only',source_reference:reference,
            graph_verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
            identity_verification_reference:identityVerificationReference,profile_reference:profileReference,
            selection,purpose,market_decision:decision,progress:typedOriginals.progress};
          typedReference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_typed_v1',
            evidence_refs:[retained.intent.reference,stockReference,reference,verificationReference,stockVerificationReference,identityVerificationReference,typedReference]});
        }
        if(readingStockMetrics) stockMetricResult=await createNeighborhoodFrozenJobStockMetricPages(client,stockOptions,graph,context.effective_date).page(metricPage);
      }
      if(readingSharedStockMetrics) {
        // A completed shared cache is DATA, not a source grant. All existing
        // original graph/geography/identity prerequisites and ending rights
        // checks remain mandatory. Never materialize on a cache miss or copy
        // typed payloads/profile blobs/checkpoints into this report's job.
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        const reader=neutralSharedMetrics?createNeighborhoodSharedJobStockMetricPagesV2:createNeighborhoodSharedJobStockMetricPages;
        stockMetricResult=await reader(client,stockOptions,graph,context.effective_date).page(metricPage);
      }
      if(readingCadPages){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        stockMetricResult=projectingCadAccounts
          ?await createNeighborhoodSharedJobCadAccountPages(client,stockOptions,graph,context.effective_date).page(cadPage)
          :await createNeighborhoodSharedJobCadImprovementPages(client,stockOptions,graph).page(cadPage);
      }
      if(readingTransactionPages){
        const graph={root,layer_counts:Object.fromEntries(COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.map(key=>[key,prefix.layers[key].row_count]))};
        stockMetricResult=await createNeighborhoodSharedJobTransactionPagesV2(client,stockOptions,graph).page(transactionInput);
      }
      input=freeze({...input,auth:await loadCurrentCustomCohortJobActor(client,input.auth.userId,scope.organization_id)});
      assertTarget(await resolveTarget(client,input,true),target);
      privateDraft(await privateCaptureWorkfile(client,input));
      if((await subjects.compareCurrent(retained.subjectReference)).status!=='matched') fail('subject_changed');
      authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
        permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
      if(!same(await boundedPolicy(authorizeMarketData,client,input.auth,context,purpose,budget),decision)) fail('market_policy_changed');
      if(readingCadPages&&!same(await boundedPolicy(authorizeCadImprovementData,client,input.auth,context,cadPurpose,budget),cadDecision))
        fail('CAD_source_policy_changed');
      if(!same(await jobs.readRequest(claim,jobOptions),requested)||!same(await stockStore.read(),stock)) fail('checkpoint_conflict');
      if(!same((await chain.describe(root)).layers,prefix.layers)) fail('checkpoint_conflict');
      if(graphAnchorStore&&!same(await graphAnchorStore.read(),graphAnchor))fail('checkpoint_conflict');
      if(geographicAnchorStore&&!same(await geographicAnchorStore.read(),geographicAnchor))fail('checkpoint_conflict');
      if(identityAnchorStore&&!same(await identityAnchorStore.read(),identityAnchor))fail('checkpoint_conflict');
      budget.check();
      if(readingStockMetrics||readingSharedStockMetrics||readingCadPages||readingTransactionPages) return freeze({...stockMetricResult,
        ...(readingStockMetrics?{typed_original_reference:typedReference}:{}),
        ...(readingCadPages?{CAD_source_authorization:{purpose:cadPurpose,decision:cadDecision},stock_reference:stockReference,
          current_authorized_owner:'V2_issued_graph_geography_identity_and_separate_CAD_rights'}:{}),
        ...(readingTransactionPages?{stock_reference:stockReference,retained_effective_date:context.effective_date,
          retained_observation_period:input.observationPeriod,
          current_authorized_owner:'V2_issued_graph_geography_identity_and_current_original_source_rights'}:{}),
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference});
      if(typing) return freeze({status:'typed_original_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference,typed_original_reference:typedReference,generation_id:stock.generation_id,
        advanced:typedOriginals.advanced,typed_layer_count:typedOriginals.progress.kind_index,all_layers_typed:typedOriginals.all_layers_typed,
        typed_profile_ref:typedOriginals.profile_ref,individual_original_interpretation:typedOriginals.all_layers_typed?'complete':'in_progress',
        property_transaction_observations:'not_established',source_freshness:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(identityVerifying) return freeze({status:'source_identity_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        identity_verification_reference:identityVerificationReference,generation_id:stock.generation_id,
        advanced:identityVerification.advanced,verified_layer_count:identityVerification.progress.kind_index,
        all_layers_verified:identityVerification.all_layers_verified,original_graph_verification:'representation_verified',
        geographic_stock_verification:'originals_verified',
        source_identity_closure:identityVerification.all_layers_verified?'identities_and_one_hop_verified':'in_progress',
        unknown_parcel_origins:identityVerification.progress.unknown_parcel_origins,
        origin_count_scope:'source_graph_account_parcel_parts_not_geographic_stock',
        missing_account_count:identityVerification.progress.missing_account_count,
        typed_numerical_observations:'not_established',source_freshness:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(stockVerifying) return freeze({status:'geographic_original_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,stock_verification_reference:stockVerificationReference,
        generation_id:stock.generation_id,advanced:stockVerification.advanced,
        verified_parcels:stockVerification.progress.verified_parcels,verified_unassociated:stockVerification.progress.verified_unassociated,
        all_parcels_verified:stockVerification.all_parcels_verified,original_graph_verification:'representation_verified',
        geographic_stock_verification:stockVerification.all_parcels_verified?'originals_verified':'in_progress',
        typed_identity_closure:'not_established',source_acquisition:'not_established',report_update:'none'});
      if(verifying) return freeze({status:'original_graph_progress_retained',operation_id:input.operationId,
        source_reference:reference,verification_reference:verificationReference,generation_id:stock.generation_id,
        advanced:verification.advanced,verified_layer_count:verification.verified_layer_count,
        all_layers_verified:verification.all_layers_verified,
        original_graph_verification:verification.all_layers_verified?'representation_verified':'in_progress',
        geographic_stock_verification:'not_established',typed_identity_closure:'not_established',
        source_acquisition:'not_established',report_update:'none'});
      return freeze({status:referencesV2?'source_reference_prefix_retained':'source_prefix_retained',operation_id:input.operationId,source_reference:reference,
        generation_id:stock.generation_id,advanced:kind!==undefined,layers:prefix.layers,
        all_layers_ended:COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS.every(key=>prefix.layers[key].ended),
        original_graph_verification:'not_established',source_acquisition:'not_established',report_update:'none'});
    });
  }
  return Object.freeze({
    ...recordedGroupSelection,
    ...preparedCatalog,
    selectPreparedRecordedGroups: retainedGroupSelection.selectRecordedGroups,
    selectAndSavePreparedRecordedGroups: retainedGroupSelection.selectAndSaveRecordedGroups,
    completePreparedRecordedGroupCapture: retainedGroupSelection.completeRecordedGroupCapture,
    readPreparedRecordedGroupSelection: retainedGroupSelection.readRecordedGroupSelection,
    // These are intentionally not exposed by the HTTP router until a worker
    // can process queued jobs. Queue admission is not a source grant; every
    // operation rechecks current assignment access and the worker must recheck
    // current actor/source rights before each resumable stage and registration.
    async queueCaptureJob(value, options = {}) {
      const input = inputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, true, 'write');
        return createCustomCohortCaptureJobRepository(client).enqueue({
          scope: Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])),
          actorUserId: input.auth.userId,
          request: { operation_id: input.operationId, observation_period: input.observationPeriod,
            ...(input.discovery ? { discovery: input.discovery } : {}),
            ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) },
        });
      });
    },
    async captureJobStatus(value, options = {}) {
      const input = captureJobInputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, false, 'read');
        return createCustomCohortCaptureJobRepository(client).status(
          Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])), input.operationId);
      });
    },
    async cancelCaptureJob(value, options = {}) {
      const input = captureJobInputOf(value), budget = operationBudget(options);
      return transaction(pool, 'READ COMMITTED', budget, async client => {
        const target = await resolveTarget(client, input, true, 'write');
        return createCustomCohortCaptureJobRepository(client).cancel(
          Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])), input.operationId);
      });
    },
    /** New internal worker stage, not an HTTP/default acquisition path. Retain
     * the original subject and exact SQL stock once; NEVER read licensed sales
     * here or publish a partial context/report. Source acquisition has its own
     * subsequent current-purpose checks and explicit versioned owner. */
    async prepareFrozenCaptureJobStock(value, options = {}) {
      if (!options || Object.getPrototypeOf(options)!==Object.prototype) fail('invalid_options');
      const {captureJobClaim:providedClaim,...budgetOptions}=options;
      const originalInput=inputOf(value);
      const claim=prepareCustomCohortCaptureJobClaim(providedClaim);
      if (claim.operation_id!==originalInput.operationId.toLowerCase()) fail('operation_conflict');
      if (originalInput.privateSalesImport || originalInput.discovery?.profile_id!=='custom-suburban-radius-v2') fail('frozen_discovery_unsupported');
      const budget=operationBudget(budgetOptions,LIMITS.capture_duration_ms);
      return transaction(pool,'READ COMMITTED',budget,async client=>{
        // Resolve only the organization locator before fresh DB identity. Old
        // browser/worker role claims are not used for even initial admission.
        const locator=one(await client.query(`/* custom-cohort-capture:job-organization */
          SELECT organization_id FROM app.assignment_files WHERE id=$1::bigint AND account_id=$2`,
        [originalInput.assignmentFileId,originalInput.accountId]));
        let input=freeze({...originalInput,operationId:claim.operation_id,
          auth:await loadCurrentCustomCohortJobActor(client,originalInput.auth.userId,locator.organization_id)});
        privateDraft(await privateCaptureWorkfile(client,input));
        const target=await resolveTarget(client,input,true);
        const scope=Object.fromEntries(TARGET_FIELDS.map(key=>[key,target[key]]));
        const jobOptions={scope,actorUserId:input.auth.userId},jobs=createCustomCohortCaptureJobRepository(client);
        const requested={operation_id:input.operationId,observation_period:input.observationPeriod,discovery:input.discovery};
        if(!same(await jobs.readRequest(claim,jobOptions),requested)) fail('operation_conflict');
        const checkpoint=await jobs.readCheckpoint(claim,jobOptions);
        if(checkpoint && !['subject','frozen_stock_v1'].includes(checkpoint.phase)) fail('checkpoint_conflict');
        if(checkpoint?.phase==='frozen_stock_v1' && checkpoint.evidence_refs.length!==2) fail('checkpoint_conflict');
        const subjects=createCustomCohortSubjectRepository(client,canonicalAssessmentJson(scope));
        const blobs=createNeighborhoodCohortBlobRepository(client,scope.organization_id);
        const study=freeze({profile_id:input.discovery.profile_id,discovery:input.discovery,
          observation_period:input.observationPeriod,knowledge_cutoff:null});
        let retained;
        if(checkpoint) {
          retained=await resumeCustomCohortSubjectCheckpoint({checkpoint:{phase:'subject',evidence_refs:[checkpoint.evidence_refs[0]]},
            blobs,subjects,input,study,reportedProfile,housingProfile});
        } else {
          const subjectReference=await subjects.capture(),subject=await subjects.load(subjectReference);
          if(study.observation_period.end_date>subject.effective_date) fail('period_after_effective_date');
          const point=await subjects.loadRecordedPoint(subjectReference);
          if(point.status!=='represented') fail('recorded_point_required');
          const body=freeze({intent_version:1+(reportedProfile?2:0)+4,operation_id:input.operationId,
            actor_user_id:input.auth.userId,subject_inputs:subjectReference,target:subject.target,
            effective_date:subject.effective_date,study,created_at:await databaseTime(client),
            ...(reportedProfile?{reported_sale_interpretation:reportedProfile}:{}),recorded_housing_interpretation:housingProfile});
          retained={subjectReference,subject,point,intent:{body,reference:await blobs.put(canonicalAssessmentJson(body))}};
        }
        authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        const pin=checkpoint?.phase==='frozen_stock_v1' ? await jobs.readPreparedGeneration(claim,jobOptions)
          : await jobs.pinPreparedGeneration(claim,jobOptions);
        if(!pin) fail('prepared_generation_unavailable');
        const stockStore=createNeighborhoodFrozenJobStock(client,{claim,scope,actorUserId:input.auth.userId,
          geometryInput:retained.point.geometry_input,discovery:input.discovery,subjectIntent:retained.intent.reference,checkBudget:budget.check});
        const stock=checkpoint?.phase==='frozen_stock_v1' ? await stockStore.read() : await stockStore.prepare();
        const body={stock_stage_version:1,usage:'frozen_job_stock_only',subject_intent:retained.intent.reference,stock};
        let reference;
        if(checkpoint?.phase==='frozen_stock_v1') {
          reference=checkpoint.evidence_refs[1];
          if(await blobs.get(reference.content_sha256,reference.canonical_utf8_bytes)!==canonicalAssessmentJson(body)) fail('checkpoint_conflict');
        }else{
          reference=await blobs.put(canonicalAssessmentJson(body));
          await jobs.saveCheckpoint(claim,jobOptions,{phase:'frozen_stock_v1',evidence_refs:[retained.intent.reference,reference]});
        }
        // Recheck current roles, exact assignment and original subject under
        // READ COMMITTED before commit. Pin/data/checkpoint alone grant none.
        input=freeze({...input,auth:await loadCurrentCustomCohortJobActor(client,input.auth.userId,scope.organization_id)});
        assertTarget(await resolveTarget(client,input,true),target);
        privateDraft(await privateCaptureWorkfile(client,input));
        if((await subjects.compareCurrent(retained.subjectReference)).status!=='matched') fail('subject_changed');
        authorizePublicCadastralCatalogRead(input.auth,input.accountId,{workflows:['custom_appraisal'],
          permissionChecker:(auth,workflow,permission)=>hasApplicationPermission(auth,workflow,permission,scope.organization_id)});
        if(!same(await jobs.readRequest(claim,jobOptions),requested) || !same(await stockStore.read(),stock)) fail('checkpoint_conflict');
        budget.check();
        return freeze({status:'stock_prepared',operation_id:input.operationId,reused:checkpoint?.phase==='frozen_stock_v1',
          stock_reference:reference,generation_id:stock.generation_id,population:stock.population,
          source_acquisition:'not_established',report_update:'none'});
      });
    },
    /** Internal source-prefix DATA stage; never dispatched by the legacy worker. */
    prepareFrozenCaptureJobSourcePage: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'prefix_v1'),
    /** Explicit V2 prefix DATA owner. Retain exact fixed-plan metadata only,
     * not per-report originals. Both-end current rights and the live generation/
     * stock pin are identical to V1; no V1 checkpoint conversion, new source
     * grant, verification receipt, HTTP/worker activation or Apply is implied. */
    prepareFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'prefix_refs_v2'),
    /** Explicit V2 original-query/root-edge verifier. Continuation is derived
     * only from a separately fenced owner-issued receipt anchor, never arbitrary
     * checkpoint progress. No legacy cast, source grant, worker dispatch or Apply. */
    verifyFrozenCaptureJobSourceReferencesV2Page: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'verify_refs_v2'),
    /** Explicit V2 geographic original owner. Requires the completed issued
     * graph and advances only its own independent geographic issuance head;
     * never casts V1 progress, grants source rights, releases a pin or Applies. */
    verifyFrozenCaptureJobStockOriginalReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'geographic_refs_v2'),
    /** Explicit V2 identity owner. Requires independently issued DONE graph and
     * geography; continuation comes only from its own issued identity head.
     * No typed observations, source acquisition, publication, Apply or pin release. */
    verifyFrozenCaptureJobSourceIdentityReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'identity_refs_v2'),
    /** Independent current-authorized root-edge/original-representation validation.
     * Not typed identity closure, complete geographic stock, source acquisition,
     * report publication or Apply. Progress is loaded only from this job's fence. */
    verifyFrozenCaptureJobSourcePage: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'verify_v1'),
    /** Independently reopen every geographic parcel original, including NULL
     * account geometry, after the actual owner verified the whole source graph.
     * Typed source identities/numerical coverage remain a subsequent stage. */
    verifyFrozenCaptureJobStockOriginals: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'geographic_v1'),
    /** Current-authorized exact identity/one-hop validation, not numerical facts,
     * historical/freshness coverage or a legacy acquisition capability. */
    verifyFrozenCaptureJobSourceIdentityClosure: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'identity_v1'),
    prepareFrozenCaptureJobTypedOriginals: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'typed_v1'),
    // Internal numerical pages only. No API/browser exposure, checkpoint write,
    // acquisition receipt or accepted report is established by reading a page.
    readFrozenCaptureJobStockMetrics: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'stock_metrics_v1'),
    // Exact prepared-cache reuse is separate from the per-job V1 typed path.
    // Still internal/unmounted: no new job phase, builder, schedule or Apply.
    readSharedFrozenCaptureJobStockMetrics: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'shared_stock_metrics_v1'),
    readSharedFrozenCaptureJobStockMetricsReferencesV2: (value, options = {}) => frozenCaptureJobSourceStage(value, options, 'shared_stock_metrics_refs_v2'),
    /** Read one bounded internal CAD syntax page after actual issued DONE V2
     * prerequisites and both current source decisions. Default composition has
     * no CAD grant; this method cannot prepare a cache, advance a checkpoint,
     * convert legacy receipts, publish reports or infer amenity meaning. */
    readSharedFrozenCaptureJobCadImprovementsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_CAD_pages_refs_v2'),
    /** Read current CAD account syntax using only the retained context date and
     * both current rights decisions; missing primary remains missing, and no
     * housing, amenity, historical or complete-population meaning is inferred. */
    readSharedFrozenCaptureJobCadAccountsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_CAD_accounts_refs_v2'),
    readSharedFrozenCaptureJobTransactionsReferencesV2: (value, options = {}) =>
      frozenCaptureJobSourceStage(value, options, 'shared_transaction_pages_refs_v2'),
    async capture(value, options = {}) {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype)
      fail('invalid_options');
    const { captureJobClaim: providedClaim, ...budgetOptions } = options;
    let input = inputOf(value);
    const captureJobClaim = providedClaim ? prepareCustomCohortCaptureJobClaim(providedClaim) : null;
    if (captureJobClaim && captureJobClaim.operation_id !== input.operationId.toLowerCase()) fail('operation_conflict');
    if (captureJobClaim) input = freeze({ ...input, operationId: captureJobClaim.operation_id });
    const budget = operationBudget(budgetOptions, LIMITS.capture_duration_ms);
    async function refreshJobActor(client, organizationId) {
      if (!captureJobClaim) return;
      // A worker can run long enough for its initial roles to be revoked. The
      // assignment and source checks in each transaction must use today's
      // database identity, including the final registration and replay paths.
      budget.check();
      const auth = await loadCurrentCustomCohortJobActor(client, input.auth.userId, organizationId);
      budget.check();
      input = freeze({ ...input, auth });
    }
    budget.check();
    const phase = createCustomCapturePhaseTiming();
    const study = freeze({ profile_id: input.discovery?.profile_id ?? NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1,
      ...(input.discovery ? { discovery: input.discovery } : {}),
      observation_period: input.observationPeriod, knowledge_cutoff: null });
    const phaseOne = await phase('subject', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const privateWorkfile = input.privateSalesImport ? await privateCaptureWorkfile(client, input) : null;
      const target = await resolveTarget(client, input, true);
      await refreshJobActor(client, target.organization_id);
      if (captureJobClaim) assertTarget(await resolveTarget(client, input, true), target);
      const scope = Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]]));
      const scopeJson = canonicalAssessmentJson(scope);
      const repository = createCustomCohortSubjectRepository(client, scopeJson);
      const jobs = captureJobClaim ? createCustomCohortCaptureJobRepository(client) : null;
      const jobScope = { scope, actorUserId: input.auth.userId };
      const checkpoint = jobs ? await jobs.readCheckpoint(captureJobClaim, jobScope) : null;
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
        // A worker retry can observe a context committed before its response
        // was lost. Close that exact fenced claim only after replay has again
        // checked the current assignment and source rights.
        if (captureJobClaim) await createCustomCohortCaptureJobRepository(client)
          .complete(captureJobClaim, reference.context_sha256);
        // Replay confirms durable registration only, not a new source read or
        // eligible cohort. No raw market evidence is returned here.
        return { replay: freeze({ status: 'registered', reused: true, context_ref: reference,
          discovery: { ...(retained.summary.discovery ?? { radius_metres: retained.summary.radius_metres }), parcel_count: retained.summary.parcel_count,
            account_count: retained.summary.account_count }, source_query_complete: true, provider_coverage: 'not_established',
          unsupported_capabilities: retained.retained_inputs.acquisition.capture_result.unsupported_capabilities,
          ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) }) };
      }
      if (privateWorkfile) privateDraft(privateWorkfile);
      if (checkpoint) {
        const resume = checkpoint.phase === 'preparation'
          ? resumeCustomCohortPreparationCheckpoint : resumeCustomCohortSubjectCheckpoint;
        const resumed = await resume({ checkpoint,
          blobs: createNeighborhoodCohortBlobRepository(client, scope.organization_id),
          subjects: repository, input, study, reportedProfile, housingProfile });
        if (resumed.stagedHeader) {
          authorizePublicCadastralCatalogRead(input.auth, input.accountId, { workflows: ['custom_appraisal'],
            permissionChecker: (auth, workflow, permission) => hasApplicationPermission(auth, workflow, permission, scope.organization_id) });
          const stagedCapture = await authorizedRetainedInputs(client, { scopeJson,
            reference: resumed.stagedHeader.context_ref, input, authorizeMarketData, authorizePrivateSales,
            budget, study, stagedHeader: resumed.stagedHeader, expectedIntent: resumed.intent.reference });
          if (!same(stagedCapture.retained.subject_reference, resumed.subjectReference)
            || !same(stagedCapture.retained.acquisition_intent, resumed.intent)) fail('checkpoint_conflict');
          budget.check();
          return { scope, scopeJson, ...resumed, stagedCapture, checkpoint };
        }
        budget.check();
        return { scope, scopeJson, ...resumed };
      }
      const subjectReference = await repository.capture();
      const subject = await repository.load(subjectReference);
      if (study.observation_period.end_date > subject.effective_date) fail('period_after_effective_date');
      const point = await repository.loadRecordedPoint(subjectReference);
      if (point.status !== 'represented') fail('recorded_point_required', point.reason);
      const body = freeze({ intent_version: (input.privateSalesImport ? 2 : 1) + (reportedProfile ? 2 : 0) + 4, operation_id: input.operationId, actor_user_id: input.auth.userId,
        subject_inputs: subjectReference, target: subject.target, effective_date: subject.effective_date,
        study, created_at: await databaseTime(client),
        ...(reportedProfile ? { reported_sale_interpretation: reportedProfile } : {}),
        recorded_housing_interpretation: housingProfile,
        ...(input.privateSalesImport ? { private_sales_import: input.privateSalesImport } : {}) });
      const reference = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalAssessmentJson(body));
      if (jobs) await jobs.saveCheckpoint(captureJobClaim, jobScope,
        { phase: 'subject', evidence_refs: [reference] });
      return { scope, scopeJson, subject, subjectReference, point, intent: { reference, body } };
    }));
    if (phaseOne.replay) return phaseOne.replay;
    const { scope, scopeJson, subject, subjectReference, point, intent } = phaseOne;
    // A saved operation replays its retained original before consulting today's
    // registry. A NEW city study accepts only an installed, dated local asset.
    const city = !phaseOne.stagedCapture && input.discovery?.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY
      ? await loadInstalledCustomCityDiscovery(input.discovery) : null;
    budget.check();
    const context = contextOf(subject);
    let purpose = phaseOne.stagedCapture?.purpose, decision = phaseOne.stagedCapture?.decision;
    const originals = phaseOne.stagedCapture?.retained.retained_inputs;
    // Completed acquisition/preparation retries use the exact complete original
    // snapshot. A later database sweep must not get mixed into that operation.
    const read = originals ? { spatial: originals.spatial, selector: originals.selector,
      result: originals.acquisition.capture_result, privateSales: originals.private_sales ?? null }
      : await transaction(pool, 'REPEATABLE READ READ ONLY', budget, async client => {
      await refreshJobActor(client, scope.organization_id);
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
      const spatial = await phase('spatial', async () => captured(await captureNeighborhoodSpatialMembershipCompact(client, point.geometry_input, {}, input.discovery, city ?? undefined), 'spatial'));
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
      // The chosen issuer/reader pair must agree; denied expanded rights never
      // fall back to the old projection. Registered contexts replay above.
      const access = createReadAccess({
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
        const grants = await phase('source_authorization', () => access.prepare(input.auth, { target: context.target,
          selection_reference: { id: input.operationId, revision: 1 }, observation_period: input.observationPeriod, knowledge_cutoff: null }));
        const reader = createSourceReader(pool, { access });
        const result = await phase('source_read', async () => captured(await reader.captureInSnapshot(client, { ...grants.request, auth: input.auth,
          selection_grant: grants.selection_grant, market_grant: grants.market_grant },
        { deadline: budget.deadline, signal: budget.signal }), 'source'));
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
    const prepared = originals ? null : await phase('preparation', () => {
      const acquisition = consumeNeighborhoodCachedAcquisition(read.reader, read.result);
      return prepareCustomCohortCaptureInputsBatched({ acquisition, spatial: read.spatial, subject,
        subject_reference: subjectReference, selector: read.selector, study, acquisition_intent: intent,
        started_at: read.startedAt, completed_at: read.completedAt,
        ...(reportedProfile ? { reported_sale_interpretation: reportedProfile } : {}),
        recorded_housing_interpretation: housingProfile,
        ...(read.privateSales ? { private_sales: read.privateSales } : {}) }, { check: budget.check });
    });
    const recheckCapture = async client => {
      await refreshJobActor(client, scope.organization_id);
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
    };
    const headerFor = refs => ({ context_version: 1, context_id: input.operationId, context_revision: '1',
      target: { ...context.target, ...context.scope, snapshot_version: subject.target.snapshot_version },
      effective_date: subject.effective_date, ...refs });
    let stagedHeader = phaseOne.stagedHeader, preparedCheckpoint = phaseOne.checkpoint;
    if (captureJobClaim && !stagedHeader) {
      // Stage only a WHOLE validated acquisition. Immutable originals, their
      // header and the fenced checkpoint commit together; no context/report is
      // published here. Partial source pages cannot become a completed study.
      await transaction(pool, 'READ COMMITTED', budget, async client => {
        await recheckCapture(client);
        const refs = await phase('retention', () => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
        const canonicalHeader = canonicalAssessmentJson(headerFor(refs));
        const representedHeader = prepareCustomCohortContextHeader(canonicalHeader);
        const headerRef = await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put(canonicalHeader);
        preparedCheckpoint = { phase: 'preparation', evidence_refs: [intent.reference, headerRef] };
        await createCustomCohortCaptureJobRepository(client).saveCheckpoint(captureJobClaim,
          { scope, actorUserId: input.auth.userId }, preparedCheckpoint);
        stagedHeader = representedHeader;
      });
    }
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      await recheckCapture(client);
      let header;
      if (captureJobClaim) {
        const current = await createCustomCohortCaptureJobRepository(client).readCheckpoint(captureJobClaim,
          { scope, actorUserId: input.auth.userId });
        if (!same(current, preparedCheckpoint)) fail('checkpoint_conflict');
        header = stagedHeader.body;
      } else {
        const refs = await phase('retention', () => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
        header = headerFor(refs);
      }
      budget.check();
      const stored = await phase('registration', () => createCustomCohortContextRepository(client, scopeJson).put(canonicalAssessmentJson(header)));
      // The job and context become visible together. A lost/cancelled claim
      // aborts this transaction rather than publishing an orphaned context.
      if (captureJobClaim) await createCustomCohortCaptureJobRepository(client)
        .complete(captureJobClaim, stored.context_ref.context_sha256);
      return freeze({ status: 'registered', reused: stored.status === 'reused', context_ref: stored.context_ref,
        discovery: { ...(phaseOne.stagedCapture?.retained.summary.discovery ?? (city ? city.choice : { radius_metres: read.spatial.radius_metres })),
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
    const input = reportedInputOf(value), budget = operationBudget(options), phase = createCustomReportPhaseTiming();
    const loaded = await phase('load', () => transaction(pool, 'READ COMMITTED', budget, async client => {
      const data = await loadReported(client, input, budget);
      if (data.reportEditor.editor_revision !== input.expectedEditorRevision) fail('report_editor_changed');
      if (input.replacement) data.replacement = await reportedPredecessor(client, input, data.target);
      const previous = await storedReportProposal(client, input, data.target);
      if (previous && !same(previous.payload.fences, reportFences(data))) fail('report_proposal_changed');
      await recheckReported(client, input, data, budget);
      return { ...data, previous };
    }));
    if (loaded.previous) return proposalResponse(input, loaded, { status: 'ready',
      attachment: loaded.previous.stored.attachment }, loaded.previous.stored.assessment, [], true);
    const active = loaded.workspace.checkpoint.active;
    const target = { scope: loaded.retained.context.scope, report_file_id: loaded.target.report_file_id,
      custom_assignment_file_id: Number(input.assignmentFileId), editor_revision: input.expectedEditorRevision,
      effective_date: loaded.retained.context.effective_date, data_cutoff: loaded.retained.context.effective_date };
    const identity = { assessment_id: randomUUID(), assessment_revision: 1, attachment_id: randomUUID(), attachment_revision: 1 };
    budget.check();
    const buildReported = loaded.retained.reportedInterpretation
      ? buildCustomCohortReportedAssessmentWitnessV2Batched : buildCustomCohortReportedAssessmentBatched;
    const prepared = await phase('assembly', () => buildReported({ context_ref: input.contextRef,
      retained_inputs: loaded.retained.retained.retained_inputs, selection: loaded.workspaceSelection?.selection ?? active.selection, target,
      catalog_version: customWorkspaceCatalogVersion(loaded.workspace.checkpoint),
      preparation_identity: identity, report_geography: loaded.reportGeography, derived_at: loaded.derivedAt,
      proposal_binding: { operation_id: input.operationId, actor_user_id: input.auth.userId,
        expected_editor_revision: input.expectedEditorRevision } }, { check: budget.check }));
    // Rehearse the exact public shape before any publication writes. The final
    // published identity is checked again after its actual revision is assigned.
    if (prepared.status === 'ready') proposalResponse(input, loaded, prepared.candidate, prepared.assessment);
    budget.check();
    return phase('publication', () => transaction(pool, 'READ COMMITTED', budget, async client => {
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
      const published = await phase('repository', () => repository.publishBatched(claim, prepared.assessment, prepared.publication_bundle.members,
        prepared.publication_bundle.sources.map(source => ({ id: source.snapshot.id, payload: source.payload })), { check: budget.check }));
      if (!published.promoted) fail('report_proposal_changed');
      const candidate = buildCustomNeighborhoodReportCandidate({ assessment: published.assessment,
        target: { ...target, attachment_id: identity.attachment_id, attachment_revision: identity.attachment_revision,
          workflow_type: 'custom_appraisal', uad_workfile_id: null, specification_release: null } });
      if (candidate.status !== 'ready') fail('report_publication_incomplete');
      await persistNeighborhoodAttachment(client, { assessment: published.assessment,
        attachment: candidate.attachment, mappedSuggestions: candidate.suggestions });
      await recheckReported(client, input, loaded, budget);
      return proposalResponse(input, loaded, candidate, published.assessment);
    }));
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
      const exactSelection = workspace.checkpoint.workspace_version === 7;
      const currentInput = exactSelection ? { ...input,
        auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, target.organization_id) } : input;
      if (exactSelection) assertTarget(await resolveTarget(client, currentInput, true, 'read'), target);
      const retained = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef,
        input: currentInput, authorizeMarketData, authorizePrivateSales, budget, study: workspace.checkpoint.active,
        additionalExposures: exactSelection ? ['report_observation_catalog'] : [] });
      const selection = await workspaceSelection(client, currentInput, { scopeJson, workspace, retained }, budget);
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
      return { target, scopeJson, workspace, review, retained, reportEditor, savedBoundary, reportGeography, now, derivedAt,
        ...(selection ? { workspaceSelection: selection } : {}) };
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
        retained_inputs: loaded.retained.retained.retained_inputs, selection: loaded.workspaceSelection?.selection ?? active.selection,
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
      const currentInput = loaded.workspaceSelection ? { ...input,
        auth: await loadCurrentCustomCohortJobActor(client, input.auth.userId, loaded.target.organization_id) } : input;
      assertTarget(await resolveTarget(client, currentInput, true, 'read'), loaded.target);
      const workspace = await savedWorkspace(client, input);
      if (!same(workspace, loaded.workspace)) fail('workspace_changed');
      await recheckWorkspaceSelection(client, currentInput, loaded, budget);
      if (loaded.reportEditor !== null && !same(await reportEditorState(client, input), loaded.reportEditor)) fail('report_editor_changed');
      if (loaded.savedBoundary !== null && !same(await reportGeographyState(client, input), loaded.savedBoundary)) fail('report_geography_changed');
      if ((await createCustomCohortSubjectRepository(client, loaded.scopeJson)
        .compareCurrent(loaded.retained.retained.subject_reference)).status !== 'matched') fail('subject_changed');
      const review = await createCustomCohortReviewRepository(client, loaded.scopeJson)
        .getCurrent(canonicalAssessmentJson(input.contextRef), input.expectedReviewGeneration);
      if (review.state_sha256 !== loaded.review.state_sha256) fail('review_state_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, currentInput.auth,
        loaded.retained.context, loaded.retained.purpose, budget);
      if (!same(decision, loaded.retained.decision)) fail('market_policy_changed');
      if (loaded.workspaceSelection && !same(await boundedPolicy(authorizeMarketData, client, currentInput.auth,
        loaded.retained.context, loaded.retained.purpose, budget, 'report_observation_catalog'), loaded.retained.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, currentInput, loaded.retained, budget,
        loaded.workspaceSelection ? ['none', 'report_observation_catalog'] : ['none']);
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
    // Saved workspaces pin their catalog semantics. Only a fresh opening or an
    // explicit user upgrade requests latest; never reinterpret old unassigned.
    // Omitted wire versions stay v2 for already-open clients during rollout.
    const catalogVersion = value && Object.hasOwn(value, 'catalogVersion')
      ? value.catalogVersion : CUSTOM_COHORT_DENSE_CATALOG_VERSION;
    customCohortCatalogGroupLimit(catalogVersion);
    // Preserve the original method/response when omitted. The optional summary
    // uses the two EXISTING exposures; no source-policy key/grant is widened.
    const requested = value && Object.hasOwn(value, 'includeRecommendation');
    const include = requested ? value.includeRecommendation : false;
    if (typeof include !== 'boolean') fail('invalid_input');
    const explicitGroups = value && Object.hasOwn(value, 'initialPreviewGroups');
    const modeRequested = value && Object.hasOwn(value, 'initialPreviewMode');
    const manifestOpening = value && Object.hasOwn(value, 'initialMapMode');
    if (explicitGroups && modeRequested) fail('invalid_input');
    if (modeRequested) prepareCustomCohortOpeningMode(value.initialPreviewMode);
    const opening = explicitGroups || modeRequested;
    if (manifestOpening && (value.initialMapMode !== 'manifest' || !opening || catalogVersion !== 3 || !include)) fail('invalid_input');
    const groups = explicitGroups ? prepareCustomCohortOpeningGroups(value.initialPreviewGroups, catalogVersion) : null;
    const input = Object.fromEntries(Object.entries(value).filter(([key]) => !['catalogVersion', 'includeRecommendation', 'initialPreviewGroups', 'initialPreviewMode', 'initialMapMode'].includes(key)));
    const cached = await readPreparedCatalog(input, options, { catalogVersion, include, opening, groups,
      recommendedAreaOpening: modeRequested && value.initialPreviewMode === 'recommended_area', manifestOpening });
    if (cached) return cached;
    return runPreview(input, options, { includeMap: false, exposure: 'report_observation_catalog',
      additionalExposures: include || opening ? ['report_observation_summary'] : [],
      preparedCatalog: include && catalogVersion === 3,
      manifestOpening,
      outputLimit: opening ? CUSTOM_COHORT_OPENING_RESPONSE_BYTES : include ? CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes : null,
      recommendedAreaOpening: modeRequested && value.initialPreviewMode === 'recommended_area',
      project: async (preview, expected, _parcelMap, retained_inputs, deriveProximity, presentOpening, checkBudget, deriveSecondary, setCatalogPhaseTiming) => {
        const timed = createCustomCatalogPhaseTiming();
        setCatalogPhaseTiming(timed);
        const catalog = await timed('catalog', () => presentCustomCohortPocketCatalog({
          catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview, catalog_version: catalogVersion }), preview, expected,
        }));
        const city = retained_inputs.study.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_CITY;
        const response = { status: 'catalog', catalog, ...(city ? { discovery: retained_inputs.study.discovery } : {}) };
        if (!include && modeRequested && value.initialPreviewMode === 'recommended_area') fail('invalid_input');
        if (!include && opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
          groups ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
        if (!include) return response;
        // Ranking/report safeguards stay separate from display-only colors.
        // Current retained CAD can inform manual map review without pretending
        // it establishes a retrospective housing population. Reuse the same
        // preview/kernel and prepared catalog, never a fresh source capture.
        const current = customCohortCurrentStockSupport({ effective_date: retained_inputs.subject.effective_date,
          retained_capture_at: retained_inputs.acquisition.capture_result.captured_at });
        if (!catalog.catalog_complete || current.status === 'historical_stock_evidence_required') {
          if (catalog.catalog_complete) response.prepared_secondary_map = await timed('retained_map_scores', () =>
            buildCustomCohortMapScoresBatched({ context_ref: expected.context_ref, retained_inputs,
              catalog_version: catalogVersion, observation_preview: catalogVersion >= 2 ? preview : undefined,
              selection: { revision: expected.selection_revision, included_recorded_group_ids: [] } }, { checkBudget }));
          if (opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
            groups ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
          return response;
        }
        // A municipal polygon has no radius-calibrated proximity scale. Keep
        // that factor unknown instead of borrowing an arbitrary ten-mile radius.
        const recorded_proximity = city ? undefined : await timed('proximity', deriveProximity);
        // No map can consume this overlay when the retained parcel geometry is
        // unavailable. This also avoids an unnecessary index checkout.
        const prepared_secondary_facts = !city && recorded_proximity?.reason === 'retained_map_unavailable'
          ? null : await timed('prepared_secondary', deriveSecondary).catch(() => null);
        checkBudget();
        const maximumBytes = Math.max(0, Math.min(CUSTOM_COHORT_DENSE_RECOMMENDATION_PRESENTATION_BYTES,
          CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes
            - Buffer.byteLength(JSON.stringify({ ...response, initial_preview: undefined })) - 10_000));
        const recommendation = await timed('recommendation', () => buildCustomCohortPocketRecommendationPresentationBatched({ catalog, expected,
          retained_inputs, recorded_proximity, observation_preview: preview, maximumBytes,
          prepared_secondary_facts }, { checkBudget }));
        const { prepared_secondary_map, ...stableRecommendation } = recommendation ?? {};
        // The opening preview and the saved revision must use one identical
        // selection. On missing/unsupported recommendation, retain the prior
        // complete-catalog opening instead of presenting an invented subset.
        const areaIds = modeRequested && value.initialPreviewMode === 'recommended_area'
          && recommendation?.sales_aware_area?.status !== 'unavailable'
          && recommendation?.sales_aware_area?.selected_recorded_group_ids?.length
          ? recommendation.sales_aware_area.selected_recorded_group_ids : null;
        if (opening) response.initial_preview = await timed('opening', () => presentOpening(customCohortOpeningSelection(catalog,
          groups ?? areaIds ?? customCohortOpeningGroupIds(catalog), expected.selection_revision)));
        return { ...response, ...(recommendation ? { recommendation: stableRecommendation } : {}),
          ...(prepared_secondary_map ? { prepared_secondary_map } : {}) };
      },
    });
  }, async authorizeMarketSelection(value, options = {}) {
    const input = previewInputOf(value), budget = operationBudget(options);
    return transaction(pool, 'READ COMMITTED', budget, async client => {
      const target = await resolveTarget(client, input, false, 'read');
      const scopeJson = canonicalAssessmentJson(Object.fromEntries(TARGET_FIELDS.map(key => [key, target[key]])));
      const licensed = await authorizedRetainedInputs(client, { scopeJson, reference: input.contextRef, input,
        authorizeMarketData, authorizePrivateSales, budget, exposure: 'report_observation_summary',
        privateSummary: true, loadInputs: false });
      const membership = await checkCustomCohortMarketMembership({
        store: createNeighborhoodCohortBlobRepository(client, target.organization_id),
        rosterRef: licensed.accountRosterRef, selection: input.selection, contextRef: input.contextRef, checkBudget: budget.check,
      });
      assertTarget(await resolveTarget(client, input, true, 'read'), target);
      if ((await createCustomCohortSubjectRepository(client, scopeJson)
        .compareCurrent(licensed.subjectReference)).status !== 'matched') fail('subject_changed');
      const decision = await boundedPolicy(authorizeMarketData, client, input.auth,
        licensed.context, licensed.purpose, budget, 'report_observation_summary');
      if (!same(decision, licensed.decision)) fail('market_policy_changed');
      await recheckPrivatePolicy(client, input, licensed, budget, ['report_observation_summary']);
      budget.check();
      // This is internal authorization, not report Apply or a rewritten capture.
      return freeze({ target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId }, ...membership });
    });
  }, present(value, presentation = { includeMap: true }, options = {}) {
    exactKeys(presentation, ['includeMap']);
    if (typeof presentation.includeMap !== 'boolean') fail('invalid_input');
    return runPreview(value, options, { includeMap: presentation.includeMap, exposure: 'report_observation_summary', preparedFast: true,
      project: (preview, expected, parcelMap) => ({ summary: presentCustomCohortPreview({ preview, expected, includeNarrative: true }), parcel_map: parcelMap }) });
  }, async viewport(value, viewport, options = {}) {
    const checked = prepareCustomCohortViewport(viewport);
    const preview = await runPreview(value, options, { includeMap: true, exposure: 'report_observation_summary', preparedFast: true,
      mapViewport: checked,
      project: (observation, expected, parcelMap) => ({ summary: presentCustomCohortPreview({ preview: observation, expected }), parcel_map: parcelMap }) });
    return projectCustomCohortViewportMap(preview, checked);
  }, inspect(value, inspection, options = {}) {
    exactKeys(inspection, ['population', 'page']);
    const owned = freeze(JSON.parse(canonicalAssessmentJson(inspection)));
    return runPreview(value, options, { includeMap: false, exposure: 'report_observation_members',
      project: (preview, expected) => ({ status: 'members', page: inspectCustomCohortPreviewMembers({ preview, expected, ...owned }) }) });
  } });
}
