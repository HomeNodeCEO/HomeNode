import { buildMarketConditionsAnalyses, normalizeMarketAnalysisRequest } from '../marketConditions.js';
import { MARKET_ANALYSIS_PUBLIC_ERRORS } from '../../modules/sales/studyPublicErrors.js';
import { isNeighborhoodProfileBusyError, runNeighborhoodProfileOperation } from '../neighborhoodProfileExecution.js';

/** Selected-roster adapter only. Reuse retained membership authorization and
 * numeric cache, then the established closed-sale study/series calculation.
 * It never captures data, draws geometry, or changes the saved/report selection. */
export function createCustomCohortMarketAnalysis({ pool, cohortService, buildAnalyses = buildMarketConditionsAnalyses,
  run = runNeighborhoodProfileOperation } = {}) {
  return async (identity, body, options) => {
    let request;
    try {
      request = normalizeMarketAnalysisRequest({ subjectAccountId: identity.accountId,
        areaKeys: body.area_keys, asOfDate: body.as_of, periodMonths: body.period_months,
        marketContextOverride: body.context_override });
      if (!request.areaKeys.includes('exploration') || request.areaKeys.includes('custom')
        || typeof body.selection_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.selection_sha256)) {
        throw Object.assign(new Error('invalid_input'), { reason: 'invalid_input' });
      }
    } catch (error) {
      if (MARKET_ANALYSIS_PUBLIC_ERRORS.has(error.message)) error.reason = 'invalid_input';
      throw error;
    }
    const input = { ...identity, contextRef: body.context_ref, selection: body.selection };
    const checked = await cohortService.present(input, { includeMap: false }, options);
    const binding = checked.summary?.binding;
    if (!binding || binding.selection_sha256 !== body.selection_sha256) {
      throw Object.assign(new Error('operation_conflict'), { reason: 'operation_conflict' });
    }
    // The presentation owner has already checked that every requested account
    // belongs to this exact retained context, including overlap/empty semantics.
    const accounts = [...new Set(body.selection.pockets.flatMap(pocket => pocket.account_ids))].sort();
    const key = JSON.stringify({ operation: 'exploration_market', target: checked.target,
      binding, request });
    if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    try {
      const response = await run(key, () => buildAnalyses(pool, { ...request, explorationAccountIds: accounts }),
        { allowCached: false, cacheResult: false });
      if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
      // The numeric query runs outside the retained-context read transaction.
      // Recheck access before publishing, using the same geometry-free cache.
      const latest = await cohortService.present(input, { includeMap: false }, options);
      if (latest.summary?.binding?.selection_sha256 !== binding.selection_sha256) {
        throw Object.assign(new Error('operation_conflict'), { reason: 'operation_conflict' });
      }
      return { ...response, exploration_binding: binding };
    } catch (error) {
      if (MARKET_ANALYSIS_PUBLIC_ERRORS.has(error.message)) error.reason = 'invalid_input';
      if (isNeighborhoodProfileBusyError(error.message)) error.code = 'custom_cohort_execution_busy';
      throw error;
    }
  };
}
