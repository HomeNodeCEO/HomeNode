import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortRecordedGroupSelection as prepare, prepareCustomCohortGroupSelectionCommandOriginal as commandOriginal }
  from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store as createStore }
  from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { customCohortOpeningSelection } from '../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
const U = 'discovery:unassigned';
const account = i => `account-${String(i).padStart(7, '0')}`;
const scope = { organization_id: '10000000-0000-4000-8000-000000000001',
  report_file_id: '10000000-0000-4000-8000-000000000002', assignment_file_id: '1', account_id: account(0) };
const context = { context_id: '10000000-0000-4000-8000-000000000003', context_revision: '1', context_sha256: 'c'.repeat(64) };
function fixture(groups = [{ id: A, account_ids: [account(0), account(2)] }, { id: B, account_ids: [account(1)] }], unassigned = [account(3)]) {
  const pockets = groups.map(g => ({ ...g, member_count: g.account_ids.length }));
  const accounts = [...pockets.flatMap(g => g.account_ids), ...unassigned].sort();
  const catalog = { catalog_version: 3, status: 'review_only', catalog_complete: true, authority: 'not_established',
    apply: { status: 'blocked' }, binding: { context_ref: context, selection_revision: 1,
      selection_sha256: sha('{"pockets":[],"revision":1}') }, presentation: { membership_complete: true },
    discovered_group_count: pockets.length, pockets, unassigned: { account_ids: unassigned, member_count: unassigned.length },
    unresolved_membership: null, coverage: { discovery_member_count: accounts.length, stock_member_count: accounts.length,
      unassigned_account_count: unassigned.length, assigned_account_count: accounts.length - unassigned.length } };
  return { catalog, accounts, input: { scopeJson: json(scope), contextJson: json(context), catalogJson: JSON.stringify(catalog),
    rosterJson: JSON.stringify({ account_ids: accounts }), includedGroupIds: [B, U, A], revision: 7 } };
}
function memoryStore() {
  const originals = new Map();
  const repository = { async put(text) { const ref = blob(text); originals.set(ref.content_sha256, text); return ref; },
    async get(hash) { return originals.get(hash) ?? null; } };
  return { originals, repository, store: createStore(repository) };
}
async function rows(prepared) {
  const result = []; for await (const page of prepared.membershipPages()) result.push(...page); return result;
}

test('original catalog bridge derives all original digests and ordered memberships with unchanged legacy selection identity', async () => {
  const f = fixture(), p = await prepare(f.input), m = memoryStore();
  assert.equal(p.authority, 'not_established');
  assert.deepEqual(p.included_recorded_group_ids, [U, A, B].sort());
  const descriptor = JSON.parse(p.catalog_original_json), metadata = JSON.parse(p.metadata_json);
  assert.equal(descriptor.original_catalog_sha256, sha(f.input.catalogJson));
  assert.equal(descriptor.original_roster_sha256, sha(f.input.rosterJson));
  assert.deepEqual(descriptor.scope, scope); assert.deepEqual(descriptor.context_ref, context);
  assert.deepEqual(metadata.catalog_ref, blob(p.catalog_original_json));
  assert.equal(descriptor.groups.length, 3);
  for (const g of descriptor.groups) {
    const members = g.id === U ? f.catalog.unassigned.account_ids : f.catalog.pockets.find(p => p.id === g.id).account_ids;
    assert.equal(g.member_count, members.length); assert.equal(g.account_ids_sha256, sha(json({ account_ids: members })));
  }
  assert.deepEqual(await rows(p), [{ account_id: account(0), group_id: A }, { account_id: account(1), group_id: B },
    { account_id: account(2), group_id: A }, { account_id: account(3), group_id: U }]);
  const staged = await m.store.stage({ metadataJson: p.metadata_json, membershipPages: p.membershipPages() });
  const old = customCohortOpeningSelection(f.catalog, f.input.includedGroupIds, 7);
  const expected = { pockets: old.pockets.map(g => ({ account_ids: g.account_ids, id: g.id, label: g.label })), revision: 7 };
  assert.equal(staged.selection_sha256, sha(JSON.stringify(expected)));
  assert.deepEqual(await m.store.verify({ metadataJson: p.metadata_json, manifestRef: staged.manifest_ref }), staged);
});

