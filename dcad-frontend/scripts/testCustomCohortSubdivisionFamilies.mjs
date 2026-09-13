import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCustomCohortPocketCatalog as check, selectionFromRecordedGroups as select } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { buildCustomCohortSubdivisionFamilies as build,
  customCohortSubdivisionFamilyForPocket as find } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';

const contextRef = { context_id: '30000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const pocketId = n => `recorded-cad:${n.toString(16).padStart(64, '0')}`;
function fixture(specs, { catalogVersion = 2, unassigned = [] } = {}) {
  let account = 0;
  const pockets = specs.map((spec, index) => {
    const value = typeof spec === 'string' ? { label: spec } : spec;
    const ids = Array.from({ length: value.member_count ?? 1 }, () => `A${++account}`);
    return { id: pocketId(index + 1), label: value.label, county: value.county ?? 'Dallas', account_ids: ids,
      member_count: ids.length, disposition: 'needs_review' };
  });
  const catalog = { catalog_version: catalogVersion, status: 'review_only',
    binding: { context_ref: contextRef, selection_revision: 7 }, pockets,
    unassigned: { account_ids: unassigned, member_count: unassigned.length, reason_counts: [] },
    coverage: { discovery_member_count: account + unassigned.length, assigned_account_count: account, unassigned_account_count: unassigned.length },
    subject_membership: { account_id: 'A1', assigned_pocket_id: pockets.find(p => p.account_ids.includes('A1'))?.id ?? null,
      status: 'recorded_label_matched', recorded_label_match_only: true }, limitations: [], apply: { status: 'blocked' } };
  const input = { accountId: 'A1', assignmentFileId: '1', contextRef, selection: { revision: 7, pockets: [] } };
  const response = { status: 'catalog', target: { account_id: 'A1', assignment_file_id: '1' },
    context_ref: contextRef, selection_revision: 7, subject_freshness: 'matched', catalog, apply: { status: 'blocked' } };
  return { catalog: check(response, input), input, response };
}
const family = (model, index = 1) => find(model, pocketId(index));
function complete(catalog, model) {
  const expected = catalog.pockets.map(p => p.id).sort(), actual = model.families.flatMap(f => f.pocket_ids).sort();
  assert.deepEqual(actual, expected); assert.equal(new Set(actual).size, actual.length);
  assert.equal(model.families.reduce((sum, f) => sum + f.member_count, 0), catalog.coverage.assigned_account_count);
  assert.deepEqual(Object.keys(model.family_id_by_pocket_id).sort(), expected);
  assert.ok(model.families.every(f => f.pocket_ids.every(id => model.family_id_by_pocket_id[id] === f.id)));
}

for (const [labels, name] of [[['MONICA PARK 1', 'MONICA PARK 4'], 'MONICA PARK'],
  [['HOLIDAY PARK NORTH 1', 'HOLIDAY PARK NORTH 6'], 'HOLIDAY PARK NORTH']]) {
  test(`numbered recorded-name candidates preserve original leaves: ${name}`, () => {
    const { catalog } = fixture(labels), before = JSON.stringify(catalog), model = build(catalog);
    assert.equal(model.profile_version, 1); assert.equal(model.families.length, 1);
    assert.equal(family(model).basis, 'candidate_numbered_name'); assert.equal(family(model).label, name);
    assert.deepEqual(family(model).pocket_ids, [pocketId(1), pocketId(2)]); complete(catalog, model);
    assert.equal(JSON.stringify(catalog), before); assert.deepEqual(model.context_ref, catalog.binding.context_ref);
    assert.notEqual(model.context_ref, catalog.binding.context_ref);
  });
}

test('narrow PH and PHASE markers share an explicit name basis and numeric child order', () => {
  const { catalog } = fixture(['Cedar Park PHASE 12', 'cedar  park PH 2', 'CEDAR PARK PHASE 999']);
  const model = build(catalog), item = family(model);
  assert.equal(model.families.length, 1); assert.equal(item.basis, 'explicit_phase_name');
  assert.deepEqual(item.pocket_ids, [pocketId(2), pocketId(1), pocketId(3)]); complete(catalog, model);
});

test('known DFW county suffixes are equivalent while other county names remain exactly isolated', () => {
  const { catalog } = fixture([
    { label: 'Monica Park 1', county: 'Dallas' }, { label: 'Monica Park 4', county: 'DALLAS COUNTY' },
    { label: 'Monica Park 1', county: 'Collin' }, { label: 'Monica Park 4', county: 'Collin County' },
    { label: 'Monica Park 1', county: 'Travis' }, { label: 'Monica Park 4', county: 'Travis County' },
    { label: 'Monica Park 1', county: 'Dallas County, MO' },
  ]);
  const model = build(catalog); complete(catalog, model);
  assert.deepEqual(family(model, 1).pocket_ids, [pocketId(1), pocketId(2)]);
  assert.deepEqual(family(model, 3).pocket_ids, [pocketId(3), pocketId(4)]);
  for (const i of [5, 6, 7]) assert.equal(family(model, i).basis, 'standalone');
});

test('directions, punctuation, and internal numbers stay part of the exact base', () => {
  const labels = ['Holiday Park North 1', 'Holiday Park North 6', 'Holiday Park South 1', 'Holiday Park South 6',
    'Cedar-Park 1', 'Cedar Park 2', 'Village 66 Gardens 1', 'Village 66 Gardens 2'];
  const { catalog } = fixture(labels), model = build(catalog); complete(catalog, model);
  assert.deepEqual(family(model, 1).pocket_ids, [pocketId(1), pocketId(2)]);
  assert.deepEqual(family(model, 3).pocket_ids, [pocketId(3), pocketId(4)]);
  assert.notEqual(family(model, 1).id, family(model, 3).id);
  for (const i of [5, 6]) assert.equal(family(model, i).basis, 'standalone');
  assert.equal(family(model, 7).label, 'Village 66 Gardens');
});

for (const base of ['Route', 'HIGHWAY', 'US', 'U.S.', 'US-75 Estates', 'I-35 Estates', 'FM 544 Gardens',
  'County Road', 'State Route', 'SH 121 Estates', '1st Street', '66th Avenue', 'Park Road']) {
  test(`numeric road/street labels never become phase candidates: ${base}`, () => {
    const { catalog } = fixture([`${base} 1`, `${base} 2`]), model = build(catalog);
    assert.equal(model.families.length, 2); assert.ok(model.families.every(f => f.basis === 'standalone'));
    complete(catalog, model);
  });
}

for (const labels of [
  ['Park 0', 'Park 1'], ['Park 01', 'Park 2'], ['Park 1000', 'Park 1001'],
  ['Park PHASE I', 'Park PHASE II'], ['Park PHASE 1A', 'Park PHASE 1B'],
  ['Park SECTION 1', 'Park SECTION 2'], ['Park UNIT 1', 'Park UNIT 2'],
  ['Park 1 2', 'Park 1 3'], ['Park PHASE 1', 'Park 2'],
  ['Park PHASE 1', 'Park PH 1', 'Park PHASE 2'],
]) test(`ambiguous/unsupported whole families remain standalone: ${labels.join(' / ')}`, () => {
  const { catalog } = fixture(labels), model = build(catalog); complete(catalog, model);
  assert.equal(model.families.length, labels.length); assert.ok(model.families.every(f => f.basis === 'standalone'));
  for (let i = 0; i < labels.length; i++) assert.equal(family(model, i + 1).label, labels[i]);
});

for (const labels of [['Park', 'Park 1', 'Park 2'], ['Park', 'Park PHASE 1', 'Park PHASE 2']]) {
  test(`generic base stays separate without blocking otherwise unambiguous siblings: ${labels.join(' / ')}`, () => {
    const { catalog } = fixture(labels), model = build(catalog); complete(catalog, model);
    assert.equal(model.families.length, 2); assert.equal(family(model, 1).basis, 'standalone');
    assert.deepEqual(family(model, 1).pocket_ids, [pocketId(1)]);
    assert.deepEqual(family(model, 2).pocket_ids, [pocketId(2), pocketId(3)]);
  });
}

for (const county of ['Unknown', 'UNKNOWN COUNTY', 'N/A', '  ']) test(`unknown county is never inferred: ${county}`, () => {
  const { catalog } = fixture([{ label: 'Park 1', county }, { label: 'Park 2', county }]);
  assert.ok(build(catalog).families.every(f => f.basis === 'standalone'));
});

test('zero-member conflict candidate leaves and unassigned accounts are not absorbed into a named family', () => {
  const { catalog } = fixture(['Park 1', { label: 'Park 2', member_count: 0 }, 'Park 4'], { unassigned: ['unresolved'] });
  const model = build(catalog); complete(catalog, model);
  assert.equal(family(model, 2).basis, 'standalone'); assert.equal(family(model, 2).member_count, 0);
  assert.deepEqual(family(model, 1).pocket_ids, [pocketId(1), pocketId(3)]);
  for (const id of ['discovery:unassigned', 'foreign', '__proto__', 'constructor']) assert.equal(find(model, id), null);
});

test('a family is a view only: complete include, phase exclusion, and reopen preserve the exact flat leaf selection', () => {
  const { catalog } = fixture([{ label: 'Park 1', member_count: 3 }, { label: 'Park 4', member_count: 7 },
    { label: 'Unrelated', member_count: 2 }]);
  const model = build(catalog), parent = family(model), unrelated = pocketId(3);
  const initiallySelected = [unrelated], before = JSON.stringify(initiallySelected);
  const included = [...new Set([...initiallySelected, ...parent.pocket_ids])];
  assert.equal(select(catalog, included, 8).pockets[0].account_ids.length, 12);
  const partial = included.filter(id => id !== pocketId(2));
  const saved = JSON.parse(JSON.stringify({ revision: 9, included_recorded_group_ids: partial }));
  const reopened = build(catalog);
  assert.deepEqual(reopened, model); assert.equal(saved.included_recorded_group_ids.filter(id => parent.pocket_ids.includes(id)).length, 1);
  assert.equal(select(catalog, saved.included_recorded_group_ids, saved.revision).pockets[0].account_ids.length, 5);
  const removed = saved.included_recorded_group_ids.filter(id => !parent.pocket_ids.includes(id));
  assert.deepEqual(removed, [unrelated]); assert.deepEqual(select(catalog, [], 10).pockets, []);
  assert.equal(JSON.stringify(initiallySelected), before); assert.ok(!saved.included_recorded_group_ids.includes(parent.id));
});

test('model is detached, deeply immutable, and deterministic under catalog order changes', () => {
  const { catalog } = fixture(['PARK 4', 'Park 1', 'Standalone']), before = JSON.stringify(catalog);
  const a = build(catalog), b = build({ ...catalog, pockets: [...catalog.pockets].reverse() });
  assert.deepEqual(a, b); assert.equal(JSON.stringify(catalog), before);
  for (const value of [a, a.context_ref, a.families, a.family_id_by_pocket_id, ...a.families,
    ...a.families.map(f => f.pocket_ids)]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { a.context_ref.context_sha256 = 'b'.repeat(64); }, TypeError);
  assert.throws(() => a.families.push({}), TypeError);
  assert.throws(() => family(a).pocket_ids.push(pocketId(3)), TypeError);
  assert.throws(() => { a.family_id_by_pocket_id[pocketId(1)] = 'foreign'; }, TypeError);
  assert.ok(a.families.every(f => f.id.startsWith('subdivision-family-v1:') && f.id.length < 300));
});

test('complete 50,000-account / 1,024-leaf catalog keeps every original member and leaf', () => {
  const specs = Array.from({ length: 1024 }, (_, i) => ({ label: `Development ${Math.floor(i / 2)} Gardens PHASE ${i % 2 + 1}`,
    member_count: 48 + (i < 848 ? 1 : 0) }));
  const { catalog } = fixture(specs), model = build(catalog); complete(catalog, model);
  assert.equal(catalog.coverage.discovery_member_count, 50_000); assert.equal(model.families.length, 512);
  assert.equal(model.families.flatMap(f => f.pocket_ids).length, 1024);
  assert.equal(select(catalog, model.families.flatMap(f => f.pocket_ids), 8).pockets[0].account_ids.length, 50_000);
});

test('incomplete catalog returns no derived families rather than a partial-name prefix', () => {
  const { catalog } = fixture(['Park 1', 'Park 2']);
  assert.deepEqual(build({ ...catalog, status: 'incomplete' }), { profile_version: 1,
    context_ref: contextRef, families: [], family_id_by_pocket_id: {} });
});

test('bounds, duplicates, and inconsistent assigned counts fail closed', () => {
  const { catalog } = fixture(['Park 1', 'Park 2']);
  for (const mutate of [
    c => { c.pockets.push(c.pockets[0]); },
    c => { c.pockets[1].account_ids = [...c.pockets[0].account_ids]; },
    c => { c.pockets[0].member_count = 50_001; },
    c => { c.pockets[0].member_count++; },
    c => { c.coverage.assigned_account_count--; },
    c => { c.pockets = Array(1025).fill(c.pockets[0]); },
    c => { c.catalog_version = 3; },
  ]) {
    const bad = structuredClone(catalog); mutate(bad); assert.throws(() => build(bad), TypeError);
  }
});
