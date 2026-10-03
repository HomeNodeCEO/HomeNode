import { isUrarStateCode } from './urarScalarValidation.js';

// Presentation is deliberately separate from source identity and conflict
// detection. Call only after selecting reviewed evidence; never use the result
// to match parcels, resolve contradictory documents, or rewrite legal text.
const RETAIN_UPPERCASE = new Set(['LLC', 'PLLC', 'LLP', 'LP', 'PC', 'INC', 'USA', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX']);
const ADDRESS_ABBREVIATIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'US', 'PO']);

export function titleCaseSubjectText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\p{L}[\p{L}\p{M}]*/gu, (word) => {
    if (RETAIN_UPPERCASE.has(word.toUpperCase())) return word.toUpperCase();
    // Preserve a deliberately styled/mixed-case name such as McDonald or
    // DeVito. Uniform source capitals/lowercase get the predictable transform.
    if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word;
    const lower = word.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

export function formatSubjectZip(value) {
  if (typeof value !== 'string') return value;
  return /^\d{5}(?:-?\d{4})?$/.test(value.trim()) ? value.trim().slice(0, 5) : value;
}

export function formatSubjectAddress(value) {
  if (typeof value !== 'string') return value;
  return titleCaseSubjectText(value)
    .replace(/\b(?:n|s|e|w|ne|nw|se|sw|us|po)\b/gi, (word) => (
      ADDRESS_ABBREVIATIONS.has(word.toUpperCase()) ? word.toUpperCase() : word
    ))
    // A two-letter word is a state only in the postal suffix, not in a street
    // name such as "In The Woods Dr". No address components are inferred.
    .replace(/\b([A-Za-z]{2}|Texas)(\s+)(\d{5})(?:-?\d{4})?(?=\s*$)/, (full, state, gap, zip) => (
      state === 'Texas' ? `Texas${gap}${zip}` : isUrarStateCode(state) ? `${state.toUpperCase()}${gap}${zip}` : full
    ));
}

export function formatNeighborhoodDisplayName(value) {
  if (typeof value !== 'string') return value;
  // The user wants a subdivision-level display label. Strip a standalone
  // terminal numeric phase only; meaningful digits inside a name, legal block/
  // lot text, roman numerals, and the original source label remain untouched.
  const trimmed = value.trim();
  const withoutPhase = trimmed.replace(/\s+\d+$/, '');
  return titleCaseSubjectText(withoutPhase);
}

export function formatSubjectPresentationValue(sourceField, value) {
  if (['subject_property_address', 'subject_street_address', 'lender_client_address'].includes(sourceField)) return formatSubjectAddress(value);
  if (['subject_city', 'borrower_name', 'owner_name', 'record_owner_name'].includes(sourceField)) return titleCaseSubjectText(value);
  if (['subject_zip', 'subject_zip_code'].includes(sourceField)) return formatSubjectZip(value);
  if (['neighborhood_name', 'subdivision_name'].includes(sourceField)) return formatNeighborhoodDisplayName(value);
  return value;
}
