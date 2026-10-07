import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortPreparedSelectionRegistry as registry } from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogRegistry.js';
import { createCustomCohortRecordedGroupSelectionOwner as createOwner } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelectionOwner.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCustomCohortGroupSelectionRepository } from '../src/services/neighborhoodAssessment/customCohortGroupSelectionRepository.js';
import { createCohortPagedGroupSelectionV1Store } from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { prepareCustomCohortRecordedGroupSelection as derive } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { customCohortPreparedCatalogSqlFixture as sqlFixture } from './fixtures/customCohortPreparedCatalogSqlFixture.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from './fixtures/customCohortPreparedCatalogRegistryFixture.js';

// Actual original compiler, registry, staging and unchanged head repository.
// This SQL protocol fixture is not proof of current authorization or native
// transactions; the guarded PostgreSQL current-owner suite proves those too.
async function harness({ count = 501, groupCount = 7, prepared = true } = {}) {
  const hooks = {}, h = sqlFixture(fixture({ count, groupCount }), hooks), { scope, context } = h.f;
  if (prepared) await h.make().prepareMembership();
  const state = { head: null, actor: randomUUID(), retained: true, allowed: true, finalAllowed: true, before: null };
  const revisions = new Map(), operations = new Map(), calls = [];
  const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [{ ...value }] : [] });
  const client = { release() { assert.fail('caller owns release'); }, async query(sql, args = []) {
    const tag = /\/\* ([^*]+) \*\//.exec(sql)?.[1]; calls.push(tag); await state.before?.(tag);
    if (tag === 'custom-cohort-group-selection:transaction') return row({ transaction_id: '77' });
    if (tag === 'custom-cohort-group-selection:target') return row(context);
    if (tag === 'custom-cohort-group-selection:head') return row(revisions.get(state.head));
    if (tag === 'custom-cohort-group-selection:operation') return row(operations.get(args[1]));
    if (tag === 'custom-cohort-group-selection:insert') {
      const value = { selection_revision: String(args[7]), operation_id: args[8], request_sha256: args[9],
        selection_sha256: args[10], manifest_content_sha256: args[11], manifest_canonical_utf8_bytes: args[12] };
      revisions.set(args[7], value); operations.set(args[8], value); return row(value);
    }
    if (tag === 'custom-cohort-group-selection:head-insert') {
      assert.equal(state.head, null); state.head = args[2]; return row({ selection_revision: String(args[2]) });
    }
    if (tag === 'custom-cohort-group-selection:head-update') {
      assert.equal(state.head, args[3]); state.head = args[2]; return row({ selection_revision: String(args[2]) });
    }
    if (tag === 'neighborhood-cohort-blob:read-batch') {
      const rows = args[1].flatMap(hash => {
        const text = h.originals.get(`${args[0]}:${hash}`);
        return text === undefined ? [] : [{ content_sha256: hash,
          canonical_utf8_bytes: String(Buffer.byteLength(text)), canonical_utf8: text }];
      });
      return { rowCount: rows.length, rows };
    }
    return h.client.query(sql, args);
  } };
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const owner = createOwner({ identityOf: v => ({ auth: v.auth, accountId: v.accountId, assignmentFileId: v.assignmentFileId }),
    execute: async (input, options, write, work) => {
      if (!state.allowed) throw new Error('current rights denied');
      const snapshot = { head: state.head, maps: [h.originals, revisions, operations].map(m => new Map(m)) };
      try {
        const budget = { signal: options.signal, check() { if (options.signal?.aborted) throw new Error('cancelled'); } };
        const owned = { client, auth: { userId: state.actor }, scopeJson: json(scope), budget, blobs };
        if (state.retained) {
          owned.retainedSelection = registry(client, json(scope), json(context), { signal: budget.signal, checkBudget: budget.check });
          for (const key of ['catalogJson', 'rosterJson']) Object.defineProperty(owned, key,
            { get() { assert.fail('prepared selection may not open dense inputs'); } });
        } else Object.assign(owned, { catalogJson: JSON.stringify(h.f.catalog),
          rosterJson: JSON.stringify({ account_ids: h.f.preview.all.account_ids }) });
        const result = await work(owned);
        if (!state.finalAllowed) throw new Error('ending rights denied');
        budget.check(); return result;
      } catch (error) {
        state.head = snapshot.head;
        [h.originals, revisions, operations].forEach((m, i) => { m.clear(); for (const [k, v] of snapshot.maps[i]) m.set(k, v); });
        throw error;
      }
    } });
  const read = { auth: { userId: state.actor }, accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, contextRef: context };
  const ids = h.f.catalog.pockets.map(p => p.id); if (h.f.catalog.unassigned.member_count) ids.push('discovery:unassigned');
  const select = { ...read, operationId: randomUUID(), expectedSelectionRef: null, includedRecordedGroupIds: ids };
  const command = v => json({ command_version: 1, actor_user_id: state.actor, operation_id: v.operationId,
    expected_selection_ref: v.expectedSelectionRef, included_recorded_group_ids: [...v.includedRecordedGroupIds].sort(),
    selection_revision: (v.expectedSelectionRef?.selection_revision ?? 0) + 1 });
  const legacy = async (v, version = 2) => derive({ scopeJson: json(scope), contextJson: json(context),
    catalogJson: JSON.stringify(h.f.catalog), rosterJson: JSON.stringify({ account_ids: h.f.preview.all.account_ids }),
    includedGroupIds: v.includedRecordedGroupIds, revision: (v.expectedSelectionRef?.selection_revision ?? 0) + 1,
    commandJson: command(v), catalogIdentityVersion: version });
  return { ...h, state, client, blobs, owner, revisions, calls, read, select, legacy };
}

