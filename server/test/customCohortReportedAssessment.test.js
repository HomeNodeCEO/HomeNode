import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortReportedAssessment as build } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { customCohortReportedAssessmentFixture as fixture } from './fixtures/customCohortReportedAssessmentFixture.js';
import { neighborhoodMemberSetDigest } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { prepareCustomCohortAssessmentPreparation } from '../src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js';

test('actual retained CAD graph and explicit saved manual geometry produce one v2 report candidate', async () => {
  const { input } = await fixture(), result = build(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(result.assessment.contract_version, 2); assert.equal(result.candidate.suggestions.length, 5);
  assert.deepEqual(result.assessment.geographic_neighborhood.geometry, input.report_geography.geometry);
  assert.equal(result.assessment.populations[0].member_unit, 'account');
  assert.equal(result.assessment.populations.find(p => p.id === 'selected-shared-source-records').member_count, 3);
  assert.equal(result.assessment.statistics.find(s => s.id === 'selected-shared-source-records:reported_current_price:median').value, null);
  assert.ok(result.assessment.source_snapshots.every(s => s.valid_from === null && s.historical_availability === 'unknown'));
  assert.equal(result.assessment.geographic_neighborhood.perimeter.length, 4);
});

test('887 retained named groups survive v5 checkpoint, preparation, report statistics and subset selection without truncation', async () => {
  const { input, recorded } = await fixture({ catalogVersion: 2,
    recordedLabels: Array.from({ length: 887 }, (_, i) => `Dense Recorded ${String(i).padStart(4, '0')}`) });
  const checkpoint = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: 5, pending_capture: null, active: {
    context_ref: input.context_ref, observation_period: input.retained_inputs.study.observation_period, selection: input.selection } });
  assert.equal(checkpoint.active.selection.included_recorded_group_ids.length, 887);
  const preparation = { context_header_json: recorded.context_header_json, expected: { context_ref: input.context_ref,
    target: { organization_id: input.target.scope.organization_id, report_file_id: input.target.report_file_id,
      assignment_file_id: '41', account_id: input.target.scope.account_id }, observation_period: input.retained_inputs.study.observation_period },
    retained_inputs: input.retained_inputs, selection: input.selection, catalog_version: 2 };
  const diagnostic = prepareCustomCohortAssessmentPreparation(preparation);
  assert.equal(diagnostic.selection_resolution.selected_account_count, 887);
  assert.equal(diagnostic.selection_resolution.catalog_complete, true);
  assert.throws(() => prepareCustomCohortAssessmentPreparation({ ...preparation, catalog_version: 1 }), /group_ids/);
  const result = build(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  const population = result.assessment.populations.find(p => p.id === 'selected-cad-accounts');
  assert.equal(population.member_count, 887); assert.equal(result.assessment.selection.pocket_ids.length, 887);
  assert.ok(result.assessment.statistics.filter(s => s.population_id === population.id).every(s => s.denominator_count === 887));
  assert.equal(result.binding.selected_account_set_sha256, neighborhoodMemberSetDigest(input.retained_inputs.spatial.account_ids));
  assert.throws(() => build({ ...input, catalog_version: 1 }), /catalog_incomplete/);
  const ids = input.selection.included_recorded_group_ids.slice(0, 440);
  const subset = build({ ...input, selection: { revision: 2, included_recorded_group_ids: ids } });
  assert.equal(subset.assessment.populations.find(p => p.id === population.id).member_count, 440);
  assert.deepEqual(subset.assessment.selection.pocket_ids, [...ids].sort());
});

test('v2 interpretation leaves an existing small report result byte-for-byte unchanged', async () => {
  const { input } = await fixture(); assert.deepEqual(build({ ...input, catalog_version: 2 }), build(input));
});

test('private real CSV values survive as exact labeled source-record statistics, including zero DOM', async () => {
  const { input } = await fixture({ privateRows: [{ ClosePrice: '9007199254740993.123456789012' }, { ClosePrice: '9007199254740993.123456789013' }] });
  const result = build(input), stats = result.assessment.statistics;
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(stats.find(s => s.id === 'selected-private-source-records:reported_close_price:median').value, '9007199254740993.1234567890125');
  assert.equal(stats.find(s => s.id === 'selected-private-source-records:reported_days_on_market:median').value, '0');
  assert.equal(result.publication_bundle.members.filter(row => row.population_id === 'selected-private-source-records').length, 2);
});

test('all 101 reviewed in-period records enter the median, never an implicit top30', async () => {
  const { input } = await fixture({ privateRows: Array.from({ length: 101 }, (_, n) => ({ ClosePrice: String(1000 + n) })) });
  const result = build(input), price = result.assessment.statistics.find(s => s.id === 'selected-private-source-records:reported_close_price:median');
  assert.equal(price.denominator_count, 101); assert.equal(price.value, '1050');
});

