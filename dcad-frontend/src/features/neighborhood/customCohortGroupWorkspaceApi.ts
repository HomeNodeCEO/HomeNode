import { createCustomWorkspaceApi } from './customWorkspaceApi.ts';
import { createCustomWorkspaceSectionTransport } from './customCohortPreviewTransport.ts';
import { createCustomCohortGroupWorkspaceTransport, readCustomCohortGroupWorkspaceSection } from './customCohortGroupWorkspaceTransport.ts';
import type { CustomCohortGroupWorkspaceSection } from './customCohortGroupWorkspaceTransport';
import { createCustomCohortRecordedGroupTransport } from './customCohortRecordedGroupTransport.ts';
import { createCustomCohortGroupDisplayReader } from './customCohortGroupDisplay.ts';
import { createCustomCohortGroupMapReader } from './customCohortGroupMapView.ts';
import { createCustomCohortGroupMarketTransport } from './customCohortGroupMarketTransport.ts';
import { createCustomCohortGroupMarketReader } from './customCohortGroupMarketView.ts';
import type { CustomWorkspaceTarget, CustomWorkspaceOperationOptions } from './customWorkspaceLifecycle';

export interface CustomCohortGroupWorkspaceApiRead {
  readonly target: CustomWorkspaceTarget; readonly section: CustomCohortGroupWorkspaceSection | undefined;
  readonly status: 'draft' | 'signed' | 'archived';
}
class ApiError extends Error {
  readonly workspaceCode: string; readonly status?: number;
  readonly code?: 'viewport_detail_capacity_exceeded';
  constructor(code: string, status?: number) { super(`custom_workspace_${code}`); this.workspaceCode = code; this.status = status;
    if (code === 'viewport_detail_capacity_exceeded') this.code = code; }
}
const requireThat: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) throw new ApiError(code); };
const object = (value: unknown): Record<string, unknown> => {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_response'); return value as Record<string, unknown>;
};
function target(value: CustomWorkspaceTarget): CustomWorkspaceTarget {
  // This fresh read uses the existing generic workfile GET. Its public identity
  // is still a safe JS number; never round an int64 cohort-command target to it.
  requireThat(typeof value?.accountId === 'string' && /^[0-9A-Za-z_-]{1,50}$/.test(value.accountId)
    && typeof value.assignmentFileId === 'string' && /^[1-9][0-9]{0,15}$/.test(value.assignmentFileId)
    && Number.isSafeInteger(Number(value.assignmentFileId)) && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0 && value.sessionKey.length <= 200 && value.sessionKey.trim() === value.sessionKey
    && [...value.sessionKey].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127), 'invalid_target');
  return Object.freeze({ accountId: value.accountId, assignmentFileId: value.assignmentFileId, sessionKey: value.sessionKey });
}
const FAILURES = new Map<string, readonly [number, string]>([
  ['authentication_required', [401, 'save_authentication_required']],
  ['neighborhood_access_denied', [403, 'save_access_denied']],
  ['neighborhood_workspace_changed', [409, 'save_revision_conflict']],
  ['neighborhood_private_source_read_only', [409, 'save_read_only']],
  ['neighborhood_operation_outcome_unknown', [409, 'save_outcome_unknown']],
  ['neighborhood_service_busy', [503, 'save_service_busy']],
  ['neighborhood_request_interrupted', [503, 'save_interrupted']],
  ['neighborhood_viewport_too_dense', [422, 'viewport_too_dense']],
]);
async function safely<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  const live = () => { if (signal.aborted) throw new DOMException('Custom workspace request cancelled', 'AbortError'); };
  try { live(); const result = await fn(); live(); return result; }
  catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new DOMException('Custom workspace request cancelled', 'AbortError');
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'viewport_detail_capacity_exceeded')
      throw new ApiError('viewport_detail_capacity_exceeded', 422);
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const code = error instanceof Error && 'errorCode' in error && typeof error.errorCode === 'string' ? FAILURES.get(error.errorCode) : undefined;
    if (code && status === code[0]) throw new ApiError(code[1], code[0]);
    throw new ApiError('request_failed', typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined);
  }
}

