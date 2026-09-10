import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as decoder from '../src/features/neighborhood/customReportedProposal.ts';
import * as presentation from '../src/features/neighborhood/customReportedObservationPresentation.ts';
import * as outline from '../src/features/neighborhood/acceptedNeighborhoodOutline.ts';
import { createCustomWorkspaceRequestLane } from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import { reportedObservationReportFixture } from '../../server/test/fixtures/reportedObservationReportFixture.js';

const runtime = createRequire(new URL('../package.json', import.meta.url)), ts = runtime('typescript'), jsx = runtime('react/jsx-runtime');
const { renderToStaticMarkup } = runtime('react-dom/server');
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TARGET = { accountId: 'SYNTHETIC', assignmentFileId: '125', sessionKey: 'synthetic-user-session' };
const CONTEXT = { context_id: uuid(1), context_revision: '1', context_sha256: 'a'.repeat(64) };
const EXPECTED = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
  contextRef: CONTEXT, workspaceRevision: 7, editorRevision: 5, operationId: uuid(2) };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 5000 });
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const normalized = reportedObservationReportFixture(raw => {
  const source = raw.statistics[2]; source.value = '9007199254740993.0199999999999';
  raw.statistics.push({ ...copy(source), id: 'low', estimator: 'exact_quantile', estimator_parameters: { convention: 'type_7', probability: 0 } });
  raw.statistics.push({ ...copy(source), id: 'high', estimator: 'exact_quantile', estimator_parameters: { convention: 'type_7', probability: 1 } });
  raw.statistics.push({ ...copy(source), id: 'unavailable-area', measurement: 'reported_living_area', unit: null, value: null,
    estimator: 'unsupported', status: 'unsupported', observed_count: 0, unsupported_count: 1, reason: 'unit_not_reviewed' });
  raw.geographic_neighborhood.geometry.coordinates.push([[-97.005, 32.995], [-97.004, 32.995], [-97.004, 32.996], [-97.005, 32.996], [-97.005, 32.995]]);
}).assessment;
function proposal(e = EXPECTED) {
  return { status: 'proposed', target: { account_id: e.accountId, assignment_file_id: e.assignmentFileId }, context_ref: copy(e.contextRef),
    workspace_section_revision: e.workspaceRevision, editor_revision: e.editorRevision, proposal_operation_id: e.operationId, reused: false,
    attachment_ref: { attachment_id: uuid(3), attachment_revision: 1, binding_digest: 'b'.repeat(64) }, assessment: {
      contract_version: 2, assessment_id: normalized.id, revision: normalized.revision, status: 'ready', basis: 'reported_observations_not_verified_market_facts',
      statistics: copy(normalized.statistics), populations: normalized.populations.map(pop => Object.fromEntries(
        ['id', 'kind', 'member_unit', 'member_count', 'unique_account_count', 'account_link_count'].map(key => [key, pop[key]]))),
      geography_status: 'ready', boundary: { geometry: copy(normalized.geographic_neighborhood.geometry), cardinal_summaries: copy(normalized.geographic_neighborhood.cardinal_summaries) },
    }, issues: [] };
}
const ack = (e = EXPECTED, operation = uuid(4)) => ({ status: 'accepted', target: { account_id: e.accountId, assignment_file_id: e.assignmentFileId },
  context_ref: copy(e.contextRef), operation_id: operation, proposal_operation_id: e.operationId, accepted_editor_revision: e.editorRevision + 1, reused: false });
