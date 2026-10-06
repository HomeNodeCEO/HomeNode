import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortRecordedGroupSelectionOwner as createOwner } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelectionOwner.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortRecordedGroupSelection as prepare } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { createCustomCohortGroupSelectionRepository as createSelectionRepository } from '../src/services/neighborhoodAssessment/customCohortGroupSelectionRepository.js';
import { createCohortPagedGroupSelectionV1Store as createStore } from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';

const A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
const scope = { organization_id: randomUUID(), report_file_id: randomUUID(), assignment_file_id: '8', account_id: 'A' };
const context = { context_id: randomUUID(), context_revision: '1', context_sha256: 'c'.repeat(64) };
const actor = randomUUID(), otherActor = randomUUID();
function fixture(extraAccounts = []) {
  const data = new Map(), revisions = new Map(), operations = new Map(), calls = [];
  const state = { head: null, actor, allowed: true, finalAllowed: true, summaryAllowed: true,
    missing: null, before: null, summaryInputs: [], viewportInputs: [] };
  const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [{ ...value }] : [] });
  const client = { release() { assert.fail('caller owns release'); }, async query(sql, args = []) {
    const tag = /\/\* ([^*]+) \*\//.exec(sql)?.[1]; calls.push(tag); await state.before?.(tag);
    if (tag === 'custom-cohort-group-selection:transaction') return row({ transaction_id: '42' });
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
    if (tag?.startsWith('neighborhood-cohort-blob:')) {
      assert.equal(args[0], scope.organization_id);
      if (tag.endsWith(':read')) return row(state.missing === args[1] ? null : data.get(args[1]));
      if (tag.endsWith(':insert')) {
        if (data.has(args[1])) return row(null);
        const r = blob(args[3]); data.set(r.content_sha256, { ...r, canonical_utf8: args[3] }); return row(data.get(args[1]));
      }
    }
    throw new Error(`unexpected SQL ${tag}`);
  } };
  const catalog = { catalog_version: 3, status: 'review_only', catalog_complete: true, authority: 'not_established',
    apply: { status: 'blocked' }, binding: { context_ref: context, selection_revision: 1,
      selection_sha256: digest({ pockets: [], revision: 1 }) }, presentation: { membership_complete: true },
    discovered_group_count: 2, pockets: [{ id: A, member_count: 2 + extraAccounts.length, account_ids: ['A', 'C', ...extraAccounts] },
      { id: B, member_count: 1, account_ids: ['B'] }], unassigned: { account_ids: [], member_count: 0 },
    unresolved_membership: null, coverage: { discovery_member_count: 3 + extraAccounts.length, stock_member_count: 3 + extraAccounts.length,
      unassigned_account_count: 0, assigned_account_count: 3 + extraAccounts.length } };
  const roster = { account_ids: ['A', 'B', 'C', ...extraAccounts] };
  const identityOf = value => ({ auth: structuredClone(value.auth), accountId: value.accountId, assignmentFileId: value.assignmentFileId });
  const owner = createOwner({ identityOf, execute: async (input, options, write, work, projection = 'intent') => {
    if (!state.allowed || (projection !== 'intent' && !state.summaryAllowed)) throw new Error('current source rights denied');
    calls.push('authorized');
    const snapshot = { head: state.head, data: new Map(data), revisions: new Map(revisions), operations: new Map(operations) };
    try {
      const result = await work({ client, auth: { userId: state.actor }, scopeJson: json(scope),
        catalogJson: JSON.stringify(catalog), rosterJson: JSON.stringify(roster),
        blobs: createNeighborhoodCohortBlobRepository(client, scope.organization_id),
        presentSelectionSummary: (accounts, reference) => {
          assert.equal(projection, 'summary'); assert.ok(Object.isFrozen(accounts));
          state.summaryInputs.push({ accounts, reference });
          return { summary: { selected: { account_count: accounts.length }, binding: {
            context_ref: input.contextRef, selection_sha256: reference.selection_sha256,
            selection_revision: reference.selection_revision } } };
        },
        presentSelectionViewport: (accounts, reference, viewport) => {
          assert.equal(projection, 'viewport'); assert.ok(Object.isFrozen(accounts));
          state.viewportInputs.push({ accounts, reference, viewport });
          return { display_only: true, selected_count: accounts.length };
        },
        budget: { signal: options.signal, check() { if (options.signal?.aborted) throw new Error('cancelled'); } } });
      if (!state.finalAllowed) throw new Error('current rights revoked before commit');
      calls.push(write ? 'committed' : 'delivered'); return result;
    } catch (error) {
      state.head = snapshot.head;
      for (const [map, original] of [[data, snapshot.data], [revisions, snapshot.revisions], [operations, snapshot.operations]]) {
        map.clear(); for (const [key, value] of original) map.set(key, value);
      }
      calls.push('rolled_back'); throw error;
    }
  } });
  const read = { auth: { userId: actor }, accountId: scope.account_id,
    assignmentFileId: scope.assignment_file_id, contextRef: context };
  const select = { ...read, operationId: randomUUID(), expectedSelectionRef: null, includedRecordedGroupIds: [B, A] };
  return { owner, calls, state, data, revisions, catalog, roster, client, read, select };
}

