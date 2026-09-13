import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCustomCohortPocketCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { buildCustomCohortSubdivisionFamilies, buildCustomCohortSubdivisionPhases } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { checkCustomCohortStockComposition } from '../src/features/neighborhood/customCohortStockComposition.ts';
import { STOCK_COMPOSITION_DEFINITION as definition, STOCK_COMPOSITION_PROFILE as profile } from '../src/features/neighborhood/customCohortStockCompositionDefinition.ts';
import { createCustomCohortStockCompositionComparison as prepare } from '../src/features/neighborhood/customCohortStockCompositionComparison.ts';

const contextRef = { context_id: '30000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const id = index => `recorded-cad:${index.toString(16).padStart(64, '0')}`;
const zeros = n => Array(n).fill(0);
const population = spec => {
  const n = spec.count ?? 5, states = spec.states ?? [n, 0, 0, 0, 0];
  return [n, Array.from({ length: 3 }, () => [states, spec.bins ?? [0, 0, 0, states[0] + states[1]]]),
    [spec.housingStates ?? [n, 0, 0, 0, 0], spec.categories ?? [n, ...zeros(6)]]];
};
function add(rows) {
  const out = [0, Array.from({ length: 3 }, () => [zeros(5), zeros(4)]), [zeros(5), zeros(7)]];
  for (const row of rows) {
    out[0] += row[0];
    for (let field = 0; field < 3; field++) for (let part = 0; part < 2; part++) row[1][field][part].forEach((v, i) => { out[1][field][part][i] += v; });
    for (let part = 0; part < 2; part++) row[2][part].forEach((v, i) => { out[2][part][i] += v; });
  }
  return out;
}
// Synthetic already-projected bin fixtures, admitted through the actual browser
// checker. These are not native capture/provider data or timing measurements.
function fixture(specs = [{ label: 'REFERENCE' }, { label: 'COMPARISON' }], { unknownSubject = false, unassigned = 0 } = {}) {
  let next = 0;
  const pockets = specs.map((spec, i) => ({ id: id(i + 1), label: spec.label, county: spec.county ?? 'Dallas',
    disposition: 'needs_review', member_count: spec.count ?? 5, account_ids: Array.from({ length: spec.count ?? 5 }, () => `A${++next}`) }));
  const assigned = next, unassignedIds = Array.from({ length: unassigned }, () => `A${++next}`);
  const rawCatalog = { catalog_version: 2, status: 'review_only', binding: { context_ref: contextRef, selection_revision: 1 }, pockets,
    unassigned: { member_count: unassigned, account_ids: unassignedIds, reason_counts: [] },
    coverage: { discovery_member_count: next, assigned_account_count: assigned, unassigned_account_count: unassigned },
    subject_membership: { account_id: 'A1', assigned_pocket_id: unknownSubject ? null : pockets.find(p => p.account_ids.includes('A1'))?.id ?? null,
      status: unknownSubject ? 'conflicting_evidence' : 'recorded_label_matched', recorded_label_match_only: true }, limitations: [], apply: { status: 'blocked' } };
  const input = { accountId: 'A1', assignmentFileId: '1', contextRef, selection: { revision: 1, pockets: [] } };
  const catalog = checkCustomCohortPocketCatalog({ status: 'catalog', subject_freshness: 'matched', context_ref: contextRef,
    selection_revision: 1, target: { account_id: 'A1', assignment_file_id: '1' }, catalog: rawCatalog, apply: { status: 'blocked' } }, input);
  const populations = specs.map(population), rows = pockets.map((p, i) => [p.id, ...populations[i]]);
  if (unassigned) rows.push(['discovery:unassigned', ...population({ count: unassigned })]);
  rows.sort(([a], [b]) => a < b ? -1 : 1);
  const raw = { composition_version: 1, profile, binding: { context_ref: contextRef, captured_at: '2026-09-06T08:00:00.123Z' },
    status: 'available', reason: null, mapping_version: 4, housing_profile: definition.housing_profiles[0], definition,
    bin_cuts: [[2000, 2000, 2000], [2000, 2000, 2000], [2000, 2000, 2000]],
    subject: { numeric: [['observed', 2100, 'saved_subject'], ['observed', 1999, 'retained_subject_public'], ['missing', null, 'saved_subject']],
      housing: ['observed', 'detached_single_family', 'current_subject_cad'], recorded_group_id: rawCatalog.subject_membership.assigned_pocket_id,
      group_reason: unknownSubject ? 'conflicting_evidence' : null }, all: add(rows.map(row => row.slice(1))), pockets: rows };
  const composition = checkCustomCohortStockComposition(raw, catalog), families = buildCustomCohortSubdivisionFamilies(catalog);
  const args = { catalog, families, contextRef, composition };
  const family = index => families.families.find(f => f.pocket_ids.includes(id(index)));
  const view = (index = 2, selectedPocketIds = [id(2)]) => ({ family: family(index), inspectedPocketIds: family(index).pocket_ids, selectedPocketIds });
  return { ...args, raw, args, family, view, build: prepare(args) };
}

test('different distributions with identical median produce descriptive overlap below100', () => {
  const left = [1000, 1000, 2000, 3000, 3000], right = [2000, 2000, 2000, 2000, 2000];
  assert.equal(left[2], right[2]);
  const f = fixture([{ label: 'REFERENCE', bins: [2, 0, 0, 3] }, { label: 'COMPARISON', bins: [0, 0, 0, 5] }]);
  const result = f.build(f.view()); assert.equal(result.status, 'available');
  assert.equal(result.inspected.fields[0].overlap_percent, 60); assert.equal(result.selected.fields[0].overlap_percent, 60);
  assert.equal(result.reference.label, 'REFERENCE'); assert.equal(result.reference.member_count, 5);
  assert.deepEqual(result.subject.map(c => c.value), [2100, 1999, null, 'detached_single_family']);
  assert.equal(result.subject[1].label, 'Year built'); assert.equal(result.subject[1].origin, 'retained_subject_public');
  assert.equal(Object.hasOwn(result, 'score'), false); assert.equal(Object.hasOwn(result, 'reliability'), false);
});

test('subject reference is the exact existing family; alias phases and selected unions conserve every original leaf once', () => {
  const f = fixture([{ label: 'MONICA PARK 1', count: 2 }, { label: 'MONICA PARK 1', county: 'DALLAS COUNTY', count: 1 },
    { label: 'MONICA PARK 2', count: 3 }, { label: 'OTHER', count: 4 }]);
  const family = f.family(1), phase = buildCustomCohortSubdivisionPhases(f.catalog, family)[0];
  const result = f.build({ family, inspectedPocketIds: phase.pocket_ids, selectedPocketIds: [id(2), id(4)] });
  assert.equal(result.reference.member_count, 6); assert.deepEqual(result.reference.pocket_ids, [id(1), id(2), id(3)]);
  assert.equal(result.inspected.member_count, 3); assert.deepEqual(result.inspected.pocket_ids, [id(1), id(2)]);
  assert.equal(result.selected.member_count, 5); assert.deepEqual(result.selected.pocket_ids, [id(2), id(4)]);
  assert.equal(f.build({ family, inspectedPocketIds: [id(1)], selectedPocketIds: [] }).reason, 'inspection_union_mismatch');
  assert.equal(f.build({ family, inspectedPocketIds: family.pocket_ids, selectedPocketIds: [id(2), id(2)] }).reason, 'selection_union_mismatch');
});

test('empty selection is zero, never all; explicit nonempty unassigned remains part of the selected union', () => {
  const f = fixture(undefined, { unassigned: 2 }), empty = f.build(f.view(2, []));
  assert.equal(empty.selected.member_count, 0); assert.ok(empty.selected.fields.every(field => field.overlap_percent === null));
  assert.equal(empty.reference.member_count, 5);
  const selected = f.build(f.view(2, [id(2), 'discovery:unassigned'])); assert.equal(selected.selected.member_count, 7);
});

test('partial and unknown coverage remain visible and numeric partials are not counted as fully observed', () => {
  const f = fixture([{ label: 'REFERENCE' }, { label: 'COMPARISON', states: [1, 1, 1, 1, 1], bins: [0, 0, 0, 2],
    housingStates: [1, 1, 1, 1, 1], categories: [1, ...zeros(6)] }]);
  const result = f.build(f.view());
  for (const field of result.inspected.fields) assert.deepEqual(field.coverage, { total: 5, observed: 1, partial: 1, unknown: 3 });
  assert.equal(result.inspected.fields[0].overlap_percent, 100); assert.equal(result.inspected.fields[3].overlap_percent, 100);
  assert.deepEqual(result.inspected.fields[0].reference_coverage, { total: 5, observed: 5, partial: 0, unknown: 0 });
});

test('unknown subject reference stays unavailable without matching a nearby or similarly named family', () => {
  const f = fixture([{ label: 'MONICA PARK 1' }, { label: 'MONICA PARK 2' }], { unknownSubject: true });
  const result = f.build(f.view()); assert.equal(result.reference.status, 'unavailable');
  assert.equal(result.reference.reason, 'subject_reference_unavailable'); assert.equal(result.reference.member_count, null);
  assert.equal(result.reference.label, null); assert.deepEqual(result.reference.pocket_ids, []);
  assert.ok(result.inspected.fields.every(field => field.overlap_percent === null)); assert.equal(result.subject[0].value, 2100);
});

test('ambiguous reference family index never supplies a substitute reference', () => {
  const f = fixture(), families = { ...f.families, families: [...f.families.families, { ...f.family(1), id: 'duplicate' }] };
  const result = prepare({ ...f.args, families })(f.view());
  assert.equal(result.reference.reason, 'subject_reference_ambiguous'); assert.equal(result.reference.member_count, null);
});

test('defensive empty reference refuses overlap instead of selecting the nonempty neighboring family', () => {
  const f = fixture([{ label: 'EMPTY REFERENCE', count: 0 }, { label: 'NONEMPTY', count: 5 }]);
  // Malformed caller-boundary probe, not a fabricated admitted acquisition: the
  // actual catalog checker would not assign a subject to an empty original leaf.
  const catalog = { ...f.catalog, subject_membership: { ...f.catalog.subject_membership, assigned_pocket_id: id(1) } };
  const composition = { ...f.composition, subject: { ...f.composition.subject, recorded_group_id: id(1) } };
  const result = prepare({ ...f.args, catalog, composition })(f.view());
  assert.equal(result.reference.status, 'unavailable'); assert.equal(result.reference.reason, 'subject_reference_empty');
  assert.equal(result.reference.member_count, null); assert.ok(result.inspected.fields.every(field => field.overlap_percent === null));
});

test('foreign contexts/profile/grouping and changed original population membership refuse safely', () => {
  const f = fixture(), foreign = { ...contextRef, context_sha256: 'b'.repeat(64) };
  for (const args of [{ ...f.args, contextRef: foreign }, { ...f.args, families: { ...f.families, context_ref: foreign } },
    { ...f.args, composition: { ...f.composition, binding: { ...f.composition.binding, context_ref: foreign } } }])
    assert.equal(prepare(args)(f.view()).reason, 'context_mismatch');
  assert.equal(prepare({ ...f.args, families: { ...f.families, profile_version: 2 } })(f.view()).reason, 'grouping_mismatch');
  assert.equal(prepare({ ...f.args, composition: { ...f.composition, profile: { ...profile, content_sha256: 'b'.repeat(64) } } })(f.view()).reason, 'profile_mismatch');
  assert.equal(prepare({ ...f.args, composition: { ...f.composition, pockets: [f.composition.pockets[0], f.composition.pockets[0]] } })(f.view()).reason,
    'original_membership_mismatch');
  assert.equal(f.build({ ...f.view(), selectedPocketIds: ['recorded-cad:foreign'] }).reason, 'selection_union_mismatch');
  assert.equal(f.build({ ...f.view(), family: { ...f.family(2), member_count: 99 } }).reason, 'family_mismatch');
});

test('missing legacy addon and producer unavailable envelope remain unavailable without source requests', () => {
  const f = fixture();
  assert.equal(prepare({ ...f.args, composition: undefined })(f.view()).reason, 'composition_unavailable');
  const composition = { composition_version: 1, profile, binding: f.composition.binding, status: 'unavailable', reason: 'account_limit' };
  assert.equal(prepare({ ...f.args, composition })(f.view()).reason, 'account_limit');
});

test('repeated views are detached/frozen, do not mutate input or traverse account arrays again', () => {
  const f = fixture(), before = JSON.stringify(f.args);
  const catalog = { ...f.catalog, pockets: f.catalog.pockets.map(p => ({ ...p,
    get account_ids() { assert.fail('comparison must use checked count vectors, not scan accounts'); } })) };
  const build = prepare({ ...f.args, catalog }), a = build(f.view()), b = build(f.view(1, []));
  assert.equal(a.inspected.member_count, 5); assert.equal(b.selected.member_count, 0); assert.equal(JSON.stringify(f.args), before);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.inspected.fields[0].coverage)); assert.ok(Object.isFrozen(a.subject));
  assert.notEqual(a.context_ref, f.contextRef); assert.notEqual(a.inspected.pocket_ids, f.view().inspectedPocketIds);
});
