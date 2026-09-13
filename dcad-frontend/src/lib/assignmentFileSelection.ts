import type { AppraisalAssignmentFile } from "./api";

export function selectAssignmentFile(
  files: AppraisalAssignmentFile[],
  latestFile: AppraisalAssignmentFile | null | undefined,
  requestedAssignmentFileId?: number | null,
): AppraisalAssignmentFile | null {
  if (requestedAssignmentFileId === undefined) return latestFile || null;
  if (!Number.isSafeInteger(requestedAssignmentFileId) || !requestedAssignmentFileId
    || requestedAssignmentFileId < 1) return null;
  return files.find((file) => file.id === requestedAssignmentFileId) || null;
}
