import { requireCustomCohortGroupDisplay } from './customCohortGroupDisplay.ts';
import type { CustomCohortGroupDisplay } from './customCohortGroupDisplay';
import { createCustomCohortMemberContinuation } from './customCohortMemberPage.ts';
import type { CustomCohortMemberExpectation, CustomCohortMemberKind, CustomCohortMemberPageRequest } from './customCohortMemberPage';
import type { createCustomCohortRecordedGroupTransport, CustomCohortRecordedGroupMemberContinuation } from './customCohortRecordedGroupTransport';
import type { CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Ports = Pick<ReturnType<typeof createCustomCohortRecordedGroupTransport>, 'members'>;
export type CustomCohortGroupInspectedPage = Awaited<ReturnType<Ports['members']>>;
const KINDS = ['stock', 'source_reported', 'transactions', 'omitted_transactions'] as const;
const views = new WeakMap<CustomCohortGroupDisplay, Readonly<Record<CustomCohortMemberKind, CustomCohortMemberExpectation>>>();
const continuations = new WeakSet<object>(); // Local continuity, not server access.
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const requireThat: (value: unknown) => asserts value = value => { if (!value) throw new TypeError('invalid_custom_cohort_group_member_view'); };

/** Read-only inspection of the same complete selected population as the coherent
 * display. A visible viewport, a phase subset, or a target number of sales never
 * defines this population. The composed display witness is not source authority. */
export function prepareCustomCohortGroupMemberView(value: CustomCohortGroupDisplay) {
  const display = requireCustomCohortGroupDisplay(value), cached = views.get(display);
  if (cached) return cached;
  const selected = object(display.observations.summary.selected);
  const result = {} as Record<CustomCohortMemberKind, CustomCohortMemberExpectation>;
  for (const kind of KINDS) {
    const source = object(selected[kind === 'omitted_transactions' ? 'transactions' : kind]);
    const descriptor = object(source[kind === 'omitted_transactions' ? 'omitted_inspection' : 'inspection']);
    const population = object(descriptor.population), total = descriptor.total_count;
    requireThat(population.group === 'selected' && population.kind === kind && Object.keys(population).length === 2
      && descriptor.maximum_page_size === 50 && Number.isSafeInteger(total) && Number(total) >= 0 && Number(total) <= 100000
      && total === source[kind === 'omitted_transactions' ? 'omitted_count' : 'member_count']);
    result[kind] = Object.freeze({ group: 'selected', kind, total_count: Number(total) });
  }
  const view = Object.freeze(result); views.set(display, view); return view;
}

/** Compact, decoder-owned continuity only; no prior rows or caller-constructed
 * cursor can substitute for the retained member-page proof. */
export function createCustomCohortGroupMemberViewContinuation(page: CustomCohortGroupInspectedPage): CustomCohortRecordedGroupMemberContinuation {
  const result = Object.freeze({ selection_ref: page.selection_ref, members: createCustomCohortMemberContinuation(page.members) });
  continuations.add(result); return result;
}

/** One already-checked exact-reference port, under the host's finite session
 * lane. No local fingerprint, flat account request, timer, retry or write. The
 * transport retains current source/assignment and full continuation admission. */
export function createCustomCohortGroupMemberReader(ports: Ports) {
  requireThat(typeof ports.members === 'function');
  return async (value: CustomCohortGroupDisplay, kind: CustomCohortMemberKind, page: CustomCohortMemberPageRequest,
    io: CustomWorkspaceOperationOptions, previous?: CustomCohortRecordedGroupMemberContinuation): Promise<CustomCohortGroupInspectedPage> => {
    const display = requireCustomCohortGroupDisplay(value), expected = prepareCustomCohortGroupMemberView(display);
    requireThat(KINDS.includes(kind) && Number.isFinite(io?.deadline) && io.deadline > 0 && io.signal instanceof AbortSignal);
    requireThat(previous === undefined || (previous && continuations.has(previous)));
    const live = () => { if (io.signal.aborted) throw new DOMException('Neighborhood records cancelled', 'AbortError'); };
    live();
    const result = await ports.members({ accountId: display.target.accountId, assignmentFileId: display.target.assignmentFileId,
      contextRef: display.active.context_ref, selectionRef: display.active.selection_ref, population: { group: 'selected', kind }, page },
    display.selected, display.catalog, expected[kind], io, previous);
    live();
    const summary = display.observations.summary, checked = result.members.page;
    requireThat(JSON.stringify(result.selection_ref) === JSON.stringify(display.active.selection_ref)
      && checked.effective_date === summary.effective_date && checked.captured_at === summary.captured_at
      && checked.observation_period.start_date === display.active.observation_period.start_date
      && checked.observation_period.end_date === display.active.observation_period.end_date);
    return result;
  };
}