test('explicit empty selection keeps complete catalog lineage while producing no membership or broad default', async () => {
  const f = fixture(), p = await prepare({ ...f.input, includedGroupIds: [] });
  assert.deepEqual(JSON.parse(p.metadata_json).groups, []);
  assert.equal(JSON.parse(p.catalog_original_json).groups.length, 3);
  assert.deepEqual(await rows(p), []);
  const r = await memoryStore().store.stage({ metadataJson: p.metadata_json, membershipPages: p.membershipPages() });
  assert.equal(r.account_count, 0); assert.equal(r.selection_sha256, sha('{"pockets":[],"revision":7}'));
  const empty = fixture([], []);
  assert.deepEqual(await rows(await prepare({ ...empty.input, includedGroupIds: [] })), []);
  await assert.rejects(prepare({ ...empty.input, includedGroupIds: [U] }), /unknown_group/);
});

test('v2 complete membership identity ignores display and JSON order but binds every group, roster and context', async () => {
  const f = fixture(), input = { ...f.input, catalogIdentityVersion: 2, includedGroupIds: [A] };
  const first = await prepare(input), descriptor = JSON.parse(first.catalog_original_json);
  assert.equal(descriptor.selection_catalog_version, 2);
  assert.equal(descriptor.roster_account_ids_sha256, sha(JSON.stringify({ account_ids: f.accounts })));
  assert.ok(!Object.hasOwn(descriptor, 'original_catalog_sha256'));
  assert.ok(!Object.hasOwn(descriptor, 'original_roster_sha256'));
  const display = structuredClone(f.catalog);
  display.presentation.note = 'new rendering'; display.pockets[0].label = 'Renamed label';
  display.pockets[0].reasons = ['New display explanation']; display.pockets.reverse();
  const refreshed = await prepare({ ...input,
    catalogJson: JSON.stringify(Object.fromEntries(Object.entries(display).reverse())),
    rosterJson: JSON.stringify({ account_ids: [...f.accounts].reverse() }) });
  assert.equal(refreshed.catalog_original_json, first.catalog_original_json);
  assert.equal(refreshed.metadata_json, first.metadata_json);
  assert.deepEqual(await rows(refreshed), await rows(first));
  const membership = structuredClone(f.catalog);
  membership.pockets[0].account_ids = [account(0), account(1)]; membership.pockets[1].account_ids = [account(2)];
  assert.notEqual((await prepare({ ...input, catalogJson: JSON.stringify(membership) })).catalog_original_json,
    first.catalog_original_json, 'a valid repartition is not merely presentation');
  const renamed = structuredClone(f.catalog); renamed.pockets[1].id = `recorded-cad:${'d'.repeat(64)}`;
  assert.notEqual((await prepare({ ...input, catalogJson: JSON.stringify(renamed) })).catalog_original_json,
    first.catalog_original_json, 'an unselected group identity is still bound');
  const newRoster = [...f.accounts.slice(0, -1), account(4)], stock = structuredClone(f.catalog);
  stock.unassigned.account_ids = [account(4)];
  assert.notEqual((await prepare({ ...input, catalogJson: JSON.stringify(stock),
    rosterJson: JSON.stringify({ account_ids: newRoster }) })).catalog_original_json, first.catalog_original_json);
  const nextContext = { ...context, context_sha256: 'd'.repeat(64) }, other = structuredClone(f.catalog);
  other.binding.context_ref = nextContext;
  assert.notEqual((await prepare({ ...input, catalogJson: JSON.stringify(other), contextJson: json(nextContext) }))
    .catalog_original_json, first.catalog_original_json);
  for (const catalogIdentityVersion of [0, 3, '2', null]) {
    await assert.rejects(prepare({ ...input, catalogIdentityVersion }), /invalid_catalog_identity_version/);
  }
});

test('server-owned reviewer intent is retained with catalog/group originals and changes cannot share a receipt', async () => {
  const f = fixture(), command = { command_version: 1, actor_user_id: scope.organization_id,
    operation_id: context.context_id, expected_selection_ref: null, included_recorded_group_ids: [A, B].sort(), selection_revision: 1 };
  const commandJson = json(command), p = await prepare({ ...f.input, includedGroupIds: [B, A], revision: 1, commandJson });
  assert.deepEqual(JSON.parse(p.catalog_original_json).selection_command, command);
  const metadata = JSON.parse(p.metadata_json); assert.deepEqual(metadata.catalog_ref, blob(p.catalog_original_json));
  assert.equal(commandOriginal(commandJson).selection_revision, 1);
  const q = await prepare({ ...f.input, includedGroupIds: [A, B], revision: 1,
    commandJson: json({ ...command, actor_user_id: scope.report_file_id }) });
  assert.notDeepEqual(q.catalog_ref, p.catalog_ref, 'a different reviewer cannot reuse the same immutable intent receipt');
  const staged = await memoryStore().store.stage({ metadataJson: p.metadata_json, membershipPages: p.membershipPages() });
  const other = await memoryStore().store.stage({ metadataJson: q.metadata_json, membershipPages: q.membershipPages() });
  assert.equal(staged.selection_sha256, other.selection_sha256, 'the chosen population identity does not depend on who reviewed it');
  assert.notDeepEqual(staged.manifest_ref, other.manifest_ref, 'the evidence manifest retains the distinct reviewer lineage');
});

