import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortAssessmentPreparation as prepare } from '../src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js';
import { createCustomCohortDecisionEvidenceResolver as evidence } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

// Captured from the genuine existing fixtures BEFORE the mapping4 changes.
// Do not regenerate these simply because a new mapper has been installed.
const OLD_HASHES = {
  2: { input: '7e444435e236e5e30e1179b71365ce252fb960ea5b3b7091e2117c5407947861',
    preview: '775e607b5273e6278b35388c0e3e4ab6f840ea4fb6137977be9280d3fe07bdf3',
    catalog: '7f1b56bd338bf6e098621f5cb549dd3adab2aa85b610d6d6d252a3860f164087',
    preparation: 'bfe90cf683769fcb5b138feb729886828cf633c3adf65ea6164051d88b592da2' },
  3: { input: '04ef7f6c4cef434cde7eee982c3160e26f4ce66a77fed97d55f9030e44d60c92',
    preview: '3c8d6de37fa9eca59a3f07af8c86106fefb77b378b0a94f8fe1ac06c404c3934',
    catalog: 'b887c4ccbe910c95e682e673c2ccf8d2c3117f0f48fdd207fedade6689b7e5d5',
    preparation: 'b0de20ae5ce7f8d4e140063e5029bef61f964f8936fd9a30d0f30894397eec26' },
};
const FIELDS = ['class_code', 'class_description', 'use_description', 'structure_type', 'built_up'];
const getSources = input => input.retained_inputs.acquisition.capture_result.source_capture.sources;
const source = (input, role) => getSources(input).find(s => s.payload.projection.definition.role === role);
const rows = (input, role) => getSources(input).filter(s => s.payload.projection.definition.role === role).flatMap(s => s.payload.records);
const previewOf = input => buildCustomCohortObservationPreview({ context_ref: input.expected.context_ref,
  retained_inputs: input.retained_inputs, selection: { revision: input.selection.revision, pockets: [] } });
const metadata = (input, change) => {
  const a = input.retained_inputs.acquisition, value = JSON.parse(a.compact_metadata_json);
  change(value); a.compact_metadata_json = JSON.stringify(value);
};
let shared;
const fixture = () => shared ??= cadEvidenceFixture();

for (const [version, factory] of [[2, decisionEvidenceFixture], [3, saleWitnessMeaningFixture]]) {
  test(`mapping${version} full capture, preview, catalog and preparation hashes remain pinned`, async () => {
    const old = await factory();
    const actual = { input: digest(old.input), preview: digest(old.preview), catalog: digest(old.catalog),
      preparation: digest(prepare(old.input)) };
    assert.deepEqual(actual, OLD_HASHES[version]);
    await fixture();
    assert.deepEqual({ input: digest(old.input), preview: digest(old.preview), catalog: digest(old.catalog),
      preparation: digest(prepare(old.input)) }, OLD_HASHES[version]);
    assert.equal(Object.hasOwn(rows(old.input, 'parcels')[0].data.raw_projection, 'class_code'), false);
  });
}

test('actual original mapping4 capture persists and reopens with exact row/chunk identities', async () => {
  const f = await fixture(), captured = f.input.retained_inputs.acquisition.capture_result;
  assert.deepEqual(f.input.retained_inputs, f.originalRetained);
  assert.equal(JSON.parse(f.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 4);
  assert.equal(captured.reader_version, 'local-capture-v3'); // Existing reader envelope, additive row profile only.
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(captured.query_evidence)).status, 'syntax_valid');
  const snapshots = new Map(captured.source_capture.source_snapshots.map(s => [s.id, s]));
  for (const s of getSources(f.input)) {
    assert.equal(s.payload.projection.definition.mapping_version, 4);
    assert.equal(snapshots.get(s.id).content_sha256, digest(s.payload));
    for (const row of s.payload.records) if (row.data.raw_projection) {
      assert.equal(row.data.data.cached_mapping_version, 4);
      assert.equal(row.data.data.cached_projection_sha256, digest({ mapping_version: 4,
        projection_kind: row.data.data.cached_projection_kind, raw_projection: row.data.raw_projection }));
    }
  }
  assert.ok(Object.isFrozen(f.input.retained_inputs));
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, f.captureResult), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, captured), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
  assert.equal(f.marketPurposes.length, 1); // Access prepare authorizes once; the reader consumes its issued grant.
  assert.ok(f.marketPurposes.every(p => !Object.hasOwn(p, 'source_projection')));
  const parcelQuery = f.queryCalls.find(sql => sql.includes('neighborhood-cache:parcels'));
  for (const field of FIELDS) assert.ok(parcelQuery.includes(field));
  assert.ok(f.queryCalls.every(sql => !sql.includes('raw_payload')));
});

