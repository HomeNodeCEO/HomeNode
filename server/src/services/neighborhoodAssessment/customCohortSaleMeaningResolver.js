import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { neighborhoodMemberSetDigest } from './assessmentRepository.js';
import { createCustomCohortDecisionEvidenceResolver } from './customCohortDecisionEvidence.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_SALE_MEANING_LIMITS = Object.freeze({ comparison_records: 1000, decimal_bytes: 256,
  text_bytes: 512, output_utf8_bytes: 32_768 });
const L = CUSTOM_COHORT_SALE_MEANING_LIMITS;
// This installed profile describes LOCAL stored columns, not a provider data
// dictionary. In particular CurrentPrice is not relabeled ClosePrice or USD.
const DEFINITION = freeze({ id: 'custom-local-sale-projection-v2-meaning', revision: '1', cached_mapping_version: 2,
  attribution: 'local_stored_observations', provider_meaning: 'not_established',
  fields: {
    source_close_date: ['date', 'Stored source-reported close date', null],
    sale_closing_date: ['date', 'Stored canonical closing date', null],
    source_current_price: ['nonnegative_decimal', 'Stored source current price; closing-price meaning unverified', null],
    sale_price: ['nonnegative_decimal', 'Stored canonical price; consideration and currency unverified', null],
    source_living_area: ['positive_decimal', 'Source-reported living-area magnitude; units and GLA at sale unverified', null],
    source_lot_size_area: ['nonnegative_decimal', 'Source-reported lot-area magnitude; units unverified', null],
    source_days_on_market: ['nonnegative_integer', 'Source-reported days on market; counting convention unverified', 'days'],
    source_year_built: ['year', 'Source-reported year built; historical applicability unverified', 'year'],
    source_structural_style: ['text', 'Recorded structural-style description', null],
    source_housing_type: ['text', 'Stored housing description; not a verified taxonomy', null],
    source_attachment_type: ['text', 'Stored attachment description; not a verified classification', null],
    record_type: ['text', 'Local record-type marker; not independent sale-completion evidence', null],
    primary_account_id: ['text', 'Source-associated account identity', null],
    sale_account_id: ['text', 'Canonical-associated account identity', null],
  },
  comparisons: { date: ['source_close_date', 'sale_closing_date'],
    price: ['source_current_price', 'sale_price'], account: ['primary_account_id', 'sale_account_id'] },
  comparison_policy: 'all_retained_rows_sharing_stored_canonical_sale_id_not_verified_equivalence',
  decimal_policy: 'retain_original_scale_compare_exact_nonnegative_plain_decimal',
  absent_policy: 'absent_sql_null_blank_invalid_are_distinct_no_coercion_or_fallback',
});
const definitionJson = json(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionJson);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionJson } });
export function getCustomSaleMeaningProfile() { return PROFILE; }
function fail(reason) {
  throw Object.assign(new TypeError(`custom_cohort_sale_meaning_${reason}`), { code: 'CUSTOM_COHORT_SALE_MEANING_INVALID', reason });
}
function check(ok, reason) { if (!ok) fail(reason); }
function decimal(raw, positive) {
  // Numeric SQL values were captured as text. Never reconstruct an exact money
  // value from an already rounded Number, formatted currency, or an exponent.
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > L.decimal_bytes
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.'), tail = fraction.replace(/0+$/, '');
  const exact = whole + (tail ? `.${tail}` : '');
  return positive && exact === '0' ? null : exact;
}
function field(raw, key) {
  const [kind, label, unit] = DEFINITION.fields[key], value = raw[key];
  const presence = !Object.hasOwn(raw, key) ? 'absent' : value === null ? 'sql_null'
    : typeof value === 'string' && value.trim() === '' ? 'blank' : 'present';
  const result = { label, unit, presence, status: presence === 'present' ? 'invalid' : 'missing',
    value: null, exact_decimal: null, reason: presence === 'present' ? 'invalid_stored_value' : presence };
  if (presence !== 'present') return result;
  let parsed = null, exact = null;
  if (kind.endsWith('_decimal')) {
    exact = decimal(value, kind === 'positive_decimal'); if (exact !== null) parsed = value;
  } else if (kind === 'date') {
    if (typeof value === 'string') { try { parsed = assessmentDate(value); } catch { /* invalid observation */ } }
  } else if (kind === 'text') {
    if (typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= L.text_bytes
      && !/[\u0000-\u001f\u007f]/.test(value)) parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
    && (kind === 'year' ? value >= 1600 && value <= 9999 : value >= 0)) parsed = value;
  if (parsed === null) return result;
  return { ...result, status: 'observed', value: parsed, exact_decimal: exact, reason: null };
}
function comparison(rows, keys) {
  const values = new Set(); let missing = 0, invalid = 0, observed = 0;
  for (const row of rows) for (const key of keys) {
    const item = field(row.data.raw_projection, key);
    if (item.status === 'missing') missing++;
    else if (item.status === 'invalid') invalid++;
    else { observed++; values.add(item.exact_decimal ?? item.value); }
  }
  const status = values.size > 1 ? 'conflicting' : !observed || missing || invalid ? 'incomplete' : 'agree';
  return { fields: keys, status, agreed_value: status === 'agree' ? [...values][0] : null,
    observed_field_count: observed, missing_field_count: missing, invalid_field_count: invalid,
    distinct_observed_value_count: values.size, agreement_is_independent_confirmation: false };
}

