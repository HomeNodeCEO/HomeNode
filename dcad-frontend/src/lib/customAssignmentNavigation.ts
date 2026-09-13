import type { AppraisalAssignmentFile, AssignmentFilesResponse } from "./api";
import { selectAssignmentFile } from "./assignmentFileSelection.ts";

// undefined is deliberately unscoped; null is an invalid explicit request.
export function parseCustomAssignmentFileId(search: string): number | null | undefined {
  const values = new URLSearchParams(search).getAll("assignmentFileId");
  if (!values.length) return undefined;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) ? id : null;
}

type FileIdentity = Pick<AppraisalAssignmentFile, "id" | "account_id">;
export const CUSTOM_ASSIGNMENT_REQUEST_ERROR =
  "This appraisal file is unavailable or its link is invalid. Choose an existing file or start a new assignment.";

export function customAssignmentFileMatches(
  file: FileIdentity | null | undefined,
  accountId: string,
): file is FileIdentity {
  return Boolean(file && Number.isSafeInteger(file.id) && file.id > 0
    && typeof file.account_id === "string" && accountId.trim()
    && file.account_id.trim().toUpperCase() === accountId.trim().toUpperCase());
}

export function selectCustomAssignmentFile(
  response: Pick<AssignmentFilesResponse, "account_id" | "files" | "latest_file">,
  accountId: string,
  requestedId: number | null | undefined,
): AppraisalAssignmentFile | null {
  if (response.account_id.trim().toUpperCase() !== accountId.trim().toUpperCase()) {
    throw new Error(CUSTOM_ASSIGNMENT_REQUEST_ERROR);
  }
  const file = selectAssignmentFile(response.files, response.latest_file, requestedId);
  if (file ? !customAssignmentFileMatches(file, accountId) : requestedId !== undefined) {
    throw new Error(CUSTOM_ASSIGNMENT_REQUEST_ERROR);
  }
  return file;
}

type CustomPath = "/report" | "/ComparableSalesAnalysis" | "/AppraisalReport"
  | "/CostApproach" | "/IncomeApproach" | "/FinalReconciliation";

export function customAssignmentHref(
  path: CustomPath,
  accountId: string,
  requestedId: number | null | undefined,
  resolvedFile: FileIdentity | null | undefined,
): string | undefined {
  if (!accountId.trim() || requestedId === null) return undefined;
  const id = requestedId === undefined
    ? customAssignmentFileMatches(resolvedFile, accountId) ? resolvedFile.id : null
    : requestedId;
  if (!Number.isSafeInteger(id) || !id || id < 1) return undefined;
  const account = encodeURIComponent(accountId.trim());
  const query = `assignmentFileId=${id}`;
  return path === "/report" ? `/report/${account}?${query}`
    : `${path}?propertyId=${account}&${query}`;
}
