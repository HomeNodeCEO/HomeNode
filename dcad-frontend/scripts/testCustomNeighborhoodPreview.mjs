import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { makeCustomNeighborhoodPreviewFixture as fixture, customControllerForAssessment,
  customFormatterInput, expectedCustomDisplayNotice, copyCustomFixture as copy } from './fixtures/customNeighborhoodPreviewFixture.mjs';

// Actual frontend modules only, exactly one instance of each. The model's
// private prepared identity must survive adapter -> real intent-guard calls.
// Existing pure backend normalization is restricted to the TEST fixture.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const ts = createRequire(join(frontend, 'package.json'))('typescript');
const names = {
  model: 'src/features/neighborhood/neighborhoodPreviewModel.ts',
  formatter: 'src/features/neighborhood/neighborhoodAssessmentDisplay.ts',
  adapter: 'src/features/neighborhood/customNeighborhoodPreviewAdapter.ts',
};
const cache = new Map();
function compiled(name) {
  if (cache.has(name)) return cache.get(name);
  const relative = names[name]; assert.ok(relative, 'allowlisted production module');
  const output = ts.transpileModule(readFileSync(join(frontend, relative), 'utf8'), { fileName: relative,
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} }; cache.set(name, module.exports);
  const requireLocal = requested => {
    const allowed = { './neighborhoodPreviewModel': 'model', './neighborhoodAssessmentDisplay': 'formatter' };
    assert.ok(Object.hasOwn(allowed, requested), `Unexpected production import: ${requested}`);
    return compiled(allowed[requested]);
  };
  new Script(`(function(require,module,exports){\n${output.outputText}\n})`, { filename: relative })
    .runInThisContext()(requireLocal, module, module.exports);
  cache.set(name, module.exports); return module.exports;
}
const { prepareNeighborhoodPreview: prepare, createNeighborhoodPreviewIntent: intent } = compiled('model');
const { formatNeighborhoodAssessmentDisplay: format } = compiled('formatter');
const adapter = compiled('adapter');
const { buildCustomNeighborhoodInspectionEnvelope: build, resolveCustomNeighborhoodInspectionIntent: resolve } = adapter;
const json = JSON.stringify;
const B = value => Buffer.byteLength(typeof value === 'string' ? value : json(value));
const strings = f => [json(f.controller), json(f.assessment)];
const allowedCodes = ['invalid_input', 'input_limit', 'structure_limit', 'unsupported_version', 'binding_unavailable',
  'binding_mismatch', 'invalid_assessment', 'unsupported_records', 'invalid_references', 'display_capacity'];
