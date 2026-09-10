import { createCustomCohortJsonTransport, createCustomCohortPreviewTransport, createCustomCohortMemberTransport,
  createCustomWorkspaceSectionTransport } from './customCohortPreviewTransport';
import type { CustomCohortMemberTransport } from './customCohortPreviewTransport';
import { CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION, prepareCustomWorkspaceCheckpoint,
  readCustomWorkspaceCheckpoint, prepareCustomWorkspaceDiscovery, customWorkspaceCaptureDiscoveryMatches } from './customWorkspaceCheckpoint';
import type { CustomWorkspaceCheckpoint, CustomWorkspaceDiscovery, CustomWorkspaceObservationPeriod, CustomWorkspacePrivateSalesImport } from './customWorkspaceCheckpoint';
import type { CustomWorkspaceOperationOptions, CustomWorkspaceTarget } from './customWorkspaceLifecycle';
import type { CustomCohortPreviewInput, CustomCohortPreviewRequest } from './customCohortPreviewController';

interface Options {
  request: (url: string, init: RequestInit) => Promise<Response>;
  urlFor: (path: string) => string;
  editorKeyForSave: (target: CustomWorkspaceTarget, options: CustomWorkspaceOperationOptions) => string | Promise<string>;
}
export interface CustomWorkspaceApiSection {
  readonly value: CustomWorkspaceCheckpoint; readonly revision: number;
}
export interface CustomWorkspaceApiRead {
  readonly target: CustomWorkspaceTarget;
  readonly section: CustomWorkspaceApiSection | undefined;
  readonly status: 'draft' | 'signed' | 'archived';
}
class WorkspaceApiError extends Error {
  readonly workspaceCode: string;
  readonly status?: number;
  constructor(code: string, status?: number) {
    super(`custom_workspace_${code}`); this.workspaceCode = code; this.status = status;
  }
}
const requireThat: (ok: unknown, code: string) => asserts ok = (ok, code) => {
  if (!ok) throw new WorkspaceApiError(code);
};
const abortError = () => new DOMException('Custom workspace request cancelled', 'AbortError');
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw abortError(); };
function object(value: unknown): Record<string, unknown> {
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_response');
  return value as Record<string, unknown>;
}
function identity(accountId: string, assignmentFileId: string) {
  // Generic workfile routes still normalize IDs to safe positive JS numbers.
  // Do not round an int64 target or silently switch to a canonical alias.
  requireThat(typeof accountId === 'string' && /^[0-9A-Za-z_-]{1,50}$/.test(accountId)
    && typeof assignmentFileId === 'string' && /^[1-9][0-9]{0,15}$/.test(assignmentFileId)
    && Number.isSafeInteger(Number(assignmentFileId)), 'invalid_target');
  return { accountId, assignmentFileId };
}
function target(value: CustomWorkspaceTarget): CustomWorkspaceTarget {
  const bound = identity(value?.accountId, value?.assignmentFileId);
  requireThat(typeof value.sessionKey === 'string' && value.sessionKey.length > 0 && value.sessionKey.length <= 200
    && value.sessionKey.trim() === value.sessionKey
    && !Array.from(value.sessionKey).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127), 'invalid_target');
  return Object.freeze({ ...bound, sessionKey: value.sessionKey });
}
function responseIdentity(value: unknown, expected: CustomWorkspaceTarget) {
  const envelope = object(value);
  requireThat(Object.hasOwn(envelope, 'ok') && envelope.ok === true
    && Object.hasOwn(envelope, 'account_id') && envelope.account_id === expected.accountId, 'invalid_response');
  return envelope;
}
function responseFile(value: unknown, expected: string) {
  requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && String(value) === expected, 'invalid_response');
}
function section(value: unknown): CustomWorkspaceApiSection {
  const parsed = readCustomWorkspaceCheckpoint(value);
  requireThat(parsed.status === 'restored', 'invalid_response');
  return Object.freeze({ value: parsed.checkpoint, revision: parsed.section_revision });
}
async function safely<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  try { checkSignal(signal); const result = await task(); checkSignal(signal); return result; }
  catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError();
    if (error instanceof WorkspaceApiError) throw error;
    // The shared transport retains HTTP status; its raw server error text is not
    // suitable for this host. Never include that text, credentials, or a cause.
    const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    throw new WorkspaceApiError('request_failed', typeof status === 'number' && Number.isInteger(status)
      && status >= 400 && status <= 599 ? status : undefined);
  }
}
function editorKey(options: Options, bound: CustomWorkspaceTarget, io: CustomWorkspaceOperationOptions): Promise<string> {
  // Key acquisition may itself await the injected session boundary. Cancellation
  // must prevent a late key from ever starting a save, even if it ignores signal.
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError());
    io.signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { checkSignal(io.signal); return options.editorKeyForSave(bound, io); })
      .then(resolve, reject).finally(() => io.signal.removeEventListener('abort', aborted));
  });
}