test('internal owner retains server actor, complete originals and current head; bounded reopen returns IDs not members', async () => {
  const f = fixture();
  assert.deepEqual(await f.owner.readRecordedGroupSelection(f.read), { status: 'absent', authority: 'not_established',
    context_ref: context, selection_ref: null, included_recorded_group_ids: null });
  const first = await f.owner.selectRecordedGroups(f.select);
  assert.equal(first.status, 'stored'); assert.equal(first.selection_ref.selection_revision, 1);
  assert.deepEqual(first.included_recorded_group_ids, [A, B]);
  assert.deepEqual(await f.owner.selectRecordedGroups(f.select), { ...first, status: 'reused' });
  const receipts = [...f.data.values()].map(row => JSON.parse(row.canonical_utf8)).filter(value => value.selection_command);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].selection_command.actor_user_id, actor);
  assert.equal(receipts[0].selection_catalog_version, 2);
  // Another CURRENT authorized reader may reopen the prior reviewer's receipt.
  f.state.actor = otherActor;
  const reopened = await f.owner.readRecordedGroupSelection({ ...f.read, auth: { userId: otherActor } });
  assert.deepEqual(reopened.selection_ref, first.selection_ref);
  assert.deepEqual(reopened.included_recorded_group_ids, [A, B]);
  assert.ok(!Object.hasOwn(reopened, 'account_ids')); assert.equal(f.state.head, 1);
  await assert.rejects(f.owner.selectRecordedGroups(f.select), /operation_conflict/);
  assert.equal(f.revisions.size, 1);
});

test('v2 saved selections reopen and replay after presentation, key/group order and roster order refreshes', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  const originals = [...f.data.entries()];
  f.catalog.presentation.note = 'refreshed rendering, no membership change';
  f.catalog.pockets[0].label = 'Updated display label';
  f.catalog.pockets[0].reasons = ['New explanation'];
  f.catalog.pockets.reverse(); f.roster.account_ids.reverse();
  const reordered = Object.fromEntries(Object.entries(f.catalog).reverse());
  for (const key of Object.keys(f.catalog)) delete f.catalog[key];
  Object.assign(f.catalog, reordered);
  assert.deepEqual((await f.owner.readRecordedGroupSelection(f.read)).selection_ref, first.selection_ref);
  assert.deepEqual(await f.owner.selectRecordedGroups(f.select), { ...first, status: 'reused' });
  assert.deepEqual([...f.data.entries()], originals, 'no immutable evidence is rewritten or newly staged by the replay');
  assert.equal(f.revisions.size, 1);
  f.catalog.presentation.membership_complete = false;
  await assert.rejects(f.owner.readRecordedGroupSelection(f.read), /invalid_catalog/);
});

test('v2 still binds unselected complete memberships, not just chosen members', async () => {
  const f = fixture(); await f.owner.selectRecordedGroups({ ...f.select, includedRecordedGroupIds: [A] });
  f.catalog.pockets[0].account_ids = ['A', 'B']; f.catalog.pockets[1].account_ids = ['C'];
  await assert.rejects(f.owner.readRecordedGroupSelection(f.read), /original_mismatch/);
  assert.equal(f.state.head, 1); assert.equal(f.revisions.size, 1);
});