const safeFailure = (result, reason) => {
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']); assert.equal(result.status, 'unavailable');
  assert.ok(allowedCodes.includes(result.reason)); if (reason) assert.equal(result.reason, reason);
  assert.ok(B(result) < 1000); return result;
};
function good(f = fixture()) {
  const result = build(...strings(f)); assert.equal(result.status, 'ready', json(result));
  assert.deepEqual(Object.keys(result).sort(), ['envelopeJson', 'status']);
  assert.ok(B(result) <= 1000000 && B(result.envelopeJson) <= 1000000);
  const envelope = JSON.parse(result.envelopeJson), prepared = prepare(result.envelopeJson);
  assert.equal(prepared.phase, 'shown', json(prepared)); assert.equal(prepared.freshness, 'current');
  return { result, envelope, prepared, document: prepared.document };
}
function inactive(load = 'empty', access = 'inspect') {
  const controller = fixture().controller;
  Object.assign(controller, { load, expected: null, subject_label: null });
  controller.current.access = access; controller.current.preview_key = null;
  if (access === 'none') Object.assign(controller.current, { target_key: null, operation_key: null });
  return controller;
}
function latestResolve(f, value) { return resolve(...strings(f), json(value)); }
function metric(document, id) { return document.populations.flatMap(p => p.metrics).find(m => m.id === id); }
function measure(value) {
  const stack = [{ value, depth: 0 }]; let nodes = 0, depth = 0, references = 0;
  const arrays = new Set(['source_refs', 'required_population_ids', 'required_statistic_ids', 'population_refs',
    'pocket_ids', 'required_evidence_keys', 'evidence_keys']);
  const scalars = new Set(['population_id', 'members_resource_id', 'pocket_id', 'evidence_key']);
  while (stack.length) {
    const current = stack.pop(); nodes++; depth = Math.max(depth, current.depth);
    if (!current.value || typeof current.value !== 'object') continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (arrays.has(key) && Array.isArray(child)) references += child.length;
      if (scalars.has(key) && child !== null) references++;
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return { nodes, depth, references };
}
const combined = f => { const a = measure(f.controller), b = measure(f.assessment);
  return { bytes: B(json(f.controller)) + B(json(f.assessment)) + 3, nodes: 1 + a.nodes + b.nodes,
    depth: 1 + Math.max(a.depth, b.depth), references: a.references + b.references }; };

test('Custom adapter exports only the two frozen functions and uses one real dependency instance', () => {
  assert.deepEqual(Object.keys(adapter).sort(), ['buildCustomNeighborhoodInspectionEnvelope', 'resolveCustomNeighborhoodInspectionIntent']);
  assert.equal(cache.size, 3); assert.equal(compiled('model'), cache.get('model')); assert.equal(compiled('formatter'), cache.get('formatter'));
});

for (const options of [{}, { zeroSales: true }, { incompleteGeography: true }]) test(`actual normalized core composition ${json(options)}`, () => {
  const f = fixture(options), before = json(f), out = good(f), formatted = format(json(customFormatterInput(f.assessment)));
  assert.equal(formatted.status, 'formatted');
  assert.deepEqual(out.document.populations, formatted.display.populations);
  assert.deepEqual(out.document.evidence.filter(e => e.kind !== 'geographic_neighborhood'), formatted.display.evidence);
  assert.deepEqual([out.document.effective_date, out.document.data_cutoff, out.document.observation_period],
    [formatted.display.effective_date, formatted.display.data_cutoff, formatted.display.observation_period]);
  assert.equal(out.document.workflow, 'custom_appraisal'); assert.equal(out.document.origin, 'workflow_supplied');
  assert.deepEqual(out.document.fields, []); assert.deepEqual(out.document.pockets, []);
  assert.equal(out.document.boundary.outline, null); assert.equal(out.document.boundary.analysis_area.status, 'not_available');
  assert.equal(json(f), before, 'caller and shared normalized objects remain unchanged');
  assert.equal(out.prepared.review_blocked, true); assert.equal(intent(out.prepared, 'review-group'), null);
  assert.equal(intent(out.prepared, 'edit-area'), null);
});

test('mandatory notice, full common evidence and blocked mapping survive exactly', () => {
  const f = fixture(), { document, envelope } = good(f);
  assert.deepEqual(document.review_items.find(r => r.id === 'assessment-display:v1:context'), {
    id: 'assessment-display:v1:context', label: 'About this evidence', detail: expectedCustomDisplayNotice(f.assessment),
    blocks_review: false, evidence_keys: [],
  });
  assert.deepEqual(document.review_items.find(r => r.id === 'custom-inspection:v1:mapping'), {
    id: 'custom-inspection:v1:mapping', label: 'Report-field mapping unavailable',
    detail: 'Custom report-field mapping is not available. This inspection does not propose or apply report changes.',
    blocks_review: true, evidence_keys: [],
  });
  assert.equal(envelope.current.actions.open_review, false); assert.equal(envelope.current.actions.edit_area, false);
  assert.equal(envelope.current.actions.refresh, f.controller.current.actions.refresh);
  assert.ok(document.evidence.every(e => e.support === 'unknown'));
  assert.ok(document.evidence.some(e => e.key === 'population:shared'));
  assert.ok(document.evidence.some(e => e.key === 'statistic:shared'));
  assert.ok(document.evidence.some(e => e.key === 'source:shared'));
});

for (const incompleteGeography of [false, true]) test(`supplied geographic declarations and entire perimeter closure; incomplete=${incompleteGeography}`, () => {
  const f = fixture({ incompleteGeography }), { document } = good(f), geo = f.assessment.geographic_neighborhood;
  const evidence = document.evidence.find(e => e.key === 'geographic_neighborhood');
  assert.equal(evidence.label, 'Supplied neighborhood description'); assert.equal(evidence.support, 'unknown');
  const prefix = 'Producer-supplied geographic descriptor and application context: ';
  const suffix = ' Geometry, source authority and report eligibility are not established by this inspection.';
  assert.ok(evidence.detail.startsWith(prefix) && evidence.detail.endsWith(suffix));
  assert.deepEqual(JSON.parse(evidence.detail.slice(prefix.length, -suffix.length)), {
    status: geo.status, revision: geo.revision, crs: geo.crs, validation: geo.validation,
    reasons: geo.reasons, perimeter: geo.perimeter, application_group: f.assessment.application_group,
    discovery: { complete: f.assessment.discovery.complete },
  });
  const allRefs = [...new Set(['geographic_neighborhood', ...geo.perimeter.flatMap(e => e.source_refs.map(id => `source:${id}`))])].sort();
  for (const side of ['north', 'east', 'south', 'west']) {
    const row = document.boundary.cardinals[side]; assert.equal(row.text, geo.cardinal_summaries[side]);
    assert.equal(row.status, row.text === null ? 'not_available' : 'needs_review');
    assert.deepEqual([...row.evidence_keys].sort(), row.text === null ? [] : allRefs);
  }
  assert.ok(evidence.detail.length <= 5000); assert.equal(document.boundary.outline, null);
});

test('known omissions are retained verbatim in a bounded informational row', () => {
  const f = fixture({ mutateRaw: raw => { raw.diagnostics.omissions = ['missing "sales"', { reason: 'source unknown', count: 0 }]; } });
  const { document } = good(f);
  assert.deepEqual(document.review_items.find(r => r.id === 'custom-inspection:v1:omissions'), {
    id: 'custom-inspection:v1:omissions', label: 'Supplied omission notes',
    detail: `Producer-supplied diagnostic omissions: ${json(f.assessment.diagnostics.omissions)}. No omission has been resolved by this inspection.`,
    blocks_review: false, evidence_keys: [],
  });
});

test('zero, unknown, count units, years and sale/data coverage remain distinct', () => {
  const zero = good(fixture({ zeroSales: true })).document;
  assert.equal(metric(zero, 'sale-count').display_value, '0'); assert.equal(metric(zero, 'sale-count').unit, 'transactions');
  assert.equal(metric(zero, 'median-sale-price').display_value, null); assert.equal(metric(zero, 'median-sale-price').status, 'needs_review');
  assert.equal(metric(zero, 'predominant-sale-price').display_value, null); assert.equal(metric(zero, 'predominant-sale-price').status, 'not_available');
  assert.equal(metric(zero, 'zero-data-coverage').display_value, '0'); assert.equal(metric(zero, 'sale-coverage').display_value, '0');
  assert.equal(metric(zero, 'year-built').display_value, '2004'); assert.equal(metric(zero, 'year-built').unit, 'year');
  const positive = good().document;
  assert.equal(metric(positive, 'shared').unit, 'properties'); assert.equal(metric(positive, 'sale-coverage').display_value, '20');
  assert.equal(metric(positive, 'median-sale-price').display_value, '330000');
  assert.equal(metric(positive, 'price-low').display_value, '300000'); assert.equal(metric(positive, 'price-high').display_value, '390000');
  assert.deepEqual(positive.fields, []); assert.equal(positive.populations.find(p => p.role === 'geographic_stock').member_count, 6);
  assert.equal(positive.populations.find(p => p.role === 'competitive_stock').member_count, 10);
});

test('organization/public/assignment and optional reconstructed source semantics use the real formatter', () => {
  const f = fixture(), out = good(f), formatted = format(json(f.formatterInput)); assert.equal(formatted.status, 'formatted');
  for (const source of f.assessment.source_snapshots) assert.deepEqual(out.document.evidence.find(e => e.key === `source:${source.id}`),
    formatted.display.evidence.find(e => e.key === `source:${source.id}`));
  assert.notEqual(f.assessment.source_snapshots.find(s => s.id === 'organization:source').scope.account_id, f.assessment.scope.account_id);
  assert.ok(out.document.evidence.some(e => e.key === 'source:optional:late'));
  assert.ok(out.document.evidence.some(e => e.key === 'source:boundary:only'));
  const bad = copy(f); bad.assessment.source_snapshots.find(s => s.id === 'assignment:source').scope.account_id = 'FOREIGN';
  safeFailure(build(...strings(bad)), 'invalid_assessment');
});

test('access-none suppresses all retained content with no previous target display', () => {
  const controller = inactive('empty', 'none'), result = build(json(controller), null);
  assert.equal(result.status, 'ready'); const envelope = JSON.parse(result.envelopeJson);
  assert.equal(envelope.preview, null); assert.equal(prepare(result.envelopeJson).phase, 'unavailable');
  safeFailure(build(json(controller), 'this is deliberately not parsed JSON with a private marker'), 'invalid_input');
  safeFailure(build(json(controller), 'x'.repeat(1000000)), 'input_limit');
  assert.equal(resolve(json(controller), null, json({ type: 'refresh', target_key: 'old', operation_key: 'old' })), null);
});

for (const [load, phase] of [['empty', 'empty'], ['loading', 'loading'], ['failed', 'error']]) test(`noncomplete ${load} has no old preview`, () => {
  const controller = inactive(load), result = build(json(controller), null); assert.equal(result.status, 'ready');
  assert.equal(JSON.parse(result.envelopeJson).preview, null); assert.equal(prepare(result.envelopeJson).phase, phase);
  const wanted = { type: 'refresh', target_key: controller.current.target_key, operation_key: controller.current.operation_key };
  assert.deepEqual(resolve(json(controller), null, json(wanted)), load === 'loading' ? null : wanted);
  safeFailure(build(json(controller), 'null'), 'invalid_input');
  safeFailure(build(json(controller), json(fixture().assessment)), 'invalid_input');
});

for (const missing of ['expected', 'subject_label', 'assessment', 'target_key', 'operation_key', 'preview_key']) test(`completed load missing ${missing} cannot synthesize binding`, () => {
  const f = fixture();
  if (missing === 'assessment') safeFailure(build(json(f.controller), null), 'binding_unavailable');
  else { if (missing === 'expected' || missing === 'subject_label') f.controller[missing] = null; else f.controller.current[missing] = null;
    safeFailure(build(...strings(f)), 'binding_unavailable'); }
});

for (const key of ['target_key', 'operation_key', 'preview_key']) test(`request-start ${key} survives and mismatching latest value refuses`, () => {
  const f = fixture(), out = good(f); assert.equal(out.document[key], f.controller.expected.request_context[key]);
  const old = intent(out.prepared, 'inspect-evidence', 'source:fixture-source'); assert.ok(old);
  f.controller.current[key] += ':next'; safeFailure(build(...strings(f)), 'binding_mismatch'); assert.equal(latestResolve(f, old), null);
});

const bindings = [
  ['id', f => { f.controller.expected.assessment_reference.id = '40000000-0000-4000-8000-000000000002'; }],
  ['revision', f => { f.controller.expected.assessment_reference.revision++; }],
  ['digest', f => { f.controller.expected.assessment_reference.evidence_digest_sha256 = '0'.repeat(64); }],
  ...['organization_id', 'appraisal_case_id', 'subject_snapshot_id'].map(key => [key, f => { f.controller.expected.scope[key] = '90000000-0000-4000-8000-000000000009'; }]),
  ['account', f => { f.controller.expected.account_id = 'OTHER'; }],
  ['effective date', f => { f.controller.expected.effective_date = '2024-07-01'; }],
  ['data cutoff', f => { f.controller.expected.data_cutoff = '2024-06-29'; }],
  ['period start', f => { f.controller.expected.observation_period.start_date = '2023-08-01'; }],
  ['period end', f => { f.controller.expected.observation_period.end_date = '2024-06-29'; }],
  ['date basis', f => { f.controller.expected.observation_period.date_basis = 'contract_date'; }],
];
for (const [name, mutate] of bindings) test(`complete ${name} binding mismatch refuses`, () => { const f = fixture(); mutate(f); safeFailure(build(...strings(f)), 'binding_mismatch'); });

test('fresh A-B-A generations reject old intent; hidden epoch reuse cannot be discovered by this pure API', () => {
  const a = fixture(), first = good(a), old = intent(first.prepared, 'inspect-evidence', 'source:fixture-source');
  const next = copy(a); next.controller.current.operation_key = 'operation-3'; next.controller.current.preview_key = 'preview-3';
  Object.assign(next.controller.expected.request_context, { operation_key: 'operation-3', preview_key: 'preview-3' });
  good(next); assert.equal(latestResolve(next, old), null);
  assert.deepEqual(latestResolve(a, old), old, 'reusing all old host keys is the explicit hidden-epoch limitation');
});

test('primitive-only input rejects arbitrary objects without coercion or proxy traps', () => {
  let invoked = 0; const f = fixture();
  const objects = [{}, new String('{}'), Object.defineProperty({}, 'value', { get() { invoked++; return '{}'; } }),
    { toString() { invoked++; return json(f.controller); } }, new Proxy({}, { ownKeys() { invoked++; return []; }, get() { invoked++; return null; } })];
  for (const object of objects) { safeFailure(build(object, json(f.assessment)), 'invalid_input'); safeFailure(build(json(f.controller), object), 'invalid_input'); assert.equal(resolve(...strings(f), object), null); }
  assert.equal(invoked, 0); safeFailure(build(null, null), 'invalid_input');
});

for (const [name, change] of [
  ['whitespace', s => ' ' + s], ['duplicate key', s => s.replace('{', '{"custom_inspection_version":1,')],
  ['numeric exponent', s => s.replace('"assignment_file_id":73', '"assignment_file_id":7.3e1')],
  ['literal lone surrogate', s => s.replace('Synthetic subject', '\ud800')],
  ['escaped lone surrogate', s => s.replace('Synthetic subject', '\\ud800')],
]) test(`strict compact JSON rejects ${name}`, () => { const f = fixture(); safeFailure(build(change(json(f.controller)), json(f.assessment)), 'invalid_input'); });

for (const [name, change] of [
  ['extra root', c => { c.extra = true; }], ['extra current', c => { c.current.extra = true; }],
  ['extra expected', c => { c.expected.extra = true; }], ['extra request context', c => { c.expected.request_context.extra = true; }],
  ['string assignment ID', c => { c.expected.assignment_file_id = '73'; }], ['zero assignment ID', c => { c.expected.assignment_file_id = 0; }],
  ['string revision', c => { c.expected.assessment_reference.revision = '1'; }], ['uppercase UUID', c => { c.expected.scope.organization_id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'; }],
  ['trim-changing account', c => { c.expected.account_id += ' '; }],
]) test(`closed controller rejects ${name}`, () => { const f = fixture(); change(f.controller); safeFailure(build(...strings(f)), 'invalid_input'); });

test('unsupported controller version precedes private assessment parsing', () => {
  const f = fixture(); f.controller.custom_inspection_version = 2;
  safeFailure(build(json(f.controller), 'malformed private JSON'), 'unsupported_version');
});

for (const [name, change] of [
  ['missing required population', a => { a.required_population_ids.push('missing'); }],
  ['missing required statistic', a => { a.required_statistic_ids.push('missing'); }],
  ['missing group population', a => { a.application_group.population_refs.push({ id: 'missing', revision: '1', member_set_sha256: '0'.repeat(64) }); }],
  ['missing group source', a => { a.application_group.source_refs.push('missing'); }],
  ['missing perimeter source', a => { a.geographic_neighborhood.perimeter[0].source_refs.push('missing'); }],
  ['duplicate source declaration', a => { a.source_snapshots.push(copy(a.source_snapshots[0])); }],
]) test(`required complete closure rejects ${name}`, () => { const f = copy(fixture()); change(f.assessment); safeFailure(build(...strings(f)), 'invalid_references'); });

test('legitimate repeated references across independent required lists are unioned without dropping optional sources', () => {
  const f = fixture(), expected = customFormatterInput(f.assessment), out = good(f);
  assert.ok(expected.required_evidence_keys.includes('geographic_neighborhood'));
  for (const key of expected.required_evidence_keys) assert.ok(out.document.evidence.some(e => e.key === key));
  assert.equal(out.document.evidence.filter(e => e.kind === 'source').length, f.assessment.source_snapshots.length);
});

for (const type of ['review-group', 'edit-area', 'inspect-pocket', 'apply', 'select-field']) test(`inspection-only resolver refuses ${type}`, () => {
  const f = fixture(), k = f.controller.current; good(f);
  assert.equal(latestResolve(f, { type, target_key: k.target_key, operation_key: k.operation_key, preview_key: k.preview_key, item_key: 'shared' }), null);
});

for (const [name, mutate, permitted] of [
  ['clean', () => {}, true], ['dirty', f => { f.controller.current.dirty = true; }, false],
  ['read-only inspect', f => { f.controller.current.read_only = true; f.controller.current.access = 'inspect'; }, true],
  ['refresh flag false', f => { f.controller.current.actions.refresh = false; }, false],
]) test(`latest refresh guard: ${name}`, () => {
  const f = fixture(); mutate(f); const out = good(f), wanted = { type: 'refresh', target_key: f.controller.current.target_key, operation_key: f.controller.current.operation_key };
  assert.deepEqual(latestResolve(f, wanted), permitted ? wanted : null);
  assert.deepEqual(latestResolve(f, wanted), intent(out.prepared, 'refresh'));
  assert.equal(latestResolve(f, { ...wanted, preview_key: f.controller.current.preview_key }), null);
});

for (const key of ['population:shared', 'statistic:shared', 'source:shared', 'geographic_neighborhood']) test(`exact namespaced inspect intent ${key}`, () => {
  const f = fixture(), out = good(f), expected = intent(out.prepared, 'inspect-evidence', key); assert.ok(expected);
  assert.deepEqual(latestResolve(f, expected), expected);
  for (const field of ['target_key', 'operation_key', 'preview_key', 'item_key']) assert.equal(latestResolve(f, { ...expected, [field]: 'wrong' }), null);
  assert.equal(latestResolve(f, { ...expected, extra: true }), null);
  f.controller.current.dirty = true; f.controller.current.read_only = true; f.controller.current.spatial_review = 'required';
  assert.deepEqual(latestResolve(f, expected), expected, 'nonmutating inspection is still guarded by current exact identities');
});

test('resolver rebuilds complete latest evidence and refuses disappeared or unsupported source state', () => {
  const f = fixture(), out = good(f), incoming = intent(out.prepared, 'inspect-evidence', 'source:optional:late');
  const gone = copy(f); gone.assessment.source_snapshots = gone.assessment.source_snapshots.filter(s => s.id !== 'optional:late');
  assert.equal(latestResolve(gone, incoming), null);
  const unsupported = copy(f); unsupported.assessment.statistics[0].uncertainty = { status: 'estimated', interval: [1, 2] };
  safeFailure(build(...strings(unsupported)), 'unsupported_records'); assert.equal(latestResolve(unsupported, incoming), null);
  const unavailable = copy(f); unavailable.controller.expected = null; assert.equal(latestResolve(unavailable, incoming), null);
});

test('producer-normalized listings are explicitly unsupported rather than pruned', () => {
  const f = fixture({ mutateRaw: raw => {
    const listing = copy(raw.populations.find(p => p.kind === 'transactions'));
    Object.assign(listing, { id: 'listing-only', kind: 'listings', member_unit: 'listing', member_count: 3, unique_property_count: 3,
      members_resource_id: 'listings-resource', observation_period: { ...raw.observation_period, date_basis: 'status_as_of' } });
    raw.populations.push(listing);
  } });
  safeFailure(build(...strings(f)), 'unsupported_records');
});

test('legacy profiles and reduced candidates cannot become full core assessments', () => {
  const f = fixture();
  for (const wrong of [{ median_sale_price: 300000 }, { status: 'ready', suggestions: [], evidence: {} }, null]) {
    const result = build(json(f.controller), json(wrong)); safeFailure(result);
  }
});

test('retained explanation overflow refuses instead of truncating', () => {
  const f = fixture({ mutateRaw: raw => { raw.diagnostics.omissions = ['x'.repeat(5000)]; } });
  safeFailure(build(...strings(f)), 'display_capacity');
  const geography = fixture({ mutateRaw: raw => { raw.geographic_neighborhood.status = 'incomplete'; raw.geographic_neighborhood.reasons = Array.from({ length: 25 }, (_, i) => `reason-${i}-${'x'.repeat(180)}`); } });
  safeFailure(build(...strings(geography)), 'display_capacity');
});

test('whole-call UTF8 capacity includes tuple framing and later resolver intent', () => {
  const make = length => fixture({ mutateRaw: raw => { raw.diagnostics.transport_padding = 'x'.repeat(length); } });
  const base = make(0), length = 1000000 - combined(base).bytes, f = make(length);
  assert.equal(combined(f).bytes, 1000000); good(f);
  const wanted = { type: 'refresh', target_key: f.controller.current.target_key, operation_key: f.controller.current.operation_key };
  assert.equal(latestResolve(f, wanted), null, 'intent pushes exact build tuple over the same whole-call budget');
  const larger = make(length + 1); assert.equal(combined(larger).bytes, 1000001); safeFailure(build(...strings(larger)), 'input_limit');
  safeFailure(build('x'.repeat(16385), null), 'input_limit');
  assert.equal(resolve(...strings(fixture()), 'x'.repeat(8193)), null);
});

test('whole parsed node capacity includes retained unknown extensions', () => {
  const make = n => fixture({ mutateRaw: raw => { raw.diagnostics.node_padding = Array(n).fill(null); } });
  const n = 50000 - combined(make(0)).nodes, exact = make(n); assert.equal(combined(exact).nodes, 50000); good(exact);
  const over = make(n + 1); assert.equal(combined(over).nodes, 50001); safeFailure(build(...strings(over)), 'structure_limit');
});

test('whole parsed depth includes conceptual tuple root', () => {
  const make = n => fixture({ mutateRaw: raw => { let value = null; for (let i = 0; i < n; i++) value = { next: value }; raw.diagnostics.depth_padding = value; } });
  const exact = make(21); assert.equal(combined(exact).depth, 24); good(exact);
  const over = make(22); assert.equal(combined(over).depth, 25); safeFailure(build(...strings(over)), 'structure_limit');
});

test('all ingress reference occurrences count before eligible assessment semantics', () => {
  const make = n => fixture({ mutateRaw: raw => { raw.diagnostics.reference_padding = { required_evidence_keys: Array(n).fill('source:fixture-source') }; } });
  const n = 10000 - combined(make(0)).references, exact = make(n); assert.equal(combined(exact).references, 10000); good(exact);
  const over = make(n + 1); assert.equal(combined(over).references, 10001); safeFailure(build(...strings(over)), 'structure_limit');
  const earlierBad = copy(over); earlierBad.assessment.populations[0].kind = 'unsupported';
  safeFailure(build(...strings(earlierBad)), 'structure_limit');
});

function capacityFixture(quotes, tail = 0, count = 80) {
  return fixture({ mutateRaw: raw => {
    const stock = raw.populations.find(p => p.kind === 'competitive_stock');
    for (let i = 0; i < count; i++) raw.populations.push({ ...copy(stock), id: `capacity-stock-${String(i).padStart(2, '0')}`,
      members_resource_id: `capacity-resource-${i}`,
      definition: 'Supplied optional stock:' + '"'.repeat(quotes) + (i === count - 1 ? 'a'.repeat(tail) : '') });
  } });
}

test('actual formatter output capacity rejects an admitted normalized input atomically', t => {
  const f = capacityFixture(1950, 0, 97), bounds = combined(f), input = customFormatterInput(f.assessment);
  assert.ok(bounds.bytes < 1000000 && bounds.nodes < 50000 && bounds.references < 10000);
  assert.ok(B(json(input)) < 1000000);
  const formatted = format(json(input));
  assert.equal(formatted.status, 'unavailable'); assert.equal(formatted.reason, 'display_capacity');
  safeFailure(build(...strings(f)), 'display_capacity');
  t.diagnostic(json({ case: 'actual_formatter_capacity', input: bounds, formatterInputBytes: B(json(input)), reason: formatted.reason }));
});

test('complete escaped public wrapper admits exactly one megabyte and rejects one more byte', t => {
  const baseline = good(), geo = baseline.envelope.preview.evidence.find(e => e.kind === 'geographic_neighborhood');
  // This explicit test host substitutes only actual formatter-owned common
  // records into the unchanged baseline descriptor/context. Additional stocks
  // are optional, so the supplied application group and geographic facts remain
  // byte-identical. No adapter projection helper or mocked formatter is used.
  function projected(f) {
    const input = customFormatterInput(f.assessment), formatted = format(json(input));
    assert.equal(formatted.status, 'formatted', json(formatted));
    const envelope = copy(baseline.envelope);
    envelope.preview = { ...envelope.preview, ...copy(formatted.display), subject_label: f.controller.subject_label,
      evidence: [...copy(formatted.display.evidence), copy(geo)] };
    const envelopeJson = json(envelope), prepared = prepare(envelopeJson);
    assert.equal(prepared.phase, 'shown', json(prepared));
    const result = { status: 'ready', envelopeJson };
    return { wrapperBytes: B(result), envelopeBytes: B(envelopeJson), formattedBytes: B(formatted),
      formatterInputBytes: B(json(input)), preparedBytes: B(prepared), input: combined(f) };
  }
  let low = 0, high = 1200;
  assert.ok(projected(capacityFixture(low)).wrapperBytes < 1000000);
  assert.ok(projected(capacityFixture(high)).wrapperBytes > 1000000);
  while (low + 1 < high) { const middle = Math.floor((low + high) / 2);
    if (projected(capacityFixture(middle)).wrapperBytes <= 1000000) low = middle; else high = middle; }
  const quotes = low; low = 0; high = 2000 - 'Supplied optional stock:'.length - quotes;
  while (low < high) { const middle = Math.ceil((low + high) / 2);
    if (projected(capacityFixture(quotes, middle)).wrapperBytes <= 1000000) low = middle; else high = middle - 1; }
  const exact = capacityFixture(quotes, low), remaining = 1000000 - projected(exact).wrapperBytes;
  assert.ok(remaining >= 0 && remaining <= 2, 'only the sub-three-byte final scalar remainder remains');
  exact.controller.subject_label += 'x'.repeat(remaining);
  const measured = projected(exact); assert.equal(measured.wrapperBytes, 1000000);
  assert.ok(measured.input.bytes < 1000000 && measured.input.nodes < 50000 && measured.input.references < 10000);
  assert.ok(measured.formatterInputBytes < 1000000 && measured.formattedBytes < 1000000
    && measured.envelopeBytes < 1000000 && measured.preparedBytes < 1000000);
  const accepted = good(exact); assert.equal(B(accepted.result), 1000000);
  t.diagnostic(json({ case: 'escaped_wrapper_capacity', quotes, tail: low, subjectSuffix: remaining, ...measured }));
  const wanted = intent(accepted.prepared, 'inspect-evidence', 'source:fixture-source');
  assert.deepEqual(latestResolve(exact, wanted), wanted);
  exact.controller.subject_label += 'x'; assert.equal(projected(exact).wrapperBytes, 1000001);
  safeFailure(build(...strings(exact)), 'display_capacity'); assert.equal(latestResolve(exact, wanted), null);
});
