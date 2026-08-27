import type { AppraisalAssignmentFile } from "./api";

export function selectAssignmentFile(
  files: AppraisalAssignmentFile[],
  latestFile: AppraisalAssignmentFile | null | undefined,
  requestedAssignmentFileId?: number | null,
): AppraisalAssignmentFile | null {
  if (requestedAssignmentFileId) {
    const requested = files.find((file) => file.id === requestedAssignmentFileId);
    if (requested) return requested;
  }
  return latestFile || null;
}
