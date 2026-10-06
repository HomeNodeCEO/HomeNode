import express from 'express';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { CUSTOM_COHORT_POCKET_CATALOG_LIMITS } from '../../services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { prepareCustomCohortOpeningMode, CUSTOM_COHORT_OPENING_RESPONSE_BYTES } from '../../services/neighborhoodAssessment/customCohortOpeningPreview.js';
import { customCaptureDiagnostic } from '../../services/neighborhoodAssessment/customCaptureDiagnostics.js';
import { customCohortReadDiagnostic } from '../../services/neighborhoodAssessment/customCohortReadDiagnostics.js';
import { customCohortExecutionGate } from '../../services/neighborhoodAssessment/customCohortExecutionGate.js';
import { CUSTOM_COHORT_OPERATION_LIMITS } from '../../services/neighborhoodAssessment/customCohortOperationLimits.js';
import { CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, prepareCustomCohortRecordedGroupTransportRequest,
  presentCustomCohortRecordedGroupTransportResponse, CUSTOM_COHORT_GROUP_SUMMARY_RESPONSE_BYTES,
  prepareCustomCohortGroupSummaryTransportRequest,
  presentCustomCohortGroupSummaryTransportResponse } from '../../services/neighborhoodAssessment/customCohortRecordedGroupTransport.js';
import { CUSTOM_COHORT_SELECTION_VIEWPORT_BYTES, prepareCustomCohortGroupViewportTransportRequest,
  presentCustomCohortGroupViewportTransportResponse } from '../../services/neighborhoodAssessment/customCohortGroupViewportTransport.js';
import { CUSTOM_COHORT_SELECTION_MEMBER_BYTES, prepareCustomCohortGroupMemberTransportRequest,
  presentCustomCohortGroupMemberTransportResponse } from '../../services/neighborhoodAssessment/customCohortGroupMemberTransport.js';
import { prepareCustomCohortGroupWorkspaceTransportRequest,
  presentCustomCohortGroupWorkspaceTransportResponse } from '../../services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';
import { CUSTOM_COHORT_GROUP_MAP_OPENING_RESPONSE_BYTES, prepareCustomCohortGroupMapOpeningTransportRequest,
  presentCustomCohortGroupMapOpeningTransportResponse } from '../../services/neighborhoodAssessment/customCohortGroupMapOpening.js';
import { prepareCustomCohortRecordedGroupMarketRequest }
  from '../../services/neighborhoodAssessment/customCohortRecordedGroupMarketAnalysis.js';

const BASE = '/api/accounts/:id/neighborhood-cohort';
const BODY_BYTES = 4_000_000;
const CATALOG_COMPRESSION_THRESHOLD_BYTES = 64_000;
const compressCatalogGzip = promisify(gzip);
const compressCatalogBrotli = promisify(brotliCompress);
const FILE_ID = /^[1-9]\d{0,18}$/;
const INPUT_ERRORS = new Set(['invalid_input', 'invalid_account', 'invalid_assignment',
  'invalid_operation', 'invalid_period', 'invalid_selection', 'period_after_effective_date', 'invalid_private_sales_import', 'invalid_reported_input', 'invalid_discovery']);
const ACCESS_ERRORS = new Set(['assignment_access_denied', 'market_data_access_denied', 'report_observation_access_denied']);
const CONFLICT_ERRORS = new Set(['operation_conflict', 'subject_changed', 'target_changed', 'market_policy_changed', 'private_source_read_only',
  'workspace_changed', 'workspace_capture_pending', 'report_editor_changed', 'report_geography_changed',
  'report_policy_changed', 'report_proposal_changed', 'report_group_conflict', 'report_replacement_conflict']);
const UNAVAILABLE_ERRORS = new Set(['recorded_point_required', 'spatial_incomplete',
  'selector_incomplete', 'transaction_identity_incomplete', 'source_incomplete', 'retained_inputs_unavailable']);
const PREVIEW_CAPACITY_ERRORS = new Set([
  'custom_cohort_recorded_group_owner_summary_account_limit',
  'custom_cohort_observation_preview_output_bytes_limit',
  'custom_cohort_observation_preview_measurement_work_limit',
  'custom_cohort_observation_preview_member_work_limit',
]);

