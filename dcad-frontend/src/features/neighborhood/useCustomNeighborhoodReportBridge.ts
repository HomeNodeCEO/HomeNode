import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { Session } from '../auth/applicationAuthData';
import { fetchWithApplicationAuthentication, makeUrl } from '@/lib/api';
import { editorCredentialForRequest } from '@/lib/editorCredential';
import { createCustomWorkspaceApi } from './customWorkspaceApi';
import type { CustomWorkspaceApiRead } from './customWorkspaceApi';
import type CustomNeighborhoodWorkspaceHost from './components/CustomNeighborhoodWorkspaceHost';
import type { CustomNeighborhoodWorkspaceControls } from './components/CustomNeighborhoodWorkspaceHost';
import type { CustomWorkspaceTarget } from './customWorkspaceLifecycle';
import type { CustomWorkspacePrivateSalesImport } from './customWorkspaceCheckpoint';

export type CustomNeighborhoodReportHostProps = ComponentProps<typeof CustomNeighborhoodWorkspaceHost>;
export interface CustomNeighborhoodReportBridgeInput {
  enabled: boolean; accountId?: string | null; assignmentFileId?: number | null;
  workfileStatus?: 'draft' | 'signed' | 'archived' | null; subjectLabel: string;
  auth: { ready: boolean; bootstrapError: string | null; session: Session | null };
  onAccepted?: () => Promise<boolean>;
}
export interface CustomNeighborhoodReportSaveLease {
  isCurrent(): boolean;
  flush(): Promise<boolean>;
  release(): void;
  retainReadOnly(): void;
}
type Status = 'inactive' | 'loading' | 'ready' | 'unavailable' | 'read_only';
export interface CustomNeighborhoodReportBridge {
  status: Status; message: string | null; hostProps: CustomNeighborhoodReportHostProps | null;
  retry(): void;
  useReviewedSales(reference: CustomWorkspacePrivateSalesImport): Promise<boolean>;
  /** Synchronous acquisition pauses the exact mounted workspace before the
   * caller awaits anything. Null is not a successful no-op when enabled. */
  beginSaveBarrier(): CustomNeighborhoodReportSaveLease | null;
}
const DEADLINE_MS = 65_000;
const unavailable = 'Neighborhood exploration is unavailable. Reload its saved workspace before saving or finalizing this file.';
const sameTarget = (a: CustomWorkspaceTarget, b: CustomWorkspaceTarget) => a.accountId === b.accountId
  && a.assignmentFileId === b.assignmentFileId && a.sessionKey === b.sessionKey;
const cancelled = () => new DOMException('Neighborhood report target changed', 'AbortError');

