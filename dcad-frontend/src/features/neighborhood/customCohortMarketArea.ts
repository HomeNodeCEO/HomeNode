import type { MarketConditionsRequest, MarketConditionsResponse } from '@/lib/api';
import { runMarketConditionsAnalysis } from '@/lib/api';
import type { CustomCohortPreviewGroup, CustomCohortPreviewBinding } from './customCohortPreviewController';
import { requestCustomCohortOperation } from './customCohortPreviewApi';

export function usableExplorationArea(group: CustomCohortPreviewGroup | null, accountId: string, fileId: number | null) {
  return group && group.binding.accountId === accountId && group.binding.assignmentFileId === String(fileId) ? group : null;
}
export function explorationAreaIdentity(binding: CustomCohortPreviewBinding): string {
  const ref = binding.contextRef;
  return JSON.stringify([ref.context_id, ref.context_revision, ref.context_sha256,
    binding.selectionRevision, binding.selectionFingerprint]);
}
export function marketExplorationIdentity(response: MarketConditionsResponse): string | null {
  const binding = (response as MarketConditionsResponse & { exploration_binding?: {
    context_ref: CustomCohortPreviewBinding['contextRef']; selection_revision: number; selection_sha256: string;
  } }).exploration_binding;
  const ref = binding?.context_ref;
  return binding && ref && typeof ref.context_id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ref.context_id) && ref.context_revision === '1'
    && /^[a-f0-9]{64}$/.test(ref.context_sha256) && Number.isSafeInteger(binding.selection_revision)
    && binding.selection_revision > 0 && /^[a-f0-9]{64}$/.test(binding.selection_sha256)
    ? JSON.stringify([ref.context_id, ref.context_revision, ref.context_sha256,
      binding.selection_revision, binding.selection_sha256]) : null;
}

/** Reuse the bounded authenticated cohort route and the existing market-study
 * calculation. No polygon approximation, geometry upload, or fresh capture. */
export async function runExplorationMarketAnalysis(request: MarketConditionsRequest, group: CustomCohortPreviewGroup): Promise<MarketConditionsResponse> {
  if (!usableExplorationArea(group, request.subjectAccountId, request.assignmentFileId ?? null)) throw new Error('The exploration area belongs to a different appraisal file.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 65_000);
  try {
    const value = await requestCustomCohortOperation(group.binding.accountId, 'market-analysis', {
      assignment_file_id: group.binding.assignmentFileId, context_ref: group.binding.contextRef,
      selection: group.request.selection, selection_sha256: group.binding.selectionFingerprint,
      area_keys: request.areaKeys, as_of: request.asOf, period_months: request.periodMonths,
      context_override: request.contextOverride ?? null,
    }, { signal: abort.signal });
    const response = value as MarketConditionsResponse;
    if (!response || response.subject?.account_id !== group.binding.accountId
      || !Array.isArray(response.analyses) || !response.analyses.some(analysis => analysis.market?.key === 'exploration') || !response.recommendation
      || marketExplorationIdentity(response) !== explorationAreaIdentity(group.binding)) throw new Error('The market study does not match the selected exploration area.');
    return response;
  } catch (error) {
    if (abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error('Exploration Map Area took too long to calculate. ZIP and radius studies can still be run separately.');
    }
    throw error;
  } finally { clearTimeout(timer); }
}

/** Independent transports: a slow retained-area read must not cancel ZIP or
 * radius calculations. Neither path uses the report effective date as a cutoff;
 * asOf/periodMonths are the appraiser's chosen observation window. */
export async function runMarketStudies(request: MarketConditionsRequest, group: CustomCohortPreviewGroup | null): Promise<MarketConditionsResponse> {
  const ordinary = request.areaKeys.filter(key => key !== 'exploration');
  if (!request.areaKeys.includes('exploration')) return runMarketConditionsAnalysis(request);
  const exploration = () => group ? runExplorationMarketAnalysis({ ...request, areaKeys: ['exploration'] }, group)
    : Promise.reject(new Error('Select subdivisions on the exploration map before running that area.'));
  if (!ordinary.length) return exploration();
  const settled = await Promise.allSettled([
    runMarketConditionsAnalysis({ ...request, areaKeys: ordinary }), exploration(),
  ]);
  const responses = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  if (!responses.length) throw (settled[0] as PromiseRejectedResult).reason;
  const result = mergeMarketStudyResponses(responses);
  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') for (const key of index === 0 ? ordinary : ['exploration'] as const) {
      result.unavailable_areas.push({ key, label: key === 'exploration' ? 'Exploration Map Area' : key.replace('_', ' '),
        reason: outcome.reason instanceof Error ? outcome.reason.message : 'This market area could not be calculated.' });
    }
  });
  return result;
}

/** Same mean/median reconciliation as the existing server calculator for the
 * displayed ZIP/radius/city/exploration studies (the old polygon is not offered).
 * Do not average per-area medians or combine overlapping sale populations. */
export function mergeMarketStudyResponses(responses: MarketConditionsResponse[]): MarketConditionsResponse {
  const analyses = responses.flatMap(response => response.analyses);
  const meanDispersion = (analysis: MarketConditionsResponse['analyses'][number]) => {
    const { composite_cod: cod, composite_cv: cv } = analysis.statistics;
    return cod != null && cv != null && Number.isFinite(cod) && Number.isFinite(cv) && cod >= 0 && cv >= 0
      ? (cod + cv) / 2 : Infinity;
  };
  const ranked = analyses.filter(analysis => analysis.statistics.annualized_change_percent !== null
    && Number.isFinite(analysis.statistics.annualized_change_percent))
    .sort((left, right) => Number(right.statistics.reliability_score || 0) - Number(left.statistics.reliability_score || 0)
      || meanDispersion(left) - meanDispersion(right)
      || right.population.eligible_sale_count - left.population.eligible_sale_count);
  const changes = ranked.map(analysis => Number(analysis.statistics.annualized_change_percent));
  const sorted = [...changes].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const mean = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null;
  const median = changes.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
  const change = mean === null || median === null ? null : (mean + median) / 2;
  const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;
  // Carry the exact exploration context/selection identity, never manufacture it
  // for a failed request or borrow it from another report.
  const base = responses.find(response => marketExplorationIdentity(response)) || responses[0];
  return { ...base, analyses, unavailable_areas: responses.flatMap(response => response.unavailable_areas),
    recommendation: { methodology_version: Math.min(...responses.map(response => response.recommendation.methodology_version ?? 2)), weighting_method: 'mean_median_reconciliation',
      appraiser_defined_area_weight_percent: 0, stable_threshold_percent: 1,
      conclusion: change === null ? 'insufficient' : Math.abs(change) < 1 ? 'stable' : change > 0 ? 'increasing' : 'decreasing',
      average_annualized_change_percent: round(mean), median_annualized_change_percent: round(median), recommended_change_percent: round(change),
      ranked_studies: ranked.map((analysis, index) => ({ rank: index + 1, key: analysis.market.key, label: analysis.market.label,
        reliability_score: analysis.statistics.reliability_score, reconciliation_weight_percent: null,
        sale_count: analysis.population.eligible_sale_count, sample_sufficient: analysis.statistics.sample_sufficient,
        annualized_change_percent: analysis.statistics.annualized_change_percent, composite_cod: analysis.statistics.composite_cod,
        composite_cv: analysis.statistics.composite_cv })) } };
}