test('explicit empty selected pockets remain empty in every report population', async () => {
  const { input } = await fixture({ privateRows: [{}], emptySelection: true }), result = build(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.ok(result.assessment.populations.every(p => p.member_count === 0));
  assert.ok(result.assessment.statistics.filter(s => s.estimator !== 'count').every(s => s.value === null));
});

test('future, undated, nonclosed and out-of-period CSV rows never enter selected closing-price statistics', async () => {
  const { input } = await fixture({ privateRows: [{}, { CloseDate: '2027-01-01' }, { CloseDate: '' },
    { MlsStatus: 'Active' }, { CloseDate: '2020-01-01' }] }), result = build(input);
  assert.equal(result.assessment.populations.find(p => p.id === 'selected-private-source-records').member_count, 1);
  const source = result.publication_bundle.sources.find(s => s.snapshot.id === 'selected-private-source-records:observations');
  assert.equal(Object.values(source.payload.disposition_counts).reduce((sum, n) => sum + n, 0), 5);
});

for (const geographyChanges of [{ neighborhood_boundary_north: '' }, { neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' }]) {
  test(`manual geography is not fabricated when ${JSON.stringify(geographyChanges)}`, async () => {
    const { input } = await fixture({ geographyChanges }), result = build(input);
    assert.equal(result.status, 'incomplete'); assert.equal(result.assessment.geographic_neighborhood.status, 'incomplete');
    assert.deepEqual(result.candidate.suggestions, []);
  });
}

test('reported manual boundary must cover the actual retained subject point', async () => {
  const { input } = await fixture({ oracleChanges: { covers_recorded_subject_point: false, contains_recorded_subject_point: false } });
  assert.equal(build(input).status, 'incomplete');
});

test('retrospective appraisal cannot adopt a later current-CAD mirror as dated stock', async () => {
  const { input } = await fixture({ effectiveDate: '2024-07-01' }), result = build(input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.assessment, null);
  assert.deepEqual(result.issues, [{ code: 'historical_stock_evidence_required' }]);
});

test('unrecognized selected group and foreign target fail before report output', async () => {
  const { input } = await fixture();
  assert.throws(() => build({ ...input, selection: { revision: 1, included_recorded_group_ids: ['made-up-pocket'] } }), /selection_membership/);
  assert.throws(() => build({ ...input, target: { ...input.target, report_file_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), /target/);
});

test('genuine retained long recorded label is preserved without violating numeric presentation label bounds', async () => {
  const label = `Recorded ${'é'.repeat(240)}`;
  assert.ok(label.length > 200 && Buffer.byteLength(label) <= 512);
  const { input, recorded } = await fixture({ recordedLabels: [label, label] });
  const before = JSON.stringify(input.retained_inputs), result = build(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(recorded.catalog.pockets.length, 1); assert.equal(recorded.catalog.pockets[0].label, label);
  const rawNames = input.retained_inputs.acquisition.capture_result.source_capture.sources
    .filter(s => s.payload.projection.definition.role === 'accounts').flatMap(s => s.payload.records.map(r => r.data.raw_projection.subdivision));
  assert.deepEqual(rawNames, [label, label]);
  assert.deepEqual(result.assessment.selection.pocket_ids, input.selection.included_recorded_group_ids);
  assert.equal(result.assessment.populations.find(p => p.id === 'selected-cad-accounts').member_count, 2);
  assert.equal(JSON.stringify(input.retained_inputs), before, 'no retained source relabeling/trimming');
});

test('all128 actual recorded groups plus unassigned retain all129 accounts and original selected group IDs', async () => {
  const { input, recorded } = await fixture({ recordedLabels: [...Array.from({ length: 128 }, (_, i) => `Recorded Group ${String(i).padStart(3, '0')}`), null] });
  assert.equal(recorded.catalog.pockets.length, 128); assert.equal(recorded.catalog.unassigned.member_count, 1);
  assert.equal(input.selection.included_recorded_group_ids.length, 129);
  const checkpoint = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: 1, pending_capture: null, active: {
    context_ref: input.context_ref, observation_period: input.retained_inputs.study.observation_period, selection: input.selection } });
  assert.deepEqual(checkpoint.active.selection, input.selection, 'this is actually admissible saved intent');
  const result = build(input), members = result.publication_bundle.members.filter(r => r.population_id === 'selected-cad-accounts');
  assert.equal(result.status, 'ready', JSON.stringify(result.issues));
  assert.equal(members.length, 129); assert.equal(new Set(members.map(m => m.member_id)).size, 129);
  assert.deepEqual(members.map(m => m.member_id).sort(), [...input.retained_inputs.spatial.account_ids].sort());
  assert.deepEqual(result.assessment.selection.pocket_ids, [...input.selection.included_recorded_group_ids].sort());
  assert.equal(result.binding.selected_account_set_sha256, neighborhoodMemberSetDigest(input.retained_inputs.spatial.account_ids));
  const population = result.assessment.populations.find(p => p.id === 'selected-cad-accounts');
  assert.equal(population.member_count, 129); assert.equal(population.unique_account_count, 129); assert.equal(population.account_link_count, 129);
  assert.ok(result.assessment.statistics.filter(s => s.population_id === population.id).every(s => s.denominator_count === 129));
  const subset = build({ ...input, selection: { ...input.selection,
    included_recorded_group_ids: input.selection.included_recorded_group_ids.filter(id => id !== 'discovery:unassigned') } });
  assert.equal(subset.assessment.populations.find(p => p.id === population.id).member_count, 128);
  assert.ok(!subset.publication_bundle.members.some(m => m.population_id === population.id && recorded.catalog.unassigned.account_ids.includes(m.member_id)));
});
