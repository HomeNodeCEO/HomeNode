import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present,
  buildCustomCohortPocketRecommendationPresentation as compose }
  from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { presentCustomCohortCadEvidence as presentCad } from '../src/services/neighborhoodAssessment/customCohortCadEvidencePresentation.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const FIELDS = ['class_code', 'class_description', 'use_description', 'structure_type', 'built_up'];
const shared = cadEvidenceFixture();
function inputs(f, selection = { revision: 7, pockets: [] }) {
  const retained_inputs = f.input.retained_inputs, context_ref = f.input.expected.context_ref;
  const preview = buildCustomCohortObservationPreview({ retained_inputs, context_ref, selection });
  const expected = { context_ref, selection_revision: selection.revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: { ...f.catalog,
    binding: { context_ref, selection_revision: selection.revision } }, preview, expected });
  const recommendation = buildCustomCohortPocketRecommendation({ retained_inputs, context_ref,
    selection: { revision: selection.revision, included_recorded_group_ids: [] } });
  return { catalog, recommendation, expected };
}

// These hashes were recorded from the actual old presenter BEFORE adding CAD
// presentation. Never regenerate them to admit an accidental legacy change.
for (const [version, factory, hash] of [
  [2, decisionEvidenceFixture, 'ad07d9f27ee1ad1a2f1c1d02d1dab578132c2d506be2dc1d23c770090254725a'],
  [3, saleWitnessMeaningFixture, '872ab8eab1188a91a61039e1e1e1454069c20fb81df000e240ab86b0d9449031'],
]) test(`mapping${version} public recommendation stays byte-identical with no CAD addon`, async () => {
  const result = present(inputs(await factory()));
  assert.equal(Object.hasOwn(result, 'cad_recorded_evidence'), false);
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), hash);
});

test('actual mapping4 capture/persist/reopen presents all accounts independently of selection', async () => {
  const f = await shared, input = inputs(f), result = present(input), cad = result.cad_recorded_evidence;
  assert.equal(cad.mapping_version, 4);
  assert.equal(cad.authority, 'not_established');
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.deepEqual(cad.binding.context_ref, input.expected.context_ref);
  assert.equal(cad.all.member_count, f.input.retained_inputs.spatial.account_ids.length);
  assert.equal(cad.all.member_count, input.catalog.coverage.stock_member_count);
  assert.equal(cad.pockets.reduce((sum, pocket) => sum + pocket.member_count, 0), cad.all.member_count);
  for (const population of [cad.all, ...cad.pockets]) for (const key of FIELDS) {
    const field = population.fields[key];
    assert.equal(field.observed_count + field.partial_count + field.missing_count + field.conflicting_count, population.member_count);
    assert.equal(field.observed_record_count + field.missing_record_count, field.record_count);
    assert.equal(Object.values(field.subject_comparison).reduce((sum, n) => sum + n, 0), population.member_count);
  }
  const second = present(inputs(f, { revision: 8, pockets: [{ id: 'manual-empty', label: 'Empty', account_ids: [] }] }));
  assert.deepEqual(second.cad_recorded_evidence, cad);
  assert.deepEqual(second.pockets, result.pockets);
  assert.deepEqual(result.all, input.recommendation.all);
  assert.deepEqual(result.recommended_recorded_group_ids, input.recommendation.recommended_recorded_group_ids);
  assert.deepEqual(compose({ catalog: input.catalog, expected: input.expected, retained_inputs: f.input.retained_inputs }), result);
});

test('mapping4 SQL-null, blank and false literals remain distinct without reducing the denominator', async () => {
  const result = present(inputs(await cadEvidenceFixture({ parcelOverrides: {
    class_code: null, class_description: '', use_description: '  ', structure_type: null, built_up: false,
  } }))).cad_recorded_evidence;
  const n = result.all.member_count;
  for (const [key, literal] of [['class_code', null], ['class_description', ''], ['use_description', '  '], ['structure_type', null]]) {
    const field = result.all.fields[key];
    assert.equal(field.missing_count, n); assert.equal(field.observed_count, 0);
    assert.deepEqual(field.distribution.entries, [{ literal, account_count: n }]);
    assert.equal(field.subject_comparison.unavailable_count, n);
  }
  assert.equal(result.all.fields.built_up.observed_count, n);
  assert.deepEqual(result.all.fields.built_up.distribution.entries, [{ literal: false, account_count: n }]);
});

