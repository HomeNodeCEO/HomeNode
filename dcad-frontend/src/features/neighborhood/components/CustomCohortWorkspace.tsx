import { useEffect, useMemo, useRef, useState } from 'react';
import { requestCustomCohortObservationPreview, requestCustomCohortOperation } from '../customCohortPreviewApi';
import { createCustomCohortPreviewController } from '../customCohortPreviewController';
import type { CustomCohortContextRef, CustomCohortPreviewInput, CustomCohortPreviewState, CustomCohortInitialResponse, CustomCohortPreviewGroup } from '../customCohortPreviewController';
import type { CustomCohortMemberTransport } from '../customCohortPreviewTransport';
import { isCustomCohortPreviewCapacityError } from '../customCohortPreviewTransport';
import { checkCustomCohortPocketCatalog, customCohortCatalogGroupIds, selectionFromRecordedGroups,
  customCohortCountyNameMatches, CUSTOM_COHORT_UNASSIGNED_GROUP } from '../customCohortPocketCatalog';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CheckedRecordedProximity } from '../customCohortPocketRecommendation';
import { buildCustomCohortSubdivisionFamilies, customCohortSubdivisionFamilyForPocket } from '../customCohortSubdivisionFamilies';
import CustomCohortParcelMap from './CustomCohortParcelMap';
import CustomCohortStatistics, { CustomCohortCompactStatistics } from './CustomCohortStatistics';
import CustomCohortScoreBandSelector from './CustomCohortScoreBandSelector';