// This is a local invalidation key, not a session credential or an assignment
// permission decision. Equivalent auth response objects do not reset a file.
function identity(session: Session | null): string | null {
  if (!session?.user_id || !Array.isArray(session.organizations)) return null;
  return JSON.stringify([session.user_id, session.organizations.map(organization => [organization.organization_id,
    [...organization.roles].sort(), Object.entries(organization.permissions).map(([workflow, access]) =>
      [workflow, access.read, access.write, access.sign]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}
interface Runtime {
  key: string; enabled: boolean; live: boolean; readSettled: boolean; result: CustomWorkspaceApiRead | null;
  target: CustomWorkspaceTarget | null; api: ReturnType<typeof createCustomWorkspaceApi> | null;
  controls: CustomNeighborhoodWorkspaceControls | null; lease: CustomNeighborhoodReportSaveLease | null;
  stop: AbortController | null;
  retainedReadOnly: boolean; pendingFlush: boolean; quarantined: boolean;
  initialStatus: Status; initialMessage: string | null;
  registerControls: (value: CustomNeighborhoodWorkspaceControls | null) => void;
}
interface Bootstrap { runtime: Runtime; status: Status; message: string | null }

/** Production adapter only: existing authenticated endpoints + existing owned
 * workspace. No local drafts, accepted report writes, inferred study dates,
 * polling, auth policy changes, or per-preview report autosave state. */
export function useCustomNeighborhoodReportBridge(input: CustomNeighborhoodReportBridgeInput): CustomNeighborhoodReportBridge {
  const [retryRevision, setRetryRevision] = useState(0);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const latest = useRef<Runtime | null>(null);
  const acceptedCallback = useRef(input.onAccepted); acceptedCallback.current = input.onAccepted;
  const sessionIdentity = identity(input.auth.session), enabled = input.enabled === true;
  const accountId = input.accountId ?? null, assignmentFileId = input.assignmentFileId ?? null;
  const fileStatus = input.workfileStatus ?? null;
  const validTarget = typeof accountId === 'string' && /^[0-9A-Za-z_-]{1,50}$/.test(accountId)
    && Number.isSafeInteger(assignmentFileId) && Number(assignmentFileId) > 0;
  const eligible = enabled && input.auth.ready && !input.auth.bootstrapError && sessionIdentity !== null && validTarget;
  const initialStatus: Status = !enabled ? 'inactive' : !input.auth.ready ? 'loading' : eligible ? 'loading' : 'unavailable';
  const initialMessage = initialStatus === 'unavailable' ? unavailable : null;
  const key = JSON.stringify([enabled, input.auth.ready, Boolean(input.auth.bootstrapError), sessionIdentity,
    accountId, assignmentFileId, fileStatus, retryRevision]);
  const runtime = useMemo<Runtime>(() => {
    const value: Runtime = { key, enabled, live: false, readSettled: false, result: null, target: null, api: null,
      controls: null, lease: null, stop: null, retainedReadOnly: false, pendingFlush: false, quarantined: false,
      initialStatus, initialMessage, registerControls: () => {} };
    const isCurrent = () => value.live && latest.current === value;
    if (eligible) {
      try { value.target = Object.freeze({ accountId: accountId!, assignmentFileId: String(assignmentFileId), sessionKey: crypto.randomUUID() }); }
      catch { value.initialStatus = 'unavailable'; value.initialMessage = unavailable; }
    }
    if (value.target) value.api = createCustomWorkspaceApi({ urlFor: makeUrl,
      request: async (url, init) => {
        if (!isCurrent() || init.signal?.aborted) throw cancelled();
        const response = await fetchWithApplicationAuthentication(url, init);
        if (!isCurrent() || init.signal?.aborted) { void response.body?.cancel().catch(() => {}); throw cancelled(); }
        return response;
      },
      editorKeyForSave: (target, options) => {
        if (!isCurrent() || options.signal.aborted || !sameTarget(target, value.target!)) throw cancelled();
        const credential = editorCredentialForRequest();
        if (!credential) throw new Error('custom_workspace_authentication_required');
        return credential;
      } });
    value.registerControls = controls => {
      if (!isCurrent()) return;
      if (controls && (!value.target || !sameTarget(controls.target, value.target))) return;
      value.controls = controls;
      if (controls && (value.lease || value.retainedReadOnly)) controls.setReadOnly(true);
    };
    return value;
  }, [key, enabled, eligible, initialStatus, initialMessage, accountId, assignmentFileId]);
  // Render-current identity closes the short interval before old effect cleanup.
  latest.current = runtime;

  useEffect(() => {
    runtime.live = true;
    const abort = new AbortController();
    runtime.stop = abort; runtime.readSettled = false;
    let timedOut = false;
    const current = () => runtime.live && latest.current === runtime;
    setBootstrap({ runtime, status: runtime.initialStatus, message: runtime.initialMessage });
    if (!runtime.target || !runtime.api) {
      runtime.readSettled = true;
      return () => { runtime.live = false; runtime.controls = null; runtime.lease = null; abort.abort(); };
    }
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, DEADLINE_MS);
    void runtime.api.read(runtime.target, { signal: abort.signal, deadline: performance.now() + DEADLINE_MS }).then(result => {
      if (!current() || abort.signal.aborted) return;
      runtime.result = result;
      setBootstrap({ runtime, status: result.status === 'draft' && fileStatus !== 'signed' && fileStatus !== 'archived' ? 'ready' : 'read_only', message: null });
    }).catch(() => {
      if (current() && (!abort.signal.aborted || timedOut)) setBootstrap({ runtime, status: 'unavailable', message: unavailable });
    }).finally(() => { if (runtime.stop === abort) runtime.readSettled = true; clearTimeout(timeout); });
    return () => { runtime.live = false; runtime.controls = null; runtime.lease = null; abort.abort(); clearTimeout(timeout); };
  }, [runtime, fileStatus]);

  const retry = useCallback(() => {
    if (latest.current !== runtime || !runtime.live || !runtime.enabled || !runtime.readSettled
      || runtime.lease || runtime.pendingFlush) return;
    setRetryRevision(value => value + 1);
  }, [runtime]);

  const beginSaveBarrier = useCallback((): CustomNeighborhoodReportSaveLease | null => {
    if (latest.current !== runtime || !runtime.live || runtime.lease || runtime.pendingFlush || runtime.retainedReadOnly || runtime.quarantined) return null;
    const controls = runtime.controls;
    if (runtime.enabled && (!runtime.result || runtime.result.status !== 'draft' || fileStatus === 'signed'
      || fileStatus === 'archived' || !controls || !runtime.target || !sameTarget(controls.target, runtime.target))) return null;
    let released = false, retained = false, flushed: Promise<boolean> | null = null;
    const stop = runtime.stop!;
    const isCurrent = () => !released && !stop.signal.aborted && runtime.stop === stop
      && runtime.live && latest.current === runtime && runtime.lease === lease
      && (!runtime.enabled || runtime.controls === controls);
    const lease: CustomNeighborhoodReportSaveLease = Object.freeze({ isCurrent,
      flush: () => {
        if (!isCurrent()) return Promise.resolve(false);
        if (flushed) return flushed;
        if (!runtime.enabled) return Promise.resolve(true);
        runtime.pendingFlush = true;
        const operation = Promise.resolve().then(() => isCurrent() ? controls!.flush() : false)
          .then(value => value === true, () => false).finally(() => { runtime.pendingFlush = false; });
        flushed = new Promise<boolean>(resolve => {
          const finish = (value: boolean) => { clearTimeout(timeout); stop.signal.removeEventListener('abort', onStop); resolve(value); };
          const onStop = () => finish(false);
          const timeout = setTimeout(() => {
            if (isCurrent()) { runtime.quarantined = true; runtime.retainedReadOnly = true;
              setBootstrap({ runtime, status: 'unavailable', message: 'Neighborhood operations have not settled. Wait for the pending operation, then reload the saved workspace before continuing.' }); }
            finish(false);
          }, DEADLINE_MS);
          stop.signal.addEventListener('abort', onStop, { once: true });
          if (stop.signal.aborted) onStop();
          void operation.then(value => finish(value && isCurrent()));
        });
        return flushed;
      },
      release: () => {
        if (released) return;
        const current = isCurrent(); released = true;
        if (runtime.lease === lease) runtime.lease = null;
        if (current && !retained && !runtime.retainedReadOnly) controls?.setReadOnly(false);
      },
      retainReadOnly: () => {
        if (!isCurrent()) return;
        retained = true; runtime.retainedReadOnly = true; controls?.setReadOnly(true);
      },
    });
    runtime.lease = lease;
    controls?.setReadOnly(true);
    return lease;
  }, [runtime, fileStatus]);

  const state = bootstrap?.runtime === runtime ? bootstrap : { status: runtime.initialStatus, message: runtime.initialMessage };
  const result = bootstrap?.runtime === runtime ? runtime.result : null;
  const checkpoint = result?.section?.value;
  const hostProps: CustomNeighborhoodReportHostProps | null = enabled && result && runtime.target && runtime.api ? {
    enabled: true, target: runtime.target, subjectLabel: input.subjectLabel, initialSection: result.section,
    initialPeriod: checkpoint?.active?.observation_period ?? checkpoint?.pending_capture?.observation_period ?? null,
    workfileStatus: fileStatus === 'signed' || fileStatus === 'archived' ? fileStatus : result.status,
    api: runtime.api, registerControls: runtime.registerControls,
    onAccepted: async () => {
      if (!runtime.live || latest.current !== runtime || runtime.stop?.signal.aborted) return false;
      const restored = await acceptedCallback.current?.();
      return restored === true && runtime.live && latest.current === runtime && !runtime.stop?.signal.aborted;
    },
  } : null;
  const useReviewedSales = async (reference: CustomWorkspacePrivateSalesImport): Promise<boolean> => {
    const controls = runtime.controls;
    if (latest.current !== runtime || !runtime.live || !runtime.readSettled || !runtime.target || !controls
      || !sameTarget(controls.target, runtime.target) || runtime.lease || runtime.retainedReadOnly || runtime.quarantined
      || runtime.pendingFlush || fileStatus !== 'draft' || runtime.result?.status !== 'draft' || !controls.useReviewedSales) return false;
    return controls.useReviewedSales(reference);
  };
  return { status: state.status, message: state.message, hostProps, retry, beginSaveBarrier, useReviewedSales };
}
