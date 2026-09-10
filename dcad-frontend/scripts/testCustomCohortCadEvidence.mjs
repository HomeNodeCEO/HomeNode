import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import * as cadHelpers from '../src/features/neighborhood/customCohortCadEvidence.ts';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as controller from '../src/features/neighborhood/customCohortPreviewController.ts';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from '../../server/test/fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from '../../server/test/fixtures/customCohortSaleWitnessMeaningFixture.js';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortCadEvidence } from '../../server/src/services/neighborhoodAssessment/customCohortCadEvidencePresentation.js';
import { CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS } from '../../server/src/services/neighborhoodAssessment/customCohortCurrentCadBaseline.js';

const base = cadEvidenceFixture(), clone = value => structuredClone(value);
const check = cadHelpers.checkCustomCohortCadEvidence;
async function fixture(source = base) {
  const f = await source, context = f.input.expected.context_ref, revision = f.input.selection.revision;
  const expected = { context_ref: context, selection_revision: revision };
  const preview = f.preview ?? buildCustomCohortObservationPreview({ context_ref: context, retained_inputs: f.input.retained_inputs,
    selection: { revision, pockets: [] } });
  const rawCatalog = f.catalog ?? buildCustomCohortPocketCatalog({ retained_inputs: f.input.retained_inputs, preview });
  const catalog = presentCustomCohortPocketCatalog({ catalog: rawCatalog, preview, expected });
  const kernel = buildCustomCohortPocketRecommendation({ context_ref: context, retained_inputs: f.input.retained_inputs,
    selection: { revision, included_recorded_group_ids: [] } });
  const recommendation = presentCustomCohortPocketRecommendation({ expected, catalog, recommendation: kernel });
  const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    contextRef: context, selection: { revision, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: context, selection_revision: revision, subject_freshness: 'matched', catalog, recommendation, apply: { status: 'blocked' } };
  const checked = catalogHelpers.checkCustomCohortPocketCatalog(response, input);
  return { input, response, checked, kernel, cad: recommendation.cad_recorded_evidence };
}
const populations = cad => [cad.all, ...cad.pockets];
function omitDistributions(cad, reason = 'presentation_byte_limit') {
  for (const p of populations(cad)) for (const field of Object.values(p.fields)) {
    Object.assign(field.distribution, { status: 'details_unavailable', reason, entries: null });
  }
}

test('actual mapping4 capture -> recommendation presenter -> browser admission keeps bounded current CAD evidence and unchanged scores', async () => {
  const { checked, response, cad } = await fixture(), result = checked.recommendation;
  assert.equal(cad.status, 'available');
  assert.equal(result.cad_recorded_evidence.subject.fields.built_up.literal, false);
  assert.equal(result.cad_recorded_evidence.subject.fields.class_code.literal, '  A1 ');
  assert.deepEqual(cadHelpers.CUSTOM_CAD_FIELD_LABELS, CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS);
  const without = clone(response); delete without.recommendation.cad_recorded_evidence;
  const { cad_recorded_evidence, ...rest } = result;
  assert.deepEqual(rest, catalogHelpers.checkCustomCohortPocketCatalog(without, (await fixture()).input).recommendation);
  assert.ok(Object.isFrozen(cad_recorded_evidence.pockets[0].fields.class_code.distribution.entries));
  assert.equal(result.all.factor_coverage.housing_type.observed_count, 0);
  assert.equal(result.all.factor_coverage.housing_type.unknown_count, cad.all.member_count);
  for (const forbidden of ['raw_projection', 'retained_inputs', 'account_ids', 'source_ref']) {
    assert.ok(!JSON.stringify(cad_recorded_evidence).includes(`"${forbidden}"`), forbidden);
  }
});

