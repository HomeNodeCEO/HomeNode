import { parseStructuredAddress } from "../util/structuredAddress.js";
import { isUrarPlaceholder, isUrarStateCode } from "../util/urarScalarValidation.js";

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
 * candidates explicitly confirmed by the appraiser may populate evidence fields;
 * document-level processing/review status does not approve individual values.
 * The sole opt-in user default (fee simple) is separate, labeled provenance.
 * Original PDFs are separate evidence addenda and need not have extracted fields.
 */
export const SFREP_PRIMARY_FORM_ID = "FNMA-1004-0911";
export const SFREP_SUPPORTED_FORM_IDS = Object.freeze([SFREP_PRIMARY_FORM_ID]);
export const SFREP_MAX_DOCUMENTS = 50;

const SPEC_URL = "https://api.sfrep.com/rpti/aixml_spec.html";
const INVALID_XML = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

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
  if (!result || isUrarPlaceholder(result)) return null;
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

const WHOLE_DOLLAR_FIELDS = new Set(["RealEstateTaxAmount", "AssessmentAmount"]);
const DISPLAY_FORMAT_FIELDS = new Set([...WHOLE_DOLLAR_FIELDS, "LegalDescription", "OwnerName"]);

// Legacy UAD Appendix D (taxes p9, HOA p11) and the installed 1004 NumberRules
// require zero decimal places for these two amounts. Apply display formatting
// only AFTER exact reviewed-value conflict resolution; it cannot approve or
// merge evidence. Keep the original input and direct provenance for review.
// https://singlefamily.fanniemae.com/media/document/pdf/uad-specification-appendix-d-field-specific-standardization-requirements
function formatSelectedField(field, warnings) {
  const sourceLabel = field.provenance?.kind === "saved_report" ? "the saved HomeNode report" : `document ${field.documentId}`;
  if (WHOLE_DOLLAR_FIELDS.has(field.fieldId)) {
    const [whole, cents] = field.value.split("."); // Already validated by money().
    const value = String(BigInt(whole) + (Number(cents) >= 50 ? 1n : 0n));
    if (Number(cents) !== 0) {
      warnings.push(`${field.fieldId} from ${sourceLabel}: reviewed amount ${field.sourceValue} rounded half up to ${value} whole dollars for legacy UAD. The exact reviewed source is retained; review the formatted amount.`);
    }
    return { ...field, value, formattingRule: "uad_whole_dollars_half_up" };
  }
  if (field.fieldId === "LegalDescription" || field.fieldId === "OwnerName") {
    const value = field.value.replace(/[ \t\r\n]*[\t\r\n][ \t\r\n]*/g, " ").trim();
    if (value !== field.value) {
      warnings.push(`${field.fieldId} from ${sourceLabel}: line breaks/tabs folded into spaces for the native single-line field. The exact reviewed source is retained and the text is not truncated; check fit in Appraise-It Pro.`);
    }
    return { ...field, value, formattingRule: field.fieldId === "OwnerName" ? "single_line_owner_name" : "single_line_legal_description" };
  }
  return field;
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
  subject_state: ["State", (value) => isUrarStateCode(value) ? value.toUpperCase() : null],
  subject_zip: ["ZipCode", (value) => /^\d{5}(?:-\d{4})?$/.test(value) ? value : null],
  subject_zip_code: ["ZipCode", (value) => /^\d{5}(?:-\d{4})?$/.test(value) ? value : null],
  borrower_name: ["BorrowerName", identity],
  owner_name: ["OwnerName", identity],
  record_owner_name: ["OwnerName", identity],
  county: ["County", identity],
  legal_description: ["LegalDescription", identity],
  assessor_parcel_number: ["AssessorsParcelNumber", identity],
  assessors_parcel_number: ["AssessorsParcelNumber", identity],
  tax_year: ["RealEstateTaxYear", year],
  tax_amount: ["RealEstateTaxAmount", money],
  real_estate_tax_year: ["RealEstateTaxYear", year],
  real_estate_tax_amount: ["RealEstateTaxAmount", money],
  neighborhood_name: ["NeighborhoodName", identity],
  subdivision_name: ["NeighborhoodName", identity],
  hoa_dues_amount: ["AssessmentAmount", money],
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
  assignment_type: "Only explicitly reviewed purchase_transaction, refinance, or known Other engagement purposes are supported; unknown purposes are not inferred.",
  contract_property_condition: "Contract terms do not establish appraiser conclusions about property condition.",
  hoa_frequency: "Only explicitly reviewed per_month or per_year HOA frequencies have verified checkboxes; amounts are not prorated.",
  property_type: "Property type is not PUD evidence unless it explicitly identifies a planned unit development.",
  property_rights: "Only explicit fee_simple or leasehold property rights are supported; no property right is inferred from ownership.",
  property_rights_appraised: "Only explicit fee_simple or leasehold property rights are supported; no property right is inferred from ownership.",
  pud: "PUD requires an explicit reviewed yes/true or no/false assertion; HOA dues are not proof.",
  is_pud: "PUD requires an explicit reviewed yes/true or no/false assertion; HOA dues are not proof.",
  offered_for_sale_prior_12_months: "Offered-for-sale status requires an explicit reviewed yes/true or no/false assertion.",
  subject_offered_for_sale_prior_12_months: "Offered-for-sale status requires an explicit reviewed yes/true or no/false assertion.",
});