function compile(url, overrides = {}, cache = new Map()) {
  const file = fileURLToPath(url); if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  assert.equal((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${output.outputText}\n})`, { filename: file }).runInThisContext()(name => {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (name.startsWith('.')) {
      let source = new URL(name, url); if (!existsSync(source)) source = new URL(`${name}.ts`, url);
      return compile(source, overrides, cache);
    }
    assert.ok(['react', 'react/jsx-runtime'].includes(name)); return runtime(name);
  }, module, module.exports); cache.set(file, module.exports); return module.exports;
}
const { createCustomWorkspaceApi } = compile(new URL('../src/features/neighborhood/customWorkspaceApi.ts', import.meta.url));

test('decoder keeps every exact supplied statistic and proposed boundary in a detached frozen result', () => {
  const raw = proposal(), before = copy(raw), result = decoder.decodeCustomReportedProposal(raw, EXPECTED);
  assert.equal(result.status, 'proposed'); assert.deepEqual(result.statistics, raw.assessment.statistics);
  assert.deepEqual(result.boundary, raw.assessment.boundary); assert.equal(result.statistics.length, 7);
  assert.equal(result.statistics[2].value, '9007199254740993.0199999999999');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.statistics[0]) && Object.isFrozen(result.boundary.geometry.coordinates[0]));
  raw.assessment.statistics[2].value = '1'; assert.notEqual(result.statistics[2].value, '1');
  assert.deepEqual(before.assessment.statistics, result.statistics);
});

for (const [name, change] of [
  ['foreign account', x => { x.target.account_id = 'OTHER'; }], ['foreign file', x => { x.target.assignment_file_id = '126'; }],
  ['number file', x => { x.target.assignment_file_id = 125; }], ['foreign context', x => { x.context_ref.context_id = uuid(10); }],
  ['context hash', x => { x.context_ref.context_sha256 = 'c'.repeat(64); }], ['workspace CAS', x => { x.workspace_section_revision++; }],
  ['editor CAS', x => { x.editor_revision++; }], ['operation', x => { x.proposal_operation_id = uuid(10); }],
  ['unknown field', x => { x.secret = true; }], ['claim basis', x => { x.assessment.basis = 'verified'; }],
  ['coerced status', x => { x.status = ['incomplete']; x.attachment_ref = null; x.issues = [{ code: 'not_ready' }]; }],
  ['coerced estimator', x => { x.assessment.statistics[6].estimator = ['unsupported']; }],
  ['missing attachment', x => { x.attachment_ref = null; }], ['invalid attachment ID', x => { x.attachment_ref.attachment_id = 'x'; }],
  ['wrong digest', x => { x.attachment_ref.binding_digest = 'bad'; }], ['ready issue', x => { x.issues = [{ code: 'incomplete' }]; }],
  ['unknown version', x => { x.assessment.contract_version = 1; }], ['raw evidence', x => { x.assessment.raw_cells = []; }],
  ['legacy property units', x => { x.assessment.populations[0].member_unit = 'property'; }],
  ['duplicate population', x => { x.assessment.populations.push(copy(x.assessment.populations[0])); }],
  ['duplicate statistic', x => { x.assessment.statistics.push(copy(x.assessment.statistics[0])); }],
  ['too many account links', x => { x.assessment.populations[1].account_link_count = 1001; }],
  ['zero unique nonempty', x => { x.assessment.populations[1].unique_account_count = 0; }],
  ['counts do not partition', x => { x.assessment.statistics[2].invalid_count = 1; }],
  ['count observed must equal denominator', x => { x.assessment.statistics[0].observed_count = 1; x.assessment.statistics[0].missing_count = 1; }],
  ['unsupported estimator wrong state', x => { x.assessment.statistics[6].status = 'incomplete'; }],
  ['count noncount estimator', x => { x.assessment.statistics[0].estimator = 'exact_median'; }],
  ['amount count estimator', x => { x.assessment.statistics[2].estimator = 'count'; }],
  ['number price', x => { x.assessment.statistics[2].value = 12; }], ['exponent money', x => { x.assessment.statistics[2].value = '1e6'; }],
  ['unknown quantile convention', x => { x.assessment.statistics[4].estimator_parameters.convention = 'other'; }],
  ['impossible calendar', x => { x.assessment.statistics[2].observation_period.end_date = '2026-02-30'; }],
  ['period mismatch', x => { x.assessment.statistics[2].observation_period = { ...x.assessment.statistics[2].observation_period, end_date: '2026-09-09' }; }],
  ['wrong period basis', x => { x.assessment.statistics[0].observation_period.date_basis = 'closing_date'; }],
  ['missing ready sources', x => { x.assessment.statistics[2].source_refs = []; }],
  ['duplicate sources', x => { x.assessment.statistics[2].source_refs.push(x.assessment.statistics[2].source_refs[0]); }],
  ['missing boundary', x => { delete x.assessment.boundary; }], ['ready absent boundary', x => { x.assessment.boundary.geometry = null; }],
  ['coordinate out of range', x => { x.assessment.boundary.geometry.coordinates[0][1][0] = 181; }],
  ['unclosed polygon', x => { x.assessment.boundary.geometry.coordinates[0].pop(); }],
  ['invented geometry', x => { x.assessment.boundary.geometry.type = 'Circle'; }],
  ['ready null cardinal', x => { x.assessment.boundary.cardinal_summaries.north = null; }],
  ['extra authority', x => { x.assessment.boundary.validation = { valid: true }; }],
]) test(`proposal fails closed: ${name}`, () => { const raw = proposal(); change(raw); assert.throws(() => decoder.decodeCustomReportedProposal(raw, EXPECTED)); });
for (const probability of ['0', '1', null, false, true, [], 0.5, Infinity]) test(`quantile probability is not coerced: ${probability}`, () => {
  const raw = proposal(); raw.assessment.statistics[4].estimator_parameters.probability = probability;
  assert.throws(() => decoder.decodeCustomReportedProposal(raw, EXPECTED));
});
test('incomplete null assessment and optional incomplete counters remain honest, never an attachment', () => {
  const raw = proposal(); Object.assign(raw, { status: 'incomplete', assessment: null, attachment_ref: null, issues: [{ code: 'historical_stock_evidence_required' }] });
  assert.equal(decoder.decodeCustomReportedProposal(raw, EXPECTED).boundary, null);
  const limited = proposal(); limited.status = 'incomplete'; limited.attachment_ref = null; limited.issues = [{ code: 'source_incomplete' }];
  limited.assessment.status = 'incomplete'; limited.assessment.geography_status = 'incomplete'; limited.assessment.boundary.geometry = null;
  Object.assign(limited.assessment.populations[1], { member_count: null, unique_account_count: null, account_link_count: null });
  limited.assessment.statistics = limited.assessment.statistics.filter(s => s.population_id === 'accounts');
  const result = decoder.decodeCustomReportedProposal(limited, EXPECTED); assert.equal(result.populations[1].member_count, null); assert.equal(result.attachment, null);
});
test('full 1000-account association denominator is retained; private five-account semantics are not imposed on shared source rows', () => {
  const raw = proposal(); Object.assign(raw.assessment.populations[1], { unique_account_count: 1000, account_link_count: 1000 });
  assert.equal(decoder.decodeCustomReportedProposal(raw, EXPECTED).populations[1].account_link_count, 1000);
});
test('proposal bytes, node graph and getters are bounded before display', () => {
  for (const modify of [x => { x.issues = [{ code: 'x'.repeat(524289) }]; }, x => { x.extra = x; }, x => { x.extra = new Array(100001).fill(null); }]) {
    const raw = proposal(); modify(raw); assert.throws(() => decoder.decodeCustomReportedProposal(raw, EXPECTED));
  }
  let called = false; const raw = proposal(); Object.defineProperty(raw, 'assessment', { enumerable: true, get() { called = true; return null; } });
  assert.throws(() => decoder.decodeCustomReportedProposal(raw, EXPECTED)); assert.equal(called, false);
});
for (const patch of [{ operationId: 'bad' }, { editorRevision: 2147483647 }, { workspaceRevision: 0 }, { contextRef: { ...CONTEXT, context_revision: '2' } }]) {
  test(`expectation must be an exact supported request identity: ${JSON.stringify(patch)}`, () => {
    const expected = { ...EXPECTED, ...patch }; assert.throws(() => decoder.decodeCustomReportedProposal(proposal(expected), expected));
  });
}
test('Apply acknowledgment is only the exact same operation/proposal/context and next report editor revision', () => {
  assert.equal(decoder.checkCustomReportedApply(ack(), EXPECTED, uuid(4)), 6);
  for (const modify of [x => { x.operation_id = uuid(9); }, x => { x.proposal_operation_id = uuid(9); }, x => { x.context_ref.context_sha256 = 'f'.repeat(64); },
    x => { x.target.account_id = 'OTHER'; }, x => { x.accepted_editor_revision = 5; }, x => { x.accepted_editor_revision = '6'; }, x => { x.status = 'prepared'; }, x => { x.raw = []; }]) {
    const value = ack(); modify(value); assert.throws(() => decoder.checkCustomReportedApply(value, EXPECTED, uuid(4)));
  }
});

function fakeHttp() {
  const calls = [], overrides = new Map(), seen = new Set();
  const read = () => ({ ok: true, account_id: TARGET.accountId, workfile: { assignment_file_id: 125, status: 'draft',
    sections: { neighborhood_workspace: { revision: 77, value: { synthetic: true } }, neighborhood_assessment: { revision: 5, value: { synthetic: 'not acceptance authority' } } } } });
  const request = async (url, init) => {
    const kind = url.endsWith('/workfile') ? 'read' : url.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
    const call = { url, init, kind, body }; calls.push(call);
    const respond = () => {
      if (kind === 'read') return json(read());
      const e = { ...EXPECTED, contextRef: body.context_ref, workspaceRevision: body.expected_workspace_revision,
        editorRevision: body.expected_editor_revision, operationId: body.operation_id };
      if (kind === 'reported-proposal') return json(proposal(e));
      assert.equal(kind, 'reported-apply'); e.operationId = body.proposal_operation_id;
      const result = ack(e, body.operation_id); result.reused = seen.has(body.operation_id); seen.add(body.operation_id); return json(result);
    };
    return overrides.has(kind) ? overrides.get(kind)(call, respond) : respond();
  };
  const api = createCustomWorkspaceApi({ request, urlFor: path => `/synthetic${path}`, editorKeyForSave: () => { throw new Error('No generic section writes'); } });
  return { api, calls, overrides, read };
}
test('actual API report editor read selects only reserved revision, not workspace revision', async () => {
  const server = fakeHttp(); assert.equal(await server.api.readReportEditor(TARGET, io()), 5);
  const [{ url, init }] = server.calls; assert.equal(url, '/synthetic/api/accounts/SYNTHETIC/assignment-files/125/workfile');
  assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.ok(init.signal instanceof AbortSignal);
  server.overrides.set('read', () => { const body = server.read(); delete body.workfile.sections.neighborhood_assessment; return json(body); });
  assert.equal(await server.api.readReportEditor(TARGET, io()), 0);
});
for (const [name, change] of [
  ['signed', x => { x.workfile.status = 'signed'; }], ['archived', x => { x.workfile.status = 'archived'; }],
  ['foreign account', x => { x.account_id = 'OTHER'; }], ['foreign file', x => { x.workfile.assignment_file_id = 126; }],
  ['null reserved', x => { x.workfile.sections.neighborhood_assessment = null; }], ['zero revision', x => { x.workfile.sections.neighborhood_assessment.revision = 0; }],
  ['string revision', x => { x.workfile.sections.neighborhood_assessment.revision = '5'; }], ['exhausted', x => { x.workfile.sections.neighborhood_assessment.revision = 2147483647; }],
]) test(`actual API report editor refuses ${name}`, async () => {
  const server = fakeHttp(); server.overrides.set('read', () => { const body = server.read(); change(body); return json(body); });
  await assert.rejects(server.api.readReportEditor(TARGET, io()));
});
test('actual report POST transport has exact command, scope and no editor key, session or fact mutation', async () => {
  const server = fakeHttp(), options = io();
  const body = { context_ref: CONTEXT, expected_workspace_revision: 7, expected_editor_revision: 5, operation_id: EXPECTED.operationId };
  const response = await server.api.reportedOperation({ target: TARGET, operation: 'reported-proposal', body }, options);
  assert.equal(decoder.decodeCustomReportedProposal(response, EXPECTED).status, 'proposed');
  const call = server.calls[0]; assert.equal(call.url, '/synthetic/api/accounts/SYNTHETIC/neighborhood-cohort/reported-proposal');
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.signal, options.signal);
  assert.deepEqual(call.body, { assignment_file_id: '125', ...body }); assert.equal(call.init.headers['content-type'], 'application/json');
  assert.ok(!JSON.stringify(call).includes(TARGET.sessionKey)); assert.equal(call.init.headers['x-homenode-editor-key'], undefined);
  await assert.rejects(server.api.reportedOperation({ target: TARGET, operation: 'reported-proposal', body: { ...body, assignment_file_id: '126' } }, io()));
  assert.equal(server.calls.length, 1);
});
test('API abort cancels ignored late response bodies; fixed error strips server detail without automatic retry', async () => {
  const server = fakeHttp(), held = deferred(), abort = new AbortController(); let cancelled = 0;
  server.overrides.set('reported-proposal', () => held.promise);
  const request = server.api.reportedOperation({ target: TARGET, operation: 'reported-proposal', body: {} }, { signal: abort.signal, deadline: performance.now() + 5000 });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await assert.rejects(request, error => error.name === 'AbortError');
  held.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
  server.overrides.set('reported-proposal', () => json({ error: 'sensitive SQL details' }, 403));
  await assert.rejects(server.api.reportedOperation({ target: TARGET, operation: 'reported-proposal', body: {} }, io()), error => {
    assert.equal(error.message, 'custom_workspace_request_failed'); assert.equal(error.status, 403); return true;
  }); assert.equal(server.calls.length, 2);
});

const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const textOf = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? children(node).map(textOf).join('') : '';
const depsEqual = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
/** Deterministic hook dispatcher with real React elements and SSR, matching the
 * existing harness. Actual API/transport/lane run; HTTP is synthetic. Not a
 * browser or React concurrent-renderer scheduling claim. */
function harness(t, server = fakeHttp(), overrides = {}) {
  let fiber, cursor = 0, dirty = false, tree, props;
  const uncertainty = [], accepted = [], controls = [], lane = createCustomWorkspaceRequestLane();
  const react = {
    useRef(value) { return fiber.cells[cursor++] ??= { current: value }; },
    useState(initial) {
      const owner = fiber, index = cursor++; owner.cells[index] ??= { value: initial };
      return [owner.cells[index].value, value => { if (owner.live) { owner.cells[index].value = typeof value === 'function' ? value(owner.cells[index].value) : value; dirty = true; } }];
    },
    useEffect(setup, deps) {
      const index = cursor++, prior = fiber.cells[index];
      if (!prior || !depsEqual(prior.deps, deps)) { const effect = { setup, deps, cleanup: prior?.cleanup }; fiber.cells[index] = effect;
        fiber.effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); }); }
    },
  };
  const Component = compile(new URL('../src/features/neighborhood/components/CustomReportedObservationAdoption.tsx', import.meta.url), {
    react, 'react/jsx-runtime': jsx, '../customReportedProposal': decoder,
    '../customReportedObservationPresentation': presentation, '../acceptedNeighborhoodOutline': outline,
  }).default;
  const cleanup = () => { if (!fiber) return; fiber.cells.forEach(cell => cell?.cleanup?.()); fiber.live = false; fiber = null; };
  function render(next = props) {
    props = next; dirty = false; const wrapper = Component(props);
    if (!fiber || fiber.key !== wrapper.key) { cleanup(); fiber = { key: wrapper.key, cells: [], effects: [], live: true }; }
    cursor = 0; tree = wrapper.type(wrapper.props); fiber.effects.splice(0).forEach(fn => fn());
  }
  function flush() { let turns = 0; while (dirty) { assert.ok(++turns < 30); render(); } }
  props = { target: copy(TARGET), contextRef: copy(CONTEXT), workspaceRevision: 7, api: server.api, disabled: false,
    onOutcomeUncertain: value => uncertainty.push(value), onAccepted: async () => { accepted.push(true); return true; },
    run: async task => { const abort = new AbortController(); controls.push(abort);
      try { await lane.run(({ signal }) => task({ signal, deadline: performance.now() + 5000 }), { signal: abort.signal }); return true; } catch { return false; } }, ...overrides };
  render(); flush(); t.after(() => { cleanup(); lane.dispose(); });
  return { server, uncertainty, accepted, controls, get props() { return props; },
    render(next) { render(next); flush(); }, html: () => renderToStaticMarkup(tree), text: () => textOf(tree),
    button(label) { return walk(tree).find(node => node.type === 'button' && textOf(node) === label); },
    click(label) { const node = this.button(label); assert.ok(node, label); assert.equal(Boolean(node.props.disabled), false, label); node.props.onClick(); flush(); },
    async settle() { for (let round = 0; round < 12; round++) { for (let i = 0; i < 24; i++) await Promise.resolve(); flush(); } },
    strictReplay() { const effects = fiber.cells.filter(cell => cell?.setup); effects.forEach(effect => effect.cleanup?.()); effects.forEach(effect => { effect.cleanup = effect.setup(); }); flush(); },
    unmount: cleanup,
  };
}
const PREPARE = 'Prepare report group', APPLY = 'Apply boundary and statistics together';
async function prepared(t, server, props) { const h = harness(t, server, props); h.click(PREPARE); await h.settle(); assert.ok(h.button(APPLY)); return h; }

test('rendered proposal is explicit, complete, includes exact boundary holes, every estimator and no automatic Apply', async t => {
  const server = fakeHttp(), h = harness(t, server); assert.equal(server.calls.length, 0);
  h.click(PREPARE); await h.settle(); assert.deepEqual(server.calls.map(c => c.kind), ['read', 'reported-proposal']);
  const html = h.html(); for (const label of ['Low (type 7 quantile)', 'High (type 7 quantile)', 'Count', 'Median (not predominant)', 'Unavailable - unit_not_reviewed']) assert.ok(html.includes(label), label);
  assert.match(html, /9,007,199,254,740,993\.02/); assert.match(html, /title="9007199254740993\.0199999999999"/);
  assert.match(html, /Proposed observation boundary/); assert.match(html, /Appraiser north boundary/); assert.match(html, /fill-rule="evenodd"/);
  const path = outline.acceptedNeighborhoodOutline(normalized.geographic_neighborhood.geometry).paths[0]; assert.ok(html.includes(path)); assert.equal((path.match(/M/g) ?? []).length, 2);
  assert.equal(h.uncertainty.length, 0); assert.equal(h.accepted.length, 0);
  const readOrder = html.match(/<dt class="font-medium capitalize">(north|east|south|west)<\/dt>/g); assert.equal(readOrder.length, 4);
});
test('same-tick double prepare and Apply callbacks are single-flight and stale callbacks cannot save twice', async t => {
  const h = harness(t), prepare = h.button(PREPARE).props.onClick; prepare(); prepare(); await h.settle();
  assert.deepEqual(h.server.calls.map(c => c.kind), ['read', 'reported-proposal']);
  const apply = h.button(APPLY).props.onClick; apply(); apply(); await h.settle();
  assert.equal(h.server.calls.filter(c => c.kind === 'reported-apply').length, 1); assert.deepEqual(h.uncertainty, [true, false]);
  assert.equal(h.accepted.length, 1); apply(); prepare(); await h.settle(); assert.equal(h.server.calls.length, 3);
  assert.match(h.text(), /saved together and reopened/);
});
test('lost proposal ACK retries the exact UUID/editor/workspace identity without another editor read', async t => {
  const server = fakeHttp(); let first = true;
  server.overrides.set('reported-proposal', (_call, respond) => { if (first) { first = false; throw new Error('synthetic lost ACK'); } return respond(); });
  const h = harness(t, server); h.click(PREPARE); await h.settle(); h.click('Retry report proposal'); await h.settle();
  const posts = server.calls.filter(c => c.kind === 'reported-proposal'); assert.equal(posts.length, 2); assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(server.calls.filter(c => c.kind === 'read').length, 1); assert.equal(h.uncertainty.length, 0);
});
test('lost durable Apply ACK keeps uncertainty and retries the identical operation until checked replay', async t => {
  const server = fakeHttp(); let first = true;
  server.overrides.set('reported-apply', (_call, respond) => { const value = respond(); if (first) { first = false; throw new Error('lost acknowledgement'); } return value; });
  const h = await prepared(t, server); h.click(APPLY); await h.settle(); assert.deepEqual(h.uncertainty, [true]); assert.equal(h.accepted.length, 0);
  assert.equal(h.button('Reload this proposal').props.disabled, true); h.button('Reload this proposal').props.onClick(); await h.settle();
  h.click('Retry same Apply request'); await h.settle(); const posts = server.calls.filter(c => c.kind === 'reported-apply');
  assert.deepEqual(posts[0].body, posts[1].body); assert.deepEqual(h.uncertainty, [true, true, false]); assert.equal(h.accepted.length, 1);
});
test('invalid Apply ACK does not clear host barrier, and onAccepted failure after valid ACK is not a failed save', async t => {
  const server = fakeHttp(); let bad = true;
  server.overrides.set('reported-apply', async (_call, respond) => { const body = await respond().json(); if (bad) { bad = false; body.accepted_editor_revision++; } return json(body); });
  const h = await prepared(t, server, { onAccepted: async () => { throw new Error('refresh failed'); } });
  h.click(APPLY); await h.settle(); assert.deepEqual(h.uncertainty, [true]); h.click('Retry same Apply request'); await h.settle();
  assert.deepEqual(h.uncertainty, [true, true]); assert.match(h.text(), /were saved. Reload the accepted group/); assert.doesNotMatch(h.html(), /role="alert"/);
  assert.equal(h.button('Retry same Apply request'), undefined); assert.equal(h.button(APPLY), undefined);
  const before = server.calls.length; h.render({ ...h.props, onAccepted: async () => true });
  h.click('Reload accepted group'); await h.settle(); assert.equal(server.calls.length, before, 'Fresh-read callback only: no proposal or Apply request');
  assert.deepEqual(h.uncertainty, [true, true, false]); assert.equal(h.button('Reload accepted group'), undefined);
});
test('known ACK retains the Save/Sign latch until its fresh read resolves; reload-only action is single-flight', async t => {
  const read = deferred(); let reads = 0;
  const h = await prepared(t, undefined, { onAccepted: async () => { reads++; return read.promise; } });
  h.click(APPLY); await h.settle(); assert.deepEqual(h.uncertainty, [true]); assert.equal(reads, 1);
  assert.equal(h.button('Reload accepted group').props.disabled, true); assert.equal(h.button(APPLY), undefined);
  read.resolve(false); await h.settle(); assert.deepEqual(h.uncertainty, [true]);
  const retry = deferred(); h.render({ ...h.props, onAccepted: async () => { reads++; return retry.promise; } });
  const reload = h.button('Reload accepted group').props.onClick; reload(); reload(); await h.settle(); assert.equal(reads, 2);
  retry.resolve(true); await h.settle(); assert.deepEqual(h.uncertainty, [true, false]);
  assert.equal(h.server.calls.filter(c => c.kind === 'reported-apply').length, 1);
});
test('an aborted Apply response remains uncertain and never becomes an accepted UI update', async t => {
  const server = fakeHttp(), held = deferred(); server.overrides.set('reported-apply', async (_call, respond) => { await held.promise; return respond(); });
  const h = await prepared(t, server); h.click(APPLY); await h.settle(); h.controls.at(-1).abort(); await h.settle();
  assert.deepEqual(h.uncertainty, [true]); held.resolve(); await h.settle(); assert.equal(h.accepted.length, 0);
  assert.deepEqual(h.uncertainty, [true]); assert.ok(h.button('Retry same Apply request'));
});
test('disabled controls also reject retained direct callbacks; ordinary rerenders preserve proposal and operation', async t => {
  const h = await prepared(t), oldApply = h.button(APPLY).props.onClick;
  for (let i = 0; i < 4; i++) h.render({ ...h.props, target: copy(TARGET), contextRef: copy(CONTEXT), onAccepted: async () => true });
  await h.settle(); assert.equal(h.server.calls.length, 2); h.render({ ...h.props, disabled: true }); oldApply(); await h.settle(); assert.equal(h.server.calls.length, 2);
  h.render({ ...h.props, disabled: false }); h.click(APPLY); await h.settle(); assert.equal(h.server.calls.length, 3);
});
for (const [name, patch] of [['file', { target: { ...TARGET, assignmentFileId: '126' } }], ['session', { target: { ...TARGET, sessionKey: 'new-session' } }],
  ['context', { contextRef: { ...CONTEXT, context_id: uuid(9) } }], ['workspace', { workspaceRevision: 8 }]]) {
  test(`late proposal after ${name} change cannot populate the new owner or invoke its callbacks`, async t => {
    const server = fakeHttp(), held = deferred(); server.overrides.set('reported-proposal', async (_call, respond) => { await held.promise; return respond(); });
    const h = harness(t, server); h.click(PREPARE); await h.settle(); h.render({ ...h.props, ...patch }); held.resolve(); await h.settle();
    assert.ok(h.button(PREPARE)); assert.equal(h.button(APPLY), undefined); assert.equal(h.uncertainty.length, 0); assert.equal(h.accepted.length, 0);
  });
}
test('unmounted late Apply ACK neither clears another owner barrier nor calls onAccepted', async t => {
  const server = fakeHttp(), held = deferred(); server.overrides.set('reported-apply', async (_call, respond) => { await held.promise; return respond(); });
  const h = await prepared(t, server); h.click(APPLY); await h.settle(); assert.deepEqual(h.uncertainty, [true]); h.unmount(); held.resolve(); await h.settle();
  assert.deepEqual(h.uncertainty, [true]); assert.equal(h.accepted.length, 0);
});
test('StrictMode effect replay ignores an earlier read generation without auto-recapture or duplicate requests', async t => {
  const server = fakeHttp(), held = deferred(); server.overrides.set('read', async (_call, respond) => { await held.promise; return respond(); });
  const h = harness(t, server); h.strictReplay(); assert.equal(server.calls.length, 0); h.click(PREPARE); await h.settle(); h.strictReplay(); held.resolve(); await h.settle();
  assert.deepEqual(server.calls.map(c => c.kind), ['read']); assert.ok(h.button(PREPARE)); assert.equal(h.button(APPLY), undefined);
});
test('incomplete response shows reasons and no Apply button or success implication', async t => {
  const server = fakeHttp(); server.overrides.set('reported-proposal', async (_call, respond) => { const value = await respond().json();
    Object.assign(value, { status: 'incomplete', assessment: null, attachment_ref: null, issues: [{ code: 'historical_stock_evidence_required' }] }); return json(value); });
  const h = harness(t, server); h.click(PREPARE); await h.settle(); assert.equal(h.button(APPLY), undefined);
  assert.match(h.text(), /current CAD data cannot stand in for it/); assert.deepEqual(h.uncertainty, []);
});