for (const [version, make] of [[2, decisionEvidenceFixture], [3, saleWitnessMeaningFixture]]) {
  test(`actual mapping${version} payload stays byte-shaped without a CAD addon`, async () => {
    const { response, checked } = await fixture(make());
    assert.equal(Object.hasOwn(response.recommendation, 'cad_recorded_evidence'), false);
    assert.equal(Object.hasOwn(checked.recommendation, 'cad_recorded_evidence'), false);
  });
}

test('actual presenter complete-list omission and whole-addon omission remain explicitly unavailable, not missing records', async () => {
  const { kernel, cad, checked } = await fixture();
  const options = { evidence: kernel.cad_recorded_evidence,
    expected: cad.binding, pockets: cad.pockets.map(p => ({ id: p.id, member_count: p.member_count })),
    member_count: cad.all.member_count, in_discovery: cad.subject.in_discovery };
  const omitted = clone(cad); omitDistributions(omitted);
  const partial = presentCustomCohortCadEvidence({ ...options, maximumBytes: Buffer.byteLength(JSON.stringify(omitted)) });
  assert.equal(partial.status, 'available');
  assert.equal(check(partial, checked).all.fields.class_code.distribution.entries, null);
  const unavailable = presentCustomCohortCadEvidence({ ...options, maximumBytes: 1200 });
  assert.equal(unavailable.status, 'details_unavailable');
  assert.equal(check(unavailable, checked).member_count, checked.coverage.discovery_member_count);
  assert.equal(Object.hasOwn(check(unavailable, checked), 'all'), false);
  assert.throws(() => check({ ...unavailable, member_count: 0 }, checked));
});

for (const stamp of ['2026-09-06T08:00:00Z', '2026-09-06T08:00:00.1Z', '2026-09-06T08:00:00.123456789Z']) {
  test(`capture timestamp is preserved exactly: ${stamp}`, async () => {
    const { cad, checked } = await fixture(), changed = clone(cad); changed.binding.captured_at = stamp;
    assert.equal(check(changed, checked).binding.captured_at, stamp);
  });
}

