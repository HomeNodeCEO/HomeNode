import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCustomCohortPocketCatalog as check, customCohortCatalogGroupIds as groups,
  selectionFromRecordedGroups as select, CUSTOM_COHORT_UNASSIGNED_GROUP as unresolved } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedAccountRow, mapCachedParcelRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from '../../server/test/fixtures/customCohortContextFixture.js';

// Actual mapper -> retained observation -> catalog -> public presenter -> browser
// admission. Synthetic observations do not establish live provider coverage.
function fixture() {
  const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
  const target = { ...contextFixture().target, account_id: '00001', assignment_file_id: '9007199254740993' };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(k => [k, target[k]]));
  const ids = ['00001', 'R-2', 'other'];
  const accountRows = ids.map((id, i) => ({ account_id: id, county: i === 2 ? null : 'Dallas', subdivision: i === 0 ? 'Cedar' : 'Oak' }));
  const parcelRows = ids.map((id, i) => ({ object_id: String(i + 1), account_id: id, subdivision_name: i === 0 ? 'CEDAR' : 'Oak' }));
  const wrap = (rows, mapper) => rows.map(row => { const mapped = mapper(row); return { record_id: mapped.record_id, data: mapped }; });
  const records = { selection: ids.map(account_id => ({ record_id: account_id, data: { account_id } })),
    accounts: wrap(accountRows, mapCachedAccountRow), parcels: wrap(parcelRows, mapCachedParcelRow), transactions: [], sale_links: [], gis_sync: [] };
  const now = '2026-09-06T08:00:00.123Z';
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(records).map(([role, rows]) => ({
    upstream: { id: `cache:${role}`, key: role, state: rows.length ? 'populated' : 'present_empty', complete: true, revision: 'fixture-v2',
      content_sha256: 'a'.repeat(64), captured_at: now, visibility: 'assignment_private', scope, row_count: rows.length },
    metadata: { id: `cache-${role}`, provider: 'Synthetic cache', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: now, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true, input_row_count: rows.length, output_record_count: rows.length }, records: rows })) });
  assert.equal(capture.status, 'ready');
  const observation_period = { start_date: '2023-07-01', end_date: '2024-06-30' };
  const retained_inputs = { subject: { target, effective_date: '2024-06-30' }, study: { observation_period },
    spatial: { query_complete: true, account_ids: ids, parcels: parcelRows.map(({ object_id, account_id }) => ({ object_id, account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: ids }, capture_result: { query_complete: true, captured_at: now, source_capture: capture } } };
  const selection = { revision: 1, pockets: [] };
  const preview = buildCustomCohortObservationPreview({ context_ref, retained_inputs, selection });
  const catalog = presentCustomCohortPocketCatalog({ catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview }), preview,
    expected: { context_ref, selection_revision: 1 } });
  return { input: { accountId: target.account_id, assignmentFileId: target.assignment_file_id, contextRef: context_ref, selection },
    response: { status: 'catalog', target: { account_id: target.account_id, assignment_file_id: target.assignment_file_id },
      context_ref, selection_revision: 1, subject_freshness: 'matched', catalog,
      apply: { status: 'blocked', reasons: ['observation_preview_only'] } } };
}

test('actual server catalog preserves exact IDs, all groups, unresolved members and immutable boundaries', () => {
  const { input, response } = fixture(), catalog = check(response, input);
  assert.equal(catalog.pockets.length, 2); assert.equal(catalog.coverage.discovery_member_count, 3);
  assert.deepEqual(catalog.unassigned.account_ids, ['other']); assert.ok(Object.isFrozen(catalog.pockets));
  assert.deepEqual(select(catalog, groups(catalog), 2).pockets[0].account_ids, ['00001', 'R-2', 'other']);
  assert.equal(catalog.subject_membership.account_id, '00001');
  assert.equal(catalog.subject_membership.assigned_pocket_id, catalog.pockets.find(p => p.account_ids.includes('00001')).id);
});

test('clearing all remains an empty selection instead of defaulting to nearby sales', () => {
  const { input, response } = fixture(), catalog = check(response, input);
  assert.deepEqual(select(catalog, [], 3), { revision: 3, pockets: [] });
  assert.deepEqual(select(catalog, [unresolved], 4).pockets[0].account_ids, ['other']);
});

for (const [name, mutate] of [
  ['wrong file', r => { r.target.assignment_file_id = '17'; }],
  ['rounded file', r => { r.target.assignment_file_id = 9007199254740993; }],
  ['wrong account', r => { r.target.account_id = '1'; }],
  ['wrong context', r => { r.context_ref.context_id = 'other'; }],
  ['wrong inner context', r => { r.catalog.binding.context_ref.context_sha256 = 'f'.repeat(64); }],
  ['wrong revision', r => { r.selection_revision = 2; }],
  ['wrong catalog revision', r => { r.catalog.binding.selection_revision = 2; }],
  ['stale subject', r => { r.subject_freshness = 'changed'; }],
  ['unblocked Apply', r => { r.catalog.apply.status = 'ready'; }],
  ['duplicate member', r => { r.catalog.unassigned.account_ids = ['00001']; }],
  ['duplicate group', r => { r.catalog.pockets[1].id = r.catalog.pockets[0].id; }],
  ['lying count', r => { r.catalog.coverage.discovery_member_count = 30; }],
  ['subject in wrong group', r => { r.catalog.subject_membership.assigned_pocket_id = r.catalog.pockets.find(p => !p.account_ids.includes('00001')).id; }],
  ['truncated incomplete groups', r => { r.catalog.status = 'incomplete'; }],
]) test(`refuses ${name}`, () => {
  const { input, response } = fixture(), altered = structuredClone(response); mutate(altered);
  assert.throws(() => check(altered, input), /Invalid/);
});

test('128 groups plus unresolved accounts are not clipped to a 128-pocket submission', () => {
  const { input, response } = fixture(), altered = structuredClone(response), c = altered.catalog;
  c.pockets = Array.from({ length: 128 }, (_, i) => ({ id: `recorded-cad:${i}`, label: `Group ${i}`, county: 'Dallas',
    account_ids: [i ? `id-${i}` : '00001'], member_count: 1, disposition: 'needs_review' }));
  c.subject_membership.assigned_pocket_id = c.pockets[0].id;
  c.coverage = { discovery_member_count: 129, assigned_account_count: 128, unassigned_account_count: 1 };
  const catalog = check(altered, input), all = select(catalog, groups(catalog), 2);
  assert.equal(all.pockets.length, 1); assert.equal(all.pockets[0].account_ids.length, 129);
  assert.ok(all.pockets[0].account_ids.includes('other'));
});

test('unknown, duplicate groups and bad revisions cannot change selection membership', () => {
  const { input, response } = fixture(), catalog = check(response, input), id = catalog.pockets[0].id;
  for (const [ids, revision] of [[['unknown'], 1], [[id, id], 1], [[id], 0], [[id], NaN]]) assert.throws(() => select(catalog, ids, revision));
});

test('catalog admission retains full labels but never forwards private response extensions', () => {
  const { input, response } = fixture(), altered = structuredClone(response);
  altered.catalog.pockets[0].label = '<img src=x onerror=alert(1)>'.repeat(10);
  altered.catalog.private_source_record = 'never-forward';
  const catalog = check(altered, input);
  assert.equal(catalog.pockets[0].label, altered.catalog.pockets[0].label);
  assert.equal(JSON.stringify(catalog).includes('never-forward'), false);
});
