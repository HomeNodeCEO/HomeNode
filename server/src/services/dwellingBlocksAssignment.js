import { isUrarPlaceholder, isUrarStateCode } from '../util/urarScalarValidation.js';

const TITLE = /^(?:\d{1,2}\/\d{1,2}\/\d{2,4},\s+\d{1,2}:\d{2}\s+[AP]M\s+)?Assignment Print\s*\|\s*Dwelling Blocks$/i;
const FOOTER = /^https:\/\/app\.dwellingblocks\.com\/assignments\/(\d+)\/print\s+(\d+)\/(\d+)$/i;
const LABEL = /^(?:Ordered By|Assignee|Contacts|Borrower|Co-?Borrower|Access Contact|Details|Due Date|Rush|Appointment Date|Report Type|Inspection Status|ETA Report Date|Loan Number|FHA Case Number|Appraisal Purpose|Loan Type|Loan Product|Property Type|Address To|Lender Address|Client Address|Notes|Completed Reports|Fees)$/i;
const compact = value => value.replace(/\s+/g, ' ').trim();
const safe = value => value && value.length <= 300 && !isUrarPlaceholder(value) && !/[\u0000-\u001f\uFFFD]/u.test(value);

export function isDwellingBlocksAssignment(pages) {
  return Array.isArray(pages) && pages.some(page => typeof page === 'string' && page.split(/\r?\n/).some(line => TITLE.test(line.trim())))
    && pages.some(page => typeof page === 'string' && page.split(/\r?\n/).some(line => FOOTER.test(line.trim())));
}

/** The verified assignment-print layout uses standalone labels and contact
 * cards. Borrower cards are one party group, not competing source documents.
 * Lender presets are deliberately not emitted as facts printed in this PDF. */
