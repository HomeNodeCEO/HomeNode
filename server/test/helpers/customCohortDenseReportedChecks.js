import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortIndexedObservationPreview, customCohortObservationMembers } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortSelectionCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography } from '../../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { buildCustomCohortReportedAssessmentBatched, buildCustomCohortReportedAssessmentWitnessV2Batched } from '../../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const REPORTED_TIMING_STAGES = Object.freeze(['builder_input_seal', 'builder_discovery_preview',
  'builder_catalog_and_selected_preview', 'builder_cad_population', 'builder_cad_metrics',
  'builder_shared_population', 'builder_assessment_contract', 'builder_publication_preparation', 'builder_candidate']);

// Test-only observer of the EXISTING check-before/check-after contract. It does
// not change production scheduling, skip verification or receive source values.
export function createDenseReportedStageObserver(emit, now = () => performance.now()) {
  assert.equal(typeof emit, 'function'); assert.equal(typeof now, 'function');
  let calls = 0, begin;
  return {
    check() {
      const timestamp = now(); assert.ok(Number.isFinite(timestamp));
      assert.ok(calls < REPORTED_TIMING_STAGES.length * 2, 'reported diagnostic stage layout changed');
      if (calls % 2 === 0) begin = timestamp;
      else emit({ name: REPORTED_TIMING_STAGES[Math.floor(calls / 2)], kind: 'synchronous_builder_interval',
        start_ms: begin, end_ms: timestamp, elapsed_ms: timestamp - begin });
      calls++;
    },
    complete() { assert.equal(calls, REPORTED_TIMING_STAGES.length * 2, 'reported diagnostic stage layout changed'); },
  };
}
const observed = (exact_value, unit) => ({ state: 'observed', exact_value, unit, reason: null });
const unavailable = (state, exact_value, reason) => ({ state, exact_value, unit: null, reason });
const BASE_RAW = { MlsStatus: ' Closed ', StandardStatus: 'Closed', CloseDate: '3/1/2024',
  ClosePrice: '300000.000000000001', ClosePriceCurrency: 'USD', CurrentPrice: '250000.000000000001', CurrentPriceCurrency: 'USD',
  LivingArea: '2000', LivingAreaUnits: 'Square Feet', LotSizeArea: '6000', LotSizeUnits: 'sqft', YearBuilt: '1999', DaysOnMarket: '12' };
const BASE_OBSERVATIONS = { reported_close_price: observed('300000.000000000001', 'USD'),
  reported_current_price: observed('250000.000000000001', 'USD'), reported_living_area: observed('2000', 'sqft'),
  reported_site_area: observed('6000', 'sqft'), reported_year_built: observed('1999', 'year'), reported_days_on_market: observed('12', 'days') };
const unitFields = ['ClosePriceCurrency', 'CurrentPriceCurrency', 'LivingAreaUnits', 'LotSizeUnits'];
const measurementFields = ['ClosePrice', 'CurrentPrice', 'LivingArea', 'LotSizeArea', 'YearBuilt', 'DaysOnMarket'];
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const firstFour = (state, reason) => Object.fromEntries(Object.entries(BASE_OBSERVATIONS).slice(0, 4)
  .map(([key, value]) => [key, unavailable(state, value.exact_value, reason)]));
const allMissing = reason => Object.fromEntries(Object.keys(BASE_OBSERVATIONS).map(key => [key, unavailable('missing', null, reason)]));

