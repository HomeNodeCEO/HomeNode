/** Response matching only. Server authorization/history validation is mandatory;
 * equality of browser strings is not evidence authority. Never merge a partial
 * response into assignment_details or let a failed read restart legacy analysis.
 */
export type AcceptedNeighborhoodState = {
  accountId: string; assignmentFileId: number;
  status: 'loading' | 'legacy' | 'accepted' | 'unavailable' | 'signed';
  assessment: unknown; message: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function matchCustomNeighborhoodAcceptedResponse(input: {
  response: unknown; accountId: string; assignmentFileId: number; section: unknown;
}): AcceptedNeighborhoodState {
  const { accountId, assignmentFileId } = input;
  const base = { accountId, assignmentFileId, assessment: null };
  const fail = (): AcceptedNeighborhoodState => ({ ...base, status: 'unavailable',
    message: 'The saved neighborhood could not be matched to this file revision. Reload the file; its saved data has not been replaced.' });
  const response = record(input.response), neighborhood = record(response?.neighborhood);
  if (input.section === undefined && response?.ok === true && response.account_id === accountId
    && neighborhood?.account_id === accountId && neighborhood.assignment_file_id === assignmentFileId
    && neighborhood.status === 'not_accepted' && neighborhood.acceptance === null) {
    return { ...base, status: 'legacy', message: '' };
  }
  const section = record(input.section), value = record(section?.value);
  const accepted = record(neighborhood?.acceptance), snapshot = record(accepted?.snapshot);
  const projection = record(neighborhood?.report_projection), assessment = record(projection?.assessment);
  const scope = record(assessment?.scope);
  if (!section || response?.ok !== true || response.account_id !== accountId || neighborhood?.status !== 'accepted'
    || neighborhood.account_id !== accountId || neighborhood.assignment_file_id !== assignmentFileId
    || accepted?.assignmentFileId !== assignmentFileId || accepted.reportFileId !== neighborhood.report_file_id
    || typeof value?.operation_id !== 'string' || typeof value.attachment_id !== 'string'
    || !Number.isSafeInteger(section?.revision) || Number(section?.revision) <= 0
    || value.accepted_editor_revision !== section?.revision || accepted.acceptedEditorRevision !== section?.revision
    || accepted.operationId !== value.operation_id || accepted.attachmentId !== value.attachment_id
    || accepted.attachmentRevision !== value.attachment_revision
    || projection?.status !== 'ready' || projection.operation_id !== value.operation_id
    || projection.accepted_editor_revision !== section?.revision || scope?.account_id !== accountId
    || scope.organization_id !== accepted.organizationId || assessment?.contract_version !== 1) return fail();
  // Workfile and accepted-group reads are separate requests. Compare the entire
  // selected section, not just a revision integer reused in another assignment.
  if (!sameJson(record(snapshot?.section_value), value)) return fail();
  return { ...base, status: 'accepted', assessment,
    message: `Saved neighborhood analysis · revision ${section.revision}. Boundary and statistics are one accepted group.` };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key)
    && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function customNeighborhoodLegacyAllowed(state: AcceptedNeighborhoodState | null,
  accountId: string | undefined, assignmentFileId: number | null | undefined): boolean {
  return Boolean(state && state.accountId === accountId && state.assignmentFileId === assignmentFileId && state.status === 'legacy');
}
