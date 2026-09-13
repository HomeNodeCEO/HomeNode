import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCustomCohortReportedAssessment as legacy,
  buildCustomCohortReportedAssessmentBatched as legacyBatched,
  buildCustomCohortReportedAssessmentWitnessV2 as build,
  buildCustomCohortReportedAssessmentWitnessV2Batched as buildBatched } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography } from '../src/services/neighborhoodAssessment/customCohortReportGeography.js';
import { neighborhoodMemberContentDigest, neighborhoodMemberSetDigest,
  prepareNeighborhoodPublication } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { canonicalAssessmentJson as canonical, assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const sharedId = 'selected-shared-source-records';
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const uuid = n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
const payload = (overrides = {}) => ({ MlsStatus: 'Closed', CloseDate: '2024-03-01',
  ClosePrice: '9007199254740993.000000000001', ClosePriceCurrency: 'USD', CurrentPrice: '299999', CurrentPriceCurrency: 'USD',
  LivingArea: '180.5', LivingAreaUnits: 'Square Meters', LotSizeArea: '0.25', LotSizeUnits: 'Acres',
  YearBuilt: '1999', DaysOnMarket: '12', ...overrides });
const extra = (number, overrides = {}) => ({ source_record_id: String(10 + number), sale_id: String(20 + number),
  primary_account_id: '0000123456789', sale_account_id: '0000123456789', source_record_hash: 'c'.repeat(64),
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  source_current_price: '1000', sale_price: '2000', source_living_area: '2000', source_year_built: 2001,
  source_days_on_market: 99, ...overrides });

// Genuine opt-in source acquisition/prepare/persist/reopen under the existing
// bounded query fake. Geography uses the actual process-local admission API and
// an explicitly synthetic oracle, not a native PostGIS/provider/owner test.
async function fixture({ effectiveDate = '2026-09-06', emptySelection = false, geographyChanges = {}, oracleChanges = {},
  mappingVersion = 5, ...captureOptions } = {}) {
  const capture = await cadEvidenceFixture({ assignmentFileId: '41', effectiveDate, mappingVersion,
    ...(mappingVersion === 5 ? { rawPayload: payload() } : {}), ...captureOptions });
  const retained = capture.input.retained_inputs, subject = retained.subject.target;
  assert.equal(subject.assignment_file_id, '41', 'numeric report identity was chosen before original capture');
  const target = { scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .map(key => [key, subject[key]])), report_file_id: subject.report_file_id, custom_assignment_file_id: 41,
    editor_revision: 0, effective_date: effectiveDate, data_cutoff: effectiveDate };
  const derivedAt = '2026-09-06T16:00:00.000Z';
  const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    neighborhood_boundary_north: 'Synthetic north', neighborhood_boundary_east: 'Synthetic east',
    neighborhood_boundary_south: 'Synthetic south', neighborhood_boundary_west: 'Synthetic west', ...geographyChanges };
  const projected = JSON.stringify(saved), admitted = prepareCustomCohortReportGeography({
    target: { organization_id: subject.organization_id, report_file_id: subject.report_file_id,
      assignment_file_id: subject.assignment_file_id, account_id: subject.account_id }, assignment_revision: 1,
    projection: { details_type: 'object', projected_utf8_bytes: Buffer.byteLength(projected),
      projected_sha256: hash(projected), projected_json: projected }, captured_at: derivedAt, retained_subject: retained.subject,
  });
  const geography = completeCustomCohortReportGeography(admitted, admitted.geometry_for_validation ? {
    is_valid: true, validation_reason: 'Synthetic oracle only', postgis_version: 'synthetic-only',
    geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
    covers_recorded_subject_point: true, contains_recorded_subject_point: true, ...oracleChanges,
  } : null);
  const groupIds = [...capture.catalog.pockets.map(pocket => pocket.id),
    ...(capture.catalog.unassigned.member_count ? ['discovery:unassigned'] : [])];
  assert.equal(capture.catalog.catalog_complete, true);
  return { capture, input: { context_ref: capture.input.expected.context_ref, retained_inputs: retained,
    selection: { revision: 1, included_recorded_group_ids: emptySelection ? [] : groupIds }, target,
    preparation_identity: { assessment_id: uuid(1), assessment_revision: 1, attachment_id: uuid(2), attachment_revision: 1 },
    report_geography: geography, derived_at: derivedAt } };
}
const statistic = (result, measurement, estimator = 'median') => result.assessment.statistics
  .find(row => row.id === `${sharedId}:${measurement}:${estimator}`);
const sharedSource = result => result.publication_bundle.sources.find(source => source.snapshot.id === `${sharedId}:observations`);
const sharedMembers = result => result.publication_bundle.members.filter(member => member.population_id === sharedId);
const publicationSources = result => result.publication_bundle.sources.map(source => ({ id: source.snapshot.id, payload: source.payload }));
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}