// Independent fixed expectation table, not output obtained from the interpreter
// being tested. All ten cases remain closed/in-period; unavailable measurements
// remain in the full source denominator. Repeated 103 times, never sampled.
const WITNESS_CASES = freeze([
  { id: 'explicit_imperial', raw: BASE_RAW, observations: BASE_OBSERVATIONS },
  { id: 'explicit_metric', raw: { ...BASE_RAW, ClosePrice: '300001.000000000001', CurrentPrice: '250001.000000000001',
    LivingArea: '180.5', LivingAreaUnits: 'Square Meters', LotSizeArea: '0.25', LotSizeUnits: 'Acres' },
  observations: { ...BASE_OBSERVATIONS, reported_close_price: observed('300001.000000000001', 'USD'),
    reported_current_price: observed('250001.000000000001', 'USD'), reported_living_area: observed('180.5', 'sqm'), reported_site_area: observed('0.25', 'acre') } },
  { id: 'values_absent_current_not_close', raw: { ...omit(BASE_RAW, measurementFields), CurrentPrice: '222222' },
    observations: { ...allMissing('raw_value_absent'), reported_current_price: observed('222222', 'USD') } },
  { id: 'metadata_absent', raw: omit(BASE_RAW, unitFields),
    observations: { ...BASE_OBSERVATIONS, ...firstFour('unsupported', 'raw_unit_missing') } },
  { id: 'metadata_blank', raw: { ...BASE_RAW, ...Object.fromEntries(unitFields.map(key => [key, '  '])) },
    observations: { ...BASE_OBSERVATIONS, ...firstFour('unsupported', 'raw_unit_missing') } },
  { id: 'generic_currency_conflict', raw: { ...BASE_RAW, Currency: 'CAD' }, observations: { ...BASE_OBSERVATIONS,
    reported_close_price: unavailable('conflicting', '300000.000000000001', 'raw_currency_conflict'),
    reported_current_price: unavailable('conflicting', '250000.000000000001', 'raw_currency_conflict') } },
  { id: 'generic_currency_not_field_scope', raw: { ...omit(BASE_RAW, unitFields.slice(0, 2)), Currency: 'USD', PriceCurrency: 'USD' },
    observations: { ...BASE_OBSERVATIONS, reported_close_price: unavailable('unsupported', '300000.000000000001', 'raw_unit_missing'),
      reported_current_price: unavailable('unsupported', '250000.000000000001', 'raw_unit_missing') } },
  { id: 'invalid_values', raw: { ...BASE_RAW, ClosePrice: '-1', CurrentPrice: '$1', LivingArea: '0', LotSizeArea: '-2', YearBuilt: '1599', DaysOnMarket: '1.5' },
    observations: Object.fromEntries(Object.keys(BASE_OBSERVATIONS).map(key => [key, unavailable('invalid', null, 'raw_value_invalid')])) },
  { id: 'values_blank', raw: { ...BASE_RAW, ...Object.fromEntries(measurementFields.map(key => [key, '  '])) }, observations: allMissing('raw_value_blank') },
  { id: 'unsupported_metadata', raw: { ...BASE_RAW, ClosePriceCurrency: 'CAD', CurrentPriceCurrency: 'EUR', LivingAreaUnits: 'Square Yards', LotSizeUnits: 'Hectares' },
    observations: { ...BASE_OBSERVATIONS, ...firstFour('unsupported', 'raw_unit_unsupported') } },
]);
export const denseWitness2FixtureCases = () => WITNESS_CASES;
export function assertDenseWitness2ObservationCase(observations, caseIndex) {
  assert.ok(Number.isInteger(caseIndex) && caseIndex >= 0 && caseIndex < WITNESS_CASES.length);
  assert.deepEqual(observations, WITNESS_CASES[caseIndex].observations);
}

// Only call on actual prepared/reopened originals. A caller mode or mapping5
// number is not an interpretation marker, and malformed presence never falls
// back to the old builder. Production admission remains owned by the loader.
export function denseReportedAssessmentBuilder(retained) {
  if (!Object.hasOwn(retained, 'reported_sale_interpretation')) return buildCustomCohortReportedAssessmentBatched;
  assert.deepEqual(retained.reported_sale_interpretation, getCustomCohortReportedSaleWitnessV2Profile().profile_ref);
  assert.equal(JSON.parse(retained.acquisition.compact_metadata_json).mapping_version, 5);
  return buildCustomCohortReportedAssessmentWitnessV2Batched;
}

