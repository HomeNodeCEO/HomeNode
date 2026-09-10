import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortCurrentCadBaseline as baseline, CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITS as L,
  CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS as FIELDS } from '../src/services/neighborhoodAssessment/customCohortCurrentCadBaseline.js';
import { buildCustomCohortPocketRecommendation as recommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCadEvidenceParcelRow, mapCadEvidenceAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const SUBJECT = '0000123456789';
const CAD = { class_code: ' A1 ', class_description: 'Recorded residential', use_description: 'Single family',
  structure_type: 'Detached?', built_up: false };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ERROR = reason => error => error.code === 'CUSTOM_COHORT_CURRENT_CAD_BASELINE_INVALID' && error.reason === reason;
let retained;
const actual = () => retained ??= cadEvidenceFixture();
const kernel = f => recommendation({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs, selection: f.input.selection });
const groupsOf = catalog => [...catalog.pockets, ...(catalog.unassigned.member_count
  ? [{ id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }] : [])];
const argsOf = f => ({ retained_inputs: f.input.retained_inputs, preview: f.preview, groups: groupsOf(f.catalog) });
const field = (result, key = 'class_code') => result.all.fields[key];

// Focused pure-consumer cases rebuild REAL mapping4 rows, source chunks and the
// existing numeric preview. Their synthetic query graph is NOT a new original
// acquisition/owner admission. The separate actual fixture test below exercises
// genuine installed reader acquisition -> persistence -> reopen -> recommendation.
async function fixture({ accounts = [SUBJECT, 'B'], parcels, counties = {}, accountRows,
  groups = [{ id: 'recorded-test:all', account_ids: accounts }] } = {}) {
  const f = await actual(), input = structuredClone(f.input.retained_inputs);
  const scope = { ...input.acquisition.capture_result.source_capture.scope };
  const parcelRows = (parcels ?? accounts.map(account_id => ({ account_id }))).map((row, index) => ({
    object_id: String(index + 1), residential_year_built: 2000, residential_area_sqft: '1800',
    parcel_area_sqft: '6000', current_market_value: '300000', land_use_category: 'one_unit', ...CAD, ...row,
  }));
  const wrap = (rows, mapper, role) => rows.map((row, index) => {
    const data = mapper(row); return { record_id: `${role}:${index}:${data.record_id}`, data };
  });
  const roles = {
    selection: accounts.map(account_id => ({ record_id: `selection:${account_id}`, data: { account_id } })),
    parcels: wrap(parcelRows, mapCadEvidenceParcelRow, 'parcel'),
    accounts: wrap(accountRows ?? accounts.map(account_id => ({ account_id, county: Object.hasOwn(counties, account_id) ? counties[account_id] : 'Dallas',
      subdivision: 'Synthetic group' })), mapCadEvidenceAccountRow, 'account'), transactions: [], sale_links: [], gis_sync: [],
  };
  const now = input.acquisition.capture_result.captured_at;
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'synthetic-cad-context-v4', content_sha256: 'a'.repeat(64), captured_at: now,
      visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'synthetic-cad-context-v4',
      valid_from: null, valid_to: null, observed_at: now, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'synthetic-cad-context-v4', definition: { role, mapping_version: 4 },
      complete: true, input_row_count: records.length, output_record_count: records.length }, records,
  })) });
  assert.equal(capture.status, 'ready');
  input.acquisition.capture_result.source_capture = capture;
  input.acquisition.captured_query_request.account_ids = [...accounts];
  input.spatial.account_ids = [...accounts];
  input.spatial.parcels = parcelRows.map(row => ({ object_id: row.object_id, account_id: row.account_id }));
  const preview = buildCustomCohortObservationPreview({ context_ref: f.input.expected.context_ref, retained_inputs: input,
    selection: { revision: 1, pockets: [] } });
  return { retained_inputs: input, preview, groups: structuredClone(groups) };
}
function verifyCounts(result) {
  for (const population of [result.all, ...result.pockets]) for (const cell of Object.values(population.fields)) {
    assert.equal(cell.observed_count + cell.partial_count + cell.missing_count + cell.conflicting_count, population.member_count);
    assert.equal(cell.observed_record_count + cell.missing_record_count, cell.record_count);
    assert.equal(Object.values(cell.subject_comparison).reduce((sum, value) => sum + value, 0), population.member_count);
    if (cell.distribution.status === 'complete') {
      assert.equal(cell.distribution.entries.length, cell.distribution.distinct_literal_count);
      assert.ok(cell.distribution.entries.every(entry => entry.account_count > 0 && entry.account_count <= population.member_count));
    } else assert.equal(cell.distribution.entries, null);
  }
  assert.equal(result.pockets.reduce((sum, group) => sum + group.member_count, 0), result.all.member_count);
}

