import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCustomCohortCatalogMembershipWitness as prepare, createCustomCohortCatalogMembershipWitnessStore as store }
  from '../src/services/neighborhoodAssessment/customCohortCatalogMembershipWitness.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { customCohortCatalogPageFixture as fixture } from './fixtures/customCohortCatalogPageFixture.js';

function memory(hook = () => {}) {
  const originals = new Map(), writes = [], reads = [];
  const repository = {
    async put(text) { const ref = blob(text); originals.set(ref.content_sha256, text); writes.push(text);
      const changed = await hook({ kind: 'put', text, ref, originals, writes, reads }); return changed ?? ref; },
    async get(hash, bytes) { reads.push({ hash, bytes });
      const result = await hook({ kind: 'get', hash, bytes, originals, writes, reads });
      return result === undefined ? originals.get(hash) ?? null : result; },
  };
  return { originals, writes, reads, repository };
}
const encoded = f => ({ ...f.input, catalogJson: JSON.stringify(f.catalog) });

test('actual compiler and existing paged stores retain every individual membership and all cleanup roots', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(), result = await store(m.repository).stage(receipt);
  const root = JSON.parse(result.witness_json);
  assert.equal(root.usage, 'complete_recorded_catalog_membership_only'); assert.equal(root.authority, 'not_established');
  assert.equal(root.account_count, f.accounts.length); assert.equal(root.group_count, 238);
  const metadata = JSON.parse(m.originals.get(root.membership_metadata_ref.content_sha256));
  assert.deepEqual(metadata.catalog_ref, root.original_catalog_ref);
  const display = JSON.parse(m.originals.get(root.display_manifest_ref.content_sha256));
  const displayMetadata = JSON.parse(m.originals.get(display.metadata_ref.content_sha256));
  assert.deepEqual(displayMetadata.original_catalog_ref, root.original_catalog_ref);
  assert.equal(displayMetadata.roster_account_ids_sha256, root.roster_account_ids_sha256);
  const members = JSON.parse(m.originals.get(root.membership_manifest_ref.content_sha256));
  const rows = members.membership_pages.flatMap(p => JSON.parse(m.originals.get(p.page.content_sha256)).entries);
  const expected = [...f.catalog.pockets, { id: 'discovery:unassigned', account_ids: f.catalog.unassigned.account_ids }]
    .flatMap(g => g.account_ids.map(account_id => ({ account_id, group_id: g.id })))
    .sort((a, b) => a.account_id < b.account_id ? -1 : 1);
  assert.deepEqual(rows, expected); assert.equal(new Set(rows.map(r => r.account_id)).size, f.accounts.length);
  const accounts = members.account_pages.flatMap(p => JSON.parse(m.originals.get(p.page.content_sha256)).entries);
  assert.deepEqual(accounts, f.accounts);
  assert.deepEqual(new Set(result.retention_refs.map(r => r.content_sha256)), new Set(m.originals.keys()));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.retention_refs));
  assert.equal(Object.hasOwn(result, 'selection_ref'), false); assert.equal(Object.hasOwn(result, 'selected'), false);
});

test('60001 members, empty and wholly unresolved catalogs retain the entire partition without a live capacity switch', async () => {
  for (const options of [{ count: 60001, groupCount: 7 }, { count: 0, groupCount: 0 }, { count: 21, groupCount: 0 }]) {
    const f = fixture(options), m = memory(), result = await store(m.repository).stage(await prepare(f.input));
    const root = JSON.parse(result.witness_json), membership = JSON.parse(m.originals.get(root.membership_manifest_ref.content_sha256));
    assert.equal(root.account_count, options.count); assert.equal(membership.account_count, String(options.count));
    assert.equal(membership.membership_count, String(options.count));
    assert.ok(Buffer.byteLength(result.witness_json) < 4000);
    assert.ok(m.writes.every(text => Buffer.byteLength(text) <= 750000));
  }
});

