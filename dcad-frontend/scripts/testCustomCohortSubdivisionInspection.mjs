import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortSubdivisionFamilies, buildCustomCohortSubdivisionPhases } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { buildCustomCohortSubdivisionInspection as batch, CUSTOM_SUBDIVISION_INSPECTION_PHASE_LIMIT as limit } from '../src/features/neighborhood/customCohortSubdivisionInspection.ts';
import { fingerprintCustomCohortSelection } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { selectionFromRecordedGroups } from '../src/features/neighborhood/customCohortPocketCatalog.ts';

function fixture(count = 3) {
  const pockets = Array.from({ length: count }, (_, i) => ({ id: `recorded-cad:${String(i).padStart(64, '0')}`,
    label: `SYNTHETIC PARK PHASE ${i + 1}`, county: 'Dallas', member_count: 2, account_ids: [`A${i}`, `B${i}`] }));
  pockets.push({ ...pockets[0], id: 'recorded-cad:alias', county: 'DALLAS COUNTY', account_ids: ['ALIAS'], member_count: 1 });
  const catalog = { status: 'review_only', catalog_version: 2, binding: { context_ref: {
    context_id: '30000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) }, selection_revision: 8 },
    pockets, unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
    coverage: { discovery_member_count: count * 2 + 1, assigned_account_count: count * 2 + 1, unassigned_account_count: 0 },
    subject_membership: { account_id: 'A0', assigned_pocket_id: pockets[0].id, recorded_label_match_only: true } };
  return { catalog, family: buildCustomCohortSubdivisionFamilies(catalog).families[0] };
}

test('batch preserves exact parent union and each full aliased phase without saved-selection mutations', async () => {
  const { catalog, family } = fixture(), before = JSON.stringify(catalog), selection = batch(catalog, family);
  assert.equal(selection.pockets.length, 3); assert.equal(selection.revision, 1);
  assert.deepEqual(selection.pockets.flatMap(p => p.account_ids).sort(), selectionFromRecordedGroups(catalog, family.pocket_ids, 1).pockets[0].account_ids);
  for (const phase of buildCustomCohortSubdivisionPhases(catalog, family)) {
    assert.deepEqual(selection.pockets.find(p => p.id === phase.id).account_ids,
      selectionFromRecordedGroups(catalog, phase.pocket_ids, 1).pockets[0].account_ids);
  }
  assert.equal(selection.pockets[0].account_ids.length, 3); assert.equal(JSON.stringify(catalog), before);
  assert.ok(Object.isFrozen(selection.pockets));
  const input = { accountId: 'A0', assignmentFileId: '7', contextRef: catalog.binding.context_ref, selection };
  assert.match(await fingerprintCustomCohortSelection(input), /^[a-f0-9]{64}$/);
});

test('batch limits do not truncate large families or private-supplement statistics', () => {
  for (const size of [1, limit + 1]) { const f = fixture(size); assert.equal(batch(f.catalog, f.family), null); }
  const f = fixture(limit); assert.equal(batch(f.catalog, f.family).pockets.length, limit);
  assert.equal(batch({ ...f.catalog, private_sales: {} }, f.family), null);
});

test('mismatched family membership is rejected, not repaired or partially inspected', () => {
  const f = fixture(); assert.throws(() => batch(f.catalog, { ...f.family, member_count: 99 }), /subdivision/);
  assert.throws(() => batch(f.catalog, { ...f.family, pocket_ids: [...f.family.pocket_ids, 'not-retained'] }));
});

test('catalog names at the request label boundary batch; longer literals fall back without truncation', async () => {
  for (const length of [200, 201, 512]) {
    const { catalog } = fixture(2);
    const renamed = { ...catalog, pockets: catalog.pockets.map(p => ({ ...p,
      label: `${'P'.repeat(length - 8)} PHASE ${p.label.endsWith('2') ? '2' : '1'}` })) };
    const family = buildCustomCohortSubdivisionFamilies(renamed).families[0], before = JSON.stringify(renamed);
    const selection = batch(renamed, family);
    if (length === 200) {
      assert.equal(selection.pockets[0].label.length, 200);
      assert.match(await fingerprintCustomCohortSelection({ accountId: 'A0', assignmentFileId: '7', contextRef: catalog.binding.context_ref, selection }), /^[a-f0-9]{64}$/);
    } else assert.equal(selection, null);
    assert.equal(JSON.stringify(renamed), before);
  }
});
