import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AppraisalAssignmentFile, AssignmentDetailsPayload } from '@/lib/api';
import type { DcadDetail } from '@/lib/propertyReportEditableSections';
import { buildSubjectNeighborhoodSummary } from '@/lib/subjectNeighborhoodSummary';

/** Seeds one editable file draft only when the saved file has no narrative.
 * Reopening or signing a file never regenerates appraiser-authored text. */
export function useSubjectSummary(
  accountId: string | undefined,
  file: AppraisalAssignmentFile | null,
  location: DcadDetail['property_location'] | undefined,
  yearBuilt: number | null,
  housingType: string | null | undefined,
  setDraft: Dispatch<SetStateAction<AssignmentDetailsPayload>>,
) {
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId || !file || !location || file.workfile?.status === 'signed') return;
    const key = `${accountId}:${file.id}`;
    if (initialized.current === key) return;
    initialized.current = key;
    if (typeof file.assignment_details?.subject_neighborhood_summary === 'string') return;
    const summary = buildSubjectNeighborhoodSummary({
      address: location.address, subdivision: location.subdivision,
      neighborhood: location.neighborhood, city: location.city, county: location.county,
      yearBuilt, housingType, effectiveDate: file.effective_date,
    });
    setDraft(current => current.subject_neighborhood_summary ? current
      : { ...current, subject_neighborhood_summary: summary });
  }, [accountId, file, location, yearBuilt, housingType, setDraft]);
}