test('partial or corrupt unselected membership, wrong subject and source getters refuse before any write', async () => {
  for (const mutate of [f => { f.catalog.pockets[4].account_ids[0] = f.catalog.pockets[3].account_ids[0]; },
    f => { f.catalog.pockets.pop(); }, f => { f.catalog.catalog_complete = false; },
    f => { f.catalog.subject_membership.assigned_pocket_id = f.catalog.pockets[1].id; }]) {
    const f = fixture(); mutate(f); await assert.rejects(prepare(encoded(f)));
  }
  const f = fixture(), value = { ...f.input }; let calls = 0;
  Object.defineProperty(value, 'catalogJson', { enumerable: true, get() { calls++; return f.input.catalogJson; } });
  await assert.rejects(prepare(value), /_input/); assert.equal(calls, 0);
  await assert.rejects(prepare({ ...f.input, account_ids: f.accounts }), /_input/);
  const m = memory(), receipt = await prepare(f.input);
  await assert.rejects(store(m.repository).stage({ ...receipt }), /issued_source_required/); assert.equal(m.writes.length, 0);
});

test('lost acknowledgments, missing later originals and an ending display loss never publish a witness root', async () => {
  for (const broken of ['ack', 'membership', 'display']) {
    let lost = false;
    const m = memory(({ kind, text, originals, hash, writes }) => {
      if (kind === 'put' && broken === 'ack') return { content_sha256: 'f'.repeat(64), canonical_utf8_bytes: String(Buffer.byteLength(text)) };
      if (kind === 'get' && broken === 'membership' && JSON.parse(originals.get(hash)).kind === 'recorded_group_memberships') return null;
      if (kind === 'put' && broken === 'display' && JSON.parse(text).kind === 'recorded_group_memberships' && !lost) {
        lost = true; const display = writes.find(v => JSON.parse(v).kind === 'recorded_group_display' && JSON.parse(v).pages);
        originals.delete(blob(display).content_sha256);
      }
    });
    await assert.rejects(store(m.repository).stage(await prepare(fixture().input)));
    assert.equal(m.writes.some(text => JSON.parse(text).usage === 'complete_recorded_catalog_membership_only'), false);
  }
});

test('caller aliases, cancellation at settlement and finite shared budgets cannot produce a late witness', async () => {
  const f = fixture(), input = { ...f.input }, pending = prepare(input); input.catalogJson = '{}';
  const receipt = await pending; assert.equal(receipt.account_count, f.accounts.length);
  const abort = new AbortController(), m = memory(({ kind }) => { if (kind === 'put') abort.abort(); });
  await assert.rejects(store(m.repository, { signal: abort.signal }).stage(receipt), /cancelled/);
  assert.equal(m.writes.length, 1); assert.equal(m.reads.length, 0);
  const bounded = memory(), owner = store(bounded.repository); let refused = false;
  for (let i = 0; i < 100 && !refused; i++) {
    try { await owner.stage(receipt); } catch (e) { assert.match(e.message, /operations_limit|io_bytes_limit/); refused = true; }
  }
  assert.equal(refused, true); assert.ok(bounded.writes.length + bounded.reads.length <= 512);
});

test('the caller lane stays occupied until actual I/O settlement, and an ending budget expiry refuses publication', async () => {
  const receipt = await prepare(fixture().input); let enter, release, held = true;
  const entered = new Promise(r => { enter = r; }), settled = new Promise(r => { release = r; });
  const m = memory(async ({ kind }) => { if (kind === 'put' && held) { held = false; enter(); await settled; } });
  const owner = store(m.repository), pending = owner.stage(receipt); await entered;
  await assert.rejects(owner.stage(receipt), /operation_in_progress/); assert.equal(m.writes.length, 1);
  release(); assert.equal((await pending).witness_version, 1);
  let expired = false;
  const ending = memory(({ kind, text }) => {
    if (kind === 'put' && JSON.parse(text).kind === 'recorded_group_memberships') expired = true;
  });
  await assert.rejects(store(ending.repository, { checkBudget() { if (expired) throw new Error('owner_deadline'); } }).stage(receipt),
    /owner_deadline/);
  assert.equal(ending.writes.some(text => JSON.parse(text).usage === 'complete_recorded_catalog_membership_only'), false);
});
