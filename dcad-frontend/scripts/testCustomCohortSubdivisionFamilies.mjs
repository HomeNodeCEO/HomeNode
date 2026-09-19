import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkCustomCohortPocketCatalog as check, selectionFromRecordedGroups as select } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { buildCustomCohortSubdivisionFamilies as build,
  buildCustomCohortSubdivisionPhases as phasesFor,
  createCustomCohortSubdivisionPhaseReader as phaseReader,
  customCohortSubdivisionFamilyForPocket as find } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { buildCustomCohortSubdivisionInspection as inspection } from '../src/features/neighborhood/customCohortSubdivisionInspection.ts';

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

test('v3 retains all 1475 recorded leaves through family and phase presentation without changing the selected union', () => {
  const { catalog } = fixture(Array.from({ length: 1475 }, (_, i) => `SYNTHETIC PARK PHASE ${i + 1}`),
    { catalogVersion: 3, unassigned: ['UNRESOLVED'] });
  const before = JSON.stringify(catalog), model = build(catalog); complete(catalog, model);
  const phases = model.families.flatMap(phaseReader(catalog));
  assert.equal(phases.length, 1475);
  const ids = phases.flatMap(p => p.pocket_ids);
  assert.deepEqual([...ids].sort(), catalog.pockets.map(p => p.id).sort());
  const selected = select(catalog, [...ids, 'discovery:unassigned'], 8);
  assert.deepEqual(selected.pockets[0].account_ids, [...catalog.pockets.flatMap(p => p.account_ids), 'UNRESOLVED'].sort());
  assert.equal(JSON.stringify(catalog), before);
});

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

// Full model plus phase bytes captured from the unchanged helper before the
// mixed-name review correction. Already admitted and same-basis refused views
// retain their original IDs, order, labels, counts, and local profile bytes.
for (const [name, specs, bytes, hash] of [
  ['bare', ['MONICA PARK 1', 'MONICA PARK 4', 'MONICA PARK'], 2282,
    '82f17d2538ec36120600a76cda2b75ef6333ab0c015ccf13ad6646b74d8ff4c7'],
  ['explicit', ['Cedar Park PHASE 12', 'cedar  park PH 2', 'CEDAR PARK PHASE 999'], 2077,
    '327f8ea21d57cca29d158e5d438b5ed6a5a220737511b0914ffe69084c4f9ed3'],
  ['aliases', [{ label: 'Park 1', county: 'Dallas' }, { label: 'Park 1', county: 'DALLAS COUNTY' },
    { label: 'Park 2', county: 'Dallas' }], 1914,
    '30e33df7bc3468ca9c403bf24e59e5e438c66449cbb23e0d1a6bf19184654c0e'],
  ['ambiguous', ['Park PHASE 1', 'Park PH 1', 'Park PHASE 2'], 2441,
    '7326549762994d1c42a1b126b8a6490ae51d0eccc51d2e5e70f28caae96ee966'],
]) test(`pre-change full family and phase bytes remain exact: ${name}`, () => {
  const { catalog } = fixture(specs), families = build(catalog);
  const json = JSON.stringify({ families, phases: families.families.map(phaseReader(catalog)) });
  assert.equal(Buffer.byteLength(json), bytes);
  assert.equal(createHash('sha256').update(json).digest('hex'), hash);
});