test('original mapping5 witness units become exact reported statistics only through the explicit entry point', async () => {
  const { input } = await fixture(), before = JSON.stringify(input), result = build(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(result.assessment.contract_version, 2);
  assert.equal(result.assessment.methodology.configuration.profile_id, 'custom-reported-observations-v2');
  for (const [measurement, value, unit] of [
    ['reported_close_price', '9007199254740993.000000000001', 'USD'],
    ['reported_current_price', '299999', 'USD'], ['reported_living_area', '180.5', 'sqm'],
    ['reported_site_area', '0.25', 'acre'], ['reported_year_built', '1999', 'year'], ['reported_days_on_market', '12', 'days'],
  ]) {
    const stat = statistic(result, measurement);
    assert.equal(stat.status, 'ready'); assert.equal(stat.reason, null);
    assert.equal(stat.value, value); assert.equal(stat.unit, unit);
    assert.equal(stat.observed_count, 1); assert.equal(stat.denominator_count, 1);
  }
  assert.deepEqual(result.assessment.geographic_neighborhood.geometry, input.report_geography.geometry);
  assert.equal(result.assessment.diagnostics.authority, 'not_established');
  assert.ok(result.assessment.diagnostics.limitations.includes('reported_observations_not_verified_market_facts'));
  assert.equal(JSON.stringify(input), before); frozen(result);
});

test('exact interpretation definition and profile are retained inside source evidence and member digests', async () => {
  const { input } = await fixture(), result = build(input), source = sharedSource(result);
  const profile = getCustomCohortReportedSaleWitnessV2Profile(), members = sharedMembers(result);
  assert.deepEqual(source.payload.interpretation, profile);
  assert.equal(profile.definition_blob.ref.content_sha256, hash(profile.definition_blob.canonical_json));
  assert.equal(profile.definition_blob.ref.canonical_utf8_bytes, String(Buffer.byteLength(profile.definition_blob.canonical_json)));
  assert.equal(profile.profile_ref.content_sha256, profile.definition_blob.ref.content_sha256);
  assert.deepEqual(JSON.parse(profile.definition_blob.canonical_json).fields.reported_close_price,
    { value_field: 'ClosePrice', unit_field: 'ClosePriceCurrency', policy: 'nonnegative', units: ['USD'] });
  assert.equal(source.snapshot.content_sha256, digest(source.payload));
  assert.deepEqual(source.payload.binding, result.binding);
  assert.deepEqual(result.binding.context_ref, input.context_ref);
  assert.equal(result.binding.selected_account_set_sha256, neighborhoodMemberSetDigest(input.retained_inputs.spatial.account_ids));
  assert.deepEqual(source.snapshot.scope, input.target.scope);
  assert.equal(source.snapshot.visibility, 'assignment');
  assert.equal(source.snapshot.historical_availability, 'unknown');
  const population = result.assessment.populations.find(population => population.id === sharedId);
  assert.equal(population.capture_source_ref, source.snapshot.id);
  assert.equal(population.member_set_sha256, neighborhoodMemberSetDigest(members.map(member => member.member_id)));
  const memberCapture = result.publication_bundle.sources.find(item => item.snapshot.id === `${sharedId}:members`);
  assert.equal(memberCapture.payload.member_content_sha256, neighborhoodMemberContentDigest(members,
    { contract_version: 2, profile_id: result.assessment.methodology.configuration.profile_id }));
  for (const member of members) {
    assert.deepEqual(member.member_data.interpretation_profile_ref, profile.profile_ref);
    assert.deepEqual(member.member_data.source_refs, [source.snapshot.id]);
    assert.equal(member.member_data.observation_basis, 'same_payload_scalar_witness_reported_not_verified');
    assert.deepEqual(member.account_ids, ['0000123456789', 'R-LINKED-ONLY']);
    assert.ok(member.member_data.retained_source_references.length >= 2);
  }
  for (const stat of result.assessment.statistics.filter(stat => stat.population_id === sharedId)) {
    assert.deepEqual(stat.source_refs, population.source_refs);
    assert.equal(stat.denominator_count, members.length);
  }
  for (const item of result.publication_bundle.sources) {
    assert.equal(item.snapshot.content_sha256, digest(item.payload));
    assert.deepEqual(result.assessment.source_snapshots.find(snapshot => snapshot.id === item.snapshot.id), item.snapshot);
  }
  assert.deepEqual(prepareNeighborhoodPublication(result.assessment, result.publication_bundle.members, publicationSources(result)),
    result.publication_bundle);
});

test('publication refuses altered interpretation evidence or altered member meanings against their original digests', async () => {
  const result = build((await fixture()).input);
  for (const mutate of [
    source => { source.payload.interpretation.profile_ref.content_sha256 = 'f'.repeat(64); },
    source => { source.payload.interpretation.definition_blob.canonical_json += ' '; },
  ]) {
    const sources = structuredClone(publicationSources(result));
    mutate(sources.find(source => source.id === `${sharedId}:observations`));
    assert.throws(() => prepareNeighborhoodPublication(result.assessment, result.publication_bundle.members, sources), /source_content_mismatch/);
  }
  for (const mutate of [
    member => { member.member_data.interpretation_profile_ref.content_sha256 = 'f'.repeat(64); },
    member => { member.member_data.observations.reported_close_price.exact_value = '1'; },
  ]) {
    const members = structuredClone(result.publication_bundle.members);
    mutate(members.find(member => member.population_id === sharedId));
    assert.throws(() => prepareNeighborhoodPublication(result.assessment, members, publicationSources(result)), /member_content_mismatch/);
  }
});

test('sync and cooperative explicit report entry points produce identical complete canonical output', async () => {
  const { input } = await fixture({ extraTransactions: [extra(1)], saleWitnessesBySourceId: {
    '11': { rawPayload: payload({ ClosePrice: '9007199254740993.000000000002' }) },
  } }), before = JSON.stringify(input);
  const sync = build(input), cooperative = await buildBatched(input);
  assert.equal(statistic(sync, 'reported_close_price').value, '9007199254740993.0000000000015');
  assert.deepEqual(cooperative, sync); assert.equal(canonical(cooperative), canonical(sync));
  assert.equal(JSON.stringify(input), before); frozen(cooperative);
});

test('cooperative entry seals descendants before yielding and services other work without altering geography admission', async () => {
  const { input } = await fixture(), expected = build(input), mutable = structuredClone(input);
  // Completed geography is an opaque process-local capability, not cloneable proof.
  mutable.report_geography = input.report_geography; Object.freeze(mutable);
  const pending = buildBatched(mutable);
  assert.ok(Object.isFrozen(mutable.selection.included_recorded_group_ids));
  const sourceRow = mutable.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(source => source.payload.projection.definition.role === 'transactions').payload.records[0];
  assert.ok(Object.isFrozen(sourceRow.data.raw_projection.source_raw_witness.fields.ClosePrice));
  assert.throws(() => { sourceRow.data.raw_projection.source_raw_witness.fields.ClosePrice.value_text = '1'; }, TypeError);
  assert.throws(() => mutable.selection.included_recorded_group_ids.pop(), TypeError);
  let serviced = false; setImmediate(() => { serviced = true; });
  assert.deepEqual(await pending, expected); assert.equal(serviced, true);
  assert.equal(mutable.report_geography, input.report_geography);
});

test('cooperative cancellation at every check returns the exact error and no partial report', async () => {
  const { input } = await fixture(), cancellation = new Error('synthetic report preparation cancelled');
  let checks = 0; const expected = await buildBatched(input, { check() { checks++; } });
  assert.ok(checks > 10);
  for (let stop = 1; stop <= checks; stop++) {
    let visited = 0;
    await assert.rejects(buildBatched(input, { check() { if (++visited === stop) throw cancellation; } }), error => error === cancellation);
    assert.equal(visited, stop);
  }
  assert.deepEqual(await buildBatched(input), expected, 'a cancelled attempt leaves no cache or partial publication');
});

test('default mapping5 report remains unsupported and profile-free before and after explicit new interpretation', async () => {
  const { input } = await fixture(), before = legacy(input), fingerprint = digest(before);
  const newResult = build(input); assert.equal(statistic(newResult, 'reported_close_price').status, 'ready');
  for (const output of [before, legacy(input), await legacyBatched(input)]) {
    assert.equal(digest(output), fingerprint);
    assert.equal(Object.hasOwn(sharedSource(output).payload, 'interpretation'), false);
    for (const measurement of ['reported_close_price', 'reported_current_price', 'reported_living_area', 'reported_site_area']) {
      const stat = statistic(output, measurement); assert.equal(stat.value, null); assert.equal(stat.unit, null);
      assert.equal(stat.status, 'incomplete'); assert.equal(stat.reason, 'reported_unit_not_established');
    }
    assert.equal(Object.hasOwn(sharedMembers(output)[0].member_data, 'interpretation_profile_ref'), false);
    assert.equal(sharedMembers(output)[0].member_data.observations.reported_current_price.exact_value, '275000');
  }
});

test('mixed observed units refuse pooled area statistics while retaining every observed member and denominator', async () => {
  const { input } = await fixture({ extraTransactions: [extra(1)], saleWitnessesBySourceId: {
    '11': { rawPayload: payload({ LivingArea: '2000', LivingAreaUnits: 'sqft', LotSizeArea: '43560', LotSizeUnits: 'sqft' }) },
  } }), result = build(input);
  assert.equal(result.status, 'ready', 'the bounded report can retain unavailable optional statistics honestly');
  for (const measurement of ['reported_living_area', 'reported_site_area']) {
    for (const estimator of ['low', 'median', 'high']) {
      const stat = statistic(result, measurement, estimator);
      assert.equal(stat.status, 'incomplete'); assert.equal(stat.reason, 'reported_unit_not_established');
      assert.equal(stat.value, null); assert.equal(stat.unit, null);
      assert.equal(stat.observed_count, 2); assert.equal(stat.denominator_count, 2);
    }
  }
  assert.deepEqual(sharedMembers(result).map(member => member.member_data.observations.reported_living_area.unit), ['sqm', 'sqft']);
  assert.equal(statistic(result, 'reported_close_price').status, 'ready');
  assert.deepEqual(await buildBatched(input), result);
});

test('absent field-specific currency remains unavailable even with a generic USD declaration', async () => {
  const { input } = await fixture({ rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01',
    ClosePrice: '123456', Currency: 'USD', PriceCurrency: 'USD' } }), result = build(input);
  const stat = statistic(result, 'reported_close_price');
  assert.equal(stat.status, 'incomplete'); assert.equal(stat.value, null); assert.equal(stat.unit, null);
  assert.equal(stat.unsupported_count, 1); assert.equal(stat.denominator_count, 1);
  assert.equal(sharedMembers(result)[0].member_data.observations.reported_close_price.exact_value, '123456');
});