test('reviewer command grammar, revision/predecessor and selected-group binding refuse mismatches', async () => {
  const f = fixture(), command = { command_version: 1, actor_user_id: scope.organization_id,
    operation_id: context.context_id, expected_selection_ref: null, included_recorded_group_ids: [A, B].sort(), selection_revision: 1 };
  for (const bad of [{ ...command, actor_user_id: 'browser-user' }, { ...command, authority: 'allowed' },
    { ...command, operation_id: 'bad-operation' }, { ...command, selection_revision: 2 },
    { ...command, included_recorded_group_ids: [B, A] }, { ...command, expected_selection_ref: {} }]) {
    assert.throws(() => commandOriginal(json(bad)), /invalid_command/);
  }
  await assert.rejects(prepare({ ...f.input, revision: 1, includedGroupIds: [A], commandJson: json(command) }), /command_mismatch/);
  await assert.rejects(prepare({ ...f.input, revision: 2, includedGroupIds: [A, B], commandJson: json(command) }), /command_mismatch/);
  assert.throws(() => commandOriginal('x'.repeat(262_145)), /invalid_command/);
});

test('v2 workspace command binds exact prior section revision without changing v1 lineage or analytical selection digest', async () => {
  const f = fixture(), v1 = { command_version: 1, actor_user_id: scope.organization_id, operation_id: context.context_id,
    expected_selection_ref: null, included_recorded_group_ids: [A, B].sort(), selection_revision: 1 };
  const v2 = { ...v1, command_version: 2, expected_workspace_revision: 12 };
  assert.deepEqual(commandOriginal(json(v1)), v1); assert.deepEqual(commandOriginal(json(v2)), v2);
  const requests = [v1, v2, { ...v2, expected_workspace_revision: 13 }];
  const manifests = [];
  for (const command of requests) {
    const prepared = await prepare({ ...f.input, includedGroupIds: [A, B], revision: 1, commandJson: json(command) });
    manifests.push(await memoryStore().store.stage({ metadataJson: prepared.metadata_json, membershipPages: prepared.membershipPages() }));
  }
  assert.equal(new Set(manifests.map(m => m.selection_sha256)).size, 1, 'selected observations are the same');
  assert.equal(new Set(manifests.map(m => m.manifest_ref.content_sha256)).size, 3, 'different CAS intent cannot share an immutable operation original');
  for (const revision of [0, -1, 1.5, '12', null, 2147483647]) {
    assert.throws(() => commandOriginal(json({ ...v2, expected_workspace_revision: revision })), /invalid_command/);
  }
  const missing = { ...v2 }; delete missing.expected_workspace_revision;
  assert.throws(() => commandOriginal(json(missing)), /invalid_command/);
  assert.throws(() => commandOriginal(json({ ...v1, expected_workspace_revision: 12 })), /invalid_command/);
});

test('a selected subset cannot conceal partial, conflicting or altered unselected catalog membership', async () => {
  const f = fixture();
  const replacements = [
    { ...f.catalog, catalog_complete: false }, { ...f.catalog, status: 'incomplete' },
    { ...f.catalog, catalog_version: 2 }, { ...f.catalog, discovered_group_count: 1 },
    { ...f.catalog, presentation: { membership_complete: false } },
    { ...f.catalog, unresolved_membership: { reason: 'capture_limit' } },
    { ...f.catalog, pockets: [f.catalog.pockets[0]] },
    { ...f.catalog, pockets: [f.catalog.pockets[0], { ...f.catalog.pockets[1], account_ids: [account(0)] }] },
    { ...f.catalog, pockets: [f.catalog.pockets[0], { ...f.catalog.pockets[1], account_ids: [account(9)] }] },
    { ...f.catalog, pockets: [f.catalog.pockets[0], { ...f.catalog.pockets[1], member_count: 2 }] },
    { ...f.catalog, unassigned: { account_ids: [], member_count: 0 } },
    { ...f.catalog, coverage: { ...f.catalog.coverage, discovery_member_count: 3 } },
  ];
  for (const catalog of replacements) await assert.rejects(prepare({ ...f.input, catalogJson: json(catalog), includedGroupIds: [A] }),
    /invalid_catalog|invalid_group|catalog_roster_mismatch/);
});

