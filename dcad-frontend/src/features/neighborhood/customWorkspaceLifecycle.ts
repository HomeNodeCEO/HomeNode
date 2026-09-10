import { prepareCustomWorkspaceCheckpoint, prepareCustomWorkspacePrivateSalesImport, readCustomWorkspaceCheckpoint, restoreCustomWorkspaceSelection,
  CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION } from './customWorkspaceCheckpoint';
import type { CustomWorkspaceCheckpoint, CustomWorkspaceObservationPeriod, CustomWorkspacePrivateSalesImport } from './customWorkspaceCheckpoint';
import { checkCustomCohortPocketCatalog, customCohortCatalogGroupIds } from './customCohortPocketCatalog';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortContextRef, CustomCohortPreviewInput } from './customCohortPreviewController';

export interface CustomWorkspaceTarget { readonly accountId: string; readonly assignmentFileId: string; readonly sessionKey: string }
export interface CustomWorkspaceOperationOptions { readonly signal: AbortSignal; readonly deadline: number }
type Recovery = 'reload' | 'resume_pending' | 'reopen' | null;
export interface CustomWorkspaceLifecycleState {
  readonly target: CustomWorkspaceTarget;
  readonly status: 'idle' | 'pending' | 'ready' | 'busy' | 'invalid' | 'error' | 'disposed';
  readonly operation_pending: boolean;
  readonly phase: string | null; readonly section_revision: number | null;
  readonly checkpoint: CustomWorkspaceCheckpoint | null; readonly catalog: CheckedPocketCatalog | null;
  readonly selection: CustomCohortPreviewInput['selection'] | null;
  readonly error: string | null; readonly recovery: Recovery;
}
interface Options {
  target: CustomWorkspaceTarget; initialSection: unknown;
  save: (input: { target: CustomWorkspaceTarget; sectionKey: string; value: CustomWorkspaceCheckpoint; expectedRevision: number },
    options: CustomWorkspaceOperationOptions) => Promise<unknown>;
  capture: (input: { target: CustomWorkspaceTarget; operationId: string; observationPeriod: CustomWorkspaceObservationPeriod;
    privateSalesImport?: CustomWorkspacePrivateSalesImport },
    options: CustomWorkspaceOperationOptions) => Promise<unknown>;
  catalog: (input: CustomCohortPreviewInput, options: CustomWorkspaceOperationOptions) => Promise<unknown>;
  onChange: (state: CustomWorkspaceLifecycleState) => void;
  operationId?: () => string; now?: () => number; timeoutMs?: number;
  timer?: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}