test('mapping4 housing recommendation preserves prior physical factors and exact literal baseline', async () => {
  const f = await actual(), before = JSON.stringify(f.input), calls = f.base.f.state.calls.length;
  const result = kernel(f), evidence = result.cad_recorded_evidence;
  // Recorded from V before housing interpretation; only the mapping4 wrapper
  // and new housing factor may change. Mapping2/3 full-byte goldens stay below.
  assert.equal(hash(result.properties.map(({ account_id, factors }) => ({ account_id,
    gla: factors.gla, age: factors.age, site_size: factors.site_size }))),
  '640a32fba16c73de8ea06e3fffca9e042e6409151a0a82c58c92ec10b3a45311');
  assert.equal(hash(evidence), '7309d3214adf0628b896d12bb9314836ecd1e5e7c2bdeb42a9654c36ac9b5692');
  assert.equal(result.policy.revision, 3);
  assert.equal(result.evidence_mode, 'recorded_housing_only');
  assert.deepEqual(evidence, baseline(argsOf(f))); verifyCounts(evidence);
  assert.equal(evidence.cad_baseline_version, 1); assert.equal(evidence.mapping_version, 4);
  assert.equal(evidence.binding.captured_at, result.binding.captured_at);
  assert.deepEqual(evidence.binding.context_ref, result.binding.context_ref);
  assert.deepEqual(evidence.all.fields.class_code.distribution.entries, [{ literal: '  A1 ', account_count: 2 }]);
  assert.deepEqual(evidence.all.fields.built_up.distribution.entries, [{ literal: false, account_count: 2 }]);
  assert.equal(evidence.subject.fields.built_up.literal, false);
  assert.equal(evidence.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.equal(JSON.stringify(f.input), before); assert.equal(f.base.f.state.calls.length, calls);
});

for (const [version, factory, expected] of [
  [2, decisionEvidenceFixture, '78860738699f476933619fc5b5378bc3fe496ed007e22f5334b29d9e6060b2a2'],
  [3, saleWitnessMeaningFixture, '19afa6d54f9a425f4420aaf53b3d928f5ebdacc8bbdfdde20663012f2f953661'],
]) test(`mapping${version} recommendation exact bytes stay pinned and addon is absent, not null`, async () => {
  const f = await factory(), result = kernel(f);
  assert.equal(hash(result), expected); assert.equal(Object.hasOwn(result, 'cad_recorded_evidence'), false);
  assert.equal(baseline(argsOf(f)), null);
});

test('complete/partial/missing/conflicting states partition every account including no parcel rows', async () => {
  const f = await fixture({ accounts: [SUBJECT, 'B', 'C', 'D', 'E'], parcels: [
    { account_id: SUBJECT }, { account_id: 'B', class_code: null },
    { account_id: 'C' }, { account_id: 'C', class_code: '' },
    { account_id: 'D' }, { account_id: 'D', class_code: 'B2' },
  ] });
  const result = baseline(f), cell = field(result); verifyCounts(result);
  assert.deepEqual([cell.observed_count, cell.partial_count, cell.missing_count, cell.conflicting_count], [1, 1, 2, 1]);
  assert.deepEqual(cell.subject_comparison, { same_literal_count: 1, different_literal_count: 0, unavailable_count: 4 });
  assert.equal(cell.record_count, 6); assert.equal(cell.observed_record_count, 4); assert.equal(cell.missing_record_count, 2);
  assert.deepEqual(cell.distribution.entries, [{ literal: ' A1 ', account_count: 3 }, { literal: '', account_count: 1 },
    { literal: 'B2', account_count: 1 }, { literal: null, account_count: 1 }]);
  assert.match(cell.distribution.basis, /nonexclusive/);
});

test('raw null/blank/whitespace/zero-like/unknown literals survive exactly without provider vocabulary guesses', async () => {
  const values = [null, '', '  ', '0', 'unknown', ' A1 ', 'a1'];
  const accounts = values.map((_, index) => index ? `A-${index}` : SUBJECT);
  const result = baseline(await fixture({ accounts, parcels: values.map((class_code, i) => ({ account_id: accounts[i], class_code })) }));
  assert.equal(field(result).missing_count, 3); assert.equal(field(result).observed_count, 4);
  assert.deepEqual(new Set(field(result).distribution.entries.map(row => row.literal)), new Set(values));
  assert.equal(result.subject.fields.class_code.state, 'missing'); assert.equal(result.subject.fields.class_code.literal, null);
  assert.equal(field(result).subject_comparison.unavailable_count, values.length); verifyCounts(result);
});

test('built_up false is observed, not missing or proof of house completion; null remains missing', async () => {
  const result = baseline(await fixture({ accounts: [SUBJECT, 'B', 'C'], parcels: [
    { account_id: SUBJECT, built_up: false }, { account_id: 'B', built_up: true }, { account_id: 'C', built_up: null },
  ] }));
  const cell = field(result, 'built_up'); assert.match(cell.label, /Local.*not house completion/);
  assert.deepEqual(cell.distribution.entries, [{ literal: false, account_count: 1 }, { literal: null, account_count: 1 }, { literal: true, account_count: 1 }]);
  assert.deepEqual(cell.subject_comparison, { same_literal_count: 1, different_literal_count: 1, unavailable_count: 1 });
});

test('exact literal comparisons neither normalize codes nor cross county scope', async () => {
  const accounts = [SUBJECT, 'B', 'C', 'D', 'E'];
  const result = baseline(await fixture({ accounts, counties: { C: 'Collin', D: null, E: 'dallas' }, parcels: [
    { account_id: SUBJECT }, { account_id: 'B', class_code: 'A1' }, { account_id: 'C' }, { account_id: 'D' }, { account_id: 'E' },
  ] }));
  assert.deepEqual(field(result).subject_comparison, { same_literal_count: 1, different_literal_count: 1, unavailable_count: 3 });
  assert.equal(result.subject.county_state, 'observed'); assert.match(result.comparison_basis, /not_housing_similarity/);
});

for (const [name, rows, state] of [
  ['partial', [{ account_id: SUBJECT, county: 'Dallas' }, { account_id: SUBJECT, county: null }], 'partial'],
  ['conflicting', [{ account_id: SUBJECT, county: 'Dallas' }, { account_id: SUBJECT, county: 'Collin' }], 'conflicting'],
  ['missing', [{ account_id: SUBJECT }], 'missing'],
]) test(`subject ${name} county makes every comparison unavailable`, async () => {
  const result = baseline(await fixture({ accountRows: [...rows, { account_id: 'B', county: 'Dallas' }] }));
  assert.equal(result.subject.county_state, state);
  for (const cell of Object.values(result.all.fields)) assert.equal(cell.subject_comparison.unavailable_count, 2);
});

test('partial subject preserves sole literal but cannot support a match; conflicting subject exposes no chosen literal', async () => {
  for (const [value, state, literal] of [[null, 'partial', ' A1 '], ['B2', 'conflicting', null]]) {
    const result = baseline(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: SUBJECT, class_code: value }, { account_id: 'B' }] }));
    assert.deepEqual(result.subject.fields.class_code, { state, literal });
    assert.equal(field(result).subject_comparison.unavailable_count, 2);
  }
});

