import { useEffect, useRef, useState } from 'react';
import { createCustomWorkspaceLifecycle } from '../customWorkspaceLifecycle';
import type { CustomWorkspaceLifecycleState, CustomWorkspaceOperationOptions, CustomWorkspaceTarget } from '../customWorkspaceLifecycle';
import type { CustomWorkspaceObservationPeriod, CustomWorkspacePrivateSalesImport, CustomWorkspaceDiscovery } from '../customWorkspaceCheckpoint';
import { createCustomWorkspaceRequestLane } from '../customWorkspaceRequestLane';
import type { createCustomWorkspaceApi } from '../customWorkspaceApi';
import type { CustomCohortPreviewRequest } from '../customCohortPreviewController';
import type { CustomCohortMemberTransport } from '../customCohortPreviewTransport';
import CustomCohortWorkspace from './CustomCohortWorkspace';
import CustomReportedObservationAdoption from './CustomReportedObservationAdoption';
import cityCatalog from '../../../data/neighborhoodCityBoundaries.json';

export interface CustomNeighborhoodWorkspaceControls {
  readonly target: CustomWorkspaceTarget;
  /** Save Everything must await this before reporting success. Exploration is
   * independently persisted intent, never accepted report output. */
  flush: () => Promise<boolean>;
  /** The report host quiesces editing before readiness/signing and releases it
   * if signing fails. This does not grant signing authority. */
  setReadOnly: (value: boolean) => void;
  /** Explicit new capture, using this host's displayed study period. */
  useReviewedSales?: (reference: CustomWorkspacePrivateSalesImport) => Promise<boolean>;
}
interface Props {
  target: CustomWorkspaceTarget; subjectLabel: string; initialSection: unknown;
  initialPeriod: CustomWorkspaceObservationPeriod | null;
  workfileStatus: 'draft' | 'signed' | 'archived'; enabled: boolean;
  api: ReturnType<typeof createCustomWorkspaceApi>;
  registerControls?: (controls: CustomNeighborhoodWorkspaceControls | null) => void;
  onAccepted?: () => Promise<boolean>;
}
const button = 'hn-action-secondary btn btn-sm normal-case';
const CAPTURE_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  capture_authentication_required: 'Sign in again, then reload saved choices before resuming the same saved capture.',
  capture_access_denied: 'Your current access does not allow this capture. Confirm assignment and source access, then reload saved choices before resuming the same saved capture.',
  capture_disabled: 'Neighborhood capture is currently disabled in this environment. Contact your administrator, then reload saved choices before resuming the same saved capture.',
  capture_context_unavailable: 'The saved capture target is unavailable. Reload this appraisal file and its saved choices before continuing.',
  capture_source_unavailable: 'Required recorded source data is unavailable or exceeds capture limits. Reload saved choices before resuming the same saved capture or setting it aside.',
  capture_capacity_exceeded: 'The complete study exceeds the current processing capacity. No properties were trimmed and no partial results were applied. Reload saved choices to keep or set aside this pending capture; repeating it unchanged will not resolve a size limit.',
  capture_private_source_review_required: 'The selected private-sales source needs its source-use review completed. Then reload saved choices and set aside the pending capture before choosing the reviewed revision.',
  capture_private_source_limit: 'The selected private-sales source exceeds the capture limits. Reload saved choices, then set aside the pending capture before choosing a smaller reviewed source.',
  capture_private_review_changed: 'The selected private-sales review changed. Reload saved choices, then set aside the pending capture before choosing the updated review.',
  capture_private_source_read_only: 'This appraisal file is no longer editable for a private-sales capture. Reload this appraisal file before continuing.',
  capture_operation_conflict: 'This saved capture conflicts with an existing operation. Reload saved choices and review the pending capture; do not retry it with changed inputs.',
  capture_subject_changed: 'The subject data changed during capture. Reload saved choices and review the subject before deciding whether to set aside the pending capture.',
  capture_target_changed: 'The appraisal target changed during capture. Reload this appraisal file and its saved choices before continuing.',
  capture_market_policy_changed: 'Source access changed during capture. Confirm source access, then reload saved choices before continuing.',
  capture_outcome_unknown: 'The server could not confirm whether this capture was recorded. Reload saved choices, then use “Resume saved capture” to recover the same saved operation. Do not start another capture to resolve this request.',
  capture_interrupted: 'The capture request was interrupted or reached its time limit. Reload saved choices, then use “Resume saved capture” to retry the same saved operation.',
});
const RADII = { '3': '4828.032', '5': '8046.72', '10': '16093.44' } as const;
type RadiusMiles = keyof typeof RADII;
const scopeKey = (discovery?: CustomWorkspaceDiscovery): string => discovery?.profile_id === 'custom-city-polygon-v1'
  ? `city:${discovery.city.geoid}:${discovery.city.vintage}:${discovery.city.asset_sha256}`
  : discovery?.radius_metres === RADII['10'] ? '10' : discovery?.radius_metres === RADII['5'] ? '5' : '3';
