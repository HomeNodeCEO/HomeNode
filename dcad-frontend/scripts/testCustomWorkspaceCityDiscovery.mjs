import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discoveryHelpers from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as serverPrepare,
  readCustomNeighborhoodWorkspaceCheckpoint as serverRead } from '../../server/src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { prepareCustomCityDiscoveryChoice as serverCity } from '../../server/src/services/neighborhoodAssessment/customCityDiscovery.js';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { deriveCustomCohortRecordedProximity } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { buildCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
function compile(name, imports) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`, { filename: file }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected dependency: ${key}`); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers,
  './customWorkspaceDiscovery.ts': discoveryHelpers });
const { prepareCustomWorkspaceCheckpoint: prepare, readCustomWorkspaceCheckpoint: read,
  restoreCustomWorkspaceSelection: restore } = checkpoint;
const { prepareCustomWorkspaceDiscovery: discovery } = discoveryHelpers;
const { createCustomWorkspaceLifecycle: createLifecycle } = compile('customWorkspaceLifecycle', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPocketCatalog': catalogHelpers,
});
const { createCustomWorkspaceApi: createApi } = compile('customWorkspaceApi', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': compile('customCohortPreviewTransport', {}),
});
const catalogData = JSON.parse(readFileSync(new URL('../src/data/neighborhoodCityBoundaries.json', import.meta.url), 'utf8'));
const CITIES = catalogData.cities.map(city => ({ profile_id: 'custom-city-polygon-v1',
  city: { geoid: city.geoid, vintage: catalogData.vintage, asset_sha256: city.sha256 } }));
const CITY = CITIES[0], OTHER = CITIES[1];
const radius = radius_metres => ({ profile_id: 'custom-suburban-radius-v2', radius_metres });
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '37', sessionKey: 'city-test' };
const PERIOD = { start_date: '2026-01-01', end_date: '2026-09-10' };
const OP = '10000000-0000-4000-8000-000000000001', OLD = '10000000-0000-4000-8000-000000000002';
const PRIVATE = { batch_id: '20000000-0000-4000-8000-000000000003', expected_review_revision: 7 };
const GROUP = `recorded-cad:${'a'.repeat(64)}`;
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'b'.repeat(64) });
const copy = value => structuredClone(value);
const active = (scope, id = OLD) => ({ context_ref: context(id), observation_period: copy(PERIOD),
  selection: { revision: 4, included_recorded_group_ids: [] }, ...(scope ? { discovery: copy(scope) } : {}) });
const pending = (scope, privateInput) => ({ operation_id: OP, observation_period: copy(PERIOD),
  ...(privateInput ? { private_sales_import: copy(privateInput) } : {}), discovery: copy(scope) });
const section = (scope, next = null) => ({ revision: 5, value: { workspace_version: 4,
  active: active(scope), pending_capture: next } });
