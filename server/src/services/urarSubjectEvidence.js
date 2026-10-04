import { inspectUrarReferenceLayout, extractUrarReferenceLayout } from "./urarReferenceLayouts.js";
import { isUrarPlaceholder, isUrarStateCode } from "../util/urarScalarValidation.js";
import { extractMlsListingPriceHistory, isMlsListingHistory } from "./mlsListingPriceHistory.js";
import { extractDwellingBlocksAssignment, isDwellingBlocksAssignment } from "./dwellingBlocksAssignment.js";

/**
 * Conservative, page-cited Subject suggestions from already-extracted PDF text.
 * No OCR, network, model, report writes, or automatic confirmation occurs here.
 * The caller owns document authorization, identity, and source-role selection.
 */
export const URAR_SUBJECT_EVIDENCE_VERSION = "2026-10-04-v1";
const LIMITS = Object.freeze({ pages: 250, pageChars: 500_000, totalChars: 4_000_000, lineChars: 4_000, lines: 50_000, candidates: 2_000, issues: 500 });
const SOURCES = new Set(["engagement_letter", "mls_sheet", "cad", "realist"]);
const NON_SUBJECT_DOCUMENT_TYPES = new Set(["purchase_contract", "district_evidence", "zoning_map", "zoning_ordinance", "map"]);
const compact = value => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim() : "";
const labelKey = value => compact(value).toLowerCase().replace(/\(s\)/g, "s").replace(/[.#]/g, "").replace(/\s*\/\s*/g, "/").trim();
const textValue = value => {
  const result = compact(value);
  return result && result.length <= 2_000 && !isUrarPlaceholder(result) && !/[\uFFFD]/u.test(result) ? result : null;
};
const shortText = value => { const result = textValue(value); return result && result.length <= 300 ? result : null; };
function subjectAddress(value) {
  const result = textValue(value);
  if (!result) return null;
  const street = result.split(",")[0].trim();
  // A subject-address candidate must actually contain a numbered street, not
  // a placeholder, table heading, or missing-value message. Unsupported rural
  // descriptions remain available in the PDF for explicit manual review.
  const numbered = street.match(/^\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+(.+)$/);
  return numbered && /[A-Za-z]/.test(numbered[1]) && !isUrarPlaceholder(numbered[1]) ? result : null;
}
const issue = (items, value) => { if (items.length < LIMITS.issues) items.push(value); };
const legalText = value => {
  const result = typeof value === "string" ? value.split("\n").map(compact).filter(Boolean).join("\n") : "";
  return result && result.length <= 2_000 && !isUrarPlaceholder(result) && !/\uFFFD/u.test(result) ? result : null;
};

function amount(value) {
  const match = compact(value).match(/^\$?\s*(\d{1,12}|\d{1,3}(?:,\d{3}){1,3})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return `${match[1].replaceAll(",", "").replace(/^0+(?=\d)/, "")}.${(match[2] || "").padEnd(2, "0")}`;
}
function date(value) {
  const source = compact(value);
  const iso = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const us = source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!iso && !us) return null;
  const [year, month, day] = (iso ? [iso[1], iso[2], iso[3]] : [us[3], us[1], us[2]]).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return year >= 1000 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
}
function frequency(value) {
  const source = compact(value).toLowerCase();
  if (/^(?:per[_ ]month|monthly|month|mo)$/.test(source)) return "per_month";
  if (/^(?:per[_ ]quarter|quarterly|quarter|qtr)$/.test(source)) return "per_quarter";
  if (/^(?:per[_ ]year|annually|annual|yearly|year|yr)$/.test(source)) return "per_year";
  return null;
}
function assignment(value) {
  const source = compact(value).toLowerCase().replace(/_/g, " ");
  const definitions = [
    ["purchase_transaction", /^(?:purchase|purchase transaction|acquisition)$/],
    ["refinance", /^(?:refinance|refi)$/], ["heloc", /^(?:heloc|home equity line of credit)$/],
    ["rtl", /^(?:rtl|residential transition loan)$/], ["bridge_loan", /^(?:bridge|bridge loan)$/],
    ["new_construction", /^(?:new construction|construction loan)$/],
    ["rehab", /^(?:rehab|rehabilitation|renovation)$/], ["dscr", /^(?:dscr|debt service coverage ratio)$/],
  ];
  return definitions.find(([, pattern]) => pattern.test(source))?.[0] || null;
}
function explicitPud(value) {
  const source = compact(value).toLowerCase();
  if (["yes", "y", "true"].includes(source)) return "true";
  if (["no", "n", "false"].includes(source)) return "false";
  return null;
}
function state(value) { const result = compact(value).toUpperCase(); return isUrarStateCode(result) ? result : null; }
function zip(value) { const result = compact(value); return /^\d{5}(?:-\d{4})?$/.test(result) ? result : null; }
function year(value) { const result = compact(value); return /^[12]\d{3}$/.test(result) ? result : null; }
function censusTract(value) { const result = compact(value); return /^\d{1,4}(?:\.\d{1,2})?$/.test(result) ? result : null; }
function parcel(value) {
  const result = compact(value);
  return /^(?=[A-Za-z0-9. -]*\d)[A-Za-z0-9][A-Za-z0-9. -]{1,78}$/.test(result) ? result : null;
}

const addressFields = [
  ["subject_property_address", ["subject address", "subject property address", "property address"], subjectAddress],
  ["subject_street_address", ["subject street address", "property street address", "street address"], subjectAddress],
  ["subject_city", ["subject city", "property city", "city"], shortText],
  ["subject_state", ["subject state", "property state", "state"], state],
  ["subject_zip", ["subject zip", "subject zip code", "property zip", "property zip code", "zip", "zip code", "postal code"], zip],
];
const referenceAddressFields = addressFields.map(([key, labels, normalize]) => [key,
  [...labels.filter(label => /^(?:subject|property)\b/.test(label)), ...({
    subject_property_address: ["situs address", "situs property address"],
    subject_street_address: ["situs street address"], subject_city: ["situs city"], subject_state: ["situs state"],
    subject_zip: ["situs zip", "situs zip code", "situs postal code"],
  }[key] || [])], normalize,
]);
const parcelLabels = ["apn", "parcel number", "parcel id", "assessor parcel number", "assessors parcel number"];
const RULES = {
  engagement_letter: [
    ["borrower_name", ["borrower", "borrowers", "borrower name", "borrower names"], shortText],
    ["assignment_type", ["assignment type", "assignment purpose", "loan purpose", "transaction type"], assignment],
    ["lender_client_name", ["lender/client", "lender/client name", "lender name", "client name", "lender", "client"], shortText],
    ["lender_client_address", ["lender/client address", "lender address", "client address"], textValue],
    ["property_type", ["subject property type", "property type"], shortText],
    ...addressFields.map(([key, labels, normalize]) => [key, labels.filter(label => /^(?:subject|property)\b/.test(label)), normalize]),
  ],
  mls_sheet: [
    ...addressFields,
    ["list_date", ["list date", "listing date", "original list date", "original listing date", "ld"], date],
    ["hoa_dues_amount", ["hoa dues", "hoa fee", "hoa fees", "hoa dues amount", "association fee", "association dues"], amount],
    ["hoa_frequency", ["hoa frequency", "hoa fee frequency", "hoa dues frequency", "hoa dues freq", "hoa fee freq", "association fee frequency"], frequency],
    ["pud", ["pud", "planned unit development", "planned unit development pud"], explicitPud],
  ],
  cad: [
    ...referenceAddressFields,
    ["owner_name", ["owner", "owner name", "owners", "property owner", "current owner", "owner of record"], shortText],
    ["assessor_parcel_number", [...parcelLabels, "account number", "account no", "account id"], parcel],
    ["county", ["county", "property county"], shortText],
    ["legal_description", ["legal description", "legal", "property legal description"], legalText],
    ["census_tract", ["census tract", "census tract number"], censusTract],
  ],
  realist: [
    ...referenceAddressFields,
    ["assessor_parcel_number", parcelLabels, parcel],
    ["county", ["property county", "situs county"], shortText],
    ["tax_year", ["tax year", "property tax year", "real estate tax year"], year],
    ["tax_amount", ["tax amount", "total tax amount", "total taxes", "annual taxes", "property taxes", "real estate taxes", "real estate tax", "real estate tax amount"], amount],
    ["census_tract", ["census tract", "census tract number"], censusTract],
  ],
};
export const URAR_SUBJECT_FIELD_KEYS = Object.freeze([...new Set([
  ...Object.values(RULES).flatMap(rules => rules.map(([key]) => key)), "neighborhood_name", "listing_price_history",
])]);
const FIELD_BOUNDARIES = new Set([
  ...Object.values(RULES).flatMap(rules => rules.flatMap(([, labels]) => labels)),
  "owner mailing address", "owner address", "mailing address", "mailing city", "mailing state", "mailing zip", "mailing zip code", "mailing county",
  "address", "property information", "owner information", "tax information", "tax history", "assessment information",
  "assessed value", "taxable value", "assessment year", "market value", "land value", "improvement value", "total assessed value",
]);

function collectLines(pages, unresolved) {
  const entries = [];
  if (!Array.isArray(pages)) { issue(unresolved, { reason: "pages_unavailable" }); return entries; }
  if (pages.length > LIMITS.pages) issue(unresolved, { reason: "page_limit_exceeded" });
  let total = 0;
  for (let index = 0; index < Math.min(pages.length, LIMITS.pages); index += 1) {
    const page = pages[index];
    if (typeof page !== "string") { issue(unresolved, { page_number: index + 1, reason: "page_unreadable" }); continue; }
    total += page.length;
    if (page.length > LIMITS.pageChars || total > LIMITS.totalChars) {
      issue(unresolved, { page_number: index + 1, reason: "text_limit_exceeded" }); continue;
    }
    for (const line of page.replace(/\r\n?/g, "\n").split("\n")) {
      if (line.length > LIMITS.lineChars) { issue(unresolved, { page_number: index + 1, reason: "line_limit_exceeded" }); continue; }
      // Explicit visual-column separators are respected; arbitrary single spaces
      // are never treated as field boundaries or silently guessed away.
      for (const segment of line.split(/\t+|\s*\|\s*| {2,}(?=[A-Za-z][A-Za-z /()#.'-]{0,55}[:=])/)) {
        const text = compact(segment);
        if (entries.length >= LIMITS.lines) { issue(unresolved, { reason: "line_count_limit_exceeded" }); return entries; }
        if (text) entries.push({ line: text, page_number: index + 1 });
      }
    }
  }
  return entries;
}

function sourceFor(documentType, sourceKind, entries, referenceLayout = null) {
  if (SOURCES.has(sourceKind)) return sourceKind;
  if (documentType === "engagement_letter" || documentType === "mls_sheet") return documentType;
  if (documentType !== "other") return null;
  // A filename alone is not source evidence. Identify reference families from
  // their text; a report mentioning another source in prose is not a heading.
  const headings = entries.filter(entry => entry.line.length <= 160).map(entry => entry.line);
  const realist = referenceLayout === "realist" || headings.some(line => /^(?:(?:corelogic|cotality)\s+)?realist\b/i.test(line));
  const cad = referenceLayout === "cad" || headings.some(line => /^(?:[A-Za-z .'-]+\s+)?(?:central\s+)?appraisal\s+district(?:\s+(?:property|account|record|search|detail|summary|report)[\w -]*)?$/i.test(line)
    || /^(?:DALLAS|COLLIN|DENTON|TARRANT)\s+CAD(?:\s+(?:PROPERTY|ACCOUNT|RECORD|REPORT))?$/i.test(line));
  const history = isMlsListingHistory(entries.map(entry => entry.line).join("\n"));
  return Number(realist) + Number(cad) + Number(history) > 1 ? null : realist ? "realist" : cad ? "cad" : history ? "mls_sheet" : null;
}

function addMlsHoaEvidence(entries, candidates, unresolved, add) {
  const observations = [];
  const label = /(?:^|\s)(HOA(?:\s+(?:Dues(?:\s+(?:Frequency|Freq))?|Fees?(?:\s+(?:Frequency|Freq))?|Frequency))?)\s*:\s*/gi;
  const boundary = /\s+(?:HOA(?:\s+[A-Za-z /.'-]{1,40})?|PUD|Association(?:\s+[A-Za-z /.'-]{1,40})?|Phone|School Dist|SubType|Property Type)\s*[:=]/i;
  for (const entry of entries) {
    for (const match of entry.line.matchAll(label)) {
      const tail = entry.line.slice(match.index + match[0].length);
      const nextLabel = tail.search(boundary);
      const raw = compact(nextLabel < 0 ? tail : tail.slice(0, nextLabel));
      const key = labelKey(match[1]);
      if (key === "hoa") {
        observations.push({ entry, raw, status: /^(?:none|no)$/i.test(raw) ? "none" : /^voluntary$/i.test(raw) ? "voluntary" : /^(?:mandatory|yes|required)$/i.test(raw) ? "yes" : null });
        continue;
      }
      if (/(?:frequency|freq)$/.test(key)) {
        const normalized = frequency(raw);
        if (normalized) add("hoa_frequency", raw, normalized, entry, entry.line, "hoa_labeled_value");
        continue;
      }
      const dues = raw.match(/^(\$?\s*[\d,]+(?:\.\d{1,2})?)(?:\s*(?:\/|per\s+)?(monthly|month|mo|quarterly|quarter|qtr|annually|annual|yearly|year|yr))?$/i);
      if (dues && amount(dues[1])) {
        add("hoa_dues_amount", raw, amount(dues[1]), entry, entry.line, "hoa_labeled_value");
        if (dues[2]) add("hoa_frequency", dues[2], frequency(dues[2]), entry, entry.line, "hoa_labeled_value");
      }
    }
  }
  if (!observations.length) {
    // An explicitly labeled positive HOA amount and supported period establish
    // the user's requested HOA-exists assumption even when its separate status
    // label is omitted. Never override an actual Unknown/Voluntary/None label.
    const dues = candidates.filter(item => item.field_key === "hoa_dues_amount");
    const periods = new Set(candidates.filter(item => item.field_key === "hoa_frequency").map(item => item.normalized_value));
    const values = new Set(dues.map(item => item.normalized_value));
    if (values.size !== 1 || !dues.length || Number([...values][0]) <= 0
      || periods.size !== 1 || !["per_month", "per_quarter", "per_year"].includes([...periods][0])) return;
    observations.push({ entry: { page_number: dues[0].page_number, line: dues[0].evidence_excerpt }, raw: dues[0].raw_value, status: "yes" });
  }
  // This is an explicitly requested review workflow assumption, not a legal
  // finding that HOA existence alone establishes PUD status. Actual PUD labels
  // take precedence, and unknown/voluntary HOA wording never becomes Yes.
  const statuses = new Set(observations.map(item => item.status));
  const amounts = new Set(candidates.filter(item => item.field_key === "hoa_dues_amount").map(item => item.normalized_value));
  const affirmativeDues = amounts.size === 1 && Number([...amounts][0]) > 0;
  const selected = observations[0];
  if (entries.some(entry => /(?:^|\s)(?:PUD|Planned Unit Development(?: PUD)?)\s*(?:[:=]|$)/i.test(entry.line))) {
    const explicit = candidates.filter(candidate => candidate.field_key === "pud").map(candidate => candidate.normalized_value);
    const expected = selected.status === "yes" ? "true" : ["none", "voluntary"].includes(selected.status) ? "false" : null;
    if (expected && explicit.some(value => value !== expected)) issue(unresolved,
      { field_key: "pud", page_number: selected.entry.page_number, reason: "hoa_status_conflicts_with_explicit_pud" });
    return;
  }
  if (entries.some(entry => /(?:^|\s)(?:Property Type|SubType|Housing Type)\s*:\s*[^:]*\b(?:condo(?:minium)?|co-?op(?:erative)?)\b/i.test(entry.line))) {
    issue(unresolved, { field_key: "pud", page_number: selected.entry.page_number, reason: "hoa_workflow_proxy_ineligible_property_type" }); return;
  }
  if (statuses.size !== 1 || statuses.has(null) || amounts.size > 1
    || (selected.status === "none" && affirmativeDues)) {
    issue(unresolved, { field_key: "pud", page_number: selected.entry.page_number, reason: "hoa_workflow_proxy_requires_unambiguous_status_and_dues" });
    return;
  }
  if (selected.status === "voluntary") issue(unresolved,
    { field_key: "pud", page_number: selected.entry.page_number, reason: "voluntary_hoa_defaults_non_pud_review_required" });
  if (selected.status === "yes" && !affirmativeDues) issue(unresolved,
    { field_key: "hoa_dues_amount", page_number: selected.entry.page_number, reason: "affirmative_hoa_dues_not_reported" });
  add("pud", selected.raw, selected.status === "yes" ? "true" : "false", selected.entry,
    `${selected.entry.line}\nUser-requested HOA workflow assumption; requires appraiser review and is not legal proof of PUD status.`, "hoa_workflow_proxy");
}

/** Use before the general classifier for Other uploads: an incidental MLS #
 * inside a Realist/CAD report must not change the explicit source family. */
export function identifyUrarSubjectSource({ documentType = "other", pages = [] } = {}) {
  if (NON_SUBJECT_DOCUMENT_TYPES.has(documentType)) return null;
  const unresolved = [];
  const entries = collectLines(pages, unresolved);
  const reference = inspectUrarReferenceLayout(pages);
  return unresolved.length || reference.unresolved.length ? null : sourceFor(documentType, null, entries, reference.sourceKind);
}

function postalParts(value) {
  const match = compact(value).match(/^(\d+[A-Za-z0-9 -]*\s[^,]+),\s*([A-Za-z][A-Za-z .'-]*),?\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match || !state(match[3])) return null;
  return { subject_street_address: match[1], subject_city: match[2], subject_state: state(match[3]), subject_zip: match[4] };
}
function localityLine(value) { return /^[A-Za-z][A-Za-z .'-]*,?\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/.test(value); }
function labeled(value) { return /^[A-Za-z][A-Za-z /()#.'-]{0,55}\s*[:=]/.test(value); }
function fieldBoundary(value) { return labeled(value) || FIELD_BOUNDARIES.has(labelKey(value)); }

function legalSubdivision(value) {
  const nested = value.match(/(?:^|[\n;,])\s*(?:subdivision|addition)\s*[:=]\s*([^;\n]+?)(?=\s*[,;]\s*(?:lot|block|blk|phase|section|sec|plat|volume|page)\b|$)/im);
  if (nested && shortText(nested[1])) return { name: compact(nested[1]), method: "legal_subdivision_label" };
  const lines = value.split("\n").map(compact).filter(Boolean);
  const first = lines[0] || "";
  const marker = first.search(/\s+(?:BLK|BLOCK|LT|LOT)\s+[A-Za-z0-9-]+\b/i);
  const name = (marker > 0 ? first.slice(0, marker) : first).trim();
  const lotBlock = marker > 0 ? first.slice(marker) : lines.slice(1, 4).join(" ");
  if (!/\b(?:BLK|BLOCK)\s+[A-Za-z0-9-]+\b/i.test(lotBlock) || !/\b(?:LT|LOT)\s+[A-Za-z0-9-]+\b/i.test(lotBlock)) return null;
  if (!/^[A-Za-z][A-Za-z0-9 .,'&()/-]{2,199}$/.test(name)
    || /\b(?:ABSTRACT|TRACT|SURVEY|ACRES?|BEING|BEGINNING|THENCE|METES|BOUNDS|OWNER|ADDRESS|ACCOUNT|PARCEL)\b/i.test(name)
    || /^A[- ]?\d+\b/i.test(name)) return null;
  return { name, method: "legal_subdivision_lot_block" };
}

function mlsListingIdentityIssue(entries) {
  // Match the legacy MLS-number label family, including inline columns and
  // standalone values, but never truncate a malformed ID to a valid prefix.
  // A missing/placeholder record ID is not evidence that two records agree.
  const labels = /(?:^|[\s|;])(?:MLS|LISTING)\s*(?:#|NO\.|(?:NO|NUMBER|ID)(?=$|[\s:=#-]))/gi;
  const identifiers = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    for (const match of entry.line.matchAll(labels)) {
      let raw = entry.line.slice(match.index + match[0].length).trim().replace(/^[:=#-]\s*/, "");
      // Matrix's explicitly qualified, empty lease-reference field is not a
      // second primary listing. Filled or unqualified missing IDs remain gated.
      if (!raw && /\b(?:Lse|Lease)\s*$/i.test(entry.line.slice(0, match.index))) continue;
      if (!raw) {
        const next = entries[index + 1];
        // Only a standalone label can take the next same-page line as its value.
        if (match.index !== 0 || !next || next.page_number !== entry.page_number || labeled(next.line)) {
          return "ambiguous_mls_listing_identity";
        }
        raw = next.line;
      }
      const token = raw.match(/^([A-Z0-9][A-Z0-9-]{2,44})(?=$|[\s|;])/i)?.[1];
      if (!token || isUrarPlaceholder(token) || isUrarPlaceholder(raw)
        || /^(?:not\s+(?:available|provided|disclosed|applicable)|to\s+be\s+(?:determined|assigned|confirmed|announced))(?=$|[\s|;])/i.test(raw)) {
        return "ambiguous_mls_listing_identity";
      }
      identifiers.add(token.toUpperCase());
      if (identifiers.size > 1) return "multiple_mls_listing_identities";
    }
  }
  return null;
}

function addMlsHeadingIdentity(entries, add) {
  // Matrix prints the property address before its MLS-number/status row. That
  // bounded heading is evidence; an address elsewhere may be a broker or comp.
  const headers = entries.filter(entry => /^MLS\s*#\s*:\s*\d{4,20}\b/i.test(entry.line));
  const header = headers.find(entry => entry.page_number === 1);
  if (!header) return;
  const headingIndex = entries.indexOf(header);
  if (headingIndex > 12) return;
  const addresses = entries.slice(0, headingIndex).filter(entry => entry.page_number === 1)
    .map(entry => ({ entry, normalized: entry.line.replace(/,\s*Texas\s+(\d{5}(?:-\d{4})?)$/i, ", TX $1") }))
    .map(item => ({ ...item, parts: postalParts(item.normalized) }))
    .filter(item => item.parts && subjectAddress(item.normalized));
  if (addresses.length !== 1) return;
  const { entry, normalized, parts } = addresses[0];
  // Cross-check the address printed in the listing row. A brokerage letterhead
  // before MLS# is not property evidence, even when it is the only postal line.
  const beforePrice = header.line.match(/^(.*?)\s+(?:LP|List\s+Price)\s*:/i)?.[1];
  const rowZip = beforePrice?.match(/\b(\d{5}(?:-\d{4})?)$/)?.[1];
  const headerPostal = value => compact(value.replace(/,\s*/g, " ").replace(/\bTexas(?=\s+\d{5})/i, "TX")
    .replace(/(\b\d{5})-\d{4}$/, "$1")).toUpperCase();
  if (!beforePrice || !rowZip || rowZip.slice(0, 5) !== parts.subject_zip.slice(0, 5)
    || (rowZip.length === 10 && parts.subject_zip.length === 10 && rowZip !== parts.subject_zip)
    || !headerPostal(beforePrice).endsWith(` ${headerPostal(normalized)}`)) return;
  const evidence = `${entry.line}\n${header.line}`;
  add("subject_property_address", entry.line, normalized, entry, evidence, "mls_print_heading");
  for (const [key, value] of Object.entries(parts)) add(key, value, value, entry, evidence, "mls_print_heading");
  for (const parcelEntry of entries.filter(item => item.page_number === 1)) {
    const matched = parcelEntry.line.match(/^Parcel\s+ID\s*:\s*([A-Za-z0-9][A-Za-z0-9.-]{1,78})(?=\s+(?:Plan\s+Dvlpm|Lot|Block)\s*:|\s*$)/i);
    if (matched && parcel(matched[1])) add("assessor_parcel_number", matched[1], parcel(matched[1]), parcelEntry, parcelEntry.line, "mls_print_parcel");
  }
}

function collectConflicts(candidates, conflicts) {
  for (const fieldKey of new Set(candidates.map(candidate => candidate.field_key))) {
    const alternatives = candidates.filter(candidate => candidate.field_key === fieldKey);
    const values = [...new Set(alternatives.map(candidate => candidate.normalized_value))];
    if (values.length > 1) conflicts.push({ field_key: fieldKey, values, page_numbers: [...new Set(alternatives.map(candidate => candidate.page_number))] });
  }
}

/**
 * Returns the existing candidate shape plus non-persisted review diagnostics.
 * sourceKind may be supplied by a trusted caller that already identified CAD or
 * Realist; otherwise 'other' needs an explicit source heading in page text.
 * All candidates, including conflicting alternatives, remain 'suggested'.
 */
export function buildUrarSubjectEvidence({ documentType = "other", pages = [], sourceKind = null } = {}) {
  const unresolved = [], candidates = [], conflicts = [];
  // Explicit contract, zoning, district, and map types retain their own parsers.
  // Subject-only bounds or source hints must not veto or take over those types.
  // Unknown Other uploads still undergo the full fail-closed source checks.
  if (NON_SUBJECT_DOCUMENT_TYPES.has(documentType)) {
    return { schema_version: URAR_SUBJECT_EVIDENCE_VERSION, source_kind: null,
      review_required: true, candidates, conflicts, unresolved };
  }
  const entries = collectLines(pages, unresolved);
  const reference = inspectUrarReferenceLayout(pages);
  const inputIncomplete = unresolved.length > 0 || reference.unresolved.length > 0;
  const referenceLayout = documentType === "other" ? reference.sourceKind : null;
  const source = sourceFor(documentType, sourceKind, entries, referenceLayout);
  const result = { schema_version: URAR_SUBJECT_EVIDENCE_VERSION, source_kind: source, review_required: true, candidates, conflicts, unresolved };
  if (inputIncomplete) {
    reference.unresolved.forEach(item => issue(unresolved, item));
    // Never project the retained first pages after losing a conflicting page or
    // merging different report families. Legacy extraction honors this gate too.
    issue(unresolved, { reason: "source_input_incomplete" });
    return result;
  }
  if (!source) { issue(unresolved, { reason: entries.length ? "source_not_identified" : "no_readable_text" }); return result; }
  if (source === 'engagement_letter' && isDwellingBlocksAssignment(pages)) {
    const assignmentPrint = extractDwellingBlocksAssignment(pages, assignment);
    result.source_layout = 'dwelling_blocks_assignment';
    candidates.push(...assignmentPrint.candidates);
    assignmentPrint.unresolved.forEach(item => issue(unresolved, item));
    collectConflicts(candidates, conflicts);
    return result;
  }
  if (source === "mls_sheet" && isMlsListingHistory(entries.map(entry => entry.line).join("\n"))) {
    // History PDFs deliberately contain older MLS records. Their adapter binds
    // each summary to one ID; do not run the single-listing-sheet parser or
    // collapse independent histories into a first-match MLS field.
    const history = extractMlsListingPriceHistory(pages);
    result.source_layout = "matrix_listing_history";
    candidates.push(...history.candidates);
    history.unresolved.forEach(item => issue(unresolved, item));
    return result;
  }
  const listingIdentityIssue = source === "mls_sheet" ? mlsListingIdentityIssue(entries) : null;
  if (listingIdentityIssue) {
    issue(unresolved, { reason: listingIdentityIssue }); return result;
  }
  if (referenceLayout === source) {
    // A recognized table layout owns its omissions too. The generic label
    // parser must not fill an absent total with a jurisdiction's Tax Amount.
    const layout = extractUrarReferenceLayout({ sourceKind: source, pages });
    candidates.push(...layout.candidates);
    layout.unresolved.forEach(item => issue(unresolved, item));
    collectConflicts(candidates, conflicts);
    return result;
  }
  const rules = new Map(RULES[source].flatMap(([key, labels, normalize]) => labels.map(label => [label, { key, normalize }])));
  const found = new Set();
  const add = (fieldKey, raw, normalized, entry, evidence, method = "labeled_text") => {
    if (candidates.length >= LIMITS.candidates) {
      if (!unresolved.some(item => item.reason === "candidate_limit_exceeded")) issue(unresolved, { reason: "candidate_limit_exceeded" });
      return;
    }
    if (candidates.some(item => item.field_key === fieldKey && item.normalized_value === normalized && item.page_number === entry.page_number)) return;
    candidates.push({ field_key: fieldKey, raw_value: raw, normalized_value: normalized, source_kind: source,
      page_number: entry.page_number, confidence: method.startsWith("legal_subdivision_") ? 0.8 : 0.9,
      evidence_excerpt: evidence.slice(0, 2_000), extraction_method: `urar_subject_${source}_${method}`, review_status: "suggested" });
  };
  if (source === "mls_sheet") addMlsHeadingIdentity(entries, add);
  for (const candidate of candidates) found.add(candidate.field_key);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const match = entry.line.match(/^([A-Za-z][A-Za-z /()#.'-]{0,55}?)\s*[:=]\s*(.*)$/);
    // A bare label on its own line is explicit evidence too. Do not split an
    // arbitrary unlabeled sentence or column by guessing where its value starts.
    const rule = rules.get(labelKey(match ? match[1] : entry.line));
    if (!rule) continue;
    found.add(rule.key);
    if (source === "realist" && rule.key === "tax_amount" && labelKey(match ? match[1] : entry.line) === "tax amount"
      && entries.slice(0, index).some(item => item.page_number === entry.page_number && /^(?:tax\s+)?jurisdiction\b/i.test(item.line))) {
      issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "jurisdiction_tax_is_not_property_total" }); continue;
    }
    let raw = compact(match?.[2]);
    const evidence = [entry.line];
    const next = entries[index + 1];
    if (!raw && next?.page_number === entry.page_number && (!fieldBoundary(next.line)
      || (rule.key === "legal_description" && /^(?:subdivision|addition)\s*[:=]/i.test(next.line)))) {
      raw = next.line; evidence.push(next.line);
    }
    if (!raw) { issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "labeled_value_missing" }); continue; }
    if (rule.key === "list_date") {
      // Common MLS rows pack LD, CD, and DOM onto one line. Only the exact
      // numeric date token before another explicit label belongs to LD.
      const dateToken = raw.match(/^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})(?=\s+[A-Za-z][A-Za-z /()#.'-]{0,55}[:=])/);
      if (dateToken) raw = dateToken[1];
    }
    if (source === "mls_sheet" && rule.key === "hoa_dues_amount") {
      // Matrix prints the association phone beside its dues. The phone is an
      // explicit adjacent label, never part of the monetary amount or period.
      raw = raw.replace(/\s+Phone\s*[:=].*$/i, "");
    }
    if (/\b[A-Za-z][A-Za-z /()#.'-]{0,55}[:=]/.test(raw) && rule.key !== "legal_description") {
      issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "ambiguous_labeled_value" }); continue;
    }
    if (["subject_property_address", "lender_client_address"].includes(rule.key)) {
      const continuation = entries[index + evidence.length];
      if (!postalParts(raw) && continuation?.page_number === entry.page_number && localityLine(continuation.line)) {
        raw += `, ${continuation.line}`; evidence.push(continuation.line);
      }
    }
    if (rule.key === "legal_description") {
      let limited = false;
      for (let offset = evidence.length; offset < 12; offset += 1) {
        const continuation = entries[index + offset];
        if (!continuation || continuation.page_number !== entry.page_number || fieldBoundary(continuation.line)
          || /^(?:property information|owner information|mailing address|appraised value|market value|tax information|exemptions?|improvements?|copyright|©)\b/i.test(continuation.line)) break;
        if (raw.length + continuation.line.length + 1 > 2_000) { limited = true; break; }
        raw += `\n${continuation.line}`; evidence.push(continuation.line);
      }
      const remaining = entries[index + evidence.length];
      if (evidence.length === 12 && remaining?.page_number === entry.page_number && !fieldBoundary(remaining.line)) limited = true;
      if (limited) { issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "legal_text_limit_exceeded" }); continue; }
    }
    if (rule.key === "hoa_dues_amount") {
      const withFrequency = raw.match(/^(\$?\s*[\d,]+(?:\.\d{1,2})?)\s*(?:\/|per\s+)?(monthly|month|mo|quarterly|quarter|qtr|annually|annual|yearly|year|yr)$/i);
      if (withFrequency && amount(withFrequency[1]) && frequency(withFrequency[2])) {
        add(rule.key, raw, amount(withFrequency[1]), entry, evidence.join("\n"));
        add("hoa_frequency", withFrequency[2], frequency(withFrequency[2]), entry, evidence.join("\n"));
        found.add("hoa_frequency"); continue;
      }
    }
    const normalized = rule.normalize(raw);
    if (normalized == null) { issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "labeled_value_unparseable" }); continue; }
    add(rule.key, raw, normalized, entry, evidence.join("\n"));
    if (rule.key === "subject_property_address") {
      const parts = postalParts(normalized);
      if (parts) for (const [key, value] of Object.entries(parts)) {
        add(key, value, value, entry, evidence.join("\n"), "labeled_postal_address"); found.add(key);
      }
      else issue(unresolved, { field_key: rule.key, page_number: entry.page_number, reason: "address_components_not_safely_split" });
    }
    if (rule.key === "legal_description") {
      // A recorded legal label, or a name immediately preceding explicit
      // lot/block markers, is evidence. Preserve phase digits; never merge
      // phases or infer a neighborhood from an address/marketing label.
      const subdivision = legalSubdivision(normalized);
      if (subdivision) add("neighborhood_name", subdivision.name, subdivision.name, entry, evidence.join("\n"), subdivision.method);
      else issue(unresolved, { field_key: "neighborhood_name", page_number: entry.page_number, reason: "legal_subdivision_not_explicit" });
    }
  }
  if (source === "mls_sheet") {
    addMlsHoaEvidence(entries, candidates, unresolved, add);
    for (const candidate of candidates) found.add(candidate.field_key);
  }
  for (const fieldKey of new Set(RULES[source].map(([key]) => key))) {
    if (!found.has(fieldKey)) issue(unresolved, { field_key: fieldKey, reason: "label_not_found" });
  }
  collectConflicts(candidates, conflicts);
  return result;
}