/** Opt-in composition ports, not a mounted UI or permission grant. Reuse current
 * authenticated workfile reads/capture/catalog/report boundaries, but expose no
 * generic writer: all V7 mutations use the exact atomic command transports.
 * Summary, viewport and member reads take one retained selection reference;
 * their underlying transport keeps context/population/continuation validation.
 * The existing production API/host remain unchanged. */
export function createCustomCohortGroupWorkspaceApi(options: Parameters<typeof createCustomWorkspaceApi>[0]) {
  const legacy = createCustomWorkspaceApi(options), workfile = createCustomWorkspaceSectionTransport(options);
  const atomic = createCustomCohortGroupWorkspaceTransport(options), selected = createCustomCohortRecordedGroupTransport(options);
  const display = createCustomCohortGroupDisplayReader(selected);
  const map = createCustomCohortGroupMapReader(selected);
  const market = createCustomCohortGroupMarketReader(createCustomCohortGroupMarketTransport(options));
  return Object.freeze({
    read(input: CustomWorkspaceTarget, io: CustomWorkspaceOperationOptions): Promise<CustomCohortGroupWorkspaceApiRead> {
      return safely(io.signal, async () => {
        const bound = target(input), envelope = object(await workfile.read(bound.accountId, bound.assignmentFileId, io));
        requireThat(envelope.ok === true && envelope.account_id === bound.accountId, 'invalid_response');
        const file = object(envelope.workfile), sections = object(file.sections);
        requireThat(typeof file.assignment_file_id === 'number' && Number.isSafeInteger(file.assignment_file_id)
          && file.assignment_file_id > 0 && String(file.assignment_file_id) === bound.assignmentFileId
          && (file.status === 'draft' || file.status === 'signed' || file.status === 'archived'), 'invalid_response');
        let section: CustomCohortGroupWorkspaceSection | undefined;
        if (Object.hasOwn(sections, 'neighborhood_workspace')) {
          const read = readCustomCohortGroupWorkspaceSection(sections.neighborhood_workspace);
          requireThat(read.status === 'restored', 'invalid_response');
          section = Object.freeze({ revision: read.section_revision, value: read.checkpoint });
        }
        return Object.freeze({ target: bound, section, status: file.status });
      });
    },
    start(input: Parameters<typeof atomic.start>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => atomic.start(input, io)); },
    cancel(input: Parameters<typeof atomic.cancel>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => atomic.cancel(input, io)); },
    complete(input: Parameters<typeof atomic.complete>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => atomic.complete(input, io)); },
    save(input: Parameters<typeof atomic.save>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => atomic.save(input, io)); },
    readSelection(input: Parameters<typeof selected.read>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => selected.read(input, io)); },
    display(input: Parameters<typeof display>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => display(input, io)); },
    map(...args: Parameters<typeof map>) { return safely(args[2].signal, () => map(...args)); },
    market(...args: Parameters<typeof market>) { return safely(args[2].signal, () => market(...args)); },
    preview(input: Parameters<typeof selected.preview>[0], io: CustomWorkspaceOperationOptions) { return safely(io.signal, () => selected.preview(input, io)); },
    opening(...args: Parameters<typeof selected.opening>) { return safely(args[3].signal, () => selected.opening(...args)); },
    viewport(...args: Parameters<typeof selected.viewport>) { return safely(args[4].signal, () => selected.viewport(...args)); },
    members(...args: Parameters<typeof selected.members>) { return safely(args[4].signal, () => selected.members(...args)); },
    capture: legacy.capture, catalog: legacy.catalog,
    // These explicit original-subset inspections are distinct from the main
    // exact-reference population ports above. The keyed host owns their lane.
    inspectionPreview: legacy.preview, inspectionMembers: legacy.members,
    readReportEditor: legacy.readReportEditor, reportedOperation: legacy.reportedOperation,
  });
}