export function checkDenseWitness2Capture(retained) {
  const profile = getCustomCohortReportedSaleWitnessV2Profile();
  assert.equal(denseReportedAssessmentBuilder(retained), buildCustomCohortReportedAssessmentWitnessV2Batched);
  assert.equal(retained.acquisition_intent.body.intent_version, 3);
  assert.deepEqual(retained.acquisition_intent.body.reported_sale_interpretation, profile.profile_ref);
  assert.equal(retained.acquisition_intent.reference.content_sha256, assessmentEvidenceDigest(retained.acquisition_intent.body));
  const accounts = retained.spatial.account_ids;
  assert.equal(accounts.length, 38_106);
  for (let index = 0; index < accounts.length; index++) assert.equal(accounts[index], `DENSE-${String(index).padStart(6, '0')}`);
  const seen = new Set(), caseCounts = Object.fromEntries(WITNESS_CASES.map(item => [item.id, 0]));
  const roleCounts = {}; let recordCount = 0;
  for (const source of retained.acquisition.capture_result.source_capture.sources) {
    recordCount += source.payload.records.length;
    const role = source.payload.projection.definition.role;
    roleCounts[role] = (roleCounts[role] ?? 0) + source.payload.records.length;
    if (role !== 'transactions') continue;
    for (const record of source.payload.records) {
      const { raw_projection: raw, data } = record.data;
      assert.equal(data.cached_mapping_version, 5);
      const sourceId = Number(raw.source_record_id), accountIndex = sourceId - 1, sourceIndex = accountIndex / 37;
      assert.ok(Number.isSafeInteger(sourceId) && Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < 1030);
      assert.equal(seen.has(sourceId), false); seen.add(sourceId);
      const fixture = WITNESS_CASES[sourceIndex % WITNESS_CASES.length]; caseCounts[fixture.id]++;
      assert.equal(raw.primary_account_id, accounts[accountIndex]);
      assert.equal(raw.source_current_price, String(250000 + accountIndex));
      assert.equal(raw.source_living_area, '9999'); assert.equal(raw.source_lot_size_area, '8888');
      assert.equal(raw.source_year_built, 1980); assert.equal(raw.source_days_on_market, 99);
      assert.equal(raw.source_mls_status, 'Active'); assert.equal(raw.source_row_number, sourceIndex + 2);
      assert.equal(raw.source_name, 'Synthetic combined witness capacity');
      assert.equal(raw.source_filename, 'dense-witness2-fixture.csv'); assert.equal(raw.source_sha256, 'c'.repeat(64));
      const witness = raw.source_raw_witness;
      assert.equal(witness.witness_version, 2); assert.equal(witness.root_state, 'object'); assert.equal(witness.root_json_type, 'object');
      assert.deepEqual(Object.keys(witness.fields).sort(), [...CACHED_SALE_WITNESS_V2_FIELDS].sort());
      for (const key of CACHED_SALE_WITNESS_V2_FIELDS) {
        const supplied = Object.hasOwn(fixture.raw, key), value = fixture.raw[key];
        assert.deepEqual(witness.fields[key], supplied
          ? { state: 'scalar', json_type: 'string', value_text: value, utf8_bytes: Buffer.byteLength(value) }
          : { state: 'absent', json_type: null, value_text: null, utf8_bytes: null });
      }
    }
  }
  assert.equal(seen.size, 1030); assert.equal(recordCount, 116_621);
  assert.deepEqual(roleCounts, { selection: 38_106, parcels: 38_347, accounts: 38_106, transactions: 1030, sale_links: 1030, gis_sync: 2 });
  for (const count of Object.values(caseCounts)) assert.equal(count, 103);
  return { mapping_version: 5, interpretation_profile_ref: profile.profile_ref, verified_source_records: seen.size,
    verified_witness_fields: seen.size * CACHED_SALE_WITNESS_V2_FIELDS.length, retained_records: recordCount,
    role_counts: roleCounts, case_counts: caseCounts };
}