test('SQL-rooted retained path stores the exact existing identity and reopens without dense inputs or writes', async () => {
  const h = await harness({ count: 12001 }), expected = await h.legacy(h.select);
  const exact = await createCohortPagedGroupSelectionV1Store(h.blobs).stage({ metadataJson: expected.metadata_json,
    membershipPages: expected.membershipPages() });
  h.source.compressed_catalog = h.source.compressed_preview = null;
  const from = h.calls.length, first = await h.owner.selectRecordedGroups(h.select);
  assert.deepEqual(first.selection_ref.manifest_ref, exact.manifest_ref);
  assert.equal(first.selection_ref.selection_sha256, exact.selection_sha256); assert.equal(h.state.head, 1);
  assert.deepEqual(await h.owner.selectRecordedGroups(h.select), { ...first, status: 'reused' });
  const saved = [...h.originals], beforeRead = h.calls.length;
  const opened = await h.owner.readRecordedGroupSelection(h.read);
  assert.deepEqual(opened.selection_ref, first.selection_ref); assert.deepEqual(opened.included_recorded_group_ids, [...h.select.includedRecordedGroupIds].sort());
  assert.equal(Object.hasOwn(opened, 'account_ids'), false); assert.equal(Object.hasOwn(opened, 'summary'), false);
  assert.deepEqual([...h.originals], saved);
  assert.ok(!h.calls.slice(beforeRead).some(tag => /insert|update/.test(tag)));
  assert.ok(!h.calls.slice(from).some(tag => /registry:(originals|pins|insert)|membership:insert/.test(tag)));
  assert.ok(h.calls.slice(from).includes('neighborhood-cohort-blob:read-batch'), 'unchanged selected-page verifier keeps its bounded SQL batching');
});

test('empty and unresolved-only selections preserve exact intent, stale heads/replays cannot rewind', async () => {
  const h = await harness({ count: 31, groupCount: 0 }), first = await h.owner.selectRecordedGroups(h.select);
  const empty = await h.owner.selectRecordedGroups({ ...h.select, operationId: randomUUID(), expectedSelectionRef: first.selection_ref,
    includedRecordedGroupIds: [] });
  assert.deepEqual((await h.owner.readRecordedGroupSelection(h.read)).included_recorded_group_ids, []);
  assert.equal(empty.selection_ref.selection_revision, 2);
  await assert.rejects(h.owner.selectRecordedGroups(h.select), /selection_changed/);
  assert.equal(h.state.head, 2); assert.equal(h.revisions.size, 2);
});

test('missing membership is an explicit refusal with no dense fallback or implicit preparation', async () => {
  const h = await harness({ prepared: false }); await h.make().prepare(); const before = [...h.originals];
  assert.equal((await h.owner.readRecordedGroupSelection(h.read)).status, 'absent');
  await assert.rejects(h.owner.selectRecordedGroups(h.select), /membership_not_prepared/);
  assert.deepEqual([...h.originals], before); assert.equal(h.state.head, null); assert.equal(h.memberRoot(), null);
});