for (const countyMode of ['same', 'aliases']) test(`mixed Willow Run review keeps every original phase and exact union: ${countyMode}`, () => {
  const specs = [['WILLOW RUN NO 5', 1], ['WILLOW RUN 3', 1], ['WILLOW RUN 5', 145],
    ['WILLOW RUN PH 2', 67], ['WILLOW RUN 4', 26], ['WILLOW RUN PH 1', 65], ['WILLOW RUN PH 3', 3],
    ['WILLOW RUN', 2], ['Unrelated', 4]].map(([label, member_count], i) => ({ label, member_count,
    county: countyMode === 'aliases' && i % 2 ? 'Dallas' : 'DALLAS COUNTY' }));
  const { catalog } = fixture(specs), before = JSON.stringify(catalog), model = build(catalog), parent = family(model, 3);
  complete(catalog, model); assert.equal(model.families.length, 4);
  assert.equal(parent.label, 'WILLOW RUN'); assert.equal(parent.basis, 'candidate_numbered_name');
  assert.equal(parent.member_count, 307); assert.deepEqual(parent.pocket_ids, [6, 4, 2, 7, 5, 3].map(pocketId));
  for (const i of [1, 8, 9]) assert.equal(family(model, i).basis, 'standalone');
  const phases = phasesFor(catalog, parent);
  assert.deepEqual(phases.map(p => p.label), ['WILLOW RUN PH 1', 'WILLOW RUN PH 2', 'WILLOW RUN 3',
    'WILLOW RUN PH 3', 'WILLOW RUN 4', 'WILLOW RUN 5']);
  assert.deepEqual(phases.map(p => p.member_count), [65, 67, 1, 3, 26, 145]);
  assert.ok(phases.every(p => p.pocket_ids.length === 1 && p.id === p.pocket_ids[0]));
  assert.deepEqual(phases.flatMap(p => p.pocket_ids), parent.pocket_ids);
  const batch = inspection(catalog, parent), batchAccounts = batch.pockets.flatMap(p => p.account_ids);
  assert.equal(batch.pockets.length, 6); assert.equal(batchAccounts.length, 307);
  assert.equal(new Set(batchAccounts).size, 307);
  assert.deepEqual([...batchAccounts].sort(), [...select(catalog, parent.pocket_ids, 8).pockets[0].account_ids].sort());
  const outside = [1, 8, 9].map(pocketId), all = [...outside, ...parent.pocket_ids];
  assert.equal(select(catalog, all, 8).pockets[0].account_ids.length, 314);
  for (const [index, removedCount] of [[2, 1], [7, 3]]) {
    const selected = all.filter(id => id !== pocketId(index));
    assert.equal(select(catalog, selected, 9).pockets[0].account_ids.length, 314 - removedCount);
    assert.ok(selected.includes(pocketId(index === 2 ? 7 : 2)), 'the other recorded phase 3 remains independently selected');
    const saved = JSON.parse(JSON.stringify({ revision: 9, included_recorded_group_ids: selected }));
    assert.deepEqual(build(catalog), model); assert.deepEqual(saved.included_recorded_group_ids, selected);
    assert.deepEqual(selected.filter(id => !parent.pocket_ids.includes(id)), outside);
  }
  const reversed = { ...catalog, pockets: [...catalog.pockets].reverse() };
  assert.deepEqual(build(reversed), model);
  assert.deepEqual(phasesFor(reversed, { ...parent, pocket_ids: [...parent.pocket_ids].reverse() }), phases);
  assert.throws(() => phasesFor(catalog, { ...parent, basis: 'explicit_phase_name' }), TypeError);
  for (const value of [model, parent, parent.pocket_ids, phases, ...phases, ...phases.map(p => p.pocket_ids)]) assert.ok(Object.isFrozen(value));
  assert.equal(JSON.stringify(catalog), before);
});

test('mixed grammar uses exact-name county aliases only within each separate phase row', () => {
  const { catalog } = fixture([{ label: 'Park PH 1', county: 'Dallas', member_count: 5 },
    { label: 'Park 1', county: 'DALLAS COUNTY', member_count: 3 },
    { label: 'Park 1', county: 'Dallas', member_count: 2 },
    { label: 'Park PH 1', county: 'DALLAS COUNTY', member_count: 7 }]);
  const model = build(catalog), parent = family(model), phases = phasesFor(catalog, parent);
  complete(catalog, model); assert.equal(model.families.length, 1); assert.equal(parent.member_count, 17);
  assert.equal(parent.basis, 'candidate_numbered_name');
  assert.deepEqual(phases.map(p => [p.label, p.member_count, p.pocket_ids]), [
    ['Park 1', 5, [pocketId(2), pocketId(3)]], ['Park PH 1', 12, [pocketId(1), pocketId(4)]],
  ]);
  assert.deepEqual(phases.flatMap(p => p.pocket_ids), parent.pocket_ids);
  const reversed = { ...catalog, pockets: [...catalog.pockets].reverse() };
  assert.deepEqual(build(reversed), model);
  assert.deepEqual(phasesFor(reversed, { ...parent, pocket_ids: [...parent.pocket_ids].reverse() }), phases);
});

