/**
 * Pure, deliberately conservative SFREP RPTI Report.xml projection.
 *
 * Format: https://api.sfrep.com/rpti/aixml_spec.html
 * Primary form: https://api.sfrep.com/rpti/sample_rpti.html
 * Field IDs and meanings were checked against the installed SFREP dictionary:
 * Appraise-It Pro/Conversion Dictionaries/MISMO.2.6.GSE.xml,
 * Dictionary/Forms/Form[@Id='FNMA-1004-0911']/Fields (Appraise-It Pro 3.7.9).
 * No installation, filesystem access, network, or database is required at runtime.
 *
 * The caller must authorize and load assignment-scoped documents. Only current
 * candidates explicitly confirmed by the appraiser may populate report fields;
 * document-level processing/review status does not approve individual values.
 * Original PDFs are separate evidence addenda and need not have extracted fields.
 */
export const SFREP_PRIMARY_FORM_ID = "FNMA-1004-0911";
export const SFREP_SUPPORTED_FORM_IDS = Object.freeze([SFREP_PRIMARY_FORM_ID]);
export const SFREP_MAX_DOCUMENTS = 50;

const SPEC_URL = "https://api.sfrep.com/rpti/aixml_spec.html";
const INVALID_XML = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const EMPTY_MARKERS = /^(?:xsi:nil|null|undefined|unknown|n\/?a|not available|not provided|[-–—]+)$/i;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function positiveId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^\d+$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function textValue(value) {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) return null;
  const result = String(value).trim();
  if (!result || EMPTY_MARKERS.test(result)) return null;
  return result;
}

function xmlAttribute(value) {
  const text = String(value);
  if (INVALID_XML.test(text)) fail("sfrep_invalid_xml_character");
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

function money(value) {
  if (!/^\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.replace(/[$,\s]/g, "").split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  if (normalizedWhole.length > 12) return null;
  return `${normalizedWhole}.${fraction.padEnd(2, "0")}`;
}

function date(value) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!iso && !us) return null;
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : [us[3], us[1], us[2]];
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number(year) < 1000 || parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) return null;
  return `${month.padStart(2, "0")}/${day.padStart(2, "0")}/${year}`;
}

function integer(value) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value)) return null;
  const result = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(result) ? String(result) : null;
}

function year(value) {
  return /^\d{4}$/.test(value) && Number(value) >= 1000 ? value : null;
}

function area(value) {
  const result = integer(value);
  return result !== null && Number(result) > 0 ? `${result} sf` : null;
}

const identity = (value) => value;

// Deliberately exclude seller_name -> OwnerName and buyer_name -> BorrowerName.
// Both roles require distinct reviewed evidence; a party to a sale is not proof
// of current public-record ownership or of a loan-borrower relationship.
const MAPPINGS = Object.freeze({
  file_number: ["FileNumber", identity],
  case_number: ["CaseNumber", identity],
  subject_street_address: ["StreetAddress", identity],
  subject_city: ["City", identity],
  subject_state: ["State", (value) => /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : null],
  subject_zip: ["ZipCode", (value) => /^\d{5}(?:-\d{4})?$/.test(value) ? value : null],
  subject_zip_code: ["ZipCode", (value) => /^\d{5}(?:-\d{4})?$/.test(value) ? value : null],
  borrower_name: ["BorrowerName", identity],
  owner_name: ["OwnerName", identity],
  county: ["County", identity],
  legal_description: ["LegalDescription", identity],
  assessor_parcel_number: ["AssessorsParcelNumber", identity],
  assessors_parcel_number: ["AssessorsParcelNumber", identity],
  tax_year: ["RealEstateTaxYear", year],
  tax_amount: ["RealEstateTaxAmount", money],
  real_estate_tax_year: ["RealEstateTaxYear", year],
  real_estate_tax_amount: ["RealEstateTaxAmount", money],
  lender_client_name: ["LenderClientCompanyName", identity],
  lender_client_address: ["LenderClientCompanyUnparsedAddress", identity],
  contract_price: ["SalePriceAmount", money],
  contract_date: ["ContractDate", date],
  zoning_code: ["SpecificZoningClassification", identity],
  zoning_description: ["ZoningDescription", identity],
  site_area_sqft: ["Area", area],
  year_built: ["YearBuiltDescription", year],
  bedrooms: ["RoomCountBedrooms", integer],
  gross_living_area_sqft: ["GrossLivingArea", integer],
});