const EMPTY = prepareCustomWorkspaceCheckpoint({ workspace_version: 1, active: null, pending_capture: null });
const fault = (code: string) => Object.assign(new Error(`custom_workspace_${code}`), { workspaceCode: code });
const requireThat: (ok: unknown, code: string) => asserts ok = (ok, code) => { if (!ok) throw fault(code); };
const object = (value: unknown): Record<string, unknown> => {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_response');
  return value as Record<string, unknown>;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0
  && value.length <= maximum && value.trim() === value && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

/** One target/session owner, no React, fetch, auth, source policy or report Apply.
 * Adapters must bind I/O to this target and honor signal/deadline. Host reloads
 * must come from a fresh current-generation read, never a cached starting value.
 * Busy/unsettled requests reject competing work rather than queue stale writes.
 */
export function createCustomWorkspaceLifecycle(options: Options) {
  const sourceTarget = options.target;
  requireThat(text(sourceTarget?.accountId, 64) && text(sourceTarget?.sessionKey, 200)
    && typeof sourceTarget?.assignmentFileId === 'string' && /^[1-9][0-9]{0,18}$/.test(sourceTarget.assignmentFileId)
    && BigInt(sourceTarget.assignmentFileId) <= 9223372036854775807n, 'invalid_target');
  for (const fn of [options.save, options.capture, options.catalog, options.onChange]) requireThat(typeof fn === 'function', 'dependencies_required');
  const target = Object.freeze({ accountId: sourceTarget.accountId, assignmentFileId: sourceTarget.assignmentFileId, sessionKey: sourceTarget.sessionKey });
  const now = options.now ?? (() => performance.now()), timeout = options.timeoutMs ?? 180_000;
  requireThat(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 180_000, 'invalid_timeout');
  const timer = options.timer ?? { set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let busy = false, disposed = false, unsettled = 0, abort: AbortController | null = null;
  let attemptedPending: CustomWorkspaceCheckpoint['pending_capture'] = null;
  let attemptedPrivateContext: CustomCohortContextRef | null = null;
  let attemptedClear: { expectedRevision: number; value: CustomWorkspaceCheckpoint } | null = null;
  let state: CustomWorkspaceLifecycleState = Object.freeze({ target, status: 'idle', phase: null, operation_pending: false,
    section_revision: 0, checkpoint: null, catalog: null, selection: null, error: null, recovery: null });
  function emit(patch: Partial<CustomWorkspaceLifecycleState>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    try { options.onChange(state); } catch { /* Observer failures cannot change a persistence outcome. */ }
  }
  function adopt(section: unknown) {
    const parsed = readCustomWorkspaceCheckpoint(section);
    if (parsed.status === 'invalid') {
      emit({ status: 'invalid', section_revision: null, checkpoint: null, catalog: null, selection: null,
        error: 'invalid_checkpoint', recovery: 'reload' }); return false;
    }
    const checkpoint = parsed.checkpoint;
    emit({ status: checkpoint?.pending_capture ? 'pending' : 'idle', section_revision: parsed.section_revision,
      checkpoint, catalog: null, selection: null, error: null, recovery: null });
    return true;
  }
  adopt(options.initialSection);
  async function run(allowedRecovery: Recovery, task: (io: <T>(fn: (value: CustomWorkspaceOperationOptions) => Promise<T>) => Promise<T>,
    stage: (phase: string, recovery: Recovery) => void) => Promise<void>, reload = false) {
    requireThat(!disposed, 'disposed'); requireThat(!busy && unsettled === 0, 'busy');
    requireThat(reload || (state.status !== 'invalid' && (!state.recovery || state.recovery === allowedRecovery)), 'recovery_required');
    const before = state; let staged = false;
    busy = true; emit({ operation_pending: true }); let recovery: Recovery = allowedRecovery;
    const owner = new AbortController(), deadline = now() + timeout;
    abort = owner;
    const handle = timer.set(() => owner.abort(), timeout);
    const live = () => { requireThat(!disposed && !owner.signal.aborted && now() < deadline, 'cancelled_or_timed_out'); };
    const stage = (phase: string, next: Recovery) => { live(); staged = true; recovery = next; emit({ status: 'busy', phase, error: null, recovery: null }); };
    const io = async <T,>(fn: (value: CustomWorkspaceOperationOptions) => Promise<T>): Promise<T> => {
      live(); unsettled += 1;
      const work = Promise.resolve().then(() => { live(); return fn({ signal: owner.signal, deadline }); });
      const settled = () => { unsettled -= 1; if (!busy) emit({ operation_pending: unsettled > 0 }); };
      void work.then(settled, settled);
      let cancelled: () => void = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => {
        cancelled = () => reject(fault('cancelled_or_timed_out'));
        owner.signal.addEventListener('abort', cancelled, { once: true });
      });
      try { const result = await Promise.race([work, cancellation]); live(); return result; }
      finally { owner.signal.removeEventListener('abort', cancelled); }
    };
    try { await task(io, stage); }
    catch (error) {
      emit({ status: staged ? 'error' : before.status, phase: null, catalog: staged ? null : before.catalog,
        selection: staged ? null : before.selection, recovery: staged ? recovery : before.recovery,
        error: error instanceof Error && 'workspaceCode' in error ? String(error.workspaceCode) : 'operation_failed' });
      throw error instanceof Error && 'workspaceCode' in error ? error : fault('operation_failed');
    } finally { timer.clear(handle); if (abort === owner) abort = null; busy = false; emit({ operation_pending: unsettled > 0 }); }
    return state;
  }
  type IO = Parameters<Parameters<typeof run>[1]>[0];
  type Stage = Parameters<Parameters<typeof run>[1]>[1];
  async function persist(value: CustomWorkspaceCheckpoint, io: IO) {
    requireThat(state.section_revision !== null && state.section_revision < 2_147_483_647, 'section_revision');
    const expected = state.section_revision, checked = prepareCustomWorkspaceCheckpoint(value);
    const ack = object(await io(signal => options.save({ target, sectionKey: CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION,
      value: checked, expectedRevision: expected }, signal)));
    requireThat(ack.accountId === target.accountId && ack.assignmentFileId === target.assignmentFileId, 'save_target_mismatch');
    const saved = readCustomWorkspaceCheckpoint(ack.section);
    requireThat(saved.status === 'restored' && saved.section_revision === expected + 1 && same(saved.checkpoint, checked), 'save_ack_mismatch');
    emit({ checkpoint: saved.checkpoint, section_revision: saved.section_revision });
  }
  async function loadCatalog(ref: CustomCohortContextRef, revision: number, io: IO) {
    const input: CustomCohortPreviewInput = Object.freeze({ accountId: target.accountId, assignmentFileId: target.assignmentFileId,
      contextRef: ref, selection: Object.freeze({ revision, pockets: Object.freeze([]) }) });
    return checkCustomCohortPocketCatalog(await io(signal => options.catalog(input, signal)), input);
  }
  function ready(catalog: CheckedPocketCatalog) {
    const restored = restoreCustomWorkspaceSelection({ value: state.checkpoint, revision: state.section_revision }, catalog);
    requireThat(restored.status === 'restored', 'selection_restore_failed');
    emit({ status: 'ready', phase: null, catalog, selection: restored.selection, error: null, recovery: null });
  }
  async function reopen(io: IO, stage: Stage) {
    const active = state.checkpoint?.active;
    if (!active) { emit({ status: state.checkpoint?.pending_capture ? 'pending' : 'idle', phase: null, error: null, recovery: null }); return; }
    stage('loading_active_catalog', 'reopen');
    ready(await loadCatalog(active.context_ref, active.selection.revision, io));
  }
  async function acquire(pending: NonNullable<CustomWorkspaceCheckpoint['pending_capture']>, savePending: boolean, io: IO, stage: Stage) {
    const privateInput = pending.private_sales_import, version = privateInput ? 2 : 1;
    if (savePending) {
      stage('saving_pending', 'reload');
      await persist(prepareCustomWorkspaceCheckpoint({ ...(state.checkpoint ?? EMPTY), workspace_version: version, pending_capture: pending }), io);
    }
    stage('capturing', 'resume_pending');
    const response = object(await io(signal => options.capture({ target, operationId: pending.operation_id,
      observationPeriod: pending.observation_period, ...(privateInput ? { privateSalesImport: privateInput } : {}) }, signal)));
    requireThat(response.status === 'registered' && typeof response.reused === 'boolean' && response.source_query_complete === true, 'capture_response');
    if (privateInput) {
      let echoed: CustomWorkspacePrivateSalesImport;
      try { echoed = prepareCustomWorkspacePrivateSalesImport(response.private_sales_import); }
      catch { throw fault('capture_private_sales_mismatch'); }
      requireThat(same(echoed, privateInput), 'capture_private_sales_mismatch');
    } else requireThat(!Object.hasOwn(response, 'private_sales_import'), 'capture_private_sales_mismatch');
    const draft = prepareCustomWorkspaceCheckpoint({ workspace_version: version, active: { context_ref: response.context_ref,
      observation_period: pending.observation_period, selection: { revision: 1, included_recorded_group_ids: [] } }, pending_capture: null });
    requireThat(draft.active?.context_ref.context_id === pending.operation_id, 'capture_operation_mismatch');
    if (privateInput) attemptedPrivateContext = draft.active.context_ref;
    stage('loading_captured_catalog', 'resume_pending');
    const catalog = await loadCatalog(draft.active.context_ref, 1, io);
    if (privateInput) {
      requireThat(catalog.private_sales?.binding.batch.batch_id === privateInput.batch_id
        && catalog.private_sales.binding.review.revision === privateInput.expected_review_revision
        && catalog.private_sales.observation_period.start_date === pending.observation_period.start_date
        && catalog.private_sales.observation_period.end_date === pending.observation_period.end_date, 'catalog_private_sales_mismatch');
    } else requireThat(!catalog.private_sales, 'catalog_private_sales_mismatch');
    const value = prepareCustomWorkspaceCheckpoint({ ...draft, active: { ...draft.active,
      selection: { revision: 1, included_recorded_group_ids: customCohortCatalogGroupIds(catalog) } } });
    stage('saving_active', 'reload'); await persist(value, io); attemptedPending = null; attemptedPrivateContext = null; ready(catalog);
  }
  return Object.freeze({
    getState: () => state,
    isSettled: () => !busy && unsettled === 0,
    reopen: () => run('reopen', reopen),
    start: (period: CustomWorkspaceObservationPeriod, privateSalesImport?: CustomWorkspacePrivateSalesImport) => run(null, async (io, stage) => {
      requireThat(!state.checkpoint?.pending_capture, 'pending_capture_exists');
      // Validate dates before asking for an operation UUID; retries keep the UUID
      // even if an uncertain pending save is followed by a fresh absent read.
      const privateInput = privateSalesImport === undefined ? undefined : prepareCustomWorkspacePrivateSalesImport(privateSalesImport);
      const version = privateInput ? 2 : 1;
      const checked = prepareCustomWorkspaceCheckpoint({ workspace_version: version, active: null, pending_capture: {
        operation_id: '00000001-0000-4000-8000-000000000001', observation_period: period,
        ...(privateInput ? { private_sales_import: privateInput } : {}) } }).pending_capture!;
      requireThat(!attemptedPending || (same(attemptedPending.observation_period, checked.observation_period)
        && same(attemptedPending.private_sales_import, checked.private_sales_import)), 'pending_recovery_required');
      attemptedPending ??= prepareCustomWorkspaceCheckpoint({ workspace_version: version, active: null, pending_capture: {
        ...checked, operation_id: (options.operationId ?? (() => crypto.randomUUID()))() } }).pending_capture;
      await acquire(attemptedPending!, true, io, stage);
    }),
    resumePending: () => run('resume_pending', async (io, stage) => {
      const pending = state.checkpoint?.pending_capture ?? attemptedPending;
      requireThat(pending, 'pending_capture_required');
      await acquire(pending, !state.checkpoint?.pending_capture, io, stage);
    }),
    // This deselects a pending intent, not its immutable source/context. The
    // original capture may have committed. A lost clear ACK requires fresh read.
    setAsidePending: () => run(state.recovery === 'reload' ? null : state.recovery, async (io, stage) => {
      const pending = state.checkpoint?.pending_capture ?? attemptedPending;
      requireThat(pending && state.section_revision !== null && !attemptedClear, 'pending_capture_required');
      const value = prepareCustomWorkspaceCheckpoint({ ...(state.checkpoint ?? EMPTY), pending_capture: null });
      stage('setting_aside_pending', 'reload');
      attemptedPending ??= pending;
      attemptedClear = { expectedRevision: state.section_revision, value };
      await persist(value, io);
      attemptedClear = null; attemptedPending = null; attemptedPrivateContext = null;
      await reopen(io, stage);
    }),
    setGroups: (ids: readonly string[]) => run(null, async (io, stage) => {
      const current = state.checkpoint, catalog = state.catalog;
      requireThat(current?.active && catalog && !current.pending_capture, 'ready_workspace_required');
      const value = prepareCustomWorkspaceCheckpoint({ ...current, active: { ...current.active,
        selection: { revision: current.active.selection.revision + 1, included_recorded_group_ids: ids } } });
      requireThat(restoreCustomWorkspaceSelection({ value, revision: state.section_revision }, catalog).status === 'restored', 'unknown_recorded_group');
      stage('saving_selection', 'reload'); await persist(value, io); ready(catalog);
    }),
    reload: (value: { target: CustomWorkspaceTarget; section: unknown }) => run('reload', async (io, stage) => {
      requireThat(value && Object.hasOwn(value, 'section') && value.target?.accountId === target.accountId
        && value.target.assignmentFileId === target.assignmentFileId && value.target.sessionKey === target.sessionKey, 'reload_target_mismatch');
      if (!adopt(value.section)) return;
      const active = state.checkpoint?.active;
      if (attemptedClear && state.section_revision !== null) {
        if (state.section_revision > attemptedClear.expectedRevision && same(state.checkpoint, attemptedClear.value)) {
          attemptedClear = null; attemptedPending = null; attemptedPrivateContext = null;
        } else if (state.checkpoint?.pending_capture && state.section_revision >= attemptedClear.expectedRevision) {
          // A fresh saved pending state can be explicitly resumed or set aside
          // again under its revision; do not claim the earlier clear failed.
          attemptedClear = null;
        }
      }
      if (!attemptedClear && attemptedPending && active?.context_ref.context_id === attemptedPending.operation_id
        && same(active.observation_period, attemptedPending.observation_period) && !state.checkpoint?.pending_capture
        && (!attemptedPending.private_sales_import || same(active.context_ref, attemptedPrivateContext))) {
        attemptedPending = null; attemptedPrivateContext = null;
      }
      await reopen(io, stage);
      if (attemptedClear) {
        emit({ status: 'error', recovery: 'reload', error: 'pending_clear_unconfirmed' });
      } else if (attemptedPending && !state.checkpoint?.pending_capture) {
        emit({ status: 'error', recovery: 'resume_pending', error: 'pending_save_unconfirmed' });
      }
    }, true),
    dispose() { if (disposed) return; disposed = true; abort?.abort(); state = Object.freeze({ ...state, status: 'disposed', phase: null, catalog: null, selection: null }); },
  });
}