const CITIES = cityCatalog.cities.map(city => ({ name: city.name, discovery: { profile_id: 'custom-city-polygon-v1' as const,
  city: { geoid: city.geoid, vintage: cityCatalog.vintage, asset_sha256: city.sha256 } } }));
const scopeLabel = (discovery?: CustomWorkspaceDiscovery): string => discovery?.profile_id === 'custom-city-polygon-v1'
  ? `${CITIES.find(entry => scopeKey(entry.discovery) === scopeKey(discovery))?.name ?? `City GEOID ${discovery.city.geoid}`} city polygon (${discovery.city.vintage})`
  : `${scopeKey(discovery)}-mile radius`;

/** Explicitly injected Custom-only host. A mounted caller must first obtain a
 * verified current account/file/session workfile read. No local browser draft,
 * latest-context lookup, accepted-report calculation or browser evidence lives
 * here. Repeated autosave prop objects do not restart this keyed session.
 */
export default function CustomNeighborhoodWorkspaceHost(props: Props) {
  if (!props.enabled) return null;
  if (props.workfileStatus !== 'draft') return <p className="print:hidden" role="status">
    Neighborhood exploration is read-only for this {props.workfileStatus} file. Its saved report has not changed.</p>;
  const { target } = props;
  return <HostSession key={JSON.stringify([target.accountId, target.assignmentFileId, target.sessionKey])} {...props} />;
}

