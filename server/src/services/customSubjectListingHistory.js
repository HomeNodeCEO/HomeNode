// Pure projection of current, individually reviewed subject evidence. The
// fixed wording is intentional: incomplete facts must not become a different
// narrative, guessed DOM, or a claim that equal LP/OLP proves no price changes.
import { sfrepDocumentPropertyRole } from './sfrepSubjectContext.js';
import { isUrarStateCode } from '../util/urarScalarValidation.js';

const READY = new Set(['reviewed', 'review_required']);
const SHEET_FIELDS = ['list_date', 'original_list_price', 'days_on_market'];
const ownRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => ['string', 'number'].includes(typeof value) && /^\d+$/.test(String(value))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const valueOf = candidate => candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
const scalar = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const warning = reason => ({ warnings: [`Listing history: ${reason}`] });

function calendarDate(value) {
  const match = scalar(value)?.match(/^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})\/(\d{4}))$/);
  if (!match) return null;
  const [year, month, day] = (match[1] ? match.slice(1, 4) : [match[6], match[4], match[5]]).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

function recordedTimestamp(value) {
  // Matrix prints a local calendar date and minute, not a timezone. Preserve
  // that precision without guessing a timezone or allowing Date rollover.
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  return match && calendarDate(match[1]) === match[1] && Number(match[2]) <= 23 && Number(match[3]) <= 59 ? value : null;
}

