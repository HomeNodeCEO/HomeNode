import { isUrarPlaceholder, isUrarStateCode } from '../util/urarScalarValidation.js';

const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
const label = /^[A-Za-z][A-Za-z /()#.'`-]{0,70}\s*:/;
const suffix = /\b(?:STREET|ST|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|BOULEVARD|BLVD|AVENUE|AVE|PLACE|PL|CIRCLE|CIR|PARKWAY|PKWY|TRAIL|TRL|TERRACE|TER|COVE|CV|WAY)\b/gi;

/** Separate only an explicitly delimited locality or one unambiguous street
 * suffix. No words are rewritten, and ambiguous city/street boundaries stay
 * unresolved rather than weakening the downstream subject-identity check. */
export function assignmentPostalAddress(value) {
  const source = compact(value);
  const delimited = source.match(/^(.+),\s*([A-Za-z][A-Za-z .'-]*?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  const endings = source.match(/^(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  let parts = delimited?.slice(1);
  if (!parts && endings) {
    const choices = [...endings[1].matchAll(suffix)].map(match => {
      const end = match.index + match[0].length;
      return [endings[1].slice(0, end).trim(), endings[1].slice(end).trim(), endings[2], endings[3]];
    }).filter(([street, city]) => /^\d+[A-Za-z]?\s+[A-Za-z]/.test(street)
      && /^[A-Za-z][A-Za-z .'-]*$/.test(city));
    if (choices.length === 1) parts = choices[0];
  }
  if (!parts || !/^\d+[A-Za-z]?\s+\S/.test(parts[0]) || !isUrarStateCode(parts[2])) return null;
  return { address: `${parts[0]}, ${parts[1]}, ${parts[2].toUpperCase()} ${parts[3]}`,
    street: parts[0], city: parts[1], state: parts[2].toUpperCase(), zip: parts[3] };
}

export function isAppraisalOrderAssignment(pages) {
  if (!Array.isArray(pages) || pages.length > 250 || pages.some(page => typeof page !== 'string' || page.length > 500_000)
    || pages.reduce((sum, page) => sum + page.length, 0) > 4_000_000) return false;
  const first = pages[0] || '';
  return /^Order Information\s*$/m.test(first) && /^Order Type:\s*Residential Appraisal\b/m.test(first)
    && /^Property Address:/m.test(first) && /^Client Address:/m.test(first)
    && /^Transaction Type:/m.test(first) && /\bestreetamc\.com\b|E STREET (?:AMC|APPRAISAL)/i.test(pages.slice(0, 2).join('\n'));
}

/** The order page owns these fields; lender instructions later in the packet
 * must not become a second assignment, borrower, or client address. */
export function extractAppraisalOrderAssignment(pages, normalizeAssignmentType = () => null) {
  const result = { source_kind: 'engagement_letter', source_layout: 'appraisal_order_assignment',
    review_required: true, candidates: [], conflicts: [], unresolved: [] };
  if (!isAppraisalOrderAssignment(pages)) return null;
  const entries = pages.flatMap((page, index) => page.split(/\r?\n/).map(compact)
    .filter(Boolean).map(line => ({ line, page: index + 1 })));
  if (entries.length > 50_000 || entries.some(entry => entry.line.length > 4_000
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(entry.line))) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  const addresses = entries.filter(entry => /^Property Address:/i.test(entry.line));
  if (addresses.length !== 1) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  const add = (key, value, entry, excerpt = entry.line) => {
    if (!value || value.length > 2_000 || isUrarPlaceholder(value)) return;
    result.candidates.push({ field_key: key, raw_value: value, normalized_value: value,
      page_number: entry.page, confidence: 0.96, evidence_excerpt: excerpt.slice(0, 2_000),
      extraction_method: 'urar_subject_engagement_letter_appraisal_order',
      source_kind: 'engagement_letter', review_status: 'suggested' });
  };
  const read = (pattern, { page = 1, multiline = false } = {}) => {
    const matches = entries.filter(entry => entry.page === page && pattern.test(entry.line));
    if (matches.length !== 1) return null;
    const entry = matches[0], index = entries.indexOf(entry), lines = [entry.line.match(pattern)[1]];
    if (multiline) for (let next = index + 1; next < entries.length && next <= index + 3; next++) {
      const continuation = entries[next];
      if (continuation.page !== page || label.test(continuation.line)
        || /^(?:\(\s*Additional Resources\s*\)|Order Information|Borrower Information|Fee Details|Client Instructions)$/i.test(continuation.line)) break;
      lines.push(continuation.line);
    }
    return { entry, value: compact(lines.join(' ')), excerpt: [entry.line, ...lines.slice(1)].join('\n') };
  };
  const addressEntry = addresses[0], printed = addressEntry.line.replace(/^Property Address:\s*/i, '');
  const address = assignmentPostalAddress(printed);
  if (address) {
    add('subject_property_address', address.address, addressEntry);
    for (const [key, value] of [['subject_street_address', address.street], ['subject_city', address.city],
      ['subject_state', address.state], ['subject_zip', address.zip]]) add(key, value, addressEntry);
  } else result.unresolved.push({ field_key: 'subject_property_address', reason: 'address_components_not_safely_split' });
  for (const [key, pattern] of [['lender_client_name', /^Client:\s*(.+)$/i],
    ['lender_client_address', /^Client Address:\s*(.+)$/i]]) {
    const item = read(pattern, { multiline: true });
    if (item) add(key, item.value, item.entry, item.excerpt);
  }
  const borrowers = entries.filter(entry => /^Borrower Name:\s*\S/i.test(entry.line));
  if (borrowers.length === 1) add('borrower_name', borrowers[0].line.replace(/^Borrower Name:\s*/i, ''), borrowers[0]);
  const purpose = read(/^Transaction Type:\s*(.+?)(?=\s+Legal Description:|$)/i);
  if (purpose && /^(?:Foreclosure|Liquidation|REO)$/i.test(purpose.value)) {
    add('assignment_type', 'other', purpose.entry);
    add('assignment_explanation', purpose.value, purpose.entry);
  } else if (purpose) {
    const normalized = normalizeAssignmentType(purpose.value);
    if (normalized) add('assignment_type', normalized, purpose.entry);
    else result.unresolved.push({ field_key: 'assignment_type', reason: 'assignment_order_purpose_unrecognized' });
  }
  return result;
}