for (const labels of [['Park PHASE 1', 'Park 2'], ['Park 1', 'Park PH 1', 'Park 2'],
  ['Park 5 SEC 2', 'Park PH 5 SEC 2', 'Park 6']]) {
  test(`mixed forms share a candidate parent without merging raw phase rows: ${labels.join(' / ')}`, () => {
    const { catalog } = fixture(labels), model = build(catalog), parent = family(model);
    complete(catalog, model); assert.equal(model.families.length, 1); assert.equal(parent.basis, 'candidate_numbered_name');
    assert.equal(phasesFor(catalog, parent).length, labels.length);
    assert.deepEqual(phasesFor(catalog, parent).map(p => p.label).sort(), [...labels].sort());
  });
}

for (const labels of [['Park PHASE 1', 'Park PH 1', 'Park 2'],
  ['Park 5 SEC 2', 'Park 5 SECTION 2', 'Park PH 6'], ['Park 1', 'Park 1', 'Park PH 2']]) {
  test(`a mixed member never overrides same-grammar ambiguity: ${labels.join(' / ')}`, () => {
    const { catalog } = fixture(labels), model = build(catalog);
    complete(catalog, model); assert.ok(model.families.every(f => f.basis === 'standalone'));
    assert.ok(model.families.every(f => phasesFor(catalog, f).length === 1));
  });
}

