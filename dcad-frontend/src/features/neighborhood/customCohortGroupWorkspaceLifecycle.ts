import { prepareCustomCohortGroupWorkspaceCheckpoint, readCustomCohortGroupWorkspaceSection,
  checkCustomCohortGroupWorkspaceWriteReceipt, checkCustomCohortGroupWorkspaceTransitionReceipt } from './customCohortGroupWorkspaceTransport.ts';
import type { CustomCohortGroupWorkspaceCheckpoint, CustomCohortGroupWorkspaceSave, CustomCohortGroupWorkspaceComplete,
  CustomCohortGroupWorkspaceStart, CustomCohortGroupWorkspaceCancel } from './customCohortGroupWorkspaceTransport';
import { prepareCustomCohortRecordedGroupWrite, checkCustomCohortRecordedGroupReadReceipt } from './customCohortRecordedGroupTransport.ts';
import type { CustomCohortRecordedGroupRead, CustomCohortRecordedGroupReceipt } from './customCohortRecordedGroupTransport';
import { customWorkspaceCaptureDiscoveryMatches, prepareCustomWorkspacePrivateSalesImport } from './customWorkspaceCheckpoint.ts';
import type { CustomWorkspaceObservationPeriod, CustomWorkspacePrivateSalesImport,
  CustomWorkspaceDiscovery } from './customWorkspaceCheckpoint';
import { checkCustomCohortPocketCatalog, customCohortCatalogGroupIds } from './customCohortPocketCatalog.ts';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomWorkspaceTarget, CustomWorkspaceOperationOptions, CustomWorkspaceCatalogInput } from './customWorkspaceLifecycle';
import type { CustomCohortContextRef } from './customCohortPreviewController';
import { checkCustomCohortGroupDisplayResult } from './customCohortGroupDisplay.ts';
import type { CustomCohortGroupDisplay, CustomCohortGroupDisplayInput } from './customCohortGroupDisplay';