const UNMAPPED_REASONS = Object.freeze({
  seller_name: "Seller identity is not proof of the public-record owner; OwnerName is not inferred.",
  buyer_name: "Buyer identity is not proof of the borrower; BorrowerName is not inferred.",
  closing_date: "Closing date is not contract date; no verified direct FNMA 1004 field mapping.",
  loan_amount: "Mortgage detail has no verified direct FNMA 1004 field mapping.",
  down_payment: "Mortgage detail has no verified direct FNMA 1004 field mapping.",
  earnest_money: "Earnest money has no verified direct FNMA 1004 field mapping.",
  seller_concessions: "The SFREP concessions field has composite UAD semantics; an amount alone is not exported.",
  financing_type: "Financing detail has no verified direct FNMA 1004 field mapping.",
  assignment_type: "Only explicitly reviewed purchase_transaction or refinance assignment types are supported.",
  contract_property_condition: "Contract terms do not establish appraiser conclusions about property condition.",
});

function unmappedReason(sourceField) {
  if (Object.hasOwn(UNMAPPED_REASONS, sourceField)) return UNMAPPED_REASONS[sourceField];
  if (["mls_number", "listing_status", "list_price", "original_list_price", "list_date", "listing_end_date", "days_on_market"].includes(sourceField)) {
    return "SFREP's subject-listing field has composite UAD semantics; no direct scalar mapping is verified.";
  }
  return "No verified direct mapping for this reviewed field on FNMA-1004-0911; consult the source PDF.";
}

