import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { neighborhoodDenseCaptureProfile, measureNeighborhoodDenseCapture } from './helpers/neighborhoodDenseCaptureMemoryChecks.js';
import { denseWitness2FixtureCases, assertDenseWitness2ObservationCase, denseReportedAssessmentBuilder,
  createDenseReportedStageObserver } from './helpers/customCohortDenseReportedChecks.js';
import { createNeighborhoodCadEvidenceReadAccess, createNeighborhoodCombinedEvidenceReadAccess } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, createNeighborhoodDenseCombinedEvidenceSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { captureNeighborhoodSpatialMembershipStream, captureNeighborhoodSpatialMembershipCompact } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { buildCustomCohortReportedAssessmentBatched, buildCustomCohortReportedAssessmentWitnessV2Batched } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { buildCustomCohortReportedSharedSales, buildCustomCohortReportedSharedSalesWitnessV2 } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { prepareCustomCohortReportGeography, completeCustomCohortReportGeography } from '../src/services/neighborhoodAssessment/customCohortReportGeography.js';

const profile = getCustomCohortReportedSaleWitnessV2Profile(), cases = denseWitness2FixtureCases();
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const retained = f => f.input.retained_inputs;
const shared = (f, build = buildCustomCohortReportedSharedSalesWitnessV2) => build({
  retained_inputs: retained(f), selected_account_ids: retained(f).spatial.account_ids });
const combined = (options = {}) => cadEvidenceFixture({ mappingVersion: 5, rawPayload: cases[0].raw,
  reportedSaleInterpretation: profile.profile_ref, ...options });

test('optional reported diagnostic observer admits variable pairs with neutral ordinals only', () => {
  for (const count of [2, 4, 20, 202]) {
    const rows = []; let tick = 100;
    const observer = createDenseReportedStageObserver(row => rows.push(row), () => tick++);
    for (let i = 0; i < count; i++) observer.check();
    observer.complete();
    const ordinals = Array.from({ length: count / 2 }, (_, index) => index + 1);
    assert.deepEqual(rows.map(row => row.name), ordinals.map(ordinal => `builder_synchronous_interval_${ordinal}`));
    assert.deepEqual(rows.map(row => row.interval_ordinal), ordinals);
    assert.ok(rows.every(row => row.elapsed_ms === 1 && row.end_ms - row.start_ms === 1
      && row.kind === 'synchronous_builder_interval' && row.observer_version === 3));
  }
  const partial = createDenseReportedStageObserver(() => {});
  assert.throws(() => partial.complete(), /incomplete check pairs/);
  partial.check(); assert.throws(() => partial.complete(), /incomplete check pairs/);
  partial.check(); assert.doesNotThrow(() => partial.complete());
  assert.throws(() => createDenseReportedStageObserver(null));
});

test('neutral diagnostic output remains bounded independently of production source/report limits', () => {
  let emitted = 0, finalOrdinal;
  const observer = createDenseReportedStageObserver(row => { emitted++; finalOrdinal = row.interval_ordinal; }, () => 1);
  for (let index = 0; index < 100_000; index++) observer.check();
  observer.complete();
  assert.equal(emitted, 50_000); assert.equal(finalOrdinal, 50_000);
  assert.throws(() => observer.check(), /diagnostic check limit/);
});

