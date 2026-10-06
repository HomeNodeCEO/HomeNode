import { prepareCustomCohortGroupWorkspaceCheckpoint } from './customCohortGroupWorkspaceTransport.ts';
import type { CustomCohortGroupWorkspaceCheckpoint } from './customCohortGroupWorkspaceTransport';
import { prepareCustomCohortRecordedGroupWrite, checkCustomCohortRecordedGroupReadReceipt } from './customCohortRecordedGroupTransport.ts';
import type { CustomCohortRecordedGroupReceipt, createCustomCohortRecordedGroupTransport } from './customCohortRecordedGroupTransport';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomWorkspaceTarget, CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Ports = Pick<ReturnType<typeof createCustomCohortRecordedGroupTransport>, 'preview' | 'opening'>;
type Selected = Exclude<CustomCohortRecordedGroupReceipt, { readonly status: 'absent' }>;
export interface CustomCohortGroupDisplayInput {
  readonly target: CustomWorkspaceTarget; readonly workspaceRevision: number;
  readonly checkpoint: CustomCohortGroupWorkspaceCheckpoint;
  readonly catalog: CheckedPocketCatalog; readonly selected: Selected;
}
export interface CustomCohortGroupDisplay {
  readonly target: CustomWorkspaceTarget; readonly workspace_revision: number;
  readonly active: NonNullable<CustomCohortGroupWorkspaceCheckpoint['active']>;
  readonly catalog: CheckedPocketCatalog; readonly selected: Selected;
  readonly observations: Awaited<ReturnType<Ports['preview']>>;
  readonly manifest: Awaited<ReturnType<Ports['opening']>>['manifest'];
}
const admitted = new WeakSet<object>(); // A composed display, not a source/Apply capability.
const PROBE = '10000000-0000-4000-8000-000000000001';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never { throw new TypeError('invalid_custom_cohort_group_display'); }
const requireThat: (value: unknown) => asserts value = value => { if (!value) fail(); };

/** The lifecycle owns an immutable checked catalog; do not freeze caller state
 * or reread a mutable member/name list after a network await. The catalog is
 * still the installed complete bounded catalog, not a paged >50k population. */
function prepare(value: CustomCohortGroupDisplayInput) {
  requireThat(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 5
    && ['target', 'workspaceRevision', 'checkpoint', 'catalog', 'selected'].every(key => Object.hasOwn(value, key)));
  for (const key of ['target', 'workspaceRevision', 'checkpoint', 'catalog', 'selected']) {
    const d = Object.getOwnPropertyDescriptor(value, key); requireThat(d?.enumerable && Object.hasOwn(d, 'value'));
  }
  const t = value.target;
  requireThat(t && Object.getPrototypeOf(t) === Object.prototype && Reflect.ownKeys(t).length === 3);
  for (const key of ['accountId', 'assignmentFileId', 'sessionKey']) {
    const d = Object.getOwnPropertyDescriptor(t, key); requireThat(d?.enumerable && Object.hasOwn(d, 'value'));
  }
  requireThat(t && typeof t.sessionKey === 'string' && t.sessionKey.length > 0 && t.sessionKey.length <= 200
    && t.sessionKey.trim() === t.sessionKey && [...t.sessionKey].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    && Number.isInteger(value.workspaceRevision) && value.workspaceRevision > 0 && value.workspaceRevision <= 2147483647);
  const checkpoint = prepareCustomCohortGroupWorkspaceCheckpoint(value.checkpoint), active = checkpoint.active;
  requireThat(active);
  const parsed = prepareCustomCohortRecordedGroupWrite({ accountId: t.accountId, assignmentFileId: t.assignmentFileId,
    contextRef: active.context_ref, expectedSelectionRef: null, operationId: PROBE, includedRecordedGroupIds: [] });
  const target = Object.freeze({ accountId: parsed.accountId, assignmentFileId: parsed.assignmentFileId, sessionKey: t.sessionKey });
  const request = Object.freeze({ accountId: target.accountId, assignmentFileId: target.assignmentFileId,
    contextRef: active.context_ref, selectionRef: active.selection_ref });
  const selected = checkCustomCohortRecordedGroupReadReceipt(value.selected,
    { accountId: request.accountId, assignmentFileId: request.assignmentFileId, contextRef: request.contextRef });
  requireThat(selected.status !== 'absent' && same(selected.selection_ref, active.selection_ref));
  const catalog = value.catalog;
  requireThat(Object.isFrozen(catalog) && catalog.catalog_version === 3 && catalog.status === 'review_only'
    && Object.isFrozen(catalog.binding) && Object.isFrozen(catalog.binding.context_ref)
    && same(catalog.binding.context_ref, active.context_ref) && catalog.binding.selection_revision === active.selection_ref.selection_revision
    && Object.isFrozen(catalog.subject_membership) && catalog.subject_membership.account_id === target.accountId
    && Object.isFrozen(catalog.pockets) && catalog.pockets.every(p => Object.isFrozen(p) && Object.isFrozen(p.account_ids))
    && Object.isFrozen(catalog.unassigned) && Object.isFrozen(catalog.unassigned.account_ids));
  const available = new Set([...catalog.pockets.map(p => p.id), ...(catalog.unassigned.member_count ? ['discovery:unassigned'] : [])]);
  requireThat(selected.included_recorded_group_ids.every(id => available.has(id)));
  const accounts = new Set<string>(), includedAccounts = new Set<string>(), choices = new Set(selected.included_recorded_group_ids);
  for (const group of [...catalog.pockets, { id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }]) {
    for (const account of group.account_ids) { accounts.add(account); if (choices.has(group.id)) includedAccounts.add(account); }
  }
  return Object.freeze({ target, workspaceRevision: value.workspaceRevision, active, catalog, selected, request,
    capturedCount: accounts.size, selectedCount: includedAccounts.size });
}

