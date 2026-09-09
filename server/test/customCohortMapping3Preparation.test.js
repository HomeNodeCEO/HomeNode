import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { prepareCustomCohortAssessmentPreparation as prepare } from '../src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js';
import { createCustomCohortDecisionEvidenceResolver as evidence } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture, syntheticSaleWitness } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const base = saleWitnessMeaningFixture(), oldBase = decisionEvidenceFixture();
const sources = input => input.retained_inputs.acquisition.capture_result.source_capture.sources;
const source = (input, role) => sources(input).find(entry => entry.payload.projection.definition.role === role);
const rows = (input, role) => sources(input).filter(entry => entry.payload.projection.definition.role === role).flatMap(entry => entry.payload.records);
const previewOf = input => buildCustomCohortObservationPreview({ context_ref: input.expected.context_ref,
  retained_inputs: input.retained_inputs, selection: { revision: input.selection.revision, pockets: [] } });
const setMetadata = (input, change) => {
  const acquisition = input.retained_inputs.acquisition, value = JSON.parse(acquisition.compact_metadata_json);
  change(value); acquisition.compact_metadata_json = JSON.stringify(value);
};

test('actual mapping3 original capture persists/reopens unchanged with matching row and chunk digests', async () => {
  const f = await base, { input } = f, captured = input.retained_inputs.acquisition.capture_result;
  assert.deepEqual(input.retained_inputs, f.originalRetained);
  assert.equal(JSON.parse(input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 3);
  assert.equal(captured.reader_version, 'local-capture-v3');
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(captured.query_evidence)).status, 'syntax_valid');
  const snapshots = new Map(captured.source_capture.source_snapshots.map(entry => [entry.id, entry]));
  for (const entry of sources(input)) {
    assert.equal(entry.payload.projection.definition.mapping_version, 3);
    assert.equal(snapshots.get(entry.id).content_sha256, assessmentEvidenceDigest(entry.payload));
    for (const row of entry.payload.records) if (row.data.raw_projection) {
      const mapped = row.data;
      assert.equal(mapped.data.cached_mapping_version, 3);
      assert.equal(mapped.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 3,
        projection_kind: mapped.data.cached_projection_kind, raw_projection: mapped.raw_projection }));
    }
  }
  assert.equal(rows(input, 'transactions')[0].data.raw_projection.source_raw_witness.fields.ClosePrice.value_text, '275000');
  assert.equal(Object.isFrozen(input.retained_inputs), true);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, captured), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.captureResult), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
});