type Recovery = 'reload' | 'retry_exact' | 'resume_pending' | 'reopen' | null;
type Selected = Exclude<CustomCohortRecordedGroupReceipt, { readonly status: 'absent' }>;
export interface CustomCohortGroupWorkspaceLifecycleState {
  readonly target: CustomWorkspaceTarget;
  readonly status: 'idle' | 'pending' | 'ready' | 'busy' | 'invalid' | 'error' | 'disposed';
  readonly operation_pending: boolean; readonly phase: string | null; readonly section_revision: number | null;
  readonly checkpoint: CustomCohortGroupWorkspaceCheckpoint | null;
  readonly catalog: CheckedPocketCatalog | null; readonly selected: Selected | null;
  readonly display: CustomCohortGroupDisplay | null; readonly display_freshness: 'none' | 'current' | 'stale';
  readonly recovery: Recovery; readonly error: string | null;
}
interface Options {
  target: CustomWorkspaceTarget; initialSection: unknown;
  start: (request: CustomCohortGroupWorkspaceStart, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  cancel: (request: CustomCohortGroupWorkspaceCancel, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  complete: (request: CustomCohortGroupWorkspaceComplete, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  save: (request: CustomCohortGroupWorkspaceSave, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  capture: (request: { target: CustomWorkspaceTarget; operationId: string; observationPeriod: CustomWorkspaceObservationPeriod;
    discovery?: CustomWorkspaceDiscovery; privateSalesImport?: CustomWorkspacePrivateSalesImport }, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  catalog: (request: CustomWorkspaceCatalogInput, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  readSelection: (request: CustomCohortRecordedGroupRead, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  display?: (request: CustomCohortGroupDisplayInput, io: CustomWorkspaceOperationOptions) => Promise<unknown>;
  initialGroups: (catalog: CheckedPocketCatalog) => readonly string[];
  onChange: (state: CustomCohortGroupWorkspaceLifecycleState) => void;
  operationId?: () => string; now?: () => number; timeoutMs?: number;
  timer?: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}
type Attempt = { kind: 'start'; request: CustomCohortGroupWorkspaceStart }
  | { kind: 'cancel'; request: CustomCohortGroupWorkspaceCancel }
  | { kind: 'complete'; request: CustomCohortGroupWorkspaceComplete }
  | { kind: 'save'; request: CustomCohortGroupWorkspaceSave };
const EMPTY = prepareCustomCohortGroupWorkspaceCheckpoint({ workspace_version: 7, active: null, pending_capture: null });
const PROBE = '10000000-0000-4000-8000-000000000001';
const fault = (code: string) => Object.assign(new Error(`custom_workspace_${code}`), { workspaceCode: code });
const requireThat: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw fault(code); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> => {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_response'); return value as Record<string, unknown>;
};
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

/** Opt-in V7 owner only: atomic server commands, no generic workfile writes or
 * flattened account selection. A checked current reference is shared by future
 * map/statistics/report adapters; the existing V1–6 host remains unchanged.
 * Catalog display still uses the bounded installed catalog contract. This owner
 * alone neither raises capacity nor activates new routes, schedules or Apply. */
export function createCustomCohortGroupWorkspaceLifecycle(options: Options) {
  const source = options.target;
  requireThat(text(source?.accountId, 64) && text(source?.sessionKey, 200)
    && typeof source?.assignmentFileId === 'string' && /^[1-9][0-9]{0,18}$/.test(source.assignmentFileId)
    && BigInt(source.assignmentFileId) <= 9223372036854775807n, 'invalid_target');
  for (const fn of [options.start, options.cancel, options.complete, options.save, options.capture, options.catalog,
    options.readSelection, options.initialGroups, options.onChange]) requireThat(typeof fn === 'function', 'dependencies_required');
  requireThat(options.display === undefined || typeof options.display === 'function', 'dependencies_required');
  const target = Object.freeze({ accountId: source.accountId, assignmentFileId: source.assignmentFileId, sessionKey: source.sessionKey });
  const base = Object.freeze({ accountId: target.accountId, assignmentFileId: target.assignmentFileId });
  const now = options.now ?? (() => performance.now()), timeout = options.timeoutMs ?? 180_000;
  requireThat(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 180_000, 'invalid_timeout');
  const timer = options.timer ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let busy = false, disposed = false, unsettled = 0, abort: AbortController | null = null;
  let attempted: { command: Attempt; revision: number; checkpoint: CustomCohortGroupWorkspaceCheckpoint } | null = null;
  let state: CustomCohortGroupWorkspaceLifecycleState = Object.freeze({ target, status: 'idle', operation_pending: false,
    phase: null, section_revision: 0, checkpoint: null, catalog: null, selected: null,
    display: null, display_freshness: 'none', recovery: null, error: null });
  function emit(patch: Partial<CustomCohortGroupWorkspaceLifecycleState>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    try { options.onChange(state); } catch { /* Rendering cannot reinterpret a committed command. */ }
  }
  function adopt(section: unknown) {
    const read = readCustomCohortGroupWorkspaceSection(section);
    if (read.status === 'invalid') {
      emit({ status: 'invalid', section_revision: null, checkpoint: null, catalog: null, selected: null,
        display: null, display_freshness: 'none', recovery: 'reload', error: 'invalid_checkpoint' }); return false;
    }
    emit({ status: read.checkpoint?.pending_capture ? 'pending' : 'idle', section_revision: read.section_revision,
      checkpoint: read.checkpoint, catalog: null, selected: null,
      ...(!read.checkpoint?.active ? { display: null } : {}),
      display_freshness: read.checkpoint?.active && state.display ? 'stale' : 'none',
      phase: null, recovery: null, error: null }); return true;
  }
  adopt(options.initialSection);
  async function run(allowed: Recovery, task: (io: IO, stage: Stage) => Promise<void>, reload = false) {
    requireThat(!disposed, 'disposed'); requireThat(!busy && unsettled === 0, 'busy');
    requireThat(reload || (state.status !== 'invalid' && (!state.recovery || state.recovery === allowed)), 'recovery_required');
    const before = state; let staged = false, recovery = allowed;
    busy = true; emit({ operation_pending: true });
    const owner = new AbortController(), deadline = now() + timeout; abort = owner;
    const handle = timer.set(() => owner.abort(), timeout);
    const live = () => requireThat(!disposed && !owner.signal.aborted && now() < deadline, 'cancelled_or_timed_out');
    const stage: Stage = (phase, next) => { live(); staged = true; recovery = next;
      emit({ status: 'busy', phase, error: null, recovery: null, catalog: null, selected: null,
        display_freshness: state.display ? 'stale' : 'none' }); };
    const io: IO = async fn => {
      live(); unsettled++;
      const work = Promise.resolve().then(() => { live(); return fn({ signal: owner.signal, deadline }); });
      const settled = () => { unsettled--; if (!busy) emit({ operation_pending: unsettled > 0 }); };
      void work.then(settled, settled);
      let cancel: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { cancel = () => reject(fault('cancelled_or_timed_out'));
        owner.signal.addEventListener('abort', cancel, { once: true }); });
      try { const result = await Promise.race([work, cancelled]); live(); return result; }
      finally { owner.signal.removeEventListener('abort', cancel); }
    };
    try { await task(io, stage); }
    catch (error) {
      emit({ status: staged ? 'error' : before.status, phase: null, catalog: staged ? null : before.catalog,
        selected: staged ? null : before.selected, recovery: staged ? recovery : before.recovery,
        error: error instanceof Error && 'workspaceCode' in error ? String(error.workspaceCode) : 'operation_failed' });
      throw error instanceof Error && 'workspaceCode' in error ? error : fault('operation_failed');
    } finally { timer.clear(handle); if (abort === owner) abort = null; busy = false; emit({ operation_pending: unsettled > 0 }); }
    return state;
  }
  type IO = <T>(fn: (io: CustomWorkspaceOperationOptions) => Promise<T>) => Promise<T>;
  type Stage = (phase: string, recovery: Recovery) => void;
  function prior() {
    requireThat(state.section_revision !== null && state.section_revision < 2147483647, 'section_revision');
    return { expectedWorkspaceRevision: state.section_revision, expectedWorkspaceCheckpoint: state.checkpoint ?? EMPTY };
  }
  function id() {
    const value = options.operationId?.() ?? crypto.randomUUID();
    // Admit the UUID through the identical server-owned command grammar.
    prepareCustomCohortGroupWorkspaceCheckpoint({ ...EMPTY, pending_capture: { operation_id: value,
      observation_period: { start_date: '2024-01-01', end_date: '2024-01-01' } } }); return value;
  }
  function included(catalog: CheckedPocketCatalog, ids: readonly string[], ref: CustomCohortContextRef) {
    const value = prepareCustomCohortRecordedGroupWrite({ ...base, contextRef: ref, operationId: PROBE,
      expectedSelectionRef: null, includedRecordedGroupIds: ids });
    const available = new Set(customCohortCatalogGroupIds(catalog));
    requireThat(value.includedRecordedGroupIds.every(group => available.has(group)), 'unknown_recorded_group');
    return value.includedRecordedGroupIds;
  }
  async function command(value: Attempt, io: IO, stage: Stage) {
    stage(`saving_${value.kind}`, 'reload');
    attempted = { command: value, revision: value.request.expectedWorkspaceRevision, checkpoint: state.checkpoint ?? EMPTY };
    const raw = await io(signal => {
      switch (value.kind) {
        case 'start': return options.start(value.request, signal);
        case 'cancel': return options.cancel(value.request, signal);
        case 'complete': return options.complete(value.request, signal);
        case 'save': return options.save(value.request, signal);
      }
    });
    const ack = value.kind === 'start' || value.kind === 'cancel'
      ? checkCustomCohortGroupWorkspaceTransitionReceipt(raw, value.request, value.kind === 'start')
      : checkCustomCohortGroupWorkspaceWriteReceipt(raw, value.request, value.kind === 'complete');
    // Save-groups must retain the same study period/discovery, not merely a
    // structurally valid matching context and selection reference.
    if (value.kind === 'save') requireThat(state.checkpoint?.active && ack.workspace.value.active
      && same(state.checkpoint.active.observation_period, ack.workspace.value.active.observation_period)
      && same(state.checkpoint.active.discovery ?? null, ack.workspace.value.active.discovery ?? null), 'save_ack_mismatch');
    emit({ checkpoint: ack.workspace.value, section_revision: ack.workspace.revision }); attempted = null;
  }
  async function loadCatalog(ref: CustomCohortContextRef, revision: number, discovery: CustomWorkspaceDiscovery | undefined, io: IO) {
    const input: CustomWorkspaceCatalogInput = Object.freeze({ ...base, contextRef: ref,
      selection: Object.freeze({ revision, pockets: Object.freeze([]) }), catalogVersion: 3 });
    const catalog = checkCustomCohortPocketCatalog(await io(signal => options.catalog(input, signal)), input);
    requireThat(catalog.catalog_version === 3 && same(catalog.discovery,
      discovery?.profile_id === 'custom-city-polygon-v1' ? discovery : undefined), 'catalog_discovery_mismatch');
    return catalog;
  }
  async function reopen(io: IO, stage: Stage, knownCatalog?: CheckedPocketCatalog) {
    const checkpoint = state.checkpoint, active = checkpoint?.active;
    if (!active) { emit({ status: checkpoint?.pending_capture ? 'pending' : 'idle', phase: null,
      display: null, display_freshness: 'none', recovery: null, error: null }); return; }
    stage('loading_active', 'reopen');
    const catalog = knownCatalog ?? await loadCatalog(active.context_ref, active.selection_ref.selection_revision, active.discovery, io);
    const request = Object.freeze({ ...base, contextRef: active.context_ref });
    const selected = checkCustomCohortRecordedGroupReadReceipt(await io(signal => options.readSelection(request, signal)), request);
    requireThat(selected.status !== 'absent' && same(selected.selection_ref, active.selection_ref), 'selection_head_changed');
    included(catalog, selected.included_recorded_group_ids, active.context_ref);
    let display: CustomCohortGroupDisplay | null = null;
    if (options.display) {
      requireThat(checkpoint && state.section_revision !== null, 'display_checkpoint_required');
      const input = Object.freeze({ target, workspaceRevision: state.section_revision, checkpoint, catalog, selected });
      stage('loading_display', 'reopen');
      display = checkCustomCohortGroupDisplayResult(await io(signal => options.display!(input, signal)), input);
    }
    // Only a complete same-reference pair replaces the retained map/numbers.
    // A post-ACK projection failure is a reopen, never another selection save.
    emit({ status: checkpoint?.pending_capture ? 'pending' : 'ready', phase: null, catalog, selected, display,
      display_freshness: display ? checkpoint?.pending_capture ? 'stale' : 'current' : 'none', recovery: null, error: null });
  }
  async function acquire(io: IO, stage: Stage) {
    const pending = state.checkpoint?.pending_capture;
    requireThat(pending, 'pending_capture_required');
    stage('capturing', 'resume_pending');
    const response = object(await io(signal => options.capture({ target, operationId: pending.operation_id,
      observationPeriod: pending.observation_period, ...(pending.discovery ? { discovery: pending.discovery } : {}),
      ...(pending.private_sales_import ? { privateSalesImport: pending.private_sales_import } : {}) }, signal)));
    requireThat(response.status === 'registered' && typeof response.reused === 'boolean' && response.source_query_complete === true
      && customWorkspaceCaptureDiscoveryMatches(response.discovery, pending.discovery), 'capture_response');
    if (pending.private_sales_import) requireThat(same(prepareCustomWorkspacePrivateSalesImport(response.private_sales_import),
      pending.private_sales_import), 'capture_private_sales_mismatch');
    else requireThat(!Object.hasOwn(response, 'private_sales_import'), 'capture_private_sales_mismatch');
    const draft = prepareCustomCohortGroupWorkspaceCheckpoint({ ...EMPTY, pending_capture: pending });
    const ref = prepareCustomCohortRecordedGroupWrite({ ...base, contextRef: response.context_ref, operationId: PROBE,
      expectedSelectionRef: null, includedRecordedGroupIds: [] }).contextRef;
    requireThat(ref.context_id === draft.pending_capture!.operation_id, 'capture_operation_mismatch');
    stage('loading_captured_catalog', 'resume_pending');
    const catalog = await loadCatalog(ref, 1, pending.discovery, io);
    if (pending.private_sales_import) requireThat(catalog.private_sales?.binding.batch.batch_id === pending.private_sales_import.batch_id
      && catalog.private_sales.binding.review.revision === pending.private_sales_import.expected_review_revision
      && catalog.private_sales.observation_period.start_date === pending.observation_period.start_date
      && catalog.private_sales.observation_period.end_date === pending.observation_period.end_date, 'catalog_private_sales_mismatch');
    else requireThat(!catalog.private_sales, 'catalog_private_sales_mismatch');
    const groups = included(catalog, options.initialGroups(catalog), ref);
    await command({ kind: 'complete', request: Object.freeze({ ...base, ...prior(), contextRef: ref,
      operationId: id(), expectedSelectionRef: null, includedRecordedGroupIds: groups }) }, io, stage);
    await reopen(io, stage, catalog);
  }
  return Object.freeze({
    getState: () => state,
    isSettled: () => !busy && unsettled === 0,
    reopen: () => run('reopen', reopen),
    start: (period: CustomWorkspaceObservationPeriod, privateInput?: CustomWorkspacePrivateSalesImport, discovery?: CustomWorkspaceDiscovery) => run(null, async (io, stage) => {
      requireThat(!state.checkpoint?.pending_capture && !attempted, 'pending_capture_required');
      const components = prepareCustomCohortGroupWorkspaceCheckpoint({ ...EMPTY, pending_capture: { operation_id: PROBE,
        observation_period: period, ...(privateInput === undefined ? {} : { private_sales_import: privateInput }),
        ...(discovery === undefined ? {} : { discovery }) } }).pending_capture!;
      const expected = prior(); // Validate before allocating any operation identity.
      const pending = prepareCustomCohortGroupWorkspaceCheckpoint({ ...EMPTY, pending_capture: { ...components, operation_id: id() } }).pending_capture!;
      requireThat(pending.operation_id !== state.checkpoint?.active?.context_ref.context_id, 'capture_operation_mismatch');
      await command({ kind: 'start', request: Object.freeze({ ...base, ...expected, pendingCapture: pending }) }, io, stage);
      await acquire(io, stage);
    }),
    resumePending: () => run('resume_pending', acquire),
    setAsidePending: () => run(state.recovery === 'resume_pending' ? 'resume_pending' : null, async (io, stage) => {
      requireThat(state.checkpoint?.pending_capture && !attempted, 'pending_capture_required');
      await command({ kind: 'cancel', request: Object.freeze({ ...base, ...prior() }) }, io, stage); await reopen(io, stage);
    }),
    setGroups: (ids: readonly string[]) => run(null, async (io, stage) => {
      const active = state.checkpoint?.active, catalog = state.catalog;
      requireThat(state.status === 'ready' && active && catalog && !state.checkpoint?.pending_capture && !attempted, 'ready_workspace_required');
      const groups = included(catalog, ids, active.context_ref), expected = prior();
      const write = prepareCustomCohortRecordedGroupWrite({ ...base, contextRef: active.context_ref, operationId: PROBE,
        expectedSelectionRef: active.selection_ref, includedRecordedGroupIds: groups });
      await command({ kind: 'save', request: Object.freeze({ ...write, operationId: id(), expectedWorkspaceRevision: expected.expectedWorkspaceRevision }) }, io, stage);
      await reopen(io, stage);
    }),
    retryExact: () => run('retry_exact', async (io, stage) => {
      requireThat(state.recovery === 'retry_exact' && attempted && state.section_revision === attempted.revision
        && same(state.checkpoint ?? EMPTY, attempted.checkpoint), 'exact_retry_required');
      const original = attempted.command;
      await command(original, io, stage);
      if (original.kind === 'start') await acquire(io, stage); else await reopen(io, stage);
    }),
    reload: (value: { target: CustomWorkspaceTarget; section: unknown }) => run('reload', async (io, stage) => {
      requireThat(value && Object.hasOwn(value, 'section') && value.target?.accountId === target.accountId
        && value.target.assignmentFileId === target.assignmentFileId && value.target.sessionKey === target.sessionKey, 'reload_target_mismatch');
      const fresh = readCustomCohortGroupWorkspaceSection(value.section);
      if (fresh.status !== 'invalid' && state.section_revision !== null) requireThat(fresh.section_revision >= state.section_revision
        && (fresh.section_revision !== state.section_revision || same(fresh.checkpoint ?? EMPTY, state.checkpoint ?? EMPTY)), 'reload_revision_changed');
      if (!adopt(value.section)) return;
      if (attempted && state.section_revision === attempted.revision && same(state.checkpoint ?? EMPTY, attempted.checkpoint)) {
        emit({ status: 'error', recovery: 'retry_exact', error: 'write_unconfirmed' }); return;
      }
      // A newer authoritative checkpoint wins over an unacknowledged old intent.
      // Reload its exact head; never replay the old command over later edits.
      attempted = null; await reopen(io, stage);
    }, true),
    dispose() {
      if (disposed) return; disposed = true; abort?.abort();
      state = Object.freeze({ ...state, status: 'disposed', phase: null, catalog: null, selected: null,
        display: null, display_freshness: 'none' });
    },
  });
}