// Small original source acquisition/retention fixtures and the real cooperative
// builders; no native DB or capacity timing claim. The synthetic geography
// oracle uses the existing process-local admission, never a copied capability.
for (const mappingVersion of [4, 5]) test(`real mapping${mappingVersion} report builder verifies diagnostic count and output parity`, async () => {
  const capture = await cadEvidenceFixture({ mappingVersion, assignmentFileId: '41', effectiveDate: '2026-09-06',
    ...(mappingVersion === 5 ? { rawPayload: cases[0].raw, reportedSaleInterpretation: profile.profile_ref } : {}) });
  const originals = retained(capture), subject = originals.subject.target, derivedAt = '2026-09-06T16:00:00.000Z';
  const target = { scope: Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .map(key => [key, subject[key]])), report_file_id: subject.report_file_id, custom_assignment_file_id: 41,
    editor_revision: 0, effective_date: originals.subject.effective_date, data_cutoff: originals.subject.effective_date };
  const saved = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    ...Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [`neighborhood_boundary_${side}`, `Synthetic ${side}`])) };
  const projected = JSON.stringify(saved), admitted = prepareCustomCohortReportGeography({
    target: { organization_id: subject.organization_id, report_file_id: subject.report_file_id,
      assignment_file_id: subject.assignment_file_id, account_id: subject.account_id }, assignment_revision: 1,
    captured_at: derivedAt, retained_subject: originals.subject,
    projection: { details_type: 'object', projected_utf8_bytes: Buffer.byteLength(projected),
      projected_sha256: createHash('sha256').update(projected).digest('hex'), projected_json: projected } });
  assert.equal(admitted.status, 'awaiting_topology');
  const geography = completeCustomCohortReportGeography(admitted, { is_valid: true, validation_reason: 'Synthetic diagnostic oracle',
    postgis_version: 'synthetic-only', geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
    covers_recorded_subject_point: true, contains_recorded_subject_point: true });
  const input = { context_ref: capture.input.expected.context_ref, retained_inputs: originals, target,
    selection: { revision: 1, included_recorded_group_ids: [...capture.catalog.pockets.map(pocket => pocket.id),
      ...(capture.catalog.unassigned.member_count ? ['discovery:unassigned'] : [])] },
    preparation_identity: { assessment_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001', assessment_revision: 1,
      attachment_id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002', attachment_revision: 1 },
    report_geography: geography, derived_at: derivedAt };
  const builder = denseReportedAssessmentBuilder(originals), expected = await builder(input), before = json(input), rows = [];
  assert.equal(expected.status, 'ready');
  // Pinned from the preceding unscheduled capacity tree: timing observations
  // must not alter the fixed reported methodology or witness interpretation.
  assert.equal(hash(expected.assessment.methodology.configuration), '018d4f574c36ef973ad21289048703e9b106d7c25f13d0e651202df2f7bade16');
  if (mappingVersion === 5) assert.equal(profile.profile_ref.content_sha256,
    '831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e');
  let referenceCalls = 0;
  const counted = await builder(input, { check() { referenceCalls++; } });
  assert.deepEqual(counted, expected);
  let calls = 0, tick = 100;
  const observer = createDenseReportedStageObserver(row => rows.push(row), () => tick++);
  const result = await builder(input, { check() { calls++; observer.check(); } });
  observer.complete();
  assert.equal(calls, referenceCalls); assert.ok(calls > 0 && calls % 2 === 0); assert.equal(rows.length, calls / 2);
  assert.deepEqual(rows.map(row => row.interval_ordinal), Array.from({ length: calls / 2 }, (_, index) => index + 1));
  for (const [index, row] of rows.entries()) assert.deepEqual(row, { name: `builder_synchronous_interval_${index + 1}`,
    kind: 'synchronous_builder_interval', observer_version: 3, interval_ordinal: index + 1,
    start_ms: 100 + index * 2, end_ms: 101 + index * 2, elapsed_ms: 1 });
  assert.deepEqual(result, expected); assert.equal(json(result), json(expected)); assert.equal(json(input), before);
});

// Bounded dispatcher/oracle tests only. No native database, dense allocation,
// full web service, capacity timing claim or production source authorization.
test('default dense dispatch retains exact original CAD4 factories, expanded stream and unmarked intent bytes', () => {
  const selected = neighborhoodDenseCaptureProfile();
  assert.equal(selected.sourceMode, 'cad4'); assert.equal(selected.spatialEncoding, 'expanded');
  assert.equal(selected.mappingVersion, 4); assert.equal(selected.interpretation, null);
  assert.equal(selected.accessFactory, createNeighborhoodCadEvidenceReadAccess);
  assert.equal(selected.readerFactory, createNeighborhoodDenseCadEvidenceSourceReader);
  assert.equal(selected.captureSpatial, captureNeighborhoodSpatialMembershipStream);
  assert.equal(json(selected.intentFields), '{"intent_version":1}'); assert.equal(json(selected.captureFields), '{}');
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.intentFields)); assert.ok(Object.isFrozen(selected.captureFields));
});

test('combined fixture dispatch chooses the exact issuer/reader and original intent3 profile before preparation', () => {
  const selected = neighborhoodDenseCaptureProfile('combined-witness2-v1', 'fixed_fields_v1');
  assert.equal(selected.mappingVersion, 5);
  assert.equal(selected.accessFactory, createNeighborhoodCombinedEvidenceReadAccess);
  assert.equal(selected.readerFactory, createNeighborhoodDenseCombinedEvidenceSourceReader);
  assert.equal(selected.captureSpatial, captureNeighborhoodSpatialMembershipCompact);
  assert.deepEqual(selected.interpretation, profile);
  assert.deepEqual(selected.intentFields, { intent_version: 3, reported_sale_interpretation: profile.profile_ref });
  assert.deepEqual(selected.captureFields, { reported_sale_interpretation: profile.profile_ref });
  assert.equal(profile.profile_ref.content_sha256, '831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e');
  assert.equal(selected.intentFields.reported_sale_interpretation, selected.captureFields.reported_sale_interpretation);
});