for (const [label, mutate] of [
  ['null', () => null], ['extra field', v => { v.verified_housing = true; }],
  ['unsupported version', v => { v.mapping_version = 3; }], ['authority', v => { v.authority = 'verified'; }],
  ['foreign context', v => { v.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['impossible date', v => { v.binding.captured_at = '2026-02-30T00:00:00Z'; }],
  ['non-UTC date', v => { v.binding.captured_at = '2026-09-06T08:00:00+00:00'; }],
  ['unrecognized state', v => { v.subject.fields.class_code.state = 'verified'; }],
  ['absent subject', v => { v.subject.in_discovery = false; }],
  ['missing subject with value', v => { v.subject.fields.class_code.state = 'missing'; }],
  ['blank observed subject', v => { v.subject.fields.class_code.literal = ' '; }],
  ['numeric built-up', v => { v.subject.fields.built_up.literal = 0; }],
  ['string built-up', v => { v.subject.fields.built_up.literal = 'false'; }],
  ['boolean class code', v => { v.subject.fields.class_code.literal = false; }],
  ['malformed Unicode', v => { v.subject.fields.class_code.literal = '\ud800'; }],
  ['NUL literal', v => { v.subject.fields.class_code.literal = 'a\0b'; }],
  ['UTF8 literal overflow', v => { v.subject.fields.class_code.literal = 'é'.repeat(2049); }],
  ['foreign label', v => { v.all.fields.class_code.label = 'Verified detached houses'; }],
  ['dropped pocket', v => { v.pockets.pop(); }], ['duplicate pocket', v => { v.pockets[1] = clone(v.pockets[0]); }],
  ['foreign pocket', v => { v.pockets[0].id = `recorded-cad:${'f'.repeat(64)}`; }],
  ['wrong member total', v => { v.all.member_count++; }], ['wrong pocket count', v => { v.pockets[0].member_count++; }],
  ['nonfinite count', v => { v.all.fields.class_code.observed_count = Infinity; }],
  ['missing record total', v => { v.all.fields.class_code.record_count++; }],
  ['partial with no missing row', v => { const f = v.all.fields.class_code; f.partial_count = 1; f.observed_count--; }],
  ['conflict with no second value row', v => { const f = v.all.fields.class_code; f.conflicting_count = 1; f.observed_count--; }],
  ['counted comparison for partial subject', v => { v.subject.fields.class_code.state = 'partial'; }],
  ['counted comparison for partial county', v => { v.subject.county_state = 'partial'; }],
  ['wrong all comparison total', v => { const c = v.all.fields.class_code.subject_comparison; c.same_literal_count--; c.unavailable_count++; }],
  ['missing entry accounts', v => { v.all.fields.class_code.distribution.entries[0].account_count--; }],
  ['empty complete list with records', v => { for (const p of populations(v)) { const d = p.fields.class_code.distribution; d.entries = []; d.distinct_literal_count = 0; } }],
  ['missing categories for known records', v => { for (const p of populations(v)) p.fields.class_code.distribution.entries[0].literal = null; }],
  ['same comparison absent from distribution', v => { for (const p of populations(v)) p.fields.class_code.distribution.entries[0].literal = 'other'; }],
  ['wrong cross-pocket literal total', v => { v.pockets[0].fields.class_code.distribution.entries[0].literal = 'other';
    const c = v.pockets[0].fields.class_code.subject_comparison; c.different_literal_count = c.same_literal_count; c.same_literal_count = 0;
    v.all.fields.class_code.subject_comparison.same_literal_count--; v.all.fields.class_code.subject_comparison.different_literal_count++; }],
  ['false distinct-limit reason', v => { const d = v.all.fields.class_code.distribution; d.entries = null; d.status = 'details_unavailable'; d.reason = 'distinct_literal_limit'; }],
  ['entries present while unavailable', v => { v.all.fields.class_code.distribution.status = 'details_unavailable'; }],
  ['omission reason on complete list', v => { v.all.fields.class_code.distribution.reason = 'presentation_byte_limit'; }],
  ['unsupported limitation', v => { v.limitations[0] = 'supports_report_apply'; }],
]) test(`CAD admission rejects ${label} without returning partial evidence`, async () => {
  const { cad, checked } = await fixture(), changed = clone(cad), replacement = mutate(changed);
  assert.throws(() => check(replacement === null ? null : changed, checked), /Invalid recorded CAD evidence/);
});

test('optional addon is not ignored when explicitly malformed; descriptor hooks never run', async () => {
  const { response, input, checked, cad } = await fixture();
  const changed = clone(response); changed.recommendation.cad_recorded_evidence = null;
  assert.throws(() => catalogHelpers.checkCustomCohortPocketCatalog(changed, input));
  for (const place of ['root', 'array', 'entry']) {
    const value = clone(cad); let calls = 0;
    if (place === 'root') Object.defineProperty(value, 'subject', { enumerable: true, get() { calls++; return {}; } });
    if (place === 'array') Object.defineProperty(value.pockets, 'toJSON', { enumerable: false, value() { calls++; return []; } });
    if (place === 'entry') Object.defineProperty(value.all.fields.class_code.distribution.entries[0], 'literal', { enumerable: true, get() { calls++; return 'a'; } });
    assert.throws(() => check(value, checked)); assert.equal(calls, 0);
  }
});

// Synthetic public display data only: overlapping literals describe multiple
// retained parcel rows, not extra properties or a new capture/source authority.
function mixedDetails(cad) {
  const changed = clone(cad), key = 'structure_type';
  changed.subject.fields[key] = { state: 'conflicting', literal: null };
  const set = (p, partial, conflicting, entries) => {
    const f = p.fields[key]; Object.assign(f, { observed_count: 0, missing_count: 0, partial_count: partial,
      conflicting_count: conflicting, record_count: 2 * p.member_count, observed_record_count: partial + 2 * conflicting,
      missing_record_count: partial, distribution: { basis: f.distribution.basis, status: 'complete', reason: null,
        distinct_literal_count: entries.length, entries },
      subject_comparison: { same_literal_count: 0, different_literal_count: 0, unavailable_count: p.member_count } });
  };
  set(changed.pockets[0], 0, 1, [{ literal: 'A', account_count: 1 }, { literal: 'B', account_count: 1 }]);
  set(changed.pockets[1], 1, 0, [{ literal: 'A', account_count: 1 }, { literal: null, account_count: 1 }]);
  set(changed.all, 1, 1, [{ literal: 'A', account_count: 2 }, { literal: 'B', account_count: 1 }, { literal: null, account_count: 1 }]);
  return changed;
}
test('partial/conflicting multi-parcel observations preserve non-additive frequencies and unknown comparisons', async () => {
  const { cad, checked } = await fixture(), result = check(mixedDetails(cad), checked);
  assert.equal(result.all.fields.structure_type.record_count, 4);
  assert.equal(result.all.fields.structure_type.member_count, undefined);
  assert.equal(result.all.fields.structure_type.subject_comparison.unavailable_count, 2);
});

function manyLiterals(cad, values, keys = ['class_code']) {
  const changed = clone(cad);
  for (const key of keys) {
    changed.subject.fields[key] = { state: 'conflicting', literal: null };
    for (const p of populations(changed)) {
      const f = p.fields[key]; Object.assign(f, { observed_count: 0, partial_count: 0, missing_count: 0,
        conflicting_count: p.member_count, record_count: p.member_count * values.length,
        observed_record_count: p.member_count * values.length, missing_record_count: 0,
        distribution: { basis: f.distribution.basis, status: 'complete', reason: null, distinct_literal_count: values.length,
          entries: values.map(literal => ({ literal, account_count: p.member_count })) },
        subject_comparison: { same_literal_count: 0, different_literal_count: 0, unavailable_count: p.member_count } });
    }
  }
  return changed;
}
test('distribution cardinality and UTF8 budgets reject whole lists, never a clipped first page', async () => {
  const { cad, checked } = await fixture();
  assert.equal(check(manyLiterals(cad, Array.from({ length: 64 }, (_, i) => `v${i}`)), checked).all.fields.class_code.distribution.entries.length, 64);
  const overCount = manyLiterals(cad, Array.from({ length: 65 }, (_, i) => `v${i}`));
  assert.throws(() => check(overCount, checked));
  for (const p of populations(overCount)) Object.assign(p.fields.class_code.distribution,
    { status: 'details_unavailable', reason: 'distinct_literal_limit', entries: null });
  assert.equal(check(overCount, checked).all.fields.class_code.distribution.distinct_literal_count, 65);
  const overBytes = manyLiterals(cad, Array.from({ length: 17 }, (_, i) => `${i}`.padEnd(4096, 'x')));
  assert.throws(() => check(overBytes, checked));
});
test('full CAD addon has an exact serialized byte bound even when each list separately fits', async () => {
  const { cad, checked } = await fixture(), value = manyLiterals(cad,
    Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(4000, 'x')),
    ['class_code', 'class_description', 'use_description', 'structure_type']);
  assert.ok(Buffer.byteLength(JSON.stringify(value.all.fields.class_code.distribution.entries)) < 65536);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 512000);
  assert.throws(() => check(value, checked));
});