test('historical effective dates still refuse current-CAD report adoption before producing an assessment', async () => {
  const { input } = await fixture({ effectiveDate: '2024-07-01' });
  const expected = { status: 'incomplete', assessment: null, publication_bundle: null, candidate: null,
    issues: [{ code: 'historical_stock_evidence_required' }] };
  assert.deepEqual(build(input), expected); assert.deepEqual(await buildBatched(input), expected);
});

test('foreign targets, mismatched effective dates, unknown groups and copied geography refuse both new paths', async () => {
  const { input } = await fixture();
  for (const [changed, reason] of [
    [{ ...input, target: { ...input.target, report_file_id: uuid(9) } }, /target/],
    [{ ...input, target: { ...input.target, custom_assignment_file_id: 42 } }, /target/],
    [{ ...input, target: { ...input.target, scope: { ...input.target.scope, organization_id: uuid(9) } } }, /target/],
    [{ ...input, target: { ...input.target, effective_date: '2026-09-05' } }, /effective_date/],
    [{ ...input, selection: { revision: 1, included_recorded_group_ids: ['not-a-real-group'] } }, /selection_membership/],
    [{ ...input, report_geography: structuredClone(input.report_geography) }, /completed_identity/],
  ]) {
    assert.throws(() => build(changed), reason); await assert.rejects(buildBatched(changed), reason);
  }
});