test('compact encoding is explicit and orthogonal to source mode; no silent old fixture upgrade', () => {
  assert.equal(neighborhoodDenseCaptureProfile('combined-witness2-v1').captureSpatial, captureNeighborhoodSpatialMembershipStream);
  const selected = neighborhoodDenseCaptureProfile('cad4', 'fixed_fields_v1');
  assert.equal(selected.captureSpatial, captureNeighborhoodSpatialMembershipCompact);
  assert.equal(selected.readerFactory, createNeighborhoodDenseCadEvidenceSourceReader);
  assert.deepEqual(selected.captureFields, {});
});

for (const invalid of [null, '', 'mapping5', 'combined-witness2', 5, {}, ['cad4']]) {
  test(`unknown source dispatch ${JSON.stringify(invalid)} refuses before connection intake`, async () => {
    assert.throws(() => neighborhoodDenseCaptureProfile(invalid), /dense_source_mode_invalid/);
    await assert.rejects(measureNeighborhoodDenseCapture({ connectionString: 'not a database URL', phase: 'capture', sourceMode: invalid }),
      /dense_source_mode_invalid/);
  });
}
test('unknown spatial encoding refuses before connection intake', async () => {
  await assert.rejects(measureNeighborhoodDenseCapture({ connectionString: 'not a database URL', phase: 'capture', spatialEncoding: 'compact' }),
    /dense_spatial_encoding_invalid/);
});

test('genuine marked acquisition reopens exact intent/study/profile originals and routes from the retained marker', async () => {
  const f = await combined(), input = retained(f), before = json(input), prepared = prepareCustomCohortCaptureInputs(input);
  assert.equal(denseReportedAssessmentBuilder(input), buildCustomCohortReportedAssessmentWitnessV2Batched);
  assert.equal(input.acquisition_intent.body.intent_version, 3);
  assert.deepEqual(input.acquisition_intent.body.reported_sale_interpretation, profile.profile_ref);
  assert.equal(input.acquisition_intent.reference.content_sha256, hash(input.acquisition_intent.body));
  const studyRef = prepared.refs.study_input;
  const study = JSON.parse(await f.base.store.get(studyRef.content_sha256, studyRef.canonical_utf8_bytes));
  assert.equal(study.study_input_version, 2);
  assert.deepEqual(study.reported_sale_interpretation, { profile_ref: profile.profile_ref, definition_blob: profile.definition_blob.ref });
  assert.equal(await f.base.store.get(profile.definition_blob.ref.content_sha256, profile.definition_blob.ref.canonical_utf8_bytes),
    profile.definition_blob.canonical_json);
  assert.deepEqual(f.marketPurposes[0].source_projection, { id: 'cached-combined-evidence-v1', mapping_version: 5,
    witness_version: 2, fields: CACHED_SALE_WITNESS_V2_FIELDS });
  assert.equal(json(input), before);
});

test('default CAD4 retains the preexisting full shared output and retained graph golden hashes', async () => {
  const f = await cadEvidenceFixture(), input = retained(f);
  assert.equal(denseReportedAssessmentBuilder(input), buildCustomCohortReportedAssessmentBatched);
  assert.equal(hash(shared(f, buildCustomCohortReportedSharedSales)), '9d9bfa406865cb9c767af0b49059e4fd2b4a749b146609f8d51d33256f610b18');
  assert.equal(hash(prepareCustomCohortCaptureInputs(input)), '0a57fa378c4dc1766ae4c17fd179a857a9a340b7daf6fe067622ec55a644b320');
});

test('unmarked mapping5 with explicit raw units still routes to legacy reported semantics', async () => {
  const f = await cadEvidenceFixture({ mappingVersion: 5, rawPayload: cases[0].raw }), input = retained(f);
  assert.equal(denseReportedAssessmentBuilder(input), buildCustomCohortReportedAssessmentBatched);
  const old = shared(f, buildCustomCohortReportedSharedSales);
  assert.equal(old.rows[0].data.observations.reported_close_price.state, 'unsupported');
  assert.equal(old.rows[0].data.observations.reported_current_price.unit, null);
  assert.equal(old.rows[0].data.observations.reported_living_area.unit, null);
  assert.equal(Object.hasOwn(old, 'interpretation_profile_ref'), false);
});