test('original v2 remains byte-identical and separately replayable after installing and consuming v3', async () => {
  const old = await oldBase, before = JSON.stringify(old.input);
  assert.equal(JSON.parse(old.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 2);
  const next = await base;
  assert.equal(prepare(old.input).status, 'incomplete'); assert.equal(prepare(next.input).status, 'incomplete');
  assert.equal(JSON.stringify(old.input), before);
  assert.notEqual(old.sourceRef, next.sourceRef);
  assert.equal(Object.hasOwn(rows(old.input, 'transactions')[0].data.raw_projection, 'source_raw_witness'), false);
  assert.ok(rows(old.input, 'transactions').every(row => row.data.data.cached_mapping_version === 2));
});

test('v3 keeps the same coherent observed populations and recorded groups without enabling Apply', async () => {
  const f = await base, old = await oldBase, before = JSON.stringify(f.input), output = prepare(f.input);
  assert.equal(f.preview.status, 'observations_only'); assert.equal(f.catalog.status, 'review_only');
  for (const value of [f.preview, f.catalog, output]) {
    assert.equal(value.authority, 'not_established'); assert.equal(value.apply.status, 'blocked');
  }
  assert.deepEqual(f.catalog.pockets, old.catalog.pockets);
  assert.deepEqual(output.observations, prepare(old.input).observations);
  assert.equal(f.preview.all.transactions.metrics.recorded_total_price.median, 275000);
  assert.equal(f.preview.all.source_reported.metrics.current_price.median, 275000);
  assert.equal(f.preview.all.stock.metrics.gla_sqft.median, old.preview.all.stock.metrics.gla_sqft.median);
  assert.equal(f.preview.all.transactions.market_eligible_count, null);
  assert.equal(output.assessment, null); assert.equal(output.publication, null);
  assert.ok(Object.values(output.runtime_requirements).every(value => value === 'not_checked'));
  assert.equal(f.f.state.calls.length, 0); assert.equal(JSON.stringify(f.input), before);
});

test('retained raw units are not described as absent or promoted into verified units/currency/GLA at sale', async () => {
  const f = await saleWitnessMeaningFixture({ rawPayload: { LivingArea: '1850.125', LivingAreaUnits: 'Square Feet',
    LotSizeArea: '0.5', LotSizeUnits: 'Acres', Currency: 'USD', ListPrice: '280000', ClosePrice: '275000' },
  saleOverrides: { source_lot_size_area: '0.5' } });
  const metrics = f.preview.all.source_reported.metrics;
  assert.equal(metrics.lot_size_area.label, 'Source-reported lot area; units not verified');
  assert.equal(metrics.lot_size_area.median, 0.5); assert.equal(metrics.lot_size_area.unit, null);
  assert.equal(metrics.living_area.unit, null); assert.equal(f.preview.all.transactions.metrics.recorded_total_price.currency, null);
  assert.equal(f.preview.unavailable_metrics.sale_price_per_square_foot, 'property_sale_price_and_gla_at_sale_not_verified');
  const raw = rows(f.input, 'transactions')[0].data.raw_projection;
  assert.equal(raw.source_raw_witness.fields.LotSizeUnits.value_text, 'Acres');
  assert.equal(raw.source_raw_witness.fields.ListPrice.value_text, '280000');
  assert.equal(raw.source_current_price, '275000');
  assert.equal(prepare(f.input).apply.status, 'blocked');
});

test('evidence resolver binds the full original v3 witness record but a stored date match remains diagnostic only', async () => {
  const f = await base, resolver = evidence(f.input), ref = resolver.deriveEvidenceRef(f.sourceRef, f.recordId);
  const retained = source(f.input, 'transactions').payload.records[0];
  const resolved = resolver.resolveEvidenceRef(JSON.stringify(ref));
  assert.deepEqual(resolved.record, retained); assert.notEqual(resolved.record, retained);
  assert.equal(ref.record_content_sha256, assessmentEvidenceDigest(retained));
  assert.equal(ref.manifest_sha256, JSON.parse(f.input.context_header_json).selection_input.content_sha256);
  assert.equal(resolved.record.data.raw_projection.source_raw_witness.fields.PropertyAttachedYN.value_text, 'false');
  assert.ok(Object.isFrozen(resolved.record.data.raw_projection.source_raw_witness));
  const command = { version: 1, operation_id: '50000000-0000-4000-8000-000000000001',
    target_ref: resolver.binding.target_ref, expected_context: resolver.binding.context_ref, study_ref: resolver.binding.study_ref,
    expected_generation: '0', expected_predecessor: null, subject_ref: { kind: 'capture_candidate', key: f.recordId },
    claim: { kind: 'closing_date', qualifier: { basis: 'event' }, state: 'known', unknown_reason: null, decision_refs: [],
      value: { date: '2024-03-01', event_evidence_refs: [ref] } }, evidence_refs: [ref], rationale: 'Synthetic exact retained date comparison only.' };
  const bound = resolver.bindCommand(JSON.stringify(command));
  assert.equal(bound.status, 'bound'); assert.equal(bound.claim_observation.status, 'matched');
  assert.equal(bound.claim_observation.source_meaning, 'not_established');
  assert.equal(bound.authority, 'not_established'); assert.equal(bound.apply.status, 'blocked');
  assert.equal(f.f.state.calls.length, 0);
});

test('v3 explicit empty group selection stays empty and retains its independent revision', async () => {
  const input = structuredClone((await base).input);
  input.selection = { revision: 23, included_recorded_group_ids: [] };
  const output = prepare(input);
  assert.deepEqual(output.binding.selection, input.selection);
  assert.equal(output.observations.all.discovery_accounts, 2);
  assert.ok(Object.values(output.observations.selected).every(value => value === 0));
  assert.ok(output.apply.reasons.includes('empty_selection'));
});

test('extra original source-backed transactions retain explicit SQL-null witnesses rather than borrowing the first record', async () => {
  const f = await saleWitnessMeaningFixture({ extraTransactions: [{ source_record_id: '11', sale_id: '21',
    primary_account_id: 'R-001', sale_account_id: 'R-001', source_record_hash: 'c'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-04-01', source_close_date: '2024-04-01', sale_price: '300000', source_current_price: '300000' }] });
  const transactions = rows(f.input, 'transactions'); assert.equal(transactions.length, 2);
  const extra = transactions.find(row => row.data.raw_projection.source_record_id === '11');
  assert.equal(extra.data.raw_projection.source_raw_witness.root_state, 'sql_null');
  assert.equal(extra.data.raw_projection.source_mls_status, null); assert.equal(extra.data.raw_projection.source_row_number, null);
  assert.equal(extra.data.data.cached_mapping_version, 3); assert.equal(extra.data.data.market_eligible, null);
  assert.equal(prepare(f.input).observations.all.canonical_transactions_in_period, 2);
});

test('synthetic query-cell constructor distinguishes missing/null/false/zero/empty without pretending to execute SQL', () => {
  assert.equal(syntheticSaleWitness(undefined).root_state, 'sql_null');
  assert.equal(syntheticSaleWitness(null).root_state, 'json_null');
  const witness = syntheticSaleWitness({ ClosePrice: 0, PropertyAttachedYN: false, Currency: '', LivingArea: null,
    LotSizeArea: [], PrivateRemarks: 'never a selected witness cell' });
  assert.equal(witness.fields.ClosePrice.value_text, '0'); assert.equal(witness.fields.PropertyAttachedYN.value_text, 'false');
  assert.equal(witness.fields.Currency.value_text, ''); assert.equal(witness.fields.LivingArea.state, 'json_null');
  assert.equal(witness.fields.CurrentPrice.state, 'absent'); assert.equal(witness.fields.LotSizeArea.state, 'non_scalar');
  assert.equal(Object.hasOwn(witness.fields, 'PrivateRemarks'), false);
  assert.equal(syntheticSaleWitness({ ClosePrice: 'x'.repeat(513) }).fields.ClosePrice.state, 'oversize');
});

test('actual canonical-legacy mapping3 branch has no invented source witness or raw source cells', async () => {
  const f = await saleWitnessMeaningFixture({ extraTransactions: [{ source_record_id: null, sale_id: '22',
    sale_account_id: 'R-001', sale_closing_date: '2024-04-01', sale_price: '300000',
    sale_source: 'synthetic canonical-only fixture', sale_loaded_at: '2026-09-05T00:00:00.000Z' }] });
  const legacy = rows(f.input, 'transactions').find(row => row.data.data.source_record_id === null);
  assert.ok(legacy); assert.equal(legacy.data.data.cached_mapping_version, 3);
  for (const field of ['source_raw_witness', 'source_mls_status', 'source_row_number']) assert.equal(Object.hasOwn(legacy.data.raw_projection, field), false);
  assert.ok(legacy.data.capability_gaps.includes('source_record_unavailable'));
  assert.equal(legacy.data.data.market_eligible, null);
  assert.equal(prepare(f.input).observations.all.canonical_transactions_in_period, 2);
  assert.equal(prepare(f.input).observations.all.source_records_all_dates, 1);
});

for (const [name, mutate] of [
  ['absent compact metadata', i => { delete i.retained_inputs.acquisition.compact_metadata_json; }],
  ['null compact metadata', i => { i.retained_inputs.acquisition.compact_metadata_json = null; }],
  ['malformed compact JSON', i => { i.retained_inputs.acquisition.compact_metadata_json = '{'; }],
  ['missing compact mapping version', i => setMetadata(i, m => { delete m.mapping_version; })],
  ['unknown compact mapping version', i => setMetadata(i, m => { m.mapping_version = 4; })],
  ['string compact mapping version', i => setMetadata(i, m => { m.mapping_version = '3'; })],
  ['foreign compact reader version', i => setMetadata(i, m => { m.reader_version = 'invented-reader'; })],
  ['mixed source projection version', i => { source(i, 'accounts').payload.projection.definition.mapping_version = 2; }],
  ['missing source projection version', i => { delete source(i, 'accounts').payload.projection.definition.mapping_version; }],
  ['mixed mapped row version', i => { rows(i, 'accounts')[0].data.data.cached_mapping_version = 2; }],
]) test(`v3 refuses ${name} rather than defaulting/relabeling its observations`, async () => {
  const f = await base, changed = structuredClone(f.input); mutate(changed);
  assert.throws(() => previewOf(changed), TypeError);
  assert.throws(() => buildCustomCohortPocketCatalog({ retained_inputs: changed.retained_inputs, preview: f.preview }), TypeError);
  assert.throws(() => prepare(changed));
  assert.throws(() => evidence(changed), { code: 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID', reason: 'retained_input_invalid' });
});

test('relabeling all v2 versions cannot replace the retained dependency graph or invent a v3 original', async () => {
  const old = await oldBase, before = JSON.stringify(old.input), changed = structuredClone(old.input);
  setMetadata(changed, m => { m.mapping_version = 3; });
  for (const entry of sources(changed)) {
    entry.payload.projection.definition.mapping_version = 3;
    for (const row of entry.payload.records) if (row.data.data) row.data.data.cached_mapping_version = 3;
  }
  assert.throws(() => prepare(changed));
  assert.throws(() => evidence(changed), { code: 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID', reason: 'retained_input_invalid' });
  assert.equal(JSON.stringify(old.input), before); assert.equal(prepare(old.input).status, 'incomplete');
});

test('new raw witnesses cannot be substituted under an old context or an existing v3 source hash', async () => {
  const f = await base, old = await oldBase, changed = structuredClone(f.input);
  rows(changed, 'transactions')[0].data.raw_projection.source_raw_witness.fields.ClosePrice.value_text = '999999';
  assert.throws(() => prepare(changed));
  assert.throws(() => evidence(changed), { code: 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID', reason: 'retained_input_invalid' });
  const cross = structuredClone(old.input); cross.retained_inputs = f.input.retained_inputs;
  assert.throws(() => prepare(cross), { code: 'CUSTOM_COHORT_ASSESSMENT_PREPARATION_INVALID', reason: 'retained_evidence_mismatch' });
});