test('retained v1 originals reopen and exact lost-ACK replay uses v1 without rewriting lineage; new writes use v2', async () => {
  const f = fixture(), blobs = createNeighborhoodCohortBlobRepository(f.client, scope.organization_id);
  const commandJson = json({ command_version: 1, actor_user_id: actor, operation_id: f.select.operationId,
    expected_selection_ref: null, included_recorded_group_ids: [A, B], selection_revision: 1 });
  // Unit fixture seeds an actual old-format original through the same pure
  // producer/store/repository contracts, not a hand-edited manifest/hash.
  const old = await prepare({ scopeJson: json(scope), contextJson: json(context), catalogJson: JSON.stringify(f.catalog),
    rosterJson: JSON.stringify(f.roster), includedGroupIds: [A, B], revision: 1, commandJson, catalogIdentityVersion: 1 });
  await blobs.put(old.catalog_original_json);
  const staged = await createStore(blobs).stage({ metadataJson: old.metadata_json, membershipPages: old.membershipPages() });
  const first = await createSelectionRepository(f.client, json(scope), json(context)).put({ operationId: f.select.operationId,
    expectedSelectionRef: null, metadataJson: old.metadata_json, manifestRef: staged.manifest_ref });
  const originals = [...f.data.entries()];
  assert.deepEqual((await f.owner.readRecordedGroupSelection(f.read)).selection_ref, first.selection_ref);
  assert.equal((await f.owner.selectRecordedGroups(f.select)).status, 'reused');
  assert.deepEqual([...f.data.entries()], originals);
  f.catalog.pockets[0].label = 'A changed display label';
  await assert.rejects(f.owner.readRecordedGroupSelection(f.read), /original_mismatch/, 'v1 is not silently reinterpreted');
  const next = await f.owner.selectRecordedGroups({ ...f.select, operationId: randomUUID(),
    expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [A] });
  assert.equal(next.selection_ref.selection_revision, 2);
  assert.deepEqual((await f.owner.readRecordedGroupSelection(f.read)).included_recorded_group_ids, [A]);
  for (const [key, value] of originals) assert.deepEqual(f.data.get(key), value);
  await assert.rejects(f.owner.selectRecordedGroups(f.select), /operation_conflict|selection_changed/);
  assert.equal(f.state.head, 2); assert.equal(f.revisions.size, 2);
});

test('explicit empty remains empty; stale operations cannot rewind or supply replacements', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  const next = { ...f.select, operationId: randomUUID(), expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [] };
  const empty = await f.owner.selectRecordedGroups(next);
  assert.equal(empty.selection_ref.selection_revision, 2);
  assert.deepEqual((await f.owner.readRecordedGroupSelection(f.read)).included_recorded_group_ids, []);
  await assert.rejects(f.owner.selectRecordedGroups(f.select), /selection_changed/);
  assert.equal(f.state.head, 2); assert.equal(f.revisions.size, 2);
});

test('no authority/catalog/members/actor body fields, accessors, proxies or invalid operations reach the owner transaction', async () => {
  const f = fixture();
  for (const key of ['actor_user_id', 'account_ids', 'catalogJson', 'manifestRef', 'authority', 'organization_id']) {
    await assert.rejects(f.owner.selectRecordedGroups({ ...f.select, [key]: 'untrusted' }), /invalid_input/);
  }
  let invoked = false;
  await assert.rejects(f.owner.selectRecordedGroups({ ...f.select, get includedRecordedGroupIds() { invoked = true; return [A]; } }), /invalid_input/);
  await assert.rejects(f.owner.selectRecordedGroups(new Proxy(f.select, { get() { invoked = true; return null; } })), /invalid_input/);
  await assert.rejects(f.owner.selectRecordedGroups({ ...f.select, operationId: 'invalid' }), /invalid_operation/);
  await assert.rejects(f.owner.selectRecordedGroups({ ...f.select, includedRecordedGroupIds: [A, A] }), /checkpoint:group_ids/);
  assert.equal(invoked, false); assert.equal(f.calls.length, 0);
});