function checkDenseWitness2Report(result, retained) {
  const profile = getCustomCohortReportedSaleWitnessV2Profile(), id = 'selected-shared-source-records';
  const source = result.publication_bundle.sources.find(item => item.snapshot.id === `${id}:observations`);
  assert.deepEqual(source.payload.interpretation, profile);
  assert.equal(source.snapshot.content_sha256, assessmentEvidenceDigest(source.payload));
  assert.deepEqual(source.payload.binding, result.binding);
  assert.equal(source.snapshot.historical_availability, 'unknown');
  assert.equal(result.assessment.diagnostics.authority, 'not_established');
  for (const [key, count] of Object.entries(source.payload.disposition_counts)) assert.equal(count, key === 'included' ? 1030 : 0);
  const originals = new Map();
  for (const chunk of retained.acquisition.capture_result.source_capture.sources) {
    if (!['transactions', 'sale_links'].includes(chunk.payload.projection.definition.role)) continue;
    for (const record of chunk.payload.records) {
      const sourceId = record.data.data.source_record_id;
      if (!originals.has(sourceId)) originals.set(sourceId, { refs: [], gaps: new Set() });
      const original = originals.get(sourceId);
      original.refs.push({ source_ref: chunk.id, record_id: record.record_id });
      for (const gap of record.data.capability_gaps) original.gaps.add(gap);
    }
  }
  const seen = new Set(), counts = Object.fromEntries(Object.keys(BASE_OBSERVATIONS).map(key => [key,
    Object.fromEntries(['observed', 'missing', 'invalid', 'conflicting', 'unsupported'].map(state => [`${state}_count`, 0]))]));
  for (const member of result.publication_bundle.members) {
    if (member.population_id !== id) continue;
    const data = member.member_data, index = (Number(data.source_record_id) - 1) / 37;
    assert.ok(Number.isInteger(index) && index >= 0 && index < 1030);
    assert.equal(seen.has(index), false); seen.add(index);
    assert.equal(member.member_id, `core.sales_source_records:${data.source_record_id}`);
    assert.deepEqual(member.account_ids, [`DENSE-${String(index * 37).padStart(6, '0')}`]);
    assert.equal(data.reported_close_date, '2024-03-01'); assert.equal(data.mapping_version, 5);
    assert.equal(data.observation_basis, 'same_payload_scalar_witness_reported_not_verified');
    // Original fixture links say is_resolved=true but retain no match_method.
    // Keep that existing resolution gap; field-specific price units cannot fix it.
    assert.equal(data.association_completeness, 'not_established'); assert.equal(data.unresolved_link_count, 1);
    assert.deepEqual(data.interpretation_profile_ref, profile.profile_ref);
    assertDenseWitness2ObservationCase(data.observations, index % WITNESS_CASES.length);
    const original = originals.get(data.source_record_id);
    assert.deepEqual(data.retained_source_references, original.refs.sort((a, b) =>
      a.source_ref < b.source_ref ? -1 : a.source_ref > b.source_ref ? 1 : a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
    assert.deepEqual(data.capability_gaps, [...original.gaps].sort());
    for (const [key, cell] of Object.entries(WITNESS_CASES[index % WITNESS_CASES.length].observations)) counts[key][`${cell.state}_count`]++;
  }
  assert.equal(seen.size, 1030);
  const values = {
    reported_close_price: ['USD', '300000.000000000001', '300000.500000000001', '300001.000000000001'],
    reported_current_price: ['USD', '222222', '250000.000000000001', '250001.000000000001'],
    reported_living_area: [null, null, null, null], reported_site_area: [null, null, null, null],
    reported_year_built: ['year', '1999', '1999', '1999'], reported_days_on_market: ['days', '12', '12', '12'],
  };
  for (const [key, [unit, ...estimates]] of Object.entries(values)) {
    assert.equal(Object.values(counts[key]).reduce((sum, n) => sum + n, 0), 1030);
    for (const [offset, name] of ['low', 'median', 'high'].entries()) {
      const statistic = result.assessment.statistics.find(item => item.id === `${id}:${key}:${name}`);
      assert.equal(statistic.denominator_count, 1030);
      for (const [field, value] of Object.entries(counts[key])) assert.equal(statistic[field], value);
      assert.equal(statistic.unit, unit); assert.equal(statistic.value, estimates[offset]);
      assert.equal(statistic.status, unit === null ? 'incomplete' : 'ready');
      assert.equal(statistic.reason, unit === null ? 'reported_unit_not_established' : null);
    }
  }
  return { verified_source_members: seen.size, interpretation_profile_ref: profile.profile_ref,
    measurement_counts: counts, retained_unresolved_link_count: 1030, mixed_area_units_pooled: false, typed_value_fallbacks: 0 };
}

/** Only called after the native fixture's local database identity, retained
 * hashes and complete source graph have been checked. No report writes. */
export async function checkDenseReportedPreparation({ retained, query, onDiagnostic }) {
  assert.ok(onDiagnostic === undefined || typeof onDiagnostic === 'function');
  const interval = (name, kind, begin) => {
    const end = performance.now(); onDiagnostic?.({ name, kind, start_ms: begin, end_ms: end, elapsed_ms: end - begin });
  };
  const captured = retained.acquisition.capture_result.captured_at;
  assert.equal(retained.subject.effective_date, captured.slice(0, 10), 'Requires a newly captured current-date fixture');
  assert.equal(retained.spatial.account_ids.length, 38_106);
  const records = retained.acquisition.capture_result.source_capture.sources.reduce((n, s) => n + s.payload.records.length, 0);
  assert.ok(records > 100_000, 'Exercise the dense retained graph, not only many group names');
  const context_ref = { context_id: randomUUID(), context_revision: '1', context_sha256: 'a'.repeat(64) };
  let mark = performance.now();
  const preview = buildCustomCohortIndexedObservationPreview({ context_ref, retained_inputs: retained,
    selection: { revision: 1, pockets: [] } });
  interval('helper_discovery_preview', 'synchronous_helper_interval', mark); mark = performance.now();
  const catalog = buildCustomCohortSelectionCatalog({ retained_inputs: retained, preview, catalog_version: 2 });
  interval('helper_catalog', 'synchronous_helper_interval', mark); mark = performance.now();
  assert.equal(catalog.catalog_complete, true); assert.equal(catalog.pockets.length, 887);
  const subject = retained.subject.target;
  const target = { scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(k => [k, subject[k]])),
    report_file_id: subject.report_file_id, custom_assignment_file_id: Number(subject.assignment_file_id), editor_revision: 0,
    effective_date: retained.subject.effective_date, data_cutoff: retained.subject.effective_date };
  const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    ...Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [`neighborhood_boundary_${side}`, `Synthetic ${side} outline`])) };
  const projected = JSON.stringify(saved), derived_at = new Date((await query("SELECT clock_timestamp() AS value")).rows[0].value).toISOString();
  const admission = prepareCustomCohortReportGeography({ target: { organization_id: subject.organization_id,
    report_file_id: subject.report_file_id, assignment_file_id: subject.assignment_file_id, account_id: subject.account_id },
    assignment_revision: 1, captured_at: derived_at, retained_subject: retained.subject,
    projection: { details_type: 'object', projected_utf8_bytes: Buffer.byteLength(projected),
      projected_sha256: createHash('sha256').update(projected).digest('hex'), projected_json: projected } });
  assert.equal(admission.status, 'awaiting_topology');
  const point = admission.subject_point_for_validation;
  const oracle = (await query(`WITH supplied AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::jsonb),4326) AS geom,
    ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326) AS point)
    SELECT ST_IsValid(geom) AS is_valid, ST_IsValidReason(geom) AS validation_reason,
      postgis_lib_version() AS postgis_version, ST_GeometryType(geom) AS geometry_type,
      ST_IsEmpty(geom) AS is_empty, ST_NumGeometries(geom) AS component_count,
      ST_Covers(geom,point) AS covers_recorded_subject_point, ST_Contains(geom,point) AS contains_recorded_subject_point
    FROM supplied`, [json(admission.geometry_for_validation), ...point.coordinates])).rows[0];
  assert.equal(oracle.is_valid, true); assert.equal(oracle.covers_recorded_subject_point, true);
  const geography = completeCustomCohortReportGeography(admission, oracle);
  interval('helper_geography', 'helper_interval_including_database_wait', mark);
  const selection = { revision: 1, included_recorded_group_ids: catalog.pockets.map(p => p.id) };
  if (catalog.unassigned.member_count) selection.included_recorded_group_ids.push('discovery:unassigned');
  const builder = denseReportedAssessmentBuilder(retained);
  const diagnostic = onDiagnostic ? createDenseReportedStageObserver(onDiagnostic) : null;
  mark = performance.now();
  const result = await builder({ context_ref, retained_inputs: retained, selection, target,
    preparation_identity: { assessment_id: randomUUID(), assessment_revision: 1, attachment_id: randomUUID(), attachment_revision: 1 },
    report_geography: geography, derived_at, catalog_version: 2 }, diagnostic ? { check: diagnostic.check } : undefined);
  diagnostic?.complete(); interval('helper_reported_builder_total', 'helper_interval_including_cooperative_wait', mark);
  mark = performance.now();
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.deepEqual(result.assessment.geographic_neighborhood.geometry, saved.neighborhood_boundary_geometry);
  assert.equal(result.assessment.selection.pocket_ids.length, 887);
  const cad = result.assessment.populations.find(p => p.id === 'selected-cad-accounts');
  const sales = result.assessment.populations.find(p => p.id === 'selected-shared-source-records');
  assert.equal(cad.member_count, 38_106); assert.equal(sales.member_count, 1_030);
  assert.equal(result.publication_bundle.members.length, 39_136);
  assert.ok(result.assessment.statistics.filter(s => s.population_id === cad.id).every(s => s.denominator_count === cad.member_count));
  assert.ok(result.assessment.statistics.filter(s => s.population_id === sales.id).every(s => s.denominator_count === sales.member_count));
  const originalRows = new Map(customCohortObservationMembers(preview, preview.all, 'stock').map(row => [row.account_id, row]));
  for (const member of result.publication_bundle.members.filter(m => m.population_id === cad.id)) {
    const original = originalRows.get(member.member_id), reference = member.member_data.retained_account_observation_reference;
    assert.ok(original); assert.equal(reference.retained_preview_member_sha256, assessmentEvidenceDigest(original));
    assert.equal(reference.representation_version, 1);
    for (const key of ['gla_sqft', 'site_area_sqft', 'year_built']) {
      assert.deepEqual(reference.observations[key], { state: original.observations[key].state,
        exact_value: original.observations[key].exact_value });
    }
  }
  interval('helper_account_reference_verification', 'synchronous_helper_interval', mark); mark = performance.now();
  const witnessChecks = builder === buildCustomCohortReportedAssessmentWitnessV2Batched ? checkDenseWitness2Report(result, retained) : null;
  interval('helper_witness_verification', 'synchronous_helper_interval', mark);
  return { groups: 887, accounts: cad.member_count, source_records: sales.member_count, retained_records: records,
    publication_members: result.publication_bundle.members.length, verified_account_references: originalRows.size,
    candidate: result.candidate.status, writes: 0, ...(witnessChecks ? { combined_evidence: witnessChecks } : {}) };
}