test('new CAD strings/false remain exact observations, not historical housing eligibility', async () => {
  const f = await fixture(), row = rows(f.input, 'parcels')[0].data;
  assert.equal(row.raw_projection.class_code, '  A1 ');
  assert.equal(row.raw_projection.class_description, '  Residential class observation  ');
  assert.equal(row.raw_projection.use_description, 'Unknown retained use');
  assert.equal(row.raw_projection.structure_type, 'Provider-specific structure');
  assert.equal(row.raw_projection.built_up, false);
  assert.equal(row.data.housing_type, null); assert.equal(row.data.historical_support, 'unknown');
  assert.equal(row.data.valid_from, null); assert.equal(row.data.valid_to, null);
  assert.ok(row.capability_gaps.includes('housing_classification_unverified'));
  assert.equal(f.preview.all.transactions.market_eligible_count, null);
  assert.equal(f.preview.authority, 'not_established'); assert.equal(f.preview.apply.status, 'blocked');
  const output = prepare(f.input);
  assert.equal(output.status, 'incomplete'); assert.equal(output.assessment, null); assert.equal(output.publication, null);
  assert.equal(output.selection_resolution.housing_and_competitive_eligibility, 'not_established');
  assert.equal(output.selection_resolution.legal_subdivision_identity, 'not_established');
  assert.deepEqual(f.catalog.pockets, f.base.catalog.pockets);
  assert.deepEqual(output.observations, prepare(f.base.input).observations);
  const recommendation = buildCustomCohortPocketRecommendation({ context_ref: f.input.expected.context_ref,
    retained_inputs: f.input.retained_inputs, selection: f.input.selection });
  assert.equal(recommendation.authority, 'not_established'); assert.equal(recommendation.apply.status, 'blocked');
  assert.equal(f.base.f.state.calls.length, 0);
});

test('all explicit SQL-null CAD cells survive capture; absence does not become null', async () => {
  const f = await cadEvidenceFixture({ parcelOverrides: Object.fromEntries(FIELDS.map(key => [key, null])) });
  for (const row of rows(f.input, 'parcels')) for (const key of FIELDS) {
    assert.ok(Object.hasOwn(row.data.raw_projection, key)); assert.equal(row.data.raw_projection[key], null);
  }
  assert.equal(prepare(f.input).status, 'incomplete');
  for (const field of FIELDS) await assert.rejects(cadEvidenceFixture({ omitParcelFields: [field] }));
});

test('blank CAD strings and true local built-up retain their literal states without classifying a completed home', async () => {
  const f = await cadEvidenceFixture({ parcelOverrides: Object.fromEntries(FIELDS.map(key => [key, key === 'built_up' ? true : ''])) });
  const row = rows(f.input, 'parcels')[0].data;
  for (const field of FIELDS) assert.equal(row.raw_projection[field], field === 'built_up' ? true : '');
  assert.equal(row.data.housing_type, null); assert.equal(row.data.historical_support, 'unknown');
  assert.equal(prepare(f.input).status, 'incomplete');
});

test('mapping4 source-backed and legacy sales retain v2 meaning without sale-witness fields', async () => {
  const f = await cadEvidenceFixture({ legacy: true }), all = rows(f.input, 'transactions');
  assert.equal(all.length, 2);
  const current = all.find(r => r.data.data.source_record_id !== null), old = rows(f.base.input, 'transactions')[0];
  const semantic = mapped => {
    const { cached_mapping_version, cached_projection_sha256, ...rest } = mapped.data;
    return rest;
  };
  assert.deepEqual(semantic(current.data), semantic(old.data));
  assert.deepEqual(current.data.raw_projection, old.data.raw_projection);
  assert.deepEqual(current.data.capability_gaps, old.data.capability_gaps);
  for (const row of all) {
    assert.equal(row.data.data.cached_mapping_version, 4); assert.equal(row.data.data.market_eligible, null);
    assert.equal(row.data.data.gla_sqft_at_sale, null);
    for (const key of ['source_raw_witness', 'source_mls_status', 'source_row_number']) assert.equal(Object.hasOwn(row.data.raw_projection, key), false);
  }
  assert.ok(all.find(r => r.data.data.source_record_id === null).data.capability_gaps.includes('source_record_unavailable'));
  assert.equal(prepare(f.input).observations.all.canonical_transactions_in_period, 2);
  assert.equal(prepare(f.input).observations.all.source_records_all_dates, 1);
  assert.equal(f.preview.all.source_reported.metrics.days_on_market.low, 0);
});

