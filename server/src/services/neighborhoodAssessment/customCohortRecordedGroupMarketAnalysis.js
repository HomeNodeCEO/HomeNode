import { types } from 'node:util';
import { buildMarketConditionsAnalyses, normalizeMarketAnalysisRequest } from '../marketConditions.js';
import { MARKET_ANALYSIS_PUBLIC_ERRORS } from '../../modules/sales/studyPublicErrors.js';
import { isNeighborhoodProfileBusyError, runNeighborhoodProfileOperation } from '../neighborhoodProfileExecution.js';
import { canonicalAssessmentJson as json } from './contract.js';
import { CUSTOM_COHORT_GROUP_TRANSPORT_BYTES, prepareCustomCohortGroupSummaryTransportRequest }
  from './customCohortRecordedGroupTransport.js';

const fields = ['assignment_file_id', 'context_ref', 'selection_ref', 'area_keys', 'as_of', 'period_months', 'context_override'];
const overrideFields = ['source', 'address', 'city', 'county', 'review_note', 'postal_code',
  'source_account_id', 'latitude', 'longitude'];
function fail(reason = 'invalid_input') { throw Object.assign(new Error(reason), { reason }); }
function own(value, keys, optional = false) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !keys.includes(key))
    || (!optional && Reflect.ownKeys(value).length !== keys.length)) fail();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}
const scalar = value => value === null || (typeof value === 'string' && value.length <= 1000)
  || (typeof value === 'number' && Number.isFinite(value));

/** Closed, detached syntax only. It supplies no catalog, member list, actor,
 * viewport, geometry or source permission. The chosen study window remains
 * independent of the retained appraisal effective date, as in the legacy path. */
export function prepareCustomCohortRecordedGroupMarketRequest(body) {
  const value = own(body, fields);
  const selected = prepareCustomCohortGroupSummaryTransportRequest({ assignment_file_id: value.assignment_file_id,
    context_ref: value.context_ref, selection_ref: value.selection_ref });
  const areas = value.area_keys;
  if (!Array.isArray(areas) || types.isProxy(areas) || areas.length < 1 || areas.length > 10
    || Reflect.ownKeys(areas).length !== areas.length + 1) fail();
  const area_keys = [];
  for (let index = 0; index < areas.length; index++) {
    const d = Object.getOwnPropertyDescriptor(areas, String(index));
    if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'string' || d.value.length > 20) fail();
    area_keys.push(d.value);
  }
  if (typeof value.as_of !== 'string' || value.as_of.length > 10 || ![12, 24, 36].includes(value.period_months)) fail();
  const context_override = value.context_override === null ? null : own(value.context_override, overrideFields, true);
  if (context_override && !Object.values(context_override).every(scalar)) fail();
  const request = Object.freeze({ ...selected, area_keys: Object.freeze(area_keys), as_of: value.as_of,
    period_months: value.period_months, context_override: context_override && Object.freeze(context_override) });
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > CUSTOM_COHORT_GROUP_TRANSPORT_BYTES) fail();
  return request;
}

/** Exact-reference adapter. Reuse the established closed-sale calculator;
 * neither recompute geometry nor fabricate a legacy pocket/member request. */
export function createCustomCohortRecordedGroupMarketAnalysis({ pool, cohortService,
  buildAnalyses = buildMarketConditionsAnalyses, run = runNeighborhoodProfileOperation } = {}) {
  if (typeof cohortService?.authorizeRecordedGroupMarketSelection !== 'function'
    || typeof buildAnalyses !== 'function' || typeof run !== 'function')
    throw new TypeError('custom_cohort_recorded_group_market_dependencies_required');
  return async (identity, body, options) => {
    const pinned = prepareCustomCohortRecordedGroupMarketRequest(body);
    if (pinned.assignment_file_id !== identity.assignmentFileId) fail();
    const live = () => {
      if (!(options?.signal instanceof AbortSignal) || !Number.isFinite(options.deadline)) fail();
      if (options.signal.aborted) fail('cancelled');
      if (performance.now() >= options.deadline) fail('deadline_exceeded');
    };
    live();
    try {
      const request = normalizeMarketAnalysisRequest({ subjectAccountId: identity.accountId,
        areaKeys: pinned.area_keys, asOfDate: pinned.as_of, periodMonths: pinned.period_months,
        marketContextOverride: pinned.context_override });
      if (!request.areaKeys.includes('exploration') || request.areaKeys.includes('custom')) fail();
      const input = { ...identity, contextRef: pinned.context_ref, selectionRef: pinned.selection_ref };
      const authorize = () => cohortService.authorizeRecordedGroupMarketSelection(input, options);
      const expectedBinding = { context_ref: pinned.context_ref,
        selection_revision: pinned.selection_ref.selection_revision, selection_sha256: pinned.selection_ref.selection_sha256 };
      const expectedTarget = { account_id: identity.accountId, assignment_file_id: identity.assignmentFileId };
      const matches = value => value && json(value.selection_ref) === json(pinned.selection_ref)
        && json(value.binding) === json(expectedBinding) && json(value.target) === json(expectedTarget)
        && Array.isArray(value.accountIds) && Object.isFrozen(value.accountIds);
      const checked = await authorize(); live();
      if (!matches(checked)) fail('operation_conflict');
      const accounts = checked.accountIds;
      const key = JSON.stringify({ operation: 'recorded_group_exploration_market', target: expectedTarget,
        context_ref: pinned.context_ref, selection_ref: pinned.selection_ref, request });
      const response = await run(key, () => buildAnalyses(pool, { ...request, explorationAccountIds: accounts }),
        { allowCached: false, cacheResult: false });
      live();
      // The sales query has a separate bounded owner. Reopen CURRENT rights and
      // the whole exact original again before publishing, not just its digest.
      const latest = await authorize(); live();
      if (!matches(latest) || latest.accountIds.length !== accounts.length
        || latest.accountIds.some((id, index) => id !== accounts[index])) fail('operation_conflict');
      return { ...response, exploration_binding: checked.binding, exploration_selection_ref: checked.selection_ref };
    } catch (error) {
      if (MARKET_ANALYSIS_PUBLIC_ERRORS.has(error.message)) error.reason = 'invalid_input';
      if (isNeighborhoodProfileBusyError(error.message)) error.code = 'custom_cohort_execution_busy';
      throw error;
    }
  };
}