test('changed original catalog/roster and missing original pages cannot be returned as current successful selection', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  f.catalog.pockets[0].account_ids = ['A', 'B'];
  await assert.rejects(f.owner.readRecordedGroupSelection(f.read), /catalog_roster_mismatch/);
  f.catalog.pockets[0].account_ids = ['A', 'C'];
  const manifest = JSON.parse(f.data.get(first.selection_ref.manifest_ref.content_sha256).canonical_utf8);
  f.state.missing = manifest.account_pages[0].page.content_sha256;
  await assert.rejects(f.owner.readRecordedGroupSelection(f.read), /page_conflict/);
  assert.equal(f.state.head, 1);
});

test('current-rights refusal or final revocation rolls back all originals and head; cancellation does not save a selection', async () => {
  const f = fixture(); f.state.allowed = false;
  await assert.rejects(f.owner.selectRecordedGroups(f.select), /rights denied/);
  assert.equal(f.calls.length, 0); assert.equal(f.data.size, 0);
  f.state.allowed = true; f.state.finalAllowed = false;
  await assert.rejects(f.owner.selectRecordedGroups(f.select), /revoked before commit/);
  assert.equal(f.data.size, 0); assert.equal(f.revisions.size, 0); assert.equal(f.state.head, null);
  f.state.finalAllowed = true;
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(f.owner.selectRecordedGroups(f.select, { signal: cancel.signal }), /cancelled/);
  assert.equal(f.data.size, 0); assert.equal(f.state.head, null);
});

test('summary uses only the completely verified exact current union; empty and stale references never broaden', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  const summary = await f.owner.previewRecordedGroupSelection({ ...f.read, selectionRef: first.selection_ref });
  assert.equal(summary.status, 'preview'); assert.equal(summary.authority, 'not_established');
  assert.deepEqual(summary.selection_ref, first.selection_ref);
  assert.deepEqual(f.state.summaryInputs[0].accounts, ['A', 'B', 'C']);
  assert.deepEqual(summary.parcel_map, { status: 'omitted', reason: 'geometry_not_requested' });
  assert.deepEqual(summary.apply, { status: 'blocked', reasons: ['observation_preview_only'] });
  assert.equal(Object.hasOwn(summary, 'account_ids'), false);
  const empty = await f.owner.selectRecordedGroups({ ...f.select, operationId: randomUUID(),
    expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [] });
  const explicitEmpty = await f.owner.previewRecordedGroupSelection({ ...f.read, selectionRef: empty.selection_ref });
  assert.equal(explicitEmpty.summary.selected.account_count, 0);
  assert.deepEqual(f.state.summaryInputs[1].accounts, []);
  await assert.rejects(f.owner.previewRecordedGroupSelection({ ...f.read, selectionRef: first.selection_ref }), /selection_changed/);
  assert.equal(f.state.summaryInputs.length, 2);
  assert.equal(f.state.head, 2);
});

test('summary refuses missing/changed originals and separate summary rights before exposing any numeric result', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  const request = { ...f.read, selectionRef: first.selection_ref };
  f.state.summaryAllowed = false;
  const from = f.calls.length;
  await assert.rejects(f.owner.previewRecordedGroupSelection(request), /rights denied/);
  assert.equal(f.calls.length, from); assert.equal(f.state.summaryInputs.length, 0);
  f.state.summaryAllowed = true;
  const manifest = JSON.parse(f.data.get(first.selection_ref.manifest_ref.content_sha256).canonical_utf8);
  f.state.missing = manifest.account_pages[0].page.content_sha256;
  await assert.rejects(f.owner.previewRecordedGroupSelection(request), /page_conflict/);
  assert.equal(f.state.summaryInputs.length, 0);
  f.state.missing = null; f.state.finalAllowed = false;
  await assert.rejects(f.owner.previewRecordedGroupSelection(request), /revoked before commit/);
  assert.equal(f.state.head, 1); assert.equal(f.revisions.size, 1);
  f.state.finalAllowed = true;
  for (const key of ['account_ids', 'catalogJson', 'authority', 'includedRecordedGroupIds'])
    await assert.rejects(f.owner.previewRecordedGroupSelection({ ...request, [key]: [] }), /invalid_input/);
  await assert.rejects(f.owner.previewRecordedGroupSelection({ ...request, selectionRef: null }), /invalid_input/);
  const absent = fixture();
  await assert.rejects(absent.owner.previewRecordedGroupSelection({ ...absent.read, selectionRef: first.selection_ref }), /selection_changed/);
  assert.equal(absent.state.summaryInputs.length, 0);
});

