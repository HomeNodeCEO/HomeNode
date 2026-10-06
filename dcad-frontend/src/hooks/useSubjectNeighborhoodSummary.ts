import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AppraisalAssignmentFile, AssignmentDetailsPayload } from '@/lib/api';
import type { DcadDetail } from '@/lib/propertyReportEditableSections';
import { buildSubjectNeighborhoodSummary, legacySubjectNeighborhoodSummary } from '@/lib/subjectNeighborhoodSummary';
import { NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS } from '@/lib/neighborhoodSummaryTemplate';
import { useNearbySchool } from './useNearbySchool';

/** Seeds one editable file draft only when the saved file has no narrative.
 * Reopening or signing a file never regenerates appraiser-authored text. */
export function useSubjectSummary(
  accountId: string | undefined,
  file: AppraisalAssignmentFile | null,
  location: DcadDetail['property_location'] | undefined,
  yearBuilt: number | null,
  housingType: string | null | undefined,
  setDraft: Dispatch<SetStateAction<AssignmentDetailsPayload>>,
  draft: AssignmentDetailsPayload,
  setDirty: Dispatch<SetStateAction<boolean>>,
) {
  const initialized = useRef<string | null>(null);
  const school = useNearbySchool(accountId, file?.id, file?.workfile?.status === 'draft', draft.subject_neighborhood_summary_school);
  useEffect(() => {
    const saved = draft.subject_neighborhood_summary_school;
    if (!school || file?.workfile?.status !== 'draft' || (saved?.captured_at === school.captured_at
      && saved.account_id === school.account_id && saved.assignment_file_id === school.assignment_file_id)) return;
    setDraft(current => ({ ...current, subject_neighborhood_summary_school: school })); setDirty(true);
  }, [school, file?.workfile?.status, draft.subject_neighborhood_summary_school, setDraft, setDirty]);
  useEffect(() => {
    if (!accountId || !file || !location || file.workfile?.status !== 'draft') return;
    const key = `${accountId}:${file.id}`;
    if (initialized.current === key) return;
    initialized.current = key;
    const input = {
      address: location.address, subdivision: location.subdivision,
      neighborhood: location.neighborhood, city: location.city, county: location.county,
      yearBuilt, housingType, effectiveDate: file.effective_date,
      locationType: file.assignment_details?.neighborhood_location_type,
    };
    const previous = file.assignment_details?.subject_neighborhood_summary;
    if (previous && previous !== legacySubjectNeighborhoodSummary(input)) return;
    const summary = buildSubjectNeighborhoodSummary(input);
    setDraft(current => current.subject_neighborhood_summary && current.subject_neighborhood_summary !== previous ? current
      : { ...current, subject_neighborhood_summary: summary, subject_neighborhood_summary_template: summary,
        subject_neighborhood_summary_review_items: [...NEIGHBORHOOD_TEMPLATE_REVIEW_ITEMS] });
    setDirty(true);
  }, [accountId, file, location, yearBuilt, housingType, setDraft, setDirty]);
  return {
    summaryTemplate: draft.subject_neighborhood_summary_template,
    summaryReadOnly: file?.workfile?.status !== 'draft',
    summaryInput: { subdivision: location?.subdivision, city: location?.city,
      effectiveDate: file?.effective_date, locationType: draft.neighborhood_location_type,
      // Do not turn a later-year campus dataset into a retrospective school fact.
      nearbySchool: school && Number(file?.effective_date?.slice(0, 4)) >= Number(school.source.school_year.slice(-4)) ? school.school.name : null },
    onGeneratedSummary: (value: string, reviewItems: readonly string[]) => {
      setDraft(current => ({ ...current, subject_neighborhood_summary: value,
        subject_neighborhood_summary_template: value, subject_neighborhood_summary_review_items: [...reviewItems] }));
      setDirty(true);
    },
    onLocationTypeChange: (value: string) => {
      setDraft(current => ({ ...current, neighborhood_location_type: value })); setDirty(true);
    },
  };
}
