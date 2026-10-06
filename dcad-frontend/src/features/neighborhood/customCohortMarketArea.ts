import type { MarketConditionsRequest, MarketConditionsResponse } from '@/lib/api';
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
  } finally { clearTimeout(timer); }
}
