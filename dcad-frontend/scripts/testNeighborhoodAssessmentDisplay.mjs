import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { NEIGHBORHOOD_MEASUREMENTS } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { makeNeighborhoodAssessmentDisplayFixture as fixture, coreDisplayInput, uadDisplayInput,
  composeDisplayPreview, expectedDisplayNotice } from './fixtures/neighborhoodAssessmentDisplayFixture.mjs';

// Transpile only the new formatter and accepted display model, in memory. Real
// server builders are imported by the TEST fixture only. Production modules
// cannot import a server, provider or Node dependency through this harness.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const ts = createRequire(join(frontend, 'package.json'))('typescript');
function compiled(relative) {
  const result = ts.transpileModule(readFileSync(join(frontend, relative), 'utf8'), { fileName: relative,
    reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){\n${result.outputText}\n})`, { filename: relative })
    .runInThisContext()(name => { throw new Error(`Unexpected production runtime dependency: ${name}`); }, module, module.exports);
  return module.exports;
}
const { formatNeighborhoodAssessmentDisplay: format } = compiled('src/features/neighborhood/neighborhoodAssessmentDisplay.ts');
const { prepareNeighborhoodPreview: prepare, createNeighborhoodPreviewIntent: intent } = compiled('src/features/neighborhood/neighborhoodPreviewModel.ts');
const json = JSON.stringify;
const clone = value => structuredClone(value);
const baseline = () => fixture().input;
const read = input => format(json(input));
const good = input => { const out = read(input); assert.equal(out.status, 'formatted', json(out)); return out; };
function bad(input, reason) {
  const out = typeof input === 'string' ? format(input) : read(input);
  assert.equal(out.status, 'unavailable', json(out));
  if (reason) assert.equal(out.reason, reason);
  assert.deepEqual(Object.keys(out).sort(), ['display_version', 'reason', 'status']);
  assert.equal(out.display_version, 1); assert.ok(Buffer.byteLength(json(out)) < 1000); return out;
}
const metric = (out, id) => out.display.populations.flatMap(p => p.metrics).find(s => s.id === id);
const evidence = (out, key) => out.display.evidence.find(e => e.key === key);
function normalizedStatistic(changes = {}) {
  return { ...clone(baseline().statistics[0]), ...changes };
}
function oneStatistic(changes = {}) {
  const input = baseline(); input.statistics = [normalizedStatistic(changes)];
  input.required_evidence_keys = []; return input;
}
function nodeCount(value) { let count = 0; const stack = [value]; while (stack.length) {
  const v = stack.pop(); count++; if (v !== null && typeof v === 'object') stack.push(...Object.values(v));
} return count; }
function outputReferences(out) { return out.deferred_evidence_keys.length + out.display.populations.reduce((sum, p) =>
  sum + 1 + p.metrics.reduce((total, m) => total + 1 + m.evidence_keys.length, 0), 0); }
function inputReferences(input) { return input.required_evidence_keys.length + input.populations.reduce((n, p) =>
  n + p.source_refs.length + p.pocket_ids.length + 1, 0) + input.statistics.reduce((n, s) => n + s.source_refs.length + 1, 0); }
function allFrozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(allFrozen); } }
function reverseKeys(value) { if (Array.isArray(value)) return value.map(reverseKeys); if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])); }

test('actual normalized Custom records compose through the accepted preview model', () => {
  const { assessment, input } = fixture(); const out = good(input);
  assert.deepEqual(input.statistics[0].observation_period, assessment.populations.find(p => p.id === input.statistics[0].population_id).observation_period);
  assert.equal(out.provenance.assessment_reference.evidence_digest_sha256, assessment.evidence_digest_sha256);
  assert.equal(out.display.populations.length, assessment.populations.length);
  assert.equal(out.display.evidence.length, assessment.populations.length + assessment.statistics.length + assessment.source_snapshots.length);
  const shown = prepare(json(composeDisplayPreview(input, out))); assert.equal(shown.phase, 'shown', json(shown));
  assert.equal(shown.review_blocked, true); assert.equal(intent(shown, 'review-group'), null);
  assert.deepEqual(shown.document.fields, []); assert.equal(shown.document.boundary.outline, null);
  allFrozen(out); assert.notEqual(out.display.populations, input.populations);
});
for (const zeroSales of [false, true]) test(`actual UAD candidate subset composes, zeroSales=${zeroSales}`, () => {
  const { candidate, assessment, input } = fixture({ workflow: 'uad_3_6', zeroSales }); const out = good(input);
  assert.equal(input.assessment_reference.evidence_digest_sha256, assessment.evidence_digest_sha256);
  assert.notEqual(input.assessment_reference.evidence_digest_sha256, candidate.attachment.source_digest_sha256);
  assert.equal(metric(out, 'sale-count').display_value, zeroSales ? '0' : '3');
  assert.deepEqual(out.display.populations.flatMap(p => p.metrics).map(m => m.id).sort(), candidate.evidence.statistics.map(s => s.id).sort());
  if (zeroSales) { assert.equal(input.statistics.length, 1); assert.equal(metric(out, 'median-sale-price'), undefined); }
  const shown = prepare(json(composeDisplayPreview(input, out, { workflow: 'uad_3_6' })));
  assert.equal(shown.phase, 'shown'); assert.equal(shown.document.workflow, 'uad_3_6');
  assert.equal(shown.document.review_items[0].detail, expectedDisplayNotice(input));
});
test('UAD extraction checks both actual assessment digests rather than mapped source digest', () => {
  const { candidate } = fixture({ workflow: 'uad_3_6' });
  for (const path of ['assessment_digest_sha256', 'market_context']) {
    const c = clone(candidate); if (path === 'market_context') c.evidence.market_context.assessment_digest_sha256 = '0'.repeat(64);
    else c.evidence[path] = '0'.repeat(64); assert.throws(() => uadDisplayInput(c));
  }
});
test('full core and subset preserve common record meaning while notices remain distinct', () => {
  const { assessment, candidate } = fixture({ workflow: 'uad_3_6' });
  const full = good(coreDisplayInput(assessment)), subset = good(uadDisplayInput(candidate));
  assert.deepEqual(full.display, subset.display); assert.notEqual(full.display_notice.text, subset.display_notice.text);
  assert.equal(full.provenance.records_kind, 'all_core_records'); assert.equal(subset.provenance.records_kind, 'candidate_subset');
});
test('median never fills unsupported predominant value; raw years are not converted to age', () => {
  const { input } = fixture({ mutateRaw: raw => raw.statistics.push({ ...raw.statistics[0], id: 'built-year',
    population_id: 'stock-a', measurement: 'year_built', unit: 'year', value: 2004, observed_count: 4, denominator_count: 4 }) });
  const out = good(input); assert.equal(metric(out, 'median-sale-price').display_value, '330000');
  assert.equal(metric(out, 'predominant-sale-price').display_value, null);
  assert.equal(metric(out, 'predominant-sale-price').status, 'not_available');
  assert.equal(metric(out, 'built-year').display_value, '2004'); assert.equal(metric(out, 'built-year').unit, 'year');
});
test('canonical transactions retain distinct property links and unique properties', () => {
  const { input } = fixture({ mutateRaw: raw => Object.assign(raw.populations.find(p => p.id === 'sales-a'),
    { member_count: 3, property_link_count: 6, unique_property_count: 5 }) });
  const out = good(input), p = out.display.populations.find(p => p.id === 'sales-a');
  assert.equal(p.member_count, 3); assert.equal(p.unique_property_count, 5);
  assert.ok(`${p.coverage_text} ${evidence(out, 'population:sales-a').detail}`.includes('6'));
  assert.equal(p.role, 'sales_sample');
});
test('geographic six, competitive ten and seven sale events are never pooled', () => {
  const { input } = fixture({ mutateRaw: raw => {
    const stock = raw.populations.find(p => p.id === 'stock-a');
    Object.assign(stock, { member_count: 10, unique_property_count: 10, property_link_count: 10 });
    raw.populations.push({ ...stock, id: 'geographic-six', kind: 'geographic_stock', definition: 'Six synthetic properties inside the descriptive region',
      member_count: 6, unique_property_count: 6, property_link_count: 6 });
    Object.assign(raw.populations.find(p => p.id === 'sales-a'), { member_count: 7, unique_property_count: 5, property_link_count: 8 });
    raw.statistics.forEach(s => Object.assign(s, { observed_count: 7, denominator_count: 7 }));
  } });
  const out = good(input);
  assert.deepEqual(out.display.populations.map(p => [p.role, p.member_count, p.unique_property_count]),
    [['geographic_stock', 6, 6], ['sales_sample', 7, 5], ['competitive_stock', 10, 10]]);
  assert.equal(metric(out, 'median-sale-price').display_value, '330000');
});
test('nullable incomplete population counts are retained, not replaced with zero', () => {
  const x = baseline(); x.statistics = []; x.required_evidence_keys = [];
  Object.assign(x.populations[0], { member_count: null, unique_property_count: null, property_link_count: null,
    member_set_sha256: null, completeness: 'incomplete', reasons: ['retained_stock_unknown'] });
  const p = good(x).display.populations.find(p => p.id === x.populations[0].id);
  assert.equal(p.member_count, null); assert.equal(p.unique_property_count, null); assert.ok(p.coverage_text.includes('retained_stock_unknown'));
});
test('late reconstructed observation is retained without a retrieval-cutoff authority heuristic', () => {
  const x = baseline(); assert.ok(x.source_snapshots[0].observed_at.slice(0, 10) > x.data_cutoff);
  const out = good(x); for (const e of out.display.evidence) assert.equal(e.support, 'unknown');
  const detail = evidence(out, 'source:fixture-source').detail;
  assert.ok(detail.includes('reconstructed')); assert.ok(detail.includes(x.source_snapshots[0].observed_at));
  assert.equal(out.provenance.source_authority, 'not_established'); assert.equal(out.provenance.report_eligibility, 'not_assessed');
});
for (const visibility of ['public', 'organization', 'assignment']) test(`source visibility ${visibility} follows exact scope rules`, () => {
  const x = baseline(), s = x.source_snapshots[0]; s.visibility = visibility;
  s.scope = visibility === 'public' ? null : clone(x.scope);
  if (visibility === 'organization') s.scope.appraisal_case_id = '20000000-0000-4000-8000-000000000099';
  good(x);
  if (s.scope) { s.scope.organization_id = '10000000-0000-4000-8000-000000000099'; bad(x); }
  else { s.scope = clone(x.scope); bad(x); }
});
test('assignment evidence cannot cross subjects within the same organization', () => {
  const x = baseline(); Object.assign(x.source_snapshots[0], { visibility: 'assignment', scope: { ...x.scope, account_id: 'ANOTHER-SYNTHETIC-ACCOUNT' } }); bad(x);
});
for (const mutate of [x => x.data_cutoff = '2024-06-29', x => x.effective_date = '2024-02-30',
  x => x.populations[0].observation_period.date_basis = 'contract_date',
  x => x.statistics[0].observation_period.end_date = '2024-06-29',
  x => x.source_snapshots[0].valid_to = '2000-01-01']) test(`rejects inconsistent date relation ${mutate}`, () => { const x = baseline(); mutate(x); bad(x); });

for (const [measurement, spec] of Object.entries(NEIGHBORHOOD_MEASUREMENTS)) test(`actual core vocabulary: ${measurement}`, () => {
  if (measurement === 'listing_count') {
    const x = baseline(); x.statistics = []; x.required_evidence_keys = [];
    Object.assign(x.populations[0], { kind: 'listings', member_unit: 'listing' }); return bad(x, 'unsupported_population');
  }
  const x = oneStatistic({ measurement, unit: spec.unit, estimator: 'unsupported', estimator_parameters: {}, value: null,
    status: 'unsupported', reason: 'explicitly_unsupported', assessment_tax_year: measurement.startsWith('assessed_') ? 2024 : null });
  if (measurement === 'allocated_property_sale_count' || measurement === 'allocated_sale_price') x.populations.find(p => p.id === 'sales-a').member_unit = 'allocated_property_sale';
  if (measurement === 'property_count') Object.assign(x.statistics[0], { population_id: 'stock-a', observed_count: 4, denominator_count: 4, observation_period: clone(x.populations.find(p => p.id === 'stock-a').observation_period) });
  if (measurement === 'unique_property_count') Object.assign(x.statistics[0], { denominator_basis: 'unique_properties', observed_count: 2, denominator_count: 2 });
  const out = good(x); assert.equal(metric(out, x.statistics[0].id).unit, spec.unit);
  assert.equal(metric(out, x.statistics[0].id).display_value, null);
});
for (const estimator of ['exact_median', 'arithmetic_mean', 'exact_quantile']) test(`supported estimator ${estimator} retains exact finite decimal`, () => {
  const x = oneStatistic({ estimator, estimator_parameters: estimator === 'exact_quantile' ? { convention: 'type_7', probability: 0.25 } : {}, value: 1.0000000000000002 });
  assert.equal(metric(good(x), 'median-sale-price').display_value, '1.0000000000000002');
});
test('modal interval keeps half-open bounds and supplied value together', () => {
  const x = oneStatistic({ measurement: 'predominant_sale_price', estimator: 'modal_interval',
    estimator_parameters: { method: 'fixed_width_histogram', lower_bound: 300000, upper_bound: 350000, bin_width: 50000 }, value: 320000 });
  assert.equal(metric(good(x), 'median-sale-price').display_value, '[300000, 350000); supplied value 320000');
  x.statistics[0].value = 350000; bad(x); x.statistics[0].value = 320000; x.statistics[0].estimator_parameters.bin_width = 40000; bad(x);
});
test('valid core uncertainty extensions are explicitly unsupported rather than discarded', () => {
  const { input } = fixture({ mutateRaw: raw => raw.statistics[0].uncertainty = { status: 'not_estimated', extra: 'core permits this metadata' } });
  bad(input, 'unsupported_metadata');
});
test('nonready supported-estimator provisional value remains visible as needs_review', () => {
  const x = oneStatistic({ value: 12.5, status: 'incomplete', reason: 'partial_observation' });
  const m = metric(good(x), 'median-sale-price'); assert.equal(m.display_value, '12.5'); assert.equal(m.status, 'needs_review');
});
test('ratio percentage retains original supplied rounding and data numerator is observed', () => {
  const x = oneStatistic({ measurement: 'data_coverage_percent', unit: 'percent', estimator: 'ratio',
    estimator_parameters: { numerator_count: 1 }, value: 100 / 3, observed_count: 1, missing_count: 2 });
  assert.equal(metric(good(x), 'median-sale-price').display_value, String(100 / 3));
  x.statistics[0].value = 100; bad(x); x.statistics[0].estimator_parameters.numerator_count = 3; bad(x);
});
test('known zero data coverage differs from empty undefined zero-over-zero', () => {
  const x = oneStatistic({ measurement: 'data_coverage_percent', unit: 'percent', estimator: 'ratio',
    estimator_parameters: { numerator_count: 0 }, value: 0, observed_count: 0, missing_count: 3 });
  assert.equal(metric(good(x), 'median-sale-price').display_value, '0');
  Object.assign(x.populations.find(p => p.id === 'sales-a'), { member_count: 0, unique_property_count: 0, property_link_count: 0 });
  Object.assign(x.statistics[0], { denominator_count: 0, missing_count: 0 }); bad(x);
  Object.assign(x.statistics[0], { value: null, status: 'incomplete', reason: 'undefined_denominator' });
  assert.equal(metric(good(x), 'median-sale-price').display_value, null);
});
test('sale coverage numerator is a sold subset, not the observation count', () => {
  const x = oneStatistic({ measurement: 'sale_coverage_percent', unit: 'percent', estimator: 'ratio', estimator_parameters: { numerator_count: 1 }, value: 100 / 3 });
  assert.equal(metric(good(x), 'median-sale-price').display_value, String(100 / 3));
  Object.assign(x.statistics[0], { value: 0, estimator_parameters: { numerator_count: 0 } }); good(x);
  Object.assign(x.statistics[0], { observed_count: 0, missing_count: 3 }); bad(x);
});
for (const changes of [{ observed_count: 4 }, { missing_count: 1 }, { denominator_count: 4 },
  { value: -1 }, { status: 'unsupported', value: 1 }, { assessment_tax_year: 2025 }, { estimator_parameters: { ignored: true } }])
  test(`invalid statistic is not silently repaired: ${json(changes)}`, () => bad(oneStatistic(changes)));

test('namespaced IDs containing colons remain exact and all optional records survive', () => {
  const x = baseline(), source = x.source_snapshots[0]; source.id = 'same:opaque';
  for (const p of x.populations) p.source_refs = [source.id]; for (const s of x.statistics) s.source_refs = [source.id];
  const old = x.populations[0].id; x.populations[0].id = source.id;
  for (const s of x.statistics) if (s.population_id === old) s.population_id = source.id;
  x.statistics[0].id = source.id; x.required_evidence_keys = ['source:same:opaque', 'population:same:opaque', 'statistic:same:opaque'];
  x.source_snapshots.push({ ...source, id: 'unused-source' }); const out = good(x);
  for (const key of x.required_evidence_keys) assert.ok(evidence(out, key));
  assert.ok(evidence(out, 'source:unused-source'));
  assert.deepEqual(metric(out, 'same:opaque').evidence_keys, ['statistic:same:opaque', 'population:same:opaque', 'source:same:opaque']);
});
for (const mutate of [x => x.source_snapshots.push(clone(x.source_snapshots[0])), x => x.populations.push(clone(x.populations[0])),
  x => x.statistics.push(clone(x.statistics[0])), x => x.statistics[1].source_refs = ['missing-optional'],
  x => x.statistics[1].population_id = 'missing-population', x => x.populations[0].source_refs.push('fixture-source'),
  x => x.required_evidence_keys.push(x.required_evidence_keys[0]), x => x.required_evidence_keys = ['fixture-source'],
  x => x.required_evidence_keys = ['source:missing']]) test(`reference closure ${mutate}`, () => { const x = baseline(); mutate(x); bad(x, 'invalid_references'); });
test('set and object ordering cannot change the complete emitted fragment', () => {
  const x = baseline(); x.source_snapshots.push({ ...x.source_snapshots[0], id: 'Z-source' }, { ...x.source_snapshots[0], id: 'é-source' });
  x.statistics[0].source_refs = x.source_snapshots.map(s => s.id); x.populations[0].pocket_ids = ['z', 'é', 'a'];
  const expected = good(x); const y = reverseKeys(x);
  for (const key of ['populations', 'statistics', 'source_snapshots', 'required_evidence_keys']) y[key].reverse();
  y.statistics.forEach(s => s.source_refs.reverse()); y.populations.forEach(p => { p.source_refs.reverse(); p.pocket_ids.reverse(); p.reasons.reverse(); });
  assert.equal(json(good(y)), json(expected));
});
test('all generated evidence references resolve and deferred geometry remains explicit', () => {
  const x = baseline(); x.required_evidence_keys.push('analysis_geography'); const out = good(x);
  assert.deepEqual(out.deferred_evidence_keys, ['analysis_geography', 'geographic_neighborhood']);
  const keys = new Set(out.display.evidence.map(e => e.key));
  for (const p of out.display.populations) { assert.ok(keys.has(p.evidence_key)); for (const m of p.metrics) {
    assert.equal(m.population_id, p.id); m.evidence_keys.forEach(k => assert.ok(keys.has(k), k));
  } }
  const envelope = composeDisplayPreview(x, out); assert.equal(prepare(json(envelope)).phase, 'shown');
  envelope.preview.evidence.pop(); assert.equal(prepare(json(envelope)).phase, 'shown', 'unused deferred descriptors are optional to preview itself');
  // The formatter still declares BOTH dependencies for the owner; dropping an
  // unused placeholder does not mean the shared guard certifies composition.
  assert.equal(out.deferred_evidence_keys.length, 2);
});
test('trusted composition checks provenance and notice that shared preview cannot reconstruct', () => {
  const x = baseline(), out = good(x); const altered = clone(out); altered.provenance.assessment_reference.revision++;
  assert.throws(() => composeDisplayPreview(x, altered)); const env = composeDisplayPreview(x, out);
  env.preview.review_items[0].detail = 'Host replaced the source caveat'; assert.equal(prepare(json(env)).phase, 'shown');
  const badNotice = clone(out); badNotice.display_notice.text = 'Host replaced the source caveat'; assert.throws(() => composeDisplayPreview(x, badNotice));
});
for (const input of [null, 1, {}, [], new String('{}')]) test(`nonprimitive input ${typeof input} rejected without coercion`, () => {
  assert.equal(format(input).status, 'unavailable');
});
test('proxy/object getters and toJSON are never invoked', () => {
  let calls = 0; const value = new Proxy({}, { get() { calls++; throw new Error('secret'); }, ownKeys() { calls++; throw new Error('secret'); }, getPrototypeOf() { calls++; throw new Error('secret'); } });
  assert.equal(format(value).status, 'unavailable'); assert.equal(calls, 0);
});
for (const suffix of ['\n', ' ']) test('noncompact JSON is rejected ' + json(suffix), () => bad(json(baseline()) + suffix, 'invalid_input'));
test('duplicate object keys and alternate numeric forms are rejected', () => {
  const raw = json(baseline()); bad(raw.replace('"display_input_version":1', '"display_input_version":1,"display_input_version":1'), 'invalid_input');
  bad(raw.replace('"revision":1', '"revision":1.0'), 'invalid_input');
  bad(json(oneStatistic({ value: 0 })).replace('"value":0', '"value":-0'), 'invalid_input');
});
for (const value of ['\ud800', '\udc00', 'bad\u0000text', 'bad\u007ftext', ' padded ']) test('invalid core text is rejected ' + json(value), () => {
  const x = baseline(); x.source_snapshots[0].provider = value; bad(x);
});
test('well-formed Unicode and full 200-unit source names are retained without locale mutation', () => {
  const x = baseline(); const provider = '提供元'.repeat(66) + 'éé'; assert.equal(provider.length, 200);
  x.source_snapshots[0].provider = provider; x.populations[0].definition = 'Café 河岸 🏠';
  const out = good(x); assert.ok(evidence(out, 'source:fixture-source').detail.includes(provider));
  assert.equal(out.display.populations.find(p => p.id === x.populations[0].id).definition, 'Café 河岸 🏠');
});
test('primitive transport exact UTF8 budget includes multibyte data', () => {
  const x = { padding: '' }; const fixed = Buffer.byteLength(json(x)); x.padding = 'é'.repeat(Math.floor((1_000_000 - fixed) / 2));
  if (Buffer.byteLength(json(x)) < 1_000_000) x.padding += 'x';
  assert.equal(Buffer.byteLength(json(x)), 1_000_000); bad(x, 'invalid_input'); x.padding += 'x'; bad(x, 'input_limit');
});
test('depth and whole-node limits run before semantic failure', () => {
  const nested = depth => { let x = null; for (let i = 0; i < depth; i++) x = [x]; return x; };
  bad(json(nested(24)), 'invalid_input'); bad(json(nested(25)), 'structure_limit');
  const x = Array(49_999).fill(null); assert.equal(nodeCount(x), 50_000); bad(json(x), 'invalid_input');
  x.push(null); bad(json(x), 'structure_limit');
});
test('combined evidence cap counts deferred descriptors', () => {
  const x = baseline(); x.populations = []; x.statistics = []; x.required_evidence_keys = [];
  const s = x.source_snapshots[0]; x.source_snapshots = Array.from({ length: 1000 }, (_, i) => ({ ...s, id: `s${i}` }));
  const out = good(x); assert.equal(out.display.evidence.length, 1000);
  x.required_evidence_keys = ['geographic_neighborhood']; bad(x, 'structure_limit');
});
test('per-record text overflow is atomic rather than truncated', () => {
  const x = baseline(); x.statistics = []; x.required_evidence_keys = [];
  Object.assign(x.populations[0], { completeness: 'incomplete', reasons: Array.from({ length: 30 }, (_, i) => `${i}:` + 'r'.repeat(195)) });
  bad(x, 'display_capacity');
});
function referenceCapacity(extraLastReference = false) {
  const x = baseline(); x.required_evidence_keys = []; x.populations = [x.populations.find(p => p.id === 'sales-a')];
  x.source_snapshots = Array.from({ length: 22 }, (_, i) => ({ ...x.source_snapshots[0], id: `s${i}` }));
  x.populations[0].source_refs = ['s0'];
  x.statistics = Array.from({ length: 400 }, (_, i) => ({ ...x.statistics[0], id: `m${i}`, source_refs: x.source_snapshots.map(s => s.id) }));
  if (!extraLastReference) x.statistics.at(-1).source_refs.pop(); return x;
}
test('generated reference budget admits 10000 and rejects 10001 without dropping a source', () => {
  const x = referenceCapacity(); assert.ok(inputReferences(x) < 10000); const out = good(x);
  assert.equal(outputReferences(out), 10000); assert.equal(out.display.populations[0].metrics.length, 400);
  bad(referenceCapacity(true), 'display_capacity');
});
test('input references are fully charged even where malformed metadata would fail earlier', () => {
  const x = baseline(); x.statistics[0].estimator_parameters = { unsupported: true };
  x.populations[0].pocket_ids = Array(5000).fill('same'); x.populations[1].pocket_ids = Array(5000).fill('same');
  assert.ok(inputReferences(x) > 10000); bad(x, 'structure_limit');
});
test('10000 legitimate input references fit and the next occurrence is rejected', () => {
  const x = baseline(); x.statistics = [];
  const template = x.source_snapshots[0];
  x.source_snapshots = Array.from({ length: 900 }, (_, i) => ({ ...template, id: `s${i}` }));
  const stock = x.populations.find(p => p.id === 'stock-a');
  x.populations = Array.from({ length: 100 }, (_, i) => ({ ...stock, id: `p${i}`, pocket_ids: [],
    source_refs: x.source_snapshots.slice(0, 90).map(s => s.id) }));
  x.required_evidence_keys = x.source_snapshots.map(s => `source:${s.id}`);
  assert.equal(inputReferences(x), 10000); const out = good(x);
  assert.equal(out.display.populations.length, 100); assert.equal(out.display.evidence.length, 1000);
  x.required_evidence_keys.push('population:p0'); assert.equal(inputReferences(x), 10001); bad(x, 'structure_limit');
});
test('whole formatter capacity fails before composing oversized host output; no partial fragment', () => {
  // Each statistic has an individually legal 1900-unit uncertainty reason;
  // expansion into labels, metrics and evidence eventually fills the output.
  let last = null, failed = null;
  for (let n = 100; n <= 430; n += 10) {
    const x = baseline(); x.required_evidence_keys = []; x.statistics = Array.from({ length: n }, (_, i) => ({
      ...x.statistics[0], id: `bulk-${i}`, uncertainty: { status: 'not_estimated', reason: 'é'.repeat(900) } }));
    if (Buffer.byteLength(json(x)) > 1_000_000) break;
    const out = read(x);
    if (out.status === 'formatted') { assert.ok(Buffer.byteLength(json(out)) <= 1_000_000); last = out; }
    else { assert.equal(out.reason, 'display_capacity'); failed = out; break; }
  }
  assert.ok(last, 'a valid nontrivial fragment fits'); assert.ok(failed, 'actual metadata expansion reaches the output cap within input cap');
  assert.deepEqual(Object.keys(failed).sort(), ['display_version', 'reason', 'status']);
});
test('exact complete output byte boundary counts provenance, notice and every display record', () => {
  const make = length => {
    const x = baseline(); x.required_evidence_keys = [];
    x.statistics = Array.from({ length: 400 }, (_, i) => ({ ...x.statistics[0], id: `exact-${i}`,
      uncertainty: { status: 'not_estimated', reason: 'x'.repeat(length) } })); return x;
  };
  let low = 1, high = 2000;
  assert.equal(read(make(low)).status, 'formatted');
  assert.equal(read(make(high)).status, 'unavailable');
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2), out = read(make(middle));
    if (out.status === 'formatted') low = middle;
    else { assert.ok(['display_capacity', 'input_limit'].includes(out.reason)); high = middle; }
  }
  assert.equal(read(make(high)).reason, 'display_capacity', 'the nearest actual boundary is generated output, not input');
  const x = make(low), before = good(x);
  let gap = 1_000_000 - Buffer.byteLength(json(before));
  assert.ok(gap >= 0 && gap < 400, 'one extra ASCII character per record spans the remaining gap');
  // An ASCII uncertainty-reason character is preserved once in evidence detail.
  // Distribute the residual across legal records, never supply an expected size
  // to the formatter or assume the provenance/notice costs zero bytes.
  for (const s of x.statistics) { const add = Math.min(gap, 2000 - s.uncertainty.reason.length);
    s.uncertainty.reason += 'x'.repeat(add); gap -= add; if (!gap) break; }
  assert.equal(gap, 0); const exact = good(x);
  assert.equal(Buffer.byteLength(json(exact)), 1_000_000);
  assert.ok(Buffer.byteLength(json(x)) < 1_000_000); assert.ok(nodeCount(exact) < 50_000);
  const composed = composeDisplayPreview(x, exact);
  assert.ok(Buffer.byteLength(json(composed)) > 1_000_000, 'actual host context and mandatory notice expansion exceed the remaining complete-preview capacity');
  const previewFailure = prepare(json(composed)); assert.equal(previewFailure.phase, 'unavailable'); assert.equal(previewFailure.reason, 'input_limit');
  x.statistics.find(s => s.uncertainty.reason.length < 2000).uncertainty.reason += 'x';
  assert.ok(Buffer.byteLength(json(x)) < 1_000_000); bad(x, 'display_capacity');
});
test('owner composition has independent complete-preview limits and notice costs a review row', () => {
  const x = baseline(), out = good(x), env = composeDisplayPreview(x, out);
  env.preview.review_items.push(...Array.from({ length: 255 }, (_, i) => ({ id: `owner-${i}`, label: 'Owner supplied review', detail: 'Synthetic notice', blocks_review: false, evidence_keys: [] })));
  assert.equal(prepare(json(env)).phase, 'shown'); env.preview.review_items.push({ ...env.preview.review_items[1], id: 'one-more' });
  const failure = prepare(json(env)); assert.equal(failure.phase, 'unavailable'); assert.equal(failure.reason, 'structure_limit');
});
