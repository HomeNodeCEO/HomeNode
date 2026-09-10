import { useEffect, useMemo, useRef, useState } from 'react';
import { requestCustomCohortObservationPreview, requestCustomCohortOperation } from '../customCohortPreviewApi';
import { createCustomCohortPreviewController } from '../customCohortPreviewController';
import type { CustomCohortContextRef, CustomCohortPreviewInput, CustomCohortPreviewState } from '../customCohortPreviewController';
import type { CustomCohortMemberTransport } from '../customCohortPreviewTransport';
import { isCustomCohortPreviewCapacityError } from '../customCohortPreviewTransport';
import { checkCustomCohortPocketCatalog, customCohortCatalogGroupIds, selectionFromRecordedGroups,
  CUSTOM_COHORT_UNASSIGNED_GROUP } from '../customCohortPocketCatalog';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import CustomCohortParcelMap from './CustomCohortParcelMap';
import CustomCohortStatistics from './CustomCohortStatistics';
import CustomCohortPocketInspector from './CustomCohortPocketInspector';

export interface CustomCohortControlledWorkspace {
  readonly catalog: CheckedPocketCatalog;
  readonly selection: { readonly revision: number; readonly included_recorded_group_ids: readonly string[] };
  readonly saving: boolean;
  readonly blockedReason?: 'reload_required' | 'pending_capture' | 'read_only' | null;
  readonly onSelectionIntent: (ids: readonly string[]) => void;
  /** The host owns serialization with checkpoint saves and independent reads. */
  readonly previewTransport: typeof requestCustomCohortObservationPreview;
  readonly memberTransport: CustomCohortMemberTransport;
}
interface Props {
  accountId: string; assignmentFileId: string; contextRef: CustomCohortContextRef;
  /** Changes on session/organization transition, even for the same file. */
  sessionKey: string; subjectLabel: string; enabled: boolean;
  workspace?: CustomCohortControlledWorkspace;
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
  const { subjectLabel } = props;
  const [localCatalog, setCatalog] = useState<CheckedPocketCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [localIncluded, setIncluded] = useState<readonly string[]>([]);
  const [localRevision, setRevision] = useState(1);
  const [retry, setRetry] = useState(0);
  const [inspected, setInspected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<CustomCohortPreviewState>(idle);
  const controller = useRef<ReturnType<typeof createCustomCohortPreviewController> | null>(null);
  const controlled = props.workspace !== undefined;
  const catalog = props.workspace?.catalog ?? localCatalog;
  const included = props.workspace?.selection.included_recorded_group_ids ?? localIncluded;
  const revision = props.workspace?.selection.revision ?? localRevision;
  const saving = props.workspace?.saving ?? false;
  const blockedReason = props.workspace?.blockedReason ?? null;
  const inspectionsPaused = blockedReason === 'read_only';
  const selectionBlocked = saving || Boolean(blockedReason);
  const transport = props.workspace?.previewTransport ?? requestCustomCohortObservationPreview;
  const transportRef = useRef(transport);
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
      onChange: next => { if (active) setPreview(next); } });
    controller.current = owner;
    return () => { active = false; owner.dispose(); controller.current = null; };
  }, [retry]);

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
  const toggle = (id: string) => choose(included.includes(id) ? included.filter(value => value !== id) : [...included, id]);
  const recommendation = desired ? catalog?.recommendation ?? null : null;
  const reviewById = new Map(recommendation?.pockets.map(pocket => [pocket.id, pocket]));
  const groups = catalog ? [...catalog.pockets.map(p => ({ id: p.id, label: p.label, county: p.county, count: p.member_count })),
    ...(catalog.unassigned.member_count ? [{ id: CUSTOM_COHORT_UNASSIGNED_GROUP, label: 'Unassigned / conflicting recorded names',
      county: 'Needs review', count: catalog.unassigned.member_count }] : [])]
    .sort((a, b) => (reviewById.get(a.id)?.review_rank ?? 0) - (reviewById.get(b.id)?.review_rank ?? 0)) : [];
  const selectedGroup = groups.find(p => p.id === inspected);
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
  const selectionDisabled = selectionBlocked || !desired;
  const suggested = recommendation?.recommended_recorded_group_ids ?? [];
  const suggestionActive = suggested.length === included.length && suggested.every(id => included.includes(id));
  const suggestionDisabled = selectionDisabled || recommendation?.status !== 'recommendation_for_review' || !suggested.length || suggestionActive;

  return <section aria-label="Neighborhood pocket exploration" className="space-y-4 rounded-2xl border border-violet-200 p-4 print:hidden">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-base font-semibold">Neighborhood pocket exploration</h3>
        <p className="text-sm opacity-80">{subjectLabel} · Recorded CAD groups in the retained discovery area</p></div>
      <span className="rounded-full border border-amber-300 px-3 py-1 text-xs">Preview only · report unchanged</span>
    </header>
    <p className="text-sm">Explore broad observations, then include or exclude recorded groups. These parcel shapes are not legal subdivision
      or appraiser-defined neighborhood boundaries. Current-observation similarity is for review only; reliability and report-ready eligibility are not established.</p>
    {!catalog && !catalogError && <p role="status">Loading recorded groups…</p>}
    {!controlled && catalogError && <div role="alert" className="space-y-2"><p>{catalogError}</p>
      <button type="button" className={button} onClick={() => setReload(n => n + 1)}>Retry group loading</button></div>}
    {catalog && <>
      {!desired && <p role="alert">The saved group selection does not match this retained context. Reload the workspace; no replacement selection has been inferred.</p>}
      {catalog.status === 'incomplete' && <p role="alert">The recorded-name catalog is incomplete. All discovered accounts remain in the unresolved group;
        no partial set of named groups has been substituted.</p>}
      {recommendation && <section aria-label="Recommended pockets for review" className="space-y-2 rounded-xl border border-amber-300 bg-violet-50/40 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h4 className="font-semibold">Recommended pockets for review</h4>
            <p className="text-sm">{suggested.length.toLocaleString('en-US')} suggested recorded groups · Current observations only</p></div>
          <button type="button" className={button} disabled={suggestionDisabled}
            onClick={() => { if (!suggestionDisabled) choose(suggested); }}>Use suggested selection</button>
        </div>
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
          {recommendation.recorded_proximity.status === 'unavailable' && ' Recorded point proximity is unavailable for this captured study.'}
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
      </section>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={selectionDisabled} onClick={() => choose(customCohortCatalogGroupIds(catalog))}>Include all observations</button>
        <button type="button" className={button} disabled={selectionDisabled} onClick={() => choose([])}>Exclude all</button>
        <button type="button" className={button} disabled={selectionDisabled || !catalog.subject_membership.assigned_pocket_id}
          onClick={() => { const id = catalog.subject_membership.assigned_pocket_id; if (id) choose([id]); }}>
          Preview subject’s recorded group</button>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {saving ? 'Saving the group selection… Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'reload_required' ? 'Saved choices need to be reloaded before continuing. Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'pending_capture' ? 'Resume the saved capture before changing groups. Any displayed map and statistics still match the preceding selection.'
          : blockedReason === 'read_only' ? 'Neighborhood selection is read-only. Any displayed map and statistics reflect the saved selection.'
          : pending ? 'Updating the map and statistics together…' : preview.error === 'capacity_exceeded'
          ? 'This selection exceeds the preview capacity. Choose fewer recorded groups, use “Exclude all” and include groups individually, or try the subject’s recorded group. Any displayed map and statistics still represent the preceding selection, not these choices. No groups were automatically removed.' : preview.status === 'failed'
          ? 'The preview could not update. Any displayed map and statistics are from the preceding selection.'
          : current ? 'Map and statistics match the current preview selection.' : 'Preparing observations…'}
      </p>
      {preview.status === 'failed' && <button type="button" className={button} disabled={selectionDisabled}
        onClick={() => { if (!selectionDisabled) setRetry(n => n + 1); }}>Retry preview</button>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        {group ? <CustomCohortParcelMap group={group} catalog={catalog} freshness={freshness}
          inspectedPocketId={inspected} onInspectPocket={id => { if (!inspectionsPaused) setInspected(id); }}
          onInspectAccount={account => { if (!inspectionsPaused && catalog.unassigned.account_ids.includes(account)) setInspected(CUSTOM_COHORT_UNASSIGNED_GROUP); }} />
          : <p role="status" className="grid min-h-80 place-content-center rounded-xl border border-violet-200 p-4">Waiting for a coherent map and statistics…</p>}
        <aside className="space-y-3 rounded-xl border border-violet-200 p-3" aria-label="Recorded groups">
          <label className="block text-sm">Find a recorded group<input value={search} maxLength={200}
            onChange={event => setSearch(event.target.value)} className="input input-bordered mt-1 w-full" /></label>
          <div className="max-h-80 space-y-2 overflow-auto">
            {groups.filter(p => `${p.label} ${p.county}`.toLowerCase().includes(search.toLowerCase())).map(p =>
              <div key={p.id} className="flex items-start gap-2 rounded-lg border border-violet-100 p-2">
                <input type="checkbox" aria-label={`Include ${p.label}`} checked={included.includes(p.id)} disabled={selectionDisabled} onChange={() => toggle(p.id)} />
                <button type="button" className="custom-cohort-pocket-card min-w-0 flex-1 text-left text-sm" disabled={inspectionsPaused}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', justifyItems: 'stretch',
                    alignItems: 'start', gap: '0.375rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  onClick={() => { if (!inspectionsPaused) setInspected(p.id); }}
                  aria-pressed={inspected === p.id}><span className="block font-medium">{p.label}</span>
                  <span className="text-xs opacity-75">{p.count.toLocaleString('en-US')} accounts · {p.county}</span>
                  {reviewById.has(p.id) && <span className="mt-1 block text-xs">
                    Review rank {reviewById.get(p.id)!.review_rank} · {boundsLabel(reviewById.get(p.id)!.similarity)}
                    <span className="block opacity-75">Observed factor coverage {reviewById.get(p.id)!.similarity.known_weight_percent?.toFixed(1) ?? 'unavailable'}{reviewById.get(p.id)!.similarity.known_weight_percent === null ? '' : '%'}
                      {reviewById.get(p.id)!.suggested_for_review ? ' · Suggested' : ''}
                      {reviewById.get(p.id)!.subject_group_review ? ' · Subject group review' : ''}</span>
                    {recommendation?.recorded_proximity && <span className="block opacity-75">
                      Recorded point proximity: {reviewById.get(p.id)!.factor_coverage.proximity.observed_count.toLocaleString('en-US')} observed /{' '}
                      {p.count.toLocaleString('en-US')} accounts; {reviewById.get(p.id)!.factor_coverage.proximity.unknown_count.toLocaleString('en-US')} unknown.
                    </span>}
                    {recommendation?.recorded_housing && <span className="block opacity-75">
                      Recorded housing comparison: {reviewById.get(p.id)!.factor_coverage.housing_type.observed_count.toLocaleString('en-US')} observed /{' '}
                      {p.count.toLocaleString('en-US')} accounts; {reviewById.get(p.id)!.factor_coverage.housing_type.unknown_count.toLocaleString('en-US')} unknown.
                    </span>}
                  </span>}</button>
              </div>)}
          </div>
          {selectedGroup && <div className="space-y-2 border-t border-violet-200 pt-3">
            <h4 className="font-semibold">{selectedGroup.label}</h4><p className="text-sm">{selectedGroup.count.toLocaleString('en-US')} retained accounts.
              Recorded-name grouping requires review; builder, HOA dues, amenities and legal phases are not inferred.</p>
            <button type="button" className={button} disabled={selectionDisabled} onClick={() => toggle(selectedGroup.id)}>
              {included.includes(selectedGroup.id) ? 'Exclude this group' : 'Include this group'}</button>
          </div>}
        </aside>
      </div>
      <CustomCohortStatistics group={group} freshness={freshness} />
      {selectedGroup && desired && <CustomCohortPocketInspector input={input} catalog={catalog}
        pocketId={selectedGroup.id} label={selectedGroup.label} previewTransport={transport} paused={inspectionsPaused}
        memberTransport={props.workspace?.memberTransport} membersPaused={selectionBlocked} />}
    </>}
  </section>;
}