const PROPERTY_RIGHTS_FIELDS = new Set(["property_rights", "property_rights_appraised"]);
const OFFERED_FOR_SALE_FIELDS = new Set(["offered_for_sale_prior_12_months", "subject_offered_for_sale_prior_12_months"]);
const BOOLEAN_FIELDS = new Set(["pud", "is_pud", ...OFFERED_FOR_SALE_FIELDS]);
const OTHER_ASSIGNMENT_DESCRIPTIONS = Object.freeze({
  heloc: "HELOC",
  rtl: "RTL",
  bridge_loan: "Bridge loan",
  new_construction: "New construction",
  rehab: "Rehab",
  dscr: "DSCR",
});

/** One supported purpose vocabulary for both field projection and persistence.
 * Canonicalize presentation separators only; do not infer new loan purposes. */
export function canonicalSfrepAssignmentType(value) {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  return canonical === "purchase_transaction" || canonical === "refinance"
    || Object.hasOwn(OTHER_ASSIGNMENT_DESCRIPTIONS, canonical) ? canonical : null;
}

function booleanValue(value) {
  return /^(?:true|yes)$/i.test(value) ? true : /^(?:false|no)$/i.test(value) ? false : null;
}

function isoDate(value) {
  const normalized = typeof value === "string" ? date(value) : null;
  return normalized ? `${normalized.slice(6)}-${normalized.slice(0, 2)}-${normalized.slice(3, 5)}` : null;
}

