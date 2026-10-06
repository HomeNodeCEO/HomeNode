import { useEffect, useRef, useState } from 'react';
import { createCustomCohortGroupWorkspaceLifecycle } from '../customCohortGroupWorkspaceLifecycle';
import type { CustomCohortGroupWorkspaceLifecycleState } from '../customCohortGroupWorkspaceLifecycle';
import type { createCustomCohortGroupWorkspaceApi } from '../customCohortGroupWorkspaceApi';
import type { CustomWorkspaceTarget, CustomWorkspaceOperationOptions } from '../customWorkspaceLifecycle';
import type { CustomWorkspaceObservationPeriod, CustomWorkspaceDiscovery } from '../customWorkspaceCheckpoint';
import { hasValidCustomWorkspaceObservationPeriod } from '../customWorkspaceCheckpoint';
import { createCustomWorkspaceRequestLane, CUSTOM_WORKSPACE_CAPTURE_TIMEOUT_MS } from '../customWorkspaceRequestLane';
import { createCustomCohortGroupMemberReader } from '../customCohortGroupMemberView';
import type { CustomCohortGroupDisplay } from '../customCohortGroupDisplay';
import type { CheckedPocketCatalog } from '../customCohortPocketCatalog';
import type { CustomNeighborhoodWorkspaceControls } from './CustomNeighborhoodWorkspaceHost';
import CustomCohortWorkspace from './CustomCohortWorkspace';
import type { CustomCohortExactWorkspace } from './CustomCohortWorkspace';
import CustomReportedObservationAdoption from './CustomReportedObservationAdoption';
import cityCatalog from '../../../data/neighborhoodCityBoundaries.json';

interface Props {
  target: CustomWorkspaceTarget; subjectLabel: string;
  initialPeriod: CustomWorkspaceObservationPeriod | null;
  defaultPeriod?: CustomWorkspaceObservationPeriod | null;
  workfileStatus: 'draft' | 'signed' | 'archived'; enabled: boolean;
  api: ReturnType<typeof createCustomCohortGroupWorkspaceApi>;
  /** Explicit policy only. Never silently choose all or run a recommendation. */
  initialGroups: (catalog: CheckedPocketCatalog) => readonly string[];
  registerControls?: (controls: CustomNeighborhoodWorkspaceControls | null) => void;
  onAccepted?: () => Promise<boolean>;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const RADII = { '1': '1609.344', '2': '3218.688', '3': '4828.032', '5': '8046.72', '10': '16093.44' } as const;
type Miles = keyof typeof RADII;
const cities = cityCatalog.cities.map(city => ({ name: city.name, discovery: { profile_id: 'custom-city-polygon-v1' as const,
  city: { geoid: city.geoid, vintage: cityCatalog.vintage, asset_sha256: city.sha256 } } }));
const scopeKey = (d?: CustomWorkspaceDiscovery): string => d?.profile_id === 'custom-city-polygon-v1'
  ? `city:${d.city.geoid}:${d.city.vintage}:${d.city.asset_sha256}`
  : (Object.keys(RADII) as Miles[]).find(key => RADII[key] === d?.radius_metres) ?? '3';
const scopeLabel = (d?: CustomWorkspaceDiscovery): string => d?.profile_id === 'custom-city-polygon-v1'
  ? `${cities.find(c => scopeKey(c.discovery) === scopeKey(d))?.name ?? `City GEOID ${d.city.geoid}`} city polygon (${d.city.vintage})`
  : `${scopeKey(d)}-mile radius`;
const fault = (reason: string) => new Error(`custom_workspace_${reason}`);

/** Opt-in V7 host. No production mounting or legacy checkpoint migration here.
 * A fresh authenticated workfile read precedes every initial owner. One keyed
 * finite lane owns commands, coherent opening, exact detail, independent subset
 * inspections and report operations; no cache or browser reference grants access. */
export default function CustomCohortGroupWorkspaceHost(props: Props) {
  if (!props.enabled) return null;
  if (props.workfileStatus !== 'draft') return <p className="print:hidden" role="status">
    Neighborhood exploration is read-only for this {props.workfileStatus} file. Its saved report has not changed.</p>;
  const t = props.target;
  return <HostSession key={JSON.stringify([t.accountId, t.assignmentFileId, t.sessionKey])} {...props} />;
}

function HostSession(props: Props) {
  const [initial] = useState(() => ({ ...props, target: Object.freeze({ ...props.target }),
    initialPeriod: props.initialPeriod ? Object.freeze({ ...props.initialPeriod }) : null,
    defaultPeriod: props.defaultPeriod ? Object.freeze({ ...props.defaultPeriod }) : null }));
  const [state, setState] = useState<CustomCohortGroupWorkspaceLifecycleState | null>(null);
  const [start, setStart] = useState(initial.initialPeriod?.start_date ?? initial.defaultPeriod?.start_date ?? '');
  const [end, setEnd] = useState(initial.initialPeriod?.end_date ?? initial.defaultPeriod?.end_date ?? '');
  const [scope, setScope] = useState<CustomWorkspaceDiscovery | undefined>(undefined);
  const scopeRef = useRef<CustomWorkspaceDiscovery | undefined>(undefined), scopeBinding = useRef<string | null>(null);
  const [readOnly, setReadOnly] = useState(false), readonlyRef = useRef(false);
  const [locked, setLocked] = useState(false), lockedRef = useRef(false);
  const [actionPending, setActionPending] = useState(false), actionFailed = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reportEpoch, setReportEpoch] = useState(0);
  const [reportUncertain, setReportUncertain] = useState(false), reportUncertainRef = useRef(false);
  const [reportRecovery, setReportRecovery] = useState(false), reportRecoveryRef = useRef(false);
  const owner = useRef<ReturnType<typeof createCustomCohortGroupWorkspaceLifecycle> | null>(null);
  const lane = useRef<ReturnType<typeof createCustomWorkspaceRequestLane> | null>(null);
  const currentAction = useRef<Promise<boolean> | null>(null);
  const live = useRef(false), generation = useRef(0);
  const freshAbort = useRef<AbortController | null>(null), reportAbort = useRef<AbortController | null>(null);
  const period = useRef({ start_date: start, end_date: end }); period.current = { start_date: start, end_date: end };
  const validPeriod = hasValidCustomWorkspaceObservationPeriod(period.current);

