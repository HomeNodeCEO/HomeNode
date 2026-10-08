import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS } from './cohortOriginalSourceChainV1.js';
import { scanOriginalJsonText } from './originalJsonTokens.js';
import { getCustomCohortReportedSaleWitnessV2Profile, interpretCustomCohortReportedSaleWitnessV2 }
  from './customCohortReportedSaleWitnessV2.js';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(reason) { throw new TypeError(`neighborhood_frozen_typed_original_${reason}`); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
// Fixed fields from frozen-original format 1, not a new provider dictionary.
// Decimal fields were retained as SQL text BEFORE JSON/Node could round them.
const FIELDS = freeze({
  parcels: {
    reported_year_built: ['residential_year_built', 'year', 'year', 'integer'],
    reported_residential_area: ['residential_area_sqft', 'positive', 'reported_sqft', 'text'],
    reported_site_area: ['parcel_area_sqft', 'nonnegative', 'reported_sqft', 'text'],
    reported_market_value: ['current_market_value', 'nonnegative', null, 'text'],
  },
  source_records: {
    normalized_living_area: ['living_area', 'positive', null, 'text'],
    normalized_site_area: ['lot_size_area', 'nonnegative', null, 'text'],
    normalized_year_built: ['year_built', 'year', 'year', 'integer'],
    normalized_bedrooms: ['bedrooms_total', 'integer', 'bedrooms', 'integer'],
    normalized_bathrooms_total: ['bathrooms_total_integer', 'integer', 'bathrooms', 'integer'],
    normalized_full_bathrooms: ['bathrooms_full', 'integer', 'bathrooms', 'integer'],
    normalized_half_bathrooms: ['bathrooms_half', 'integer', 'half_bathrooms', 'integer'],
    normalized_garage_spaces: ['garage_spaces', 'nonnegative', 'spaces', 'text'],
    normalized_days_on_market: ['days_on_market', 'integer', 'days', 'integer'],
    normalized_current_price: ['current_price', 'nonnegative', null, 'text'],
  },
  sales: { recorded_sale_price: ['sale_price', 'nonnegative', null, 'text'] },
});
const DATE_FIELDS = freeze({ source_records: ['close_date', 'listing_contract_date'], sales: ['closing_date'] });
const MARKERS = freeze({
  parcels: ['subdivision_name', 'land_use_category', 'class_code', 'class_description', 'use_description', 'structure_type', 'built_up'],
  accounts: ['county', 'subdivision', 'neighborhood_code'],
  source_records: ['record_type', 'mls_status', 'housing_type', 'attachment_type', 'structural_style', 'architectural_style',
    'garage_yn', 'pool_yn', 'match_status', 'multi_parcel_status', 'has_unresolved_parcel', 'requires_additional_review'],
  sales: ['source'], sale_links: ['source_position', 'parcel_sequence', 'parcel_role', 'is_resolved', 'match_method'],
  sync_state: ['status', 'source_vintage', 'last_run_id', 'last_success_at', 'last_source_update_at'],
  sync_runs: ['source_key', 'mode', 'status', 'started_at', 'completed_at'],
});
export const NEIGHBORHOOD_FROZEN_TYPED_ORIGINAL_V1_LIMITS = Object.freeze({
  original_utf8_bytes: 1_000_000, output_utf8_bytes: 65_536, raw_literal_utf8_bytes: 128,
  numeric_token_characters: 128, canonical_digits: 30, fractional_digits: 12, integer_max: 2_147_483_647,
});
const L = NEIGHBORHOOD_FROZEN_TYPED_ORIGINAL_V1_LIMITS;
const DEFINITION = freeze({
  id: 'neighborhood-frozen-typed-original-v1', revision: '1', frozen_source_format: 1,
  authority: 'not_established', scope: 'one_exact_original_row_not_a_property_or_transaction',
  fields: FIELDS, date_fields: DATE_FIELDS, markers: MARKERS, limits: L,
  numeric: { grammar: '^\\+?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$', canonicalization: 'exact_decimal_strings_no_float',
    missing: ['absent', 'json_null', 'blank_string'], unavailable: 'oversize_literal',
    forbidden: ['negative_including_negative_zero', 'exponent', 'currency_symbols', 'commas', 'floating_point_conversion'],
    integer_policy: 'nonnegative_int32', year_policy: 'integer_1600_through_effective_date_year',
    units: 'only_fixed_field_labels_no_measurement_standard_or_currency_inference',
    unspecified_unit: 'unsupported_with_exact_numeric_retained_not_aggregation_eligible',
    raw_numeric_json: 'exact_original_number_tokens_only_known_integer_fields_int32_other_number_types_invalid' },
  date: { grammar: 'YYYY-MM-DD', calendar: 'Gregorian', future: 'preserve_then_caller_period_filter',
    no_timestamp_or_loaded_at_fallback: true },
  markers_policy: 'bounded_literal_diagnostics_no_inferred_builder_phase_zoning_freshness_or_use',
  provenance: 'original_payload_text_sha256_and_exact_native_kind_row_key',
  reported_sale_witness: { interpretation_profile_ref: getCustomCohortReportedSaleWitnessV2Profile().profile_ref,
    exact_definition_blob: getCustomCohortReportedSaleWitnessV2Profile().definition_blob,
    missing_or_null_witness: 'reject_not_absent_fields', use: 'pure_single_witness_interpretation_only',
    caller_dense_capabilities: 'not_accepted_not_minted_not_widened' },
  aggregation: 'none_no_cross_row_resolution_or_price_allocation',
  limitations: ['not_verified_GLA_at_sale', 'not_historical_CAD_stock', 'not_source_freshness', 'not_economic_property_equivalence',
    'missing_CAD_improvement_amenity_lineage', 'no_source_license_or_acquisition_receipt', 'no_statistics_or_report_update'],
});
const profileText = canonicalAssessmentJson(DEFINITION), profileBlob = prepareNeighborhoodCohortBlob(profileText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: profileBlob.content_sha256 },
  definition_blob: { ref: profileBlob, canonical_json: profileText } });
