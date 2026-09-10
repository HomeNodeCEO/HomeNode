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


const REPLACEMENT = { kind: 'accepted_custom_reported_group', predecessor: {
  acceptance_id: uuid(20), operation_id: uuid(21), accepted_editor_revision: 5, section_value_sha256: 'c'.repeat(64),
} };
const intent = { kind: 'accepted_custom_reported_group' };
const replacing = { ...EXPECTED, replacement: intent };
const pinned = { ...EXPECTED, replacement: REPLACEMENT };
const replacementProposal = (e = replacing) => ({ ...proposal(e), replacement: copy(REPLACEMENT) });
const replacementAck = (e = pinned, operation = uuid(4)) => ({ ...ack(e, operation), replacement: copy(REPLACEMENT) });

// Synthetic HTTP only. Real bounded transport, API, decoder, lane, component
// and source-contract assessment fixture are used; no accepted database claim.
function fakeHttp(editorRevision = 5) {
  const calls = [], overrides = new Map(), seen = new Set();
  const read = () => ({ ok: true, account_id: TARGET.accountId, workfile: { assignment_file_id: 125, status: 'draft',
    sections: { neighborhood_workspace: { revision: 77, value: { synthetic: true } },
      ...(editorRevision ? { neighborhood_assessment: { revision: editorRevision, value: { synthetic: 'not acceptance authority' } } } : {}) } } });
  const request = async (url, init) => {
    const kind = url.endsWith('/workfile') ? 'read' : url.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
    const call = { url, init, kind, body }; calls.push(call);
    const respond = () => {
      if (kind === 'read') return json(read());
      const e = { ...EXPECTED, contextRef: body.context_ref, workspaceRevision: body.expected_workspace_revision,
        editorRevision: body.expected_editor_revision, operationId: body.operation_id };
      if (kind === 'reported-proposal') return json(body.replacement ? replacementProposal(e) : proposal(e));
      assert.equal(kind, 'reported-apply'); e.operationId = body.proposal_operation_id;
      const result = body.replacement ? replacementAck(e, body.operation_id) : ack(e, body.operation_id);
      result.reused = seen.has(body.operation_id); seen.add(body.operation_id); return json(result);
    };
    return overrides.has(kind) ? overrides.get(kind)(call, respond) : respond();
  };
  const api = createCustomWorkspaceApi({ request, urlFor: path => `/synthetic${path}`, editorKeyForSave: () => { throw new Error('No generic section writes'); } });
  return { api, calls, overrides, read };
}
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

const PREPARE = 'Prepare report group', CHOOSE = 'Prepare replacement', APPLY = 'Replace saved boundary and statistics together', CANCEL = 'Cancel replacement';
async function prepared(t, server = fakeHttp(), props) {
  const h = harness(t, server, props); h.click(PREPARE); await h.settle();
  assert.deepEqual(server.calls.map(c => c.kind), ['read']);
  h.click(CHOOSE); await h.settle(); assert.ok(h.button(APPLY)); return h;
}