function invalid() { throw Object.assign(new Error('invalid_input'), { reason: 'invalid_input' }); }
function bodyOf(body, required, optional = [], maximum = BODY_BYTES) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype
    || !required.every(key => Object.hasOwn(body, key))
    || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  if (Buffer.byteLength(JSON.stringify(body)) > maximum) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  if (typeof body.assignment_file_id !== 'string' || !FILE_ID.test(body.assignment_file_id)
    || BigInt(body.assignment_file_id) > 9223372036854775807n) invalid();
  return body;
}
function publicFailure(error) {
  if (error?.code === 'custom_cohort_execution_busy') return [503, { error: 'neighborhood_service_busy' }];
  if (error?.code === 'custom_cohort_execution_interrupted') return [503, { error: 'neighborhood_request_interrupted' }];
  if (error?.outcome_unknown) return [409, { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true }];
  if (error instanceof TypeError && error.message === 'custom_cohort_job_actor_access_revoked')
    return [403, { error: 'neighborhood_access_denied' }];
  if (error instanceof TypeError && error.message === 'custom_cohort_group_selection_selection_changed')
    return [409, { error: 'neighborhood_selection_changed' }];
  if (error instanceof TypeError && error.message === 'custom_cohort_group_selection_operation_conflict')
    return [409, { error: 'neighborhood_operation_conflict' }];
  if (error instanceof TypeError && error.message === 'custom_cohort_recorded_group_selection_unknown_group')
    return [409, { error: 'neighborhood_selection_changed' }];
  if (error instanceof TypeError && ['revision_changed', 'study_changed', 'selection_changed', 'replay_changed',
    'capture_pending', 'unavailable'].some(reason => error.message === `custom_cohort_group_workspace_${reason}`))
    return [409, { error: 'neighborhood_workspace_changed' }];
  if (error?.message === 'custom_appraisal_section_revision_conflict') return [409, { error: 'neighborhood_workspace_changed' }];
  if (error?.message === 'custom_appraisal_workfile_signed') return [409, { error: 'neighborhood_private_source_read_only' }];
  if (['assignment_sales_import_revision_conflict', 'assignment_sales_import_capture_changed'].includes(error?.code)) {
    return [409, { error: 'neighborhood_private_review_changed' }];
  }
  if (['assignment_sales_import_source_not_reviewed', 'assignment_sales_import_source_use_not_confirmed'].includes(error?.code)) {
    return [422, { error: 'neighborhood_private_source_review_required' }];
  }
  if (error?.code === 'assignment_sales_import_preparation_limit') return [422, { error: 'neighborhood_private_source_limit' }];
  if (['report_response_limit', 'report_publication_incomplete'].includes(error?.reason)) {
    return [422, { error: 'neighborhood_report_incomplete' }];
  }
  if (['55P03', '57014', '40001', '40P01'].includes(error?.code)) return [503, { error: 'neighborhood_request_interrupted' }];
  if (error?.code === 'custom_neighborhood_acceptance_not_current_section') return [409, { error: 'neighborhood_report_editor_changed' }];
  if (error?.reason === 'catalog_transport_limit') return [422, { error: 'neighborhood_catalog_incomplete',
    reason: 'catalog_response_byte_limit', membership_returned: false }];
  if (error?.reason === 'viewport_capacity_exceeded') return [422, { error: 'neighborhood_viewport_too_dense' }];
  if (error?.type === 'entity.too.large' || error?.status === 413) return [413, { error: 'neighborhood_request_too_large' }];
  if (error?.type === 'entity.parse.failed') return [400, { error: 'invalid_neighborhood_request' }];
  const reason = error?.reason;
  if (reason === 'city_subject_outside_scope') return [422, { error: 'neighborhood_city_subject_outside_scope' }];
  if (error?.code === 'CUSTOM_CITY_DISCOVERY_INVALID') return [422, { error: 'neighborhood_city_source_unavailable' }];
  if (reason === 'authentication_required') return [401, { error: 'authentication_required' }];
  if (ACCESS_ERRORS.has(reason)) return [403, { error: 'neighborhood_access_denied' }];
  if (reason === 'context_unavailable' || reason === 'target_unavailable' || error?.message === 'account_not_found') {
    return [404, { error: 'neighborhood_context_unavailable' }];
  }
  if (CONFLICT_ERRORS.has(reason)) return [409, { error: `neighborhood_${reason}` }];
  // These are computed output/work ceilings, not malformed selection input.
  // Preserve the ceilings and return no partial rows or private diagnostics.
  // Input pocket/member-count validation continues to return HTTP 400 below.
  if (error instanceof TypeError && (PREVIEW_CAPACITY_ERRORS.has(error.message)
    || (error.code === 'CUSTOM_COHORT_PREVIEW_PRESENTATION_INVALID' && reason === 'output_bytes_limit'))) {
    return [422, { error: 'neighborhood_preview_capacity_exceeded' }];
  }
  if (INPUT_ERRORS.has(reason) || error?.message === 'invalid_account_id'
    || /^custom_cohort_context_(invalid_|input_limit)/.test(error?.message ?? '')
    || error?.code === 'CUSTOM_COHORT_PREVIEW_PRESENTATION_INVALID'
    || (error instanceof TypeError && /^(custom_cohort_observation_preview_|invalid_neighborhood_assessment:)/.test(error.message))) {
    return [400, { error: 'invalid_neighborhood_request' }];
  }
  if (UNAVAILABLE_ERRORS.has(reason)) {
    const diagnostic = customCaptureDiagnostic(error);
    if (diagnostic?.category === 'capacity') return [422, { error: 'neighborhood_capture_capacity_exceeded' }];
    if (diagnostic?.category === 'interrupted') return [503, { error: 'neighborhood_request_interrupted' }];
    return [422, { error: 'neighborhood_source_unavailable' }];
  }
  if (['cancelled', 'deadline_exceeded', 'connection_timeout', 'policy_timeout'].includes(reason)) {
    return [503, { error: 'neighborhood_request_interrupted' }];
  }
  return [500, { error: 'neighborhood_request_failed' }];
}

