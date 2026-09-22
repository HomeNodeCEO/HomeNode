import {
  fetchJSON,
  makeUrl,
  type PreviousAppraisalFilesResponse,
} from '@/lib/api';

export async function getPreviousAppraisalFiles(
  accountId: string,
  cursor?: string | null,
): Promise<PreviousAppraisalFilesResponse> {
  return fetchJSON<PreviousAppraisalFilesResponse>(
    makeUrl(
      `/api/accounts/${encodeURIComponent(String(accountId || '').trim())}/appraisal-history`,
      { cursor: cursor || undefined },
    ),
  );
}