/** Publish the numeric population and neutral opening only after BOTH checked
 * ports completed with the same saved head and period. Calls are sequential
 * under the caller's finite assignment/session lane, never parallel SQL owners.
 * No intermediate observations reach onChange, and no local selection hash,
 * account-list request, Apply permission, retry or independent timer is made. */
export function createCustomCohortGroupDisplayReader(ports: Ports) {
  requireThat(typeof ports.preview === 'function' && typeof ports.opening === 'function');
  return async (value: CustomCohortGroupDisplayInput, io: CustomWorkspaceOperationOptions): Promise<CustomCohortGroupDisplay> => {
    requireThat(Number.isFinite(io?.deadline) && io.deadline > 0 && io.signal instanceof AbortSignal);
    const pinned = prepare(value);
    const live = () => { if (io.signal.aborted) throw new DOMException('Neighborhood display cancelled', 'AbortError'); };
    live();
    const observations = await ports.preview(pinned.request, io); live();
    const b = observations.binding, period = observations.summary.observation_period;
    requireThat(Object.isFrozen(observations) && b.accountId === pinned.target.accountId
      && b.assignmentFileId === pinned.target.assignmentFileId && same(b.contextRef, pinned.active.context_ref)
      && b.selectionRevision === pinned.active.selection_ref.selection_revision
      && b.selectionFingerprint === pinned.active.selection_ref.selection_sha256
      && same(observations.selection_ref, pinned.active.selection_ref)
      && period && typeof period === 'object' && !Array.isArray(period) && Object.keys(period).length === 2
      && period.start_date === pinned.active.observation_period.start_date && period.end_date === pinned.active.observation_period.end_date);
    const all = observations.summary.all, selected = observations.summary.selected;
    requireThat(all && typeof all === 'object' && !Array.isArray(all) && all.account_count === pinned.capturedCount
      && selected && typeof selected === 'object' && !Array.isArray(selected) && selected.account_count === pinned.selectedCount);
    const opening = await ports.opening(pinned.request, pinned.selected, pinned.catalog, io); live();
    requireThat(Object.isFrozen(opening) && Object.isFrozen(opening.manifest)
      && same(opening.selection_ref, pinned.active.selection_ref)
      && same(opening.manifest.context_ref, pinned.active.context_ref));
    const result: CustomCohortGroupDisplay = Object.freeze({ target: pinned.target, workspace_revision: pinned.workspaceRevision,
      active: pinned.active, catalog: pinned.catalog, selected: pinned.selected, observations, manifest: opening.manifest });
    admitted.add(result); return result;
  };
}

/** Only this reader's checked composition can become lifecycle display state.
 * A clone/raw envelope is not an accepted display. This witness is deliberately
 * local and cannot authorize a server read, save, Apply or accepted report. */
export function checkCustomCohortGroupDisplayResult(value: unknown, expected: CustomCohortGroupDisplayInput): CustomCohortGroupDisplay {
  requireThat(value && typeof value === 'object' && admitted.has(value));
  const pinned = prepare(expected), result = value as CustomCohortGroupDisplay;
  requireThat(same(result.target, pinned.target) && result.workspace_revision === pinned.workspaceRevision
    && same(result.active, pinned.active) && result.catalog === pinned.catalog
    && same(result.selected, pinned.selected));
  return result;
}

/** View adapters may only project the actual composed immutable display, not a
 * look-alike legacy group or a raw response. This is not server authority. */
export function requireCustomCohortGroupDisplay(value: unknown): CustomCohortGroupDisplay {
  requireThat(value && typeof value === 'object' && admitted.has(value));
  return value as CustomCohortGroupDisplay;
}