/** A calendar-year lookback clamps February 29 to February 28, never March 1. */
function previousCalendarYear(value) {
  const [year, month, day] = value.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${String(year - 1).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function effectiveDateContext(subjectContext) {
  if (subjectContext === undefined) subjectContext = {};
  if (!subjectContext || typeof subjectContext !== "object" || Array.isArray(subjectContext)) fail("sfrep_invalid_subject_context");
  if (subjectContext.feeSimpleDefault !== undefined && typeof subjectContext.feeSimpleDefault !== "boolean") fail("sfrep_invalid_subject_context");
  const supplied = subjectContext.effectiveDate;
  const effectiveDate = supplied == null || supplied === "" ? null : isoDate(supplied);
  if (supplied != null && supplied !== "" && (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(supplied))) fail("sfrep_invalid_effective_date");
  const source = subjectContext.effectiveDateSource ?? null;
  if (source !== null && !["inspection_date", "assignment_effective_date", "document_upload_date_placeholder"].includes(source)) fail("sfrep_invalid_effective_date_source");
  if ((effectiveDate === null) !== (source === null)) fail("sfrep_invalid_effective_date_source");
  const sourceDocumentId = subjectContext.effectiveDateSourceDocumentId == null ? null : positiveId(subjectContext.effectiveDateSourceDocumentId);
  if (subjectContext.effectiveDateSourceDocumentId != null && !sourceDocumentId) fail("sfrep_invalid_effective_date_source");
  if (!source && sourceDocumentId) fail("sfrep_invalid_effective_date_source");
  return {
    effectiveDate, source, sourceDocumentId,
    windowStart: effectiveDate ? previousCalendarYear(effectiveDate) : null,
    windowEnd: effectiveDate, calendarMonths: 12,
    isPlaceholder: source === "document_upload_date_placeholder",
  };
}

function unmappedReason(sourceField) {
  if (Object.hasOwn(UNMAPPED_REASONS, sourceField)) return UNMAPPED_REASONS[sourceField];
  if (["mls_number", "listing_status", "list_price", "original_list_price", "list_date", "listing_end_date", "days_on_market"].includes(sourceField)) {
    return "SFREP's subject-listing field has composite UAD semantics; no direct scalar mapping is verified.";
  }
  return "No verified direct mapping for this reviewed field on FNMA-1004-0911; consult the source PDF.";
}

function projectValue(sourceField, value) {
  if (sourceField === "pud" || sourceField === "is_pud") {
    const explicit = booleanValue(value);
    return explicit === null ? [] : [{ fieldId: "PropertyTypePUDCheckBox", value: String(explicit), type: "CheckBoxField", group: "pud", suppress: !explicit }];
  }
  if (sourceField === "property_type" && /^(?:pud|planned unit development)$/i.test(value)) {
    return [{ fieldId: "PropertyTypePUDCheckBox", value: "true", type: "CheckBoxField", group: "pud" }];
  }
  if (PROPERTY_RIGHTS_FIELDS.has(sourceField)) {
    const normalized = value.toLowerCase().replace(/[ -]+/g, "_");
    const fieldId = normalized === "fee_simple" ? "PropertyRightsAppraisedFeeSimpleCheckBox"
      : normalized === "leasehold" ? "PropertyRightsAppraisedLeaseholdCheckBox" : null;
    return fieldId ? [{ fieldId, value: "true", type: "CheckBoxField", group: "property_rights" }] : [];
  }
  if (OFFERED_FOR_SALE_FIELDS.has(sourceField)) {
    const explicit = booleanValue(value);
    return explicit === null ? [] : [{ fieldId: explicit ? "CurrentPriorListingYesCheckBox" : "CurrentPriorListingNoCheckBox", value: "true", type: "CheckBoxField", group: "offered_for_sale" }];
  }
  if (sourceField === "hoa_frequency") {
    const fieldId = value === "per_month" ? "AssessmentPerMonthCheckBox"
      : value === "per_year" ? "AssessmentPerYearCheckBox" : null;
    return fieldId ? [{ fieldId, value: "true", type: "CheckBoxField", group: "hoa_frequency" }] : [];
  }
  if (sourceField === "assignment_type") {
    const assignmentType = canonicalSfrepAssignmentType(value);
    if (!assignmentType) return [];
    const fieldId = assignmentType === "purchase_transaction" ? "AssignmentTypePurchaseCheckBox"
      : assignmentType === "refinance" ? "AssignmentTypeRefinanceCheckBox" : null;
    const choice = { group: "assignment_type", assignmentType };
    if (fieldId) return [{ ...choice, fieldId, value: "true", type: "CheckBoxField" }];
    if (!Object.hasOwn(OTHER_ASSIGNMENT_DESCRIPTIONS, assignmentType)) return [];
    return [
      { ...choice, fieldId: "AssignmentTypeOtherCheckBox", value: "true", type: "CheckBoxField" },
      { ...choice, fieldId: "AssignmentTypeOtherDescription", value: OTHER_ASSIGNMENT_DESCRIPTIONS[assignmentType], type: "TextField" },
    ];
  }
  if (sourceField === "subject_property_address" || sourceField === "subject_street_address") {
    // Only split explicit comma-delimited localities. Do not guess the boundary
    // between a street and a multi-word city from a whitespace-only address.
    const full = value.match(/^([^,\r\n]+),\s*([A-Za-z][A-Za-z .'-]*?)(?:,\s*|\s+)([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (full) {
      // Legacy/manual confirmations bypass extraction guards. Splitting must
      // not turn a composite value into an exported exact placeholder.
      if (!isUrarStateCode(full[3]) || full.slice(1).some((component) => textValue(component) === null)) return [];
      return ["StreetAddress", "City", "State", "ZipCode"].map((fieldId, index) => ({
        fieldId, value: index === 2 ? full[index + 1].trim().toUpperCase() : full[index + 1].trim(), type: "TextField",
      }));
    }
    // Street-only evidence is usable, but locality-looking suffixes require
    // separate reviewed address components instead of truncating the source.
    if (!/[,\r\n]/.test(value) && !/\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/.test(value)) {
      return [{ fieldId: "StreetAddress", value, type: "TextField" }];
    }
    // Preserve explicit comma-delimited secondary street identifiers, but do
    // not treat an incomplete or unrecognized locality tail as street text.
    const commaParts = value.split(",");
    if (sourceField === "subject_street_address" && !/[\r\n]/.test(value) && commaParts.length > 1
      && textValue(commaParts[0]) !== null && commaParts.slice(1).every((part) => (
        /^(?:#\s*|(?:apartment|apt|flat|lot|no|number|num|penthouse|ph|rm|room|space|spc|ste|suite|unit|bld|bldg|building|tower|fl|floor|level|lvl)[\s:#.-]+)[0-9A-Z][0-9A-Z/-]*$/i.test(part.trim())
      ))) return [{ fieldId: "StreetAddress", value, type: "TextField" }];
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

function destinationComparisonKey(entry) {
  // Other purpose's checkbox and description are one reviewed choice, not two
  // conflicting destinations. Distinct Other purposes still conflict together.
  if (entry.group === "assignment_type") return JSON.stringify([entry.group, entry.assignmentType]);
  if (entry.fieldId === "City") {
    return JSON.stringify([entry.fieldId, entry.value.trim().replace(/\s+/g, " ").toUpperCase()]);
  }
  if (entry.fieldId === "AssessorsParcelNumber" && /^\d+(?:-\d+)*$/.test(entry.value)) {
    // Numeric parcel identifiers may use display separators. Preserve every
    // digit (including leading zeroes), and leave alphanumeric IDs exact.
    return JSON.stringify([entry.fieldId, entry.value.replace(/-/g, "")]);
  }
  if (entry.fieldId === "StreetAddress") {
    const parsed = parseStructuredAddress(entry.value);
    const unsegmented = parseStructuredAddress(entry.value.replace(/,/g, " "));
    const identityKeys = ["house_number", "street_key", "unit_key", "building_key", "floor_key"];
    // The parser intentionally ignores comma-delimited locality tails. A value
    // sent to StreetAddress must not compare equal by dropping such information.
    // It also removes punctuation in secondary identifiers, so retain exact
    // comparison when a unit/building/floor token includes a hyphen or slash.
    const punctuatedSecondary = parsed.secondary_labels.some((label) => (
      new RegExp(`\\b${label}\\s+[A-Z0-9]*[-/][A-Z0-9/-]*\\b`).test(parsed.normalized_address)
    ));
    if (parsed.house_number && parsed.street_key && !punctuatedSecondary
      && identityKeys.every((key) => parsed[key] === unsegmented[key])) {
      return JSON.stringify([entry.fieldId, ...identityKeys.map((key) => parsed[key])]);
    }
  }
  // Names, legal descriptions, and other identities remain exact. Compatible
  // ZIP5/ZIP+4 groups are handled together below; ZIP5 cannot bridge two +4s.
  return JSON.stringify([entry.fieldId, entry.value]);
}

function compatibleZipGroup(entries) {
  return entries[0]?.fieldId === "ZipCode"
    && entries.every((entry) => /^\d{5}(?:-\d{4})?$/.test(entry.value))
    && new Set(entries.map((entry) => entry.value.slice(0, 5))).size === 1
    && new Set(entries.filter((entry) => entry.value.length === 10).map((entry) => entry.value)).size <= 1;
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
 * subjectContext is server-resolved context, never an unreviewed field override.
 * property_role must be "subject" to derive a listing checkbox from MLS dates;
 * explicit non-subject roles suppress all subject-field evidence from that PDF.
 * feeSimpleDefault is opt-in, recorded as an assumption, and never overrides a
 * reviewed rights assertion, including an unsupported or conflicting assertion.
 * Bind effectiveDateContext, assumptions, and provenance into the preview digest.
 */
export function buildSfrepReportExport({
  documents = [], selectedDocumentIds, fieldSelections = {}, pdfAddenda = [],
  formId = SFREP_PRIMARY_FORM_ID, application = {}, subjectContext, forReportPersistence = false,
  savedReportFields,
} = {}) {
  if (!SFREP_SUPPORTED_FORM_IDS.includes(formId)) fail("sfrep_unsupported_form");
  if (!fieldSelections || typeof fieldSelections !== "object" || Array.isArray(fieldSelections)) fail("sfrep_invalid_field_selection");
  const selected = selectedDocuments(documents, selectedDocumentIds);
  const dateContext = effectiveDateContext(subjectContext);
  for (const id of Object.values(fieldSelections)) {
    if (!positiveId(id) || !selected.has(positiveId(id))) fail("sfrep_invalid_field_selection");
  }
  const omitted = [];
  const projected = [];
  const listingDates = [];
  const listingConflicts = [];
  const assumptions = [];
  const knownMissing = [];
  const supplementalWarnings = [];
  let hasReviewedRights = false;
  let hasReviewedHoa = false;
  let hasReviewedListing = false;
  const omit = (entry, reason) => omitted.push({
    sourceField: entry.sourceField, documentId: entry.documentId, candidateId: entry.candidateId, reason,
  });
  // A saved report is authoritative for Subject. Do not refill a deliberately
  // cleared/unsupported report field from old document candidates during export.
  const subjectSources = new Set(['subject_property_address', 'subject_street_address', 'subject_city',
    'subject_state', 'subject_zip', 'subject_zip_code', 'borrower_name', 'owner_name', 'record_owner_name',
    'county', 'legal_description', 'assessor_parcel_number', 'assessors_parcel_number', 'tax_year',
    'tax_amount', 'real_estate_tax_year', 'real_estate_tax_amount', 'neighborhood_name', 'subdivision_name',
    'pud', 'is_pud', 'property_type', 'property_rights', 'property_rights_appraised', 'assignment_type', 'lender_client_name',
    'lender_client_address', 'offered_for_sale_prior_12_months', 'subject_offered_for_sale_prior_12_months',
    'list_date', 'hoa_dues_amount', 'hoa_frequency']);
  if (savedReportFields !== undefined) {
    if (!Array.isArray(savedReportFields) || savedReportFields.length > 30) fail('sfrep_invalid_saved_report');
    for (const saved of savedReportFields) {
      if (!subjectSources.has(saved.sourceField) || saved.provenance?.kind !== 'saved_report') fail('sfrep_invalid_saved_report');
      const value = textValue(typeof saved.value === 'boolean' ? String(saved.value) : saved.value);
      if (value === null) continue;
      if (INVALID_XML.test(value)) fail('sfrep_invalid_xml_character');
      // Saved address components are independently editable. Composite source
      // parsing must not refill a city/state/ZIP the appraiser cleared or changed.
      const savedProjection = saved.sourceField === 'subject_street_address'
        ? [{ fieldId: 'StreetAddress', value, type: 'TextField' }]
        : projectValue(saved.sourceField, value);
      for (const projectedField of savedProjection) {
        if (projectedField.suppress) continue;
        projected.push({ ...projectedField, sourceField: saved.sourceField, documentId: null, candidateId: null,
          provenance: saved.provenance,
          ...(DISPLAY_FORMAT_FIELDS.has(projectedField.fieldId) ? { sourceValue: String(saved.value) } : {}),
        });
      }
      if (saved.provenance.origin === 'user_default' && saved.sourceField === 'property_rights' && value === 'fee_simple') {
        assumptions.push({ fieldId: 'PropertyRightsAppraisedFeeSimpleCheckBox', value: 'true',
          rule: 'user_requested_fee_simple_default', reason: 'Fee simple is the saved user-requested default, not document evidence. Confirm the appraised property rights.' });
      }
    }
  }
  for (const [documentId, document] of selected) {
    const candidates = Array.isArray(document.candidates) ? document.candidates : [];
    const hoaFrequencies = new Set(candidates.filter((candidate) => candidate?.review_status === "confirmed"
      && candidate.field_key === "hoa_frequency"
      && (candidate.document_id == null || positiveId(candidate.document_id) === documentId)
      && (!Object.hasOwn(fieldSelections, "hoa_frequency") || positiveId(fieldSelections.hoa_frequency) === documentId))
      .map((candidate) => textValue(candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value)));
    for (const candidate of candidates) {
      if (candidate?.review_status !== "confirmed") continue;
      const sourceField = typeof candidate.field_key === "string" ? candidate.field_key : "";
      if (savedReportFields !== undefined && subjectSources.has(sourceField)) continue;
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
      if (document.property_role != null && document.property_role !== "subject") {
        omit(entry, "Document is not verified as subject-property evidence; comparable or unknown-property values are not exported to Subject fields.");
        continue;
      }
      if (sourceField === "assignment_type" && document.document_type !== "engagement_letter") {
        omit(entry, "Subject assignment type must come from reviewed engagement evidence; a purchase-contract classification is not the assignment instruction.");
        continue;
      }
      if (PROPERTY_RIGHTS_FIELDS.has(sourceField)) hasReviewedRights = true;
      const rawValue = candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
      // Pending is meaningful MLS status, not an unknown value. It still has
      // no scalar export mapping; keep the accurate composite-field omission.
      const value = sourceField === "listing_status" && typeof rawValue === "string" && /^pending$/i.test(rawValue.trim())
        ? rawValue.trim()
        : textValue(BOOLEAN_FIELDS.has(sourceField) && typeof rawValue === "boolean" ? String(rawValue) : rawValue);
      if (value === null) {
        omit(entry, "Blank, unknown, or non-scalar reviewed value omitted to preserve existing report data.");
        continue;
      }
      if (INVALID_XML.test(value)) {
        omit(entry, "Reviewed value contains characters not allowed in XML 1.0.");
        continue;
      }
      const provenance = {
        kind: "reviewed_document", sourceField, documentId, candidateId: entry.candidateId,
        documentType: textValue(document.document_type),
      };
      if (["hoa_dues_amount", "hoa_frequency"].includes(sourceField)) hasReviewedHoa = true;
      if (sourceField === "hoa_dues_amount" && (hoaFrequencies.size !== 1
        || !["per_month", "per_year"].includes([...hoaFrequencies][0]))) {
        omit(entry, "HOA amount needs one reviewed monthly or annual frequency from the same source; unsupported or ambiguous periods are not prorated.");
        continue;
      }
      if (["mls_number", "listing_status", "list_price", "original_list_price", "list_date", "listing_end_date", "days_on_market"].includes(sourceField)) hasReviewedListing = true;
      if (sourceField === "list_date") {
        if (document.document_type !== "mls_sheet" || document.property_role !== "subject") {
          omit(entry, "A listing date can establish offered-for-sale Yes only on a verified subject MLS sheet.");
          continue;
        }
        const listedOn = isoDate(value);
        if (!listedOn) {
          omit(entry, "Reviewed MLS listing date is invalid; no listing checkbox was inferred.");
          continue;
        }
        listingDates.push({ ...entry, value: listedOn, provenance });
        continue;
      }
      if (OFFERED_FOR_SALE_FIELDS.has(sourceField) && document.property_role !== "subject") {
        omit(entry, "An explicit offered-for-sale assertion must be verified as subject-property evidence.");
        continue;
      }
      const fields = projectValue(sourceField, value);
      if (!fields.length) {
        omit(entry, ["subject_property_address", "subject_street_address"].includes(sourceField)
          ? "Address locality cannot be safely split; review separate street, city, state, and ZIP fields."
          : Object.hasOwn(MAPPINGS, sourceField)
            ? "Reviewed value does not match the verified destination field's format."
            : unmappedReason(sourceField));
        continue;
      }
      projected.push(...fields.map((field) => ({
        ...entry, ...field, provenance,
        ...(DISPLAY_FORMAT_FIELDS.has(field.fieldId) ? { sourceValue: String(rawValue) } : {}),
      })));
    }
  }

  // A date-based conclusion is downstream of the reviewed date. Conflicting
  // dates are not collapsed to the same Yes even if both happen to be in range.
  if (new Set(listingDates.map((entry) => entry.value)).size > 1) {
    listingConflicts.push({
      sourceField: "list_date",
      documentIds: [...new Set(listingDates.map((entry) => entry.documentId))].sort((a, b) => a - b),
      values: [...new Set(listingDates.map((entry) => entry.value))].sort(compare),
    });
    for (const entry of listingDates) omit(entry, "Conflicting reviewed subject listing dates; no offered-for-sale checkbox was inferred.");
  } else {
    for (const entry of listingDates) {
      if (!dateContext.effectiveDate) {
        omit(entry, "Effective date is unavailable; the preceding 12-calendar-month listing window cannot be determined.");
      } else if (entry.value < dateContext.windowStart || entry.value > dateContext.windowEnd) {
        omit(entry, "Listing date is outside the preceding 12-calendar-month window; this does not establish offered-for-sale No.");
      } else {
        projected.push({
          ...entry, fieldId: "CurrentPriorListingYesCheckBox", value: "true", type: "CheckBoxField", group: "offered_for_sale",
          provenance: { ...entry.provenance, kind: "derived_reviewed_document",
            rule: "subject_mls_list_date_within_preceding_12_calendar_months", sourceValue: entry.value,
            effectiveDate: dateContext.effectiveDate, effectiveDateSource: dateContext.source,
            effectiveDateSourceDocumentId: dateContext.sourceDocumentId,
            windowStart: dateContext.windowStart, windowEnd: dateContext.windowEnd,
          },
        });
      }
    }
  }
  if (savedReportFields === undefined && subjectContext?.feeSimpleDefault === true && !hasReviewedRights) {
    const assumption = {
      fieldId: "PropertyRightsAppraisedFeeSimpleCheckBox", value: "true",
      rule: "user_requested_fee_simple_default",
      reason: "Fee simple is a user-requested default, not a fact extracted from the source documents. Confirm the appraised property rights.",
    };
    assumptions.push(assumption);
    projected.push({
      sourceField: "property_rights", documentId: null, candidateId: null,
      fieldId: assumption.fieldId, value: "true", type: "CheckBoxField", group: "property_rights",
      provenance: { kind: "user_default", sourceField: "property_rights", documentId: null, candidateId: null, rule: assumption.rule },
    });
    supplementalWarnings.push(assumption.reason);
  } else if (savedReportFields === undefined && subjectContext?.feeSimpleDefault === true && hasReviewedRights) {
    supplementalWarnings.push("The fee-simple default was not used because reviewed property-rights evidence is present; unresolved or conflicting rights remain omitted.");
  }
  if (hasReviewedHoa) supplementalWarnings.push("HOA dues or a mandatory HOA do not establish PUD status. PUD is checked only from an explicit reviewed PUD assertion.");
  if (dateContext.isPlaceholder) supplementalWarnings.push("The effective date is provisionally a document upload date, not an inspection date. Confirm the effective date before relying on the listing determination.");
  if (hasReviewedListing) knownMissing.push({
    fieldId: "CurrentPriorListingDataSources",
    reason: "The composite UAD listing-data encoding is not verified. MLS scalar details are not concatenated into this field; any derived checkbox is a separate determination.",
  });

  const grouped = new Map();
  for (const field of projected.sort(sourceOrder)) {
    const key = field.group || field.fieldId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(field);
  }
  if (new Set((grouped.get("hoa_frequency") || []).map((entry) => entry.fieldId)).size > 1) {
    for (const entry of grouped.get("AssessmentAmount") || []) omit(entry, "Conflicting HOA frequencies make the amount's period ambiguous; no amount was exported.");
    grouped.delete("AssessmentAmount");
  }
  const fields = [];
  const conflicts = [...listingConflicts];
  for (const [, entries] of [...grouped.entries()].sort(([a], [b]) => compare(a, b))) {
    const alternatives = new Set(entries.map(destinationComparisonKey));
    const compatibleZip = compatibleZipGroup(entries);
    if (alternatives.size > 1 && !compatibleZip) {
      const sourceFields = [...new Set(entries.map((entry) => entry.sourceField))].sort(compare);
      conflicts.push({
        sourceField: sourceFields[0],
        documentIds: [...new Set(entries.map((entry) => entry.documentId))].sort((a, b) => a - b),
        values: [...new Set(entries.map((entry) => entry.type === "CheckBoxField" ? `${entry.fieldId}=${entry.value}` : entry.value))].sort(compare),
      });
      for (const entry of entries) omit(entry, "Conflicting reviewed values; deselect a source document or explicitly choose one source for this field.");
      continue;
    }
    if (entries[0].suppress && !forReportPersistence) {
      for (const entry of entries) omit(entry, "Explicit not-PUD evidence was retained for conflict checks; an unchecked PUD value is not exported because it could erase an existing field.");
      continue;
    }
    const chosenEntries = entries[0].group === "assignment_type"
      ? entries.filter((entry, index) => entries.findIndex((other) => other.fieldId === entry.fieldId) === index)
      : [compatibleZip ? entries.find((entry) => entry.value.length === 10) || entries[0] : entries[0]];
    for (const entry of chosenEntries) {
      const { group: _group, suppress: _suppress, assignmentType: _assignmentType, ...field } = entry;
      // HomeNode stores exact reviewed amounts/text and explicit negative PUD
      // evidence. Destination-only rounding and unchecked-field omission belong
      // to the SFREP export, never the persisted appraisal record.
      fields.push(forReportPersistence ? field : formatSelectedField(field, supplementalWarnings));
    }
  }
  fields.sort((a, b) => compare(a.fieldId, b.fieldId));
  conflicts.sort((a, b) => compare(a.sourceField, b.sourceField));
  omitted.sort(sourceOrder);
  const validatedAddenda = validatePdfAddenda(pdfAddenda, selected);
  const warnings = [
    "This export targets the legacy FNMA 1004 (09/2011) form, not the dynamic UAD 3.6 URAR.",
    "Document-derived fields use explicitly confirmed evidence. Any user-requested defaults are identified separately. Review imported values in Appraise-It Pro before use.",
    ...supplementalWarnings,
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
  return { formId, reportXml: `${lines.join("\n")}\n`, fields, conflicts, omitted, warnings,
    pdfAddenda: validatedAddenda, specificationUrl: SPEC_URL,
    effectiveDateContext: dateContext, assumptions, knownMissing };
}