export function getNeighborhoodFrozenTypedOriginalV1Profile() { return PROFILE; }

function literal(payload, field, tokens, original) {
  const node = tokens.get(field);
  if (!node) return { state: 'absent', json_type: null, value_text: null, utf8_bytes: 0, value_sha256: null };
  const type = node.kind;
  if (type === 'null') return { state: 'json_null', json_type: type, value_text: null, utf8_bytes: 0, value_sha256: null };
  // A numeric token is sliced from the original, NEVER stringified from the
  // JSON.parse result. Wrong-type decimal evidence remains exact as well.
  const text = type === 'string' ? payload[field] : original.slice(node.start, node.end), bytes = Buffer.byteLength(text);
  return { state: ['string', 'number', 'boolean'].includes(type) ? bytes > L.raw_literal_utf8_bytes ? 'oversize' : 'scalar' : 'non_scalar',
    json_type: type, value_text: bytes <= L.raw_literal_utf8_bytes ? text : null, utf8_bytes: bytes, value_sha256: sha(text) };
}
function decimal(text, policy, year) {
  const token = text.trim();
  if (token.length > L.numeric_token_characters || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return null;
  let [whole, fraction = ''] = token.replace(/^\+/, '').split('.');
  whole = whole.replace(/^0+/, '') || '0'; fraction = fraction.replace(/0+$/, '');
  if (whole.length + fraction.length > L.canonical_digits || fraction.length > L.fractional_digits
    || policy === 'positive' && whole === '0' && !fraction
    || ['integer', 'year'].includes(policy) && (fraction || BigInt(whole) > BigInt(L.integer_max))
    || policy === 'year' && (BigInt(whole) < 1600n || BigInt(whole) > year)) return null;
  return whole + (fraction ? `.${fraction}` : '');
}
function numeric(raw, policy, unit, encoding, year) {
  const cell = (state, exact_value, reason) => ({ state, exact_value, unit: state === 'observed' ? unit : null, reason, raw });
  if (['absent', 'json_null'].includes(raw.state) || raw.state === 'scalar' && raw.json_type === 'string' && !raw.value_text.trim())
    return cell('missing', null, `raw_value_${raw.state === 'scalar' ? 'blank' : raw.state}`);
  if (raw.state === 'oversize') return cell('unsupported', null, 'raw_value_oversize');
  if (raw.state !== 'scalar' || (encoding === 'text' ? raw.json_type !== 'string' : raw.json_type !== 'number'))
    return cell('invalid', null, 'raw_value_type_invalid');
  const exact = decimal(raw.value_text, policy, year);
  return exact === null ? cell('invalid', null, 'raw_value_invalid')
    : unit === null ? cell('unsupported', exact, 'unit_not_established') : cell('observed', exact, null);
}
function date(raw) {
  const result = (state, exact_value, reason) => ({ state, exact_value, reason, raw });
  if (['absent', 'json_null'].includes(raw.state) || raw.state === 'scalar' && raw.json_type === 'string' && !raw.value_text.trim())
    return result('missing', null, 'missing_date');
  if (raw.state === 'oversize') return result('unsupported', null, 'unsupported_date');
  const token = raw.state === 'scalar' && raw.json_type === 'string' ? raw.value_text.trim() : '';
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(token) || token.startsWith('0000')) return result('invalid', null, 'invalid_date');
  try { assessmentDate(token); } catch { return result('invalid', null, 'invalid_date'); }
  return result('observed', token, null);
}
function account(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 64 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail('identity_mismatch');
  return value;
}
/** Interpret one retained row. No SQL, authorization, spatial discovery,
 * dense acquisition capability, whole-population statistics or side effects.
 * The job owner must independently verify the graph/geography/identity first.
 */