test('unknown, repeated, malformed group IDs and altered JSON encoding/binding replacements refuse', async () => {
  const f = fixture();
  for (const ids of [[A, A], ['parcel-123'], [`recorded-cad:${'e'.repeat(64)}`]]) {
    await assert.rejects(prepare({ ...f.input, includedGroupIds: ids }), /group_ids|unknown_group/);
  }
  for (const change of [
    { catalogJson: ` ${f.input.catalogJson}` }, { rosterJson: '{}broken' },
    { catalogJson: f.input.catalogJson.replace('"catalog_version":3', '"catalog_version":3e0') },
    { catalogJson: f.input.catalogJson.replace('"catalog_version":3', '"catalog_version":2,"catalog_version":3') },
    { revision: 0 }, { revision: 2147483648 },
    { catalogJson: json({ ...f.catalog, binding: { ...f.catalog.binding, selection_revision: 2 } }) },
    { catalogJson: json({ ...f.catalog, binding: { ...f.catalog.binding, selection_sha256: 'a'.repeat(64) } }) },
    { contextJson: json({ ...context, context_sha256: 'd'.repeat(64) }) },
    { rosterJson: json({ account_ids: [account(0), account(0), account(1), account(2), account(3)] }) },
    { rosterJson: json({ account_ids: f.accounts, sampled: true }) },
  ]) await assert.rejects(prepare({ ...f.input, ...change }), /invalid_catalog|invalid_roster|invalid_revision|duplicate_roster_account/);
});

test('within-group sorting, uniqueness, account grammar and input byte bounds are exact', async () => {
  const f = fixture();
  for (const members of [[account(2), account(0)], [account(0), account(0)], [' bad', account(2)], ['\ud800', account(2)]]) {
    const catalog = { ...f.catalog, pockets: [{ ...f.catalog.pockets[0], account_ids: members }, f.catalog.pockets[1]] };
    await assert.rejects(prepare({ ...f.input, catalogJson: json(catalog) }), /membership_order|catalog_roster_mismatch|invalid_account/);
  }
  await assert.rejects(prepare({ ...f.input, catalogJson: ' '.repeat(4_000_001) }), /invalid_catalog/);
  await assert.rejects(prepare({ ...f.input, rosterJson: ' '.repeat(4_000_001) }), /invalid_roster/);
  const padded = { ...f.catalog, retained_display_note: '' };
  padded.retained_display_note = 'x'.repeat(4_000_000 - Buffer.byteLength(JSON.stringify(padded)));
  const exact = JSON.stringify(padded); assert.equal(Buffer.byteLength(exact), 4_000_000);
  assert.equal((await prepare({ ...f.input, catalogJson: exact })).authority, 'not_established');
  padded.retained_display_note += 'x';
  await assert.rejects(prepare({ ...f.input, catalogJson: JSON.stringify(padded) }), /invalid_catalog/);
});

test('caller group aliases detach before asynchronous preparation and cannot change returned streams', async () => {
  const f = fixture(Array.from({ length: 2 }, (_, g) => ({ id: g ? B : A,
    account_ids: Array.from({ length: 200 }, (_, i) => account(i * 2 + g)) })), []);
  const ids = [A]; const pending = prepare({ ...f.input, includedGroupIds: ids });
  ids[0] = B; const p = await pending;
  assert.deepEqual(p.included_recorded_group_ids, [A]);
  const first = await rows(p); assert.equal(first.length, 200); assert.ok(first.every(r => r.group_id === A));
  first[0].account_id = 'caller-change'; assert.equal((await rows(p))[0].account_id, account(0));
  assert.ok(Object.isFrozen(p.included_recorded_group_ids));
  const accessor = Object.defineProperty([], '0', { enumerable: true, get() { assert.fail('must not invoke group accessor'); } });
  await assert.rejects(prepare({ ...f.input, includedGroupIds: accessor }), /group_ids/);
});