export interface CustomCohortControlledWorkspace {
  readonly catalog: CheckedPocketCatalog;
  readonly selection: { readonly revision: number; readonly included_recorded_group_ids: readonly string[] };
  readonly saving: boolean;
  readonly blockedReason?: 'reload_required' | 'pending_capture' | 'read_only' | null;
  readonly onSelectionIntent: (ids: readonly string[]) => void;
  /** The host owns serialization with checkpoint saves and independent reads. */
  readonly previewTransport: typeof requestCustomCohortObservationPreview;
  readonly memberTransport: CustomCohortMemberTransport;
  readonly initialPreview?: CustomCohortInitialResponse | null;
}
interface Props {
  accountId: string; assignmentFileId: string; contextRef: CustomCohortContextRef;
  /** Changes on session/organization transition, even for the same file. */
  sessionKey: string; subjectLabel: string; enabled: boolean;
  workspace?: CustomCohortControlledWorkspace;
  onAnalysisSelection?: (group: CustomCohortPreviewGroup | null, includesTownhomes?: boolean) => void;
}
const timer = { set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const idle: CustomCohortPreviewState = { status: 'idle', freshness: 'none', requested: null, group: null, error: null };
const button = 'hn-action-secondary btn btn-sm normal-case';
const boundsLabel = (value: { lower: number | null; upper: number | null }) => value.lower === null || value.upper === null
  ? 'No comparable observations' : `${value.lower.toFixed(1)}–${value.upper.toFixed(1)} / 100`;
const housingLabels = { detached_single_family: 'Detached single-family', townhouse: 'Townhouse', condominium: 'Condominium',
  duplex: 'Duplex', apartment: 'Apartment', mobile_home: 'Mobile home', manufactured_home: 'Manufactured home' };
const housingOrigins = { saved_subject: 'saved subject', retained_subject_public: 'retained public subject observation',
  current_subject_cad: 'current retained subject CAD' };
const proximityUnavailableReasons = {
  capacity_exceeded: 'The captured study exceeds the current proximity calculation limit. Its parcel map may still be available; distances remain unknown for the whole study.',
  subject_point_unavailable: 'The captured subject location is missing or cannot be used for this calculation. Distances remain unknown.',
  retained_map_unavailable: 'The saved parcel geometry could not be validated for this calculation. Distances remain unknown.',
  retained_binding_mismatch: 'The saved subject location, discovery area, and parcel evidence could not be matched for this calculation. Distances remain unknown.',
  native_query_failed: 'The recorded-point distance calculation could not be completed. Distances remain unknown.',
  native_result_invalid: 'The distance calculation did not return a complete, valid result. Distances remain unknown.',
} satisfies Record<Exclude<CheckedRecordedProximity['reason'], null>, string>;
const unassignedReasonLabels: Record<string, string> = {
  pocket_count_limit: 'Too many distinct recorded names for this catalog version',
  recorded_label_variant_limit: 'Too many raw subdivision-name variants',
  recorded_label_text_limit: 'A recorded subdivision name exceeds the text limit',
  catalog_output_byte_limit: 'Grouped result exceeds the response-size limit',
  county_unavailable: 'County missing',
  conflicting_recorded_counties: 'Conflicting counties',
  invalid_recorded_county: 'Invalid county value',
  recorded_subdivision_label_unavailable: 'Subdivision name missing',
  conflicting_recorded_subdivision_labels: 'Conflicting subdivision names',
  invalid_recorded_subdivision_label: 'Invalid subdivision name',
};
const unassignedReasonLabel = (reason: string) => unassignedReasonLabels[reason] ?? reason.replaceAll('_', ' ');

/** Independent exploration only. Controlled intent never writes accepted report data.
 * A target, context or session change unmounts all request/map ownership. */
export default function CustomCohortWorkspace(props: Props) {
  if (!props.enabled) return null;
  const ref = props.contextRef;
  const key = JSON.stringify([props.sessionKey, props.accountId, props.assignmentFileId,
    ref.context_id, ref.context_revision, ref.context_sha256]);
  return <WorkspaceSession key={key} {...props} />;
}

function WorkspaceSession(props: Props) {
  // The keyed parent owns logical identity changes. Pin equivalent prop objects
  // here so an unrelated autosave render never reloads the catalog or preview.
  const [input] = useState<CustomCohortPreviewInput>(() => ({ accountId: props.accountId,
    assignmentFileId: props.assignmentFileId, contextRef: { ...props.contextRef }, selection: { revision: 1, pockets: [] } }));
  const { accountId, assignmentFileId, contextRef } = input;
  const [localCatalog, setCatalog] = useState<CheckedPocketCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [localIncluded, setIncluded] = useState<readonly string[]>([]);
  const [localRevision, setRevision] = useState(1);
  const [retry, setRetry] = useState(0);
  const [inspected, setInspected] = useState<string | null>(null);
  const [inspectedFamilyId, setInspectedFamilyId] = useState<string | null>(null);
  const [minimumScoreBand, setMinimumScoreBand] = useState(90);
  const [preview, setPreview] = useState<CustomCohortPreviewState>(idle);
  const controller = useRef<ReturnType<typeof createCustomCohortPreviewController> | null>(null);
  const controlled = props.workspace !== undefined;
  const catalog = props.workspace?.catalog ?? localCatalog;
  const subdivisionFamilies = useMemo(() => catalog ? buildCustomCohortSubdivisionFamilies(catalog) : undefined, [catalog]);
  const inspectedFamily = subdivisionFamilies?.families.find(family => family.id === inspectedFamilyId) ?? null;
  const highlightedIds = inspectedFamily?.pocket_ids;
  const included = props.workspace?.selection.included_recorded_group_ids ?? localIncluded;
  const revision = props.workspace?.selection.revision ?? localRevision;
  const saving = props.workspace?.saving ?? false;
  const blockedReason = props.workspace?.blockedReason ?? null;
  const inspectionsPaused = blockedReason === 'read_only';
  const selectionBlocked = saving || Boolean(blockedReason);
  const transport = props.workspace?.previewTransport ?? requestCustomCohortObservationPreview;
  const transportRef = useRef(transport);
  // Stable through selection saves; a fresh explicit reopen supplies a new
  // response and resets this owner even if the context/revision stayed equal.
  const openingPreview = props.workspace?.initialPreview;
  transportRef.current = transport;
  const desired = useMemo(() => {
    if (!catalog) return null;
    const ref = catalog.binding.context_ref;
    if (catalog.subject_membership.account_id !== input.accountId
      || ref.context_id !== contextRef.context_id || ref.context_revision !== contextRef.context_revision
      || ref.context_sha256 !== contextRef.context_sha256) return null;
    try { return { ...input, selection: selectionFromRecordedGroups(catalog, included, revision) }; }
    catch { return null; } // Malformed restored IDs must never fall back to all groups.
  }, [catalog, contextRef, included, input, revision]);

  useEffect(() => {
    let active = true;
    const owner = createCustomCohortPreviewController({ transport: (request, options) => transportRef.current(request, options), timer,
      // A controlled selection becomes visible only after its single owned
      // workfile save completes. There are no unsaved edits left to debounce.
      debounceMs: controlled ? 0 : undefined,
      initialResponse: retry === 0 ? openingPreview : null,
      onChange: next => { if (active) setPreview(next); } });
    controller.current = owner;
    return () => { active = false; owner.dispose(); controller.current = null; };
  }, [openingPreview, retry, controlled]);

  useEffect(() => {
    if (controlled) return;
    const abort = new AbortController(); let active = true;
    setCatalog(null); setCatalogError(null); controller.current?.setSelection(null);
    const timeout = setTimeout(() => { abort.abort(); if (active) setCatalogError('Loading the recorded groups timed out. Retry when ready.'); }, 65_000);
    void requestCustomCohortOperation(accountId, 'catalog', {
      assignment_file_id: assignmentFileId, context_ref: contextRef, selection: input.selection, include_recommendation: true,
    }, { signal: abort.signal }).then(value => {
      if (!active || abort.signal.aborted) return;
      const checked = checkCustomCohortPocketCatalog(value, input);
      // Begin broad: all retained discovered accounts, including unresolved
      // groups. No sale-count target and no unsupported automatic recommendation.
      setCatalog(checked); setIncluded(customCohortCatalogGroupIds(checked)); setRevision(1);
    }).catch(error => {
      if (active && !abort.signal.aborted) setCatalogError(isCustomCohortPreviewCapacityError(error)
        ? 'This captured study exceeds the preview capacity even before groups are selected. Its groups cannot be loaded here; retrying the same study may reach the same limit. No selection was substituted and this read has not applied anything to the report.'
        : 'Recorded groups are unavailable. The saved report has not changed.');
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); abort.abort(); };
  }, [accountId, assignmentFileId, contextRef, controlled, input, reload]);

  useEffect(() => {
    if (!selectionBlocked) controller.current?.setSelection(desired);
  }, [desired, retry, selectionBlocked]);

  const choose = (ids: readonly string[]) => {
    if (selectionBlocked || !desired) return;
    if (props.workspace) props.workspace.onSelectionIntent(Object.freeze([...ids]));
    else { setIncluded(ids); setRevision(n => n + 1); }
  };
  const includeGroups = (ids: readonly string[]) => {
    const added = ids.filter(id => !included.includes(id));
    if (added.length) choose([...included, ...added]);
  };
  const excludeGroups = (ids: readonly string[]) => {
    const removed = new Set(ids), next = included.filter(id => !removed.has(id));
    if (next.length !== included.length) choose(next);
  };
  const activatePocket = (id: string) => {
    if (inspectionsPaused || !desired || !catalog?.pockets.some(p => p.id === id)) return;
    const family = subdivisionFamilies && customCohortSubdivisionFamilyForPocket(subdivisionFamilies, id);
    setInspected(id);
    setInspectedFamilyId(family?.id ?? null);
    // Map selection always applies to the complete recorded-name family,
    // regardless of zoom. Individual CAD leaves remain intact in the workfile.
    includeGroups(family?.pocket_ids ?? [id]);
  };
  const excludePocket = (id: string) => {
    if (inspectionsPaused || !desired || !catalog?.pockets.some(p => p.id === id)) return;
    const family = subdivisionFamilies && customCohortSubdivisionFamilyForPocket(subdivisionFamilies, id);
    excludeGroups(family?.pocket_ids ?? [id]);
  };
  const recommendation = desired ? catalog?.recommendation ?? null : null;
  const groups = useMemo(() => catalog ? customCohortCatalogGroupIds(catalog) : [], [catalog]);
  const subjectCountyMatches = useMemo(() => catalog?.subject_membership.assigned_pocket_id
    ? customCohortCountyNameMatches(catalog, catalog.subject_membership.assigned_pocket_id) : [], [catalog]);
  const pending = preview.status === 'debouncing' || preview.status === 'loading';
  const requestMatches = useMemo(() => {
    const requested = preview.requested?.selection, selected = desired?.selection;
    return requested && selected && requested.revision === selected.revision
      && requested.pockets.length === selected.pockets.length && requested.pockets.every((pocket, index) => {
        const other = selected.pockets[index];
        return pocket.id === other.id && pocket.label === other.label && pocket.account_ids.length === other.account_ids.length
          && pocket.account_ids.every((id, member) => id === other.account_ids[member]);
      });
  }, [desired, preview.requested]);
  const current = !selectionBlocked && desired !== null && preview.freshness === 'current'
    && preview.group?.binding.selectionRevision === revision
    && requestMatches;
  const group = desired ? preview.group : null;
  const freshness = group ? current ? 'current' : 'stale' : 'none';
  // Analysis never borrows stale figures while a selection save/preview is in
  // flight. Its identity includes the exact context and selection fingerprint.
  const onAnalysisSelection = props.onAnalysisSelection;
  const includesTownhomes = useMemo(() => {
    const composition = catalog?.recommendation?.stock_composition_v1;
    if (composition?.status !== 'available') return false;
    const selected = new Set(included);
    // The checked composition uses the fixed housing-category order:
    // detached single family, townhouse, condominium, duplex, apartment, etc.
    return composition.pockets.some(row => selected.has(row[0]) && row[3][1][1] > 0);
  }, [catalog, included]);
  useEffect(() => { onAnalysisSelection?.(current ? group : null, current ? includesTownhomes : undefined); }, [current, group, includesTownhomes, onAnalysisSelection]);
  useEffect(() => () => onAnalysisSelection?.(null), [onAnalysisSelection]);
  const selectionDisabled = selectionBlocked || !desired;
  const area = recommendation?.sales_aware_area;
  const suggested = area && area.status !== 'unavailable' && area.selected_recorded_group_ids.length
    ? area.selected_recorded_group_ids : recommendation?.recommended_recorded_group_ids ?? [];
  const suggestionActive = suggested.length === included.length && suggested.every(id => included.includes(id));
  const suggestionDisabled = selectionDisabled || (!area && recommendation?.status !== 'recommendation_for_review')
    || !suggested.length || suggestionActive;
  const allGroupsIncluded = useMemo(() => {
    if (!groups.length || included.length !== groups.length) return false;
    const selected = new Set(included);
    return groups.every(id => selected.has(id));
  }, [groups, included]);
  const scoreBandSelector = <CustomCohortScoreBandSelector recommendation={recommendation}
    preparedMap={catalog?.prepared_secondary_map} included={included}
    minimum={minimumScoreBand} onMinimumChange={setMinimumScoreBand}
    subjectGroupId={catalog?.subject_membership.assigned_pocket_id ?? null} disabled={selectionDisabled}
    allGroupsIncluded={Boolean(current && allGroupsIncluded)}
    onReplace={ids => choose(ids)} onAdd={includeGroups} onRemove={excludeGroups} />;
  const liveStatistics = <aside className="min-w-0 rounded-xl border border-violet-200 bg-violet-50/30 p-3"
    aria-label="Live neighborhood characteristics and market observations">
    <CustomCohortCompactStatistics group={group} freshness={freshness} includePrivateSales mapStrip />
    <details className="mt-3 rounded-lg border border-violet-200 bg-white p-2 text-xs">
      <summary className="cursor-pointer font-medium">Full observation breakdown</summary>
      <div className="mt-3"><CustomCohortStatistics group={group} freshness={freshness} selectedOnly /></div>
    </details>
  </aside>;

  return <section aria-label="Neighborhood pocket exploration" className="space-y-4 rounded-2xl border border-violet-200 p-4 print:hidden">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-base font-semibold">Neighborhood pocket exploration</h3></div>
      <span className="rounded-full border border-amber-300 px-3 py-1 text-xs">Preview only · report unchanged</span>
    </header>
    {/* Parcel geometry and similarity limitations remain in the retained workfile,
        not in explanatory paragraphs above the appraiser's controls. */}
    {!catalog && !catalogError && <p role="status">Loading recorded groups…</p>}
    {!controlled && catalogError && <div role="alert" className="space-y-2"><p>{catalogError}</p>
      <button type="button" className={button} onClick={() => setReload(n => n + 1)}>Retry group loading</button></div>}
    {catalog && <>
      {!desired && <p role="alert">The saved group selection does not match this retained context. Reload the workspace; no replacement selection has been inferred.</p>}
      {catalog.status === 'incomplete' && <p role="alert">Subdivision grouping reached a capacity limit: {catalog.unassigned.reason_counts.map(row => unassignedReasonLabel(row.reason)).join(', ')}.
        {' '}All captured accounts remain selectable together; their individual CAD subdivision names have not been judged missing.</p>}
      {recommendation && <details className="rounded-xl border border-amber-300 bg-violet-50/40 p-4">
        <summary className="cursor-pointer text-sm font-medium">Optional automatic recommendation</summary>
        <section aria-label="Recommended pockets for review" className="mt-3 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-semibold">Recommended area for review</h4>
            <p className="text-sm">{suggested.length.toLocaleString('en-US')} recorded groups · Current observations only</p></div>
          <button type="button" className={button} disabled={suggestionDisabled}
            onClick={() => { if (!suggestionDisabled) choose(suggested); }}>Use recommended area</button>
        </div>
        {area && <div className="rounded-lg border border-violet-200 bg-white p-3 text-sm" aria-label="Recommended area sales and living-area check">
          <p>{area.recorded_transaction_count.toLocaleString('en-US')} qualifying recorded transactions in the suggestion
            {' '}of {area.available_qualifying_transaction_count.toLocaleString('en-US')} in the captured area; target 50.
            {' '}{area.selected_account_count.toLocaleString('en-US')} CAD accounts selected.</p>
          <p className="mt-1">{area.status === 'meets_targets'
            ? 'Provisional count and populated-quarter GLA targets met; sale eligibility and at-sale GLA still require review.'
            : area.status === 'insufficient_recorded_sales' ? 'Fewer than 50 qualifying recorded transactions were available in the compact selection.'
            : area.status === 'quarterly_gla_mismatch' ? 'At least one quarter has no qualifying sales or its median current CAD GLA differs from the subject by more than 5%.'
            : 'A sales-aware selection could not be established from the retained observations.'}</p>
          {area.quarterly_gla.length > 0 && <p className="mt-1 text-xs">Quarterly median current-CAD GLA versus subject:{' '}
            {area.quarterly_gla.map(q => q.transaction_count
              ? `${q.quarter} ${q.transaction_count} transactions, ${q.deviation_percent!.toFixed(1)}% ${q.within_tolerance ? 'within' : 'outside'} 5%`
              : `${q.quarter} no qualifying transactions`).join(' · ')}.
          </p>}
          <p className="mt-1 text-xs">These are recorded transaction links and current CAD living areas—not verified market-eligible sales or measurements at sale. The suggestion is an appraiser-editable starting area, not a reliability probability.</p>
        </div>}
        <p className="text-sm">Across all captured accounts: similarity bounds {boundsLabel(recommendation.all.similarity)} · Observed factor coverage{' '}
          {recommendation.all.similarity.known_weight_percent === null ? 'unavailable' : `${recommendation.all.similarity.known_weight_percent.toFixed(1)}%`}.</p>
        <p className="text-xs opacity-80">These bounds retain uncertainty from missing data; they are not confidence or reliability scores.
          The fixed initial review policy uses GLA 40%, year-built similarity 30%, housing type 20%, and the remaining factors 10%.
          {recommendation.recorded_housing
            ? ` Recorded housing categories are observations, not verified property classifications.${recommendation.recorded_proximity ? '' : ' Comparable distance is not established here.'} Verified sale consideration is not established here. The map still shows your current inclusion choices.`
            : recommendation.recorded_proximity
            ? ' Housing taxonomy and verified sale consideration are not established here. The map still shows your current inclusion choices.'
            : ' Housing, comparable distance and verified sale consideration are not established here. The map still shows your current inclusion choices.'}</p>
        {recommendation.recorded_proximity && <p className="text-xs opacity-80">
          Recorded point proximity: {recommendation.all.factor_coverage.proximity.observed_count.toLocaleString('en-US')} observed /{' '}
          {recommendation.all.member_count.toLocaleString('en-US')} captured accounts;{' '}
          {recommendation.all.factor_coverage.proximity.unknown_count.toLocaleString('en-US')} unknown.
          {' '}This compares the recorded subject centroid with a point on each retained parcel surface, not an entrance, route or full-property distance.
          {' '}Multiple locations and invalid parcel geometry stay unknown; they are not replaced with a convenient parcel.
          {recommendation.recorded_proximity.status === 'unavailable' && <>
            {' Recorded point proximity is unavailable for this captured study. '}
            {recommendation.recorded_proximity.reason && Object.hasOwn(proximityUnavailableReasons, recommendation.recorded_proximity.reason)
              ? proximityUnavailableReasons[recommendation.recorded_proximity.reason] : ''}
          </>}
        </p>}
        {recommendation.recorded_housing && <div className="space-y-1 text-xs opacity-80">
          <p>Recorded housing observations: {recommendation.recorded_housing.coverage.observed_count.toLocaleString('en-US')} observed /{' '}
            {recommendation.all.member_count.toLocaleString('en-US')} captured accounts;{' '}
            {recommendation.recorded_housing.coverage.unknown_count.toLocaleString('en-US')} unknown.</p>
          <p>Subject category: {recommendation.recorded_housing.subject.category
            ? housingLabels[recommendation.recorded_housing.subject.category] : 'Unknown'} ({housingOrigins[recommendation.recorded_housing.subject.origin]}).
            {' '}Housing comparison: {recommendation.all.factor_coverage.housing_type.observed_count.toLocaleString('en-US')} observed /{' '}
            {recommendation.all.member_count.toLocaleString('en-US')} captured accounts;{' '}
            {recommendation.all.factor_coverage.housing_type.unknown_count.toLocaleString('en-US')} unknown.</p>
          <p>Only complete recorded categories are compared: an exact category match contributes to the fixed 20% housing weight; a different category does not.
            {' '}Missing, unknown, partial and conflicting observations stay unscored. These are not verified housing classifications or historical stock evidence.</p>
        </div>}
        {recommendation.status === 'insufficient_observations' || !suggested.length
          ? <p className="text-sm">No usable suggested selection is available. Review groups manually; your saved choices have not changed.</p>
          : suggestionActive ? <p className="text-sm">The suggested selection is already active.</p>
            : <p className="text-sm">Using the suggestion replaces the exploration selection and saves it to this file. It does not change the accepted report.</p>}
        {!recommendation.subject.in_discovery && <p className="text-sm">The subject is not in this captured roster. Review the discovery area before using recommendations.</p>}
        {recommendation.subject.recorded_group_review_ids.some(id => !suggested.includes(id)) && <p className="text-sm">
          The subject’s recorded group is flagged separately for review; it was not automatically added to the suggested set or given a higher score.</p>}
        </section>
      </details>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selectionDisabled} onClick={() => choose(customCohortCatalogGroupIds(catalog))}>Include all observations</button>
        <button type="button" className={button} disabled={selectionDisabled} onClick={() => choose([])}>Deselect all</button>
        <button type="button" className={button} disabled={selectionDisabled || !catalog.subject_membership.assigned_pocket_id}
          onClick={() => { const id = catalog.subject_membership.assigned_pocket_id; if (id) choose([id]); }}>
          Preview subject’s recorded group</button>
        {subjectCountyMatches.length > 1 && <button type="button" className={button} disabled={selectionDisabled}
          onClick={() => choose(subjectCountyMatches.map(p => p.id))}>Preview subject’s matching county-name groups</button>}
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {saving ? 'Saving the group selection… Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'reload_required' ? 'Saved choices need to be reloaded before continuing. Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'pending_capture' ? 'Resume the saved capture before changing groups. Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'read_only' ? 'Neighborhood selection is read-only. Any displayed map and statistics reflect the saved selection.'
          : pending ? 'Updating the map and statistics together…' : preview.error === 'capacity_exceeded'
          ? 'This selection exceeds the preview capacity. Choose fewer recorded groups, use “Deselect all” and include groups individually, or try the subject’s recorded group. Any displayed map and statistics still represent the preceding selection, not these choices. No groups were automatically removed.' : preview.status === 'failed'
          ? 'The preview could not update. Any displayed map and statistics are from the preceding selection.'
          : current ? 'Map and statistics match the current preview selection.' : 'Preparing observations…'}
      </p>
      {preview.status === 'failed' && <button type="button" className={button} disabled={selectionDisabled}
        onClick={() => { if (!selectionDisabled) setRetry(n => n + 1); }}>Retry preview</button>}
      <div>
        {group ? <CustomCohortParcelMap group={group} catalog={catalog} freshness={freshness}
          subdivisionFamilies={subdivisionFamilies} inspectedPocketIds={highlightedIds}
          onActivatePocket={activatePocket} onExcludePocket={excludePocket}
          inspectedPocketId={inspected} onInspectPocket={id => { if (!inspectionsPaused) { setInspectedFamilyId(null); setInspected(id); } }}
          onInspectAccount={account => { if (!inspectionsPaused && catalog.unassigned.account_ids.includes(account)) setInspected(CUSTOM_COHORT_UNASSIGNED_GROUP); }}
          scoreBandSelector={scoreBandSelector} belowMapStatistics={liveStatistics} />
          : <div className="space-y-3 rounded-xl border border-violet-200 p-4">
            <p role="status" className="grid min-h-40 place-content-center">Waiting for a coherent map and statistics…</p>
            {scoreBandSelector}
            {liveStatistics}
          </div>}
      </div>
      {/* Detailed source evidence remains in the workfile. Map selection feeds
          only the combined live statistics and the independent market studies. */}
    </>}
  </section>;
}
