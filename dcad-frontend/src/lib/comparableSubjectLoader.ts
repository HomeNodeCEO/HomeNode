import * as api from './api';
import { fetchDetail } from './dcad';
import { mapAccountDetailToLegacy } from './legacyDcadDetail';
import {
  accountNeedsRoomRefresh,
  mergeSubjectData,
  subjectFromAccountResponse,
  subjectFromDetailResponse,
  type SubjectData,
} from './comparableSubjectData';

type SubjectUpdate = SubjectData | ((current: SubjectData | null) => SubjectData);

// Keep the DB result visible while optional legacy fields are enriched. The
// scraper request remains a compatibility fallback until a queued repair API
// can replace it without changing the first-load behavior.
export async function loadComparableSubject(
  propertyId: string,
  assignmentFileId: number | undefined,
  scraperBase: string,
  updateSubject: (update: SubjectUpdate) => void,
  onInitialSubject: () => void,
): Promise<void> {
  try {
    const accountResponse = await api.getAccount(propertyId, { assignmentFileId });
    updateSubject(subjectFromAccountResponse(accountResponse, propertyId));
    onInitialSubject();

    try {
      // Derive compatibility fields from the same assignment-scoped response.
      const legacyResponse = mapAccountDetailToLegacy(accountResponse);
      const legacySubject = subjectFromDetailResponse(legacyResponse, propertyId);
      updateSubject((current) => mergeSubjectData(current, legacySubject, propertyId));
    } catch { /* optional compatibility enrichment failed; keep the DB response */ }

    if (accountNeedsRoomRefresh(accountResponse)) {
      try {
        const response = await fetch(
          `${scraperBase}/detail/${encodeURIComponent(propertyId)}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (response.ok) {
          const payload: unknown = await response.json();
          const scraperSubject = subjectFromDetailResponse(
            payload,
            propertyId,
            { derivePool: true },
          );
          updateSubject((current) => mergeSubjectData(current, scraperSubject, propertyId));
        }
      } catch { /* optional scraper enrichment failed; keep the DB response */ }
    }
    return;
  } catch {
    // Fall through to compatibility detail only when the DB path failed.
  }

  const legacyResponse = await fetchDetail(propertyId, 1, { assignmentFileId });
  updateSubject(subjectFromDetailResponse(legacyResponse, propertyId));
}
