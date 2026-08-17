export type HomeNodeReportType = "custom-appraisal" | "uad-3.6" | "property-tax-protest";

export type ReportDestinationSubject = {
  accountId: string;
  ownerName?: string | null;
};

export function reportDestination(
  reportType: HomeNodeReportType,
  subject: ReportDestinationSubject,
): string {
  const accountId = encodeURIComponent(subject.accountId.trim());
  if (!accountId) return "/";

  if (reportType === "custom-appraisal") {
    return `/report/${accountId}`;
  }
  if (reportType === "uad-3.6") {
    return `/uad-3.6/${accountId}`;
  }

  const params = new URLSearchParams({ propertyId: subject.accountId.trim() });
  const ownerName = String(subject.ownerName || "").trim();
  if (ownerName) params.set("ownerName", ownerName);
  return `/PropertyTaxProtest?${params.toString()}`;
}
