import { requireCustomCohortGroupDisplay } from './customCohortGroupDisplay.ts';
import type { CustomCohortGroupDisplay } from './customCohortGroupDisplay';
import { prepareCustomCohortGroupMarketWindow, checkCustomCohortGroupMarketResponse } from './customCohortGroupMarketTransport.ts';
import type { createCustomCohortGroupMarketTransport, CustomCohortGroupMarketWindow } from './customCohortGroupMarketTransport';
import type { CustomCohortGroupMarketResponse } from './customCohortGroupMarketTransport';
import type { CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

type Port = ReturnType<typeof createCustomCohortGroupMarketTransport>;
export interface CustomCohortGroupMarketArea {
  readonly display: CustomCohortGroupDisplay;
  read(window: CustomCohortGroupMarketWindow, io: CustomWorkspaceOperationOptions): Promise<CustomCohortGroupMarketResponse>;
}
/** Checked-display projection, not a look-alike legacy group. The keyed host
 * must also fence the CURRENT display/session at queue admission AND settlement;
 * this local witness is neither current assignment/source nor Apply authority. */
export function createCustomCohortGroupMarketReader(port: Port) {
  if (typeof port !== 'function') throw new TypeError('invalid_custom_cohort_group_market_port');
  return async (value: CustomCohortGroupDisplay, window: CustomCohortGroupMarketWindow, io: CustomWorkspaceOperationOptions) => {
    const display = requireCustomCohortGroupDisplay(value), study = prepareCustomCohortGroupMarketWindow(window);
    const live = () => {
      if (!(io?.signal instanceof AbortSignal) || !Number.isFinite(io.deadline) || io.deadline <= performance.now())
        throw new Error('custom_workspace_deadline');
      if (io.signal.aborted) throw new DOMException('Neighborhood market study cancelled', 'AbortError');
    };
    live();
    const request = Object.freeze({ accountId: display.target.accountId, assignmentFileId: display.target.assignmentFileId,
      contextRef: display.active.context_ref, selectionRef: display.active.selection_ref, ...study });
    const result = await port(request, io);
    live(); return checkCustomCohortGroupMarketResponse(result, request);
  };
}