test('mixed grammar does not relax exact base, county, unknown, or zero-member isolation', () => {
  const { catalog } = fixture([{ label: 'Park North 1', county: 'Dallas' },
    { label: 'Park North PH 2', county: 'DALLAS COUNTY' },
    { label: 'Park North 1', county: 'Collin' }, { label: 'Park North PH 2', county: 'Collin County' },
    { label: 'Park North 1', county: 'Unknown' }, { label: 'Park North PH 2', county: 'Unknown' },
    { label: 'Park North 1', county: 'Travis' }, { label: 'Park North PH 2', county: 'Travis County' },
    'Park South PH 3', 'Park-North PH 3', { label: 'Park North PH 3', member_count: 0 }]);
  const model = build(catalog); complete(catalog, model);
  assert.deepEqual(family(model, 1).pocket_ids, [1, 2].map(pocketId));
  assert.deepEqual(family(model, 3).pocket_ids, [3, 4].map(pocketId));
  for (const id of [5, 6, 7, 8, 9, 10, 11]) assert.equal(family(model, id).basis, 'standalone');
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

test('mirrored Monica Park phases across Dallas aliases keep the complete roster and exact phase unions', () => {
  const specs = Array.from({ length: 5 }, (_, i) => [
    { label: `MONICA PARK ${i + 1}`, county: 'Dallas', member_count: i + 2 },
    { label: `MONICA PARK ${i + 1}`, county: 'DALLAS COUNTY', member_count: i + 7 },
  ]).flat();
  specs.push({ label: 'MONICA PARK 6', county: 'DALLAS COUNTY', member_count: 13 },
    { label: 'MONICA PARK 5 SEC 2', county: 'Dallas', member_count: 17 },
    { label: 'MONICA PARK 5 SEC 2', county: 'DALLAS COUNTY', member_count: 19 },
    { label: 'MONICA PARK', county: 'Dallas', member_count: 23 },
    { label: 'MONICA PARK HEIGHTS 1', county: 'Dallas', member_count: 29 },
    { label: 'MONICA PARK HEIGHTS 2', county: 'Dallas', member_count: 31 });
  const { catalog } = fixture(specs), model = build(catalog), parent = family(model);
  complete(catalog, model); assert.equal(model.families.length, 3);
  assert.equal(parent.label, 'MONICA PARK'); assert.equal(parent.basis, 'candidate_numbered_name');
  assert.equal(parent.member_count, 114); assert.equal(parent.pocket_ids.length, 13);
  assert.equal(family(model, 14).basis, 'standalone'); assert.equal(family(model, 14).label, 'MONICA PARK');
  assert.equal(family(model, 15).label, 'MONICA PARK HEIGHTS');
  const phases = phasesFor(catalog, parent);
  assert.equal(phases.length, 7);
  assert.deepEqual(phases.map(p => p.label), ['MONICA PARK 1', 'MONICA PARK 2', 'MONICA PARK 3',
    'MONICA PARK 4', 'MONICA PARK 5', 'MONICA PARK 5 SEC 2', 'MONICA PARK 6']);
  assert.deepEqual(phases.map(p => p.member_count), [9, 11, 13, 15, 17, 36, 13]);
  assert.deepEqual(phases.map(p => p.id), [1, 3, 5, 7, 9, 12, 11].map(pocketId));
  assert.deepEqual(phases.flatMap(p => p.pocket_ids), parent.pocket_ids);
  assert.equal(phases.reduce((sum, p) => sum + p.member_count, 0), parent.member_count);
  for (let i = 0; i < 5; i++) assert.deepEqual(phases[i].pocket_ids, [pocketId(2 * i + 1), pocketId(2 * i + 2)]);
  const allIds = [...parent.pocket_ids, pocketId(14)], included = select(catalog, allIds, 8);
  assert.equal(included.pockets[0].account_ids.length, 137);
  const excluded = allIds.filter(id => !phases[4].pocket_ids.includes(id));
  assert.equal(select(catalog, excluded, 9).pockets[0].account_ids.length, 120);
  assert.ok(phases[5].pocket_ids.every(id => excluded.includes(id)), 'excluding phase 5 does not silently exclude its separate section row');
  const saved = JSON.parse(JSON.stringify({ revision: 9, included_recorded_group_ids: excluded }));
  assert.deepEqual(phasesFor(catalog, family(build(catalog))), phases);
  assert.deepEqual(saved.included_recorded_group_ids, excluded);
  assert.ok(!saved.included_recorded_group_ids.includes(parent.id));
});

test('known alias collapse requires exact normalized full names, not equivalent-looking marker syntax', () => {
  const { catalog } = fixture([{ label: 'Cedar  Park PHASE 1', county: 'Dallas', member_count: 2 },
    { label: ' cedar park phase 1 ', county: 'Dallas County', member_count: 3 },
    { label: 'Cedar Park PHASE 2', county: 'Dallas County', member_count: 5 }]);
  const model = build(catalog), phases = phasesFor(catalog, family(model));
  assert.equal(model.families.length, 1); assert.equal(phases.length, 2);
  assert.deepEqual(phases[0].pocket_ids, [pocketId(1), pocketId(2)]); assert.equal(phases[0].member_count, 5);
  assert.ok(catalog.pockets.some(p => p.label === phases[0].label));
  for (const labels of [['Park PHASE 1', 'Park PH 1', 'Park PHASE 2'],
    ['Park 5 SEC 2', 'Park 5 SECTION 2', 'Park 6']]) {
    const { catalog: ambiguous } = fixture(labels.map((label, i) => ({ label, county: i === 1 ? 'DALLAS COUNTY' : 'Dallas' })));
    const view = build(ambiguous); complete(ambiguous, view);
    assert.ok(view.families.every(f => f.basis === 'standalone'));
    assert.ok(view.families.every(f => phasesFor(ambiguous, f).length === 1));
  }
});

test('same-name county aliases alone can form one review phase without minting an original ID', () => {
  const { catalog } = fixture([{ label: 'MONICA PARK 4', county: 'Dallas' }, { label: 'MONICA PARK 4', county: 'DALLAS COUNTY' }]);
  const model = build(catalog), phases = phasesFor(catalog, family(model));
  assert.equal(model.families.length, 1); assert.equal(phases.length, 1);
  assert.equal(phases[0].id, pocketId(1)); assert.deepEqual(phases[0].pocket_ids, [pocketId(1), pocketId(2)]);
});

test('duplicate suffixes without a distinct recognized county spelling stay ambiguous', () => {
  for (const counties of [['Dallas', 'Dallas'], ['Dallas', ' dallas '], ['DALLAS COUNTY', 'Dallas County'],
    ['Travis', 'Travis'], ['Travis', 'Travis County'], ['Unknown', 'UNKNOWN COUNTY']]) {
    const { catalog } = fixture([{ label: 'Park 1', county: counties[0] },
      { label: 'Park 1', county: counties[1] }, { label: 'Park 2', county: counties[0] }]);
    const model = build(catalog); complete(catalog, model);
    if (counties[0] === 'Travis' && counties[1] === 'Travis County') {
      assert.deepEqual(family(model, 1).pocket_ids, [pocketId(1), pocketId(3)]);
      assert.equal(family(model, 2).basis, 'standalone');
    } else assert.ok(model.families.every(f => f.basis === 'standalone'));
  }
  const { catalog } = fixture(['Dallas', 'DALLAS COUNTY', 'Collin', 'COLLIN COUNTY'].flatMap(county =>
    [1, 2].map(n => ({ label: `Park ${n}`, county }))));
  const model = build(catalog); assert.equal(model.families.length, 2); complete(catalog, model);
  assert.deepEqual(phasesFor(catalog, family(model)).map(p => p.pocket_ids), [[pocketId(1), pocketId(3)], [pocketId(2), pocketId(4)]]);
  assert.deepEqual(phasesFor(catalog, family(model, 5)).map(p => p.pocket_ids), [[pocketId(5), pocketId(7)], [pocketId(6), pocketId(8)]]);
});

test('one bounded nested section remains a distinct phase row under the exact recognized base', () => {
  for (const phaseMarker of ['', 'PH ', 'PHASE ']) {
    const { catalog } = fixture([`Monica Park ${phaseMarker}5 SECTION 999`, `Monica Park ${phaseMarker}5`,
      `Monica Park ${phaseMarker}5 SEC 2`, `Monica Park ${phaseMarker}6`]);
    const model = build(catalog), parent = family(model); complete(catalog, model);
    assert.equal(model.families.length, 1); assert.equal(parent.label, 'Monica Park');
    assert.deepEqual(parent.pocket_ids, [2, 3, 1, 4].map(pocketId));
    assert.deepEqual(phasesFor(catalog, parent).map(p => p.id), [2, 3, 1, 4].map(pocketId));
  }
  for (const unsupported of ['MONICA PARK 5 SEC 0', 'MONICA PARK 5 SEC 01', 'MONICA PARK 5 SEC 1000',
    'MONICA PARK 5 SEC II', 'MONICA PARK 5 SEC2', 'MONICA PARK5 SEC 2', 'MONICA PARK 5 SEC 2 SEC 3',
    'MONICA PARK SECTION 2', 'MONICA PARK 5 UNIT 2', 'MONICA PARK 5 2', 'Route 66 5 SEC 2']) {
    const { catalog } = fixture(['MONICA PARK 1', 'MONICA PARK 6', unsupported]);
    const model = build(catalog); complete(catalog, model);
    assert.equal(family(model, 3).basis, 'standalone', unsupported);
    assert.deepEqual(family(model).pocket_ids, [pocketId(1), pocketId(2)]);
  }
});

test('phase projection is immutable, order-independent, metadata-only and rejects foreign or partial families', () => {
  const { catalog } = fixture([{ label: 'Park 1', county: 'Dallas' }, { label: 'Park 1', county: 'DALLAS COUNTY' },
    { label: 'Park 2', county: 'Dallas' }, { label: 'Unrelated', county: 'Dallas' }]);
  const parent = family(build(catalog)), before = JSON.stringify(catalog), phases = phasesFor(catalog, parent);
  const metadataOnly = { ...catalog, pockets: catalog.pockets.map(p => ({ ...p,
    get account_ids() { throw new Error('phase projection must not rescan account arrays'); } })) };
  assert.deepEqual(phasesFor(metadataOnly, { ...parent, pocket_ids: [...parent.pocket_ids].reverse() }), phases);
  assert.deepEqual(phasesFor({ ...catalog, pockets: [...catalog.pockets].reverse() }, parent), phases);
  assert.equal(JSON.stringify(catalog), before);
  for (const value of [phases, ...phases, ...phases.map(p => p.pocket_ids)]) assert.ok(Object.isFrozen(value));
  assert.throws(() => phases[0].pocket_ids.push('foreign'), TypeError);
  assert.throws(() => { phases[0].member_count = 100; }, TypeError);
  for (const change of [{ id: 'foreign' }, { label: 'Park Other' }, { county: 'Collin' }, { basis: 'standalone' },
    { member_count: parent.member_count + 1 }, { pocket_ids: [pocketId(1), pocketId(2)] },
    { pocket_ids: [pocketId(1), pocketId(2), pocketId(4)] }, { pocket_ids: [pocketId(1), pocketId(1), pocketId(3)] },
    { pocket_ids: [] }, { pocket_ids: ['foreign'] }]) {
    assert.throws(() => phasesFor(catalog, { ...parent, ...change }), TypeError);
  }
  assert.deepEqual(phasesFor({ ...catalog, status: 'incomplete' }, parent), []);
});

test('prepared phase reader owns a detached metadata snapshot, not a hidden mutable catalog cache', () => {
  const { catalog } = fixture([{ label: 'Park 1', county: 'Dallas' }, { label: 'Park 1', county: 'DALLAS COUNTY' }, 'Park 2']);
  const parent = family(build(catalog)), mutable = structuredClone(catalog), reader = phaseReader(mutable);
  const expected = reader(parent);
  mutable.pockets[0].label = 'Changed 1'; mutable.pockets[0].member_count = 100;
  assert.deepEqual(reader(parent), expected);
  assert.throws(() => phaseReader(mutable)(parent), TypeError);
  mutable.pockets.length = 0;
  assert.deepEqual(reader(parent), expected);
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
  ['Park 1 2', 'Park 1 3'],
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

for (const grammar of ['explicit', 'mixed']) test(`complete 50,000-account / 1,024-leaf catalog keeps every original member and leaf: ${grammar}`, () => {
  const specs = Array.from({ length: 1024 }, (_, i) => ({ label: `Development ${Math.floor(i / 2)} Gardens ${grammar === 'mixed' && i % 2 === 0 ? '' : 'PHASE '}${i % 2 + 1}`,
    member_count: 48 + (i < 848 ? 1 : 0) }));
  const { catalog } = fixture(specs), model = build(catalog); complete(catalog, model);
  assert.equal(catalog.coverage.discovery_member_count, 50_000); assert.equal(model.families.length, 512);
  assert.equal(model.families.flatMap(f => f.pocket_ids).length, 1024);
  assert.equal(select(catalog, model.families.flatMap(f => f.pocket_ids), 8).pockets[0].account_ids.length, 50_000);
  let metadataReads = 0;
  const metadataOnly = { ...catalog, pockets: catalog.pockets.map(p => ({ ...p,
    get label() { metadataReads++; return p.label; },
    get account_ids() { throw new Error('prepared phase reader must not scan account arrays'); } })) };
  const reader = phaseReader(metadataOnly);
  assert.equal(metadataReads, 1024);
  const phases = model.families.flatMap(reader);
  assert.equal(metadataReads, 1024, 'all 512 family projections share exactly one catalog metadata traversal');
  assert.equal(phases.length, 1024); assert.equal(phases.reduce((sum, p) => sum + p.member_count, 0), 50_000);
  assert.deepEqual(phases.flatMap(p => p.pocket_ids).sort(), catalog.pockets.map(p => p.id).sort());
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
    c => { c.catalog_version = 4; },
  ]) {
    const bad = structuredClone(catalog); mutate(bad); assert.throws(() => build(bad), TypeError);
  }
});
