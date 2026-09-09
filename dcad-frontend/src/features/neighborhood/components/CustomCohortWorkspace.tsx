import { useEffect, useRef, useState } from 'react';
import { requestCustomCohortObservationPreview, requestCustomCohortOperation } from '../customCohortPreviewApi';
import { createCustomCohortPreviewController } from '../customCohortPreviewController';
import type { CustomCohortContextRef, CustomCohortPreviewInput, CustomCohortPreviewState } from '../customCohortPreviewController';
import { checkCustomCohortPocketCatalog, customCohortCatalogGroupIds, selectionFromRecordedGroups,
  CUSTOM_COHORT_UNASSIGNED_GROUP } from '../customCohortPocketCatalog';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import CustomCohortParcelMap from './CustomCohortParcelMap';
import CustomCohortStatistics from './CustomCohortStatistics';
import CustomCohortPocketInspector from './CustomCohortPocketInspector';

interface Props {
  accountId: string; assignmentFileId: string; contextRef: CustomCohortContextRef;
  /** Changes on session/organization transition, even for the same file. */
  sessionKey: string; subjectLabel: string; enabled: boolean;
}
const timer = { set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const idle: CustomCohortPreviewState = { status: 'idle', freshness: 'none', requested: null, group: null, error: null };
const button = 'hn-action-secondary btn btn-sm normal-case';

/** Independent exploration only. No workfile/draft mutation callbacks exist.
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
  const [catalog, setCatalog] = useState<CheckedPocketCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [included, setIncluded] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(1);
  const [inspected, setInspected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<CustomCohortPreviewState>(idle);
  const controller = useRef<ReturnType<typeof createCustomCohortPreviewController> | null>(null);

  useEffect(() => {
    let active = true;
    const owner = createCustomCohortPreviewController({ transport: requestCustomCohortObservationPreview, timer,
      onChange: next => { if (active) setPreview(next); } });
    controller.current = owner;
    return () => { active = false; owner.dispose(); controller.current = null; };
  }, []);

  useEffect(() => {
    const abort = new AbortController(); let active = true;
    setCatalog(null); setCatalogError(null); controller.current?.setSelection(null);
    const timeout = setTimeout(() => { abort.abort(); if (active) setCatalogError('Loading the recorded groups timed out. Retry when ready.'); }, 65_000);
    void requestCustomCohortOperation(accountId, 'catalog', {
      assignment_file_id: assignmentFileId, context_ref: contextRef, selection: input.selection,
    }, { signal: abort.signal }).then(value => {
      if (!active || abort.signal.aborted) return;
      const checked = checkCustomCohortPocketCatalog(value, input);
      // Begin broad: all retained discovered accounts, including unresolved
      // groups. No sale-count target and no unsupported automatic recommendation.
      setCatalog(checked); setIncluded(customCohortCatalogGroupIds(checked)); setRevision(1);
    }).catch(() => {
      if (active && !abort.signal.aborted) setCatalogError('Recorded groups are unavailable. The saved report has not changed.');
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); abort.abort(); };
  }, [accountId, assignmentFileId, contextRef, input, reload]);

  useEffect(() => {
    if (catalog) controller.current?.setSelection({ ...input,
      selection: selectionFromRecordedGroups(catalog, included, revision) });
  }, [catalog, included, input, revision]);

  const choose = (ids: readonly string[]) => { setIncluded(ids); setRevision(n => n + 1); };
  const toggle = (id: string) => choose(included.includes(id) ? included.filter(value => value !== id) : [...included, id]);
  const groups = catalog ? [...catalog.pockets.map(p => ({ id: p.id, label: p.label, county: p.county, count: p.member_count })),
    ...(catalog.unassigned.member_count ? [{ id: CUSTOM_COHORT_UNASSIGNED_GROUP, label: 'Unassigned / conflicting recorded names',
      county: 'Needs review', count: catalog.unassigned.member_count }] : [])] : [];
  const selectedGroup = groups.find(p => p.id === inspected);
  const pending = preview.status === 'debouncing' || preview.status === 'loading';

  return <section aria-label="Neighborhood pocket exploration" className="space-y-4 rounded-2xl border border-violet-200 p-4 print:hidden">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-base font-semibold">Neighborhood pocket exploration</h3>
        <p className="text-sm opacity-80">{subjectLabel} · Recorded CAD groups in the retained discovery area</p></div>
      <span className="rounded-full border border-amber-300 px-3 py-1 text-xs">Preview only · report unchanged</span>
    </header>
    <p className="text-sm">Explore broad observations, then include or exclude recorded groups. These parcel shapes are not legal subdivision
      or appraiser-defined neighborhood boundaries. Similarity, reliability and report-ready recommendations are not established by this preview.</p>
    {!catalog && !catalogError && <p role="status">Loading recorded groups…</p>}
    {catalogError && <div role="alert" className="space-y-2"><p>{catalogError}</p>
      <button type="button" className={button} onClick={() => setReload(n => n + 1)}>Retry group loading</button></div>}
    {catalog && <>
      {catalog.status === 'incomplete' && <p role="alert">The recorded-name catalog is incomplete. All discovered accounts remain in the unresolved group;
        no partial set of named groups has been substituted.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => choose(customCohortCatalogGroupIds(catalog))}>Include all observations</button>
        <button type="button" className={button} onClick={() => choose([])}>Exclude all</button>
        <button type="button" className={button} disabled={!catalog.subject_membership.assigned_pocket_id}
          onClick={() => { const id = catalog.subject_membership.assigned_pocket_id; if (id) choose([id]); }}>
          Preview subject’s recorded group</button>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {pending ? 'Updating the map and statistics together…' : preview.status === 'failed'
          ? 'The preview could not update. Any displayed map and statistics are from the preceding selection.'
          : preview.status === 'ready' ? 'Map and statistics match the current preview selection.' : 'Preparing observations…'}
      </p>
      {preview.status === 'failed' && <button type="button" className={button} onClick={() => setRevision(n => n + 1)}>Retry preview</button>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        {preview.group ? <CustomCohortParcelMap group={preview.group} catalog={catalog} freshness={preview.freshness}
          inspectedPocketId={inspected} onInspectPocket={setInspected}
          onInspectAccount={account => { if (catalog.unassigned.account_ids.includes(account)) setInspected(CUSTOM_COHORT_UNASSIGNED_GROUP); }} />
          : <p role="status" className="grid min-h-80 place-content-center rounded-xl border border-violet-200 p-4">Waiting for a coherent map and statistics…</p>}
        <aside className="space-y-3 rounded-xl border border-violet-200 p-3" aria-label="Recorded groups">
          <label className="block text-sm">Find a recorded group<input value={search} maxLength={200}
            onChange={event => setSearch(event.target.value)} className="input input-bordered mt-1 w-full" /></label>
          <div className="max-h-80 space-y-2 overflow-auto">
            {groups.filter(p => `${p.label} ${p.county}`.toLowerCase().includes(search.toLowerCase())).map(p =>
              <div key={p.id} className="flex items-start gap-2 rounded-lg border border-violet-100 p-2">
                <input type="checkbox" aria-label={`Include ${p.label}`} checked={included.includes(p.id)} onChange={() => toggle(p.id)} />
                <button type="button" className="min-w-0 flex-1 text-left text-sm" onClick={() => setInspected(p.id)}
                  aria-pressed={inspected === p.id}><span className="block font-medium">{p.label}</span>
                  <span className="text-xs opacity-75">{p.count.toLocaleString('en-US')} accounts · {p.county}</span></button>
              </div>)}
          </div>
          {selectedGroup && <div className="space-y-2 border-t border-violet-200 pt-3">
            <h4 className="font-semibold">{selectedGroup.label}</h4><p className="text-sm">{selectedGroup.count.toLocaleString('en-US')} retained accounts.
              Recorded-name grouping requires review; builder, HOA dues, amenities and legal phases are not inferred.</p>
            <button type="button" className={button} onClick={() => toggle(selectedGroup.id)}>
              {included.includes(selectedGroup.id) ? 'Exclude this group' : 'Include this group'}</button>
          </div>}
        </aside>
      </div>
      <CustomCohortStatistics group={preview.group} freshness={preview.freshness} />
      {selectedGroup && <CustomCohortPocketInspector input={input} catalog={catalog}
        pocketId={selectedGroup.id} label={selectedGroup.label} />}
    </>}
  </section>;
}