function money(value) {
  const match = scalar(value)?.match(/^\$?\s*(\d{1,10}|\d{1,3}(?:,\d{3}){1,3})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = match[1].replaceAll(',', '').replace(/^0+(?=\d)/, '');
  if (whole.length > 10) return null;
  const amount = `${whole}.${(match[2] || '').padEnd(2, '0')}`;
  return BigInt(amount.replace('.', '')) > 0n ? amount : null;
}

const cents = value => BigInt(value.replace('.', ''));
const usd = value => {
  const [whole, fraction] = value.split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === '00' ? '' : `.${fraction}`}`;
};
const usDate = value => `${value.slice(5, 7)}/${value.slice(8)}/${value.slice(0, 4)}`;
const mlsId = value => {
  const text = scalar(value);
  return text && /^[A-Z0-9][A-Z0-9-]{2,44}$/i.test(text) && !/^(?:unknown|pending|null|none|unavailable|tbd)$/i.test(text)
    ? text.toUpperCase() : null;
};
const dom = value => {
  const text = scalar(value);
  return text && /^\d{1,5}$/.test(text) ? String(Number(text)) : null;
};

function entries(document, key) {
  return document.candidates.filter(candidate => candidate?.review_status === 'confirmed' && candidate.field_key === key
    && positiveId(candidate.id) && (candidate.document_id == null || positiveId(candidate.document_id) === Number(document.id)))
    .map(candidate => ({ documentId: Number(document.id), candidateId: Number(candidate.id), sourceField: key, value: valueOf(candidate) }));
}

function unique(entries, normalize) {
  const normalized = entries.map(entry => normalize(entry.value));
  if (!normalized.length || normalized.some(value => value === null)) return null;
  const options = [...new Set(normalized)];
  return options.length === 1 ? options[0] : null;
}

function parseHistory(entry) {
  if (typeof entry.value !== 'string' || entry.value.length > 8_000) return null;
  let source;
  try { source = JSON.parse(entry.value); } catch { return null; }
  if (!ownRecord(source) || source.schema_version !== 1 || !mlsId(source.listing_id)
    || !['complete', 'partial'].includes(source.coverage) || !Array.isArray(source.price_changes) || source.price_changes.length > 500) return null;
  const changes = [];
  for (const row of source.price_changes) {
    if (!ownRecord(row)) return null;
    const date = calendarDate(row.date), previous = money(row.previous_price), next = money(row.new_price);
    if (!date || !previous || !next) return null;
    const recordedAt = Object.hasOwn(row, 'recorded_at') ? recordedTimestamp(row.recorded_at) : null;
    const changeDate = Object.hasOwn(row, 'change_date') ? calendarDate(row.change_date) : null;
    if ((Object.hasOwn(row, 'recorded_at') && !recordedAt) || (Object.hasOwn(row, 'change_date') && !changeDate)
      || (recordedAt && changeDate && recordedAt.slice(0, 10) !== changeDate)) return null;
    changes.push({ date, previous_price: previous, new_price: next, recordedAt });
  }
  changes.sort((a, b) => compare(a.date, b.date) || compare(a.recordedAt || '', b.recordedAt || ''));
  for (let index = 1; index < changes.length; index += 1) {
    const previous = changes[index - 1], current = changes[index];
    // Older payloads remain usable on distinct effective dates. On the same
    // date, every change needs a distinct, validated printed timestamp; array
    // position and even an apparently connected price chain cannot prove order.
    if (previous.date === current.date && (!previous.recordedAt || !current.recordedAt || previous.recordedAt === current.recordedAt)) return null;
  }
  return { listingId: mlsId(source.listing_id), listDate: calendarDate(source.list_date), coverage: source.coverage,
    propertyAddress: typeof source.property_address === 'string' ? source.property_address : null,
    // Timestamp proof stays in sourceEvidence's untouched reviewed JSON. Compare
    // the proven ordered price facts so equivalent old/new histories can agree.
    changes: changes.map(({ recordedAt, ...row }) => row) };
}

function historyAddressMatchesSubject(history, document, subjectSheets) {
  if (!history.propertyAddress || history.propertyAddress.length > 1_000 || /[\u0000-\u001f\u007f]/.test(history.propertyAddress)) return false;
  const address = history.propertyAddress.trim().replace(/\s+/g, ' ');
  // Matrix's history header lacks delimiters between street and city. The only
  // split allowed is its exact canonical city suffix, followed optionally by a
  // printed state/ZIP. This is not a general fuzzy address/name match.
  return subjectSheets.length > 0 && subjectSheets.every(sheet => {
    const context = sheet.subject_context;
    const city = typeof context?.city === 'string' ? context.city.trim().replace(/\s+/g, ' ') : '';
    if (!city || !context?.address) return false;
    const escapedCity = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = address.match(new RegExp(`^(.+?)[, ]+(${escapedCity})(?:[, ]+([A-Z]{2}|Texas)(?: +([0-9]{5}(?:-[0-9]{4})?))?)?$`, 'i'));
    if (!match || !/^\d/.test(match[1])) return false;
    const canonicalState = isUrarStateCode(context.state) ? context.state.toUpperCase()
      : unique(entries(sheet, 'subject_state'), value => isUrarStateCode(scalar(value)) ? scalar(value).toUpperCase() : null);
    if (match[3] && (!canonicalState || canonicalState !== (/^Texas$/i.test(match[3]) ? 'TX' : match[3].toUpperCase()))) return false;
    const supplied = [
      ['subject_street_address', match[1]], ['subject_city', match[2]],
      ...(match[3] ? [['subject_state', /^Texas$/i.test(match[3]) ? 'TX' : match[3]]] : []),
      ...(match[4] ? [['subject_zip', match[4]]] : []),
    ].map(([field_key, value]) => ({ field_key, confirmed_value: value, review_status: 'confirmed', document_id: Number(document.id) }));
    // Retain original reviewed identities in this comparison so a contradictory
    // parcel, street, unit, city or ZIP cannot be overridden by the JSON header.
    // This temporary comparison never promotes the document or its other fields.
    return sfrepDocumentPropertyRole({ ...document, id: Number(document.id), subject_context: { ...context, state: canonicalState },
      candidates: [...document.candidates, ...supplied] }) === 'subject';
  });
}

/** Caller supplies assignment-scoped documents whose property_role has already
 * been independently established. This function never reads unreviewed fields,
 * extracts text, reaches into another file, or mutates the saved appraisal. */
export function buildCustomSubjectListingHistory(documents = [], subjectContext = {}) {
  if (!Array.isArray(documents) || documents.length > 50 || documents.some(document => !ownRecord(document)
    || !positiveId(document.id) || !Array.isArray(document.candidates) || document.candidates.length > 200)
    || new Set(documents.map(document => Number(document.id))).size !== documents.length) {
    return warning('source evidence exceeds supported bounds or is malformed.');
  }
  const ready = documents.filter(document => document.property_role === 'subject' && READY.has(document.processing_status));
  const sheets = ready.filter(document => document.document_type === 'mls_sheet'
    && SHEET_FIELDS.some(field => entries(document, field).length));
  if (!sheets.length) return { warnings: [] };
  const effectiveDate = calendarDate(subjectContext?.effectiveDate);
  if (!effectiveDate) return warning('confirm the appraisal effective date before generating the listing summary.');
  const contractEntries = ready.filter(document => document.document_type === 'purchase_contract')
    .flatMap(document => entries(document, 'contract_date'));
  const contractDate = unique(contractEntries, calendarDate);
  if (!contractDate || contractDate > effectiveDate) return warning('one valid reviewed subject contract date on or before the effective date is required.');

  const groups = new Map();
  for (const document of sheets) {
    const ids = entries(document, 'mls_number'), id = unique(ids, mlsId);
    if (!id) return warning('a subject MLS sheet has a missing or conflicting listing number.');
    if (!groups.has(id)) groups.set(id, { id, documents: [], evidence: [], values: Object.fromEntries(SHEET_FIELDS.map(key => [key, []])) });
    const group = groups.get(id);
    group.documents.push(document);
    group.evidence.push(...ids);
    for (const key of SHEET_FIELDS) group.values[key].push(...entries(document, key));
  }
  const possible = [];
  for (const group of groups.values()) {
    const listDate = unique(group.values.list_date, calendarDate);
    if (!listDate) return warning('the reviewed subject listing dates are missing or conflicting.');
    if (listDate <= contractDate) possible.push({ ...group, listDate });
  }
  possible.sort((a, b) => compare(b.listDate, a.listDate));
  const chosen = possible[0];
  if (!chosen || possible[1]?.listDate === chosen.listDate) return warning('the current MLS listing cannot be determined uniquely before the contract date.');
  const originalPrice = unique(chosen.values.original_list_price, money), daysOnMarket = unique(chosen.values.days_on_market, dom);
  if (!originalPrice || daysOnMarket === null) return warning('one reviewed original list price and MLS days-on-market value are required.');

  const historyEntries = documents.filter(document => READY.has(document.processing_status)
    && ['subject', 'unknown'].includes(document.property_role) && ['mls_sheet', 'other'].includes(document.document_type))
    .flatMap(document => entries(document, 'listing_price_history').map(entry => ({ entry, document })));
  const matching = [];
  for (const { entry, document } of historyEntries) {
    const history = parseHistory(entry);
    if (!history) return warning('reviewed listing-history data is malformed or has ambiguous event order.');
    if (history.listingId !== chosen.id) continue;
    const explicitIds = entries(document, 'mls_number');
    if (explicitIds.length && unique(explicitIds, mlsId) !== chosen.id) return warning('the history listing number conflicts with its reviewed MLS identity.');
    if (document.property_role === 'unknown' && !historyAddressMatchesSubject(history, document, chosen.documents)) {
      return warning('the matching MLS history also needs an exact subject street and city match.');
    }
    if (document.property_role === 'subject' && history.propertyAddress && chosen.documents.some(sheet => sheet.subject_context)
      && !historyAddressMatchesSubject(history, document, chosen.documents)) {
      return warning('the history property address conflicts with the verified subject.');
    }
    if (history.coverage !== 'complete' || history.listDate !== chosen.listDate) {
      return warning('complete history for the matching MLS number and initial listing date is required.');
    }
    // Retrospective analysis uses the event's effective date, not the report's
    // later download date. Post-contract changes never rewrite this narrative.
    const changes = history.changes.filter(row => row.date <= contractDate && row.date <= effectiveDate);
    if (changes.some(row => row.date < chosen.listDate)) return warning('a price change predates the initial listing date.');
    let previous = originalPrice;
    for (const row of changes) {
      if (row.previous_price !== previous) return warning('the reviewed price-change chain does not match the original list price.');
      previous = row.new_price;
    }
    matching.push({ entry, changes, identityEvidence: explicitIds });
  }
  if (!matching.length) return warning('upload and review complete history for the matching MLS number before stating whether prices were reduced.');
  if (new Set(matching.map(history => JSON.stringify(history.changes))).size !== 1) return warning('reviewed histories disagree about the current listing price changes.');
  const changes = matching[0].changes;
  const reductions = changes.filter(row => cents(row.new_price) < cents(row.previous_price));
  if (reductions.length && changes.some(row => cents(row.new_price) > cents(row.previous_price))) {
    return warning('mixed price increases and reductions need appraiser review before using the fixed reduction wording.');
  }
  const priceHistory = reductions.length
    ? `the price was reduced ${reductions.length} times between ${usDate(reductions[0].date)} and ${usDate(reductions.at(-1).date)} to ${usd(reductions.at(-1).new_price)}`
    : 'no reductions in list price';
  const value = `Subject was listed on ${usDate(chosen.listDate)} for ${usd(originalPrice)}, ${priceHistory}, on the market for ${daysOnMarket} days, under current contract on ${usDate(contractDate)}`;
  const sourceEvidence = [...chosen.evidence, ...SHEET_FIELDS.flatMap(key => chosen.values[key]), ...contractEntries,
    ...matching.flatMap(history => [history.entry, ...history.identityEvidence])]
    .filter((entry, index, all) => all.findIndex(other => other.documentId === entry.documentId && other.candidateId === entry.candidateId) === index)
    .sort((a, b) => a.documentId - b.documentId || a.candidateId - b.candidateId || compare(a.sourceField, b.sourceField));
  const anchor = sourceEvidence.find(entry => entry.sourceField === 'list_date');
  return { field: { key: 'listing_history_summary', value,
    provenance: { kind: 'derived_reviewed_document', sourceField: 'listing_history_summary',
      documentId: anchor.documentId, candidateId: anchor.candidateId, documentType: 'mls_sheet',
      rule: 'reviewed_subject_listing_history_template_v1', effectiveDate,
      effectiveDateSource: subjectContext.effectiveDateSource ?? null,
      effectiveDateSourceDocumentId: subjectContext.effectiveDateSourceDocumentId ?? null, sourceEvidence },
    sourceValue: JSON.stringify({ effectiveDate, sourceEvidence }),
  }, warnings: [] };
}
