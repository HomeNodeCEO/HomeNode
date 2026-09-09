import { fetchJSON, makeUrl } from '@/lib/api';
import { matchCustomNeighborhoodAcceptedResponse, type AcceptedNeighborhoodState } from './customNeighborhoodAcceptedState';

export async function loadCustomNeighborhoodAccepted(accountId: string, assignmentFileId: number,
  section: unknown): Promise<AcceptedNeighborhoodState> {
  try {
    const response = await fetchJSON<unknown>(makeUrl(`/api/accounts/${encodeURIComponent(accountId)}/assignment-files/${assignmentFileId}/workfile/neighborhood`),
      { cache: 'no-store', retryTransient: false });
    return matchCustomNeighborhoodAcceptedResponse({ response, accountId, assignmentFileId, section });
  } catch {
    return { accountId, assignmentFileId, status: 'unavailable', assessment: null,
      message: 'The saved neighborhood could not be loaded. Reload the file to retry. No saved boundary or statistics have been replaced.' };
  }
}