  function act(action: () => Promise<unknown>, report = false) {
    if (!live.current || readonlyRef.current || lockedRef.current || currentAction.current
      || (!report && (reportUncertainRef.current || reportRecoveryRef.current))) return Promise.resolve(false);
    const epoch = generation.current; actionFailed.current = false; setMessage(null); setActionPending(true);
    const task = Promise.resolve().then(async () => {
      // A retained callback or signing transition cannot enter after admission.
      if (!live.current || generation.current !== epoch || readonlyRef.current || lockedRef.current) return false;
      await action(); return true;
    }).catch(() => {
      if (live.current && generation.current === epoch) {
        if (report) { reportRecoveryRef.current = true; setReportRecovery(true); }
        else { actionFailed.current = true; setMessage('The neighborhood could not be updated. Try again.'); }
      }
      return false;
    }).finally(() => {
      if (currentAction.current === task) { currentAction.current = null;
        if (live.current && generation.current === epoch) setActionPending(false); }
    });
    currentAction.current = task; return task;
  }
  function restoreScope(next: CustomCohortGroupWorkspaceLifecycleState) {
    const c = next.checkpoint, key = c?.pending_capture?.operation_id ?? c?.active?.context_ref.context_id ?? null;
    if (key === scopeBinding.current) return;
    scopeBinding.current = key; const d = c?.pending_capture?.discovery ?? c?.active?.discovery;
    scopeRef.current = d; setScope(d);
  }
  function discovery(): CustomWorkspaceDiscovery {
    const d = scopeRef.current;
    if (d?.profile_id === 'custom-city-polygon-v1' && !cities.some(c => scopeKey(c.discovery) === scopeKey(d)))
      throw fault('city_not_installed');
    return d ?? { profile_id: 'custom-suburban-radius-v2', radius_metres: RADII['3'] };
  }
  function admitDisplay(display: CustomCohortGroupDisplay) {
    const current = owner.current?.getState();
    if (!live.current || readonlyRef.current || lockedRef.current || currentAction.current || actionFailed.current
      || reportUncertainRef.current || reportRecoveryRef.current || current?.status !== 'ready' || current.operation_pending
      || current.recovery || current.checkpoint?.pending_capture || current.display_freshness !== 'current'
      || current.display !== display || display.target.accountId !== initial.target.accountId
      || display.target.assignmentFileId !== initial.target.assignmentFileId || display.target.sessionKey !== initial.target.sessionKey)
      throw fault('read_only');
  }
  function read<T>(display: CustomCohortGroupDisplay, io: CustomWorkspaceOperationOptions,
    task: (options: CustomWorkspaceOperationOptions) => Promise<T>) {
    try {
      admitDisplay(display);
      if (!(io.signal instanceof AbortSignal) || !Number.isFinite(io.deadline) || io.deadline <= performance.now()) throw fault('deadline');
      const requests = lane.current; if (!requests) throw fault('target_changed');
      const timeoutMs = Math.max(1, Math.min(65_000, Math.ceil(io.deadline - performance.now())));
      const epoch = generation.current;
      return requests.run(({ signal }) => {
        // Queued work is checked again at actual admission, not just at click.
        admitDisplay(display); if (io.signal.aborted || io.deadline <= performance.now()) throw fault('deadline');
        return task({ ...io, signal });
      }, { signal: io.signal, timeoutMs }).catch(error => {
        // A timed-out detail call may still own remote work. Expose explicit
        // checked recovery; never silently reopen this quarantined lane.
        if (live.current && generation.current === epoch && requests.needsRecovery()) {
          actionFailed.current = true; setMessage('The neighborhood could not be updated. Try again.');
        }
        throw error;
      });
    } catch (error) { return Promise.reject(error); }
  }
  const [readViewport] = useState<CustomCohortExactWorkspace['readViewport']>(() => (...[display, window, io]: Parameters<CustomCohortExactWorkspace['readViewport']>) =>
    read(display, io, options => initial.api.map(display, window, options)));
  const [readMembers] = useState<CustomCohortExactWorkspace['readMembers']>(() => {
    const reader = createCustomCohortGroupMemberReader(initial.api);
    return (...[display, kind, page, io, previous]: Parameters<CustomCohortExactWorkspace['readMembers']>) => read(display, io, options => reader(display, kind, page, options, previous));
  });
  function inspectedDisplay(input: { accountId: string; assignmentFileId: string; contextRef: object; selection: { revision: number } }) {
    const display = owner.current?.getState().display;
    if (!display || input.accountId !== initial.target.accountId || input.assignmentFileId !== initial.target.assignmentFileId
      || JSON.stringify(input.contextRef) !== JSON.stringify(display.active.context_ref)
      || input.selection.revision !== display.active.selection_ref.selection_revision) throw fault('context_changed');
    admitDisplay(display); return display;
  }
  const [inspectionPreview] = useState<CustomCohortExactWorkspace['inspectionPreview']>(() => (...[input, options]: Parameters<CustomCohortExactWorkspace['inspectionPreview']>) => {
    try { return read(inspectedDisplay(input), { signal: options.signal, deadline: performance.now() + 65_000 },
      io => { inspectedDisplay(input); return initial.api.inspectionPreview(input, io); }); } catch (error) { return Promise.reject(error); }
  });
  const [inspectionMembers] = useState<CustomCohortExactWorkspace['inspectionMembers']>(() => (...[input, population, page, options]: Parameters<CustomCohortExactWorkspace['inspectionMembers']>) => {
    try { return read(inspectedDisplay(input), { signal: options.signal, deadline: performance.now() + 65_000 },
      io => { inspectedDisplay(input); return initial.api.inspectionMembers(input, population, page, io); }); } catch (error) { return Promise.reject(error); }
  });

