import {
  fetchJSON,
  makeUrl,
  type AppraisalAssignmentFile,
} from '@/lib/api';
import { withDesktopSketchSaveOperation } from '@/lib/desktopSketchSaveOperation';

type InspectionSketch = NonNullable<AppraisalAssignmentFile['mobile_inspection_sketch']>;

/** Create the first canonical sketch revision directly from the desktop editor. */
export function createMobileInspectionSketch(
  accountId: string,
  assignmentFileId: number,
  input: {
    sketch: InspectionSketch['document'];
    reviewer?: string;
    client_operation_id?: string;
  },
  editorKey: string,
): Promise<{
  ok: true;
  sketch: InspectionSketch;
  report_registry_revision: number;
}> {
  const id = (accountId || '').trim();
  return withDesktopSketchSaveOperation(
    'custom-appraisal',
    id,
    assignmentFileId,
    0,
    (operationId) => fetchJSON(
      makeUrl(
        `/api/accounts/${encodeURIComponent(id)}/assignment-files/`
          + `${encodeURIComponent(String(assignmentFileId))}/mobile-sketch`,
      ),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-homenode-editor-key': editorKey,
        },
        body: JSON.stringify({ ...input, client_operation_id: operationId }),
        retryTransient: true,
      },
    ),
    input.client_operation_id,
  );
}

/** Save a desktop review as the next immutable shared sketch revision. */
export function updateMobileInspectionSketch(
  accountId: string,
  assignmentFileId: number,
  input: {
    sketch: InspectionSketch['document'];
    expected_revision: number;
    reviewer?: string;
    client_operation_id?: string;
  },
  editorKey: string,
): Promise<{
  ok: true;
  sketch: InspectionSketch;
  report_registry_revision: number;
}> {
  const id = (accountId || '').trim();
  return withDesktopSketchSaveOperation(
    'custom-appraisal', id, assignmentFileId, input.expected_revision,
    (operationId) => fetchJSON(
      makeUrl(
        `/api/accounts/${encodeURIComponent(id)}/assignment-files/`
          + `${encodeURIComponent(String(assignmentFileId))}/mobile-sketch`,
      ),
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-homenode-editor-key': editorKey,
        },
        body: JSON.stringify({ ...input, client_operation_id: operationId }),
        retryTransient: true,
      },
    ),
    input.client_operation_id,
  );
}

export function saveCustomAppraisalSketchDraft(input: {
  accountId: string;
  assignmentFileId: number;
  sketch: InspectionSketch['document'];
  expectedRevision: number;
  editorKey: string;
}) {
  const payload = { sketch: input.sketch, reviewer: 'HomeNode appraiser' };
  return input.expectedRevision === 0
    ? createMobileInspectionSketch(input.accountId, input.assignmentFileId, payload, input.editorKey)
    : updateMobileInspectionSketch(
        input.accountId,
        input.assignmentFileId,
        { ...payload, expected_revision: input.expectedRevision },
        input.editorKey,
      );
}