function HostSession(props: Props) {
  const [initial] = useState(() => props);
  const [state, setState] = useState<CustomWorkspaceLifecycleState | null>(null);
  const [lastReady, setLastReady] = useState<CustomWorkspaceLifecycleState | null>(null);
  const [start, setStart] = useState(initial.initialPeriod?.start_date ?? '');
  const [end, setEnd] = useState(initial.initialPeriod?.end_date ?? '');
  const [scope, setScope] = useState<CustomWorkspaceDiscovery | undefined>(undefined);
  const scopeRef = useRef<CustomWorkspaceDiscovery | undefined>(undefined);
  const scopeBinding = useRef<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [locked, setLocked] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reportEpoch, setReportEpoch] = useState(0);
  const [reportUncertain, setReportUncertain] = useState(false);
  const reportUncertainRef = useRef(false);
  const [reportRecovery, setReportRecovery] = useState(false);
  const reportRecoveryRef = useRef(false);
  const owner = useRef<ReturnType<typeof createCustomWorkspaceLifecycle> | null>(null);
  const lane = useRef<ReturnType<typeof createCustomWorkspaceRequestLane> | null>(null);
  const currentAction = useRef<Promise<unknown> | null>(null);
  const readonlyRef = useRef(false);
  const lockedRef = useRef(false);
  const actionFailed = useRef(false);
  const live = useRef(false);
  const generation = useRef(0);
  const reloadAbort = useRef<AbortController | null>(null);
  const reportAbort = useRef<AbortController | null>(null);
  const period = useRef({ start_date: start, end_date: end }); period.current = { start_date: start, end_date: end };

  function captureDiscovery(): CustomWorkspaceDiscovery | undefined {
    const selected = scopeRef.current;
    if (selected?.profile_id === 'custom-city-polygon-v1') {
      if (!CITIES.some(entry => scopeKey(entry.discovery) === scopeKey(selected))) throw new Error('custom_workspace_city_not_installed');
      return selected;
    }
    // Preserve omitted legacy three-mile requests; city -> radius stays explicit.
    if (scopeKey(selected) === '3' && (owner.current?.getState().checkpoint?.workspace_version ?? 1) < 3) return undefined;
    return selected ?? { profile_id: 'custom-suburban-radius-v2', radius_metres: RADII['3'] };
  }
  function restoreScope(next: CustomWorkspaceLifecycleState) {
    const checkpoint = next.checkpoint;
    const binding = checkpoint?.pending_capture?.operation_id ?? checkpoint?.active?.context_ref.context_id ?? null;
    if (binding === scopeBinding.current) return;
    scopeBinding.current = binding;
    const discovery = checkpoint?.pending_capture?.discovery ?? checkpoint?.active?.discovery;
    scopeRef.current = discovery; setScope(discovery);
  }

  // One owned action at a time, without reflecting per-request progress in the
  // page-wide assignment autosave state. Invalid/uncertain saves stay visible.
  function act(action: () => Promise<unknown>, report = false) {
    if (!live.current || readonlyRef.current || lockedRef.current || currentAction.current) return Promise.resolve(false);
    if (!report && (reportUncertainRef.current || reportRecoveryRef.current)) return Promise.resolve(false);
    const epoch = generation.current;
    actionFailed.current = false; setMessage(null); setActionPending(true);
    const task = Promise.resolve().then(() => {
      if (live.current && generation.current === epoch) return action().then(() => true);
      return false;
    }).catch(error => {
      if (live.current && generation.current === epoch) {
        if (report) { reportRecoveryRef.current = true; setReportRecovery(true); }
        else { actionFailed.current = true;
          const code = error instanceof Error && 'workspaceCode' in error ? error.workspaceCode : null;
          const cityFailure = code === 'city_subject_outside_scope' ? 'The subject is outside the selected city polygon.'
            : code === 'city_source_unavailable' ? 'The selected city polygon is unavailable for capture.' : null;
          const guidance = typeof code === 'string' && Object.hasOwn(CAPTURE_GUIDANCE, code) ? CAPTURE_GUIDANCE[code] : null;
          setMessage(cityFailure ? `${cityFailure} Reload saved choices, then use “Set aside pending capture” to choose another study area. This capture has not applied anything to the report.`
            : guidance ? `${guidance} This capture has not applied anything to the report.`
            : code === 'preview_capacity_exceeded' ? 'This captured study exceeds the preview capacity before its recorded groups can be loaded. Reload saved choices before resolving any pending capture. If the previous study reopens, set aside the pending capture before explicitly choosing a smaller study. Retrying the same oversized study may reach the same limit. This update has not applied anything to the report.'
            : 'The neighborhood workspace could not finish updating. Reload its saved choices before continuing. This update has not applied anything to the report.'); }
      }
      return false;
    }).finally(() => {
      if (currentAction.current === task) { currentAction.current = null;
        if (live.current && generation.current === epoch) setActionPending(false); }
    });
    currentAction.current = task;
    return task;
  }

  useEffect(() => {
    live.current = true; const epoch = ++generation.current;
    const requests = createCustomWorkspaceRequestLane(); lane.current = requests;
    const api = initial.api;
    const lifecycle = createCustomWorkspaceLifecycle({ target: initial.target, initialSection: initial.initialSection,
      save: (input, options) => requests.run(({ signal }) => api.save(input, { ...options, signal }), options),
      capture: (input, options) => requests.run(({ signal }) => api.capture(input, { ...options, signal }), options),
      catalog: (input, options) => requests.run(({ signal }) => api.catalog(input, { ...options, signal }), options),
      onChange: next => {
        if (!live.current || generation.current !== epoch) return;
        restoreScope(next); setState(next); if (next.status === 'ready' && next.catalog && next.selection) setLastReady(next);
      } });
    owner.current = lifecycle; restoreScope(lifecycle.getState()); setState(lifecycle.getState());
    initial.registerControls?.({ target: initial.target,
      useReviewedSales: reference => {
        if (!live.current || generation.current !== epoch || reportUncertainRef.current || reportRecoveryRef.current || !period.current.start_date || !period.current.end_date)
          return Promise.resolve(false);
        return act(() => lifecycle.start(period.current, reference, captureDiscovery()));
      },
      setReadOnly: value => { if (!live.current || generation.current !== epoch) return;
        readonlyRef.current = value; setReadOnly(value); },
      flush: async () => {
        try {
          await currentAction.current; await requests.flush();
          const current = lifecycle.getState();
          return live.current && generation.current === epoch && !currentAction.current && !lockedRef.current && !actionFailed.current
            && !reportUncertainRef.current && !reportRecoveryRef.current && lifecycle.isSettled() && requests.isIdle() && !current.recovery
            && !current.checkpoint?.pending_capture && ['idle', 'ready'].includes(current.status);
        } catch { return false; }
      } });
    // Reopen exactly the stored context. A new file may start once when its
    // caller supplies the actual report observation period. A durable pending
    // operation is shown for explicit same-UUID recovery, never replaced.
    const first = lifecycle.getState();
    if (first.checkpoint?.active) act(() => lifecycle.reopen());
    else if (first.status === 'idle' && !first.checkpoint?.pending_capture && initial.initialPeriod) act(() => lifecycle.start(initial.initialPeriod!));
    return () => {
      live.current = false; generation.current = epoch + 1; currentAction.current = null;
      reloadAbort.current?.abort(); reportAbort.current?.abort(); lifecycle.dispose(); requests.dispose();
      owner.current = null; lane.current = null; initial.registerControls?.(null);
    };
  }, [initial]);

  // Pin the transport function once. It reads the current keyed lane, never
  // switches file identity in response to an unrelated save/updated_at render.
  const [previewTransport] = useState(() => (input: CustomCohortPreviewRequest, options: { signal: AbortSignal }) => {
    const requests = lane.current;
    // Quiescence must close read admission too: an inspector or a previously
    // debounced preview must not acquire new locks after finalization flushed.
    // Already admitted lane work remains owned and is awaited by flush().
    if (!live.current || readonlyRef.current || lockedRef.current || reportUncertainRef.current || reportRecoveryRef.current)
      return Promise.reject(new Error('custom_workspace_read_only'));
    if (!requests || input.accountId !== initial.target.accountId || input.assignmentFileId !== initial.target.assignmentFileId)
      return Promise.reject(new Error('custom_workspace_target_changed'));
    return requests.run(signal => initial.api.preview(input, signal), options);
  });
  const [memberTransport] = useState<CustomCohortMemberTransport>(() => (...[input, population, page, options]: Parameters<CustomCohortMemberTransport>) => {
    const requests = lane.current, current = owner.current?.getState();
    // Completed pages may stay visible while saving, but new inspection work
    // cannot compete with mutation or reopen a lane already quiesced for signing.
    if (!live.current || readonlyRef.current || lockedRef.current || reportUncertainRef.current || reportRecoveryRef.current
      || currentAction.current || actionFailed.current || current?.status !== 'ready' || current.recovery || current.checkpoint?.pending_capture)
      return Promise.reject(new Error('custom_workspace_read_only'));
    if (!requests || input.accountId !== initial.target.accountId || input.assignmentFileId !== initial.target.assignmentFileId)
      return Promise.reject(new Error('custom_workspace_target_changed'));
    const context = current.checkpoint?.active?.context_ref;
    if (!context || context.context_id !== input.contextRef.context_id || context.context_revision !== input.contextRef.context_revision
      || context.context_sha256 !== input.contextRef.context_sha256)
      return Promise.reject(new Error('custom_workspace_context_changed'));
    return requests.run(io => initial.api.members(input, population, page, io), options);
  });
  const saving = !state || actionPending || state.operation_pending || state.status === 'busy';
  const busy = saving || readOnly || locked;
  const blockedReason = readOnly || locked ? 'read_only'
    : actionFailed.current || message || state?.status === 'invalid' || state?.status === 'error'
      || (state?.recovery && state.recovery !== 'resume_pending') ? 'reload_required'
    : state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending' ? 'pending_capture'
    : state?.status !== 'ready' && state?.status !== 'idle' ? 'reload_required' : null;
  const explorationBlocked = blockedReason ?? (reportUncertain || reportRecovery ? 'reload_required' : null);
  const active = lastReady?.checkpoint?.active;
  const installedScope = scope?.profile_id !== 'custom-city-polygon-v1' || CITIES.some(entry => scopeKey(entry.discovery) === scopeKey(scope));
  function reportOutcome(uncertain: boolean) {
    if (!live.current) return;
    reportUncertainRef.current = uncertain; setReportUncertain(uncertain);
  }
  function runReportTask(task: (io: CustomWorkspaceOperationOptions) => Promise<void>) {
    // A report deadline is not a failed workspace save. Keep the mounted
    // proposal/Apply UUID and allow only its explicit retry (or accepted read),
    // once the previous underlying lane operation has actually settled.
    const state = owner.current?.getState();
    if (actionFailed.current || state?.status !== 'ready' || state.recovery || state.checkpoint?.pending_capture
      || (reportRecoveryRef.current && !lane.current?.isIdle())) return Promise.resolve(false);
    return act(async () => {
      const requests = lane.current, lifecycle = owner.current;
      const current = lifecycle?.getState();
      if (!requests || !lifecycle || !lifecycle.isSettled() || current?.status !== 'ready'
        || current.recovery || current.checkpoint?.pending_capture)
        throw new Error('custom_workspace_busy');
      if (reportRecoveryRef.current) {
        if (!requests.isIdle()) throw new Error('custom_workspace_busy');
        requests.recover();
      }
      await requests.flush();
      const abort = new AbortController(); reportAbort.current = abort;
      const epoch = generation.current;
      const deadline = performance.now() + 65_000;
      const timeout = setTimeout(() => abort.abort(), 65_000);
      try {
        await requests.run(({ signal }) => task({ signal, deadline }), { signal: abort.signal });
        if (live.current && generation.current === epoch) { reportRecoveryRef.current = false; setReportRecovery(false); }
      }
      finally { clearTimeout(timeout); if (reportAbort.current === abort) reportAbort.current = null; }
    }, true);
  }
  async function reload() {
    const requests = lane.current, lifecycle = owner.current;
    if (!requests || !lifecycle || !lifecycle.isSettled()) throw new Error('custom_workspace_busy');
    await requests.flush().catch(() => {});
    if (!requests.isIdle()) throw new Error('custom_workspace_busy');
    requests.recover();
    const abort = new AbortController(); reloadAbort.current = abort;
    const timeout = setTimeout(() => abort.abort(), 65_000);
    try {
      const fresh = await requests.run(({ signal }) => initial.api.read(initial.target, {
        signal, deadline: performance.now() + 65_000,
      }), { signal: abort.signal });
      if (!live.current || abort.signal.aborted) return;
      if (fresh.status !== 'draft') { lockedRef.current = true; setLocked(true); setLastReady(null); return; }
      await lifecycle.reload({ target: fresh.target, section: fresh.section });
      if (live.current && !abort.signal.aborted) setReportEpoch(value => value + 1);
    } finally { clearTimeout(timeout); if (reloadAbort.current === abort) reloadAbort.current = null; }
  }
  return <section className="space-y-3 print:hidden" aria-label="Saved neighborhood workspace">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-violet-200 p-3">
      <label className="text-sm">Observation start<input type="date" className="input input-bordered block" value={start}
        disabled={busy} onChange={event => setStart(event.target.value)} /></label>
      <label className="text-sm">Observation end<input type="date" className="input input-bordered block" value={end}
        disabled={busy} onChange={event => setEnd(event.target.value)} /></label>
      <label className="text-sm">Analytical study area<select className="select select-bordered block" value={scopeKey(scope)}
        disabled={busy || Boolean(explorationBlocked)} onChange={event => {
          const key = event.target.value;
          const choice = Object.hasOwn(RADII, key) ? { profile_id: 'custom-suburban-radius-v2' as const, radius_metres: RADII[key as RadiusMiles] }
            : CITIES.find(entry => scopeKey(entry.discovery) === key)?.discovery;
          if (!choice) return;
          scopeRef.current = choice; setScope(choice);
        }}>
        <optgroup label="Radius"><option value="3">3 miles — default</option><option value="5">5 miles</option><option value="10">10 miles</option></optgroup>
        <optgroup label="Installed city polygons">{CITIES.map(entry => <option key={entry.discovery.city.geoid} value={scopeKey(entry.discovery)}>
          {entry.name} — {entry.discovery.city.vintage} polygon</option>)}</optgroup>
        {!installedScope && <option value={scopeKey(scope)} disabled>{scopeLabel(scope)} — retained; not installed for new capture</option>}
      </select></label>
      <button type="button" className={button} disabled={busy || !start || !end || !installedScope || Boolean(explorationBlocked)}
        onClick={() => { if (!explorationBlocked) act(() => owner.current!.start({ start_date: start, end_date: end }, undefined, captureDiscovery())); }}>
        {scope?.profile_id === 'custom-city-polygon-v1' ? `Capture ${scopeLabel(scope)} study`
          : active ? `Capture a new ${scopeKey(scope)}-mile study` : `Start ${scopeKey(scope)}-mile exploration`}</button>
      <button type="button" className={button} disabled={busy || reportUncertain || reportRecovery}
        onClick={() => { if (!reportUncertainRef.current && !reportRecoveryRef.current) act(reload); }}>Reload saved choices</button>
      {(state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending') && <button type="button" className={button}
        disabled={busy || blockedReason === 'reload_required' || (state.recovery !== null && state.recovery !== 'resume_pending')}
        onClick={() => { if (blockedReason !== 'reload_required') act(() => owner.current!.resumePending()); }}>Resume saved capture</button>}
      {(state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending') && <button type="button" className={button}
        disabled={busy || blockedReason === 'reload_required' || (state.recovery !== null && state.recovery !== 'resume_pending')}
        title="Clear only this pending choice. Keep the previous study, source evidence, and accepted report."
        onClick={() => { if (blockedReason !== 'reload_required') act(() => owner.current!.setAsidePending()); }}>Set aside pending capture</button>}
    </div>
    <p className="text-xs text-slate-600">{active ? `Displayed study: ${scopeLabel(active.discovery)}. ` : ''}
      Changing this choice only changes the next capture. City studies use the dated installed polygon, not mailing-city names or the map's reference control.
      Complete cached membership is not proof of complete provider coverage. Available records in the requested area are considered within the observation period;
      capacity limits stop an incomplete capture instead of silently trimming it. Your accepted report changes only when you apply the complete reviewed group.</p>
    <p role="status" className="text-sm">{locked ? 'This file is no longer editable. Its saved report is unchanged.' : saving
      ? 'Updating neighborhood workspace…' : readOnly ? 'Neighborhood exploration is read-only while the report is being finalized.' : state?.status === 'ready' && !blockedReason
        ? 'Neighborhood choices saved to this appraisal file.' : 'Neighborhood exploration has not changed the accepted report.'}</p>
    {(message || state?.status === 'invalid' || state?.status === 'error') && <p role="alert" className="text-sm">
      {message ?? 'The saved neighborhood workspace needs to be reloaded or reviewed before continuing. No default selection was substituted.'}</p>}
    {reportRecovery && <p role="alert" className="text-sm">The report request did not finish in time. Once it settles, retry the same report request or reload its accepted group below. Saving and finalizing remain paused.</p>}
    {active && lastReady?.catalog && <CustomCohortWorkspace accountId={initial.target.accountId} assignmentFileId={initial.target.assignmentFileId}
      sessionKey={initial.target.sessionKey} contextRef={active.context_ref} subjectLabel={initial.subjectLabel} enabled={!locked}
      workspace={{ catalog: lastReady.catalog, selection: active.selection, saving, blockedReason: explorationBlocked, previewTransport, memberTransport,
        onSelectionIntent: ids => { if (!explorationBlocked) act(() => owner.current!.setGroups(ids)); } }} />}
    {active && state?.status === 'ready' && state.section_revision !== null && <CustomReportedObservationAdoption
      key={JSON.stringify([active.context_ref, state.section_revision, reportEpoch])}
      target={initial.target} contextRef={active.context_ref} workspaceRevision={state.section_revision}
      api={initial.api} disabled={busy || Boolean(blockedReason)} run={runReportTask}
      onOutcomeUncertain={reportOutcome} onAccepted={initial.onAccepted} />}
  </section>;
}
