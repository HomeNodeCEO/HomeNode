import { requireCustomCohortGroupDisplay } from './customCohortGroupDisplay.ts';
import type { CustomCohortGroupDisplay } from './customCohortGroupDisplay';
import { loadCustomCohortCheckedViewportTiles } from './customCohortViewportLoader.ts';
import type { CustomCohortViewportBounds, CheckedViewportMap } from './customCohortViewportClient';
import type { CustomCohortMapDisplay } from './customCohortMapPresentation';
import type { createCustomCohortRecordedGroupTransport } from './customCohortRecordedGroupTransport';
import type { CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

const views = new WeakMap<CustomCohortGroupDisplay, CustomCohortGroupMapView>();
export interface CustomCohortGroupMapView {
  readonly display: CustomCohortGroupDisplay;
  readonly group: CustomCohortMapDisplay;
  readonly included_recorded_group_ids: readonly string[];
  readonly isSelectedAccount: (accountId: string) => boolean;
}

/** Project one coherent display for the existing label/score renderer without
 * inventing a legacy request or flattening memberships into browser writes.
 * These local lookup sets only restyle geometry; never feed them to statistics,
 * a report, or a source request. All numeric observations stay in display. */
export function prepareCustomCohortGroupMapView(value: CustomCohortGroupDisplay): CustomCohortGroupMapView {
  const display = requireCustomCohortGroupDisplay(value), prior = views.get(display);
  if (prior) return prior;
  const chosen = new Set(display.selected.included_recorded_group_ids), selected = new Set<string>();
  for (const group of [...display.catalog.pockets, { id: 'discovery:unassigned', account_ids: display.catalog.unassigned.account_ids }]) {
    if (chosen.has(group.id)) for (const account of group.account_ids) selected.add(account);
  }
  const group: CustomCohortMapDisplay = Object.freeze({ binding: display.observations.binding,
    parcel_map: Object.freeze({ status: 'deferred' as const, reason: 'viewport_required' as const }),
    map_manifest: display.manifest });
  const result = Object.freeze({ display, group, included_recorded_group_ids: display.selected.included_recorded_group_ids,
    isSelectedAccount: (accountId: string) => selected.has(accountId) });
  views.set(display, result); return result;
}

/** Every leaf uses the saved display's same exact current reference, receipt
 * and catalog. Pan bounds cannot select properties or restrict summary data.
 * The host owns admission, finite deadline, cancellation and recovery. There
 * is no independent timer/retry, transport, SQL owner or UI activation here. */
export function createCustomCohortGroupMapReader(ports: Pick<ReturnType<typeof createCustomCohortRecordedGroupTransport>, 'viewport'>) {
  if (typeof ports.viewport !== 'function') throw new TypeError('invalid_custom_cohort_group_map_view');
  return async (value: CustomCohortGroupDisplay, bounds: CustomCohortViewportBounds,
    io: CustomWorkspaceOperationOptions): Promise<CheckedViewportMap> => {
    const display = requireCustomCohortGroupDisplay(value);
    if (!Number.isFinite(io?.deadline) || io.deadline <= 0 || !(io.signal instanceof AbortSignal))
      throw new TypeError('invalid_custom_cohort_group_map_view');
    if (io.signal.aborted) throw new DOMException('Neighborhood map cancelled', 'AbortError');
    if (display.manifest.status === 'unavailable') return Object.freeze({ status: 'unavailable',
      features: Object.freeze([]), reason: display.manifest.reason });
    const request = Object.freeze({ accountId: display.target.accountId, assignmentFileId: display.target.assignmentFileId,
      contextRef: display.active.context_ref, selectionRef: display.active.selection_ref });
    return loadCustomCohortCheckedViewportTiles(display.manifest, bounds, { signal: io.signal,
      request: async (viewport, signal) => {
        const result = await ports.viewport({ ...request, viewport }, display.selected, display.catalog,
          display.manifest.status === 'available' ? display.manifest.counts.captured_parcels : null, { signal });
        if (JSON.stringify(result.selection_ref) !== JSON.stringify(request.selectionRef))
          throw new TypeError('invalid_custom_cohort_group_map_view');
        return result.map;
      } });
  };
}