/** Inject the existing authenticated request and URL boundary; this module does
 * not import a session, grant source rights, retry requests, cache a workfile, or
 * mount production routes. The lifecycle/read/preview owner controls the finite
 * deadline via its AbortSignal. Session keys are local generation identity only
 * and are never sent to either server endpoint. Signed/archived reads are returned
 * explicitly so the host can refuse to create an editable lifecycle. */
export function createCustomWorkspaceApi(options: Options) {
  for (const dependency of [options?.request, options?.urlFor, options?.editorKeyForSave]) {
    requireThat(typeof dependency === 'function', 'dependencies_required');
  }
  const workfile = createCustomWorkspaceSectionTransport(options);
  const cohort = createCustomCohortJsonTransport(options), preview = createCustomCohortPreviewTransport(options);
  const members = createCustomCohortMemberTransport(options);
  return Object.freeze({
    read(input: CustomWorkspaceTarget, io: CustomWorkspaceOperationOptions): Promise<CustomWorkspaceApiRead> {
      return safely(io.signal, async () => {
        const bound = target(input), envelope = responseIdentity(await workfile.read(bound.accountId, bound.assignmentFileId, io), bound);
        const file = object(envelope.workfile);
        responseFile(file.assignment_file_id, bound.assignmentFileId);
        requireThat(file.status === 'draft' || file.status === 'signed' || file.status === 'archived', 'invalid_response');
        const sections = object(file.sections);
        const saved = Object.hasOwn(sections, CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION)
          ? section(sections[CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION]) : undefined;
        return Object.freeze({ target: bound, section: saved, status: file.status });
      });
    },
    save(input: { target: CustomWorkspaceTarget; sectionKey: string; value: CustomWorkspaceCheckpoint; expectedRevision: number },
      io: CustomWorkspaceOperationOptions) {
      return safely(io.signal, async () => {
        const bound = target(input.target), expected = input.expectedRevision;
        requireThat(input.sectionKey === CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION && Number.isInteger(expected)
          && expected >= 0 && expected < 2_147_483_647, 'invalid_input');
        let value: CustomWorkspaceCheckpoint;
        try { value = prepareCustomWorkspaceCheckpoint(input.value); } catch { throw new WorkspaceApiError('invalid_input'); }
        const key = await editorKey(options, bound, io); checkSignal(io.signal);
        const envelope = responseIdentity(await workfile.save(bound.accountId, bound.assignmentFileId,
          { value, expectedRevision: expected, editorKey: key }, io), bound);
        responseFile(envelope.assignment_file_id, bound.assignmentFileId);
        const saved = section(envelope.section);
        requireThat(saved.revision === expected + 1 && JSON.stringify(saved.value) === JSON.stringify(value), 'invalid_response');
        return Object.freeze({ accountId: bound.accountId, assignmentFileId: bound.assignmentFileId, section: saved });
      });
    },
    capture(input: { target: CustomWorkspaceTarget; operationId: string; observationPeriod: CustomWorkspaceObservationPeriod;
      privateSalesImport?: CustomWorkspacePrivateSalesImport; discovery?: CustomWorkspaceDiscovery },
      io: CustomWorkspaceOperationOptions) {
      return safely(io.signal, async () => {
        const bound = target(input.target);
        let value: CustomWorkspaceCheckpoint;
        const selected = Object.hasOwn(input, 'privateSalesImport');
        const expanded = Object.hasOwn(input, 'discovery');
        try {
          const discovery = expanded ? prepareCustomWorkspaceDiscovery(input.discovery) : undefined;
          value = prepareCustomWorkspaceCheckpoint({ workspace_version: discovery?.profile_id === 'custom-city-polygon-v1' ? 4 : expanded ? 3 : selected ? 2 : 1, active: null,
          pending_capture: { operation_id: input.operationId, observation_period: input.observationPeriod,
            ...(selected ? { private_sales_import: input.privateSalesImport } : {}),
            ...(expanded ? { discovery } : {}) } }); }
        catch { throw new WorkspaceApiError('invalid_input'); }
        let response: Record<string, unknown>;
        try {
          response = object(await cohort(bound.accountId, 'capture', { assignment_file_id: bound.assignmentFileId,
            operation_id: value.pending_capture!.operation_id, observation_period: value.pending_capture!.observation_period,
            ...(selected ? { private_sales_import: value.pending_capture!.private_sales_import } : {}),
            ...(expanded ? { discovery: value.pending_capture!.discovery } : {}) }, io));
        } catch (error) {
          // Only these fixed city-capture refusals are user-facing. No raw server
          // details, source paths or unknown error vocabulary leave this boundary.
          if (value.pending_capture!.discovery?.profile_id === 'custom-city-polygon-v1'
            && error instanceof Error && 'status' in error && error.status === 422) {
            if (error.message === 'neighborhood_city_subject_outside_scope') throw new WorkspaceApiError('city_subject_outside_scope', 422);
            if (error.message === 'neighborhood_city_source_unavailable') throw new WorkspaceApiError('city_source_unavailable', 422);
          }
          throw error;
        }
        requireThat(customWorkspaceCaptureDiscoveryMatches(object(response.discovery), value.pending_capture!.discovery),
          'capture_discovery_mismatch');
        return response;
      });
    },
    catalog(input: CustomCohortPreviewInput, io: CustomWorkspaceOperationOptions) {
      return safely(io.signal, async () => {
        const bound = identity(input.accountId, input.assignmentFileId);
        return cohort(bound.accountId, 'catalog', { assignment_file_id: bound.assignmentFileId,
          context_ref: input.contextRef, selection: input.selection, include_recommendation: true }, io);
      });
    },
    preview(input: CustomCohortPreviewRequest, io: { signal: AbortSignal }) {
      // Preview already has a controller/route contract using exact int64 string
      // IDs. Do not apply the older generic workfile number limit to this view.
      return safely(io.signal, () => preview(input, io));
    },
    members(...[input, population, page, io]: Parameters<CustomCohortMemberTransport>) {
      return safely(io.signal, () => members(input, population, page, io));
    },
    readReportEditor(input: CustomWorkspaceTarget, io: CustomWorkspaceOperationOptions) {
      return safely(io.signal, async () => {
        const bound = target(input), envelope = responseIdentity(await workfile.read(bound.accountId, bound.assignmentFileId, io), bound);
        const file = object(envelope.workfile); responseFile(file.assignment_file_id, bound.assignmentFileId);
        requireThat(file.status === 'draft', 'report_read_only');
        const sections = object(file.sections);
        if (!Object.hasOwn(sections, 'neighborhood_assessment')) return 0;
        const value = object(sections.neighborhood_assessment);
        requireThat(Number.isInteger(value.revision) && Number(value.revision) > 0 && Number(value.revision) < 2147483647, 'invalid_response');
        return Number(value.revision);
      });
    },
    reportedOperation(input: { target: CustomWorkspaceTarget; operation: 'reported-proposal' | 'reported-apply';
      body: Record<string, unknown> }, io: CustomWorkspaceOperationOptions) {
      // The dedicated report controller creates only the closed proposal/Apply
      // command; no generic assignment-section save or browser facts are used.
      return safely(io.signal, async () => {
        const bound = target(input.target);
        requireThat(!Object.hasOwn(input.body, 'assignment_file_id'), 'invalid_input');
        return cohort(bound.accountId, input.operation, { assignment_file_id: bound.assignmentFileId, ...input.body }, io);
      });
    },
  });
}