/** Internal owner-scoped interpretation of immutable captured records. No
 * supplied profile/flags, source queries, fallback price, verified facts,
 * eligibility decisions, workfile writes or report Apply are accepted here.
 */
export function createCustomCohortSaleMeaningResolver(preparationInput) {
  check(arguments.length === 1, 'arguments');
  const evidence = createCustomCohortDecisionEvidenceResolver(preparationInput);
  const candidates = new Map(), canonicalGroups = new Map();
  // Admission above checked the entire graph. Detach lightweight identities now
  // so mutation of the caller's input later cannot change comparison membership.
  for (const source of preparationInput.retained_inputs.acquisition.capture_result.source_capture.sources) {
    if (source.payload.projection.definition.role !== 'transactions') continue;
    for (const row of source.payload.records) {
      const canonicalId = row.data.data.canonical_transaction_id;
      const ref = evidence.deriveEvidenceRef(source.id, row.record_id);
      const entry = { ref, canonicalId };
      candidates.set(row.record_id, entry);
      if (canonicalId !== null) {
        if (!canonicalGroups.has(canonicalId)) canonicalGroups.set(canonicalId, []);
        canonicalGroups.get(canonicalId).push(entry);
      }
    }
  }
  function resolveMeaning(referenceJson) {
    check(arguments.length === 1, 'arguments');
    const requested = evidence.resolveEvidenceRef(referenceJson);
    check(requested.role === 'transactions', 'transactions_role_required');
    const entry = candidates.get(requested.record.record_id);
    const group = entry.canonicalId === null ? [entry] : canonicalGroups.get(entry.canonicalId);
    check(group.length <= L.comparison_records, 'comparison_record_limit');
    const rows = group.map(item => evidence.resolveEvidenceRef(JSON.stringify(item.ref)).record);
    for (const row of rows) check(row.data?.data?.cached_mapping_version === 2
      && row.data.data.cached_projection_kind === 'sale', 'unsupported_mapping_version');
    const raw = requested.record.data.raw_projection;
    const output = { meaning_version: 1, status: 'observations_only', authority: 'not_established',
      binding: evidence.binding, evidence_ref: requested.evidence_ref, candidate_key: requested.record.record_id,
      profile_ref: PROFILE.profile_ref, attribution: 'local_stored_observations',
      fields: Object.fromEntries(Object.keys(DEFINITION.fields).map(key => [key, field(raw, key)])),
      comparison_scope: { basis: DEFINITION.comparison_policy, canonical_transaction_id: entry.canonicalId,
        evaluated_record_count: rows.length, record_set_sha256: neighborhoodMemberSetDigest(rows.map(row => row.record_id)) },
      comparisons: Object.fromEntries(Object.entries(DEFINITION.comparisons).map(([key, fields]) => [key, comparison(rows, fields)])),
      unavailable: { provider_field_meaning: 'not_established', source_mls_status: 'not_retained_by_mapping_v2',
        source_revision_lineage: 'not_established_stable_row_hash_and_latest_file_hash_are_not_field_history',
        currency: 'not_established', source_area_units: 'not_established',
        historical_validity: 'not_established', gla_at_sale: 'not_established', housing_taxonomy: 'not_established',
        sale_completion: 'not_established', consideration_meaning: 'not_established',
        economic_property_membership: 'not_established', transaction_equivalence: 'not_established',
        market_eligibility: 'not_established' },
      assessment: null, apply: { status: 'blocked', reason: 'local_source_meaning_is_not_supported_fact_authority' } };
    check(Buffer.byteLength(json(output)) <= L.output_utf8_bytes, 'output_limit');
    return freeze(output);
  }
  return Object.freeze({ binding: evidence.binding, profile: PROFILE, deriveEvidenceRef: evidence.deriveEvidenceRef, resolveMeaning });
}
