import { requireCustomCohortPagedCatalog } from './customCohortPagedCatalog.ts';
import { prepareCustomCohortRecordedGroupWrite, prepareCustomCohortGroupSelectionReference,
  checkCustomCohortRecordedGroupReadReceipt } from './customCohortRecordedGroupTransport.ts';
import type { CheckedCustomCohortPagedCatalog } from './customCohortPagedCatalog';
import type { createCustomCohortRecordedGroupTransport, CustomCohortGroupSelectionRef }
  from './customCohortRecordedGroupTransport';
import type { CustomCohortContextRef } from './customCohortPreviewController';
import type { createCustomCohortPreparedCatalogClient, createCustomCohortPreparedCatalogRecheck }
  from './customCohortPreparedCatalogClient';
import type { CustomWorkspaceTarget, CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Ports = Pick<ReturnType<typeof createCustomCohortRecordedGroupTransport>, 'read' | 'preview'> & {
  readonly catalog: ReturnType<typeof createCustomCohortPreparedCatalogClient>;
  readonly currentCatalog: ReturnType<typeof createCustomCohortPreparedCatalogRecheck>;
};
type Selected = Exclude<Awaited<ReturnType<Ports['read']>>, { readonly status: 'absent' }>;
export interface CustomCohortPreparedStatisticsInput {
  readonly target: CustomWorkspaceTarget; readonly workspaceRevision: number;
  readonly contextRef: CustomCohortContextRef; readonly selectionRef: CustomCohortGroupSelectionRef;
  readonly observationPeriod: { readonly start_date: string; readonly end_date: string };
}
export interface CustomCohortPreparedStatisticsDisplay {
  readonly target: CustomWorkspaceTarget; readonly workspace_revision: number;
  readonly catalog: CheckedCustomCohortPagedCatalog; readonly selected: Selected;
  readonly observations: Awaited<ReturnType<Ports['preview']>>;
  readonly observation_period: CustomCohortPreparedStatisticsInput['observationPeriod'];
}
export type CustomCohortPreparedStatisticsResult = { readonly status: 'not_prepared' } |
  { readonly status: 'available'; readonly display: CustomCohortPreparedStatisticsDisplay };
const issued = new WeakSet<object>(), PROBE = '10000000-0000-4000-8000-000000000001';
// Compare decoder-produced closed records (or sorted IDs), never raw wire key
// order. Each admitted context/ref/period has its own canonical field order.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never { throw new TypeError('invalid_custom_cohort_prepared_statistics_display'); }
function check(v: unknown): asserts v { if (!v) fail(); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length);
  const result: Record<string, unknown> = {};
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(value, key);
    check(d?.enumerable && Object.hasOwn(d, 'value')); result[key] = d.value; }
  return result;
}
function date(value: unknown): string {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  const epoch = new Date(`${value}T00:00:00.000Z`); check(Number.isFinite(epoch.getTime()) && epoch.toISOString().slice(0, 10) === value);
  return value;
}
function prepare(value: unknown) {
  const v = closed(value, ['target', 'workspaceRevision', 'contextRef', 'selectionRef', 'observationPeriod']);
  const t = closed(v.target, ['accountId', 'assignmentFileId', 'sessionKey']);
  check(typeof t.sessionKey === 'string' && t.sessionKey.length > 0 && t.sessionKey.length <= 200
    && t.sessionKey.trim() === t.sessionKey && !/\p{Cc}/u.test(t.sessionKey));
  check(typeof v.workspaceRevision === 'number' && Number.isInteger(v.workspaceRevision)
    && v.workspaceRevision > 0 && v.workspaceRevision <= 2147483647);
  const parsed = prepareCustomCohortRecordedGroupWrite({ accountId: t.accountId, assignmentFileId: t.assignmentFileId,
    contextRef: v.contextRef, expectedSelectionRef: null, operationId: PROBE, includedRecordedGroupIds: [] });
  const target = Object.freeze({ accountId: parsed.accountId, assignmentFileId: parsed.assignmentFileId, sessionKey: t.sessionKey });
  const period = closed(v.observationPeriod, ['start_date', 'end_date']);
  const observationPeriod = Object.freeze({ start_date: date(period.start_date), end_date: date(period.end_date) });
  check(observationPeriod.start_date <= observationPeriod.end_date);
  const selectionRef = prepareCustomCohortGroupSelectionReference(v.selectionRef);
  const request = Object.freeze({ accountId: target.accountId, assignmentFileId: target.assignmentFileId,
    contextRef: parsed.contextRef, selectionRef });
  const read = Object.freeze({ accountId: target.accountId, assignmentFileId: target.assignmentFileId, contextRef: parsed.contextRef });
  return Object.freeze({ target, workspaceRevision: v.workspaceRevision, observationPeriod, request, read });
}

