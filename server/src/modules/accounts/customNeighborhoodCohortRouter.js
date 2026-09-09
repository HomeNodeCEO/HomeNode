import express from 'express';
import { CUSTOM_COHORT_POCKET_CATALOG_LIMITS } from '../../services/neighborhoodAssessment/customCohortPocketCatalog.js';

const BASE = '/api/accounts/:id/neighborhood-cohort';
const BODY_BYTES = 4_000_000;
const FILE_ID = /^[1-9]\d{0,18}$/;
const INPUT_ERRORS = new Set(['invalid_input', 'invalid_account', 'invalid_assignment',
  'invalid_operation', 'invalid_period', 'invalid_selection', 'period_after_effective_date']);
const ACCESS_ERRORS = new Set(['assignment_access_denied', 'market_data_access_denied']);
const CONFLICT_ERRORS = new Set(['operation_conflict', 'subject_changed', 'target_changed', 'market_policy_changed']);
const UNAVAILABLE_ERRORS = new Set(['recorded_point_required', 'spatial_incomplete',
  'selector_incomplete', 'transaction_identity_incomplete', 'source_incomplete', 'retained_inputs_unavailable']);

function invalid() { throw Object.assign(new Error('invalid_input'), { reason: 'invalid_input' }); }
function bodyOf(body, required, optional = []) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype
    || !required.every(key => Object.hasOwn(body, key))
    || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_BYTES) {
    throw Object.assign(new Error('request_too_large'), { status: 413 });
  }
  if (typeof body.assignment_file_id !== 'string' || !FILE_ID.test(body.assignment_file_id)
    || BigInt(body.assignment_file_id) > 9223372036854775807n) invalid();
  return body;
}
function publicFailure(error) {
  if (error?.reason === 'catalog_transport_limit') return [422, { error: 'neighborhood_catalog_incomplete',
    reason: 'catalog_response_byte_limit', membership_returned: false }];
  if (error?.outcome_unknown) return [409, { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true }];
  if (error?.type === 'entity.too.large' || error?.status === 413) return [413, { error: 'neighborhood_request_too_large' }];
  if (error?.type === 'entity.parse.failed') return [400, { error: 'invalid_neighborhood_request' }];
  const reason = error?.reason;
  if (reason === 'authentication_required') return [401, { error: 'authentication_required' }];
  if (ACCESS_ERRORS.has(reason)) return [403, { error: 'neighborhood_access_denied' }];
  if (reason === 'context_unavailable' || reason === 'target_unavailable' || error?.message === 'account_not_found') {
    return [404, { error: 'neighborhood_context_unavailable' }];
  }
  if (CONFLICT_ERRORS.has(reason)) return [409, { error: `neighborhood_${reason}` }];
  if (INPUT_ERRORS.has(reason) || error?.message === 'invalid_account_id'
    || /^custom_cohort_context_(invalid_|input_limit)/.test(error?.message ?? '')
    || error?.code === 'CUSTOM_COHORT_PREVIEW_PRESENTATION_INVALID'
    || (error instanceof TypeError && /^(custom_cohort_observation_preview_|invalid_neighborhood_assessment:)/.test(error.message))) {
    return [400, { error: 'invalid_neighborhood_request' }];
  }
  if (UNAVAILABLE_ERRORS.has(reason)) return [422, { error: 'neighborhood_source_unavailable' }];
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
export function createCustomNeighborhoodCohortRouter({ cohortService } = {}) {
  if (['capture', 'present', 'inspect', 'catalog'].some(key => typeof cohortService?.[key] !== 'function')) {
    throw new TypeError('custom_neighborhood_cohort_router_dependencies_required');
  }
  const router = express.Router();
  const parse = express.json({ limit: BODY_BYTES, strict: true });
  function route(action, fields, execute, optional = []) {
    router.post(`${BASE}/${action}`, (req, res, next) => {
      res.set('cache-control', 'no-store');
      if (typeof req.mobileAuth?.userId !== 'string' || !req.mobileAuth.userId.trim()) {
        return res.status(401).json({ error: 'authentication_required' });
      }
      return parse(req, res, next);
    }, async (req, res) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const closed = () => { if (!res.writableFinished) abort(); };
      req.once('aborted', abort); res.once('close', closed);
      try {
        const body = bodyOf(req.body, fields, optional);
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
        const result = await execute(identity, body, { signal: controller.signal });
        if (action === 'catalog') {
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded, 'utf8') > CUSTOM_COHORT_POCKET_CATALOG_LIMITS.transport_output_utf8_bytes) {
            throw Object.assign(new Error('catalog_transport_limit'), { reason: 'catalog_transport_limit' });
          }
          // Send the exact checked bytes: application-wide JSON indentation or
          // replacers must not expand an otherwise bounded catalog response.
          if (!controller.signal.aborted && !res.destroyed) return res.type('application/json').send(encoded);
        }
        if (!controller.signal.aborted && !res.destroyed) return res.json(result);
      } catch (error) {
        if (!controller.signal.aborted && !res.destroyed) {
          const [status, payload] = publicFailure(error);
          return res.status(status).json(payload);
        }
      } finally {
        req.removeListener('aborted', abort); res.removeListener('close', closed);
      }
    });
  }
  route('capture', ['assignment_file_id', 'operation_id', 'observation_period'], (identity, body, options) =>
    cohortService.capture({ ...identity, operationId: body.operation_id, observationPeriod: body.observation_period }, options));
  route('preview', ['assignment_file_id', 'context_ref', 'selection', 'include_map'], (identity, body, options) => {
    if (typeof body.include_map !== 'boolean') invalid();
    return cohortService.present({ ...identity, contextRef: body.context_ref, selection: body.selection },
      { includeMap: body.include_map }, options);
  });
  route('members', ['assignment_file_id', 'context_ref', 'selection', 'population', 'page'], (identity, body, options) =>
    cohortService.inspect({ ...identity, contextRef: body.context_ref, selection: body.selection },
      { population: body.population, page: body.page }, options));
  route('catalog', ['assignment_file_id', 'context_ref', 'selection'], (identity, body, options) => {
    const requested = Object.hasOwn(body, 'include_recommendation');
    if (requested && typeof body.include_recommendation !== 'boolean') invalid();
    return cohortService.catalog({ ...identity, contextRef: body.context_ref, selection: body.selection,
      ...(requested ? { includeRecommendation: body.include_recommendation } : {}) }, options);
  }, ['include_recommendation']);
  router.use(BASE, (error, _req, res, _next) => {
    const [status, payload] = publicFailure(error);
    return res.status(status).json(payload);
  });
  return router;
}
