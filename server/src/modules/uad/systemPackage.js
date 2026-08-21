import { sanitizeUadFileName } from "./r2Storage.js";

export const UAD_SYSTEM_PACKAGE_PROFILE = Object.freeze({
  valuationReportContentIdentifier: "URAR Delivery Specification v1.4",
  valuationSoftwareProductIdentifier: "HOMENODE-UAD-3.6",
  valuationSoftwareProductName: "HomeNode UAD 3.6 Appraisal Workspace",
  valuationSoftwareProductVersionIdentifier: "1.0.0",
  valuationSoftwareVendorName: "HomeNode Real Estate",
  serviceType: "Valuation",
  pdfMimeType: "application/pdf",
  documentType: "AppraisalReport",
  documentFormIssuingEntityNameType: "FNM_FRE",
  documentFormIssuingEntityVersionIdentifier: "September 2024",
});

export const UAD_SYSTEM_PACKAGE_UIDS = Object.freeze([
  "2100.0045",
  "2100.0036",
  "2100.0033",
  "2100.0001",
  "2100.0002",
  "1000.0198",
  "1400.0383",
  "1400.0384",
  "2100.0010",
  "1000.0039",
  "2100.0048",
  "2100.0049",
]);

export function buildUadNativePdfFileName(workfile = {}) {
  const identity = workfile.file_number || workfile.id || "homenode-uad-report";
  const fileName = sanitizeUadFileName(`${identity}.pdf`);
  if (!fileName.toLowerCase().endsWith(".pdf") || fileName.length > 120) {
    throw new Error("uad_pdf_file_name_invalid");
  }
  return fileName;
}

export function buildUadSystemPackageMetadata(workfile = {}) {
  const revisionNumber = Number(workfile.current_revision);
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1 || revisionNumber > 99) {
    throw new Error("uad_appraisal_version_identifier_invalid");
  }
  const pdfFileName = buildUadNativePdfFileName(workfile);
  return Object.freeze({
    ...UAD_SYSTEM_PACKAGE_PROFILE,
    appraisalVersionIdentifier: String(revisionNumber),
    pdfFileName,
    pdfObjectUrl: `\\\\${pdfFileName}`,
  });
}