  async function reload(bootstrap = false) {
    const requests = lane.current, epoch = generation.current;
    if (!requests || (owner.current && !owner.current.isSettled())) throw fault('busy');
    await requests.flush().catch(() => {});
    if (!requests.isIdle()) throw fault('busy');
    // Only an explicit checked recovery opens a deadline-quarantined lane.
    if (requests.needsRecovery()) requests.recover();
    const abort = new AbortController(); freshAbort.current = abort;
    try {
      const deadline = performance.now() + 65_000;
      const fresh = await requests.run(({ signal }) => initial.api.read(initial.target, { signal, deadline }), { signal: abort.signal });
      if (!live.current || generation.current !== epoch || abort.signal.aborted) return;
      if (fresh.status !== 'draft') { lockedRef.current = true; setLocked(true); owner.current?.dispose(); owner.current = null; setState(null); return; }
      if (owner.current) await owner.current.reload({ target: fresh.target, section: fresh.section });
      else {
        // One action already owns these serial continuations. Quiescence closes
        // NEW consumer/action admission but flush still waits this whole action.
        const run = <T,>(io: CustomWorkspaceOperationOptions, task: (value: CustomWorkspaceOperationOptions) => Promise<T>, capture = false) =>
          requests.run(({ signal }) => {
            if (!live.current || generation.current !== epoch || lockedRef.current || io.signal.aborted || io.deadline <= performance.now()) throw fault('target_changed');
            return task({ ...io, signal });
          }, { signal: io.signal, ...(capture ? { timeoutMs: CUSTOM_WORKSPACE_CAPTURE_TIMEOUT_MS } : {}) });
        const api = initial.api;
        const lifecycle = createCustomCohortGroupWorkspaceLifecycle({ target: fresh.target, initialSection: fresh.section,
          start: (r, io) => run(io, options => api.start(r, options)), cancel: (r, io) => run(io, options => api.cancel(r, options)),
          complete: (r, io) => run(io, options => api.complete(r, options)), save: (r, io) => run(io, options => api.save(r, options)),
          capture: (r, io) => run(io, options => api.capture(r, options), true), catalog: (r, io) => run(io, options => api.catalog(r, options)),
          readSelection: (r, io) => run(io, options => api.readSelection(r, options)), display: (r, io) => run(io, options => api.display(r, options)),
          initialGroups: initial.initialGroups, onChange: next => {
            if (live.current && generation.current === epoch) { restoreScope(next); setState(next); }
          } });
        owner.current = lifecycle; restoreScope(lifecycle.getState()); setState(lifecycle.getState());
        const current = lifecycle.getState();
        if (current.checkpoint?.active) await lifecycle.reopen();
        else if (bootstrap && current.status === 'idle' && !current.checkpoint?.pending_capture
          && hasValidCustomWorkspaceObservationPeriod(initial.initialPeriod)) await lifecycle.start(initial.initialPeriod!, undefined, discovery());
      }
      if (live.current && generation.current === epoch) setReportEpoch(value => value + 1);
    } finally { if (freshAbort.current === abort) freshAbort.current = null; }
  }
  useEffect(() => {
    live.current = true; const epoch = ++generation.current, requests = createCustomWorkspaceRequestLane(); lane.current = requests;
    initial.registerControls?.({ target: initial.target,
      setReadOnly: value => { if (live.current && generation.current === epoch) { readonlyRef.current = value; setReadOnly(value); } },
      useReviewedSales: reference => !live.current || generation.current !== epoch || !owner.current || !hasValidCustomWorkspaceObservationPeriod(period.current)
        ? Promise.resolve(false) : act(() => owner.current!.start({ ...period.current }, reference, discovery())),
      flush: async () => {
        try { await currentAction.current; await requests.flush(); const current = owner.current?.getState();
          return live.current && generation.current === epoch && !currentAction.current && !lockedRef.current && !actionFailed.current
            && !reportUncertainRef.current && !reportRecoveryRef.current && Boolean(owner.current?.isSettled()) && requests.isIdle()
            && Boolean(current && !current.recovery && !current.checkpoint?.pending_capture && ['idle', 'ready'].includes(current.status)
              && (current.status !== 'ready' || current.display_freshness === 'current'));
        } catch { return false; }
      } });
    void act(() => reload(true));
    return () => {
      live.current = false; generation.current = epoch + 1; currentAction.current = null;
      freshAbort.current?.abort(); reportAbort.current?.abort(); owner.current?.dispose(); requests.dispose();
      owner.current = null; lane.current = null; initial.registerControls?.(null);
    };
  }, [initial]);