test('subject outside discovery remains unavailable without inventing a CAD identity from saved material', async () => {
  const result = baseline(await fixture({ accounts: ['B', 'C'] }));
  assert.equal(result.subject.in_discovery, false); assert.equal(result.subject.county_state, 'missing');
  for (const cell of Object.values(result.subject.fields)) assert.deepEqual(cell, { state: 'missing', literal: null });
  for (const cell of Object.values(result.all.fields)) assert.equal(cell.subject_comparison.unavailable_count, 2);
});

test('repeated rows count once per account/literal while complete distinct rows remain conflicting', async () => {
  const result = baseline(await fixture({ parcels: [{ account_id: SUBJECT }, { account_id: 'B' }, { account_id: 'B' }, { account_id: 'B', class_code: 'B2' }] }));
  assert.equal(field(result).record_count, 4);
  assert.deepEqual(field(result).distribution.entries, [{ literal: ' A1 ', account_count: 2 }, { literal: 'B2', account_count: 1 }]);
  assert.equal(field(result).conflicting_count, 1); verifyCounts(result);
});

test('groups keep exact denominators/unassigned members and output order is deterministic', async () => {
  const accounts = [SUBJECT, ...Array.from({ length: 42 }, (_, i) => `A-${i}`)];
  const groups = [{ id: 'z', account_ids: accounts.slice(20) }, { id: 'discovery:unassigned', account_ids: accounts.slice(0, 20) }];
  const a = await fixture({ accounts, groups }), b = await fixture({ accounts: [...accounts].reverse(), groups: [...groups].reverse() });
  assert.deepEqual(baseline(a), baseline(b)); verifyCounts(baseline(a));
  assert.equal(baseline(a).all.member_count, 43); assert.deepEqual(baseline(a).pockets.map(row => row.member_count), [20, 23]);
});