test('unselected/later source original loss and ending SQL pins cannot deliver a selected head or provisional bytes', async () => {
  for (const broken of ['page', 'root', 'source']) {
    const h = await harness(), ref = h.memberRoot(), key = digest => `${h.f.scope.organization_id}:${digest}`;
    const w = JSON.parse(h.originals.get(key(ref.witness_sha256)));
    const m = JSON.parse(h.originals.get(key(w.membership_manifest_ref.content_sha256)));
    if (broken === 'page') h.originals.delete(key(m.membership_pages.at(-1).page.content_sha256));
    else h.state.before = tag => { if (tag === 'neighborhood-cohort-blob:insert') {
      if (broken === 'root') h.dropMemberRoot(); else h.source.preview_sha256 = 'f'.repeat(64);
    } };
    const before = [...h.originals];
    await assert.rejects(h.owner.selectRecordedGroups({ ...h.select, includedRecordedGroupIds: h.select.includedRecordedGroupIds.slice(0, 1) }));
    assert.deepEqual([...h.originals], before); assert.equal(h.state.head, null); assert.equal(h.revisions.size, 0);
  }
});

test('actual head cancellation and ending authorization refusal roll back pages, revision and head together', async () => {
  for (const failure of ['cancel', 'rights']) {
    const h = await harness(), before = [...h.originals], controller = new AbortController();
    h.state.before = tag => { if (tag === 'custom-cohort-group-selection:head-insert') {
      if (failure === 'cancel') controller.abort(); else h.state.finalAllowed = false;
    } };
    await assert.rejects(h.owner.selectRecordedGroups(h.select, { signal: controller.signal }), /cancelled|ending rights denied/);
    assert.deepEqual([...h.originals], before); assert.equal(h.state.head, null); assert.equal(h.revisions.size, 0);
  }
});

test('fresh reader actor does not rewrite intent; request roots/projections/actor stamps stay closed', async () => {
  const h = await harness(), first = await h.owner.selectRecordedGroups(h.select); h.state.actor = randomUUID();
  assert.deepEqual((await h.owner.readRecordedGroupSelection({ ...h.read, auth: { userId: h.state.actor } })).selection_ref, first.selection_ref);
  await assert.rejects(h.owner.selectRecordedGroups(h.select), /operation_conflict/);
  for (const change of [{ retainedSelection: {} }, { witnessRef: {} }, { catalogJson: '{}' }, { actor_user_id: randomUUID() }, { projection: 'membership' }])
    await assert.rejects(h.owner.selectRecordedGroups({ ...h.select, ...change }), /invalid_input/);
  assert.equal(h.revisions.size, 1);
});

test('legacy v1 originals remain supported by the old verifier and explicitly refuse the new prepared path', async () => {
  const h = await harness(), d = await h.legacy(h.select, 1); await h.blobs.put(d.catalog_original_json);
  const staged = await createCohortPagedGroupSelectionV1Store(h.blobs).stage({ metadataJson: d.metadata_json, membershipPages: d.membershipPages() });
  const original = await createCustomCohortGroupSelectionRepository(h.client, json(h.f.scope), json(h.f.context)).put({
    operationId: h.select.operationId, expectedSelectionRef: null, metadataJson: d.metadata_json, manifestRef: staged.manifest_ref });
  const before = [...h.originals];
  await assert.rejects(h.owner.readRecordedGroupSelection(h.read), /prepared_identity_version_unsupported/);
  await assert.rejects(h.owner.selectRecordedGroups(h.select), /prepared_identity_version_unsupported/);
  h.state.retained = false;
  assert.deepEqual((await h.owner.readRecordedGroupSelection(h.read)).selection_ref, original.selection_ref);
  assert.deepEqual([...h.originals], before);
});

test('trusted selection profile exposes no preparation/limit switch and keeps one lifetime budget across commands', async () => {
  const h = await harness(), r = registry(h.client, json(h.f.scope), json(h.f.context));
  assert.deepEqual(Object.keys(r).sort(), ['describe', 'stage']); let limited = false;
  const cmd = json({ command_version: 1, actor_user_id: h.state.actor, operation_id: randomUUID(), expected_selection_ref: null,
    included_recorded_group_ids: [], selection_revision: 1 });
  for (let i = 0; i < 70 && !limited; i++) try { await r.describe(cmd); }
  catch (error) { assert.match(error.message, /operations_limit|io_bytes_limit/); limited = true; }
  assert.equal(limited, true); assert.equal(h.state.head, null);
});