test('summary never emits a verified prefix or raises the installed 50k numeric-consumer ceiling', async () => {
  const extras = n => Array.from({ length: n }, (_, i) => `D-${String(i).padStart(6, '0')}`);
  const incomplete = fixture(extras(2000)), stored = await incomplete.owner.selectRecordedGroups(incomplete.select);
  const manifest = JSON.parse(incomplete.data.get(stored.selection_ref.manifest_ref.content_sha256).canonical_utf8);
  incomplete.state.missing = manifest.account_pages.at(-1).page.content_sha256;
  await assert.rejects(incomplete.owner.previewRecordedGroupSelection({ ...incomplete.read,
    selectionRef: stored.selection_ref }), /page_conflict/);
  assert.equal(incomplete.state.summaryInputs.length, 0, 'numeric projection cannot see the matched first pages');
  for (const count of [50000, 50001]) {
    const f = fixture(extras(count - 3)), saved = await f.owner.selectRecordedGroups(f.select);
    const request = { ...f.read, selectionRef: saved.selection_ref };
    if (count === 50000) {
      const result = await f.owner.previewRecordedGroupSelection(request);
      assert.equal(result.summary.selected.account_count, count);
      assert.equal(f.state.summaryInputs[0].accounts.length, count);
    } else {
      await assert.rejects(f.owner.previewRecordedGroupSelection(request), /summary_account_limit/);
      assert.equal(f.state.summaryInputs.length, 0);
    }
    assert.equal(f.state.head, 1, 'read failure cannot replace intent or report data');
  }
});

test('exact-reference viewport verifies the whole offscreen union before map work; empty, stale, revoked and missing originals never broaden', async () => {
  const f = fixture(), first = await f.owner.selectRecordedGroups(f.select);
  const viewport = { west: -97, south: 32, east: -96.99, north: 32.01 };
  const request = { ...f.read, selectionRef: first.selection_ref, viewport };
  const result = await f.owner.viewportRecordedGroupSelection(request);
  assert.equal(result.status, 'viewport'); assert.equal(result.authority, 'not_established');
  assert.deepEqual(result.selection_ref, first.selection_ref);
  assert.deepEqual(f.state.viewportInputs[0].accounts, ['A', 'B', 'C']);
  assert.equal(f.state.summaryInputs.length, 0, 'a pan does not rerun the numeric kernel');
  const manifest = JSON.parse(f.data.get(first.selection_ref.manifest_ref.content_sha256).canonical_utf8);
  f.state.missing = manifest.account_pages[0].page.content_sha256;
  await assert.rejects(f.owner.viewportRecordedGroupSelection(request), /page_conflict/);
  assert.equal(f.state.viewportInputs.length, 1); f.state.missing = null;
  f.state.summaryAllowed = false;
  await assert.rejects(f.owner.viewportRecordedGroupSelection(request), /rights denied/);
  assert.equal(f.state.viewportInputs.length, 1); f.state.summaryAllowed = true;
  f.state.finalAllowed = false;
  await assert.rejects(f.owner.viewportRecordedGroupSelection(request), /revoked before commit/);
  f.state.finalAllowed = true;
  const empty = await f.owner.selectRecordedGroups({ ...f.select, operationId: randomUUID(),
    expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [] });
  await assert.rejects(f.owner.viewportRecordedGroupSelection(request), /selection_changed/);
  const explicitEmpty = await f.owner.viewportRecordedGroupSelection({ ...request, selectionRef: empty.selection_ref });
  assert.equal(explicitEmpty.viewport_map.selected_count, 0);
  assert.deepEqual(f.state.viewportInputs.at(-1).accounts, []);
  for (const changed of [{ selectionRef: null }, { account_ids: [] }, { includedRecordedGroupIds: [] },
    { viewport: { ...viewport, east: -98 } }, { viewport: { ...viewport, extra: true } }])
    await assert.rejects(f.owner.viewportRecordedGroupSelection({ ...request, ...changed }), /invalid_input/);
  assert.equal(f.state.head, 2); assert.equal(f.revisions.size, 2);
});
