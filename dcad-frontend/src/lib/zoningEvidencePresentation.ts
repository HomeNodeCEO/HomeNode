import type { PropertyZoningEvidence } from "./api";

export type ZoningEvidenceDraft = {
  sourceDocumentId: string;
  sourceType: "map_pdf" | "interactive_map" | "city_confirmation" | "official_gis" | "manual";
  zoningCode: string;
  zoningDescription: string;
  pageNumber: string;
  confirmationReference: string;
  notes: string;
  reviewer: string;
};

export const EMPTY_ZONING_EVIDENCE_DRAFT: ZoningEvidenceDraft = {
  sourceDocumentId: "",
  sourceType: "map_pdf",
  zoningCode: "",
  zoningDescription: "",
  pageNumber: "",
  confirmationReference: "",
  notes: "",
  reviewer: "",
};

export function zoningDraftFromEvidence(
  evidence: PropertyZoningEvidence,
  current: ZoningEvidenceDraft,
): ZoningEvidenceDraft {
  const verification = evidence.verification;
  const automatic = evidence.automatic_result;
  const suggestion = automatic || evidence.suggested_result;
  const firstDocument = evidence.documents[0];
  const contact = evidence.jurisdiction?.contact;
  const defaultContactReference = [
    contact?.planningPhone ? `Planning & Zoning: ${contact.planningPhone}` : null,
    contact?.buildingPhone ? `Building Inspections: ${contact.buildingPhone}` : null,
    !contact?.planningPhone && !contact?.buildingPhone && contact?.phone
      ? `${contact.department}: ${contact.phone}`
      : null,
  ].filter(Boolean).join("; ");
  return {
    sourceDocumentId: verification?.source_document_id
      ? String(verification.source_document_id)
      : firstDocument ? String(firstDocument.id) : "",
    sourceType: verification?.source_type || (firstDocument
      ? "map_pdf"
      : automatic ? "official_gis" : "city_confirmation"),
    zoningCode: verification?.zoning_code || suggestion?.zoning_code || current.zoningCode,
    zoningDescription:
      verification?.zoning_description || suggestion?.zoning_description || current.zoningDescription,
    pageNumber: verification?.page_number ? String(verification.page_number) : "",
    confirmationReference: verification?.confirmation_reference
      || current.confirmationReference
      || defaultContactReference,
    notes: verification?.notes || "",
    reviewer: verification?.reviewer || current.reviewer,
  };
}
