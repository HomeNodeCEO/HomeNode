import { parseStructuredAddress } from '../util/structuredAddress.js';
import { normalizePropertyCity } from '../util/propertySearch.js';
import { isUrarStateCode } from '../util/urarScalarValidation.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const identifier = value => text(value).toUpperCase().replace(/[\s-]/g, '');
const zip = value => text(value).match(/^\d{5}(?:-?\d{4})?$/)?.[0].slice(0, 5) || null;
const REVIEW_READY_STATUSES = new Set(['reviewed', 'review_required']);
const reviewReady = document => REVIEW_READY_STATUSES.has(document?.processing_status);

function confirmed(document, keys) {
  return (document.candidates || []).filter(candidate => candidate.review_status === 'confirmed'
    && (candidate.document_id == null || Number(candidate.document_id) === document.id)
    && keys.includes(candidate.field_key)).map(candidate => text(candidate.confirmed_value
      ?? candidate.normalized_value ?? candidate.raw_value)).filter(Boolean);
}

function postalAddress(value) {
  // Only a complete, explicitly delimited locality can be separated. Greedy
  // street capture retains comma-delimited unit/building/floor components.
  const full = value.match(/^(.+),\s*([A-Za-z][A-Za-z .'-]*),?\s+([A-Z]{2}|Texas)\s+(\d{5}(?:-\d{4})?)$/i);
  return full ? { street: text(full[1]), city: text(full[2]), state: /^Texas$/i.test(full[3]) ? 'TX' : full[3].toUpperCase(), postalCode: full[4] }
    : { street: value, city: null, state: null, postalCode: null };
}

function exactStreetIdentity(value) {
  const parsed = parseStructuredAddress(value);
  const unsegmented = parseStructuredAddress(value.replace(/,/g, ' '));
  const keys = ['house_number', 'street_key', 'unit_key', 'building_key', 'floor_key'];
  // The shared search parser deliberately removes punctuation from secondary
  // identifiers and ignores unrecognized comma tails. Neither behavior may
  // serve as proof that a PDF describes this subject property.
  const punctuatedSecondary = parsed.secondary_labels.some(label => new RegExp(
    `\\b${label}\\s+[A-Z0-9]*[-/][A-Z0-9/-]*\\b`,
  ).test(parsed.normalized_address));
  const ambiguous = punctuatedSecondary || keys.some(key => parsed[key] !== unsegmented[key]);
  return { ...parsed, ambiguous };
}

/** Confirm identity, not merely that a PDF was uploaded into this workfile.
 * Comparable MLS sheets can share the lender, city and neighborhood. Only exact
 * canonical street/unit plus locality, or the exact parcel ID, identifies subject.
 * Contradictory street/locality identity blocks export. A canonical county
 * snapshot plus exact street/unit, city AND ZIP can quarantine a PDF APN typo
 * without authorizing that contradictory APN as report evidence.
 */
export function sfrepDocumentPropertyRole(document) {
  // Reprocessing and failed extraction can leave previously confirmed rows in
  // place. Those stale candidates cannot authorize Subject identity or dates.
  if (!reviewReady(document)) return 'unknown';
  const context = document.subject_context;
  if (!context || typeof context !== 'object') return 'unknown';
  const canonicalAddress = postalAddress(text(context.address));
  const canonical = exactStreetIdentity(canonicalAddress.street);
  if (canonical.ambiguous) return 'unknown';
  const parcelValues = confirmed(document, ['assessor_parcel_number', 'assessors_parcel_number']);
  // A routed/canonical account key is not necessarily the county's printed
  // parcel number. Prefer the separately supplied county APN when available.
  const parcelId = identifier(context.assessorParcelNumber || context.accountId);
  const parcelMatch = Boolean(parcelId && parcelValues.some(value => identifier(value) === parcelId));
  const parcelMismatch = parcelValues.some(value => parcelId && identifier(value) !== parcelId);
  // A dated CAD record for the exact account can legitimately carry an older
  // situs address than the shared, continually refreshed account row. Keep it
  // assignment-scoped; other source families still require address agreement.
  const verifiedCad = document.document_type === 'other'
    && (document.extraction_summary?.urar_subject_evidence?.source_kind === 'cad'
      || document.candidates?.some(candidate => candidate.review_status === 'confirmed'
        && /^urar_subject_cad_/.test(String(candidate.extraction_method || ''))));
  if (verifiedCad
    && parcelMatch && !parcelMismatch) return 'subject';
  // A CAD record for a different APN is not the workfile's subject even if
  // its street happens to resemble the shared account address. In particular,
  // the old county-bound APN-typo exception must not promote its other fields.
  if (verifiedCad && parcelMismatch) return 'comparable';

  // Even a field labeled Street Address can contain a locality. Validate every
  // tail rather than letting the structured parser silently throw it away.
  const fullAddresses = confirmed(document, ['subject_property_address', 'subject_street_address']).map(postalAddress);
  const streets = fullAddresses.map(value => value.street);
  const cities = [...confirmed(document, ['subject_city']), ...fullAddresses.map(value => value.city).filter(Boolean)];
  const states = [...confirmed(document, ['subject_state']), ...fullAddresses.map(value => value.state).filter(Boolean)]
    .map(value => text(value).toUpperCase());
  const postcodes = [...confirmed(document, ['subject_zip', 'subject_zip_code']), ...fullAddresses.map(value => value.postalCode).filter(Boolean)];
  const canonicalCity = normalizePropertyCity(context.city || canonicalAddress.city);
  const countyState = isUrarStateCode(context.canonicalIdentity?.state) ? context.canonicalIdentity.state : null;
  const canonicalState = text(context.state || countyState || canonicalAddress.state).toUpperCase();
  const canonicalZip = zip(context.postalCode || canonicalAddress.postalCode);
  if (canonicalCity && cities.some(value => normalizePropertyCity(value) !== canonicalCity)) return 'comparable';
  if (canonicalState && states.some(value => value !== canonicalState)) return 'comparable';
  if (!canonicalState && new Set(states).size > 1) return 'unknown';
  if (postcodes.some(value => !zip(value))) return 'unknown';
  if (canonicalZip && postcodes.some(value => zip(value) && zip(value) !== canonicalZip)) return 'comparable';
  let streetMatch = false;
  for (const street of streets) {
    const parsed = exactStreetIdentity(street);
    if (parsed.ambiguous) return 'unknown';
    if (!canonical.house_number || !parsed.house_number) continue;
    if (['base_address_key', 'unit_key', 'building_key', 'floor_key'].some(key => parsed[key] !== canonical[key])) return 'comparable';
    streetMatch = true;
  }
  const localityMatch = (canonicalCity && cities.some(value => normalizePropertyCity(value) === canonicalCity))
    || (canonicalZip && postcodes.some(value => zip(value) === canonicalZip));
  if (parcelMismatch) {
    const county = context.canonicalIdentity;
    const countyBound = county && county.accountId === context.accountId
      && county.assessorParcelNumber === context.accountId
      && county.address === context.address && county.city === context.city && county.postalCode === context.postalCode;
    return countyBound && streetMatch && canonicalCity && canonicalZip
      && cities.some(value => normalizePropertyCity(value) === canonicalCity)
      && postcodes.some(value => zip(value) === canonicalZip) ? 'subject' : 'comparable';
  }
  return parcelMatch || (streetMatch && localityMatch) ? 'subject' : 'unknown';
}

/** Diagnostic/quarantine only. This never proves document applicability. */
export function sfrepDocumentParcelMismatch(document) {
  const context = document?.subject_context;
  const parcelId = identifier(context?.assessorParcelNumber || context?.accountId);
  return Boolean(parcelId && confirmed(document, ['assessor_parcel_number', 'assessors_parcel_number'])
    .some(value => identifier(value) !== parcelId));
}

function workfileCadIdentity(document) {
  if (document.document_type !== 'other' || !reviewReady(document)
    || !(document.extraction_summary?.urar_subject_evidence?.source_kind === 'cad'
      || document.candidates?.some(candidate => candidate.review_status === 'confirmed'
        && /^urar_subject_cad_/.test(String(candidate.extraction_method || ''))))
    || sfrepDocumentPropertyRole(document) !== 'subject') return null;
  const parcelId = identifier(document.subject_context?.assessorParcelNumber || document.subject_context?.accountId);
  const apns = confirmed(document, ['assessor_parcel_number', 'assessors_parcel_number']);
  if (!parcelId || !apns.length || apns.some(value => identifier(value) !== parcelId)) return null;
  const full = confirmed(document, ['subject_property_address']).map(postalAddress);
  const streets = [...confirmed(document, ['subject_street_address']), ...full.map(value => value.street)];
  const cities = [...confirmed(document, ['subject_city']), ...full.map(value => value.city).filter(Boolean)];
  const zips = [...confirmed(document, ['subject_zip', 'subject_zip_code']), ...full.map(value => value.postalCode).filter(Boolean)];
  const states = [...confirmed(document, ['subject_state']), ...full.map(value => value.state).filter(Boolean)];
  if (new Set(streets.map(value => exactStreetIdentity(value).base_address_key)).size !== 1
    || new Set(cities.map(normalizePropertyCity)).size > 1 || new Set(zips.map(zip)).size > 1
    || new Set(states.map(value => value.toUpperCase())).size > 1) return null;
  const address = streets[0], city = cities[0] || null, postalCode = zips[0] || null, state = states[0] || null;
  if (!address || !city || exactStreetIdentity(address).ambiguous) return null;
  return { address, city, postalCode, state };
}

/** Bind other workfile documents to one reviewed CAD identity when the shared
 * account address has changed. This is in-memory role proof, not a database
 * update. Conflicting CAD records cannot establish a common identity. */
export function sfrepWorkfileDocumentRoles(documents) {
  const candidates = documents.map(workfileCadIdentity).filter(Boolean);
  const identities = new Set(candidates.map(value => JSON.stringify({ street: exactStreetIdentity(value.address).base_address_key,
    city: normalizePropertyCity(value.city), zip: zip(value.postalCode), state: value.state?.toUpperCase() || null })));
  const cad = identities.size === 1 ? candidates[0] : null;
  return documents.map(document => {
    const context = document.subject_context;
    const forRole = cad && context
      ? { ...document, subject_context: { ...context, address: cad.address, city: cad.city,
        postalCode: cad.postalCode, state: cad.state || context.state,
        canonicalIdentity: { ...context.canonicalIdentity, state: cad.state || context.canonicalIdentity?.state } } }
      : document;
    return { ...document, property_role: sfrepDocumentPropertyRole(forRole) };
  });
}

export function sfrepSubjectContext(documents) {
  const context = documents[0]?.subject_context;
  const empty = { effectiveDate: null, effectiveDateSource: null, effectiveDateSourceDocumentId: null, feeSimpleDefault: true };
  if (!context) return empty;
  // Dates come from the exact assignment's appraisal case, never an engagement's
  // contract date or another appraisal of the same property. A real saved
  // effective date takes priority (including retrospective assignments).
  if (context.effectiveDate) return { ...empty, effectiveDate: context.effectiveDate, effectiveDateSource: 'assignment_effective_date' };
  if (context.inspectionDate) return { ...empty, effectiveDate: context.inspectionDate, effectiveDateSource: 'inspection_date' };
  const uploads = documents.filter(document => reviewReady(document) && document.property_role === 'subject'
    && typeof document.upload_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(document.upload_date))
    .sort((left, right) => left.upload_date.localeCompare(right.upload_date) || left.id - right.id);
  const first = uploads[0];
  return first ? { ...empty, effectiveDate: first.upload_date,
    effectiveDateSource: 'document_upload_date_placeholder', effectiveDateSourceDocumentId: first.id } : empty;
}