function catalog(input, scope, privateInput) {
  const result = { status: 'catalog', subject_freshness: 'matched', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: copy(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: copy(input.contextRef), selection_revision: input.selection.revision },
      pockets: [{ id: GROUP, label: 'Synthetic group', county: 'Synthetic', account_ids: ['SUBJECT'], member_count: 1, disposition: 'needs_review' }],
      unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
      coverage: { discovery_member_count: 1, assigned_account_count: 1, unassigned_account_count: 0 },
      subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: GROUP, recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
  if (scope?.profile_id === 'custom-city-polygon-v1') result.discovery = copy(scope);
  if (privateInput) {
    result.private_sales = privateSalesSummaryFixture({ input, privateSalesImport: privateInput, period: PERIOD });
    result.catalog.binding.selection_sha256 = result.private_sales.binding.selection_sha256;
  }
  return result;
}
const reply = input => ({ status: 'registered', reused: false, context_ref: context(input.operationId), source_query_complete: true,
  discovery: { ...(input.discovery?.profile_id === 'custom-city-polygon-v1' ? copy(input.discovery)
    : { radius_metres: input.discovery?.radius_metres ?? '4828.032' }), account_count: 1, parcel_count: 1 },
  ...(input.privateSalesImport ? { private_sales_import: copy(input.privateSalesImport) } : {}) });
const defer = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
const rejects = (promise, code) => assert.rejects(promise, e => e.workspaceCode === code);
function harness({ initialSection, save, capture, alterCatalog } = {}) {
  const calls = [], db = { section: copy(initialSection) }, retained = new Map(); let ids = 0;
  if (initialSection?.value.active) retained.set(initialSection.value.active.context_ref.context_id,
    { scope: copy(initialSection.value.active.discovery) });
  const commit = input => {
    assert.equal(input.expectedRevision, db.section?.revision ?? 0);
    db.section = { value: copy(input.value), revision: input.expectedRevision + 1 };
    return { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, section: copy(db.section) };
  };
  const owner = createLifecycle({ target: TARGET, initialSection, onChange() {}, operationId: () => { ids++; return OP; },
    save: async (input, io) => { calls.push({ kind: 'save', input: copy(input), io }); return save ? save(input, io, commit) : commit(input); },
    capture: async (input, io) => { calls.push({ kind: 'capture', input: copy(input), io });
      retained.set(input.operationId, { scope: copy(input.discovery), privateInput: copy(input.privateSalesImport) });
      return capture ? capture(input, io) : reply(input); },
    catalog: async (input, io) => { calls.push({ kind: 'catalog', input: copy(input), io });
      const saved = retained.get(input.contextRef.context_id), result = catalog(input, saved?.scope, saved?.privateInput);
      return alterCatalog ? alterCatalog(result, input) : result; },
  });
  return { owner, calls, db, get ids() { return ids; }, reload: () => owner.reload({ target: TARGET, section: copy(db.section) }) };
}
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
function apiHarness(alter) {
  const requests = [], api = createApi({ urlFor: path => path, editorKeyForSave: () => 'synthetic-editor-key',
    request: async (url, init) => { const body = JSON.parse(init.body); requests.push(body);
      const result = reply({ operationId: body.operation_id, discovery: body.discovery, privateSalesImport: body.private_sales_import });
      return new Response(JSON.stringify(alter ? await alter(result, body) : result), { headers: { 'content-type': 'application/json' } }); },
  });
  return { api, requests };
}

test('city catalog accepts housing-only observations and rejects an otherwise valid radius-calibrated recommendation', async () => {
  const f = await cadEvidenceFixture({ parcelOverrides: { class_code: 'A11', class_description: null,
    use_description: null, structure_type: null, built_up: null } });
  const context_ref = f.input.expected.context_ref, retained_inputs = f.input.retained_inputs;
  const expected = { context_ref, selection_revision: 7 };
  const publicCatalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    contextRef: context_ref, selection: { revision: 7, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref, selection_revision: 7, subject_freshness: 'matched', catalog: publicCatalog, apply: { status: 'blocked' } };
  const present = measured => presentCustomCohortPocketRecommendation({ catalog: publicCatalog, expected,
    recommendation: buildCustomCohortPocketRecommendation({ context_ref, retained_inputs,
      selection: { revision: 7, included_recorded_group_ids: [] }, ...(measured ? { recorded_proximity: measured } : {}) }) });
  // Original retained mapping4 -> real kernel/presenter. Only the HTTP scope is
  // mutated here; this is a decoder contradiction probe, not a new city capture.
  const housing = present(null);
  assert.equal(catalogHelpers.checkCustomCohortPocketCatalog({ ...response, discovery: CITY, recommendation: housing }, input)
    .recommendation.evidence_mode, 'recorded_housing_only');
  const measured = await deriveCustomCohortRecordedProximity(async () => assert.fail('fixture retained geometry is unavailable'),
    { context_ref, retained_inputs });
  const combined = present(measured);
  assert.equal(catalogHelpers.checkCustomCohortPocketCatalog({ ...response, recommendation: combined }, input)
    .recommendation.evidence_mode, 'recorded_housing_and_proximity');
  assert.throws(() => catalogHelpers.checkCustomCohortPocketCatalog({ ...response, discovery: CITY, recommendation: combined }, input));
  assert.equal(catalogHelpers.checkCustomCohortPocketCatalog({ ...response, discovery: CITY }, input).recommendation, null);
});

for (const city of [...CITIES, { ...CITY, city: { geoid: '4899999', vintage: '2001-02-28', asset_sha256: 'f'.repeat(64) } }]) {
  test(`city grammar/server parity ${city.city.geoid}/${city.city.vintage} does not require today's installed asset`, () => {
    const raw = copy(city), checked = discovery(raw); assert.deepEqual(checked, serverCity(raw));
    assert.ok(Object.isFrozen(checked.city)); raw.city.asset_sha256 = 'e'.repeat(64); assert.deepEqual(checked, city);
    const saved = section(city); assert.deepEqual(prepare(saved.value), serverPrepare(saved.value)); assert.deepEqual(read(saved), serverRead(saved));
  });
}
for (const [label, mutate] of [
  ['wrong geoid', v => { v.city.geoid = '0612345'; }], ['numeric geoid', v => { v.city.geoid = 4816612; }],
  ['fake date', v => { v.city.vintage = '2026-02-29'; }], ['year zero', v => { v.city.vintage = '0000-01-01'; }],
  ['uppercase hash', v => { v.city.asset_sha256 = 'A'.repeat(64); }], ['renamed hash', v => { v.city.geometry_sha256 = v.city.asset_sha256; delete v.city.asset_sha256; }],
  ['extra radius', v => { v.radius_metres = '4828.032'; }], ['browser geometry', v => { v.city.geometry = {}; }],
  ['null city', v => { v.city = null; }], ['wrong profile', v => { v.profile_id = 'custom-city-polygon-v2'; }],
]) test(`city rejects ${label} before API work, with actual server parity`, async () => {
  const value = copy(CITY); mutate(value); assert.throws(() => discovery(value)); assert.throws(() => serverCity(value));
  const a = apiHarness(); await rejects(a.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: value }, io()), 'invalid_input');
  assert.equal(a.requests.length, 0);
});
test('nested city accessors never execute in checkpoint or catalog admission', () => {
  let calls = 0; const city = copy(CITY);
  Object.defineProperty(city.city, 'asset_sha256', { enumerable: true, get() { calls++; return CITY.city.asset_sha256; } });
  const saved = section(CITY); saved.value.active.discovery = city;
  assert.throws(() => discovery(city)); assert.throws(() => prepare(saved.value));
  const input = { ...TARGET, contextRef: context(OLD), selection: { revision: 1, pockets: [] } };
  const result = catalog(input, CITY); result.discovery = city;
  assert.throws(() => catalogHelpers.checkCustomCohortPocketCatalog(result, input)); assert.equal(calls, 0);
});
test('v1/v2/v3 reject city; v4 admits mixed active/pending choices and requires pending discovery', () => {
  for (const version of [1, 2, 3]) {
    const value = section(CITY).value; value.workspace_version = version;
    assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value));
  }
  for (const [oldScope, nextScope] of [[CITY, radius('8046.72')], [radius('16093.44'), CITY], [undefined, CITY], [CITY, OTHER]]) {
    const value = section(oldScope, pending(nextScope, PRIVATE)).value;
    assert.deepEqual(prepare(value), serverPrepare(value));
  }
  const value = section(CITY, pending(CITY)).value; delete value.pending_capture.discovery;
  assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value));
});
for (const change of ['asset_sha256', 'geoid', 'vintage', 'profile']) test(`same operation cannot change ${change}`, () => {
  const value = section(CITY, pending(CITY)).value; value.active.context_ref = context(OP);
  assert.deepEqual(prepare(value), serverPrepare(value));
  if (change === 'profile') value.pending_capture.discovery = radius('4828.032');
  else value.pending_capture.discovery.city[change] = change === 'asset_sha256' ? 'e'.repeat(64) : change === 'geoid' ? OTHER.city.geoid : '2025-01-01';
  assert.throws(() => prepare(value), e => e.checkpointReason === 'operation_discovery_conflict'); assert.throws(() => serverPrepare(value));
});
for (const privateInput of [undefined, PRIVATE]) for (const previous of [undefined, radius('16093.44'), CITY]) {
  test(`city capture with private=${Boolean(privateInput)} from ${previous?.profile_id ?? 'legacy'} keeps old active until exact catalog + ACK`, async () => {
    const initial = section(previous), h = harness({ initialSection: initial });
    try { await h.owner.start(PERIOD, privateInput, OTHER);
      assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture', 'catalog', 'save']);
      assert.deepEqual(h.calls[0].input.value.active, initial.value.active); assert.equal(h.calls[0].input.value.workspace_version, 4);
      assert.deepEqual(h.calls[1].input.discovery, OTHER); assert.deepEqual(h.db.section.value.active.discovery, OTHER);
      assert.equal(h.db.section.value.workspace_version, 4); assert.equal(h.owner.getState().status, 'ready');
      const a = apiHarness(); const result = await a.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD,
        discovery: OTHER, ...(privateInput ? { privateSalesImport: privateInput } : {}) }, io());
      assert.deepEqual(a.requests[0], { assignment_file_id: TARGET.assignmentFileId, operation_id: OP, observation_period: PERIOD,
        ...(privateInput ? { private_sales_import: privateInput } : {}), discovery: OTHER });
      assert.equal(Object.hasOwn(result.discovery, 'radius_metres'), false);
    } finally { h.owner.dispose(); }
  });
}
for (const metres of ['4828.032', '8046.72', '16093.44']) test(`city -> ${metres} uses v4 pending then v3 new active`, async () => {
  const initial = section(CITY), h = harness({ initialSection: initial });
  try { await h.owner.reopen(); assert.deepEqual(h.owner.getState().selection.pockets, []);
    await h.owner.start(PERIOD, undefined, radius(metres));
    assert.equal(h.calls.find(c => c.kind === 'save').input.value.workspace_version, 4);
    assert.deepEqual(h.calls.find(c => c.kind === 'save').input.value.active, initial.value.active);
    assert.equal(h.db.section.value.workspace_version, 3); assert.deepEqual(h.db.section.value.active.discovery, radius(metres));
  } finally { h.owner.dispose(); }
});
for (const [label, alter] of [['missing', r => { delete r.discovery; }], ['wrong city', r => { r.discovery = copy(OTHER); }],
  ['wrong hash', r => { r.discovery.city.asset_sha256 = 'e'.repeat(64); }]]) {
  test(`catalog ${label} blocks activation and same saved city reopen without default all`, async () => {
    const h = harness({ initialSection: section(undefined), alterCatalog: r => { alter(r); return r; } });
    try { await rejects(h.owner.start(PERIOD, undefined, CITY), 'catalog_discovery_mismatch');
      assert.deepEqual(h.db.section.value.active, active(undefined)); assert.deepEqual(h.db.section.value.pending_capture.discovery, CITY);
      assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
    } finally { h.owner.dispose(); }
    const reopening = harness({ initialSection: section(CITY), alterCatalog: r => { alter(r); return r; } });
    try { await rejects(reopening.owner.reopen(), 'catalog_discovery_mismatch');
      assert.equal(reopening.owner.getState().selection, null); assert.deepEqual(reopening.calls.map(c => c.kind), ['catalog']);
    } finally { reopening.owner.dispose(); }
  });
}
test('restore matches city identity separately from context; radius cannot adopt an unsolicited city catalog', () => {
  const input = { ...TARGET, contextRef: context(OLD), selection: { revision: 1, pockets: [] } };
  const checked = catalogHelpers.checkCustomCohortPocketCatalog(catalog(input, CITY), input);
  assert.deepEqual(checked.discovery, CITY); assert.equal(restore(section(CITY), checked).status, 'restored');
  assert.deepEqual(restore(section(CITY), checked).selection.pockets, []);
  assert.equal(restore(section(OTHER), checked).reason, 'catalog_discovery_mismatch');
  assert.equal(restore(section(radius('4828.032')), checked).reason, 'catalog_discovery_mismatch');
});
for (const [label, alter] of [['radius substituted', r => { r.discovery = { radius_metres: '4828.032' }; }],
  ['hash changed', r => { r.discovery.city.asset_sha256 = 'f'.repeat(64); }], ['extra radius', r => { r.discovery.radius_metres = '4828.032'; }]]) {
  test(`API and lifecycle reject city capture ${label}`, async () => {
    const a = apiHarness(r => { alter(r); return r; });
    await rejects(a.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: CITY }, io()), 'capture_discovery_mismatch');
    const h = harness({ initialSection: section(undefined), capture: input => { const result = reply(input); alter(result); return result; } });
    try { await rejects(h.owner.start(PERIOD, undefined, CITY), 'capture_discovery_mismatch');
      assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture']); assert.deepEqual(h.db.section.value.active, active(undefined));
    } finally { h.owner.dispose(); }
  });
}
test('city request is detached before awaiting pending save or API response', async () => {
  const entered = defer(), held = defer(), raw = copy(CITY), h = harness({ save: async (input, _io, commit) => {
    if (input.value.pending_capture) { entered.resolve(); await held.promise; } return commit(input); } });
  try { const work = h.owner.start(PERIOD, PRIVATE, raw); await entered.promise; raw.city.asset_sha256 = 'e'.repeat(64); held.resolve(); await work;
    assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.discovery, CITY);
  } finally { held.resolve(); h.owner.dispose(); }
  const apiEntered = defer(), apiHeld = defer(), apiRaw = copy(CITY), a = apiHarness(async result => { apiEntered.resolve(); await apiHeld.promise; return result; });
  const work = a.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: apiRaw }, io());
  await apiEntered.promise; apiRaw.city.asset_sha256 = 'd'.repeat(64); apiHeld.resolve();
  assert.deepEqual((await work).discovery.city, CITY.city);
});
test('lost pending ACK retains exact city/UUID and private review across fresh absent reload', async () => {
  let first = true; const h = harness({ save(input, _io, commit) { if (first) { first = false; throw Error('lost'); } return commit(input); } });
  try { await rejects(h.owner.start(PERIOD, PRIVATE, CITY), 'operation_failed'); await h.reload();
    await rejects(h.owner.start(PERIOD, PRIVATE, OTHER), 'recovery_required'); await h.owner.resumePending();
    assert.equal(h.ids, 1); assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.discovery, CITY);
    assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.privateSalesImport, PRIVATE);
  } finally { h.owner.dispose(); }
});
for (const [serverCode, workspaceCode] of [
  ['neighborhood_city_subject_outside_scope', 'city_subject_outside_scope'],
  ['neighborhood_city_source_unavailable', 'city_source_unavailable'],
]) test(`only exact HTTP422 city-capture ${serverCode} survives as a fixed UI code`, async () => {
  for (const [operation, scope, status, errorText, expected] of [
    ['capture', CITY, 422, serverCode, workspaceCode],
    ['capture', radius('4828.032'), 422, serverCode, 'request_failed'],
    ['capture', CITY, 500, serverCode, 'request_failed'],
    ['capture', CITY, 403, serverCode, 'request_failed'],
    ['capture', CITY, 422, `${serverCode}: secret source path`, 'request_failed'],
    ['catalog', CITY, 422, serverCode, 'request_failed'],
  ]) {
    const api = createApi({ urlFor: path => path, editorKeyForSave: () => assert.fail('capture never acquires editor key'),
      request: async () => new Response(JSON.stringify({ error: errorText, detail: 'secret source path' }),
        { status, headers: { 'content-type': 'application/json' } }) });
    const input = operation === 'capture' ? { target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: scope }
      : { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, contextRef: context(OLD), selection: { revision: 1, pockets: [] } };
    await assert.rejects(api[operation](input, io()), error => {
      assert.equal(error.workspaceCode, expected); assert.equal(error.status, status);
      assert.equal(error.message, `custom_workspace_${expected}`); assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes('secret source path')); return true;
    });
  }
});
for (const mismatch of [false, true]) test(`lost active ACK ${mismatch ? 'cannot resolve a modified city checkpoint' : 'resolves exact saved city without recapture'}`, async () => {
  const h = harness({ save(input, _io, commit) { const ack = commit(input); if (!input.value.pending_capture) throw Error('lost'); return ack; } });
  try { await rejects(h.owner.start(PERIOD, undefined, CITY), 'operation_failed');
    if (mismatch) h.db.section.value.active.discovery.city.asset_sha256 = 'f'.repeat(64);
    if (mismatch) await rejects(h.reload(), 'catalog_discovery_mismatch'); else await h.reload();
    assert.equal(h.owner.getState().status, mismatch ? 'error' : 'ready'); assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1);
  } finally { h.owner.dispose(); }
});
test('remounted private pending city resumes same UUID; clearing pending radius retains city and empty selection', async () => {
  const h = harness({ initialSection: section(undefined, pending(CITY, PRIVATE)) });
  try { await h.owner.resumePending(); assert.equal(h.ids, 0); assert.deepEqual(h.calls.map(c => c.kind), ['capture', 'catalog', 'save']);
    assert.deepEqual(h.db.section.value.active.discovery, CITY);
  } finally { h.owner.dispose(); }
  const clearing = harness({ initialSection: section(CITY, pending(radius('16093.44'))) });
  try { await clearing.owner.setAsidePending(); assert.deepEqual(clearing.calls.map(c => c.kind), ['save', 'catalog']);
    assert.deepEqual(clearing.db.section.value.active, active(CITY)); assert.deepEqual(clearing.owner.getState().selection.pockets, []);
  } finally { clearing.owner.dispose(); }
});