test('first adoption retains its exact absent-replacement decoder and ACK shapes', () => {
  const before = decoder.decodeCustomReportedProposal(proposal(), EXPECTED);
  assert.equal(Object.hasOwn(before, 'replacement'), false);
  assert.equal(decoder.checkCustomReportedApply(ack(), EXPECTED, uuid(4)), 6);
  assert.throws(() => decoder.decodeCustomReportedProposal(replacementProposal(), EXPECTED));
  assert.throws(() => decoder.checkCustomReportedApply(replacementAck(), EXPECTED, uuid(4)));
});
test('replacement keeps exact server-resolved predecessor, full boundary/statistics and frozen shape', () => {
  const raw = replacementProposal(), before = copy(raw), result = decoder.decodeCustomReportedProposal(raw, replacing);
  assert.deepEqual(result.replacement, REPLACEMENT); assert.deepEqual(result.statistics, raw.assessment.statistics);
  assert.deepEqual(result.boundary, raw.assessment.boundary); assert.ok(Object.isFrozen(result.replacement.predecessor));
  raw.replacement.predecessor.acceptance_id = uuid(90);
  assert.equal(result.replacement.predecessor.acceptance_id, before.replacement.predecessor.acceptance_id);
  assert.equal(decoder.decodeCustomReportedProposal(before, pinned).status, 'proposed');
  assert.equal(decoder.checkCustomReportedApply(replacementAck(), pinned, uuid(4)), 6);
});
for (const [name, change] of [
  ['missing', r => { delete r.replacement; }], ['null', r => { r.replacement = null; }],
  ['undefined', r => { r.replacement = undefined; }], ['intent only', r => { delete r.replacement.predecessor; }],
  ['wrong kind', r => { r.replacement.kind = 'overwrite'; }], ['extra replacement', r => { r.replacement.force = true; }],
  ['extra predecessor', r => { r.replacement.predecessor.attachment_id = uuid(9); }],
  ['bad acceptance', r => { r.replacement.predecessor.acceptance_id = 'bad'; }],
  ['uppercase operation', r => { r.replacement.predecessor.operation_id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'; }],
  ['zero predecessor', r => { r.replacement.predecessor.accepted_editor_revision = 0; }],
  ['wrong revision', r => { r.replacement.predecessor.accepted_editor_revision = 6; }],
  ['string revision', r => { r.replacement.predecessor.accepted_editor_revision = '5'; }],
  ['bad hash', r => { r.replacement.predecessor.section_value_sha256 = 'z'.repeat(64); }],
  ['uppercase hash', r => { r.replacement.predecessor.section_value_sha256 = 'A'.repeat(64); }],
  ['missing operation', r => { delete r.replacement.predecessor.operation_id; }],
]) test(`replacement response is exact and closed: ${name}`, () => {
  const proposal = replacementProposal(), ack = replacementAck(); change(proposal); change(ack);
  assert.throws(() => decoder.decodeCustomReportedProposal(proposal, replacing));
  assert.throws(() => decoder.checkCustomReportedApply(ack, pinned, uuid(4)));
});
for (const [key, value] of [['acceptance_id', uuid(30)], ['operation_id', uuid(31)], ['section_value_sha256', 'd'.repeat(64)]]) {
  test(`reload and Apply refuse altered pinned predecessor ${key}`, () => {
    const p = replacementProposal(), a = replacementAck(); p.replacement.predecessor[key] = value; a.replacement.predecessor[key] = value;
    assert.throws(() => decoder.decodeCustomReportedProposal(p, pinned));
    assert.throws(() => decoder.checkCustomReportedApply(a, pinned, uuid(4)));
  });
}
for (const value of [null, undefined, {}, { kind: 'other' }, { ...intent, force: true }]) test(`replacement expectation is not permissive: ${JSON.stringify(value)}`, () => {
  assert.throws(() => decoder.decodeCustomReportedProposal(replacementProposal(), { ...EXPECTED, replacement: value }));
});
test('Apply requires the pinned full predecessor; revision-zero intent cannot adopt', () => {
  assert.throws(() => decoder.checkCustomReportedApply(replacementAck(), replacing, uuid(4)));
  assert.throws(() => decoder.decodeCustomReportedProposal(replacementProposal(), { ...replacing, editorRevision: 0 }));
});
test('incomplete replacement still preserves exact predecessor and never grants an attachment', () => {
  const raw = replacementProposal(); Object.assign(raw, { status: 'incomplete', assessment: null, attachment_ref: null, issues: [{ code: 'manual_cardinal_descriptions_required' }] });
  const result = decoder.decodeCustomReportedProposal(raw, replacing); assert.equal(result.attachment, null); assert.deepEqual(result.replacement, REPLACEMENT);
});
test('occupied editor reads once, requires explicit choice, and never submits implicit first adoption', async t => {
  const server = fakeHttp(), h = harness(t, server); h.click(PREPARE); await h.settle();
  assert.deepEqual(server.calls.map(c => c.kind), ['read']); assert.ok(h.button(CHOOSE)); assert.equal(h.button(APPLY), undefined);
  assert.match(h.text(), /already saved at editor revision 5/); assert.match(h.text(), /boundary, selection, populations, statistics and evidence together/);
  for (let i = 0; i < 3; i++) h.render({ ...h.props, contextRef: copy(CONTEXT), target: copy(TARGET) });
  await h.settle(); assert.equal(server.calls.length, 1); assert.deepEqual(h.uncertainty, []); assert.deepEqual(h.accepted, []);
  h.click(CHOOSE); await h.settle();
  const post = server.calls.at(-1); assert.deepEqual(post.body.replacement, intent); assert.equal(post.body.expected_editor_revision, 5);
  assert.equal(post.body.expected_workspace_revision, 7); assert.equal(post.body.assignment_file_id, '125');
  assert.equal(Object.hasOwn(post.body, 'predecessor'), false);
  assert.equal(server.calls.filter(c => c.kind === 'read').length, 1);
  assert.match(h.text(), /saved editor revision 5 with revision 6/);
  assert.match(h.html(), /9,007,199,254,740,993\.02/); assert.match(h.html(), /fill-rule="evenodd"/);
  assert.deepEqual(h.accepted, []);
});
test('revision-zero component still submits the unchanged first-adoption request', async t => {
  const h = harness(t, fakeHttp(0)); h.click(PREPARE); await h.settle();
  const post = h.server.calls.at(-1); assert.equal(post.body.expected_editor_revision, 0); assert.equal(Object.hasOwn(post.body, 'replacement'), false);
  assert.equal(h.button(CHOOSE), undefined); h.click('Apply boundary and statistics together'); await h.settle();
  assert.equal(Object.hasOwn(h.server.calls.at(-1).body, 'replacement'), false); assert.deepEqual(h.uncertainty, [true, false]);
});
test('cancel occupied choice makes no proposal or Apply; stale replacement callback cannot reopen it', async t => {
  const h = harness(t); h.click(PREPARE); await h.settle(); const stale = h.button(CHOOSE).props.onClick;
  h.click(CANCEL); stale(); await h.settle(); assert.deepEqual(h.server.calls.map(c => c.kind), ['read']);
  assert.deepEqual(h.accepted, []); assert.deepEqual(h.uncertainty, []); assert.match(h.text(), /saved report group has not been changed/);
});
test('cancel prepared replacement cannot Apply a stale callback or alter saved report; explicit fresh attempt gets new UUID', async t => {
  const h = await prepared(t), staleApply = h.button(APPLY).props.onClick, old = h.server.calls.at(-1).body.operation_id;
  h.click(CANCEL); staleApply(); await h.settle(); assert.equal(h.server.calls.length, 2); assert.deepEqual(h.accepted, []);
  h.click(PREPARE); await h.settle(); h.click(CHOOSE); await h.settle();
  staleApply(); await h.settle(); assert.equal(h.server.calls.filter(c => c.kind === 'reported-apply').length, 0);
  assert.notEqual(h.server.calls.at(-1).body.operation_id, old); assert.deepEqual(h.uncertainty, []);
});
test('lost replacement proposal retries same UUID, base revision and explicit intent without rereading editor', async t => {
  const server = fakeHttp(); let first = true; server.overrides.set('reported-proposal', (_c, respond) => {
    if (first) { first = false; throw new Error('synthetic response lost'); } return respond();
  });
  const h = harness(t, server); h.click(PREPARE); await h.settle(); h.click(CHOOSE); await h.settle();
  h.click('Retry report proposal'); await h.settle(); const posts = server.calls.filter(c => c.kind === 'reported-proposal');
  assert.deepEqual(posts[0].body, posts[1].body); assert.equal(server.calls.filter(c => c.kind === 'read').length, 1); assert.ok(h.button(APPLY));
});
test('reloading a proposal cannot silently switch its resolved predecessor', async t => {
  const server = fakeHttp(), h = await prepared(t, server);
  server.overrides.set('reported-proposal', async (_c, respond) => { const raw = await respond().json(); raw.replacement.predecessor.acceptance_id = uuid(30); return json(raw); });
  h.click('Reload this proposal'); await h.settle(); assert.match(h.text(), /could not be confirmed/);
  h.click(APPLY); await h.settle(); assert.deepEqual(server.calls.at(-1).body.replacement, REPLACEMENT);
});
test('double explicit prepare/Apply uses single lane and exact predecessor; uncertainty blocks cancel even via direct callback', async t => {
  const server = fakeHttp(); let first = true;
  server.overrides.set('reported-apply', (_c, respond) => { const result = respond(); if (first) { first = false; throw new Error('synthetic lost saved ACK'); } return result; });
  const h = harness(t, server); h.click(PREPARE); await h.settle(); const choose = h.button(CHOOSE).props.onClick; choose(); choose(); await h.settle();
  const cancel = h.button(CANCEL).props.onClick, apply = h.button(APPLY).props.onClick; apply(); apply(); await h.settle();
  assert.deepEqual(h.uncertainty, [true]); assert.equal(h.button(CANCEL).props.disabled, true); cancel(); choose(); await h.settle();
  assert.equal(server.calls.filter(c => c.kind === 'reported-proposal').length, 1); assert.equal(server.calls.filter(c => c.kind === 'reported-apply').length, 1);
  h.click('Retry same Apply request'); await h.settle(); const posts = server.calls.filter(c => c.kind === 'reported-apply');
  assert.deepEqual(posts[0].body, posts[1].body); assert.deepEqual(posts[0].body.replacement, REPLACEMENT);
  assert.deepEqual(h.uncertainty, [true, true, false]); assert.equal(h.accepted.length, 1);
});
test('mismatched replacement ACK remains uncertain; exact retry and known-ACK fresh-read failure never repeat Apply', async t => {
  const server = fakeHttp(); let first = true;
  server.overrides.set('reported-apply', async (_c, respond) => { const raw = await respond().json();
    if (first) { first = false; raw.replacement.predecessor.section_value_sha256 = 'd'.repeat(64); } return json(raw);
  });
  const h = await prepared(t, server, { onAccepted: async () => false }); h.click(APPLY); await h.settle();
  assert.deepEqual(h.uncertainty, [true]); assert.equal(h.accepted.length, 0);
  h.click('Retry same Apply request'); await h.settle(); assert.deepEqual(h.uncertainty, [true, true]);
  assert.equal(h.button('Retry same Apply request'), undefined); assert.ok(h.button('Reload accepted group')); assert.equal(h.button(CANCEL), undefined);
  h.render({ ...h.props, onAccepted: async () => true }); h.click('Reload accepted group'); await h.settle();
  assert.deepEqual(h.uncertainty, [true, true, false]); assert.equal(server.calls.filter(c => c.kind === 'reported-apply').length, 2);
});
test('stale or unsupported occupied section conflict does not clear the prior group or infer a replacement fallback', async t => {
  const server = fakeHttp(); server.overrides.set('reported-proposal', () => json({ error: 'report_replacement_conflict' }, 409));
  const h = harness(t, server); h.click(PREPARE); await h.settle(); h.click(CHOOSE); await h.settle();
  assert.equal(h.button(APPLY), undefined); assert.equal(server.calls.length, 2); assert.deepEqual(h.uncertainty, []); assert.deepEqual(h.accepted, []);
  assert.match(h.text(), /accepted report has not been replaced/);
});
test('disabled replacement actions reject retained callbacks without any HTTP or accepted-state change', async t => {
  const h = await prepared(t), apply = h.button(APPLY).props.onClick, cancel = h.button(CANCEL).props.onClick;
  h.render({ ...h.props, disabled: true }); apply(); cancel(); await h.settle(); assert.equal(h.server.calls.length, 2); assert.deepEqual(h.uncertainty, []);
  h.render({ ...h.props, disabled: false }); assert.ok(h.button(APPLY));
});
for (const [name, patch] of [['file', { target: { ...TARGET, assignmentFileId: '126' } }], ['session', { target: { ...TARGET, sessionKey: 'new-session' } }],
  ['context', { contextRef: { ...CONTEXT, context_id: uuid(9) } }], ['workspace', { workspaceRevision: 8 }]]) {
  test(`late replacement ACK after ${name} change cannot update new owner or release its barrier`, async t => {
    const server = fakeHttp(), held = deferred(); server.overrides.set('reported-apply', async (_c, respond) => { await held.promise; return respond(); });
    const h = await prepared(t, server); h.click(APPLY); await h.settle(); h.render({ ...h.props, ...patch }); held.resolve(); await h.settle();
    assert.ok(h.button(PREPARE)); assert.deepEqual(h.accepted, []); assert.deepEqual(h.uncertainty, [true]);
  });
}
test('replacement interrupted by StrictMode cleanup does not receive a stale proposal or recapture automatically', async t => {
  const server = fakeHttp(), held = deferred(); server.overrides.set('reported-proposal', async (_c, respond) => { await held.promise; return respond(); });
  const h = harness(t, server); h.click(PREPARE); await h.settle(); h.click(CHOOSE); await h.settle(); h.strictReplay(); held.resolve(); await h.settle();
  assert.equal(h.button(APPLY), undefined); assert.equal(server.calls.length, 2); assert.deepEqual(h.accepted, []); assert.deepEqual(h.uncertainty, []);
});
test('aborted replacement Apply keeps exact pending UUID; ignored late response cannot turn into acceptance', async t => {
  const server = fakeHttp(), held = deferred(); server.overrides.set('reported-apply', async (_c, respond) => { await held.promise; return respond(); });
  const h = await prepared(t, server); h.click(APPLY); await h.settle(); h.controls.at(-1).abort(); await h.settle(); held.resolve(); await h.settle();
  assert.deepEqual(h.uncertainty, [true]); assert.deepEqual(h.accepted, []);
  server.overrides.delete('reported-apply'); h.click('Retry same Apply request'); await h.settle();
  const posts = server.calls.filter(c => c.kind === 'reported-apply'); assert.deepEqual(posts[0].body, posts[1].body); assert.deepEqual(h.uncertainty, [true, true, false]);
});