test('cancellation and owner budget failures stop preparation/streaming without a final staged selection', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(prepare({ ...f.input, signal: controller.signal }), /cancelled/);
  const large = fixture([{ id: A, account_ids: Array.from({ length: 1001 }, (_, i) => account(i)) }], []);
  const c = new AbortController(); const p = await prepare({ ...large.input, includedGroupIds: [A], signal: c.signal });
  const stream = p.membershipPages(); assert.equal((await stream.next()).value.length, 1000); c.abort();
  await assert.rejects(stream.next(), /cancelled/);
  let blocked = false; const q = await prepare({ ...f.input, checkBudget: () => { if (blocked) throw new Error('owner deadline'); } });
  blocked = true; await assert.rejects(rows(q), /owner deadline/);
  const during = new AbortController(); let checks = 0;
  await assert.rejects(prepare({ ...large.input, includedGroupIds: [A], signal: during.signal,
    checkBudget: () => { if (++checks === 3) during.abort(); } }), /cancelled/);
});

test('60,000 accounts across many interleaved groups merge in bounded pages without flattening or viewport clipping', async () => {
  const count = 60_000, groupCount = 180;
  const groups = Array.from({ length: groupCount }, (_, i) => ({ id: `recorded-cad:${i.toString(16).padStart(64, '0')}`, account_ids: [] }));
  for (let i = 0; i < count; i++) groups[i % groupCount].account_ids.push(account(i));
  const f = fixture(groups, []), p = await prepare({ ...f.input, includedGroupIds: groups.map(g => g.id) });
  let seen = 0, pages = 0;
  for await (const page of p.membershipPages()) {
    assert.ok(page.length <= 1000); pages++;
    for (const row of page) { assert.equal(row.account_id, account(seen)); assert.equal(row.group_id, groups[seen % groupCount].id); seen++; }
  }
  assert.equal(seen, count); assert.equal(pages, 60);
  const m = memoryStore(), r = await m.store.stage({ metadataJson: p.metadata_json, membershipPages: p.membershipPages() });
  assert.equal(r.account_count, count); assert.equal(r.membership_count, count);
  assert.deepEqual(await m.store.verify({ metadataJson: p.metadata_json, manifestRef: r.manifest_ref }), r);
});

test('120,000-account read models above legacy blob byte/node limits still derive bounded original digest metadata', async () => {
  const count = 120_000;
  const groups = [A, B].map((id, group) => ({ id,
    account_ids: Array.from({ length: count / 2 }, (_, i) => account(2 * i + group)) }));
  const f = fixture(groups, []);
  assert.ok(Buffer.byteLength(f.input.catalogJson) > 1_500_000);
  assert.ok(Buffer.byteLength(f.input.rosterJson) > 1_500_000);
  assert.throws(() => json(f.catalog), /json_limit|json_bytes/);
  const p = await prepare({ ...f.input, includedGroupIds: [B, A] });
  assert.ok(Buffer.byteLength(p.catalog_original_json) < 2000);
  assert.ok(Buffer.byteLength(p.metadata_json) < 2000);
  let seen = 0;
  for await (const page of p.membershipPages()) for (const row of page) {
    assert.equal(row.account_id, account(seen)); assert.equal(row.group_id, seen % 2 ? B : A); seen++;
  }
  assert.equal(seen, count);
  // Representation test only: no live source ceiling or report capacity changed.
  const m = memoryStore(), r = await m.store.stage({ metadataJson: p.metadata_json, membershipPages: p.membershipPages() });
  assert.equal(r.account_count, count);
  assert.deepEqual(await m.store.verify({ metadataJson: p.metadata_json, manifestRef: r.manifest_ref }), r);
  const v2 = await prepare({ ...f.input, includedGroupIds: [B, A], catalogIdentityVersion: 2 });
  assert.equal(JSON.parse(v2.catalog_original_json).roster_account_ids_sha256,
    sha(JSON.stringify({ account_ids: f.accounts })));
  assert.ok(Buffer.byteLength(v2.catalog_original_json) < 2000);
  const v2Staged = await m.store.stage({ metadataJson: v2.metadata_json, membershipPages: v2.membershipPages() });
  assert.equal(v2Staged.selection_sha256, r.selection_sha256, 'producer version does not change chosen population identity');
  assert.notDeepEqual(v2Staged.manifest_ref, r.manifest_ref, 'new evidence version has distinct retained lineage');
});
