import {
  getAssignmentFiles,
  getCustomAppraisalWorkfile,
  type AssignmentFilesResponse,
} from "@/lib/api";
import { createInFlightRequestCache } from "@/lib/timedRequestCache";

const assignmentFileRequests = createInFlightRequestCache<AssignmentFilesResponse>();
type WorkfileResponse = Awaited<ReturnType<typeof getCustomAppraisalWorkfile>>;

const workfileRequests = createInFlightRequestCache<WorkfileResponse>();

export function loadAssignmentFiles(accountId: string): Promise<AssignmentFilesResponse> {
  const normalizedAccountId = accountId.trim().toUpperCase();
  return assignmentFileRequests.load(
    normalizedAccountId,
    () => getAssignmentFiles(accountId),
  );
}

export function loadCustomAppraisalWorkfile(
  accountId: string,
  assignmentFileId: number,
): Promise<WorkfileResponse> {
  const normalizedAccountId = accountId.trim().toUpperCase();
  return workfileRequests.load(
    `${normalizedAccountId}:${assignmentFileId}`,
    () => getCustomAppraisalWorkfile(accountId, assignmentFileId),
  );
}
