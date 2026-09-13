import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import * as catalogModule from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortIndexedObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

const { buildCustomCohortPocketCatalog: build, buildCustomCohortSelectionCatalog: selectionCatalog } = catalogModule;
const { customCohortPocketCatalogBatches: batches, customCohortSelectionCatalogBatches: selectionBatches } = catalogModule;
const NOW = '2026-09-06T08:00:00.123Z';
const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
const fingerprint = value => { const text = JSON.stringify(value); return {
  utf8_bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
}; };
const seal = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(seal); Object.freeze(value); }
  return value;
};
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}
function drain(stages) {
  let yields = 0;
  while (true) {
    const step = stages.next();
    if (step.done) return { result: step.value, yields };
    assert.equal(step.value, undefined, 'A checkpoint never exposes partial membership or a catalog'); yields++;
  }
}
// Test-only owner. Production owns sealing, scheduling, budget and final rights.
async function consume(stages, { check = () => {}, onYield = () => {} } = {}) {
  let yields = 0;
  try {
    while (true) {
      check(); const step = stages.next(); check();
      if (step.done) return step.value;
      assert.equal(step.value, undefined); onYield(++yields);
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { stages.return(); }
}
const captureOf = input => input.retained_inputs.acquisition.capture_result.source_capture;
const cadSources = input => captureOf(input).sources.filter(source => ['parcels', 'accounts'].includes(source.payload.projection.definition.role));
const completeYields = input => 3 + Math.floor(cadSources(input).reduce((n, source) => n + source.payload.records.length, 0) / 125)
  + Math.floor(input.retained_inputs.spatial.account_ids.length / 125);
// Keep the genuinely issued immutable preview; only detach synthetic retained
// input for downstream malformed-graph tests, never claiming hash admission.
const detached = input => ({ ...input, retained_inputs: structuredClone(input.retained_inputs) });

// Actual mapping/source-chunk and issued indexed-preview kernels, using a
// synthetic retained-loader graph. This is not SQL or owner-admission proof.
function fixture({ count = 8, distinct = false, mixed = false, catalogVersion = 1 } = {}) {
  const accounts = Array.from({ length: count }, (_, i) => `A-${String(i).padStart(5, '0')}`);
  const target = { ...contextFixture().target, account_id: accounts[0] ?? 'SUBJECT-OUTSIDE', assignment_file_id: '17' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const accountRows = accounts.map((account_id, i) => ({ account_id, county: 'Dallas',
    subdivision: distinct ? `Recorded Group ${i}` : 'Oak Creek' }));
  const parcels = accounts.map((account_id, i) => ({ object_id: String(i + 1), account_id,
    residential_year_built: 2000, residential_area_sqft: '1800.125', parcel_area_sqft: '6000.00',
    current_market_value: '330000.00', subdivision_name: accountRows[i].subdivision }));
  if (mixed) {
    accountRows[1].county = 'DALLAS COUNTY';
    accountRows[2].county = ' dAlLaS '; accountRows[2].subdivision = ' OAK  CREEK ';
    accountRows[3].county = null;
    accountRows[4].subdivision = null; parcels[4].subdivision_name = 'UNKNOWN';
    accountRows[5].subdivision = null;
    accountRows[6].subdivision = 'Pine Grove';
    parcels.push({ ...parcels[7], object_id: '1000', subdivision_name: 'Oak Creek Phase 2' });
  }
  const wrap = (rows, mapper, prefix) => rows.map(row => {
    const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped };
  });
  const roles = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'), accounts: wrap(accountRows, mapCachedAccountRow, 'account'),
    transactions: [], sale_links: [], gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  const retained_inputs = { subject: { target, effective_date: '2024-06-30' },
    study: { observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } },
    spatial: { query_complete: true, account_ids: accounts,
      parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } };
  const preview = buildCustomCohortIndexedObservationPreview({ context_ref, retained_inputs,
    selection: { revision: 1, pockets: [] } });
  return { retained_inputs, preview, catalog_version: catalogVersion };
}

// Filled from the original synchronous implementation at d2f4954, before any
// production scheduling edit. Pins exact JSON key order as well as full values.
const GOLDENS = Object.fromEntries(Object.entries({
  '1-small': [2489, 'f0af51c8f1c9c3d98d820724d7bcaf01858c6b39528dc5b2bace823d14c05bd7', 2489, 'f0af51c8f1c9c3d98d820724d7bcaf01858c6b39528dc5b2bace823d14c05bd7'],
  '2-small': [2489, '68de187980aa6713d16654d7ca7e345b1980689b4c6eaeadf80f78f7e5faf649', 2541, 'da07c45594351acf97b213b76f58665500955de0c95bddd06478ed5583385334'],
  '1-empty': [1698, '685f2414dbd8ccf82d86951e0e8dfd05f13591baf0099f85727c7931e582b044', 1698, '685f2414dbd8ccf82d86951e0e8dfd05f13591baf0099f85727c7931e582b044'],
  '2-empty': [1698, 'da8a1584813f1352aad0bfcf9f66ee64d170ac85af9d66240ab365b945480f0c', 1878, 'f74ea3afb7dffa22383b97a46909bd15e1c713e2f32433edf48a49e2da146533'],
  '1-mixed': [5441, 'c32d7a81ec6ee54b6587b6e854aac6da3c819b73aa4c28a479c78f452a1ce297', 5441, 'c32d7a81ec6ee54b6587b6e854aac6da3c819b73aa4c28a479c78f452a1ce297'],
  '2-mixed': [5441, 'd40d2db37949414c29a033447c1c82b81bfc63622d29dade0a5630872474b5e9', 4041, 'a8e397188930f188011bedfad488c99cb4207c8333a8da89430c8041862f65f5'],
  '1-dense': [10584, 'cb12098babad3d4fdeb50da726aaa97811ce0192898b3bbb40e688397adf37c2', 10584, 'cb12098babad3d4fdeb50da726aaa97811ce0192898b3bbb40e688397adf37c2'],
  '2-dense': [531078, 'e2b715ebc53d4a1c9159646048c7b454ed76b2109012edfe75b4eabf3dd3a649', 401976, 'f5266c68c77cf6a87212cda93b4f057cc211f153ad9cb9a712f0359a7093c451'],
  '1-overflow': [11970, '57b50080b84c25192fe79903952b39d80f7f1256e12b9848b8160f20efcceda4', 11970, '57b50080b84c25192fe79903952b39d80f7f1256e12b9848b8160f20efcceda4'],
  '2-overflow': [11970, '15845b078f86aa4f909989b2e855a090894f85ed74c8c52a52fbc293059a5b7e', 12149, 'a6abb857d40333632d44989bf6dfa9e1cb4c6654a0b659a5f0cd90f2e1425673'],
}).map(([name, [internalBytes, internalHash, selectionBytes, selectionHash]]) => [name, {
  internal: { utf8_bytes: internalBytes, sha256: internalHash }, selection: { utf8_bytes: selectionBytes, sha256: selectionHash },
}]));
for (const [name, options] of [
  ['small', {}], ['empty', { count: 0 }], ['mixed', { mixed: true }],
  ['dense', { count: 887, distinct: true }], ['overflow', { count: 1025, distinct: true }],
]) for (const version of [1, 2]) test(`catalog v${version} ${name} preserves original full output bytes`, async () => {
  const input = seal(fixture({ ...options, catalogVersion: version }));
  const before = fingerprint(input), internal = build(input), selected = selectionCatalog(input);
  assert.deepEqual({ internal: fingerprint(internal), selection: fingerprint(selected) }, GOLDENS[`${version}-${name}`]);
  for (const [iterator, expected] of [[batches, internal], [selectionBatches, selected]]) {
    const completed = drain(iterator(input)); frozen(completed.result);
    assert.deepEqual(completed.result, expected); assert.deepEqual(await consume(iterator(input)), expected);
  }
  assert.deepEqual(fingerprint(input), before);
});

for (const count of [0, 124, 125, 126, 250, 251]) test(`${count} accounts preserve complete membership and both exact checkpoint boundaries`, () => {
  for (const version of [1, 2]) {
    const input = seal(fixture({ count, catalogVersion: version }));
    const internal = drain(batches(input)), selected = drain(selectionBatches(input));
    assert.equal(internal.yields, completeYields(input));
    assert.equal(selected.yields, internal.yields + (version === 2 ? 1 : 0));
    assert.equal(internal.result.coverage.account_source_row_count, count);
    assert.equal(internal.result.coverage.parcel_source_row_count, count);
    assert.equal(internal.result.coverage.assigned_account_count, count);
    const union = [...selected.result.pockets.flatMap(pocket => pocket.account_ids), ...selected.result.unassigned.account_ids].sort();
    assert.deepEqual(union, input.retained_inputs.spatial.account_ids); assert.equal(new Set(union).size, count);
    assert.deepEqual(internal.result, build(input)); assert.deepEqual(selected.result, selectionCatalog(input));
  }
});

test('124 parcel rows plus 124 account rows share a CAD checkpoint budget across roles', () => {
  const input = seal(fixture({ count: 124 })), sources = cadSources(input);
  assert.deepEqual(sources.map(source => source.payload.records.length), [124, 124]);
  assert.equal(drain(batches(input)).yields, 4, 'One CAD checkpoint plus three stage boundaries, although neither role has 125 rows');
});

for (const version of [1, 2]) test(`catalog v${version} owner cancellation works at every checkpoint without a reusable partial catalog`, async () => {
  const input = seal(fixture({ count: 251, catalogVersion: version })), before = fingerprint(input);
  const expected = selectionCatalog(input), count = drain(selectionBatches(input)).yields;
  assert.equal(count, completeYields(input) + (version === 2 ? 1 : 0));
  for (let stop = 1; stop <= count; stop++) {
    const stages = selectionBatches(input), controller = new AbortController(), cancelled = new Error(`cancel-catalog-${version}-${stop}`);
    let serviced = false, lastYield = 0;
    await assert.rejects(consume(stages, { check: () => controller.signal.throwIfAborted(), onYield(n) {
      lastYield = n;
      if (n === stop) setImmediate(() => { serviced = true; controller.abort(cancelled); });
    } }), error => error === cancelled);
    assert.equal(serviced, true); assert.equal(lastYield, stop);
    assert.deepEqual(stages.next(), { done: true, value: undefined });
  }
  assert.deepEqual(fingerprint(input), before);
  assert.deepEqual(await consume(selectionBatches(input)), expected);
});

test('missing/conflicting/invalid account decisions consume roster checkpoints and never invent membership', () => {
  const input = detached(fixture({ count: 251, catalogVersion: 2 }));
  const accounts = cadSources(input).find(source => source.payload.projection.definition.role === 'accounts');
  for (const [index, record] of accounts.payload.records.entries()) {
    record.data.raw_projection.county = index % 3 === 0 ? null : 'Dallas';
    record.data.raw_projection.subdivision = index % 3 === 1 ? 'Conflicting Pine Grove'
      : index % 3 === 2 ? { raw_invalid: true } : 'Oak Creek';
  }
  seal(input);
  const completed = drain(selectionBatches(input));
  assert.equal(completed.yields, completeYields(input) + 1);
  assert.equal(completed.result.coverage.assigned_account_count, 0);
  assert.deepEqual(completed.result.unassigned.account_ids, input.retained_inputs.spatial.account_ids);
  assert.equal(completed.result.unassigned.member_count, 251);
  assert.deepEqual(completed.result, selectionCatalog(input));
});

test('the exact recorded county/name groups, partial observations and conflicting candidates remain unchanged', () => {
  const input = seal(fixture({ mixed: true, catalogVersion: 2 })), result = drain(batches(input)).result;
  const dallas = result.pockets.find(pocket => pocket.normalized_county === 'dallas' && pocket.normalized_label === 'oak creek');
  const alias = result.pockets.find(pocket => pocket.normalized_county === 'dallas county' && pocket.normalized_label === 'oak creek');
  assert.notEqual(dallas.id, alias.id); assert.deepEqual(alias.account_ids, ['A-00001']);
  assert.deepEqual(dallas.account_ids, ['A-00000', 'A-00002', 'A-00005']);
  assert.equal(dallas.partially_observed_account_count, 1);
  assert.deepEqual(result.unassigned.account_ids, ['A-00003', 'A-00004', 'A-00006', 'A-00007']);
  assert.equal(result.coverage.conflicting_account_count, 2);
  const publicResult = drain(selectionBatches(input)).result;
  assert.deepEqual(publicResult.pockets.map(pocket => [pocket.id, pocket.account_ids]), result.pockets.map(pocket => [pocket.id, pocket.account_ids]));
  for (const field of ['raw_label_variants', 'raw_county_variants', 'source_ref', 'raw_projection', 'details']) {
    assert.ok(!JSON.stringify(publicResult).includes(`"${field}":`), field);
  }
});

for (const [version, sizes] of [[1, [128, 129]], [2, [1024, 1025]]]) test(`catalog v${version} group boundary remains full membership or whole-roster refusal`, () => {
  for (const count of sizes) {
    const input = seal(fixture({ count, distinct: true, catalogVersion: version })), result = drain(selectionBatches(input)).result;
    assert.deepEqual(result, selectionCatalog(input));
    assert.equal(result.catalog_complete, count === sizes[0]);
    const union = [...result.pockets.flatMap(pocket => pocket.account_ids), ...result.unassigned.account_ids].sort();
    assert.deepEqual(union, input.retained_inputs.spatial.account_ids);
    if (!result.catalog_complete) {
      assert.deepEqual(result.pockets, []); assert.deepEqual(result.reasons, ['pocket_count_limit']);
      assert.equal(result.unassigned.details_complete, false); assert.equal(result.unassigned.member_count, count);
    }
  }
});

test('late UTF-8 label overflow returns the original whole roster after checkpoints, not partial groups', () => {
  for (const [label, complete] of [['é'.repeat(256), true], ['é'.repeat(256) + 'x', false]]) {
    const input = detached(fixture({ count: 126, catalogVersion: 2 }));
    const parcels = cadSources(input).find(source => source.payload.projection.definition.role === 'parcels');
    parcels.payload.records.at(-1).data.raw_projection.subdivision_name = label; seal(input);
    const completed = drain(selectionBatches(input)); assert.ok(completed.yields >= 3);
    assert.equal(completed.result.catalog_complete, complete);
    assert.deepEqual(completed.result, selectionCatalog(input));
    if (!complete) {
      assert.deepEqual(completed.result.reasons, ['recorded_label_text_limit']); assert.deepEqual(completed.result.pockets, []);
      assert.deepEqual(completed.result.unassigned.account_ids, input.retained_inputs.spatial.account_ids);
    }
  }
});

test('late row and source-role failures retain exact reasons and original validation order', async () => {
  const base = fixture({ count: 126, catalogVersion: 2 });
  for (const [mutate, reason] of [
    [input => { input.retained_inputs.acquisition.capture_result.query_complete = false; }, 'retained_capture_required'],
    [input => { input.retained_inputs.subject.target.assignment_file_id = 'different'; }, 'target_mismatch'],
    [input => { input.retained_inputs.spatial.account_ids.push(input.retained_inputs.spatial.account_ids[0]); }, 'duplicate_account'],
    [input => { input.retained_inputs.spatial.account_ids.pop(); }, 'stock_roster_mismatch'],
    [input => { cadSources(input)[0].payload.records.at(-1).data.raw_projection.account_id = 'outside'; }, 'cad_account_scope'],
    [input => { cadSources(input)[0].payload.records.at(-1).data.data.cached_mapping_version = 99; }, 'mapping_v2_required'],
    [input => { captureOf(input).sources.at(-1).payload.projection.definition.mapping_version = 99; }, 'mapping_profile_mismatch'],
  ]) {
    const input = detached(base); mutate(input); seal(input);
    const matches = error => error.constructor === TypeError && error.message === `custom_cohort_pocket_catalog_${reason}`
      && error.code === 'CUSTOM_COHORT_POCKET_CATALOG_INVALID' && error.reason === reason;
    assert.throws(() => selectionCatalog(input), matches);
    await assert.rejects(consume(selectionBatches(input)), matches);
  }
  // A label limit has always short-circuited later source validation with a
  // whole-roster incomplete result. Scheduling must not reorder those reads.
  const input = detached(base);
  const firstCad = cadSources(input)[0], labelField = firstCad.payload.projection.definition.role === 'accounts' ? 'subdivision' : 'subdivision_name';
  firstCad.payload.records.at(-1).data.raw_projection[labelField] = 'x'.repeat(513);
  captureOf(input).sources.at(-1).payload.projection.definition.mapping_version = 99; seal(input);
  assert.deepEqual(drain(selectionBatches(input)).result.reasons, ['recorded_label_text_limit']);
  for (const make of [() => batches(), () => selectionBatches(), () => batches(null), () => selectionBatches(null)]) {
    assert.throws(() => drain(make()), TypeError);
  }
});

test('unchanged account, source-chunk and per-chunk row limits refuse rather than clip', async () => {
  const base = fixture();
  for (const mutate of [
    input => { input.retained_inputs.spatial.account_ids.length = 50001; },
    input => { captureOf(input).sources.length = 1001; },
    input => { cadSources(input)[0].payload.records.length = 100001; },
  ]) {
    const input = detached(base); mutate(input); seal(input);
    const matches = error => error.constructor === TypeError && error.message === 'custom_cohort_pocket_catalog_input_limit'
      && error.code === 'CUSTOM_COHORT_POCKET_CATALOG_INVALID' && error.reason === 'input_limit';
    assert.throws(() => build(input), matches); await assert.rejects(consume(batches(input)), matches);
  }
});