export function extractDwellingBlocksAssignment(pages, normalizeAssignmentType) {
  const result = { candidates: [], unresolved: [] };
  const fail = reason => { result.candidates = []; result.unresolved.push({ reason }); return result; };
  if (!Array.isArray(pages) || pages.length > 250 || pages.some(page => typeof page !== 'string' || page.length > 500_000)
    || pages.reduce((sum, page) => sum + page.length, 0) > 4_000_000) return fail('assignment_print_input_incomplete');
  const prepared = pages.map(page => page.split(/\r?\n/).map(compact).filter(Boolean));
  if (prepared.some(lines => lines.length > 10_000 || lines.some(line => line.length > 4_000))) return fail('assignment_print_input_incomplete');
  const entries = prepared.flatMap((lines, page) => lines.map((line, index) => ({ line, page_number: page + 1, index })));
  const footers = entries.flatMap(entry => { const match = entry.line.match(FOOTER); return match ? [{ ...entry, match }] : []; });
  if (!isDwellingBlocksAssignment(pages) || footers.length !== pages.length
    || new Set(footers.map(footer => footer.match[1])).size !== 1
    || footers.some((footer, index) => footer.page_number !== index + 1 || Number(footer.match[2]) !== index + 1 || Number(footer.match[3]) !== pages.length)) {
    return fail('assignment_print_incomplete_or_multiple_records');
  }
  const add = (key, raw, normalized, entry, evidence = entry.line, method = 'labeled_value') => {
    if (!safe(raw) || !safe(normalized)) return;
    if (result.candidates.some(candidate => candidate.field_key === key && candidate.normalized_value === normalized)) return;
    result.candidates.push({ field_key: key, raw_value: raw, normalized_value: normalized, page_number: entry.page_number,
      confidence: 0.95, evidence_excerpt: evidence.slice(0, 2_000), review_status: 'suggested', source_kind: 'engagement_letter',
      extraction_method: `urar_subject_engagement_letter_assignment_print_${method}` });
  };
  const addresses = entries.flatMap(entry => {
    const match = entry.line.match(/^(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?(?:\s+1\/2)?\s+[^,]{1,200}),\s*([A-Za-z][A-Za-z .'-]{0,99}),\s*([A-Za-z][A-Za-z .'-]{0,99}) County,\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
    return match && isUrarStateCode(match[4]) ? [{ ...entry, match }] : [];
  });
  if (addresses.length !== 1 || addresses[0].page_number !== 1
    || addresses[0].index >= prepared[0].findIndex(line => /^Ordered By$/i.test(line))) return fail('assignment_print_subject_identity_ambiguous');
  const address = addresses[0], [, street, city, county, state, zip] = address.match;
  for (const [key, value] of [['subject_property_address', `${street}, ${city}, ${state.toUpperCase()} ${zip}`],
    ['subject_street_address', street], ['subject_city', city], ['subject_state', state.toUpperCase()], ['subject_zip', zip], ['county', county]]) {
    add(key, value, value, address, address.line, 'subject_header');
  }
  const starts = entries.filter(entry => /^Contacts$/i.test(entry.line));
  if (starts.length === 1) {
    const start = starts[0], lines = prepared[start.page_number - 1];
    const end = lines.findIndex((line, index) => index > start.index && /^Details$/i.test(line));
    const contacts = end > start.index && end - start.index <= 60 ? lines.slice(start.index + 1, end) : [];
    const names = [];
    let invalid = !contacts.length;
    for (let index = 0; index < contacts.length; index += 1) {
      if (!/^(?:Borrower|Co-?Borrower)$/i.test(contacts[index])) continue;
      const name = contacts[index + 1];
      if (!safe(name) || LABEL.test(name) || !/^[\p{L}][\p{L}\p{M} .,'&()-]{1,199}$/u.test(name)) invalid = true;
      else names.push(name);
    }
    const unique = [...new Set(names)];
    if (!invalid && unique.length > 0 && unique.length <= 6 && unique.join(' / ').length <= 300) {
      add('borrower_name', unique.join(' / '), unique.join(' / '), start,
        ['Contacts', ...unique.flatMap(name => ['Borrower', name])].join('\n'), 'borrower_contacts');
    } else result.unresolved.push({ field_key: 'borrower_name', reason: 'assignment_print_borrower_contacts_ambiguous' });
  } else result.unresolved.push({ field_key: 'borrower_name', reason: 'assignment_print_borrower_contacts_ambiguous' });
  for (const entry of entries) {
    const lines = prepared[entry.page_number - 1], value = lines[entry.index + 1];
    if (!safe(value) || LABEL.test(value) || TITLE.test(value) || FOOTER.test(value)) continue;
    if (/^Appraisal Purpose$/i.test(entry.line)) {
      const normalized = normalizeAssignmentType(value);
      if (normalized) add('assignment_type', value, normalized, entry, `${entry.line}\n${value}`);
      else result.unresolved.push({ field_key: 'assignment_type', reason: 'assignment_print_purpose_unrecognized' });
    }
    if (/^Property Type$/i.test(entry.line)) add('property_type', value, value, entry, `${entry.line}\n${value}`);
    if (/^Address To$/i.test(entry.line)) {
      add('lender_client_name', value, value, entry, `${entry.line}\n${value}`, 'lender_name');
      const street = lines[entry.index + 2], locality = lines[entry.index + 3];
      if (/^\d+\s+[A-Za-z]/.test(street || '') && /^[A-Za-z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i.test(locality || '')) {
        add('lender_client_address', `${street}, ${locality}`, `${street}, ${locality}`, entry,
          `${entry.line}\n${value}\n${street}\n${locality}`, 'lender_address');
      }
    }
    if (/^(?:Lender|Client) Address$/i.test(entry.line)) {
      const continuation = lines[entry.index + 2];
      const full = /^\d+\s/.test(value) && /^[A-Za-z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i.test(continuation || '')
        ? `${value}, ${continuation}` : value;
      if (/^\d+\s+.+,\s*[A-Za-z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/i.test(full)) {
        add('lender_client_address', full, full, entry, `${entry.line}\n${full}`, 'lender_address');
      }
    }
  }
  return result;
}