test('empty retained population reports true zero counts and empty complete distributions, not zero-valued facts', async () => {
  const result = baseline(await fixture({ accounts: [], groups: [] }));
  assert.equal(result.all.member_count, 0); assert.deepEqual(result.pockets, []);
  for (const cell of Object.values(result.all.fields)) {
    assert.equal(cell.observed_count, 0); assert.deepEqual(cell.distribution.entries, []); assert.equal(cell.distribution.distinct_literal_count, 0);
  }
  verifyCounts(result);
});

test('64 distinct literals are complete; the 65th removes the entire distribution, never a convenient prefix', async () => {
  for (const n of [64, 65]) {
    const accounts = Array.from({ length: n }, (_, i) => i ? `A-${i}` : SUBJECT);
    const result = baseline(await fixture({ accounts, parcels: accounts.map((account_id, i) => ({ account_id, class_code: `C-${i}` })) }));
    const cell = field(result); assert.equal(cell.observed_count, n); assert.equal(cell.distribution.distinct_literal_count, n);
    assert.equal(cell.distribution.status, n === 64 ? 'complete' : 'details_unavailable');
    assert.equal(cell.distribution.reason, n === 64 ? null : 'distinct_literal_limit');
    if (n === 65) assert.equal(cell.distribution.entries, null); else assert.equal(cell.distribution.entries.length, 64);
    verifyCounts(result);
  }
});

test('per-field detail byte budget omits entire escaped-literal distribution while preserving exact account counts', async () => {
  const accounts = Array.from({ length: 20 }, (_, i) => i ? `A-${i}` : SUBJECT);
  const result = baseline(await fixture({ accounts, parcels: accounts.map((account_id, i) => ({ account_id, class_code: `${i}${'"'.repeat(4000)}` })) }));
  const cell = field(result); assert.equal(cell.distribution.status, 'details_unavailable');
  assert.equal(cell.distribution.reason, 'distribution_byte_limit'); assert.equal(cell.distribution.entries, null);
  assert.equal(cell.distribution.distinct_literal_count, 20); assert.equal(cell.observed_count, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes); verifyCounts(result);
});

