import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { uadNeighborhoodReviewFixture, acceptedUadNeighborhoodReviewFixture,
  prepareSyntheticAcceptance } from './fixtures/uadNeighborhoodReviewFixture.mjs';

// LOCAL/PURE evidence only. Real retained-fixture builders, reducer, formatter
// and shared guard are used. No controller, browser, database or source authority
// is established; committed-shaped fixture responses below are explicitly synthetic.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const ts = createRequire(join(frontend, 'package.json'))('typescript');
const files = {
  adapter: 'src/features/uad/neighborhoodPreviewAdapter.ts',
  owner: 'src/features/uad/neighborhoodReviewModel.ts',
  shared: 'src/features/neighborhood/neighborhoodPreviewModel.ts',
  formatter: 'src/features/neighborhood/neighborhoodAssessmentDisplay.ts',
};
const allowed = new Set(Object.values(files)), modules = new Map();
function compiled(path) {
  assert.ok(allowed.has(path), `Unapproved production dependency: ${path}`);
  if (modules.has(path)) return modules.get(path).exports;
  const emitted = ts.transpileModule(readFileSync(join(frontend, path), 'utf8'), { fileName: path,
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((emitted.diagnostics ?? []).filter(row => row.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} }; modules.set(path, module);
  const require = name => {
    assert.ok(name.startsWith('.'), `No provider/Node/network import allowed: ${name}`);
    return compiled(posix.normalize(posix.join(posix.dirname(path), name.replace(/\.ts$/, '') + '.ts')));
  };
  new Script(`(function(require,module,exports){\n${emitted.outputText}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}
// One instance per module is essential for the real shared guard's WeakMap.
const model = compiled(files.owner), shared = compiled(files.shared), formatter = compiled(files.formatter);
const { buildUadNeighborhoodPreviewEnvelope: buildAdapter, resolveUadNeighborhoodPreviewIntent: resolveAdapter } = compiled(files.adapter);
const { createNeighborhoodReviewState: create, updateNeighborhoodReviewContext: update,
  startNeighborhoodReviewLoad: start, receiveNeighborhoodReviewLoad: receive, failNeighborhoodReviewLoad: failLoad,
  selectNeighborhoodReviewGroup: select, confirmNeighborhoodReviewGroup: confirm,
  beginNeighborhoodReviewApply: begin, finishNeighborhoodReviewApply: finish, buildNeighborhoodReviewView: ownerView } = model;
const { prepareNeighborhoodPreview: prepare, createNeighborhoodPreviewIntent: emit } = shared;
const json = JSON.stringify, clone = structuredClone;
const ACTION = { refresh: 'refresh_review', 'review-group': 'open_group_review', 'inspect-evidence': 'inspect_evidence',
  'inspect-pocket': 'inspect_pocket', 'edit-area': 'request_area_edit' };
const COMPANIONS = ['lowest-sale-price', 'median-sale-price', 'highest-sale-price'].map(id => `uad-owner:companion:${id}`);
const F = () => uadNeighborhoodReviewFixture();
function freezeStates(value, states = []) {
  if (value && typeof value === 'object') { states.push([value, Object.isFrozen(value)]); Object.values(value).forEach(v => freezeStates(v, states)); }
  return states;
}
function unchanged(state, owner, fn) {
  const before = clone({ state, owner }), flags = freezeStates({ state, owner });
  try { return fn(); } finally {
    assert.deepEqual({ state, owner }, before, 'adapter must not mutate owner/reducer inputs');
    flags.forEach(([value, frozen]) => assert.equal(Object.isFrozen(value), frozen, 'adapter must not freeze caller objects'));
  }
}
function build(c, ...supplied) { return unchanged(c.state, c.owner, () => buildAdapter(c.state, c.owner, supplied.length ? supplied[0] : c.projectionJson)); }
function resolve(c, intent, ...supplied) { return unchanged(c.state, c.owner, () => resolveAdapter(c.state, c.owner, supplied.length ? supplied[0] : c.projectionJson, intent)); }
function binding(context) { return { workfile_id: context.workfileId, report_file_id: context.reportFileId,
  specification_release: context.specificationRelease, editor_revision: context.revision, session_key: context.sessionKey }; }
function geography(candidate, { outline = false, analysis = false } = {}) {
  const absent = () => ({ status: 'not_available', description: null, evidence_key: null });
  const evidence = key => ({ key, kind: key, id: null, label: `Synthetic ${key}`, observation_text: null,
    support: 'unknown', detail: 'Synthetic authorized-host descriptor; no real geometry/source authority claimed.' });
  const cardinal = candidate.evidence.geographic_neighborhood.cardinal_summaries;
  return {
    boundary: { neighborhood: { status: 'available', description: 'Synthetic neighborhood descriptor', evidence_key: 'geographic_neighborhood' },
      analysis_area: analysis ? { status: 'available', description: candidate.evidence.market_context.analysis_geometry.boundary_description,
        evidence_key: 'analysis_geography' } : absent(),
      cardinals: Object.fromEntries(['north', 'east', 'south', 'west'].map(side => [side, cardinal?.[side] == null
        ? { status: 'not_available', text: null, evidence_keys: [] }
        : { status: 'needs_review', text: cardinal[side], evidence_keys: ['geographic_neighborhood'] }])),
      outline_required_for_review: outline, outline: null }, pockets: [],
    evidence: [evidence('geographic_neighborhood'), ...(analysis ? [evidence('analysis_geography')] : [])], review_items: [],
  };
}
function pin(c, { epoch = 'projection_one', outline = c.owner.outline_required_for_review,
  analysis = c.owner.allow_analysis_geography, mutate } = {}) {
  const candidate = c.state.preview?.candidate ?? c.fixture.preview.candidate;
  const projection = { projection_version: 1, projection_epoch: epoch,
    candidate_digest_sha256: candidate.candidate_digest_sha256, binding_digest_sha256: candidate.attachment.binding_digest_sha256,
    descriptors: geography(candidate, { outline, analysis }) };
  mutate?.(projection);
  c.projectionJson = json(projection);
  c.owner.projection = { epoch, load_generation: c.state.generation, load_sequence: c.state.sequence, retained_json: c.projectionJson };
  return c;
}
function setup({ fixture = F(), context = {}, host = {}, mutatePreview } = {}) {
  const preview = clone(fixture.preview); mutatePreview?.(preview);
  const loaded = start(create({ ...fixture.context, ...context }));
  const state = receive(loaded.state, loaded.token, preview);
  assert.ok(state.preview, state.error);
  const owner = { owner_version: 1, mount_epoch: 'mount_one', target_epoch: 'target_one', binding: binding(state.context),
    access: 'review', read_only: false, spatial_review: 'clear', outline_required_for_review: false,
    allow_analysis_geography: false, allowed_intents: { refresh: true, open_review: true, edit_area: true },
    subject_label: 'Synthetic private subject', projection: null, ...host };
  return pin({ fixture, state, owner, projectionJson: null, loadToken: loaded.token });
}
function shown(c) {
  const result = build(c); assert.equal(result.status, 'ready', json(result));
  assert.deepEqual(Object.keys(result).sort(), ['envelopeJson', 'status']);
  const view = prepare(result.envelopeJson); assert.equal(view.phase, 'shown', json(view));
  return { result, envelope: JSON.parse(result.envelopeJson), view, document: view.document };
}
function denied(c, ...supplied) {
  const result = build(c, ...supplied); assert.equal(result.status, 'unavailable', json(result));
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']);
  assert.ok(['owner_context_changed', 'invalid_projection', 'unsupported_projection', 'stale_projection', 'projection_limit', 'display_capacity'].includes(result.reason));
  assert.ok(json(result).length < 200); return result;
}
function intent(c, type, key) { const { view } = shown(c); return emit(view, type, key); }
function action(c, type, key) {
  const request = intent(c, type, key); assert.ok(request, `Expected current ${type} intent`);
  const response = resolve(c, json(request)); assert.deepEqual(response, { ...request, type: ACTION[type] }); return request;
}
function noAction(c, type, key) {
  const result = build(c); const view = result.status === 'ready' ? prepare(result.envelopeJson) : null;
  const request = view && emit(view, type, key); assert.equal(request, null, `${type} must be blocked`);
}
function selected(c) { c.state = confirm(select(c.state, true), true); assert.equal(c.state.confirmed, true); return c; }
function pending(c) { selected(c); const op = begin(c.state); assert.ok(op); c.state = op.state; return op; }
function transition(c, changes, epoch = 'target_changed') {
  c.state = update(c.state, { ...c.state.context, ...changes }); c.owner.binding = binding(c.state.context); c.owner.target_epoch = epoch; return c;
}
function reload(c, epoch = 'projection_two', preview = c.fixture.preview) {
  const load = start(c.state); c.state = receive(load.state, load.token, preview); assert.ok(c.state.preview, c.state.error);
  return pin(c, { epoch });
}

test('R01: review can open before selection, but Apply remains owner-confirmed', () => {
  const c = setup(), { document } = shown(c); assert.equal(document.fields.length, 7);
  assert.equal(ownerView(c.state).canApply, false); assert.equal(begin(c.state), null);
  action(c, 'review-group'); assert.equal(c.state.selected, false); assert.equal(c.state.confirmed, false); assert.equal(c.state.acceptance, null);
});
test('R02: only explicit owner selection/confirmation creates the seven-member command', () => {
  const c = setup(); action(c, 'review-group'); const op = pending(c);
  assert.deepEqual(op.command.body.selected_suggestion_ids, c.fixture.preview.candidate.suggestions.map(s => s.id));
  assert.equal(op.command.body.selected_suggestion_ids.length, 7); assert.ok(c.state.pendingApply);
});
test('R03: zero sales has four real members and three display-only empty companions', () => {
  const c = setup({ fixture: uadNeighborhoodReviewFixture({ zeroSales: true }) }), { document } = shown(c);
  assert.equal(document.fields.length, 7);
  assert.deepEqual(document.fields.filter(f => f.disposition === 'empty_companion').map(f => f.id).sort(), COMPANIONS.toSorted());
  document.fields.forEach(f => assert.deepEqual(f.current, { status: 'not_supplied', text: null }));
  document.fields.filter(f => COMPANIONS.includes(f.id)).forEach(f => assert.deepEqual(f.proposed, { status: 'not_proposed', text: null }));
  const op = pending(c); assert.equal(op.command.body.selected_suggestion_ids.length, 4);
  assert.ok(op.command.body.selected_suggestion_ids.every(id => !id.startsWith('uad-owner:')));
});
test('R04/A06: equal manual data remains a conflict; corrective edit remains an inert request', () => {
  const c = setup({ fixture: uadNeighborhoodReviewFixture({ conflictKeys: ['market:3000.0008'] }) });
  const fields = shown(c).document.fields, expected = ownerView(c.state).fields;
  assert.equal(fields.filter(f => f.disposition === 'conflict').length, 1);
  assert.deepEqual(fields.map(f => f.proposed.text), expected.map(f => f.displayValue));
  noAction(c, 'review-group'); action(c, 'edit-area'); assert.equal(c.state.confirmed, false);
});
test('R05: accepted mixed reuse retains the full group without inferred before-values', () => {
  const c = setup({ fixture: uadNeighborhoodReviewFixture({ reuseKeys: ['market:3000.0008', 'market:3000.0010'] }) });
  const fields = shown(c).document.fields; assert.equal(fields.length, 7); assert.equal(fields.filter(f => f.disposition === 'reused').length, 2);
  fields.forEach(f => assert.deepEqual(f.current, { status: 'not_supplied', text: null }));
});
test('R06/R08: equal-digest refresh rotates operation and projection and clears confirmation', () => {
  const c = selected(setup()); const old = ['review-group', 'refresh', 'inspect-evidence'].map(t => action(c, t, t === 'inspect-evidence' ? 'geographic_neighborhood' : undefined));
  const first = shown(c).document.preview_key; const load = start(c.state); c.state = load.state;
  assert.equal(c.state.preview, null); assert.equal(c.state.confirmed, false);
  old.forEach(i => assert.equal(resolve(c, json(i)), null));
  c.state = receive(c.state, load.token, c.fixture.preview); pin(c, { epoch: 'projection_new' });
  assert.notEqual(shown(c).document.preview_key, first); old.forEach(i => assert.equal(resolve(c, json(i)), null));
  action(c, 'review-group'); assert.equal(c.state.selected, false);
});
test('R07: matching digests cannot replace exact retained projection text', () => {
  const c = selected(setup()), old = action(c, 'review-group'), changed = JSON.parse(c.projectionJson);
  changed.descriptors.boundary.neighborhood.description += ' changed'; denied(c, json(changed));
  assert.equal(resolve(c, json(old), json(changed)), null); assert.equal(c.state.confirmed, true);
});
test('R09: trusted-host replacement cannot be authenticated by this stateless adapter', t => {
  const c = setup(), before = shown(c).document.preview_key;
  pin(c, { epoch: 'illicit_same_load_replacement', mutate: p => p.descriptors.boundary.neighborhood.description = 'Changed trusted-host descriptor' });
  assert.notEqual(shown(c).document.preview_key, before);
  t.diagnostic('Host-contract violation control only: a later controller must require a fresh accepted load; no controller enforcement is tested here.');
});
test('R10: A-to-B-to-A rotates actual reducer generation and owner target epoch', () => {
  const c = selected(setup()), old = action(c, 'review-group'), original = clone(c.state.context);
  transition(c, { workfileId: '22222222-2222-4222-8222-222222222222' }, 'target_B');
  assert.equal(resolve(c, json(old)), null); transition(c, original, 'target_A_again'); reload(c);
  assert.equal(resolve(c, json(old)), null); action(c, 'review-group'); assert.equal(c.state.confirmed, false);
});
test('R11: new mount invalidates old callbacks despite reset counters and identical evidence', () => {
  const first = setup(), old = action(first, 'review-group'), c = setup({ host: { mount_epoch: 'mount_two' } });
  assert.equal(c.state.generation, first.state.generation); assert.equal(resolve(c, json(old)), null); action(c, 'review-group');
});
test('R12: access loss removes private data; regrant requires explicit owner reset and fresh load', () => {
  const c = selected(setup()), old = action(c, 'review-group'); c.owner.access = 'none'; transition(c, { canApply: false }, 'revoked');
  const result = build(c); assert.equal(result.status, 'ready'); const raw = result.envelopeJson;
  assert.equal(prepare(raw).phase, 'unavailable'); assert.equal(JSON.parse(raw).preview, null);
  for (const secret of [c.owner.subject_label, c.fixture.context.sessionKey, c.fixture.preview.candidate.candidate_digest_sha256]) assert.equal(raw.includes(secret), false);
  assert.equal(resolve(c, json(old)), null); c.owner.access = 'review'; transition(c, { canApply: true }, 'regranted'); reload(c);
  assert.equal(resolve(c, json(old)), null); action(c, 'review-group'); assert.equal(c.state.confirmed, false);
});
for (const key of ['workfile_id', 'report_file_id', 'specification_release', 'editor_revision', 'session_key']) test(`R13: mismatched owner ${key} fails closed`, () => {
  const c = setup(); c.owner.binding[key] = key === 'editor_revision' ? c.owner.binding[key] + 1 : 'changed';
  assert.equal(denied(c).reason, 'owner_context_changed');
});
for (const key of ['load_generation', 'load_sequence']) test(`R14: mismatched ${key} cannot restore current projection`, () => {
  const c = setup(), old = action(c, 'review-group'); c.owner.projection[key]++;
  denied(c); assert.equal(resolve(c, json(old)), null);
});
test('R15: obsolete load success/failure does not replace the latest accepted state', () => {
  const c = setup(), older = start(c.state), newer = start(older.state);
  c.state = receive(newer.state, newer.token, c.fixture.preview); const accepted = c.state;
  assert.equal(receive(c.state, older.token, c.fixture.preview), accepted); assert.equal(failLoad(c.state, older.token), accepted);
  pin(c, { epoch: 'latest_load' }); action(c, 'review-group');
});
for (const [flag, type] of [['refresh', 'refresh'], ['open_review', 'review-group'], ['edit_area', 'edit-area']]) test(`R16: ${flag} true/false/true cannot revive old intent`, () => {
  const c = setup(), old = action(c, type); c.owner.allowed_intents[flag] = false; c.owner.target_epoch = 'permission_off';
  noAction(c, type); assert.equal(resolve(c, json(old)), null);
  c.owner.allowed_intents[flag] = true; c.owner.target_epoch = 'permission_on_new'; assert.equal(resolve(c, json(old)), null); action(c, type);
});
test('R17: read-only round trip rotates epoch; no implicit reducer confirmation reset', () => {
  const c = selected(setup()), old = action(c, 'review-group'); c.owner.read_only = true; c.owner.target_epoch = 'readonly';
  noAction(c, 'review-group'); noAction(c, 'edit-area'); assert.equal(c.state.confirmed, true);
  c.owner.read_only = false; c.owner.target_epoch = 'writable_again'; assert.equal(resolve(c, json(old)), null); action(c, 'review-group');
});
test('R18: spatial round trip retains corrective edit, but old tuples never revive', () => {
  const c = setup(), old = ['review-group', 'edit-area', 'inspect-evidence'].map(t => action(c, t, t === 'inspect-evidence' ? 'geographic_neighborhood' : undefined));
  c.owner.spatial_review = 'required'; c.owner.target_epoch = 'spatial_required'; noAction(c, 'review-group'); action(c, 'edit-area');
  c.owner.spatial_review = 'clear'; c.owner.target_epoch = 'spatial_cleared_new'; old.forEach(i => assert.equal(resolve(c, json(i)), null));
});
test('R19: host outline policy cannot be disabled by a descriptor', () => {
  const c = setup(), old = action(c, 'review-group'); c.owner.outline_required_for_review = true; c.owner.target_epoch = 'outline_required';
  denied(c); reload(c, 'outline_descriptor'); noAction(c, 'review-group'); action(c, 'edit-area');
  c.owner.outline_required_for_review = false; c.owner.target_epoch = 'outline_optional_new'; reload(c, 'outline_optional');
  assert.equal(resolve(c, json(old)), null); action(c, 'review-group');
});
test('R20: analysis descriptor requires explicit policy and exact candidate description on every transition', () => {
  const c = setup(), old = action(c, 'review-group'); pin(c, { analysis: true }); denied(c);
  c.owner.allow_analysis_geography = true; c.owner.target_epoch = 'analysis_allowed'; reload(c, 'analysis_one');
  const current = action(c, 'inspect-evidence', 'analysis_geography'); assert.equal(resolve(c, json(old)), null);
  c.owner.allow_analysis_geography = false; c.owner.target_epoch = 'analysis_revoked'; denied(c);
  c.owner.allow_analysis_geography = true; c.owner.target_epoch = 'analysis_reallowed'; reload(c, 'analysis_two');
  assert.equal(resolve(c, json(current)), null); action(c, 'inspect-evidence', 'analysis_geography');
});

test('A01: explicit inspection survives read-only/canApply denial without edit/review authority', () => {
  const c = setup({ context: { canApply: false }, host: { access: 'inspect', read_only: true } });
  action(c, 'inspect-evidence', 'geographic_neighborhood'); noAction(c, 'review-group'); noAction(c, 'edit-area');
});
test('A02: access none discards hostile projection without reflection or private data', () => {
  const c = setup({ host: { access: 'none' } }); let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error('private getter'); }, ownKeys() { traps++; throw Error('private keys'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const hostile of [proxy, revoked.proxy, 'x'.repeat(1_000_001)]) {
    const result = build(c, hostile); assert.equal(result.status, 'ready');
    const envelope = JSON.parse(result.envelopeJson); assert.equal(envelope.preview, null);
    assert.equal(prepare(result.envelopeJson).phase, 'unavailable');
    assert.equal(result.envelopeJson.includes(c.owner.subject_label), false); assert.equal(resolve(c, '{}', hostile), null);
  }
  assert.equal(traps, 0);
});
const uneditable = [
  ['canApply false', { canApply: false }], ['completed signature', { signedAt: '2024-07-01T00:00:00.000Z' }],
  ['partial signature', { hasSignatures: true }], ...['signed', 'archived', 'unknown', '', null].map(status => [`status ${status}`, { status }]),
];
for (const [name, context] of uneditable) test(`A03/A05: ${name} blocks review and corrective editing independently`, () => {
  const c = setup({ context, host: { spatial_review: 'required' } });
  shown(c); action(c, 'inspect-evidence', 'geographic_neighborhood'); noAction(c, 'review-group'); noAction(c, 'edit-area');
});
for (const status of ['draft', 'validating', 'ready', 'revised']) test(`A03: clean unsigned ${status} satisfies existing editable predicate`, () => {
  const c = setup({ context: { status } }); action(c, 'review-group'); action(c, 'edit-area');
});
test('A04: actual dirty transition clears evidence and blocks every new operation', () => {
  const c = selected(setup()), old = ['refresh', 'review-group', 'edit-area'].map(type => action(c, type));
  transition(c, { dirty: true }, 'dirty'); assert.equal(c.state.preview, null); assert.equal(c.state.confirmed, false);
  old.forEach(i => assert.equal(resolve(c, json(i)), null));
  for (const type of ['refresh', 'review-group', 'edit-area']) noAction(c, type);
});
test('A05: missing required outline and spatial review allow only separately authorized correction', () => {
  const c = setup({ host: { spatial_review: 'required', outline_required_for_review: true } });
  const view = shown(c).view; assert.equal(view.outline_unavailable, true); assert.equal(view.spatial_blocked, true);
  noAction(c, 'review-group'); action(c, 'edit-area'); assert.equal(c.state.confirmed, false);
});
test('A07: duplicate refresh is prevented by owner transition, not pure resolver hidden state', t => {
  const c = setup(), request = action(c, 'refresh');
  assert.deepEqual(resolve(c, json(request)), resolve(c, json(request)), 'unchanged pure calls may both return an intent');
  c.state = start(c.state).state; assert.equal(resolve(c, json(request)), null); noAction(c, 'refresh');
  t.diagnostic('No transport/controller call count claimed: synchronous start-load publication must happen in the later host.');
});
test('A08: begin Apply advances sequence; pinned projection cannot hide or cancel pending work', () => {
  const c = setup(), old = ['refresh', 'review-group', 'edit-area'].map(type => action(c, type));
  pending(c); const current = c.state.pendingApply; denied(c);
  old.forEach(i => assert.equal(resolve(c, json(i)), null)); assert.equal(c.state.pendingApply, current);
  for (const type of ['refresh', 'review-group', 'edit-area']) noAction(c, type);
});
test('A09: stale-generation apply settles without mutation and preserves a newer accepted preview', () => {
  const c = setup(), op = pending(c), result = prepareSyntheticAcceptance(c.fixture, op.command).result;
  transition(c, { dirty: true }, 'dirty_during_apply'); assert.ok(c.state.pendingApply); assert.equal(c.state.preview, null);
  transition(c, { dirty: false }, 'clean_after_edit'); reload(c, 'newer_loaded_projection');
  const newer = c.state.preview, retained = c.state.pendingApply;
  noAction(c, 'review-group'); assert.equal(c.state.pendingApply, retained);
  const settled = finish(c.state, op.token, result); assert.equal(settled.mutation, null);
  assert.equal(settled.state.preview, newer); assert.equal(settled.state.pendingApply, null);
  assert.equal(settled.state.needsRefresh, true); assert.equal(settled.state.notice, null);
});
for (const [name, change] of [['workfile', { workfileId: '22222222-2222-4222-8222-222222222222' }], ['session', { sessionKey: 'new-session' }]])
  test(`A10: ${name} switch invalidates pending correlation; unknown server outcome is not a rollback`, () => {
    const c = setup(), op = pending(c), result = prepareSyntheticAcceptance(c.fixture, op.command).result;
    transition(c, change, 'other_target'); assert.equal(c.state.pendingApply, null);
    const now = c.state, settled = finish(c.state, op.token, result); assert.equal(settled.state, now); assert.equal(settled.mutation, null);
    assert.equal(c.state.preview, null); noAction(c, 'review-group');
  });
test('A11: only existing finish handles synthetic applied response once; no database COMMIT is proved', () => {
  const c = setup(), op = pending(c), synthetic = prepareSyntheticAcceptance(c.fixture, op.command);
  denied(c); assert.equal(c.state.acceptance, null);
  const settled = finish(c.state, op.token, synthetic.result);
  assert.deepEqual(settled.mutation, { workfileId: c.fixture.context.workfileId, revision: c.fixture.context.revision + 1 });
  assert.equal(settled.state.acceptance.alreadyApplied, false); assert.equal(settled.state.acceptance.acceptedRevision, c.fixture.context.revision + 1);
  assert.match(settled.state.notice, /saved/); c.state = settled.state; noAction(c, 'review-group');
  assert.equal(finish(c.state, op.token, synthetic.result).mutation, null);
});
test('A12: synthetic accepted replay retains original accepted revision and full group, with no mutation', () => {
  const fixture = acceptedUadNeighborhoodReviewFixture(), original = clone(fixture.backend.accepted_receipt), c = setup({ fixture });
  assert.equal(shown(c).document.fields.filter(f => f.disposition === 'reused').length, 7);
  const op = pending(c), settled = finish(c.state, op.token, fixture.result);
  assert.equal(fixture.result.applied_count, 0); assert.equal(fixture.result.reused_count, fixture.preview.candidate.suggestions.length);
  assert.equal(settled.mutation, null); assert.equal(settled.state.acceptance.alreadyApplied, true);
  assert.equal(settled.state.acceptance.acceptedRevision, original.core_receipt.accepted_editor_revision);
  assert.equal(settled.state.needsRefresh, true); assert.deepEqual(fixture.backend.accepted_receipt, original);
});
const badResults = [
  ['null', () => null], ['preparation plan', (_result, c) => c.fixture.plan], ['ready', result => ({ ...result, status: 'ready' })],
  ['wrong workfile', result => ({ ...result, workfile_id: '22222222-2222-4222-8222-222222222222' })],
  ['wrong digest', result => ({ ...result, candidate_digest_sha256: 'f'.repeat(64) })],
  ['wrong group', result => ({ ...result, application_group_id: 'foreign-group' })],
  ['wrong revision', result => ({ ...result, accepted_revision: result.accepted_revision + 1 })],
  ['wrong current revision', result => ({ ...result, current_revision: result.current_revision + 1 })],
  ['wrong applied count', result => ({ ...result, applied_count: result.applied_count + 1 })],
  ['wrong reused count', result => ({ ...result, reused_count: result.reused_count + 1 })],
];
for (const [name, corrupt] of badResults) test(`A13: ${name} is not a committed-shaped result`, () => {
  const c = setup(), op = pending(c), synthetic = prepareSyntheticAcceptance(c.fixture, op.command).result;
  const settled = finish(c.state, op.token, corrupt(synthetic, c));
  assert.equal(settled.mutation, null); assert.equal(settled.state.notice, null); assert.equal(settled.state.acceptance, null);
  assert.equal(settled.state.needsRefresh, true); assert.ok(settled.state.error);
});

function retainedRaw(c, raw) { c.projectionJson = raw; c.owner.projection.retained_json = raw; return c; }
function review(id, detail = 'Synthetic geography must be reviewed.') {
  return { id, label: 'Synthetic geographic issue', detail, blocks_review: true, evidence_keys: ['geographic_neighborhood'] };
}
// An independent contract-shaped INPUT oracle calls the real formatter; it does
// not duplicate formatting rules or substitute mocked output into the adapter.
function commonInput(c) {
  const candidate = c.state.preview.candidate, a = candidate.attachment, e = candidate.evidence;
  const keys = new Set(candidate.suggestions.flatMap(item => item.evidence_refs));
  e.populations.forEach(item => keys.add(`population:${item.id}`));
  e.statistics.forEach(item => keys.add(`statistic:${item.id}`));
  e.sources.forEach(item => keys.add(`source:${item.id}`));
  JSON.parse(c.projectionJson).descriptors.evidence.forEach(item => keys.add(item.key));
  return { display_input_version: 1, source_contract_version: 1, records_kind: 'candidate_subset',
    assessment_reference: { id: a.assessment_id, revision: a.assessment_revision, evidence_digest_sha256: a.evidence_digest_sha256 },
    scope: a.scope, effective_date: a.effective_date, data_cutoff: a.data_cutoff,
    observation_period: e.market_context.observation_period, populations: e.populations, statistics: e.statistics,
    source_snapshots: e.sources, required_evidence_keys: [...keys].sort() };
}
for (const zeroSales of [false, true]) test(`D01: actual ${zeroSales ? 'zero' : 'positive'} fixture uses real common formatter, complete evidence and exact mandatory notice`, () => {
  const c = setup({ fixture: uadNeighborhoodReviewFixture({ zeroSales }) });
  const input = commonInput(c), before = clone(input), formatted = formatter.formatNeighborhoodAssessmentDisplay(json(input));
  assert.equal(formatted.status, 'formatted'); assert.deepEqual(input, before);
  const { document } = shown(c), source = c.state.preview.candidate;
  assert.deepEqual(document.populations, formatted.display.populations);
  assert.deepEqual(document.evidence.filter(row => !['geographic_neighborhood', 'analysis_geography'].includes(row.key)), formatted.display.evidence);
  assert.deepEqual(document.evidence.map(row => row.key).sort(), input.required_evidence_keys);
  assert.deepEqual(formatted.provenance.assessment_reference, input.assessment_reference);
  assert.deepEqual(formatted.provenance.scope, source.attachment.scope);
  assert.equal(formatted.provenance.records_kind, 'candidate_subset');
  assert.equal(formatted.provenance.source_authority, 'not_established'); assert.equal(formatted.provenance.report_eligibility, 'not_assessed');
  assert.notEqual(source.attachment.evidence_digest_sha256, source.attachment.source_digest_sha256);
  const notice = document.review_items.filter(row => row.id === 'assessment-display:v1:context'); assert.equal(notice.length, 1);
  assert.deepEqual(notice[0], { id: 'assessment-display:v1:context', label: 'About this evidence',
    detail: 'Supplied candidate evidence subset; other assessment records are not shown. Observation date basis: closing date. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.',
    blocks_review: false, evidence_keys: [] });
  assert.equal(notice[0].detail, formatted.display_notice.text);
  document.evidence.forEach(row => assert.equal(row.support, 'unknown'));
  assert.equal(document.effective_date, '2024-06-30'); assert.equal(document.data_cutoff, '2024-06-30');
  assert.deepEqual(document.observation_period, { start_date: '2023-07-01', end_date: '2024-06-30' });
  assert.equal(source.evidence.sources[0].observed_at.startsWith('2026-'), true, 'later source retrieval must not replace historical cutoff');
  assert.equal(document.fields.find(row => row.id === source.suggestions.find(item => item.target_key === 'market_total_sales:3000.0026').id).proposed.text, zeroSales ? '0' : '3');
  if (!zeroSales) {
    const median = document.populations.flatMap(p => p.metrics).find(m => m.id === 'median-sale-price');
    assert.equal(median.estimator_label, 'Median'); assert.equal(median.unit, 'USD'); assert.equal(median.display_value, '330000');
    assert.equal(median.label.includes('Predominant'), false);
  }
});
test('D02: unknown support and needs-review cardinal labels alone do not grant or deny review', () => {
  const c = setup(), { document } = shown(c);
  Object.values(document.boundary.cardinals).forEach(row => assert.equal(row.status, 'needs_review'));
  action(c, 'review-group'); assert.equal(c.state.confirmed, false);
});
// Deliberately corrupted display-state controls below are NOT newly signed or
// backend-valid candidates. They test the pure adapter's strict extraction gate.
const extractionErrors = [
  ['missing assessment ID', c => delete c.attachment.assessment_id], ['missing assessment revision', c => delete c.attachment.assessment_revision],
  ['missing scope', c => delete c.attachment.scope], ['missing effective date', c => delete c.attachment.effective_date],
  ['missing cutoff', c => delete c.attachment.data_cutoff], ['source digest substitution', c => c.attachment.evidence_digest_sha256 = c.attachment.source_digest_sha256],
  ['different evidence digest', c => c.evidence.assessment_digest_sha256 = '0'.repeat(64)],
  ['different context digest', c => c.evidence.market_context.assessment_digest_sha256 = '0'.repeat(64)],
  ['bad calendar date', c => c.attachment.effective_date = '2024-02-30'],
  ['cutoff after effective', c => c.attachment.data_cutoff = '2024-07-01'],
  ['period after cutoff', c => c.evidence.market_context.observation_period.end_date = '2024-07-01'],
  ['missing population', c => c.evidence.populations.shift()], ['duplicate population', c => c.evidence.populations.push(clone(c.evidence.populations[0]))],
  ['missing statistic', c => c.evidence.statistics.shift()], ['duplicate statistic', c => c.evidence.statistics.push(clone(c.evidence.statistics[0]))],
  ['missing source', c => c.evidence.sources = []], ['duplicate source', c => c.evidence.sources.push(clone(c.evidence.sources[0]))],
  ['unsupported population', c => c.evidence.populations[0].kind = 'listings'],
  ['foreign statistic population', c => c.evidence.statistics[0].population_id = 'foreign'],
  ['foreign source reference', c => c.evidence.statistics[0].source_refs = ['foreign']],
  ['unsupported reference namespace', c => c.suggestions[0].evidence_refs.push('receipt:private')],
  ['duplicate member reference', c => c.suggestions[0].evidence_refs.push(c.suggestions[0].evidence_refs[0])],
  ['foreign evidence reference', c => c.suggestions[0].evidence_refs.push('source:foreign')],
];
for (const [name, change] of extractionErrors) test(`D03: ${name} cannot be hidden by a syntactically valid final display`, () => {
  const c = setup(); change(c.state.preview.candidate); pin(c); denied(c);
});
test('D04: same bare ID in population/statistic/source namespaces remains distinct', () => {
  const c = setup(), candidate = c.state.preview.candidate, e = candidate.evidence;
  const population = e.populations[0].id, statistic = e.statistics[0].id, source = e.sources[0].id, id = 'shared-id';
  const rename = key => key === `population:${population}` ? `population:${id}` : key === `statistic:${statistic}` ? `statistic:${id}` : key === `source:${source}` ? `source:${id}` : key;
  e.populations[0].id = id; e.statistics[0].id = id; e.sources[0].id = id;
  for (const row of [...e.populations, ...e.statistics]) {
    row.source_refs = row.source_refs.map(value => value === source ? id : value);
    if (row.population_id === population) row.population_id = id;
  }
  for (const suggestion of candidate.suggestions) suggestion.evidence_refs = suggestion.evidence_refs.map(rename);
  pin(c); const document = shown(c).document;
  for (const kind of ['population', 'statistic', 'source']) assert.equal(document.evidence.filter(row => row.key === `${kind}:${id}`).length, 1);
  assert.equal(formatter.formatNeighborhoodAssessmentDisplay(json(commonInput(c))).status, 'formatted');
});
const descriptorErrors = [
  ['external fields', p => p.fields = []], ['external current', p => p.current = {}], ['external receipt', p => p.receipt = {}],
  ['external populations', p => p.descriptors.populations = []], ['external numeric statistics', p => p.descriptors.statistics = [{ value: 10 }]],
  ['external sources', p => p.descriptors.sources = []], ['external dates', p => p.descriptors.effective_date = '2024-06-30'],
  ['external permissions', p => p.descriptors.actions = { open_review: true }],
  ['external pocket', p => p.descriptors.pockets = [{ id: 'unauthorized' }]], ['external outline', p => p.descriptors.boundary.outline = {}],
  ['supported geography', p => p.descriptors.evidence[0].support = 'supported'],
  ['observed geography', p => p.descriptors.evidence[0].observation_text = 'Observed today'],
  ['non-singleton geography ID', p => p.descriptors.evidence[0].id = 'x'],
  ['source masquerading as geography', p => p.descriptors.evidence[0].kind = 'source'],
  ['duplicate geography', p => p.descriptors.evidence.push(clone(p.descriptors.evidence[0]))],
  ['third geography record', p => p.descriptors.evidence.push(clone(p.descriptors.evidence[0]), clone(p.descriptors.evidence[0]))],
  ['unsupported cardinal authority', p => p.descriptors.boundary.cardinals.north.status = 'supported'],
  ['altered cardinal', p => p.descriptors.boundary.cardinals.north.text = 'Different Road'],
  ['duplicate cardinal reference', p => p.descriptors.boundary.cardinals.north.evidence_keys.push('geographic_neighborhood')],
  ['wrong area role', p => p.descriptors.boundary.neighborhood.evidence_key = 'analysis_geography'],
  ['nonblocking geographic issue', p => p.descriptors.review_items = [{ ...review('geo:issue'), blocks_review: false }]],
  ['common-reference geographic issue', p => p.descriptors.review_items = [{ ...review('geo:issue'), evidence_keys: ['source:fixture-source'] }]],
  ['identical notice collision', p => p.descriptors.review_items = [{ id: 'assessment-display:v1:context', label: 'About this evidence',
    detail: 'Supplied candidate evidence subset; other assessment records are not shown. Observation date basis: closing date. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.', blocks_review: false, evidence_keys: [] }]],
  ['reserved formatter prefix', p => p.descriptors.review_items = [review('assessment-display:other')]],
  ['reserved owner prefix', p => p.descriptors.review_items = [review('uad-owner:blocker:0')]],
  ['duplicate review ID', p => p.descriptors.review_items = [review('geo:same'), review('geo:same')]],
];
for (const [name, mutate] of descriptorErrors) test(`D05: ${name} rejects instead of importing caller authority`, () => {
  const c = setup(); pin(c, { mutate }); denied(c);
});
test('D06: analysis descriptor must be exact even with explicit host permission', () => {
  const c = setup({ host: { allow_analysis_geography: true } }); action(c, 'inspect-evidence', 'analysis_geography');
  pin(c, { mutate: p => p.descriptors.boundary.analysis_area.description += ' inferred' }); denied(c);
});
test('D07: old external-common schema is rejected, not silently upgraded', () => {
  const c = setup(); retainedRaw(c, json({ projection_version: 1, display: commonInput(c), fields: [], current: {}, provenance: {} })); denied(c);
});
test('D08: missing cardinal stays explicitly unavailable without invented text/support', () => {
  const c = setup(); c.state.preview.candidate.evidence.geographic_neighborhood.cardinal_summaries.north = null; pin(c);
  assert.deepEqual(shown(c).document.boundary.cardinals.north, { status: 'not_available', text: null, evidence_keys: [] });
});
for (const key of ['outline_required_for_review', 'allow_analysis_geography']) test(`D09: ${key} is required literal host policy`, () => {
  for (const value of [undefined, null, 'false', 0]) { const c = setup(); c.owner[key] = value; assert.equal(denied(c).reason, 'owner_context_changed'); }
  const c = setup(); delete c.owner[key]; assert.equal(denied(c).reason, 'owner_context_changed');
});
test('D10: epoch grammar and 64-character boundary govern generated identities', () => {
  const c = setup({ host: { mount_epoch: 'a'.repeat(64), target_epoch: 'b'.repeat(64) } }); pin(c, { epoch: 'c'.repeat(64) });
  const document = shown(c).document; for (const key of ['target_key', 'operation_key', 'preview_key']) assert.ok(document[key].length <= 300);
  for (const value of ['', 'a'.repeat(65), 'space here', 'é', 'a/b']) { const d = setup(); d.owner.target_epoch = value; denied(d); }
});
test('D11: real formatter keeps year/years and null/zero distinct without altering mapped proposals', () => {
  const c = setup(), candidate = c.state.preview.candidate, e = candidate.evidence;
  const priorFields = ownerView(c.state).fields.map(row => [row.id, row.displayValue]), seed = clone(e.statistics.find(row => row.id === 'median-sale-price'));
  e.statistics.push({ ...clone(seed), id: 'year-control', measurement: 'year_built', unit: 'year', value: 1995 },
    { ...clone(seed), id: 'age-control', measurement: 'age_at_sale', unit: 'years', value: 0 },
    { ...clone(seed), id: 'unknown-price-control', status: 'incomplete', value: null, reason: 'missing_input', observed_count: 0, missing_count: 3 });
  pin(c); const formatted = formatter.formatNeighborhoodAssessmentDisplay(json(commonInput(c))); assert.equal(formatted.status, 'formatted');
  const document = shown(c).document, metrics = document.populations.flatMap(p => p.metrics), get = id => metrics.find(row => row.id === id);
  assert.equal(get('year-control').unit, 'year'); assert.equal(get('year-control').display_value, '1995');
  assert.equal(get('age-control').unit, 'years'); assert.equal(get('age-control').display_value, '0');
  assert.equal(get('unknown-price-control').display_value, null); assert.notEqual(get('unknown-price-control').status, 'available');
  assert.deepEqual(document.fields.map(row => [row.id, row.proposed.text]), priorFields);
});
test('D12: descriptor ID/label/text scalar boundaries retain content rather than truncating', () => {
  for (const [key, limit] of [['id', 300], ['label', 160], ['detail', 5000]]) {
    const c = setup(); pin(c, { mutate: p => p.descriptors.review_items = [{ ...review('geo:scalar'), [key]: 'x'.repeat(limit) }] });
    assert.equal(shown(c).document.review_items.find(row => row.id === (key === 'id' ? 'x'.repeat(limit) : 'geo:scalar'))[key].length, limit);
    pin(c, { mutate: p => p.descriptors.review_items = [{ ...review('geo:scalar'), [key]: 'x'.repeat(limit + 1) }] }); denied(c);
  }
});

test('B01: external objects, revoked proxies and toJSON are never reflected on either ingress', () => {
  const c = setup(), current = action(c, 'review-group'); let calls = 0;
  const hostile = new Proxy({}, { get() { calls++; throw Error('get'); }, ownKeys() { calls++; throw Error('keys'); },
    getPrototypeOf() { calls++; throw Error('prototype'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const getter = Object.defineProperty({}, 'projection_version', { enumerable: true, get() { calls++; throw Error('getter'); } });
  const toJSON = { toJSON() { calls++; return JSON.parse(c.projectionJson); } };
  for (const raw of [hostile, revoked.proxy, getter, toJSON, new String(c.projectionJson), {}, [], null, undefined, 1, true]) {
    denied(c, raw); assert.equal(resolve(c, raw), null); assert.equal(resolve(c, json(current), raw), null);
  }
  assert.equal(calls, 0);
});
for (const [name, transform] of [
  ['leading whitespace', raw => ` ${raw}`], ['pretty printed', raw => JSON.stringify(JSON.parse(raw), null, 2)],
  ['duplicate key', raw => raw.replace('"projection_version":1', '"projection_version":1,"projection_version":1')],
  ['escaped equivalent key', raw => raw.replace('"projection_version"', '"\\u0070rojection_version"')],
  ['invalid JSON', () => '{'],
]) test(`B02: ${name} is not exact compact projection text`, () => {
  const c = setup(); retainedRaw(c, transform(c.projectionJson)); denied(c);
});
for (const version of [2, 0, null, '1']) test(`B03: unsupported projection version ${version} is explicit and non-actionable`, () => {
  const c = setup(); pin(c, { mutate: p => p.projection_version = version }); assert.equal(denied(c).reason, 'unsupported_projection');
});
test('B04: changed epoch or digest fails despite matching retained primitive text', () => {
  for (const key of ['candidate_digest_sha256', 'binding_digest_sha256']) {
    const c = setup(); pin(c, { mutate: p => p[key] = 'f'.repeat(64) }); assert.equal(denied(c).reason, 'stale_projection');
  }
  const c = setup(); c.owner.projection.epoch = 'different_epoch'; assert.equal(denied(c).reason, 'stale_projection');
});
test('B05: literal and escaped lone surrogate encodings both fail; valid Unicode uses UTF-8', () => {
  const c = setup(); pin(c, { mutate: p => p.descriptors.boundary.neighborhood.description = '住宅 🏠 café' });
  assert.equal(shown(c).document.boundary.neighborhood.description, '住宅 🏠 café');
  for (const raw of ['"\ud800"', '"\\ud800"', '"\udc00"', '"\\udc00"']) { retainedRaw(c, raw); denied(c); }
  const oversized = json('é'.repeat(500_000)); assert.ok(oversized.length < 1_000_000); assert.equal(Buffer.byteLength(oversized), 1_000_002);
  retainedRaw(c, oversized); assert.equal(denied(c).reason, 'projection_limit');
});
test('B06: byte/depth/node exact guard boundaries are not misreported as schema-valid projections', t => {
  const c = setup();
  for (const delta of [0, 1]) {
    const raw = json('x'.repeat(999_998 + delta)); assert.equal(Buffer.byteLength(raw), 1_000_000 + delta);
    retainedRaw(c, raw); assert.equal(denied(c).reason, delta ? 'projection_limit' : 'invalid_projection');
    let nested = null; for (let n = 0; n < 24 + delta; n++) nested = [nested];
    retainedRaw(c, json(nested)); assert.equal(denied(c).reason, delta ? 'projection_limit' : 'invalid_projection');
    retainedRaw(c, json(Array(49_999 + delta).fill(null))); assert.equal(denied(c).reason, delta ? 'projection_limit' : 'invalid_projection');
  }
  t.diagnostic('Exact bounds are generic guard-order controls with intentionally invalid root schemas, not valid 1MB/50k-node/24-depth geographic projections.');
});
test('B07: 10,000 raw reference occurrences are charged before set union and semantic validation', () => {
  for (const delta of [0, 1]) {
    const c = setup(); pin(c, { mutate: p => p.extra = { evidence_keys: Array(9_995 + delta).fill('geographic_neighborhood') } });
    // Five legitimate descriptor references plus repeated extra references.
    assert.equal(denied(c).reason, delta ? 'projection_limit' : 'invalid_projection');
  }
});
test('B08: empty/loading/error owner phases do not parse or resurrect retained evidence', () => {
  const c = setup(); c.state = create(c.fixture.context);
  assert.equal(prepare(build(c, {}).envelopeJson).phase, 'empty');
  const load = start(c.state); c.state = load.state; assert.equal(prepare(build(c, {}).envelopeJson).phase, 'loading');
  c.state = failLoad(c.state, load.token); assert.equal(prepare(build(c, {}).envelopeJson).phase, 'error');
  for (const phase of [c.state]) { c.state = phase; noAction(c, 'review-group'); }
});
test('B09: malformed, extra-key, wrong-namespace and stale intents are rejected using current real guard', () => {
  const c = setup(), reviewIntent = action(c, 'review-group'), inspection = action(c, 'inspect-evidence', 'geographic_neighborhood'), refresh = action(c, 'refresh');
  const invalid = [
    { ...reviewIntent, type: 'open_group_review' }, { ...reviewIntent, selected: true }, { ...reviewIntent, item_key: 'geographic_neighborhood' },
    { ...reviewIntent, preview_key: 'old' }, { ...reviewIntent, target_key: 'old' }, { ...reviewIntent, operation_key: 'old' },
    { ...inspection, item_key: 'geographic_neighborhood:extra' }, { ...inspection, item_key: 'source:absent' },
    { ...inspection, type: 'inspect-pocket' }, { ...refresh, preview_key: reviewIntent.preview_key },
    { ...refresh, operation_key: 'old' }, { ...refresh, target_key: 'old' }, { ...refresh, type: 'unknown' },
  ];
  invalid.forEach(value => assert.equal(resolve(c, json(value)), null));
  for (const raw of [` ${json(reviewIntent)}`, json(reviewIntent).replace('"type":"review-group"', '"type":"review-group","type":"review-group"'), '{', 'null']) assert.equal(resolve(c, raw), null);
  assert.equal(resolve(c, shown(c).view), null, 'a genuine prepared object is not an external intent');
  noAction(c, 'inspect-pocket', 'pocket-a');
});
test('B10: exact 8,192-byte/+1 intent guard controls remain schema-invalid and non-actionable', t => {
  const c = setup();
  for (const delta of [0, 1]) { const raw = json('x'.repeat(8190 + delta)); assert.equal(Buffer.byteLength(raw), 8192 + delta); assert.equal(resolve(c, raw), null); }
  assert.equal(resolve(c, json('é'.repeat(4096))), null);
  t.diagnostic('No admitted intent reaches 8,192 bytes under the existing identity scalar limits; this is ingress framing only.');
});
test('C01: all generated blocker/omission rows preserve array order and repeated messages', () => {
  const c = setup(); c.state.preview.blocking_issues = ['Repeated requirement', 'Repeated requirement'];
  c.state.preview.candidate.omissions.push(c.state.preview.candidate.omissions[0]); pin(c);
  const expected = ownerView(c.state), rows = shown(c).document.review_items;
  assert.deepEqual(rows.filter(r => r.id.startsWith('uad-owner:blocker:')).map(r => [r.id, r.detail]), expected.blockers.map((text, index) => [`uad-owner:blocker:${index}`, text]));
  assert.deepEqual(rows.filter(r => r.id.startsWith('uad-owner:omission:')).map(r => [r.id, r.detail]), expected.omissions.map((row, index) => [`uad-owner:omission:${index}`, row.message]));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length); noAction(c, 'review-group');
});
test('C02: reserved real-member IDs are rejected, not confused with display-only companions', () => {
  for (const prefix of ['uad-owner:', 'assessment-display:']) {
    const c = setup(), old = c.state.preview.candidate.suggestions[0].id;
    c.state.preview.candidate.suggestions[0].id = `${prefix}forged`;
    c.state.preview.members.find(row => row.id === old).id = `${prefix}forged`; pin(c); denied(c);
  }
});
test('C03: exact combined 256 review rows include mandatory notice and every owner row; +1 fails', () => {
  const c = setup(), expected = ownerView(c.state), remaining = 256 - 1 - expected.blockers.length - expected.omissions.length;
  assert.ok(remaining > 0);
  pin(c, { mutate: p => p.descriptors.review_items = Array.from({ length: remaining }, (_, index) => review(`geo:${index}`)) });
  const rows = shown(c).document.review_items; assert.equal(rows.length, 256); assert.equal(rows.filter(row => row.id.startsWith('geo:')).length, remaining);
  pin(c, { mutate: p => p.descriptors.review_items = Array.from({ length: remaining + 1 }, (_, index) => review(`geo:${index}`)) });
  assert.equal(denied(c).reason, 'display_capacity');
});
test('C04: complete common-plus-geography evidence cap 1,000 succeeds and +1 is never truncated', () => {
  const c = setup(), e = c.state.preview.candidate.evidence, source = clone(e.sources[0]);
  const requiredSources = 1000 - e.populations.length - e.statistics.length - 1;
  e.sources = Array.from({ length: requiredSources }, (_, index) => ({ ...source, id: index === 0 ? source.id : `extra-source-${index}` }));
  pin(c); assert.equal(shown(c).document.evidence.length, 1000);
  e.sources.push({ ...source, id: 'one-source-too-many' }); pin(c); assert.equal(denied(c).reason, 'display_capacity');
});
test('C05: generated fields/notice/render metadata count toward capacity after a smaller input', t => {
  const c = setup();
  function withDetail(length, extra = 0) {
    pin(c, { mutate: p => p.descriptors.review_items = Array.from({ length: 193 }, (_, index) => review(`geo:${index}`, 'x'.repeat(length + (index < extra ? 1 : 0)))) });
    assert.ok(Buffer.byteLength(c.projectionJson) < 1_000_000);
    return build(c);
  }
  let low = 1, high = 5000; assert.equal(withDetail(low).status, 'ready');
  assert.equal(withDetail(high).status, 'unavailable', 'real output expansion must hit the unchanged composed limit');
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (withDetail(mid).status === 'ready') low = mid; else high = mid; }
  assert.equal(withDetail(low).status, 'ready'); assert.equal(withDetail(high).reason, 'display_capacity');
  let extraLow = 0, extraHigh = 193;
  while (extraHigh - extraLow > 1) { const mid = Math.floor((extraLow + extraHigh) / 2); if (withDetail(low, mid).status === 'ready') extraLow = mid; else extraHigh = mid; }
  const last = withDetail(low, extraLow); assert.equal(last.status, 'ready');
  const envelopeBytes = Buffer.byteLength(last.envelopeJson), preparedBytes = Buffer.byteLength(json(prepare(last.envelopeJson)));
  assert.equal(Math.max(envelopeBytes, preparedBytes), 1_000_000, 'exact composed envelope or prepared-output byte boundary');
  assert.equal(withDetail(low, extraHigh).reason, 'display_capacity');
  assert.ok(Buffer.byteLength(c.projectionJson) < 1_000_000, 'rejection is after composition, not oversized projection ingress');
  t.diagnostic(`Exact last accepted envelope ${envelopeBytes} bytes; prepared output ${preparedBytes} bytes; one extra ASCII byte fails composition.`);
});
test('C06: valid UAD group cannot reach the generic 1,000-field or 1,000-metric boundary', t => {
  const c = setup(); assert.equal(shown(c).document.fields.length, 7);
  const candidate = c.state.preview.candidate; candidate.suggestions.push(clone(candidate.suggestions[0]));
  c.state.preview.members.push(clone(c.state.preview.members[0])); pin(c); denied(c);
  t.diagnostic('4/7 real members plus zero-sale companions fix fields at seven; the 1,000 shared field cap is unreachable here. Common evidence (population/source/geography plus each statistic) is stricter than 1,000 metrics. No fabricated exact-bound valid group is claimed.');
});
test('C07: real module singletons and detached frozen outputs do not freeze shared caller state', () => {
  assert.deepEqual([...modules.keys()].sort(), Object.values(files).sort());
  const c = setup(), result = build(c); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(c.state), false);
  const request = action(c, 'review-group'), response = resolve(c, json(request)); assert.equal(Object.isFrozen(response), true);
  assert.equal(Object.isFrozen(c.state.preview.candidate.evidence.statistics[0]), false);
});
