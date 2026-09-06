import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { makeNeighborhoodAssessmentPreviewFixture as fixture } from './fixtures/neighborhoodAssessmentPreviewFixture.mjs';

// Only the two new local modules are transpiled. Existing installed runtime
// packages are resolved normally; no build, network, browser or server import.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const requireRuntime = createRequire(join(frontend, 'package.json'));
const ts = requireRuntime('typescript');
const React = requireRuntime('react');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
const scratchParent = resolve(tmpdir());
const scratch = mkdtempSync(join(scratchParent, 'homenode-preview-test-'));
after(() => {
  assert.ok(resolve(scratch).startsWith(scratchParent + sep));
  assert.ok(resolve(scratch).split(sep).at(-1).startsWith('homenode-preview-test-'));
  rmSync(scratch, { recursive: true, force: true });
});
function compiled(relative, imports = {}) {
  const source = readFileSync(join(frontend, relative), 'utf8');
  const result = ts.transpileModule(source, { fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const output = join(scratch, relative.split('/').at(-1).replace(/\.tsx?$/, '.cjs'));
  writeFileSync(output, result.outputText);
  const module = { exports: {} };
  const localRequire = name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    assert.ok(['react', 'react/jsx-runtime'].includes(name), `Unexpected preview dependency: ${name}`);
    return requireRuntime(name);
  };
  new Script(`(function(require,module,exports){\n${result.outputText}\n})`, { filename: output })
    .runInThisContext()(localRequire, module, module.exports);
  return module.exports;
}
const model = compiled('src/features/neighborhood/neighborhoodPreviewModel.ts');
const Component = compiled('src/features/neighborhood/components/NeighborhoodAssessmentPreview.tsx', {
  '../neighborhoodPreviewModel': model,
}).default;
const { prepareNeighborhoodPreview: prepare, createNeighborhoodPreviewIntent: intent, NEIGHBORHOOD_PREVIEW_LIMITS: L } = model;
const json = value => JSON.stringify(value);
const read = value => prepare(json(value));
const render = (value, onIntent) => renderToStaticMarkup(React.createElement(Component, { envelopeJson: json(value), onIntent }));
const clone = value => structuredClone(value);
const view = value => { const out = read(value); assert.equal(out.phase, 'shown', json(out)); return out; };
const fail = (out, reason) => {
  assert.equal(out.phase, 'unavailable');
  if (reason) assert.equal(out.reason, reason);
  assert.deepEqual(Object.keys(out).sort(), ['phase', 'reason', 'view_version']);
  assert.ok(Buffer.byteLength(json(out)) < 1000);
  assert.equal(intent(out, 'refresh'), null);
};
const actions = ['refresh', 'inspect-pocket', 'inspect-evidence', 'review-group', 'edit-area'];
const item = type => type === 'inspect-pocket' ? 'cedar' : type === 'inspect-evidence' ? 'source:shared' : undefined;
function allIntents(prepared) { return actions.map(type => intent(prepared, type, item(type))); }
function nodeCount(value) {
  let total = 0; const stack = [value];
  while (stack.length) { const node = stack.pop(); total++; if (node !== null && typeof node === 'object') stack.push(...Object.values(node)); }
  return total;
}
function elementNodes(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return [];
  if (Array.isArray(element)) return element.flatMap(elementNodes);
  if (typeof element !== 'object') return [];
  if (typeof element.type === 'function') return elementNodes(element.type(element.props));
  return [element, ...elementNodes(element.props?.children)];
}
function buttons(value, callback) {
  return elementNodes(Component({ envelopeJson: json(value), onIntent: callback })).filter(e => e.type === 'button');
}
const textOf = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '';
const fieldRow = (id, refs = []) => ({ id, label: `Field ${id}`, disposition: 'new', proposed: { status: 'value', text: '0' },
  current: { status: 'not_supplied', text: null }, explanation: 'Synthetic complete field.', evidence_keys: refs });
const sourceRow = id => ({ key: `source:${id}`, kind: 'source', id, label: `Evidence ${id}`, observation_text: null,
  support: 'unknown', detail: 'Independent synthetic display record.' });
function minimal() {
  const value = fixture(); const p = value.preview;
  p.populations = []; p.pockets = []; p.fields = []; p.review_items = [];
  p.boundary.outline = null; p.boundary.outline_required_for_review = false;
  p.boundary.neighborhood = { status: 'not_available', description: null, evidence_key: null };
  p.boundary.analysis_area = { status: 'not_available', description: null, evidence_key: null };
  for (const c of Object.values(p.boundary.cardinals)) c.evidence_keys = [];
  return value;
}

test('public budgets are fixed and cannot be mutated by a host', () => {
  assert.deepEqual({ ...L }, { input_bytes: 1_000_000, output_bytes: 1_000_000, nodes: 50_000, depth: 24,
    populations: 100, pockets: 256, fields: 1000, evidence: 1000, review_items: 256, metrics: 1000,
    references: 10000, id_length: 300, label_length: 160, text_length: 5000,
    outline_features: 256, outline_rings: 1024, outline_points: 16384 });
  assert.ok(Object.isFrozen(L)); assert.throws(() => { L.input_bytes = Infinity; }, TypeError);
});
for (const workflow of ['custom_appraisal', 'uad_3_6']) test(`${workflow}: complete display preserves separate stock, sale events, values and dates`, () => {
  const value = fixture({ workflow }); const prepared = view(value);
  assert.deepEqual(prepared.document, value.preview);
  assert.deepEqual(prepared.document.populations.map(p => [p.role, p.member_count, p.unique_property_count]),
    [['geographic_stock', 6, 6], ['competitive_stock', 10, 10], ['sales_sample', 7, 6]]);
  assert.equal(prepared.document.populations[2].metrics[0].label, 'Median sale price');
  assert.equal(prepared.document.populations[2].metrics[2].display_value, null);
  const html = render(value);
  for (const phrase of [workflow === 'uad_3_6' ? 'UAD 3.6' : 'Custom Appraisal', 'Example preview',
    'No report fields have changed.', 'Effective date', 'Observation period', 'Data cutoff',
    '2026-08-31', '2025-09-01', '2026-09-04', '$330,000', 'Geographic stock', 'Competitive stock', 'Sales sample']) assert.ok(html.includes(phrase), phrase);
  assert.ok(html.includes(value.preview.pockets[1].overlap_text));
  for (const key of Object.values(value.current).filter(v => typeof v === 'string' && v.startsWith('fixture-'))) assert.equal(html.includes(key), false);
});
test('zero sales retain all three no-proposal price companions and distinguish unknown current values from zero', () => {
  const value = fixture({ workflow: 'uad_3_6', variant: 'zero_sales' }); const prepared = view(value);
  assert.equal(prepared.document.fields.length, 7);
  assert.deepEqual(prepared.document.fields.slice(4).map(f => [f.disposition, f.proposed.status, f.proposed.text, f.current.status]),
    Array.from({ length: 3 }, () => ['empty_companion', 'not_proposed', null, 'not_supplied']));
  assert.equal(prepared.document.fields[3].proposed.text, '0');
  assert.equal(prepared.document.populations[2].member_count, 0);
  assert.ok(intent(prepared, 'review-group'));
  const html = render(value);
  assert.ok((html.match(/No proposed value/g) ?? []).length >= 3);
  assert.equal((html.match(/Current value not supplied/g) ?? []).length, 7);
  for (const f of prepared.document.fields.slice(4)) assert.ok(html.includes(f.label));
  assert.equal(/Not mapped|cleared successfully|saved successfully/i.test(html), false);
});
test('reused and conflicting fields remain visible and conflicts block group review even without a global blocker', () => {
  const value = fixture({ variant: 'reused_conflict' }); const prepared = view(value);
  assert.equal(value.preview.review_items.some(r => r.blocks_review), false);
  assert.equal(prepared.review_blocked, true); assert.equal(intent(prepared, 'review-group'), null);
  assert.ok(intent(prepared, 'edit-area'));
  const html = render(value);
  assert.ok(html.includes('Previously accepted value retained'));
  assert.ok(html.includes('Manual analysis area must be preserved'));
  assert.equal(prepared.document.fields.length, 7);
});

const gating = [
  ['fresh', () => {}, [true, true, true, true, true]],
  ['inspect access', v => { v.current.access = 'inspect'; }, [true, true, true, false, false]],
  ['read only', v => { v.current.read_only = true; }, [true, true, true, false, false]],
  ['dirty', v => { v.current.dirty = true; }, [false, true, true, false, false]],
  ['spatial review', v => { v.current.spatial_review = 'required'; }, [true, true, true, false, true]],
  ['field conflict', v => { v.preview.fields[0].disposition = 'conflict'; }, [true, true, true, false, true]],
  ['blocking review', v => { v.preview.review_items[0].blocks_review = true; }, [true, true, true, false, true]],
  ['old operation', v => { v.current.operation_key = 'next-operation'; }, [true, false, false, false, false]],
  ['old preview', v => { v.current.preview_key = 'next-preview'; }, [true, false, false, false, false]],
  ['wrong target', v => { v.current.target_key = 'other-target'; }, [false, false, false, false, false]],
  ['no access', v => { v.current.access = 'none'; }, [false, false, false, false, false]],
  ['disabled actions', v => { v.current.actions = { refresh: false, open_review: false, edit_area: false }; }, [false, true, true, false, false]],
  ['loading', v => { v.load = 'loading'; }, [false, false, false, false, false]],
  ['failed', v => { v.load = 'failed'; }, [true, false, false, false, false]],
  ['empty', v => { v.load = 'empty'; }, [true, false, false, false, false]],
];
for (const [name, change, allowed] of gating) test(`central guard: ${name} independently gates every action`, () => {
  const value = fixture(); change(value); const prepared = read(value);
  assert.deepEqual(allIntents(prepared).map(Boolean), allowed);
  for (const [index, action] of actions.entries()) {
    const out = intent(prepared, action, item(action));
    if (!allowed[index]) continue;
    assert.deepEqual(out, { type: action, target_key: value.current.target_key, operation_key: value.current.operation_key,
      ...(action === 'refresh' ? {} : { preview_key: value.current.preview_key }),
      ...(item(action) === undefined ? {} : { item_key: item(action) }) });
    assert.ok(Object.isFrozen(out));
  }
});
for (const permission of ['refresh', 'open_review', 'edit_area']) test(`a false ${permission} permission restricts only its corresponding action`, () => {
  const value = fixture(); value.current.actions[permission] = false;
  const blocked = { refresh: 'refresh', open_review: 'review-group', edit_area: 'edit-area' }[permission];
  for (const type of actions) assert.equal(Boolean(intent(read(value), type, item(type))), type !== blocked);
});
test('corrective area edit still requires current keys, review access, clean state, mutability and explicit permission', () => {
  for (const change of [v => { v.current.dirty = true; }, v => { v.current.read_only = true; },
    v => { v.current.access = 'inspect'; }, v => { v.current.actions.edit_area = false; },
    v => { v.current.operation_key = 'changed'; }, v => { v.current.preview_key = 'changed'; }]) {
    const value = fixture({ variant: 'reused_conflict' }); value.current.spatial_review = 'required'; change(value);
    assert.equal(intent(read(value), 'edit-area'), null);
  }
});
test('A to B to A and repeated candidate loads require a fresh operation at the host boundary', () => {
  const a1 = fixture(), a2 = fixture(); a2.current.operation_key = 'fixture-load-3'; a2.preview.operation_key = 'fixture-load-3';
  a2.preview.boundary.outline.operation_key = 'fixture-load-3';
  const old = view(a1), recent = view(a2);
  assert.equal(old.document.preview_key, recent.document.preview_key);
  const oldIntent = intent(old, 'review-group'), recentIntent = intent(recent, 'review-group');
  assert.ok(oldIntent, 'local branding does not revoke an old owned view');
  const acceptsCurrent = event => ['target_key', 'operation_key', 'preview_key'].every(key => event[key] === a2.current[key]);
  assert.equal(acceptsCurrent(oldIntent), false); assert.equal(acceptsCurrent(recentIntent), true);
  const b = fixture(); b.current.target_key = 'fixture-target-B';
  assert.equal(read(b).phase, 'unavailable');
});
test('actual React context keys cannot collide when opaque identities contain colons', () => {
  const keyed = tuple => {
    const value = fixture();
    for (const [index, key] of ['target_key', 'operation_key', 'preview_key'].entries()) {
      value.current[key] = tuple[index]; value.preview[key] = tuple[index];
      value.preview.boundary.outline[key] = tuple[index];
    }
    assert.equal(view(value).freshness, 'current');
    return Component({ envelopeJson: json(value) });
  };
  const first = keyed(['a:b', 'c', 'd']), second = keyed(['a', 'b:c', 'd']);
  assert.notEqual(first.key, null); assert.notEqual(second.key, null); assert.notEqual(first.key, second.key);
  assert.equal(first.key, keyed(['a:b', 'c', 'd']).key);
});
test('a new current operation resets the actual stale subtree while retaining the same comparison document', () => {
  const oldValue = fixture(); const updated = clone(oldValue); updated.current.operation_key = 'fixture-load-2';
  const oldView = view(oldValue), stale = view(updated);
  assert.equal(stale.freshness, 'stale'); assert.deepEqual(stale.document, oldView.document);
  const oldElement = Component({ envelopeJson: json(oldValue) });
  const nextElement = Component({ envelopeJson: json(updated) });
  assert.notEqual(nextElement.key, oldElement.key);
  assert.equal(nextElement.key, Component({ envelopeJson: json(updated) }).key);
  assert.equal(nextElement.key, stale.render_key);
  assert.ok(render(updated).includes(updated.preview.subject_label));
  for (const type of actions.filter(type => type !== 'refresh')) assert.equal(intent(stale, type, item(type)), null);
  assert.deepEqual(JSON.parse(stale.render_key), [
    ['fixture-target-session-A', 'fixture-load-2', 'fixture-candidate-1'],
    ['fixture-target-session-A', 'fixture-load-1', 'fixture-candidate-1'],
  ]);
});
test('changing only the expected preview revision also resets the actual stale subtree', () => {
  const oldValue = fixture(); const updated = clone(oldValue); updated.current.preview_key = 'fixture-candidate-2';
  const stale = view(updated); assert.equal(stale.freshness, 'stale'); assert.deepEqual(stale.document, oldValue.preview);
  assert.notEqual(Component({ envelopeJson: json(updated) }).key, Component({ envelopeJson: json(oldValue) }).key);
  assert.equal(Component({ envelopeJson: json(updated) }).key, stale.render_key);
  for (const type of actions.filter(type => type !== 'refresh')) assert.equal(intent(stale, type, item(type)), null);
});
test('namespaced evidence resolves exact categories even with the same bare ID', () => {
  const prepared = view(fixture());
  for (const key of ['geographic_neighborhood', 'analysis_geography', 'population:shared', 'statistic:shared', 'source:shared']) {
    assert.equal(intent(prepared, 'inspect-evidence', key)?.item_key, key);
  }
  for (const key of ['shared', 'source:geographic_neighborhood', 'population:missing', 'cedar']) assert.equal(intent(prepared, 'inspect-evidence', key), null);
  assert.equal(intent(prepared, 'inspect-pocket', 'source:shared'), null);
});

for (const [name, change] of [
  ['metric population substitution', v => { v.preview.populations[2].metrics[0].population_id = 'shared'; }],
  ['population evidence substitution', v => { v.preview.populations[0].evidence_key = 'source:shared'; }],
  ['unresolved field evidence', v => { v.preview.fields[0].evidence_keys = ['source:absent']; }],
  ['cross-kind registry spelling', v => { v.preview.evidence[2].key = 'source:shared'; }],
  ['duplicate registry record', v => { v.preview.evidence.push(clone(v.preview.evidence[0])); }],
  ['duplicate metric ID across populations', v => { v.preview.populations[2].metrics[0].id = 'stock-count'; }],
  ['duplicate population ID', v => { v.preview.populations[1].id = 'shared'; }],
  ['duplicate field ID', v => { v.preview.fields[1].id = v.preview.fields[0].id; }],
  ['duplicate pocket ID', v => { v.preview.pockets[1].id = v.preview.pockets[0].id; }],
  ['duplicate review ID', v => { v.preview.review_items.push(clone(v.preview.review_items[0])); }],
  ['duplicate evidence occurrence', v => { v.preview.fields[0].evidence_keys.push(v.preview.fields[0].evidence_keys[0]); }],
]) test(`${name} never yields partially retained private data or actions`, () => { const value = fixture(); change(value); fail(read(value)); });
test('input, prepared data and guard results have independent immutable ownership', () => {
  const value = fixture(); const prepared = view(value); const saved = json(prepared);
  value.preview.fields[0].proposed.text = 'Caller replacement'; value.current.dirty = true;
  assert.equal(json(prepared), saved);
  assert.throws(() => { prepared.document.fields[0].proposed.text = 'Output mutation'; }, TypeError);
  assert.throws(() => prepared.document.evidence.push({}), TypeError);
  assert.ok(intent(prepared, 'review-group'));
  for (const fabricated of [clone(prepared), { ...prepared }, {}, [], null, 'shown']) assert.equal(intent(fabricated, 'review-group'), null);
});
test('objects, getters and proxies at the serialized boundary are rejected without invoking caller code', () => {
  let calls = 0;
  const object = Object.defineProperty({}, 'toJSON', { get() { calls++; throw new Error('Private marker'); } });
  const proxy = new Proxy({}, { get() { calls++; throw new Error('Private marker'); }, ownKeys() { calls++; throw new Error('Private marker'); },
    getOwnPropertyDescriptor() { calls++; throw new Error('Private marker'); }, getPrototypeOf() { calls++; throw new Error('Private marker'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [object, proxy, revoked.proxy, {}, [], new String('{}'), null, 1, true, undefined]) fail(prepare(value), 'invalid_input');
  for (const value of [object, proxy, revoked.proxy]) assert.equal(intent(value, 'review-group'), null);
  const prepared = view(fixture());
  for (const value of [object, proxy, revoked.proxy, null, true, 1]) {
    assert.equal(intent(prepared, value), null); assert.equal(intent(prepared, 'inspect-evidence', value), null);
  }
  assert.equal(calls, 0);
});
test('unknown actions and spurious item payloads cannot create a persistence command', () => {
  const prepared = view(fixture());
  for (const type of ['apply', 'save', 'confirm', 'select-field', '', '__proto__']) assert.equal(intent(prepared, type), null);
  for (const type of ['refresh', 'review-group', 'edit-area']) for (const extra of ['source:shared', '', {}, null]) assert.equal(intent(prepared, type, extra), null);
});
for (const [name, input] of [
  ['malformed', '{'], ['duplicate key', json(fixture()).replace('"preview_version":1,', '"preview_version":1,"preview_version":1,')],
  ['leading whitespace', ' ' + json(fixture())], ['trailing whitespace', json(fixture()) + '\n'],
  ['alternate number', json(fixture()).replace('"preview_version":1', '"preview_version":1.0')],
  ['negative zero', json(fixture()).replace('"frame":[0', '"frame":[-0')],
]) test(`strict serialized JSON rejects ${name}`, () => fail(prepare(input), 'invalid_input'));
for (const [name, change] of [
  ['unknown root key', v => { v.permission = true; }], ['unsupported version', v => { v.preview_version = 2; }],
  ['invalid calendar date', v => { v.preview.effective_date = '2026-02-30'; }],
  ['reversed observation dates', v => { v.preview.observation_period.start_date = '2027-01-01'; }],
  ['truthy dirty state', v => { v.current.dirty = 'false'; }], ['negative population count', v => { v.preview.populations[0].member_count = -1; }],
  ['unsafe population count', v => { v.preview.populations[0].member_count = Number.MAX_SAFE_INTEGER + 1; }],
  ['empty companion with proposed value', v => { v.preview.fields[4].disposition = 'empty_companion'; }],
  ['known empty with text', v => { v.preview.fields[0].current = { status: 'known_empty', text: '0' }; }],
  ['available metric without display', v => { v.preview.populations[0].metrics[0].display_value = null; }],
]) test(`schema contradiction ${name} is atomic`, () => { const value = fixture(); change(value); fail(read(value)); });

test('ordinary Unicode, surrogate pairs, quotes and escaped newlines remain exact display data', () => {
  const value = fixture(); const label = 'Café 🏠 "north"\nCreek'; value.preview.subject_label = label;
  assert.equal(view(value).document.subject_label, label);
  assert.ok(render(value).includes('Café 🏠 &quot;north&quot;\nCreek'));
  for (const invalid of ['\ud800', '\udfff']) { value.preview.subject_label = invalid; fail(read(value)); }
});
test('unknown source details never become HTML, URLs, scripting or correlation tokens', () => {
  const value = fixture(); const attack = '<script>alert("fixture")</script><img src=x onerror=alert(1)> https://example.invalid/private';
  value.preview.evidence[6].detail = attack;
  const html = render(value);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(/<script\b|<img\b/i.test(html), false);
  for (const tag of html.match(/<[^>]+>/g) ?? []) assert.doesNotMatch(tag, /\b(?:href|on[a-z]+)=/i);
  assert.equal(html.includes(value.current.target_key), false);
  assert.equal(html.includes(value.current.operation_key), false);
  assert.equal(html.includes(value.current.preview_key), false);
});
test('known empty, unavailable before-value and unmapped proposal states remain distinct in actual SSR', () => {
  const value = fixture();
  value.preview.fields[0].current = { status: 'known_empty', text: null };
  value.preview.fields[1].current = { status: 'known_value', text: '0' };
  value.preview.fields[2].disposition = 'unmapped'; value.preview.fields[2].proposed = { status: 'not_proposed', text: null };
  const prepared = view(value); assert.equal(prepared.document.fields[0].current.status, 'known_empty');
  const html = render(value);
  assert.ok(html.includes('>Empty</dd>')); assert.ok(html.includes('>0</dd>')); assert.ok(html.includes('Not mapped'));
  assert.equal((html.match(/Current value not supplied/g) ?? []).length, 5);
  assert.equal(prepared.document.fields.length, 7);
});
test('a complete candidate cannot be displayed without a current preview correlation key', () => {
  const value = fixture(); value.current.preview_key = null;
  fail(read(value)); assert.equal(render(value).includes(value.preview.subject_label), false);
});
test('blank identities and nonfinite numeric spellings are rejected without coercion', () => {
  for (const change of [v => { v.current.operation_key = ' '; }, v => { v.preview.fields[0].id = '\t'; },
    v => { v.preview.pockets[0].id = ' cedar '; }]) { const value = fixture(); change(value); fail(read(value)); }
  fail(prepare(json(fixture()).replace('"member_count":6', '"member_count":1e999')), 'invalid_input');
});
for (const [name, change] of [
  ['target switch', v => { v.current.target_key = 'other-report-or-session'; }],
  ['access revoked', v => { v.current.access = 'none'; v.current.target_key = null; v.current.operation_key = null; v.current.preview_key = null; }],
  ['load pending', v => { v.load = 'loading'; }], ['load failed', v => { v.load = 'failed'; }], ['load empty', v => { v.load = 'empty'; }],
]) test(`SSR ${name} clears prior private subject, values, evidence and outline`, () => {
  const value = fixture(); value.preview.subject_label = 'PRIVATE_SUBJECT_SENTINEL'; value.preview.evidence[0].detail = 'PRIVATE_EVIDENCE_SENTINEL'; change(value);
  const html = render(value);
  assert.equal(/PRIVATE_|\$330,000|<svg|Cedar Court/.test(html), false);
});
test('stale same-target comparison is explicit text and has no preview-bound controls', () => {
  const value = fixture(); value.current.operation_key = 'new-load';
  const html = render(value, () => {});
  assert.ok(html.includes(value.preview.subject_label)); assert.ok(html.includes('out of date'));
  const enabled = buttons(value, () => {}).filter(b => !b.props.disabled).map(textOf);
  assert.deepEqual(enabled, ['Refresh preview']);
});
test('actual SSR uses headings, tables, disclosures, buttons and no save or selection flow', () => {
  let calls = 0; const value = fixture(); const html = render(value, () => calls++);
  for (const markup of ['<h2', '<table', '<thead', '<th scope="col"', '<th scope="row"', '<details', '<summary', '<time dateTime=', 'aria-label="Area outline"']) assert.ok(html.includes(markup), markup);
  for (const tag of html.match(/<button\b[^>]*>/g) ?? []) assert.match(tag, /type="button"/);
  assert.equal(/<form|type="checkbox"|type="submit"|>Apply<|>Save<|saved successfully/i.test(html), false);
  assert.equal(calls, 0);
});
test('actual component handlers emit only guarded narrow intents, including if a disabled button handler is invoked', () => {
  const value = fixture(); const events = []; const controls = buttons(value, event => events.push(event));
  const inspect = controls.find(b => textOf(b) === 'Inspect pocket: Cedar Court'); inspect.props.onClick();
  assert.deepEqual(events, [{ type: 'inspect-pocket', target_key: value.current.target_key, operation_key: value.current.operation_key,
    preview_key: value.current.preview_key, item_key: 'cedar' }]);
  value.current.dirty = true;
  const dirtyControls = buttons(value, event => events.push(event));
  for (const label of ['Refresh preview', 'Edit area', 'Review report changes']) {
    const control = dirtyControls.find(b => textOf(b) === label); assert.equal(control.props.disabled, true); control.props.onClick();
  }
  assert.equal(events.length, 1);
  for (const missing of [undefined, null, 'not-a-function']) {
    for (const control of buttons(fixture(), missing)) { assert.equal(control.props.disabled, true); control.props.onClick(); }
  }
});
test('holes and disconnected pieces retain every supplied ring and use evenodd paths with north-up display scaling', () => {
  const value = fixture(); const before = json(value.preview.boundary.outline); const prepared = view(value);
  assert.equal(json(prepared.document.boundary.outline), before);
  const nodes = elementNodes(Component({ envelopeJson: json(value) })); const paths = nodes.filter(n => n.type === 'path');
  assert.equal(paths.length, 4); assert.ok(paths.every(p => p.props.fillRule === 'evenodd'));
  assert.deepEqual(paths.map(p => (p.props.d.match(/M/g) ?? []).length), [1, 2, 1, 1]);
  assert.deepEqual(paths.map(p => (p.props.d.match(/ L/g) ?? []).length), [4, 8, 4, 4]);
  // Shared frame240x120 gives uniform scale2.5, left20, top30. North moves up.
  assert.match(paths[0].props.d, /^M45,305 L70,305 L70,280 L45,280 L45,305 Z$/);
  assert.equal(json(value.preview.boundary.outline), before);
});
for (const [name, change] of [
  ['missing', v => { v.preview.boundary.outline = null; }],
  ['wrong target', v => { v.preview.boundary.outline.target_key = 'another'; }],
  ['wrong operation', v => { v.preview.boundary.outline.operation_key = 'another'; }],
  ['wrong preview', v => { v.preview.boundary.outline.preview_key = 'another'; }],
  ['open ring', v => { v.preview.boundary.outline.features[0].polygons[0][0].pop(); }],
  ['outside frame', v => { v.preview.boundary.outline.features[0].polygons[0][0][1][0] = 241; }],
  ['duplicate feature', v => { v.preview.boundary.outline.features.push(clone(v.preview.boundary.outline.features[0])); }],
  ['unknown evidence', v => { v.preview.boundary.outline.evidence_keys = ['source:absent']; }],
  ['frame too small', v => { v.preview.boundary.outline.frame = [0, 0, 0.0009, 120]; }],
  ['coordinate too large', v => { v.preview.boundary.outline.frame = [0, 0, 1000001, 120]; }],
]) test(`outline ${name} removes the whole outline but preserves textual evidence and corrective editing`, () => {
  const value = fixture(); change(value); const prepared = view(value);
  assert.equal(prepared.document.boundary.outline, null); assert.equal(prepared.outline_unavailable, true);
  assert.equal(intent(prepared, 'review-group'), null); assert.ok(intent(prepared, 'edit-area'));
  assert.equal(prepared.document.fields.length, 7); assert.equal(prepared.document.evidence.length, 8);
  const html = render(value); assert.ok(html.includes('Area outline unavailable')); assert.equal(html.includes('<svg'), false);
  value.preview.boundary.outline_required_for_review = false;
  assert.ok(intent(view(value), 'review-group'));
});

test('ID, label and ordinary-text exact UTF16 length bounds admit full values and reject cap+1', () => {
  const value = fixture(); const longKey = 'k'.repeat(300);
  value.current.target_key = longKey; value.preview.target_key = longKey; value.preview.boundary.outline.target_key = longKey;
  value.preview.subject_label = '🏠'.repeat(80); value.preview.evidence[0].detail = 'é'.repeat(5000);
  const prepared = view(value); assert.equal(prepared.document.subject_label.length, 160); assert.equal(prepared.document.evidence[0].detail.length, 5000);
  for (const change of [v => { v.current.target_key += 'x'; }, v => { v.preview.subject_label += 'x'; }, v => { v.preview.evidence[0].detail += 'x'; }]) {
    const over = clone(value); change(over); fail(read(over));
  }
});
for (const [collection, cap] of [['pockets', 256], ['fields', 1000], ['evidence', 1000], ['review_items', 256]]) {
  test(`${collection} exact collection cap retains every row and cap+1 rejects atomically`, () => {
    const value = minimal();
    if (collection === 'pockets') value.preview.pockets = Array.from({ length: cap }, (_, i) => ({ id: `p${i}`, label: `Pocket ${i}`, disposition: 'needs_review', explanation: 'Independent alternative.', overlap_text: null, evidence_keys: [] }));
    if (collection === 'fields') value.preview.fields = Array.from({ length: cap }, (_, i) => fieldRow(`f${i}`));
    if (collection === 'evidence') value.preview.evidence = Array.from({ length: cap }, (_, i) => sourceRow(`s${i}`));
    if (collection === 'review_items') value.preview.review_items = Array.from({ length: cap }, (_, i) => ({ id: `r${i}`, label: `Review ${i}`, detail: 'Independent note.', blocks_review: false, evidence_keys: [] }));
    assert.equal(view(value).document[collection].length, cap);
    value.preview[collection].push({ ...value.preview[collection][0], id: 'over-limit', key: 'source:over-limit' });
    fail(read(value), 'structure_limit');
  });
}
test('population and global metric bounds apply across enclosing populations', () => {
  const value = minimal(); value.preview.populations = []; value.preview.evidence = [];
  for (let i = 0; i < 100; i++) {
    value.preview.evidence.push({ ...sourceRow(`p${i}`), key: `population:p${i}`, kind: 'population' });
    value.preview.populations.push({ id: `p${i}`, role: 'geographic_stock', definition: 'Separate retained population.', member_count: null,
      unique_property_count: null, coverage_text: null, evidence_key: `population:p${i}`, metrics: Array.from({ length: 10 }, (_, j) => ({
        id: `m${i}-${j}`, population_id: `p${i}`, label: 'Supplied metric', display_value: '0', unit: null,
        estimator_label: 'Supplied estimator', status: 'available', evidence_keys: [],
      })) });
  }
  assert.equal(view(value).document.populations.reduce((n, p) => n + p.metrics.length, 0), 1000);
  const overMetric = clone(value); overMetric.preview.populations[0].metrics.push({ ...overMetric.preview.populations[0].metrics[0], id: 'extra' });
  fail(read(overMetric), 'structure_limit');
  value.preview.populations.push(clone(value.preview.populations[0])); fail(read(value), 'structure_limit');
});
test('the reference allowance counts all occurrences instead of unique registry keys', () => {
  const value = minimal(); value.preview.evidence = Array.from({ length: 11 }, (_, i) => sourceRow(`r${i}`));
  const refs = value.preview.evidence.map(e => e.key);
  value.preview.fields = Array.from({ length: 1000 }, (_, i) => fieldRow(`f${i}`, refs.slice(0, 10)));
  assert.equal(view(value).document.fields.reduce((n, f) => n + f.evidence_keys.length, 0), 10000);
  value.preview.fields[0].evidence_keys.push(refs[10]); fail(read(value), 'structure_limit');
});
function boundedOutline(kind, count) {
  const value = minimal(); const o = fixture().preview.boundary.outline;
  const f = { id: 'bounded', role: 'pocket', label: 'Display only', evidence_keys: [], polygons: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
  if (kind === 'features') o.features = Array.from({ length: count }, (_, i) => ({ ...clone(f), id: `f${i}` }));
  if (kind === 'rings') { f.polygons = [Array.from({ length: count }, () => clone(f.polygons[0][0]))]; o.features = [f]; }
  if (kind === 'points') {
    const points = Array.from({ length: count }, (_, i) => [i % 100, Math.floor(i / 100) % 100]); points[points.length - 1] = [0, 0];
    f.polygons = [[points]]; o.features = [f];
  }
  value.preview.boundary.outline = o; value.preview.boundary.outline_required_for_review = true;
  return value;
}
for (const [kind, cap] of [['features', 256], ['rings', 1024], ['points', 16384]]) test(`outline ${kind} exact cap stays complete; one above isolates the entire outline`, () => {
  const exact = boundedOutline(kind, cap); assert.ok(nodeCount(exact) < 50000);
  assert.ok(view(exact).document.boundary.outline);
  const over = boundedOutline(kind, cap + 1); assert.ok(nodeCount(over) < 50000);
  const prepared = view(over); assert.equal(prepared.document.boundary.outline, null);
  assert.equal(intent(prepared, 'review-group'), null); assert.ok(intent(prepared, 'edit-area'));
});
test('exact whole-input JSON node count is admitted and one extra valid reference fails before partial geometry', () => {
  const value = boundedOutline('points', 4);
  value.preview.fields = Array.from({ length: 60 }, (_, i) => fieldRow(`field${i}`));
  const existing = nodeCount(value); const morePoints = Math.floor((50000 - existing) / 3);
  const ring = value.preview.boundary.outline.features[0].polygons[0][0];
  ring.splice(1, 0, ...Array.from({ length: morePoints }, (_, i) => [i % 100, Math.floor(i / 100) % 100]));
  assert.ok(ring.length <= 16384);
  const extras = ['source:shared', 'population:shared', 'source:unknown'];
  while (nodeCount(value) < 50000) value.preview.boundary.outline.evidence_keys.push(extras.shift());
  assert.equal(nodeCount(value), 50000); assert.ok(view(value).document.boundary.outline);
  value.preview.boundary.outline.evidence_keys.push(extras.shift()); assert.equal(nodeCount(value), 50001);
  fail(read(value), 'structure_limit');
});
test('depth root is zero; depth24 reaches schema rejection while depth25 fails structural admission', () => {
  // Deliberately outside the fixed schema: this distinguishes the structural
  // threshold from schema admission without pretending a nested array is a view.
  const nested = depth => { let value = null; for (let i = 0; i < depth; i++) value = [value]; return value; };
  fail(prepare(json(nested(24))), 'invalid_input');
  fail(prepare(json(nested(25))), 'structure_limit');
});
function byteSizedEnvelope(target, unicode = false, keys = ['t', 'o', 'p']) {
  const value = minimal(); value.preview.evidence = Array.from({ length: 250 }, (_, i) => sourceRow(`pad${i}`));
  for (const [index, key] of ['target_key', 'operation_key', 'preview_key'].entries()) {
    value.current[key] = keys[index]; value.preview[key] = keys[index];
  }
  let missing = target - Buffer.byteLength(json(value));
  for (const e of value.preview.evidence) {
    if (missing <= 0) break;
    const capacity = 5000 - e.detail.length;
    const amount = Math.min(capacity * (unicode ? 2 : 1), missing);
    const pairs = unicode ? Math.floor(amount / 2) : 0;
    e.detail += 'é'.repeat(pairs) + 'x'.repeat(amount - pairs * 2);
    missing = target - Buffer.byteLength(json(value));
  }
  assert.equal(missing, 0); assert.equal(Buffer.byteLength(json(value)), target);
  return value;
}
for (const unicode of [false, true]) test(`whole UTF8 input cap ${unicode ? 'multibyte' : 'ASCII'} counts metadata and retains complete output`, () => {
  const exact = byteSizedEnvelope(1_000_000, unicode); const prepared = view(exact);
  assert.equal(prepared.document.evidence.length, 250); assert.deepEqual(prepared.document.evidence, exact.preview.evidence);
  assert.ok(Buffer.byteLength(json(prepared)) <= 1_000_000);
  // These short identities leave enough room for complete render-key metadata.
  // The separate long/escaped-key case exercises a reachable output-only cap.
  assert.ok(Buffer.byteLength(json(prepared)) > 999000);
  const over = byteSizedEnvelope(1_000_001, unicode); fail(read(over), 'input_limit');
});
test('full output cap counts the real current-plus-document render key including nested JSON escaping', () => {
  const keys = ['"'.repeat(300), '\\'.repeat(300), '🧭'.repeat(150)];
  const sample = byteSizedEnvelope(900000, false, keys); const sampleView = view(sample);
  assert.deepEqual(JSON.parse(sampleView.render_key), [keys, keys]);
  const overhead = Buffer.byteLength(json(sampleView)) - Buffer.byteLength(json(sample));
  assert.ok(overhead > 0, 'long repeated/escaped identity tuples produce a real output-only expansion');
  const exact = byteSizedEnvelope(1_000_000 - overhead, false, keys); const prepared = view(exact);
  assert.equal(Buffer.byteLength(json(prepared)), 1_000_000);
  assert.deepEqual(prepared.document.evidence, exact.preview.evidence);
  const over = byteSizedEnvelope(1_000_001 - overhead, false, keys);
  assert.ok(Buffer.byteLength(json(over)) < 1_000_000, 'the input cap must not explain this rejection');
  fail(read(over), 'output_limit');
});
test('an enormous primitive or globally excessive outline is rejected atomically', () => {
  fail(prepare('x'.repeat(1_000_001)), 'input_limit');
  fail(prepare('é'.repeat(500001)), 'input_limit');
  fail(prepare('🏠'.repeat(250001)), 'input_limit');
  const value = boundedOutline('points', 16667);
  assert.ok(nodeCount(value) > 50000); fail(read(value), 'structure_limit');
});
test('an early invalid outline feature cannot hide reference occurrences in later geometry payloads', () => {
  const value = fixture(); value.preview.boundary.outline.features[0].polygons = [];
  const countedReferences = input => {
    let count = 0; const stack = [input];
    while (stack.length) {
      const current = stack.pop(); if (current === null || typeof current !== 'object') continue;
      for (const [key, entry] of Object.entries(current)) {
        if (key === 'evidence_keys' && Array.isArray(entry)) count += entry.length;
        if (key === 'evidence_key' && entry !== null) count++;
        if (entry !== null && typeof entry === 'object') stack.push(entry);
      }
    }
    return count;
  };
  const later = value.preview.boundary.outline.features[2]; later.evidence_keys = [];
  later.evidence_keys = Array(10000 - countedReferences(value)).fill('source:shared');
  assert.equal(countedReferences(value), 10000);
  const within = view(value); assert.equal(within.document.boundary.outline, null);
  assert.equal(within.document.fields.length, 7);
  later.evidence_keys.push('source:shared'); assert.equal(countedReferences(value), 10001);
  fail(read(value), 'structure_limit');
});
