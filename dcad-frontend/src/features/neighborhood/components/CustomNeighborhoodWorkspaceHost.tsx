import { useEffect, useRef, useState } from 'react';
import { createCustomWorkspaceLifecycle } from '../customWorkspaceLifecycle';
import type { CustomWorkspaceLifecycleState, CustomWorkspaceTarget } from '../customWorkspaceLifecycle';
import type { CustomWorkspaceObservationPeriod, CustomWorkspacePrivateSalesImport } from '../customWorkspaceCheckpoint';
import { createCustomWorkspaceRequestLane } from '../customWorkspaceRequestLane';
import type { createCustomWorkspaceApi } from '../customWorkspaceApi';
import type { CustomCohortPreviewRequest } from '../customCohortPreviewController';
import CustomCohortWorkspace from './CustomCohortWorkspace';

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
}
const button = 'hn-action-secondary btn btn-sm normal-case';

/** Explicitly injected Custom-only host. A mounted caller must first obtain a
 * verified current account/file/session workfile read. No local browser draft,
 * latest-context lookup, accepted-report callback or report calculation lives
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
  const [readOnly, setReadOnly] = useState(false);
  const [locked, setLocked] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const owner = useRef<ReturnType<typeof createCustomWorkspaceLifecycle> | null>(null);
  const lane = useRef<ReturnType<typeof createCustomWorkspaceRequestLane> | null>(null);
  const currentAction = useRef<Promise<unknown> | null>(null);
  const readonlyRef = useRef(false);
  const lockedRef = useRef(false);
  const actionFailed = useRef(false);
  const live = useRef(false);
  const generation = useRef(0);
  const reloadAbort = useRef<AbortController | null>(null);
  const period = useRef({ start_date: start, end_date: end }); period.current = { start_date: start, end_date: end };

  // One owned action at a time, without reflecting per-request progress in the
  // page-wide assignment autosave state. Invalid/uncertain saves stay visible.
  function act(action: () => Promise<unknown>) {
    if (!live.current || readonlyRef.current || lockedRef.current || currentAction.current) return Promise.resolve(false);
    const epoch = generation.current;
    actionFailed.current = false; setMessage(null); setActionPending(true);
    const task = Promise.resolve().then(() => {
      if (live.current && generation.current === epoch) return action().then(() => true);
      return false;
    }).catch(() => {
      if (live.current && generation.current === epoch) { actionFailed.current = true;
        setMessage('The neighborhood workspace could not finish updating. Reload its saved choices before continuing; your report has not changed.'); }
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
        setState(next); if (next.status === 'ready' && next.catalog && next.selection) setLastReady(next);
      } });
    owner.current = lifecycle; setState(lifecycle.getState());
    initial.registerControls?.({ target: initial.target,
      useReviewedSales: reference => {
        if (!live.current || generation.current !== epoch || !period.current.start_date || !period.current.end_date)
          return Promise.resolve(false);
        return act(() => lifecycle.start(period.current, reference));
      },
      setReadOnly: value => { if (!live.current || generation.current !== epoch) return;
        readonlyRef.current = value; setReadOnly(value); },
      flush: async () => {
        try {
          await currentAction.current; await requests.flush();
          const current = lifecycle.getState();
          return live.current && generation.current === epoch && !currentAction.current && !lockedRef.current && !actionFailed.current
            && lifecycle.isSettled() && requests.isIdle() && !current.recovery
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
      reloadAbort.current?.abort(); lifecycle.dispose(); requests.dispose();
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
    if (!live.current || readonlyRef.current || lockedRef.current)
      return Promise.reject(new Error('custom_workspace_read_only'));
    if (!requests || input.accountId !== initial.target.accountId || input.assignmentFileId !== initial.target.assignmentFileId)
      return Promise.reject(new Error('custom_workspace_target_changed'));
    return requests.run(signal => initial.api.preview(input, signal), options);
  });
  const saving = !state || actionPending || state.operation_pending || state.status === 'busy';
  const busy = saving || readOnly || locked;
  const blockedReason = readOnly || locked ? 'read_only'
    : actionFailed.current || message || state?.status === 'invalid' || state?.status === 'error'
      || (state?.recovery && state.recovery !== 'resume_pending') ? 'reload_required'
    : state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending' ? 'pending_capture'
    : state?.status !== 'ready' && state?.status !== 'idle' ? 'reload_required' : null;
  const active = lastReady?.checkpoint?.active;
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
    } finally { clearTimeout(timeout); if (reloadAbort.current === abort) reloadAbort.current = null; }
  }
  return <section className="space-y-3 print:hidden" aria-label="Saved neighborhood workspace">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-violet-200 p-3">
      <label className="text-sm">Observation start<input type="date" className="input input-bordered block" value={start}
        disabled={busy} onChange={event => setStart(event.target.value)} /></label>
      <label className="text-sm">Observation end<input type="date" className="input input-bordered block" value={end}
        disabled={busy} onChange={event => setEnd(event.target.value)} /></label>
      <button type="button" className={button} disabled={busy || !start || !end || Boolean(blockedReason)}
        onClick={() => { if (!blockedReason) act(() => owner.current!.start({ start_date: start, end_date: end })); }}>
        {active ? 'Capture a new 3-mile study' : 'Start 3-mile exploration'}</button>
      <button type="button" className={button} disabled={busy} onClick={() => act(reload)}>Reload saved choices</button>
      {(state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending') && <button type="button" className={button}
        disabled={busy || blockedReason === 'reload_required' || (state.recovery !== null && state.recovery !== 'resume_pending')}
        onClick={() => { if (blockedReason !== 'reload_required') act(() => owner.current!.resumePending()); }}>Resume saved capture</button>}
      {(state?.checkpoint?.pending_capture || state?.recovery === 'resume_pending') && <button type="button" className={button}
        disabled={busy || blockedReason === 'reload_required' || (state.recovery !== null && state.recovery !== 'resume_pending')}
        title="Clear only this pending choice. Keep the previous study, source evidence, and accepted report."
        onClick={() => { if (blockedReason !== 'reload_required') act(() => owner.current!.setAsidePending()); }}>Set aside pending capture</button>}
    </div>
    <p role="status" className="text-sm">{locked ? 'This file is no longer editable. Its saved report is unchanged.' : saving
      ? 'Updating neighborhood workspace…' : readOnly ? 'Neighborhood exploration is read-only while the report is being finalized.' : state?.status === 'ready' && !blockedReason
        ? 'Neighborhood choices saved to this appraisal file.' : 'Neighborhood exploration has not changed the accepted report.'}</p>
    {(message || state?.status === 'invalid' || state?.status === 'error') && <p role="alert" className="text-sm">
      {message ?? 'The saved neighborhood workspace needs to be reloaded or reviewed before continuing. No default selection was substituted.'}</p>}
    {active && lastReady?.catalog && <CustomCohortWorkspace accountId={initial.target.accountId} assignmentFileId={initial.target.assignmentFileId}
      sessionKey={initial.target.sessionKey} contextRef={active.context_ref} subjectLabel={initial.subjectLabel} enabled={!locked}
      workspace={{ catalog: lastReady.catalog, selection: active.selection, saving, blockedReason, previewTransport,
        onSelectionIntent: ids => { if (!blockedReason) act(() => owner.current!.setGroups(ids)); } }} />}
  </section>;
}