test('mapping4 public summary excludes account/source/geometry/MLS details and is detached and frozen', async () => {
  const f = await shared, input = structuredClone(inputs(f));
  input.recommendation.private_original = 'do-not-expose-source';
  const result = present(input), before = JSON.stringify(result);
  for (const key of ['account_id', 'account_ids', 'organization_id', 'report_file_id', 'assignment_file_id',
    'raw_projection', 'source_raw_witness', 'source_record_hash', 'source_record_id', 'stored_geometry_ewkb',
    'county', 'properties', 'source_refs', 'source_snapshots', 'selected', 'material']) {
    assert.equal(before.includes(`"${key}":`), false, key);
  }
  assert.equal(before.includes('do-not-expose-source'), false);
  for (const id of f.input.retained_inputs.spatial.account_ids) assert.equal(before.includes(`"${id}"`), false);
  assert.ok(Object.isFrozen(result.cad_recorded_evidence.all.fields.class_code.distribution.entries));
  input.recommendation.cad_recorded_evidence.all.member_count = 999;
  assert.equal(JSON.stringify(result), before);
});

// These deliberately corrupt the already-built internal addon, not the retained
// originals or their hashes. Presentation must never certify a partial DTO.
const malformed = [
  ['unknown top-level field', cad => { cad.account_ids = ['private']; }],
  ['wrong mapping', cad => { cad.mapping_version = 2; }],
  ['invented authority', cad => { cad.authority = 'verified'; }],
  ['wrong context', cad => { cad.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['missing population', cad => { delete cad.all; }],
  ['missing pocket', cad => { cad.pockets.pop(); }],
  ['duplicate pocket', cad => { cad.pockets[1].id = cad.pockets[0].id; }],
  ['unknown pocket', cad => { cad.pockets[0].id = 'not-in-catalog'; }],
  ['missing field', cad => { delete cad.all.fields.structure_type; }],
  ['invented field', cad => { cad.all.fields.housing_type = cad.all.fields.structure_type; }],
  ['wrong member denominator', cad => { cad.all.member_count++; }],
  ['negative account count', cad => { cad.all.fields.class_code.missing_count = -1; }],
  ['noninteger account count', cad => { cad.all.fields.class_code.observed_count = 1.5; }],
  ['contradictory account partition', cad => { cad.all.fields.class_code.partial_count++; }],
  ['contradictory record partition', cad => { cad.all.fields.class_code.record_count++; }],
  ['contradictory comparison partition', cad => { cad.all.fields.class_code.subject_comparison.different_literal_count++; }],
  ['all/pocket account contradiction', cad => {
    const field = cad.all.fields.class_code; field.observed_count--; field.missing_count++;
  }],
  ['all/pocket comparison contradiction', cad => {
    const field = cad.all.fields.class_code.subject_comparison; field.same_literal_count--; field.different_literal_count++;
  }],
  ['all/pocket record contradiction', cad => {
    const field = cad.all.fields.class_code; field.record_count++; field.observed_record_count++;
  }],
  ['wrong literal scalar type', cad => { cad.all.fields.class_code.distribution.entries[0].literal = { private: true }; }],
  ['wrong boolean literal type', cad => { cad.all.fields.built_up.distribution.entries[0].literal = 'false'; }],
  ['wrong string literal type', cad => { cad.all.fields.structure_type.distribution.entries[0].literal = false; }],
  ['missing literal entry', cad => { cad.all.fields.class_code.distribution.entries = []; }],
  ['duplicate literal entry', cad => { const d = cad.all.fields.class_code.distribution; d.entries.push(d.entries[0]); d.distinct_literal_count++; }],
  ['impossible literal account count', cad => { cad.all.fields.class_code.distribution.entries[0].account_count++; }],
  ['wrong distinct count', cad => { cad.all.fields.class_code.distribution.distinct_literal_count++; }],
  ['complete list claimed missing', cad => { cad.all.fields.class_code.distribution.entries = null; }],
  ['complete list silently marked omitted', cad => {
    const d = cad.all.fields.class_code.distribution; d.status = 'details_unavailable'; d.reason = 'distinct_literal_limit';
  }],
  ['missing comparison cell', cad => { delete cad.all.fields.class_code.subject_comparison.unavailable_count; }],
  ['private comparison field', cad => { cad.all.fields.class_code.subject_comparison.account_ids = ['private']; }],
];
for (const [name, corrupt] of malformed) test(`mapping4 presenter refuses ${name}`, async () => {
  const input = structuredClone(inputs(await shared)); corrupt(input.recommendation.cad_recorded_evidence);
  assert.throws(() => present(input), error => error instanceof TypeError);
});

test('absent optional addon remains an ordinary recommendation, but null is not absence', async () => {
  const input = structuredClone(inputs(await shared));
  delete input.recommendation.cad_recorded_evidence;
  assert.equal(Object.hasOwn(present(input), 'cad_recorded_evidence'), false);
  input.recommendation.cad_recorded_evidence = null;
  assert.throws(() => present(input));
});

test('mapping4 public catalog fallback skips the entire optional recommendation without rebuilding source groups', async () => {
  const input = structuredClone(inputs(await shared));
  input.catalog.catalog_complete = false;
  assert.equal(compose({ catalog: input.catalog, expected: input.expected, retained_inputs: null }), null);
});

function cadInput(input) {
  return { evidence: input.recommendation.cad_recorded_evidence,
    expected: { context_ref: input.expected.context_ref, captured_at: input.recommendation.binding.captured_at },
    pockets: input.recommendation.pockets.map(p => ({ id: p.id, member_count: p.result.member_count })),
    member_count: input.recommendation.all.member_count, in_discovery: input.recommendation.subject.in_discovery,
    maximumBytes: 512_000 };
}

test('complete distributions cannot drop observed accounts even when all/pocket frequency totals agree', async () => {
  // Synthetic presentation-only grouping of the two genuinely retained fixture
  // accounts. No new source observations/capture hashes are manufactured.
  const input = structuredClone(cadInput(inputs(await shared)));
  input.pockets = [{ id: 'synthetic:all', member_count: input.member_count }];
  input.evidence.pockets = [{ id: 'synthetic:all', ...structuredClone(input.evidence.all) }];
  assert.equal(presentCad(input).all.fields.class_code.observed_count, 2);
  for (const p of [input.evidence.all, ...input.evidence.pockets]) p.fields.class_code.distribution.entries[0].account_count = 1;
  assert.throws(() => presentCad(input), /distribution/);
});

test('complete distributions cannot claim same/different comparisons unsupported by their literal frequencies', async () => {
  const original = cadInput(inputs(await shared));
  for (const direction of ['same', 'different']) {
    const input = structuredClone(original);
    if (direction === 'same') input.evidence.subject.fields.class_code.literal = 'not present in retained distribution';
    else for (const p of [input.evidence.all, ...input.evidence.pockets]) {
      Object.assign(p.fields.class_code.subject_comparison, { same_literal_count: 0, different_literal_count: p.member_count });
    }
    assert.throws(() => presentCad(input), /comparison/);
  }
});

test('display byte pressure drops every distribution list together, retaining all counts and groups', async () => {
  const f = await cadEvidenceFixture({ parcelOverrides: { class_code: 'C'.repeat(1000),
    class_description: 'D'.repeat(1000), use_description: 'U'.repeat(1000), structure_type: 'S'.repeat(1000) } });
  const input = cadInput(inputs(f)), full = presentCad(input), expected = structuredClone(full);
  for (const population of [expected.all, ...expected.pockets]) for (const field of Object.values(population.fields)) {
    Object.assign(field.distribution, { status: 'details_unavailable', reason: 'presentation_byte_limit', entries: null });
  }
  const maximumBytes = Buffer.byteLength(JSON.stringify(expected));
  assert.ok(maximumBytes < Buffer.byteLength(JSON.stringify(full)));
  const bounded = presentCad({ ...input, maximumBytes });
  assert.equal(bounded.status, 'available'); assert.deepEqual(bounded, expected);
  assert.equal(bounded.all.member_count, full.all.member_count);
  assert.deepEqual(bounded.pockets.map(p => [p.id, p.member_count]), full.pockets.map(p => [p.id, p.member_count]));
  assert.deepEqual(input.evidence.all.fields.class_code.distribution.status, 'complete', 'original input never mutated');
});

test('fixed-count byte pressure returns one bound unavailable addon, never partial populations', async () => {
  const input = cadInput(inputs(await shared)), full = presentCad(input);
  const expected = { ...Object.fromEntries(['cad_baseline_version', 'mapping_version', 'basis', 'authority', 'binding',
    'comparison_basis', 'temporal_basis'].map(key => [key, full[key]])),
  status: 'details_unavailable', reason: 'presentation_byte_limit', member_count: input.member_count, pocket_count: input.pockets.length };
  const maximumBytes = Buffer.byteLength(JSON.stringify(expected));
  assert.deepEqual(presentCad({ ...input, maximumBytes }), expected);
  assert.throws(() => presentCad({ ...input, maximumBytes: maximumBytes - 1 }), /output_byte_limit/);
  for (const invalid of [0, -1, 1.5, '512000', 512_001]) assert.throws(() => presentCad({ ...input, maximumBytes: invalid }));
  const malformed = structuredClone(input); delete malformed.evidence.pockets[0].fields.built_up;
  assert.throws(() => presentCad({ ...malformed, maximumBytes }), /keys/,
    'capacity fallback must not conceal invalid internal evidence');
});

/** Real owner and graph repositories over explicit bounded SQL-result fakes.
 * Only target/context lookup rows and transaction mechanics are faked here;
 * original source blobs are those captured/persisted/reopened by the fixture.
 * This is not PostgreSQL/native execution or a production dataset grant.
 */
async function ownerFixture({ denyExposure, denyVisit = 1, changed = false } = {}) {
  const f = await cadEvidenceFixture(), input = f.input, retained = input.retained_inputs;
  const t = retained.subject.target, actor = retained.acquisition_intent.body.actor_user_id;
  const header = await f.base.store.put(input.context_header_json);
  const contextRow = { ...input.expected.context_ref, header_content_sha256: header.content_sha256,
    header_canonical_utf8_bytes: header.canonical_utf8_bytes };
  const calls = [], reads = [], releases = [], policies = [], visits = new Map();
  const row = value => ({ rowCount: 1, rows: [value] });
  const owner = createCustomCohortContextCapture({ pool: { async connect() { return {
    release(error) { releases.push(error); }, async query({ text, values }) {
      calls.push(text);
      if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(text)) return { rowCount: 0, rows: [] };
      if (text.includes('custom-cohort-capture:assignment')) return row({ ...t,
        assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null });
      if (text.includes('custom-cohort-capture:report')) return row(t);
      if (text.includes('custom-cohort-context:transaction')) return row({ transaction_id: '123456789' });
      if (text.includes('custom-cohort-context:target')) return row({ id: t.report_file_id });
      if (text.includes('custom-cohort-context:read')) return row(contextRow);
      if (text.includes('neighborhood-cohort-blob:read')) reads.push(values[1]);
      return f.base.client.query(text, values);
    },
  }; } }, authorizeMarketData: async (_client, _auth, context, purpose, options) => {
    assert.equal(context.target.report_file_id, t.report_file_id);
    assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
    assert.equal(options.retention, true);
    const visit = (visits.get(options.exposure) ?? 0) + 1; visits.set(options.exposure, visit);
    policies.push({ exposure: options.exposure, read_count: reads.length,
      commits: calls.filter(sql => sql === 'COMMIT').length, call_index: calls.length });
    const denied = options.exposure === denyExposure && visit === denyVisit;
    if (denied && !changed) return { allowed: false };
    return { allowed: true, ...retained.acquisition.captured_query_request.market_decision,
      ...(denied ? { policy_revision: 'synthetic-revised-denial' } : {}) };
  } });
  const request = { auth: { userId: actor, organizations: [{ organizationId: t.organization_id, roles: ['appraiser'] }] },
    accountId: t.account_id, assignmentFileId: t.assignment_file_id, contextRef: input.expected.context_ref,
    selection: { revision: 7, pockets: [] }, includeRecommendation: true };
  return { f, owner, request, calls, reads, releases, policies };
}

function assertReadOnlyProximityPhase(f, finalOutcome) {
  const starts = f.calls.flatMap((sql, index) => sql.startsWith('BEGIN ') ? [index] : []);
  assert.deepEqual(starts.map(index => f.calls[index]), ['BEGIN ISOLATION LEVEL READ COMMITTED',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL READ COMMITTED']);
  assert.deepEqual(f.calls.filter(sql => sql === 'COMMIT' || sql === 'ROLLBACK'), ['COMMIT', 'COMMIT', finalOutcome]);
  const computation = f.calls.slice(starts[1], starts[2]);
  assert.ok(computation.every(sql => /^(BEGIN |SET LOCAL |COMMIT$)/.test(sql)),
    'the old fixture EWKB is unavailable; its extra read-only phase cannot reload current source or subject rows');
  assert.deepEqual(f.policies.map(policy => policy.commits), [0, 0, ...f.policies.slice(2).map(() => 2)],
    'initial authorization precedes the retained computation; final authorization follows its completed transaction');
  for (const policy of f.policies.slice(2)) assert.ok(f.calls.slice(starts[2], policy.call_index)
    .some(sql => sql.includes('custom-cohort-subject:sections')), 'fresh subject material is compared before each final grant');
}

test('actual owner mapping4 catalog addon requires both unchanged existing exposures at initial and final fences', async () => {
  const f = await ownerFixture(), result = await f.owner.catalog(f.request);
  assert.equal(result.recommendation.cad_recorded_evidence.mapping_version, 4);
  assert.deepEqual(f.policies.map(p => p.exposure), ['report_observation_catalog', 'report_observation_summary',
    'report_observation_catalog', 'report_observation_summary']);
  assertReadOnlyProximityPhase(f, 'COMMIT');
  for (const source of f.f.input.retained_inputs.acquisition.capture_result.source_capture.sources) {
    const hash = createHash('sha256').update(json(source.payload)).digest('hex');
    assert.ok(f.reads.includes(hash), 'authorized success really reopens each retained source payload');
  }
  assert.deepEqual(f.releases, [undefined, undefined, undefined]);
});

for (const exposure of ['report_observation_catalog', 'report_observation_summary']) {
  test(`mapping4 ${exposure} initial denial prevents full retained source loads`, async () => {
    const f = await ownerFixture({ denyExposure: exposure });
    await assert.rejects(f.owner.catalog(f.request), error => error.reason === 'market_data_access_denied');
    assert.equal(f.reads.length, f.policies.at(-1).read_count, 'no graph payload read after denied policy');
    const sourceHashes = f.f.input.retained_inputs.acquisition.capture_result.source_capture.sources
      .map(source => createHash('sha256').update(json(source.payload)).digest('hex'));
    assert.equal(f.reads.some(hash => sourceHashes.includes(hash)), false);
    assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 0);
    assert.equal(f.calls.filter(sql => sql === 'ROLLBACK').length, 1);
    assert.ok(!f.calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
    assert.deepEqual(f.releases, [undefined]);
  });
  for (const changed of [false, true]) test(`mapping4 ${exposure} final ${changed ? 'revision change' : 'revocation'} refuses the complete response`, async () => {
    const f = await ownerFixture({ denyExposure: exposure, denyVisit: 2, changed });
    await assert.rejects(f.owner.catalog(f.request), error => error.reason === (changed ? 'market_policy_changed' : 'market_data_access_denied'));
    assertReadOnlyProximityPhase(f, 'ROLLBACK');
    assert.deepEqual(f.releases, [undefined, undefined, undefined]);
  });
}
