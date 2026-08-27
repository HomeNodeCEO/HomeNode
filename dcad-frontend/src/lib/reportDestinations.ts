export type HomeNodeReportType = "custom-appraisal" | "uad-3.6" | "property-tax-protest";

export type ReportDestinationSubject = {
  accountId: string;
  ownerName?: string | null;
};

export function reportDestination(
  reportType: HomeNodeReportType,
  subject: ReportDestinationSubject,
  targetId?: string | null,
): string {
  const accountId = encodeURIComponent(subject.accountId.trim());
  if (!accountId) return "/";

  if (reportType === "custom-appraisal") {
    const params = targetId ? `?assignmentFileId=${encodeURIComponent(targetId)}` : "";
    return `/report/${accountId}${params}`;
  }
  if (reportType === "uad-3.6") {
    const params = targetId ? `?workfileId=${encodeURIComponent(targetId)}` : "";
    return `/uad-3.6/${accountId}${params}`;
  }

  const params = new URLSearchParams({ propertyId: subject.accountId.trim() });
  const ownerName = String(subject.ownerName || "").trim();
  if (ownerName) params.set("ownerName", ownerName);
  if (targetId) params.set("fileId", targetId);
  return `/PropertyTaxProtest?${params.toString()}`;
}