for (const options of [
  { geographyChanges: { neighborhood_boundary_north: '' } },
  { geographyChanges: { neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' } },
  { oracleChanges: { covers_recorded_subject_point: false, contains_recorded_subject_point: false } },
]) test(`incomplete synthetic geography remains unadoptable: ${JSON.stringify(options)}`, async () => {
  const { input } = await fixture(options), result = build(input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.assessment.geographic_neighborhood.status, 'incomplete');
  assert.deepEqual(result.candidate.suggestions, []);
  assert.deepEqual(await buildBatched(input), result);
});

test('explicit empty selection produces complete empty populations, never implicit all or invented prices', async () => {
  const { input } = await fixture({ emptySelection: true }), result = build(input);
  assert.equal(result.status, 'ready', 'legacy empty-selection report behavior is preserved');
  assert.deepEqual(result.assessment.selection.pocket_ids, []);
  assert.ok(result.assessment.populations.every(population => population.member_count === 0));
  assert.deepEqual(result.publication_bundle.members, []);
  assert.ok(result.assessment.statistics.filter(stat => stat.estimator !== 'count').every(stat => stat.value === null
    && stat.denominator_count === 0 && stat.observed_count === 0));
  assert.equal(sharedSource(result).payload.disposition_counts.outside_selection, 1);
  assert.deepEqual(sharedSource(result).payload.interpretation, getCustomCohortReportedSaleWitnessV2Profile());
  assert.deepEqual(await buildBatched(input), result);
});

test('explicit witness report cannot reinterpret a genuine original CAD-only mapping4 capture', async () => {
  const { input } = await fixture({ mappingVersion: 4 });
  assert.equal(legacy(input).status, 'ready');
  assert.throws(() => build(input), /mapping5_required/);
  await assert.rejects(buildBatched(input), /mapping5_required/);
});
