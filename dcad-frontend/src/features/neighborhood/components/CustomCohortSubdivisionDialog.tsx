import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustomCohortSubdivisionFamily, CustomCohortSubdivisionFamilies } from '../customCohortSubdivisionFamilies';
import { buildCustomCohortSubdivisionPhases } from '../customCohortSubdivisionFamilies';
import { buildCustomCohortSubdivisionInspection } from '../customCohortSubdivisionInspection';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomCohortPreviewInput, CustomCohortPreviewGroup } from '../customCohortPreviewController';
import { buildCustomCohortSubdivisionFamilyLocationReview } from '../customCohortSubdivisionLocationReview';
import type { requestCustomCohortObservationPreview } from '../customCohortPreviewApi';
import type { CustomCohortMemberTransport } from '../customCohortPreviewTransport';
import CustomCohortPocketInspector from './CustomCohortPocketInspector';

interface Props {
  family: CustomCohortSubdivisionFamily; catalog: CheckedPocketCatalog; input: CustomCohortPreviewInput;
  families?: CustomCohortSubdivisionFamilies; mapGroup?: CustomCohortPreviewGroup | null;
  included: readonly string[]; phaseId: string | null; selectionDisabled: boolean; inspectionsPaused: boolean;
  previewTransport: typeof requestCustomCohortObservationPreview; memberTransport?: CustomCohortMemberTransport;
  onInclude: (ids: readonly string[]) => void; onExclude: (ids: readonly string[]) => void;
  onInspectPhase: (id: string | null) => void; onClose: () => void;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const PAGE_SIZE = 25;

/** A view over existing CAD leaves. Only explicit inclusion actions reach the saved selection owner. */
export default function CustomCohortSubdivisionDialog(props: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [batchUnavailable, setBatchUnavailable] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current, previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const { family, catalog, included } = props;
  const locationReview = useMemo(() => props.families ? buildCustomCohortSubdivisionFamilyLocationReview({
    families: props.families, catalog, group: props.mapGroup ?? null, familyId: family.id,
  }) : null, [props.families, catalog, props.mapGroup, family.id]);
  const familyIds = new Set(family.pocket_ids), selectedIds = new Set(included);
  const phases = useMemo(() => buildCustomCohortSubdivisionPhases(catalog, family), [catalog, family]);
  const inspectionSelection = useMemo(() => buildCustomCohortSubdivisionInspection(catalog, family), [catalog, family]);
  const selectedLeafCount = family.pocket_ids.filter(id => selectedIds.has(id)).length;
  const selectedCount = phases.filter(p => p.pocket_ids.every(id => selectedIds.has(id))).length;
  const selectedAccounts = catalog.pockets.reduce((sum, p) => sum + (familyIds.has(p.id) && selectedIds.has(p.id) ? p.member_count : 0), 0);
  const phase = phases.find(p => props.phaseId !== null && p.pocket_ids.includes(props.phaseId)) ?? null;
  const rows = phases.filter(p => p.label.toLowerCase().includes(search.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), currentPage = Math.min(page, pageCount - 1);
  const reviews = new Map(catalog.recommendation?.pockets.map(p => [p.id, p]));
  return <dialog ref={dialogRef} onCancel={props.onClose} aria-label={`${family.label} subdivision review`}
    className="m-auto max-h-[85vh] w-[min(960px,95vw)] overflow-y-auto rounded-xl border border-amber-300 bg-white p-0 shadow-xl backdrop:bg-slate-950/50 print:hidden">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-200 bg-gradient-to-r from-violet-100 to-amber-50 px-4 py-3">
      <div><h4 className="font-semibold text-violet-950">{family.label}</h4>
        <p className="text-xs text-slate-700">{phases.length.toLocaleString('en-US')} recorded phases · {family.member_count.toLocaleString('en-US')} captured accounts · {family.county}</p></div>
      <button type="button" autoFocus className={button} onClick={props.onClose}>Close details</button>
    </header>
    <div className="space-y-3 p-4 text-sm">
      <p role="status" aria-live="polite">{selectedLeafCount === family.pocket_ids.length ? 'All captured phases included.' : selectedLeafCount ? 'Partially included.' : 'Not included.'}
        {' '}{selectedCount} of {phases.length} phases fully included · {selectedAccounts.toLocaleString('en-US')} accounts selected.
        {props.selectionDisabled && ' Selection changes are currently unavailable; displayed choices are the last saved selection.'}</p>
      <p className="text-xs opacity-80">Grouped from recorded subdivision names within this captured discovery area. These are review groups, not verified legal subdivision or phase boundaries.
        Areas outside the capture are not implied to be included. Review year-built patterns and mapped proximity before keeping a phase; different construction periods are not automatically removed.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={props.selectionDisabled || selectedLeafCount === family.pocket_ids.length}
          onClick={() => { if (!props.selectionDisabled) props.onInclude(family.pocket_ids); }}>Include all phases</button>
        <button type="button" className={button} disabled={props.selectionDisabled || selectedLeafCount === 0}
          onClick={() => { if (!props.selectionDisabled) props.onExclude(family.pocket_ids); }}>Exclude subdivision</button>
        <button type="button" className={button} disabled={!phase || props.inspectionsPaused}
          onClick={() => { if (!props.inspectionsPaused) props.onInspectPhase(null); }}>View whole subdivision</button>
      </div>
      <label className="block text-xs">Find a phase<input className="input input-bordered mt-1 w-full" maxLength={200} value={search}
        onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <div className="max-h-60 space-y-2 overflow-auto" aria-label="Subdivision phases">
        {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(p => {
          const review = p.pocket_ids.length === 1 ? reviews.get(p.id) : null;
          const selected = p.pocket_ids.every(id => selectedIds.has(id)), anySelected = p.pocket_ids.some(id => selectedIds.has(id));
          return <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-200 p-2">
            <button type="button" className="min-w-0 text-left" disabled={props.inspectionsPaused} aria-pressed={phase?.id === p.id}
              onClick={() => { if (!props.inspectionsPaused) props.onInspectPhase(p.id); }}><span className="font-medium">{p.label}</span>
              <span className="block text-xs opacity-80">{p.member_count.toLocaleString('en-US')} accounts · {selected ? 'Included' : anySelected ? 'Partially included' : 'Excluded'}
                {p.pocket_ids.length > 1 ? ` · ${p.pocket_ids.length} equivalent recorded county-name groups` : ''}</span>
              {review && <span className="block text-xs opacity-80">Similarity to subject property: {review.similarity.lower === null || review.similarity.upper === null
                ? 'unavailable' : `${review.similarity.lower.toFixed(1)}–${review.similarity.upper.toFixed(1)} / 100`}. Not a reliability score.</span>}</button>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={props.selectionDisabled || selected} aria-label={`Include phase ${p.label}`}
                onClick={() => { if (!props.selectionDisabled && !selected) props.onInclude(p.pocket_ids); }}>Include phase</button>
              <button type="button" className={button} disabled={props.selectionDisabled || !anySelected} aria-label={`Exclude phase ${p.label}`}
                onClick={() => { if (!props.selectionDisabled && anySelected) props.onExclude(p.pocket_ids); }}>Exclude phase</button>
            </div>
          </div>;
        })}
        {!rows.length && <p>No matching recorded phases.</p>}
      </div>
      {pageCount > 1 && <nav aria-label="Subdivision phase pages" className="flex items-center justify-between gap-2 text-xs">
        <button type="button" className={button} disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous phases</button>
        <span>Page {currentPage + 1} of {pageCount}</span>
        <button type="button" className={button} disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next phases</button>
      </nav>}
      <p className="text-xs opacity-80">Builder, HOA dues, amenities and verified zoning are not available in this retained view. No values are inferred.
        Whole-subdivision statistics use the exact union of accounts, not averages of phase medians.</p>
      {locationReview && <details className="rounded-lg border border-violet-200 p-3 text-xs" aria-label="Subdivision location coverage">
        <summary className="cursor-pointer font-medium">Mapped location coverage · {locationReview.represented_account_count.toLocaleString('en-US')} / {locationReview.account_count.toLocaleString('en-US')} accounts</summary>
        <p className="mt-2">{locationReview.status === 'available' ? 'Every family account is represented by retained parcel geometry.'
          : 'Complete location comparison is unavailable for this family. Missing or ambiguous geometry has not been filled in.'}
          {' '}Mapped extents describe the recorded spread, not distance between homes or verified subdivision identity. Overlapping extents do not prove that homes are close together.</p>
        <p className="mt-2">Inspect each phase below for its year-built range, median and missing observations. Construction-period differences remain visible for the appraiser’s decision; they do not silently change the selection.</p>
        {locationReview.combined_extent && <p className="mt-2 tabular-nums">Recorded spread: latitude {locationReview.combined_extent.south.toFixed(5)}–{locationReview.combined_extent.north.toFixed(5)};
          {' '}longitude {locationReview.combined_extent.west.toFixed(5)}–{locationReview.combined_extent.east.toFixed(5)}.</p>}
      </details>}
      <CustomCohortPocketInspector input={props.input} catalog={catalog} pocketId={phase?.id ?? family.pocket_ids[0]}
        pocketIds={phase ? phase.pocket_ids.length > 1 ? phase.pocket_ids : undefined : family.pocket_ids} label={phase?.label ?? family.label} previewTransport={props.previewTransport}
        inspectionSelection={batchUnavailable ? undefined : inspectionSelection ?? undefined}
        inspectedPocketId={phase?.id} onBatchUnavailable={() => setBatchUnavailable(true)}
        paused={props.inspectionsPaused} memberTransport={props.memberTransport} membersPaused={props.selectionDisabled} />
    </div>
  </dialog>;
}
