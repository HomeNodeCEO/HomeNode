import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const file = new URL('../src/features/neighborhood/components/CustomCohortStockCompositionComparison.tsx', import.meta.url);
const source = readFileSync(file, 'utf8');
const children = node => [node?.props?.children].flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : children(node).filter(value => value !== null && value !== undefined && value !== false).map(text).join('');
const imports = [];
const panel = loadTrustedRepositoryCommonJs(file, key => {
  imports.push(key); assert.equal(key, 'react/jsx-runtime', 'The panel must not import hooks, transports or action owners');
  return requireRuntime(key);
}, { environment: {
  fetch: () => assert.fail('No requests from the comparison panel'),
  XMLHttpRequest: function () { assert.fail('No XMLHttpRequest'); },
  WebSocket: function () { assert.fail('No WebSocket'); },
} });

const coverage = (total, observed, partial, unknown) => ({ total, observed, partial, unknown });
const referenceCoverage = [coverage(1000, 600, 100, 300), coverage(1000, 800, 50, 150),
  coverage(1000, 500, 200, 300), coverage(1000, 700, 120, 180)];
const fields = (counts, overlaps) => ['gla_sqft', 'year_built', 'site_area_sqft', 'housing'].map((key, i) => ({
  key, label: ['GLA', 'Year built', 'Site area', 'Housing type'][i], overlap_percent: overlaps[i],
  coverage: counts[i], reference_coverage: referenceCoverage[i],
}));
function fixture() {
  return { status: 'available', context_ref: { context_id: 'private-context-id', context_revision: '1', context_sha256: 'a'.repeat(64) },
    profile: { id: 'private-profile-id', revision: 1, content_sha256: 'b'.repeat(64) }, grouping_profile_version: 1,
    reference: { status: 'available', reason: null, label: 'Subject Grove', pocket_ids: ['private-reference-one', 'private-reference-two'], member_count: 1000 },
    subject: [
      { label: 'GLA', state: 'observed', value: 2000.123456789, unit: 'ft²', origin: 'saved_subject' },
      { label: 'Year built', state: 'observed', value: 1999, unit: null, origin: 'retained_subject_public' },
      { label: 'Site area', state: 'json_null', value: null, unit: 'ft²', origin: 'saved_subject' },
      { label: 'Housing type', state: 'observed', value: 'detached_single_family', unit: null, origin: 'current_subject_cad' },
    ],
    inspected: { label: 'Neighbor Grove Phase 2', pocket_ids: ['private-inspected-leaf'], member_count: 10,
      fields: fields([coverage(10, 6, 1, 3), coverage(10, 8, 0, 2), coverage(10, 3, 2, 5), coverage(10, 4, 2, 4)], [100, 72.36, null, 0]) },
    selected: { label: 'Current selected union', pocket_ids: ['private-selected-one', 'private-selected-two', 'private-selected-three'], member_count: 1250,
      fields: fields([coverage(1250, 750, 125, 375), coverage(1250, 1000, 0, 250),
        coverage(1250, 900, 200, 150), coverage(1250, 875, 125, 250)], [90, 80, 70, 60]) },
  };
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const render = comparison => panel.default({ comparison: freeze(comparison) });
const section = (tree, label) => walk(tree).find(node => node.type === 'section' && node.props['aria-label'] === label);
const dataRows = tree => walk(tree).filter(node => node.type === 'tr').slice(1).map(row => children(row).filter(Boolean).map(text));

test('native collapsed details and its keyboard-operable summary retain the established panel classes', () => {
  const tree = render(fixture());
  assert.equal(tree.type, 'details'); assert.equal(tree.props.open, undefined);
  assert.equal(tree.props.className, 'rounded-lg border border-violet-200 p-3 text-xs');
  const summary = children(tree)[0]; assert.equal(summary.type, 'summary');
  assert.equal(text(summary), 'Property distribution comparison');
  assert.equal(summary.props.className, 'cursor-pointer font-medium');
  assert.equal(summary.props.tabIndex, undefined); assert.equal(summary.props.role, undefined);
  assert.equal(summary.props.onKeyDown, undefined); assert.equal(summary.props.onClick, undefined);
  assert.equal(tree.props.onToggle, undefined, 'Native disclosure requires no custom keyboard or toggle handler');
  assert.equal(walk(tree).filter(node => node.type === 'summary').length, 1);
});

test('reference, inspected and current selected union retain their separate exact account and leaf counts', () => {
  const tree = render(fixture()), copy = text(tree);
  assert.match(copy, /Reference: Subject Grove · 1,000 accounts · 2 recorded leaves/);
  const inspected = section(tree, 'Inspected property distribution'), selected = section(tree, 'Current selected union property distribution');
  assert.match(text(inspected), /Inspected: Neighbor Grove Phase 2/);
  assert.match(text(inspected), /10 accounts · 1 recorded leaf/);
  assert.match(text(selected), /1,250 accounts · 3 recorded leaves/);
  assert.deepEqual(dataRows(inspected), [
    ['GLA', '100%', '6 observed · 1 partial · 3 unknown / 10 accounts', '600 observed · 100 partial · 300 unknown / 1,000 accounts'],
    ['Year built', '72.4%', '8 observed · 0 partial · 2 unknown / 10 accounts', '800 observed · 50 partial · 150 unknown / 1,000 accounts'],
    ['Site area', 'Unavailable', '3 observed · 2 partial · 5 unknown / 10 accounts', '500 observed · 200 partial · 300 unknown / 1,000 accounts'],
    ['Housing type', '0%', '4 observed · 2 partial · 4 unknown / 10 accounts', '700 observed · 120 partial · 180 unknown / 1,000 accounts'],
  ]);
  assert.deepEqual(dataRows(selected)[0], ['GLA', '90%', '750 observed · 125 partial · 375 unknown / 1,250 accounts',
    '600 observed · 100 partial · 300 unknown / 1,000 accounts']);
  assert.equal(walk(inspected).filter(node => node.type === 'th' && node.props.scope === 'row').length, 4);
});

test('subject area values use grouped two-decimal display with unchanged origin, while missing observations stay unavailable', () => {
  const tree = render(fixture()), subject = text(section(tree, 'Copied subject values'));
  assert.match(subject, /GLA2,000\.12 ft² · Observed · Origin: Saved subject/);
  assert.match(subject, /Year built1999 · Observed · Origin: Retained public subject evidence/);
  assert.match(subject, /Site areaUnavailable · Recorded as blank · Origin: Saved subject/);
  assert.match(subject, /Housing typeDetached single-family · Observed · Origin: Current subject CAD/);
  assert.match(subject, /no values are inferred/);
  assert.doesNotMatch(text(tree), /private-|[ab]{64}|saved_subject|detached_single_family|json_null/);
});

test('observed site area is grouped to at most two decimals and year built never gains a comma', () => {
  const comparison = fixture(); comparison.subject[2] = { label: 'Site area', state: 'observed', value: 12345.6789,
    unit: 'ft²', origin: 'retained_subject_public' };
  const subject = text(section(render(comparison), 'Copied subject values'));
  assert.match(subject, /Site area12,345\.68 ft² · Observed · Origin: Retained public subject evidence/);
  assert.match(subject, /Year built1999 · Observed/); assert.doesNotMatch(subject, /1,999/);
  assert.equal(comparison.subject[2].value, 12345.6789, 'Display formatting does not alter the copied value');
});

test('a valid reference never turns an empty selected union into zero or complete overlap', () => {
  const comparison = fixture(); comparison.selected.member_count = 0; comparison.selected.pocket_ids = [];
  comparison.selected.fields = fields(Array.from({ length: 4 }, () => coverage(0, 0, 0, 0)), [100, 100, 100, 100]);
  const selected = section(render(comparison), 'Current selected union property distribution');
  assert.match(text(selected), /0 accounts · 0 recorded leaves/);
  assert.match(text(selected), /No accounts in this selection; overlap is unavailable/);
  assert.deepEqual(dataRows(selected).map(row => row[1]), ['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
  assert.match(text(selected), /0 observed · 0 partial · 0 unknown \/ 0 accounts/);
  assert.match(text(selected), /600 observed · 100 partial · 300 unknown \/ 1,000 accounts/);
});

test('missing reference keeps population counts and unknown coverage but does not display overlap', () => {
  const comparison = fixture(); comparison.reference = { status: 'unavailable', reason: 'subject_reference_ambiguous',
    label: null, member_count: null, pocket_ids: [] };
  for (const pop of [comparison.inspected, comparison.selected]) for (const field of pop.fields) field.reference_coverage = null;
  const tree = render(comparison), copy = text(tree);
  assert.match(copy, /A unique recorded reference group for the subject is unavailable/);
  assert.doesNotMatch(copy, /subject_reference_ambiguous/);
  assert.match(copy, /10 accounts · 1 recorded leaf/);
  const rows = dataRows(section(tree, 'Inspected property distribution'));
  assert.ok(rows.every(row => row[1] === 'Unavailable' && row[3] === 'Reference coverage unavailable'));
  assert.match(rows[0][2], /3 unknown \/ 10 accounts/);
});

test('rounded overlap never presents near-complete or near-zero proportions as an exact boundary', () => {
  const comparison = fixture(); comparison.inspected.fields[0].overlap_percent = 99.96;
  comparison.inspected.fields[1].overlap_percent = 0.04;
  const rows = dataRows(section(render(comparison), 'Inspected property distribution'));
  assert.equal(rows[0][1], '>99.9%'); assert.equal(rows[1][1], '<0.1%');
});

for (const [reason, copy] of [['subject_reference_unavailable', 'no recorded reference group'],
  ['subject_reference_empty', 'has no captured accounts']]) {
  test(`reference ${reason} retains its explicit unavailable reason in friendly language`, () => {
    const comparison = fixture(); comparison.reference = { status: 'unavailable', reason, label: null, member_count: null, pocket_ids: [] };
    for (const pop of [comparison.inspected, comparison.selected]) for (const field of pop.fields) field.reference_coverage = null;
    const tree = render(comparison); assert.ok(text(tree).includes(copy)); assert.ok(!text(tree).includes(reason));
    assert.ok(dataRows(section(tree, 'Current selected union property distribution')).every(row => row[1] === 'Unavailable'));
  });
}

for (const reason of ['context_mismatch', 'grouping_mismatch', 'catalog_incomplete', 'composition_unavailable', 'profile_mismatch',
  'original_membership_mismatch', 'inspection_union_mismatch', 'selection_union_mismatch', 'family_mismatch',
  'account_limit', 'group_limit', 'housing_interpretation_unavailable', 'output_byte_limit', 'private-unrecognized-reason', '__proto__']) {
  test(`unavailable ${reason} uses friendly copy without exposing internal reason or fake populations`, () => {
    const tree = render({ status: 'unavailable', reason });
    assert.equal(tree.type, 'details'); assert.equal(tree.props.open, undefined);
    assert.match(text(tree), /Comparison unavailable\./); assert.ok(!text(tree).includes(reason));
    assert.equal(walk(tree).filter(node => node.type === 'table').length, 0);
    assert.doesNotMatch(text(tree), /0 accounts|Reference:/);
  });
}

test('missing distribution view does not imply that computed distributions were persisted', () => {
  const copy = text(render({ status: 'unavailable', reason: 'composition_unavailable' }));
  assert.match(copy, /This capture does not have a supported distribution view\./);
  assert.doesNotMatch(source, /distributions were not retained|retained distributions|retained distribution method/);
});

test('limitations distinguish binned proportions, numeric partials and observed-only housing categories', () => {
  const copy = text(render(fixture()));
  assert.match(copy, /Descriptive binned overlap only—not calibrated reliability or a measure of sales representativeness/);
  assert.match(copy, /A 100% overlap means the same bin proportions, not that every property is the same/);
  assert.match(copy, /Numeric overlap includes observed and partial values in the bins/);
  assert.match(copy, /Housing-type overlap uses observed categories only/);
  assert.match(copy, /partial and unknown records are not included in housing category counts/);
  assert.match(copy, /Unknown coverage includes missing, invalid or conflicting observations/);
  assert.match(copy, /not averages of phase medians/); assert.match(copy, /does not change the selection/);
});

test('real component remains request-free, mutation-free and adds no action, score or color behavior', () => {
  const comparison = fixture(), before = structuredClone(comparison), tree = render(comparison);
  assert.deepEqual(comparison, before); assert.deepEqual(imports, ['react/jsx-runtime']);
  for (const node of walk(tree)) {
    assert.ok(!['button', 'input', 'select', 'form', 'a', 'progress', 'meter'].includes(node.type));
    assert.ok(Object.keys(node.props).every(key => !/^on[A-Z]/.test(key)));
    assert.equal(node.props.style, undefined);
    const classes = String(node.props.className ?? '').split(/\s+/);
    assert.ok(classes.every(value => !/^(?:bg-|text-(?:red|green|amber|violet|slate)-|border-(?:red|green|amber)-)/.test(value)));
  }
  assert.doesNotMatch(source, /\b(?:useState|useEffect|useMemo|fetch|XMLHttpRequest|WebSocket)\s*\(/);
  assert.doesNotMatch(text(tree), /reliability score|similarity score|\/ 100/);
});