/** Dedicated Custom observation transport. Mount only inside the existing
 * authenticated/CSRF application boundary and only with an explicitly licensed
 * coordinator. This factory does not change global middleware or source policy.
 * The owner resolves and rechecks the exact organization/assignment in the DB.
 * Never supply its internal raw `.preview` method as `.present` here.
 */
export function createCustomNeighborhoodCohortRouter({ cohortService, marketAnalysis, landUseAnalysis, recordedGroupMarketAnalysis, logger = console,
  recordedGroupWorkspaceTransitions = false } = {}) {
  if (['capture', 'present', 'inspect', 'catalog'].some(key => typeof cohortService?.[key] !== 'function')) {
    throw new TypeError('custom_neighborhood_cohort_router_dependencies_required');
  }
  if (typeof recordedGroupWorkspaceTransitions !== 'boolean' || (recordedGroupWorkspaceTransitions
    && ['selectAndSaveRecordedGroups', 'startRecordedGroupCapture', 'cancelRecordedGroupCapture', 'completeRecordedGroupCapture']
      .some(key => typeof cohortService?.[key] !== 'function')))
    throw new TypeError('custom_neighborhood_group_workspace_router_dependencies_required');
  const router = express.Router();
  function route(action, fields, execute, optional = [], { bodyBytes = BODY_BYTES,
    prepareBody = value => value, presentResult = value => value, responseBytes = null } = {}) {
    const parse = express.json({ limit: bodyBytes, strict: true });
    router.post(`${BASE}/${action}`, (req, res, next) => {
      res.set('cache-control', 'no-store');
      if (typeof req.mobileAuth?.userId !== 'string' || !req.mobileAuth.userId.trim()) {
        return res.status(401).json({ error: 'authentication_required' });
      }
      return parse(req, res, next);
    }, async (req, res) => {
      const controller = new AbortController();
      const deadline = performance.now() + (action === 'capture'
        ? CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms : CUSTOM_COHORT_OPERATION_LIMITS.duration_ms);
      let releaseExecution;
      const abort = () => controller.abort();
      const closed = () => { if (!res.writableFinished) abort(); };
      req.once('aborted', abort); res.once('close', closed);
      try {
        const body = prepareBody(bodyOf(req.body, fields, optional, bodyBytes));
        const requested = req.params.id;
        if (typeof requested !== 'string' || !requested || requested.length > 64
          || requested.trim() !== requested || /[\u0000-\u001f\u007f]/.test(requested)) invalid();
        // The report supplies its exact canonical account ID. The coordinator
        // resolves that exact assignment/account in its bounded transaction.
        // Do not add unbounded alias/catalog DB reads outside that owner.
        const accountId = requested;
        if (controller.signal.aborted) return;
        // Principal is taken only from middleware. Never spread body into input.
        const identity = { auth: req.mobileAuth, accountId, assignmentFileId: body.assignment_file_id };
        releaseExecution = await customCohortExecutionGate.acquire({ signal: controller.signal, deadline });
        const result = presentResult(await execute(identity, body, { signal: controller.signal, deadline }), body, accountId);
        if (responseBytes !== null) {
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded, 'utf8') > responseBytes) throw new Error('neighborhood_selection_response_limit');
          if (!controller.signal.aborted && !res.destroyed) return res.type('application/json').send(encoded);
          return;
        }
        if (action === 'catalog' || action === 'viewport' || action === 'selection-viewport') {
          const encoded = JSON.stringify(result);
          const encodedBytes = Buffer.byteLength(encoded, 'utf8');
          const maximum = action === 'viewport' || action === 'selection-viewport' ? CUSTOM_COHORT_SELECTION_VIEWPORT_BYTES
            : Object.hasOwn(body, 'initial_preview_groups') || Object.hasOwn(body, 'initial_preview_mode')
              ? CUSTOM_COHORT_OPENING_RESPONSE_BYTES : CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes;
          if (encodedBytes > maximum) {
            const viewport = action !== 'catalog';
            throw Object.assign(new Error(viewport ? 'viewport_capacity_exceeded' : 'catalog_transport_limit'),
              { reason: viewport ? 'viewport_capacity_exceeded' : 'catalog_transport_limit' });
          }
          // Send the exact checked bytes: application-wide JSON indentation or
          // replacers must not expand an otherwise bounded catalog response.
          // Opening maps are often many megabytes of repeated GeoJSON keys and
          // coordinates. Prefer accepted Brotli for that map, retain gzip for
          // older clients, and never use compressed size to bypass the original
          // output ceiling.
          res.vary('Accept-Encoding');
          const encoding = req.acceptsEncodings('br', 'gzip');
          if (encodedBytes >= CATALOG_COMPRESSION_THRESHOLD_BYTES && encoding) {
            const packed = encoding === 'br'
              ? await compressCatalogBrotli(encoded, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
              : await compressCatalogGzip(encoded, { level: 1 });
            try { logger?.info?.(`[neighborhood] ${action}-transport`, {
              encoding, uncompressed_bytes: encodedBytes, response_bytes: packed.length,
            }); } catch { /* transport diagnostics cannot change the response */ }
            if (!controller.signal.aborted && !res.destroyed) return res.type('application/json')
              .set('Content-Encoding', encoding).send(packed);
          } else if (!controller.signal.aborted && !res.destroyed) {
            if (encodedBytes >= CATALOG_COMPRESSION_THRESHOLD_BYTES) {
              try { logger?.info?.(`[neighborhood] ${action}-transport`, {
                encoding: 'identity', uncompressed_bytes: encodedBytes, response_bytes: encodedBytes,
              }); } catch { /* transport diagnostics cannot change the response */ }
            }
            return res.type('application/json').send(encoded);
          }
        }
        if (!controller.signal.aborted && !res.destroyed) return res.json(result);
      } catch (error) {
        const readDiagnostic = customCohortReadDiagnostic(action, error);
        if (readDiagnostic) {
          try { logger?.warn?.('[neighborhood] read refused', readDiagnostic); } catch { /* logging cannot change recovery */ }
        }
        if (action === 'capture') {
          const diagnostic = customCaptureDiagnostic(error);
          if (diagnostic) {
            try { logger?.warn?.('[neighborhood] capture refused', diagnostic); } catch { /* logging cannot change recovery */ }
          }
        }
        if (!controller.signal.aborted && !res.destroyed) {
          const [status, payload] = publicFailure(error);
          if (error?.code === 'custom_cohort_execution_busy') res.set('retry-after', '5');
          return res.status(status).json(payload);
        }
      } finally {
        releaseExecution?.();
        req.removeListener('aborted', abort); res.removeListener('close', closed);
      }
    });
  }
  route('capture', ['assignment_file_id', 'operation_id', 'observation_period'], (identity, body, options) =>
    cohortService.capture({ ...identity, operationId: body.operation_id, observationPeriod: body.observation_period,
      ...(Object.hasOwn(body, 'private_sales_import') ? { privateSalesImport: body.private_sales_import } : {}),
      ...(Object.hasOwn(body, 'discovery') ? { discovery: body.discovery } : {}) }, options), ['private_sales_import', 'discovery']);
  // Do not activate half of a workspace migration. Only a composition owner
  // shipping the complete V7 browser lifecycle may explicitly enable this.
  // Existing browser/default composition and generic workfile writes stay put.
  if (recordedGroupWorkspaceTransitions) {
    for (const action of ['save-groups', 'start-group-capture', 'cancel-group-capture', 'complete-group-capture']) {
      const writing = action === 'save-groups' || action === 'complete-group-capture';
      route(action, ['assignment_file_id', 'expected_workspace_revision',
        ...(writing ? ['context_ref', 'operation_id', 'expected_selection_ref', 'included_recorded_group_ids'] : []),
        ...(action !== 'save-groups' ? ['expected_workspace_checkpoint'] : []), ...(action === 'start-group-capture' ? ['pending_capture'] : [])],
      (identity, body, options) => {
        const input = { ...identity, expectedWorkspaceRevision: body.expected_workspace_revision,
          ...(action !== 'save-groups' ? { expectedWorkspaceCheckpoint: body.expected_workspace_checkpoint } : {}) };
        if (writing) return cohortService[action === 'save-groups' ? 'selectAndSaveRecordedGroups' : 'completeRecordedGroupCapture']({
          ...input, contextRef: body.context_ref, operationId: body.operation_id,
          expectedSelectionRef: body.expected_selection_ref, includedRecordedGroupIds: body.included_recorded_group_ids }, options);
        return cohortService[action === 'start-group-capture' ? 'startRecordedGroupCapture' : 'cancelRecordedGroupCapture']({
          ...input, ...(action === 'start-group-capture' ? { pendingCapture: body.pending_capture } : {}) }, options);
      }, [], { bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES,
        prepareBody: body => prepareCustomCohortGroupWorkspaceTransportRequest(body, action),
        presentResult: (result, body) => presentCustomCohortGroupWorkspaceTransportResponse(result, body, action),
      });
    }
  }
  // Additive ID-only intent commands. Older owners omit both methods and keep
  // their route surface unchanged. These do not edit legacy workspace/Apply or
  // activate a paged-statistics/map consumer; those must bind the exact receipt.
  if (typeof cohortService.selectRecordedGroups === 'function'
    && typeof cohortService.readRecordedGroupSelection === 'function') {
    for (const writing of [false, true]) {
      route(writing ? 'select-groups' : 'group-selection', ['assignment_file_id', 'context_ref',
        ...(writing ? ['operation_id', 'expected_selection_ref', 'included_recorded_group_ids'] : [])],
      (identity, body, options) => writing
        ? cohortService.selectRecordedGroups({ ...identity, contextRef: body.context_ref,
          operationId: body.operation_id, expectedSelectionRef: body.expected_selection_ref,
          includedRecordedGroupIds: body.included_recorded_group_ids }, options)
        : cohortService.readRecordedGroupSelection({ ...identity, contextRef: body.context_ref }, options), [], {
        bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES,
        prepareBody: body => prepareCustomCohortRecordedGroupTransportRequest(body, writing),
        presentResult: (result, body) => presentCustomCohortRecordedGroupTransportResponse(result, body, writing),
      });
    }
  }
  if (typeof cohortService.previewRecordedGroupSelection === 'function') {
    route('selection-preview', ['assignment_file_id', 'context_ref', 'selection_ref'],
      (identity, body, options) => cohortService.previewRecordedGroupSelection({ ...identity,
        contextRef: body.context_ref, selectionRef: body.selection_ref }, options), [], {
        bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: CUSTOM_COHORT_GROUP_SUMMARY_RESPONSE_BYTES,
        prepareBody: prepareCustomCohortGroupSummaryTransportRequest,
        presentResult: presentCustomCohortGroupSummaryTransportResponse,
      });
  }
  if (typeof cohortService.openRecordedGroupSelectionMap === 'function') {
    route('selection-map-opening', ['assignment_file_id', 'context_ref', 'selection_ref'],
      (identity, body, options) => cohortService.openRecordedGroupSelectionMap({ ...identity,
        contextRef: body.context_ref, selectionRef: body.selection_ref }, options), [], {
        bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: CUSTOM_COHORT_GROUP_MAP_OPENING_RESPONSE_BYTES,
        prepareBody: prepareCustomCohortGroupMapOpeningTransportRequest,
        presentResult: presentCustomCohortGroupMapOpeningTransportResponse,
      });
  }
  if (typeof cohortService.viewportRecordedGroupSelection === 'function') {
    route('selection-viewport', ['assignment_file_id', 'context_ref', 'selection_ref', 'viewport'],
      (identity, body, options) => cohortService.viewportRecordedGroupSelection({ ...identity,
        contextRef: body.context_ref, selectionRef: body.selection_ref, viewport: body.viewport }, options), [], {
        bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES,
        prepareBody: prepareCustomCohortGroupViewportTransportRequest,
        presentResult: (result, body, accountId) => presentCustomCohortGroupViewportTransportResponse(result, body, accountId),
      });
  }
  if (typeof cohortService.inspectRecordedGroupSelection === 'function') {
    route('selection-members', ['assignment_file_id', 'context_ref', 'selection_ref', 'population', 'page'],
      (identity, body, options) => cohortService.inspectRecordedGroupSelection({ ...identity,
        contextRef: body.context_ref, selectionRef: body.selection_ref, population: body.population, page: body.page }, options), [], {
        bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: CUSTOM_COHORT_SELECTION_MEMBER_BYTES,
        prepareBody: prepareCustomCohortGroupMemberTransportRequest,
        presentResult: presentCustomCohortGroupMemberTransportResponse,
      });
  }
  route('preview', ['assignment_file_id', 'context_ref', 'selection', 'include_map'], (identity, body, options) => {
    if (typeof body.include_map !== 'boolean') invalid();
    return cohortService.present({ ...identity, contextRef: body.context_ref, selection: body.selection },
      { includeMap: body.include_map }, options);
  });
  if (typeof cohortService.viewport === 'function') {
    route('viewport', ['assignment_file_id', 'context_ref', 'selection', 'viewport'], (identity, body, options) =>
      cohortService.viewport({ ...identity, contextRef: body.context_ref, selection: body.selection }, body.viewport, options));
  }
  route('members', ['assignment_file_id', 'context_ref', 'selection', 'population', 'page'], (identity, body, options) =>
    cohortService.inspect({ ...identity, contextRef: body.context_ref, selection: body.selection },
      { population: body.population, page: body.page }, options));
  if (typeof marketAnalysis === 'function') route('market-analysis',
    ['assignment_file_id', 'context_ref', 'selection', 'selection_sha256', 'area_keys', 'as_of', 'period_months', 'context_override'],
    (identity, body, options) => marketAnalysis(identity, body, options));
  if (typeof landUseAnalysis === 'function') route('land-use',
    ['assignment_file_id', 'context_ref', 'selection', 'selection_sha256'],
    (identity, body, options) => landUseAnalysis(identity, body, options), [], { responseBytes: 32_000 });
  if (typeof recordedGroupMarketAnalysis === 'function') route('selection-market-analysis',
    ['assignment_file_id', 'context_ref', 'selection_ref', 'area_keys', 'as_of', 'period_months', 'context_override'],
    (identity, body, options) => recordedGroupMarketAnalysis(identity, body, options), [], {
      bodyBytes: CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, responseBytes: BODY_BYTES,
      prepareBody: prepareCustomCohortRecordedGroupMarketRequest,
    });
  route('catalog', ['assignment_file_id', 'context_ref', 'selection'], (identity, body, options) => {
    const versioned = Object.hasOwn(body, 'catalog_version');
    if (versioned && ![1, 2, 3].includes(body.catalog_version)) invalid();
    const requested = Object.hasOwn(body, 'include_recommendation');
    if (requested && typeof body.include_recommendation !== 'boolean') invalid();
    const modeRequested = Object.hasOwn(body, 'initial_preview_mode');
    if (modeRequested && Object.hasOwn(body, 'initial_preview_groups')) invalid();
    if (modeRequested) prepareCustomCohortOpeningMode(body.initial_preview_mode);
    const manifestOpening = Object.hasOwn(body, 'initial_map_mode');
    if (manifestOpening && (body.initial_map_mode !== 'manifest' || body.catalog_version !== 3
      || body.include_recommendation !== true || !(modeRequested || Object.hasOwn(body, 'initial_preview_groups')))) invalid();
    return cohortService.catalog({ ...identity, contextRef: body.context_ref, selection: body.selection,
      ...(versioned ? { catalogVersion: body.catalog_version } : {}),
      ...(Object.hasOwn(body, 'initial_preview_groups') ? { initialPreviewGroups: body.initial_preview_groups } : {}),
      ...(modeRequested ? { initialPreviewMode: body.initial_preview_mode } : {}),
      ...(manifestOpening ? { initialMapMode: body.initial_map_mode } : {}),
      ...(requested ? { includeRecommendation: body.include_recommendation } : {}) }, options);
  }, ['catalog_version', 'include_recommendation', 'initial_preview_groups', 'initial_preview_mode', 'initial_map_mode']);
  // Optional owner methods keep older/default-disabled composition unchanged.
  // Browser input identifies saved intent only; no assessment/member/source JSON.
  if (typeof cohortService.prepareReportedObservations === 'function') route('reported-proposal',
    ['assignment_file_id', 'context_ref', 'expected_workspace_revision', 'expected_editor_revision', 'operation_id'],
    (identity, body, options) => cohortService.prepareReportedObservations({ ...identity, contextRef: body.context_ref,
      expectedWorkspaceRevision: body.expected_workspace_revision, expectedEditorRevision: body.expected_editor_revision,
      operationId: body.operation_id,
      ...(Object.hasOwn(body, 'replacement') ? { replacement: body.replacement } : {}) }, options), ['replacement']);
  if (typeof cohortService.applyReportedObservations === 'function') route('reported-apply',
    ['assignment_file_id', 'context_ref', 'expected_workspace_revision', 'expected_editor_revision', 'operation_id',
      'proposal_operation_id', 'attachment_id', 'attachment_revision', 'binding_digest', 'adopt'],
    (identity, body, options) => cohortService.applyReportedObservations({ ...identity, contextRef: body.context_ref,
      expectedWorkspaceRevision: body.expected_workspace_revision, expectedEditorRevision: body.expected_editor_revision,
      operationId: body.operation_id, proposalOperationId: body.proposal_operation_id, attachmentId: body.attachment_id,
      attachmentRevision: body.attachment_revision, bindingDigest: body.binding_digest, adopt: body.adopt,
      ...(Object.hasOwn(body, 'replacement') ? { replacement: body.replacement } : {}) }, options), ['replacement']);
  router.use(BASE, (error, _req, res, _next) => {
    const [status, payload] = publicFailure(error);
    return res.status(status).json(payload);
  });
  return router;
}
