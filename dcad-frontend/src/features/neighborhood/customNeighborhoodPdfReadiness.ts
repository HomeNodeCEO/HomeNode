import type { AssignmentDetailsPayload } from '../../lib/api';
import { neighborhoodBoundaryReadinessErrors } from '../../lib/neighborhoodCharacteristics.ts';
import type { AcceptedNeighborhoodState } from './customNeighborhoodAcceptedState';

const unavailable = 'The saved neighborhood could not be verified for this appraisal file. Reload the file before continuing.';
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Select only neighborhood UI blockers, never report/signing authority. The
 * accepted state must come from the existing exact section/receipt matcher, not
 * a raw workfile section. The server independently checks its saved originals.
 */
export function customNeighborhoodPdfReadinessErrors(state: AcceptedNeighborhoodState | null,
  accountId: string | undefined, assignmentFileId: number | null | undefined,
  details: AssignmentDetailsPayload | null | undefined): string[] {
  if (!accountId || !Number.isSafeInteger(assignmentFileId) || Number(assignmentFileId) < 1
      || !state || state.accountId !== accountId || state.assignmentFileId !== assignmentFileId) return [unavailable];
  if (state.status === 'loading') return ['Wait for the saved neighborhood check to finish before continuing.'];
  if (state.status === 'signed') return []; // Exact workfile load; the server serves its immutable signed artifact.
  if (state.status === 'legacy') return neighborhoodBoundaryReadinessErrors(details);
  if (state.status !== 'accepted') return [unavailable];
  const assessment = record(state.assessment), scope = record(assessment?.scope);
  if ((assessment?.contract_version !== 1 && assessment?.contract_version !== 2) || scope?.account_id !== accountId
      || record(assessment?.geographic_neighborhood)?.status !== 'ready'
      || record(assessment?.application_group)?.status !== 'ready') return [unavailable];
  return [];
}

/** This legacy HTML preview does not render the accepted group. Its browser
 * print path must not be confused with the independently checked server PDF.
 */
export function customNeighborhoodBrowserPrintReadinessErrors(state: AcceptedNeighborhoodState | null,
  accountId: string | undefined, assignmentFileId: number | null | undefined,
  details: AssignmentDetailsPayload | null | undefined): string[] {
  const pdfErrors = customNeighborhoodPdfReadinessErrors(state, accountId, assignmentFileId, details);
  if (pdfErrors.length) return pdfErrors;
  if (state?.status === 'accepted') return ['Download the PDF for the accepted neighborhood group; this HTML preview does not contain that group.'];
  if (state?.status === 'signed') return ['Download the immutable signed PDF; this HTML preview is not the signed report.'];
  return neighborhoodBoundaryReadinessErrors(details);
}
