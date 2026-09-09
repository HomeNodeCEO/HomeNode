import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortDecisionEvidenceResolver } from './customCohortDecisionEvidence.js';
import { CACHED_SALE_WITNESS_FIELDS, prepareCachedSaleWitness } from './cachedSaleWitness.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_SALE_WITNESS_MEANING_LIMITS = Object.freeze({ decimal_utf8_bytes: 256,
  typed_scalar_utf8_bytes: 512, output_utf8_bytes: 65_536 });
const L = CUSTOM_COHORT_SALE_WITNESS_MEANING_LIMITS;

// Installed local-column/literal vocabulary only, deliberately separate from
// the unchanged v2 profile. These kinds describe syntax, not provider semantics.
const DEFINITION = freeze({ id: 'custom-local-sale-witness-v3-meaning', revision: '1', cached_mapping_version: 3,
  witness_version: 1, attribution: 'local_stored_observations', provider_meaning: 'not_established',
  witness_fields: {
    MlsStatus: 'text', StandardStatus: 'text', CloseDate: 'date',
    ClosePrice: 'nonnegative_decimal', CurrentPrice: 'nonnegative_decimal', ListPrice: 'nonnegative_decimal',
    OriginalListPrice: 'nonnegative_decimal', Currency: 'text', LivingArea: 'positive_decimal', LivingAreaUnits: 'text',
    AboveGradeFinishedArea: 'nonnegative_decimal', AboveGradeFinishedAreaUnits: 'text',
    LotSizeArea: 'nonnegative_decimal', LotSizeUnits: 'text', LotSizeSquareFeet: 'nonnegative_decimal',
    LotSizeAcres: 'nonnegative_decimal', DaysOnMarket: 'nonnegative_integer', CumulativeDaysOnMarket: 'nonnegative_integer',
    YearBuilt: 'year', StructuralStyle: 'text', PropertyType: 'text', PropertySubType: 'text', StructureType: 'text',
    PropertyAttachedYN: 'boolean', ListingKey: 'text', ListingId: 'text', OriginatingSystemName: 'text', ModificationTimestamp: 'text',
  },
  typed_fields: {
    source_close_date: 'date', sale_closing_date: 'date', source_current_price: 'nonnegative_decimal',
    sale_price: 'nonnegative_decimal', source_living_area: 'positive_decimal', source_lot_size_area: 'nonnegative_decimal',
    source_days_on_market: 'nonnegative_integer', source_year_built: 'year', source_structural_style: 'text',
    source_housing_type: 'text', source_attachment_type: 'text', record_type: 'text', primary_account_id: 'text',
    sale_account_id: 'text', source_mls_status: 'text', source_row_number: 'stored_int32',
  },
  pairs: {
    source_current_price_raw_current_price: ['source_current_price', 'CurrentPrice'],
    canonical_sale_price_raw_close_price: ['sale_price', 'ClosePrice'],
    source_mls_status_raw_mls_status: ['source_mls_status', 'MlsStatus'],
    source_close_date_raw_close_date: ['source_close_date', 'CloseDate'],
    canonical_closing_date_raw_close_date: ['sale_closing_date', 'CloseDate'],
    source_living_area_raw_living_area: ['source_living_area', 'LivingArea'],
    source_lot_size_area_raw_lot_size_area: ['source_lot_size_area', 'LotSizeArea'],
    source_days_on_market_raw_days_on_market: ['source_days_on_market', 'DaysOnMarket'],
    source_year_built_raw_year_built: ['source_year_built', 'YearBuilt'],
    source_structural_style_raw_structural_style: ['source_structural_style', 'StructuralStyle'],
  },
  comparison_policy: 'explicit_pairs_in_one_exact_retained_record_not_independent_confirmation',
  decimal_policy: 'bounded_plain_nonnegative_decimal_text_preserve_scale_compare_without_float_coercion',
  text_policy: 'literal_case_and_whitespace_no_aliases_no_taxonomy_mapping',
  date_policy: 'exact_valid_calendar_date_no_timestamp_or_timezone_inference',
  unavailable_policy: 'preserve_witness_state_type_literal_and_byte_count_no_null_blank_or_zero_fallback',
  limitations: ['stored_jsonb_scalar_text_not_original_file_bytes', 'typed_columns_may_precede_stored_payload_revision',
    'field_name_or_agreement_does_not_establish_provider_meaning', 'no_default_currency_or_area_units',
    'no_sale_completion_historical_gla_market_eligibility_or_fact_authority'],
  limits: L,
});
const definitionJson = json(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionJson);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionJson } });
export function getCustomSaleWitnessMeaningProfile() { return PROFILE; }
function fail(reason) {
  throw Object.assign(new TypeError(`custom_cohort_sale_witness_meaning_${reason}`), {
    code: 'CUSTOM_COHORT_SALE_WITNESS_MEANING_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }

function decimal(text, positive) {
  if (Buffer.byteLength(text) > L.decimal_utf8_bytes || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.'), tail = fraction.replace(/0+$/, '');
  const exact = whole + (tail ? `.${tail}` : '');
  return positive && exact === '0' ? null : exact;
}
function interpreted(kind, presence, type, text) {
  const result = { kind, presence, status: 'unavailable', reason: presence, exact_decimal: null };
  if (presence !== 'present') return result;
  let valid = false, exact = null;
  if (kind === 'text') valid = type === 'string' && !/[\u0000-\u001f\u007f]/.test(text);
  else if (kind === 'boolean') valid = type === 'boolean';
  else if (kind === 'date' && type === 'string') {
    try { assessmentDate(text); valid = true; } catch { /* literal stays retained, not a usable date */ }
  } else if (['string', 'number'].includes(type)) {
    if (kind.endsWith('_decimal')) { exact = decimal(text, kind === 'positive_decimal'); valid = exact !== null; }
    else if (kind === 'nonnegative_integer') {
      valid = Buffer.byteLength(text) <= L.decimal_utf8_bytes && /^(?:0|[1-9][0-9]*)$/.test(text);
      if (valid) exact = text;
    } else if (kind === 'year') valid = /^[1-9][0-9]{3}$/.test(text) && text >= '1600' && text <= '9999';
    else if (kind === 'stored_int32') valid = type === 'number'; // mapper already checks exact SQL int32, including zero/negative
  }
  return { ...result, status: valid ? 'observed' : 'invalid', reason: valid ? null : 'invalid_local_literal', exact_decimal: exact };
}
function witnessInterpretation(cell, kind) {
  const presence = cell.state === 'scalar' ? cell.json_type === 'string' && cell.value_text.trim() === '' ? 'blank' : 'present' : cell.state;
  return interpreted(kind, presence, cell.json_type, cell.value_text);
}
function typedField(raw, key, kind) {
  const value = raw[key], present = Object.hasOwn(raw, key);
  const type = !present || value === null ? null : Array.isArray(value) ? 'array' : typeof value;
  let presence = !present ? 'absent' : value === null ? 'sql_null'
    : ['string', 'number', 'boolean'].includes(type) ? 'present' : 'non_scalar';
  let literal = null;
  if (presence === 'present') {
    const text = String(value);
    if (Buffer.byteLength(text) > L.typed_scalar_utf8_bytes) presence = 'oversize';
    else {
      literal = { type, value_text: text, utf8_bytes: Buffer.byteLength(text) };
      if (type === 'string' && value.trim() === '') presence = 'blank';
    }
  }
  let interpretation = interpreted(kind, presence, type, literal?.value_text ?? null);
  // SQL numeric columns are captured as text. A JS Number or an integer string
  // in a typed integer column is not substituted for the retained SQL type.
  const typeMismatch = kind.endsWith('_decimal') ? type !== 'string'
    : ['nonnegative_integer', 'year', 'stored_int32'].includes(kind)
      ? type !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) : false;
  if (presence === 'present' && typeMismatch) interpretation = { ...interpretation, status: 'invalid',
    reason: 'invalid_stored_type', exact_decimal: null };
  return { ...interpretation, stored_type: type, literal };
}
function compare(typed, cell, observation, pair) {
  const both = [typed, observation], observed = both.filter(item => item.status === 'observed').length;
  const invalid = both.filter(item => item.status === 'invalid').length, missing = 2 - observed - invalid;
  const key = (item, text) => item.exact_decimal ?? text;
  const agreed = observed === 2 && key(typed, typed.literal.value_text) === key(observation, cell.value_text);
  return { typed_field: pair[0], witness_field: pair[1],
    status: observed === 2 ? agreed ? 'agree' : 'conflicting' : 'incomplete',
    comparison_basis: typed.kind.endsWith('_decimal') || typed.kind === 'nonnegative_integer' ? 'exact_numeric_magnitude' : 'exact_literal_text',
    observed_field_count: observed, invalid_field_count: invalid, unavailable_field_count: missing,
    agreement_is_independent_confirmation: false, establishes_provider_meaning: false };
}

/** Internal, owner-loaded evidence only. The existing resolver checks the whole
 * retained graph and exact seven-part record reference before interpretation.
 * This module neither reads live source rows nor accepts profiles/authority flags.
 */
export function createCustomCohortSaleWitnessMeaningResolver(preparationInput) {
  check(arguments.length === 1, 'arguments');
  const evidence = createCustomCohortDecisionEvidenceResolver(preparationInput);
  // Admission has checked data-only objects and content bindings, so this read
  // cannot execute caller accessors. Do not relabel a v2 graph to gain a witness.
  const compact = JSON.parse(preparationInput.retained_inputs.acquisition.compact_metadata_json);
  check(compact.mapping_version === 3, 'mapping3_required');

  function resolveMeaning(referenceJson) {
    check(arguments.length === 1, 'arguments');
    const requested = evidence.resolveEvidenceRef(referenceJson), mapped = requested.record.data;
    check(requested.role === 'transactions', 'transactions_role_required');
    check(mapped.data.cached_mapping_version === 3 && mapped.data.cached_projection_kind === 'sale', 'mapping3_required');
    const raw = mapped.raw_projection, sourceAvailable = mapped.data.source_record_id !== null;
    const witness = sourceAvailable ? prepareCachedSaleWitness(raw.source_raw_witness) : null;
    const typed = Object.fromEntries(Object.entries(DEFINITION.typed_fields).map(([key, kind]) => [key, typedField(raw, key, kind)]));
    const observations = Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key, witness
      ? witnessInterpretation(witness.fields[key], DEFINITION.witness_fields[key])
      : interpreted(DEFINITION.witness_fields[key], 'source_record_unavailable', null, null)]));
    const comparisons = Object.fromEntries(Object.entries(DEFINITION.pairs).map(([name, pair]) => [name,
      compare(typed[pair[0]], witness?.fields[pair[1]] ?? null, observations[pair[1]], pair)]));
    const output = { meaning_version: 1, cached_mapping_version: 3, status: 'observations_only', authority: 'not_established',
      binding: evidence.binding, evidence_ref: requested.evidence_ref, candidate_key: requested.record.record_id,
      profile_ref: PROFILE.profile_ref, attribution: 'local_stored_observations',
      witness_status: sourceAvailable ? 'retained' : 'source_record_unavailable', witness,
      witness_interpretations: observations, typed_fields: typed,
      comparison_scope: { basis: DEFINITION.comparison_policy, evaluated_record_count: 1 }, comparisons,
      unavailable: { provider_field_meaning: 'not_established', original_file_bytes: 'not_retained_by_scalar_witness',
        source_revision_lineage: 'not_established_typed_columns_may_precede_stored_payload_revision',
        currency: 'not_established', source_area_units: 'not_established', historical_validity: 'not_established',
        gla_at_sale: 'not_established', housing_taxonomy: 'not_established', sale_completion: 'not_established',
        consideration_meaning: 'not_established', economic_property_membership: 'not_established',
        transaction_equivalence: 'not_established', market_eligibility: 'not_established' },
      assessment: null, apply: { status: 'blocked', reason: 'local_source_meaning_is_not_supported_fact_authority' } };
    check(Buffer.byteLength(json(output)) <= L.output_utf8_bytes, 'output_limit');
    return freeze(output);
  }
  return Object.freeze({ binding: evidence.binding, profile: PROFILE, deriveEvidenceRef: evidence.deriveEvidenceRef, resolveMeaning });
}