function projectValue(sourceField, value) {
  if (sourceField === "assignment_type") {
    const fieldId = value === "purchase_transaction" ? "AssignmentTypePurchaseCheckBox"
      : value === "refinance" ? "AssignmentTypeRefinanceCheckBox" : null;
    return fieldId ? [{ fieldId, value: "true", type: "CheckBoxField", group: "assignment_type" }] : [];
  }
  if (sourceField === "subject_property_address") {
    // Only split explicit comma-delimited localities. Do not guess the boundary
    // between a street and a multi-word city from a whitespace-only address.
    const full = value.match(/^([^,\r\n]+),\s*([^,\r\n]+?)(?:,\s*|\s+)([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (full) return ["StreetAddress", "City", "State", "ZipCode"].map((fieldId, index) => ({
      fieldId, value: index === 2 ? full[index + 1].trim().toUpperCase() : full[index + 1].trim(), type: "TextField",
    }));
    // Street-only evidence is usable, but locality-looking suffixes require
    // separate reviewed address components instead of truncating the source.
    if (!/[,\r\n]/.test(value) && !/\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/.test(value)) {
      return [{ fieldId: "StreetAddress", value, type: "TextField" }];
    }
    return [];
  }
  if (!Object.hasOwn(MAPPINGS, sourceField)) return [];
  const [fieldId, normalize] = MAPPINGS[sourceField];
  const normalized = normalize(value);
  return normalized === null ? [] : [{ fieldId, value: normalized, type: "TextField" }];
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceOrder(a, b) {
  return a.documentId - b.documentId || compare(a.sourceField, b.sourceField)
    || (a.candidateId ?? 0) - (b.candidateId ?? 0) || compare(a.value ?? "", b.value ?? "");
}

function selectedDocuments(documents, selectedDocumentIds) {
  if (!Array.isArray(documents) || documents.length > SFREP_MAX_DOCUMENTS) fail("sfrep_invalid_documents");
  const byId = new Map();
  for (const document of documents) {
    const id = positiveId(document?.id);
    if (!id || byId.has(id)) fail("sfrep_invalid_document_id");
    byId.set(id, document);
  }
  if (selectedDocumentIds === undefined) return byId;
  if (!Array.isArray(selectedDocumentIds) || selectedDocumentIds.length > SFREP_MAX_DOCUMENTS) fail("sfrep_invalid_document_selection");
  const selected = new Map();
  for (const value of selectedDocumentIds) {
    const id = positiveId(value);
    if (!id || !byId.has(id)) fail("sfrep_invalid_document_selection");
    selected.set(id, byId.get(id));
  }
  return selected;
}

function validatePdfAddenda(addenda, documents) {
  if (!Array.isArray(addenda) || addenda.length > SFREP_MAX_DOCUMENTS) fail("sfrep_invalid_pdf_addenda");
  const names = new Set();
  return addenda.map((entry) => {
    const documentId = positiveId(entry?.documentId);
    const fileName = textValue(entry?.fileName);
    if (!documentId || !documents.has(documentId)) fail("sfrep_invalid_pdf_document");
    // Data is a basename within Pdf/, never a path, URL, or archive traversal.
    if (!fileName || fileName.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$/i.test(fileName)
      || /\.\./.test(fileName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) fail("sfrep_invalid_pdf_filename");
    if (names.has(fileName.toLowerCase())) fail("sfrep_duplicate_pdf_filename");
    names.add(fileName.toLowerCase());
    const title = textValue(entry.title) || textValue(documents.get(documentId).title) || fileName;
    if (INVALID_XML.test(title)) fail("sfrep_invalid_xml_character");
    return { documentId, fileName, title };
  }).sort((a, b) => a.documentId - b.documentId || compare(a.fileName, b.fileName));
}

/**
 * fieldSelections optionally chooses one document for a sourceField. Without
 * a choice, differing confirmed values for the same destination are omitted.
 * Duplicate equal values collapse deterministically. Conflicts are resolved at
 * the SFREP destination level too, so aliases never emit duplicate field IDs.
 * An explicit blank confirmed_value is never replaced by the extracted value.
 * reportXml uses UTF-8; package it as UTF-8 bytes at the RPTI root, Report.xml.
 */
export function buildSfrepReportExport({
  documents = [], selectedDocumentIds, fieldSelections = {}, pdfAddenda = [],
  formId = SFREP_PRIMARY_FORM_ID, application = {},
} = {}) {
  if (!SFREP_SUPPORTED_FORM_IDS.includes(formId)) fail("sfrep_unsupported_form");
  if (!fieldSelections || typeof fieldSelections !== "object" || Array.isArray(fieldSelections)) fail("sfrep_invalid_field_selection");
  const selected = selectedDocuments(documents, selectedDocumentIds);
  for (const id of Object.values(fieldSelections)) {
    if (!positiveId(id) || !selected.has(positiveId(id))) fail("sfrep_invalid_field_selection");
  }
  const omitted = [];
  const projected = [];
  const omit = (entry, reason) => omitted.push({
    sourceField: entry.sourceField, documentId: entry.documentId, candidateId: entry.candidateId, reason,
  });
  for (const [documentId, document] of selected) {
    for (const candidate of Array.isArray(document.candidates) ? document.candidates : []) {
      if (candidate?.review_status !== "confirmed") continue;
      const sourceField = typeof candidate.field_key === "string" ? candidate.field_key : "";
      const entry = { sourceField, documentId, candidateId: positiveId(candidate.id) };
      if (!["reviewed", "review_required"].includes(document.processing_status)) {
        omit(entry, "Document extraction is not ready for review; stale confirmed values are not exported.");
        continue;
      }
      if (candidate.document_id != null && positiveId(candidate.document_id) !== documentId) {
        omit(entry, "Candidate document identity does not match its source document.");
        continue;
      }
      if (Object.hasOwn(fieldSelections, sourceField) && positiveId(fieldSelections[sourceField]) !== documentId) {
        omit(entry, "A different source document was selected for this field.");
        continue;
      }
      const value = textValue(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value);
      if (value === null) {
        omit(entry, "Blank, unknown, or non-scalar reviewed value omitted to preserve existing report data.");
        continue;
      }
      if (INVALID_XML.test(value)) {
        omit(entry, "Reviewed value contains characters not allowed in XML 1.0.");
        continue;
      }
      const fields = projectValue(sourceField, value);
      if (!fields.length) {
        omit(entry, sourceField === "subject_property_address"
          ? "Address locality cannot be safely split; review separate street, city, state, and ZIP fields."
          : Object.hasOwn(MAPPINGS, sourceField)
            ? "Reviewed value does not match the verified destination field's format."
            : unmappedReason(sourceField));
        continue;
      }
      projected.push(...fields.map((field) => ({ ...entry, ...field })));
    }
  }

  const grouped = new Map();
  for (const field of projected.sort(sourceOrder)) {
    const key = field.group || field.fieldId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(field);
  }
  const fields = [];
  const conflicts = [];
  for (const [, entries] of [...grouped.entries()].sort(([a], [b]) => compare(a, b))) {
    const alternatives = new Set(entries.map((entry) => `${entry.fieldId}\u0000${entry.value}`));
    if (alternatives.size > 1) {
      const sourceFields = [...new Set(entries.map((entry) => entry.sourceField))].sort(compare);
      conflicts.push({
        sourceField: sourceFields[0],
        documentIds: [...new Set(entries.map((entry) => entry.documentId))].sort((a, b) => a - b),
        values: [...new Set(entries.map((entry) => entry.type === "CheckBoxField" ? entry.fieldId : entry.value))].sort(compare),
      });
      for (const entry of entries) omit(entry, "Conflicting reviewed values; deselect a source document or explicitly choose one source for this field.");
      continue;
    }
    const { group: _group, ...field } = entries[0];
    fields.push(field);
  }
  fields.sort((a, b) => compare(a.fieldId, b.fieldId));
  omitted.sort(sourceOrder);
  const validatedAddenda = validatePdfAddenda(pdfAddenda, selected);
  const warnings = [
    "This export targets the legacy FNMA 1004 (09/2011) form, not the dynamic UAD 3.6 URAR.",
    "Only explicitly confirmed evidence is mapped. Review imported values in Appraise-It Pro before use.",
  ];
  if (conflicts.length) warnings.push("Conflicting fields were omitted; resolve the source selection before relying on the import.");
  if (omitted.length) warnings.push("Some reviewed values were omitted; consult the omission list and original PDF evidence.");
  if (fields.some((field) => field.type === "CheckBoxField")) warnings.push("Only affirmative checkboxes are exported. Check existing alternative selections after import.");
  const metadata = {
    VendorName: textValue(application?.vendorName) || "HomeNode",
    ProductName: textValue(application?.productName) || "HomeNode",
    ProductVersion: textValue(application?.productVersion) || "1.0.0",
    AixmlVersion: "1.5",
  };
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Report xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    `  <Application ${Object.entries(metadata).map(([key, value]) => `${key}="${xmlAttribute(value)}"`).join(" ")} />`,
    "  <Forms>",
    `    <Form Id="${formId}">`,
    "      <Fields>",
    ...fields.map((field) => `        <${field.type} Id="${field.fieldId}" Data="${xmlAttribute(field.value)}" />`),
    "      </Fields>",
    "    </Form>",
    ...validatedAddenda.flatMap((entry) => [
      `    <Form Id="PDFAddendum" CustomTitle="${xmlAttribute(entry.title)}">`,
      "      <Fields>",
      `        <PdfField Id="Pdf" Data="${xmlAttribute(entry.fileName)}" />`,
      "      </Fields>",
      "    </Form>",
    ]),
    "  </Forms>",
    "</Report>",
  ];
  return { formId, reportXml: `${lines.join("\n")}\n`, fields, conflicts, omitted, warnings, pdfAddenda: validatedAddenda, specificationUrl: SPEC_URL };
}