const runtime = createRequire(new URL('../package.json', import.meta.url)), ts = runtime('typescript'), React = runtime('react');
const { renderToStaticMarkup } = runtime('react-dom/server');
const inspectorPath = new URL('../src/features/neighborhood/components/CustomCohortPocketInspector.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(inspectorPath, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, module = { exports: {} };
new Script(`(function(require,module,exports){${compiled}\n})`).runInThisContext()(key => {
  if (key === 'react' || key === 'react/jsx-runtime') return runtime(key);
  if (key === '../customCohortCadEvidence') return cadHelpers;
  if (key === '../customCohortPocketCatalog') return catalogHelpers;
  if (key === '../customCohortPreviewController') return controller;
  if (key === '../customCohortPreviewApi') return { requestCustomCohortObservationPreview() { assert.fail('SSR must not fetch'); } };
  if (key === './CustomCohortStatistics' || key === './CustomCohortMemberBrowser') return { default: () => null, __esModule: true };
  assert.fail(`Unexpected Inspector import ${key}`);
}, module, module.exports);
const render = (f, options = {}) => {
  const { pocketId = f.checked.pockets[0].id, input = f.input, paused = false } = options;
  const cad = Object.hasOwn(options, 'cad') ? options.cad : f.checked.recommendation.cad_recorded_evidence;
  return renderToStaticMarkup(React.createElement(module.exports.default, { input, pocketId, label: 'Synthetic pocket', paused,
    catalog: { ...f.checked, recommendation: { ...f.checked.recommendation, cad_recorded_evidence: cad } } }));
};

test('actual Inspector renders initially collapsed pocket-specific CAD details without requests, score claims or selection callbacks', async () => {
  const f = await fixture(), html = render(f);
  assert.match(html, /Recorded CAD observations/); assert.match(html, /1 accounts/);
  assert.equal((html.match(/data-cad-field=/g) ?? []).length, 5);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:[=\s>])/);
  assert.match(html, /These values do not change similarity scores/);
  assert.match(html, /not a housing-similarity determination/);
  assert.match(html, /false is not a missing value/); assert.match(html, />false<\/code>/);
  assert.match(html, /print:hidden/);
  assert.match(render(f, { paused: true }), /Group inspection is paused/);
  assert.match(render(f, { paused: true }), /Recorded CAD observations/);
});
test('Inspector does not borrow all or another context CAD data; older payload keeps prior UI', async () => {
  const f = await fixture();
  assert.doesNotMatch(render(f, { cad: undefined }), /Recorded CAD observations/);
  const missing = clone(f.checked.recommendation.cad_recorded_evidence); missing.pockets = missing.pockets.filter(p => p.id !== f.checked.pockets[0].id);
  assert.doesNotMatch(render(f, { cad: missing }), /Recorded CAD observations/);
  assert.doesNotMatch(render(f, { input: { ...f.input, contextRef: { ...f.input.contextRef, context_sha256: 'f'.repeat(64) } } }), /Recorded CAD observations/);
});
test('Inspector explains missing, partial, conflicting and unavailable rather than upgrading them to known housing', async () => {
  const f = await fixture(), value = check(mixedDetails(f.cad), f.checked);
  const first = render(f, { cad: value, pocketId: value.pockets[0].id }), second = render(f, { cad: value, pocketId: value.pockets[1].id });
  assert.match(first, /1 conflicting accounts/); assert.match(first, /Subject: conflicting/);
  assert.match(second, /1 partial/); assert.match(second, /null \(missing\)/);
  const omitted = clone(f.cad); omitDistributions(omitted);
  assert.match(render(f, { cad: check(omitted, f.checked) }), /no partial list is shown/);
});
test('Inspector clearly labels entire-addon display omission and does not report missing CAD', async () => {
  const f = await fixture(), unavailable = { cad_baseline_version: 1, mapping_version: 4, status: 'details_unavailable',
    reason: 'presentation_byte_limit', binding: f.cad.binding, member_count: 2, pocket_count: 2 };
  const html = render(f, { cad: unavailable });
  assert.match(html, /does not mean CAD evidence is missing/); assert.doesNotMatch(html, /data-cad-field=/);
});
test('actual retained blank and HTML-like literals remain missing/escaped in Inspector', async () => {
  const f = await fixture(cadEvidenceFixture({ parcelOverrides: { class_code: '  ', use_description: '<img src=x onerror=alert(1)>' } }));
  const html = render(f);
  assert.match(html, /blank \/ missing/); assert.match(html, /Subject: missing/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img src=x/);
});