test('present malformed/foreign marker and wrong mapping cannot silently choose the legacy builder', async () => {
  const f = await combined(), input = retained(f);
  for (const marker of [null, undefined, {}, { ...profile.profile_ref, content_sha256: 'a'.repeat(64) },
    { ...profile.profile_ref, unexpected: true }]) {
    assert.throws(() => denseReportedAssessmentBuilder({ ...input, reported_sale_interpretation: marker }));
  }
  assert.throws(() => denseReportedAssessmentBuilder({ ...input, acquisition: { ...input.acquisition,
    compact_metadata_json: json({ ...JSON.parse(input.acquisition.compact_metadata_json), mapping_version: 4 }) } }));
});

for (const [index, fixture] of cases.entries()) test(`fixed dense witness case ${fixture.id} survives genuine mapping5 retention without typed fallback`, async () => {
  const f = await combined({ rawPayload: fixture.raw, saleOverrides: { source_current_price: '999999',
    source_living_area: '9999', source_lot_size_area: '8888', source_year_built: 1980, source_days_on_market: 99 } });
  const input = retained(f), before = json(input), result = shared(f);
  assert.equal(result.rows.length, 1); assert.equal(result.disposition_counts.included, 1);
  assert.equal(result.rows[0].data.reported_close_date, '2024-03-01');
  assertDenseWitness2ObservationCase(result.rows[0].data.observations, index);
  assert.deepEqual(result.interpretation_profile_ref, profile.profile_ref);
  assert.equal(json(input), before);
  const raw = input.acquisition.capture_result.source_capture.sources
    .filter(source => source.payload.projection.definition.role === 'transactions').flatMap(source => source.payload.records)[0].data.raw_projection;
  assert.equal(raw.source_current_price, '999999'); assert.equal(raw.source_living_area, '9999');
  assert.equal(raw.source_year_built, 1980); assert.equal(raw.source_days_on_market, 99);
});

test('all ten strata conserve all five measurement states and preserve exact/mixed-unit distributions together', async () => {
  const account = '0000123456789';
  const extraTransactions = cases.slice(1).map((_, index) => ({ source_record_id: String(11 + index), sale_id: String(21 + index),
    primary_account_id: account, sale_account_id: account, source_record_hash: 'b'.repeat(64), record_type: 'closed_sale',
    source_close_date: '2024-03-01', sale_closing_date: '2024-03-01', source_current_price: '999999', sale_price: '777777' }));
  const saleWitnessesBySourceId = Object.fromEntries(cases.slice(1).map((fixture, index) => [String(11 + index), { rawPayload: fixture.raw }]));
  const result = shared(await combined({ extraTransactions, saleWitnessesBySourceId }));
  assert.equal(result.rows.length, 10); assert.equal(result.disposition_counts.included, 10);
  for (const row of result.rows) assertDenseWitness2ObservationCase(row.data.observations, Number(row.data.source_record_id) - 10);
  const fields = ['observed_count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'];
  for (const [key, expected] of Object.entries({ reported_close_price: [2, 2, 1, 1, 4], reported_current_price: [3, 1, 1, 1, 4],
    reported_living_area: [4, 2, 1, 0, 3], reported_site_area: [4, 2, 1, 0, 3], reported_year_built: [7, 2, 1, 0, 0],
    reported_days_on_market: [7, 2, 1, 0, 0] })) {
    const metric = result.metrics[key];
    assert.deepEqual(fields.map(field => metric[field]), expected);
    assert.equal(fields.reduce((sum, field) => sum + metric[field], 0), 10);
  }
  assert.equal(result.metrics.reported_close_price.median, '300000.500000000001');
  assert.equal(result.metrics.reported_current_price.median, '250000.000000000001');
  for (const key of ['reported_living_area', 'reported_site_area']) {
    assert.equal(result.metrics[key].unit, null); assert.equal(result.metrics[key].median, null);
    assert.equal(result.metrics[key].low, null); assert.equal(result.metrics[key].high, null);
  }
});

test('fixed fixture table is immutable and bad case admission or changed observations is detected', () => {
  assert.equal(cases.length, 10); assert.ok(Object.isFrozen(cases));
  for (const fixture of cases) {
    assert.ok(Object.isFrozen(fixture)); assert.ok(Object.isFrozen(fixture.raw)); assert.ok(Object.isFrozen(fixture.observations));
    for (const cell of Object.values(fixture.observations)) assert.ok(Object.isFrozen(cell));
  }
  assert.throws(() => assertDenseWitness2ObservationCase(cases[0].observations, 10));
  assert.throws(() => assertDenseWitness2ObservationCase({ ...cases[0].observations,
    reported_close_price: { ...cases[0].observations.reported_close_price, exact_value: '1' } }, 0));
});