export function compileNeighborhoodFrozenTypedOriginalV1(value) {
  const input = data(value, ['kind', 'row_key', 'payload_text', 'effective_date']);
  if (!KINDS.includes(input.kind) || typeof input.row_key !== 'string' || !input.row_key || Buffer.byteLength(input.row_key) > 256
    || /[\u0000-\u001f\u007f]/.test(input.row_key) || typeof input.payload_text !== 'string'
    || Buffer.byteLength(input.payload_text) > L.original_utf8_bytes) fail('invalid_input');
  const effective = assessmentDate(input.effective_date), kind = input.kind;
  let payload, index; try { index = scanOriginalJsonText(input.payload_text, 'index').index; payload = JSON.parse(input.payload_text); }
  catch { fail('invalid_original'); }
  if (index.nodes[0].kind !== 'object') fail('invalid_original');
  const tokens = new Map(index.nodes[0].members.map(member => [member.key, index.nodes[member.value]]));
  const raw = field => literal(payload, field, tokens, input.payload_text);
  const idField = kind === 'parcels' ? 'object_id' : kind === 'accounts' ? 'account_id' : kind === 'sync_state' ? 'source_key' : 'id';
  if (payload[idField] !== input.row_key) fail('identity_mismatch');
  const accountId = ['parcels', 'accounts', 'sales', 'sale_links'].includes(kind) ? account(payload.account_id)
    : kind === 'source_records' ? account(payload.primary_account_id) : null;
  const sourceId = kind === 'source_records' ? payload.id : ['sales', 'sale_links'].includes(kind) ? payload.source_record_id : null;
  if (sourceId !== null && (typeof sourceId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(sourceId) || BigInt(sourceId) > 9223372036854775807n)) fail('identity_mismatch');
  if (kind === 'source_records') {
    const witness = tokens.get('source_raw_witness');
    if (!witness || witness.kind !== 'object') fail('witness_unavailable');
    try { scanOriginalJsonText(input.payload_text.slice(witness.start, witness.end), 'full_value'); } catch { fail('invalid_witness'); }
  }
  const result = { typed_original_version: 1, interpretation_profile_ref: PROFILE.profile_ref, effective_date: effective,
    original: { kind, row_key: input.row_key, payload_sha256: sha(input.payload_text), payload_utf8_bytes: Buffer.byteLength(input.payload_text) },
    account_id: accountId, source_record_id: sourceId,
    observations: Object.fromEntries(Object.entries(FIELDS[kind] ?? {}).map(([key, [field, policy, unit, encoding]]) =>
      [key, numeric(raw(field), policy, unit, encoding, BigInt(effective.slice(0, 4)))])),
    dates: Object.fromEntries((DATE_FIELDS[kind] ?? []).map(field => [field, date(raw(field))])),
    markers: Object.fromEntries(MARKERS[kind].map(field => [field, raw(field)])),
    same_payload_reported_sale: kind === 'source_records' ? interpretCustomCohortReportedSaleWitnessV2(payload.source_raw_witness, effective) : null,
    authority: 'not_established', coverage: 'one_original_only', source_freshness: 'not_established' };
  if (Buffer.byteLength(canonicalAssessmentJson(result)) > L.output_utf8_bytes) fail('output_limit');
  return freeze(result);
}