test('aggregate detail budget omits all lists, retaining all populations rather than breaking recommendations', async () => {
  const accounts = [], parcels = [], groups = [];
  for (let group = 0; group < 46; group++) {
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const account_id = group === 0 && i === 0 ? SUBJECT : `A-${group}-${i}`, literal = `${i}${'x'.repeat(3900)}`;
      accounts.push(account_id); ids.push(account_id);
      parcels.push({ account_id, class_code: literal, class_description: literal, use_description: literal, structure_type: literal });
    }
    groups.push({ id: `G-${group}`, account_ids: ids });
  }
  const result = baseline(await fixture({ accounts, parcels, groups }));
  assert.equal(result.all.member_count, 552); assert.equal(result.pockets.length, 46);
  for (const population of [result.all, ...result.pockets]) for (const cell of Object.values(population.fields)) {
    assert.equal(cell.distribution.entries, null); assert.equal(cell.distribution.reason, 'baseline_output_byte_limit');
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes); verifyCounts(result);
});

test('the addon is detached/frozen and contains no source, account, numerical, score or review-authority fields', async () => {
  const args = structuredClone(await fixture()), numeric = JSON.stringify(args.preview.all.stock), result = baseline(args);
  const visit = value => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(visit); } };
  visit(result); assert.equal(JSON.stringify(args.preview.all.stock), numeric);
  args.preview.context_ref.context_revision = '99'; assert.notEqual(result.binding.context_ref.context_revision, '99');
  for (const word of ['account_id', 'source_record', 'source_ref', 'raw_projection', 'source_policy', 'score', 'similarity', 'eligible_housing']) {
    assert.equal(Object.hasOwn(result, word), false);
  }
  assert.deepEqual(Object.keys(result.all.fields), Object.keys(FIELDS));
});

for (const [name, change, reason] of [
  ['duplicate membership', f => f.groups[0].account_ids.push(SUBJECT), 'group_partition'],
  ['omitted membership', f => f.groups[0].account_ids.pop(), 'group_partition'],
  ['foreign membership', f => f.groups[0].account_ids[0] = 'foreign', 'group_partition'],
  ['duplicate group', f => f.groups.push({ id: f.groups[0].id, account_ids: [] }), 'group_identity'],
  ['foreign target', f => f.preview.target.report_file_id = 'foreign', 'target_mismatch'],
  ['different capture clock', f => f.preview.captured_at = '2026-09-07T08:00:00.123Z', 'preview_capture_mismatch'],
  ['different source digest', f => f.preview.source_snapshots[0].content_sha256 = '0'.repeat(64), 'preview_capture_mismatch'],
  ['partial stock', f => f.preview.all.stock.members.pop(), 'stock_roster_mismatch'],
]) test(`${name} fails rather than returning a coherent-looking partial summary`, async () => {
  const f = structuredClone(await fixture()); change(f); assert.throws(() => baseline(f), ERROR(reason));
});

for (const [name, field, value, reason] of [
  ['number code', 'class_code', 1, 'literal_type'], ['string boolean', 'built_up', 'false', 'literal_type'],
  ['oversize UTF8', 'class_code', 'é'.repeat(2049), 'literal_text'], ['invalid Unicode', 'class_code', '\ud800', 'literal_text'],
  ['SQL-incompatible NUL', 'class_code', '\0', 'literal_text'], ['undefined own field', 'class_code', undefined, 'literal_type'],
]) test(`${name} cannot silently become an observation`, async () => {
  const f = structuredClone(await fixture());
  const row = f.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'parcels').payload.records[0];
  row.data.raw_projection[field] = value;
  assert.throws(() => baseline(f), ERROR(reason));
});

test('missing or accessor CAD fields reject without evaluating that accessor', async () => {
  for (const accessor of [false, true]) {
    const f = structuredClone(await fixture()), raw = f.retained_inputs.acquisition.capture_result.source_capture.sources
      .find(s => s.payload.projection.definition.role === 'parcels').payload.records[0].data.raw_projection;
    let calls = 0; delete raw.class_code;
    if (accessor) Object.defineProperty(raw, 'class_code', { enumerable: true, get() { calls++; return 'unsafe'; } });
    assert.throws(() => baseline(f), ERROR('cad_field_required')); assert.equal(calls, 0);
  }
});