  async function recover() {
    await reload(); if (lockedRef.current) return;
    const lifecycle = owner.current, current = lifecycle?.getState();
    if (current?.recovery === 'retry_exact') await lifecycle!.retryExact();
    else if (current?.checkpoint?.pending_capture && (!current.recovery || current.recovery === 'resume_pending')) await lifecycle!.resumePending();
  }
  async function setAside() {
    await reload(); if (lockedRef.current) return;
    const lifecycle = owner.current, current = lifecycle?.getState();
    if (current?.checkpoint?.pending_capture && (!current.recovery || current.recovery === 'resume_pending')) await lifecycle!.setAsidePending();
  }
  function runReportTask(task: (io: CustomWorkspaceOperationOptions) => Promise<void>) {
    const current = owner.current?.getState();
    if (actionFailed.current || current?.status !== 'ready' || current.recovery || current.checkpoint?.pending_capture
      || current.display_freshness !== 'current' || current.display !== state?.display || (reportRecoveryRef.current && !lane.current?.isIdle())) return Promise.resolve(false);
    return act(async () => {
      const requests = lane.current, lifecycle = owner.current, current = lifecycle?.getState();
      if (!requests || !lifecycle?.isSettled() || current?.status !== 'ready' || current.recovery
        || current.checkpoint?.pending_capture || current.display_freshness !== 'current' || current.display !== state?.display) throw fault('busy');
      if (reportRecoveryRef.current) { if (!requests.isIdle()) throw fault('busy'); requests.recover(); }
      await requests.flush(); const abort = new AbortController(); reportAbort.current = abort;
      const epoch = generation.current, deadline = performance.now() + 65_000;
      try {
        await requests.run(({ signal }) => task({ signal, deadline }), { signal: abort.signal });
        if (live.current && generation.current === epoch) { reportRecoveryRef.current = false; setReportRecovery(false); }
      } finally { if (reportAbort.current === abort) reportAbort.current = null; }
    }, true);
  }
  const saving = actionPending || Boolean(state?.operation_pending) || state?.status === 'busy';
  const busy = saving || readOnly || locked;
  const blockedReason = readOnly || locked ? 'read_only' : actionFailed.current || message
    || state?.recovery || state?.status === 'invalid' || state?.status === 'error' ? 'reload_required'
    : state?.checkpoint?.pending_capture ? 'pending_capture' : state?.status === 'ready' || state?.status === 'idle' ? null : 'reload_required';
  const explorationBlocked = blockedReason ?? (reportUncertain || reportRecovery ? 'reload_required' : null);
  const display = state?.display, installed = scope?.profile_id !== 'custom-city-polygon-v1' || cities.some(c => scopeKey(c.discovery) === scopeKey(scope));
  const recoveryNeeded = Boolean(actionFailed.current || message || state?.recovery || state?.status === 'error' || state?.checkpoint?.pending_capture || (!state && !actionPending));
  return <section className="space-y-3 print:hidden" aria-label="Saved neighborhood workspace">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-violet-200 p-3">
      <label className="text-sm">Observation start<input type="date" className="input input-bordered block" value={start} disabled={busy}
        onChange={event => setStart(event.target.value)} /></label>
      <label className="text-sm">Observation end<input type="date" className="input input-bordered block" value={end} disabled={busy}
        onChange={event => setEnd(event.target.value)} /></label>
      <label className="text-sm">Analytical study area<select className="select select-bordered block" value={scopeKey(scope)} disabled={busy || Boolean(explorationBlocked)}
        onChange={event => { const key = event.target.value, choice = Object.hasOwn(RADII, key)
          ? { profile_id: 'custom-suburban-radius-v2' as const, radius_metres: RADII[key as Miles] } : cities.find(c => scopeKey(c.discovery) === key)?.discovery;
          if (choice) { scopeRef.current = choice; setScope(choice); } }}>
        <optgroup label="Radius">{(Object.keys(RADII) as Miles[]).map(m => <option key={m} value={m}>{m} {m === '1' ? 'mile' : 'miles'}{m === '3' ? ' — default' : ''}</option>)}</optgroup>
        <optgroup label="Installed city polygons">{cities.map(c => <option key={c.discovery.city.geoid} value={scopeKey(c.discovery)}>{c.name} — {c.discovery.city.vintage} polygon</option>)}</optgroup>
        {!installed && <option value={scopeKey(scope)} disabled>{scopeLabel(scope)} — retained; not installed for new capture</option>}
      </select></label>
      <button type="button" className={button} disabled={busy || !validPeriod || !installed || Boolean(explorationBlocked)} onClick={() => {
        if (!explorationBlocked && owner.current && hasValidCustomWorkspaceObservationPeriod(period.current)) void act(() => owner.current!.start({ ...period.current }, undefined, discovery()));
      }}>{scope?.profile_id === 'custom-city-polygon-v1' ? `Explore ${scopeLabel(scope)}` : `Explore ${scopeKey(scope)}-mile area`}</button>
      {recoveryNeeded && <button type="button" className={button} disabled={busy || reportUncertain || reportRecovery} onClick={() => { void act(recover); }}>Try again</button>}
      {state?.checkpoint?.pending_capture && <button type="button" className={button} disabled={busy || reportUncertain || reportRecovery}
        onClick={() => { void act(setAside); }}>Choose a different area</button>}
    </div>
    {(start || end) && !validPeriod && <p role="alert" className="text-sm">Choose valid observation start and end dates, with the start on or before the end. No study has been requested for these dates.</p>}
    <p role="status" className="text-sm">{locked ? 'This file is no longer editable. Its saved report is unchanged.' : saving ? 'Updating neighborhood…'
      : readOnly ? 'Neighborhood analysis is read-only while the report is being finalized.' : state?.status === 'ready' && !blockedReason
        ? 'Neighborhood ready. Statistics update with the selected subdivisions.' : 'Choose an area to begin.'}</p>
    {(message || state?.status === 'invalid' || state?.status === 'error') && <p role="alert" className="text-sm">{message ?? 'The neighborhood could not be loaded. Try again.'}</p>}
    {reportRecovery && <p role="alert" className="text-sm">The report did not finish updating. Try again.</p>}
    {display && !locked && <CustomCohortWorkspace accountId={initial.target.accountId} assignmentFileId={initial.target.assignmentFileId}
      sessionKey={initial.target.sessionKey} contextRef={display.active.context_ref} subjectLabel={initial.subjectLabel} enabled exact={{ display,
        freshness: state?.display_freshness === 'current' ? 'current' : 'stale', saving, blockedReason: explorationBlocked, readViewport, readMembers, inspectionPreview, inspectionMembers,
        onSelectionIntent: ids => { try { admitDisplay(display); const included = Object.freeze([...ids]); void act(() => owner.current!.setGroups(included)); }
          catch { /* Retained/stale callbacks cannot enqueue a command. */ } } }} />}
    {display && state?.status === 'ready' && state.section_revision !== null && !locked && <CustomReportedObservationAdoption
      key={JSON.stringify([display.active.context_ref, state.section_revision, reportEpoch])} target={initial.target} contextRef={display.active.context_ref}
      workspaceRevision={state.section_revision} api={initial.api} disabled={busy || Boolean(blockedReason)} run={runReportTask}
      onOutcomeUncertain={value => { if (live.current && owner.current?.getState().display === display) {
        reportUncertainRef.current = value; setReportUncertain(value); } }} onAccepted={initial.onAccepted} />}
  </section>;
}
