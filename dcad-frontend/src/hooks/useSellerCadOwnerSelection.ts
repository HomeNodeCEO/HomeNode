import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { AppraisalAssignmentFile, AssignmentDetailsPayload } from '@/lib/api';
import { sellerComparisonSummary } from '@/lib/propertyReportPresentation';

type Source = { fileId: number; seller: string; cadOwner: string };

/** Populate the saved Contract answer from the report's CAD owner observation.
 * A changed contract/CAD name is new evidence; an explained appraiser choice on
 * unchanged evidence survives reload. The draft's ordinary autosave persists it. */
export function useSellerCadOwnerSelection({ file, filesLoaded, seller, cadOwnerNames,
  draftRef, setDraft }: {
  file: AppraisalAssignmentFile | null;
  filesLoaded: boolean;
  seller: string;
  cadOwnerNames: string[];
  draftRef: MutableRefObject<AssignmentDetailsPayload>;
  setDraft: Dispatch<SetStateAction<AssignmentDetailsPayload>>;
}) {
  const cadOwnerKey = cadOwnerNames.join('\u001f');
  const comparison = sellerComparisonSummary(seller, cadOwnerNames);
  const lastSource = useRef<Source | null>(null);
  useEffect(() => {
    if (!file || !filesLoaded || file.workfile?.status === 'signed' || file.workfile?.status === 'archived') return;
    const prior = lastSource.current;
    // Do not compare a previous file's draft before the selected one hydrates.
    if (prior?.fileId !== file.id && seller !== (file.assignment_details?.contract_seller_names || '')) return;
    if (prior?.fileId === file.id && prior.seller === seller && prior.cadOwner === cadOwnerKey) return;
    const sourceChanged = prior?.fileId === file.id &&
      (prior.seller !== seller || prior.cadOwner !== cadOwnerKey);
    lastSource.current = { fileId: file.id, seller, cadOwner: cadOwnerKey };
    const suggested = comparison.matches;
    if (suggested === null) return;
    const current = draftRef.current;
    if (current.seller_matches_public_records === suggested ||
        (!sourceChanged && typeof current.seller_matches_public_records === 'boolean'
          && Boolean(current.seller_mismatch_explanation))) return;
    setDraft((draft) => draft.contract_seller_names !== seller ||
      draft.seller_matches_public_records === suggested ? draft : {
        ...draft,
        seller_matches_public_records: suggested,
        ...(suggested ? { seller_mismatch_explanation: '' } : {}),
      });
  }, [file, filesLoaded, seller, cadOwnerKey, comparison.matches, draftRef, setDraft]);
  return comparison;
}