test('conflicting CAD labels remain unscored while other factors and the selection-independent baseline stay intact', async () => {
  const old = kernel(await actual()), changedFixture = await cadEvidenceFixture({ parcelOverrides: {
    class_code: '999', class_description: 'Condominium', use_description: 'Townhome', structure_type: 'Unknown', built_up: true,
  } });
  const changed = kernel(changedFixture);
  for (const key of ['policy', 'recommended_recorded_group_ids', 'unavailable_factors', 'status']) {
    assert.deepEqual(changed[key], old[key], key);
  }
  assert.deepEqual(changed.all.similarity, old.all.similarity);
  assert.deepEqual(changed.selected.similarity, old.selected.similarity);
  for (const row of changed.properties) {
    const prior = old.properties.find(value => value.account_id === row.account_id);
    for (const key of ['gla', 'age', 'site_size', 'proximity', 'sale_price']) assert.deepEqual(row.factors[key], prior.factors[key]);
    assert.deepEqual(row.factors.housing_type, { score: null, state: 'subject_conflicting' });
  }
  const empty = recommendation({ context_ref: changedFixture.input.expected.context_ref, retained_inputs: changedFixture.input.retained_inputs,
    selection: { revision: 77, included_recorded_group_ids: [] } });
  assert.deepEqual(empty.cad_recorded_evidence, changed.cad_recorded_evidence);
  assert.equal(empty.selected.member_count, 0);
  for (const row of empty.properties) assert.deepEqual(row.factors.housing_type, { score: null, state: 'subject_conflicting' });
});

test('bounded labels and exact maximum UTF8 literals are preserved without display truncation', async () => {
  for (const label of Object.values(FIELDS)) assert.ok(Buffer.byteLength(label) < 128);
  const literal = 'é'.repeat(2048), result = baseline(await fixture({ parcels: [{ account_id: SUBJECT, class_code: literal }, { account_id: 'B' }] }));
  assert.equal(result.subject.fields.class_code.literal, literal);
  assert.ok(field(result).distribution.entries.some(row => row.literal === literal));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes);
});

test('unselected private row properties are never included or evaluated', async () => {
  const f = structuredClone(await fixture()), raw = f.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(s => s.payload.projection.definition.role === 'parcels').payload.records[0].data.raw_projection;
  let calls = 0;
  Object.defineProperty(raw, 'private_provider_credentials', { enumerable: true, get() { calls++; throw Error('do not read'); } });
  const result = baseline(f); assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes('private_provider_credentials'), false);
});

for (const [name, change] of [
  ['account count', f => { f.preview.all.stock.members = Array(L.accounts + 1).fill({ account_id: SUBJECT }); }],
  ['group count', f => { f.groups = Array(L.groups + 1).fill({ id: 'group', account_ids: [] }); }],
  ['source chunk count', f => {
    const sources = f.retained_inputs.acquisition.capture_result.source_capture.sources;
    f.retained_inputs.acquisition.capture_result.source_capture.sources = Array(L.source_chunks + 1).fill(sources[0]);
  }],
  ['source record count', f => {
    const source = f.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'parcels');
    source.payload.records = Array(L.source_records + 1).fill(source.payload.records[0]);
  }],
]) test(`${name} resource bound rejects before unbounded iteration`, async () => {
  const f = structuredClone(await fixture()); change(f); assert.throws(() => baseline(f), ERROR('input_limit'));
});

test('aggregate literal traversal has its own byte bound even for repeated interned strings', async () => {
  // Deliberately invalid oversized consumer input, not an admitted acquisition.
  const f = structuredClone(await fixture()), source = f.retained_inputs.acquisition.capture_result.source_capture.sources
    .find(s => s.payload.projection.definition.role === 'parcels');
  const template = structuredClone(source.payload.records[0]);
  for (const key of ['class_code', 'class_description', 'use_description', 'structure_type']) template.data.raw_projection[key] = 'x'.repeat(4096);
  source.payload.records = Array.from({ length: 2000 }, (_, i) => ({ ...template, record_id: `oversized:${i}` }));
  assert.throws(() => baseline(f), ERROR('input_literal_byte_limit'));
});