/** Statistics-only coherent bundle over the actual prepared display directory.
 * Counts are an exact sum over its original-verified nonoverlapping partition;
 * medians/COD/trends remain the COMPLETE server calculator's original values.
 * No page/group median averaging or local numeric/statistical authority. This
 * has NO map/member witness: keep those existing individual checks unchanged.
 * Serial fixed reads end with current catalog and current saved selection
 * checks; partial observations never publish. No timer/retry/write/host switch.
 * The host must still fence keyed current session/workspace BOTH ends. */
export function createCustomCohortPreparedStatisticsReader(ports: Ports) {
  check(['catalog', 'currentCatalog', 'read', 'preview'].every(k => typeof ports[k as keyof Ports] === 'function'));
  const { catalog: load, currentCatalog, read, preview } = ports;
  return async (value: CustomCohortPreparedStatisticsInput, io: CustomWorkspaceOperationOptions): Promise<CustomCohortPreparedStatisticsResult> => {
    const pinned = prepare(value), signal = io?.signal, deadline = io?.deadline;
    const live = () => {
      check(signal instanceof AbortSignal && Number.isFinite(deadline));
      if (signal.aborted) throw new DOMException('Neighborhood statistics cancelled', 'AbortError');
      if (performance.now() >= deadline) throw new Error('custom_workspace_deadline');
    };
    const boundedIo = Object.freeze({ signal, deadline }); live();
    const loaded = await load(pinned.read, boundedIo); live();
    if (loaded.status === 'not_prepared') return Object.freeze({ status: 'not_prepared' });
    const catalog = requireCustomCohortPagedCatalog(loaded.catalog);
    check(catalog.request.accountId === pinned.target.accountId && catalog.request.assignmentFileId === pinned.target.assignmentFileId
      && same(catalog.request.contextRef, pinned.read.contextRef));
    const selection = (raw: unknown) => {
      const selected = checkCustomCohortRecordedGroupReadReceipt(raw, pinned.read);
      check(selected.status !== 'absent' && same(selected.selection_ref, pinned.request.selectionRef)); return selected;
    };
    const selected = selection(await read(pinned.read, boundedIo)); live();
    const groups = new Map(catalog.groups.map(g => [g.id, g])), choices = selected.included_recorded_group_ids;
    check(choices.every(id => groups.has(id)));
    const count = choices.reduce((n, id) => n + groups.get(id)!.member_count, 0);
    check(Number.isSafeInteger(count) && count <= catalog.account_count);
    const observations = await preview(pinned.request, boundedIo); live();
    const b = observations.binding, summary = observations.summary;
    check(Object.isFrozen(observations) && Object.isFrozen(summary) && b.accountId === pinned.target.accountId
      && b.assignmentFileId === pinned.target.assignmentFileId && same(b.contextRef, pinned.request.contextRef)
      && b.selectionRevision === pinned.request.selectionRef.selection_revision
      && b.selectionFingerprint === pinned.request.selectionRef.selection_sha256
      && same(observations.selection_ref, pinned.request.selectionRef)
      && same(closed(summary.observation_period, ['start_date', 'end_date']), pinned.observationPeriod));
    // Numeric envelopes allow arbitrary JSON. Check object shape before asking
    // for keys so a missing/null population follows our deliberate refusal path.
    const all = summary.all, selectedPopulation = summary.selected;
    check(all && typeof all === 'object' && Object.getPrototypeOf(all) === Object.prototype
      && selectedPopulation && typeof selectedPopulation === 'object'
      && Object.getPrototypeOf(selectedPopulation) === Object.prototype);
    check(closed(all, Object.keys(all)).account_count === catalog.account_count
      && closed(selectedPopulation, Object.keys(selectedPopulation)).account_count === count);
    // One bounded directory read, not another whole catalog/page transfer.
    check(await currentCatalog(catalog, boundedIo)); live();
    const ending = selection(await read(pinned.read, boundedIo)); live();
    check(same(ending.included_recorded_group_ids, choices));
    const display = Object.freeze({ target: pinned.target, workspace_revision: pinned.workspaceRevision, catalog, selected,
      observations, observation_period: pinned.observationPeriod });
    issued.add(display); return Object.freeze({ status: 'available', display });
  };
}

export function requireCustomCohortPreparedStatisticsDisplay(value: unknown): CustomCohortPreparedStatisticsDisplay {
  check(value && typeof value === 'object' && issued.has(value)); return value as CustomCohortPreparedStatisticsDisplay;
}
