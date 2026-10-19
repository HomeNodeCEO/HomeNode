import { isUrarPlaceholder } from '../util/urarScalarValidation.js';

const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
export function isTarrantCadSummary(pages) {
  return Array.isArray(pages) && pages.length <= 250 && pages.every(page => typeof page === 'string' && page.length <= 500_000)
    && pages.reduce((sum, page) => sum + page.length, 0) <= 4_000_000
    && /^Online Services\s*\|\s*Tarrant Appraisal District\s*$/m.test(pages[0] || '')
    && /Property Summary Report\s*\|\s*(?:Year\s+)?\d{4}/.test(pages[0] || '')
    && /^PID\s+\d{5,15}\s*\|/m.test(pages[0] || '');
}

/** True Prodigy's generated PDF stores all labels before their values in the
 * content stream. Use the printed label/value coordinates, not array order:
 * the next text after OWNER can be a Property ID, not an owner's name. */
export function buildTarrantCadSubjectEvidence(pages, textItems = []) {
  if (!isTarrantCadSummary(pages)) return null;
  const result = { schema_version: '2026-10-18-v1', source_kind: 'cad', source_layout: 'tarrant_cad_property_summary',
    review_required: true, candidates: [], conflicts: [], unresolved: [] };
  if (!Array.isArray(textItems) || textItems.length > 50_000) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  if (textItems.some(item => typeof item?.str === 'string' && compact(item.str)
    && (item.str.length > 4_000 || /[\u0000-\u001F\uFFFD]/u.test(item.str)
      || !Array.isArray(item.transform) || item.transform.length !== 6
      || !item.transform.every(Number.isFinite) || !Number.isFinite(item.width) || item.width < 0))) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  const items = textItems.filter(item => typeof item.str === 'string' && compact(item.str)
    && item.str.length <= 4_000 && Array.isArray(item.transform) && item.transform.length === 6
    && item.transform.every(Number.isFinite) && Number.isFinite(item.width))
    .map(item => ({ text: compact(item.str), x: item.transform[4], y: item.transform[5], width: item.width }));
  const headers = [...pages.join('\n').matchAll(/^PID\s+(\d{5,15})\s*\|/gm)];
  if (!headers.length || new Set(headers.map(match => match[1])).size !== 1) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  const pid = headers[0][1];
  const add = (key, value, evidence, pageNumber = 1) => {
    if (!value || value.length > 2_000 || isUrarPlaceholder(value)) return;
    result.candidates.push({ field_key: key, raw_value: value, normalized_value: value,
      page_number: pageNumber, confidence: 0.96, evidence_excerpt: evidence.slice(0, 2_000),
      extraction_method: 'urar_subject_cad_tarrant_property_summary_geometry', source_kind: 'cad', review_status: 'suggested' });
  };
  const ownerHeadings = items.filter(item => item.text === 'OWNER');
  const accountHeadings = items.filter(item => item.text === 'ACCOUNT');
  if (ownerHeadings.length !== 1 || accountHeadings.length !== 1 || ownerHeadings[0].x <= accountHeadings[0].x) {
    // A Values-only print can identify its PID, but cannot invent the missing
    // General Info, owner, location, or legal description from another source.
    add('assessor_parcel_number', pid, headers[0][0]);
    result.unresolved.push({ reason: 'tarrant_general_info_not_in_pdf' }); return result;
  }
  const divider = ownerHeadings[0].x;
  const read = (printedLabel, rightColumn = false) => {
    const labels = items.filter(item => item.text === printedLabel && (rightColumn ? item.x >= divider : item.x < divider));
    if (labels.length !== 1) return null;
    const source = labels[0], boundary = rightColumn ? Infinity : divider;
    const nextLabel = items.filter(item => Math.abs(item.x - source.x) <= 2 && item.y < source.y - 2
      && (/:$/.test(item.text) || /^[A-Z][A-Z ]+$/.test(item.text)))
      .reduce((highest, item) => Math.max(highest, item.y), -Infinity);
    if (!Number.isFinite(nextLabel)) return null;
    const valueItems = items.filter(item => item.x > source.x + source.width + 2 && item.x < boundary
      && item.y <= source.y + 2 && item.y > nextLabel + 2)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    if (!valueItems.length || valueItems.length > 12) return null;
    return { value: compact(valueItems.map(item => item.text).join(' ')), evidence: `${printedLabel} ${valueItems.map(item => item.text).join(' ')}` };
  };
  const propertyId = read('Property ID:');
  if (!propertyId || propertyId.value !== pid) {
    result.unresolved.push({ reason: 'source_input_incomplete' }); return result;
  }
  add('assessor_parcel_number', pid, propertyId.evidence);
  const owner = read('Name:', true);
  // A business name may legitimately start with digits. Require letters so a
  // numeric Property/Owner ID cannot become a name, not a letter-only prefix.
  if (owner && /[A-Za-z]/.test(owner.value)) add('owner_name', owner.value, `OWNER\n${owner.evidence}`);
  const legal = read('Legal Description:');
  if (legal) add('legal_description', legal.value, legal.evidence);
  if (legal && /\b(?:BLK|BLOCK)\s+[A-Za-z0-9-]+\b/i.test(legal.value) && /\b(?:LT|LOT)\s+[A-Za-z0-9-]+\b/i.test(legal.value)) {
    const name = legal.value.split(/\s+(?:BLK|BLOCK)\s+/i)[0];
    if (name && !/\b(?:ABSTRACT|SURVEY|TRACT|THENCE|BEGINNING)\b/i.test(name)) add('neighborhood_name', name, legal.evidence);
  }
  const location = read('Address:');
  const postal = location?.value.match(/^(.+),\s*([A-Za-z][A-Za-z .'-]*?)\s+(TX)\s+(\d{5}(?:-\d{4})?)$/i);
  if (postal) {
    add('subject_property_address', `${postal[1]}, ${postal[2]}, TX ${postal[4]}`, `LOCATION\n${location.evidence}`);
    for (const [key, value] of [['subject_street_address', postal[1]], ['subject_city', postal[2]],
      ['subject_state', 'TX'], ['subject_zip', postal[4]]]) add(key, value, `LOCATION\n${location.evidence}`);
  }
  // The provider's brand is not county evidence; the printed taxing unit is.
  const countyPage = pages.findIndex(page => /\b220\s+TARRANT COUNTY\s+/i.test(page));
  if (countyPage >= 0) add('county', 'Tarrant', 'TAXING UNITS\n220 TARRANT COUNTY', countyPage + 1);
  for (const key of ['owner_name', 'legal_description', 'subject_property_address']) {
    if (!result.candidates.some(candidate => candidate.field_key === key)) result.unresolved.push({ field_key: key, reason: 'tarrant_labeled_value_unavailable' });
  }
  return result;
}