test('decision evidence resolves the full original CAD record without interpreting housing strings', async () => {
  const f = await fixture(), resolver = evidence(f.input), s = source(f.input, 'parcels'), original = s.payload.records[0];
  const ref = resolver.deriveEvidenceRef(s.id, original.record_id), resolved = resolver.resolveEvidenceRef(JSON.stringify(ref));
  assert.deepEqual(resolved.record, original); assert.notEqual(resolved.record, original);
  assert.equal(ref.record_content_sha256, digest(original));
  const account = original.data.raw_projection.account_id;
  const command = { version: 1, operation_id: '50000000-0000-4000-8000-000000000004',
    target_ref: resolver.binding.target_ref, expected_context: resolver.binding.context_ref, study_ref: resolver.binding.study_ref,
    expected_generation: '0', expected_predecessor: null, subject_ref: { kind: 'stock_member', key: account },
    claim: { kind: 'housing_at_date', qualifier: { basis: 'evaluated_date', evaluated_on: f.input.retained_inputs.subject.effective_date },
      state: 'unknown', value: null, unknown_reason: 'unsupported_mapping', decision_refs: [] },
    evidence_refs: [ref], rationale: 'Synthetic current CAD field review; housing meaning remains unsupported.' };
  const bound = resolver.bindCommand(JSON.stringify(command));
  assert.equal(bound.status, 'bound'); assert.equal(bound.claim_observation.status, 'not_evaluated');
  assert.equal(bound.command.claim.state, 'unknown'); assert.equal(bound.apply.status, 'blocked');
  assert.equal(bound.authority, 'not_established'); assert.equal(f.base.f.state.calls.length, 0);
});

test('mapping4 explicit empty selection stays empty with its exact independent revision', async () => {
  const changed = structuredClone((await fixture()).input);
  changed.selection = { revision: 23, included_recorded_group_ids: [] };
  const output = prepare(changed);
  assert.deepEqual(output.binding.selection, changed.selection);
  assert.equal(output.observations.all.discovery_accounts, 2);
  assert.ok(Object.values(output.observations.selected).every(value => value === 0));
  assert.ok(output.apply.reasons.includes('empty_selection'));
});

for (const [name, mutate] of [
  ['unknown version', i => metadata(i, m => { m.mapping_version = 99; })],
  ['string version', i => metadata(i, m => { m.mapping_version = '4'; })],
  ['mixed old reader', i => metadata(i, m => { m.reader_version = 'local-capture-v2'; })],
  ['mixed projection', i => { source(i, 'parcels').payload.projection.definition.mapping_version = 2; }],
  ['mixed mapped row', i => { rows(i, 'parcels')[0].data.data.cached_mapping_version = 3; }],
  ['changed class code', i => { rows(i, 'parcels')[0].data.raw_projection.class_code = 'changed'; }],
  ['removed built-up field', i => { delete rows(i, 'parcels')[0].data.raw_projection.built_up; }],
  ['extra private field', i => { rows(i, 'parcels')[0].data.raw_projection.owner_private_notes = 'not retained'; }],
  ['invented sale witness', i => { rows(i, 'transactions')[0].data.raw_projection.source_raw_witness = {}; }],
  ['changed normalized housing', i => { rows(i, 'parcels')[0].data.data.housing_type = 'single_family_detached'; }],
  ['changed target', i => { i.expected.target.account_id = 'another-account'; }],
  ['changed context digest', i => { i.expected.context_ref.context_sha256 = 'f'.repeat(64); }],
]) test(`mapping4 rejects ${name} under an existing retained context`, async () => {
  const changed = structuredClone((await fixture()).input); mutate(changed);
  assert.throws(() => prepare(changed));
  assert.throws(() => evidence(changed), { code: 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID', reason: 'retained_input_invalid' });
});

test('mapping4 identity cannot be manufactured by relabeling a mapping2 capture', async () => {
  const old = await decisionEvidenceFixture(), changed = structuredClone(old.input);
  metadata(changed, m => { m.mapping_version = 4; });
  for (const s of getSources(changed)) {
    s.payload.projection.definition.mapping_version = 4;
    for (const row of s.payload.records) if (row.data.data) row.data.data.cached_mapping_version = 4;
  }
  assert.throws(() => prepare(changed)); assert.throws(() => evidence(changed));
  assert.equal(digest(old.input), OLD_HASHES[2].input);
  const fresh = await fixture(), substituted = structuredClone(old.input);
  substituted.retained_inputs = fresh.input.retained_inputs;
  assert.throws(() => prepare(substituted), { code: 'CUSTOM_COHORT_ASSESSMENT_PREPARATION_INVALID', reason: 'retained_evidence_mismatch' });
});

test('standalone observation and catalog consumers reject a mixed row version instead of returning a partial group', async () => {
  const f = await fixture(), changed = structuredClone(f.input);
  rows(changed, 'parcels')[0].data.data.cached_mapping_version = 2;
  assert.throws(() => previewOf(changed), TypeError);
  assert.throws(() => buildCustomCohortPocketCatalog({ retained_inputs: changed.retained_inputs, preview: f.preview }), TypeError);
});
