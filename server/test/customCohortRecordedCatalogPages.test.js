import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareCustomCohortRecordedCatalogSource as prepare, createCustomCohortRecordedCatalogPageStore as store,
  CUSTOM_COHORT_RECORDED_CATALOG_PAGE_LIMITS as L } from '../src/services/neighborhoodAssessment/customCohortRecordedCatalogPages.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { customCohortCatalogPageFixture as fixture } from './fixtures/customCohortCatalogPageFixture.js';
const sha = value => createHash('sha256').update(value).digest('hex');
function memory() {
  const originals = new Map(), reads = [], writes = [];
  const repository = { async put(text) { const ref = blob(text); originals.set(ref.content_sha256, text); writes.push(text); return ref; },
    async get(hash, bytes) { reads.push({ hash, bytes }); return originals.get(hash) ?? null; } };
  return { repository, originals, reads, writes };
}
const encoded = f => ({ ...f.input, catalogJson: JSON.stringify(f.catalog) });

test('actual complete catalog bridge retains every group digest/count while display pages omit all member arrays', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(), owner = store(m.repository);
  assert.equal(receipt.group_count, 238); assert.equal(receipt.account_count, 501); assert.equal(receipt.page_count, 3);
  const staged = await owner.stage(receipt), complete = await store(m.repository).reopen(await prepare(f.input), staged.manifest_ref);
  assert.equal(complete.status, 'complete_display_catalog'); assert.equal(complete.groups.length, 238);
  assert.deepEqual(complete.retention_refs, staged.retention_refs);
  assert.deepEqual(new Set(staged.retention_refs.map(r => r.content_sha256)), new Set(m.originals.keys()));
  assert.equal(complete.metadata.original_read_model_sha256, sha(f.input.catalogJson));
  assert.equal(complete.metadata.roster_account_ids_sha256, sha(JSON.stringify({ account_ids: f.accounts })));
  assert.deepEqual(complete.metadata.subject_membership, f.catalog.subject_membership);
  const expected = [...f.catalog.pockets, { id: 'discovery:unassigned', label: 'Unresolved recorded groups',
    county: null, member_count: f.catalog.unassigned.member_count, account_ids: f.catalog.unassigned.account_ids }]
    .sort((a, b) => a.id < b.id ? -1 : 1);
  assert.deepEqual(complete.groups, expected.map(({ account_ids, ...g }) => ({ ...g,
    account_ids_sha256: sha(JSON.stringify({ account_ids })) })));
  const groups = [];
  for (let pageIndex = 0; pageIndex < receipt.page_count; pageIndex++) {
    m.reads.length = 0;
    const result = await store(m.repository).readPage(await prepare(f.input), staged.manifest_ref, pageIndex);
    assert.equal(result.status, 'display_page'); assert.equal(result.page_count, 3);
    assert.equal(result.page.page_index, String(pageIndex)); assert.ok(result.page.groups.length <= L.groups_per_page);
    assert.equal(m.reads.length, 7, 'one requested page plus beginning/ending manifest/original/metadata, not all pages');
    assert.ok(!Object.hasOwn(result, 'catalog_complete')); assert.ok(Object.isFrozen(result.page.groups[0]));
    assert.ok(!JSON.stringify(result).includes('account_ids"')); groups.push(...result.page.groups);
  }
  assert.deepEqual(groups, complete.groups);
});

test('a synthetic 60001-member catalog keeps exact complete identities in small display pages without a capacity activation', async () => {
  const f = fixture({ count: 60001, groupCount: 7 }), receipt = await prepare(f.input), m = memory();
  const staged = await store(m.repository).stage(receipt), result = await store(m.repository).reopen(await prepare(f.input), staged.manifest_ref);
  assert.equal(result.metadata.account_count, 60001);
  assert.equal(result.groups.reduce((sum, g) => sum + g.member_count, 0), 60001);
  const page = await store(m.repository).readPage(receipt, staged.manifest_ref, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 5000);
  assert.ok(Buffer.byteLength(f.input.catalogJson) > 1_500_000);
  assert.equal(result.metadata.roster_account_ids_sha256, sha(JSON.stringify({ account_ids: f.accounts })));
});

test('empty and unresolved populations remain explicit; a page is never broadened or fabricated', async () => {
  for (const f of [fixture({ count: 0, groupCount: 0 }), fixture({ count: 21, groupCount: 0 })]) {
    const receipt = await prepare(f.input), m = memory(), owner = store(m.repository);
    const staged = await owner.stage(receipt), result = await owner.reopen(await prepare(f.input), staged.manifest_ref);
    assert.equal(result.metadata.unassigned_account_count, f.accounts.length);
    assert.equal(result.groups.length, f.accounts.length ? 1 : 0);
    if (!f.accounts.length) await assert.rejects(owner.readPage(receipt, staged.manifest_ref, 0), /page_index/);
    else assert.equal((await owner.readPage(receipt, staged.manifest_ref, 0)).page.groups[0].id, 'discovery:unassigned');
  }
});

test('exact installed group ceiling plus unresolved group is paged completely, and aggregate byte/operation budgets cannot reset per stage', async () => {
  const f = fixture({ count: 4097, groupCount: 2048 });
  for (const p of f.catalog.pockets) { p.label = 'L'.repeat(512); p.county = 'C'.repeat(512); }
  const receipt = await prepare(encoded(f)), m = memory(), owner = store(m.repository);
  assert.equal(receipt.group_count, 2049); assert.equal(receipt.page_count, 21);
  const staged = await owner.stage(receipt);
  assert.equal((await store(m.repository).readPage(receipt, staged.manifest_ref, 20)).page.groups.length, 49);
  for (const pageIndex of [-1, 21, 0.5, '0', NaN, Infinity]) {
    const before = m.reads.length;
    await assert.rejects(store(m.repository).readPage(receipt, staged.manifest_ref, pageIndex), /page_index/);
    assert.equal(m.reads.length, before);
  }
  let refused = false;
  for (let i = 0; i <= L.operations && !refused; i++) {
    try { await owner.stage(receipt); }
    catch (error) { assert.match(error.message, /io_bytes_limit|operations_limit/); refused = true; }
  }
  assert.equal(refused, true);
  assert.ok(m.writes.length <= L.operations);
  assert.ok(m.writes.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <= L.io_bytes);
  const over = fixture({ count: 4099, groupCount: 2049 }); await assert.rejects(prepare(over.input), /invalid_catalog/);
});

test('changed names, raw read-model bytes, subjects, exact unselected membership and foreign context cannot reuse a root', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(), staged = await store(m.repository).stage(receipt);
  const mutations = [g => { g.catalog.pockets[3].label = 'Different label'; },
    g => { g.catalog.pockets[3].county = 'Different county'; },
    g => { g.catalog.limitations.push('additional_original_display_limitation'); },
    g => { const a = g.catalog.pockets[4].account_ids[0]; g.catalog.pockets[4].account_ids[0] = g.catalog.pockets[5].account_ids[0];
      g.catalog.pockets[5].account_ids[0] = a; g.catalog.pockets[4].account_ids.sort(); g.catalog.pockets[5].account_ids.sort(); }];
  for (const mutate of mutations) {
    const other = fixture(); mutate(other); const current = await prepare(encoded(other));
    await assert.rejects(store(m.repository).reopen(current, staged.manifest_ref), /binding/);
  }
  const otherContext = { ...f.context, context_sha256: 'd'.repeat(64) }, other = fixture(); other.catalog.binding.context_ref = otherContext;
  const current = await prepare({ ...encoded(other), contextJson: JSON.stringify(otherContext) });
  await assert.rejects(store(m.repository).readPage(current, staged.manifest_ref, 0), /binding/);
  const bad = fixture(); bad.catalog.subject_membership.assigned_pocket_id = bad.catalog.pockets[1].id;
  await assert.rejects(prepare(encoded(bad)), /subject/);
});

test('complete source admission rejects partial catalogs, duplicate or missing unselected members, labels and reason traps before writes', async () => {
  const mutations = [f => { f.catalog.catalog_complete = false; }, f => { f.catalog.pockets.pop(); },
    f => { f.catalog.pockets[2].account_ids[0] = f.catalog.pockets[1].account_ids[0]; },
    f => { f.catalog.pockets[2].member_count++; }, f => { f.catalog.pockets[2].label = 'é'.repeat(257); },
    f => { f.catalog.unassigned.reason_counts[0].member_count = 2; },
    f => { f.catalog.unassigned.reason_counts.push(f.catalog.unassigned.reason_counts[0]); },
    f => { f.catalog.limitations.push(f.catalog.limitations[0]); }];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(prepare(encoded(f))); }
  let called = 0; const f = fixture(), getter = { ...f.input };
  Object.defineProperty(getter, 'catalogJson', { enumerable: true, get() { called++; return f.input.catalogJson; } });
  await assert.rejects(prepare(getter), /shape/); assert.equal(called, 0);
  await assert.rejects(prepare({ ...f.input, membership_override: [] }), /shape/);
  await assert.rejects(prepare(new Proxy(f.input, { getPrototypeOf() { throw new Error('trap'); } })), /shape/);
  const receipt = await prepare(f.input), m = memory();
  await assert.rejects(store(m.repository).stage({ ...receipt }), /issued_source_required/);
  assert.equal(m.writes.length, 0);
});

test('missing, changed or self-consistent substituted original pages fail whole reopen; an isolated page never claims whole completeness', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(), staged = await store(m.repository).stage(receipt);
  for (const ref of staged.retention_refs) {
    const saved = m.originals.get(ref.content_sha256); m.originals.delete(ref.content_sha256);
    await assert.rejects(store(m.repository).reopen(await prepare(f.input), staged.manifest_ref), /missing_or_changed_original/);
    m.originals.set(ref.content_sha256, saved);
    m.originals.set(ref.content_sha256, saved.replace('Dallas', 'Collin') + ' ');
    await assert.rejects(store(m.repository).reopen(receipt, staged.manifest_ref), /missing_or_changed_original/);
    m.originals.set(ref.content_sha256, saved);
  }
  const lastPage = JSON.parse(m.originals.get(staged.manifest_ref.content_sha256)).pages.at(-1).page_ref;
  m.originals.delete(lastPage.content_sha256);
  assert.equal((await store(m.repository).readPage(receipt, staged.manifest_ref, 0)).status, 'display_page');
  await assert.rejects(store(m.repository).readPage(receipt, staged.manifest_ref, 2), /missing_or_changed_original/);
});

test('ending fences refuse an original disappearing after page read, and mutable requests cannot rebind a held read', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(), staged = await store(m.repository).stage(receipt);
  const originalRef = staged.retention_refs[0]; let reads = 0;
  const changing = store({ put: m.repository.put, async get(...args) {
    const result = await m.repository.get(...args); if (++reads === 4) m.originals.delete(originalRef.content_sha256); return result;
  } });
  await assert.rejects(changing.readPage(receipt, staged.manifest_ref, 0), /missing_or_changed_original/);
  m.originals.set(originalRef.content_sha256, m.writes[0]);
  const mutable = { ...staged.manifest_ref }; let unblock, started;
  const entered = new Promise(r => { started = r; }); const hold = new Promise(r => { unblock = r; });
  const owned = store({ put: m.repository.put, async get(...args) { started(); await hold; return m.repository.get(...args); } });
  const read = owned.readPage(receipt, mutable, 0); await entered; mutable.content_sha256 = 'f'.repeat(64); unblock();
  assert.equal((await read).status, 'display_page');
});

test('actual cancellation settlement owns the finite lane; deadlines, storage acknowledgments and aggregate I/O remain bounded', async () => {
  const f = fixture(), receipt = await prepare(f.input), m = memory(); let finish, started;
  const hold = new Promise(r => { finish = r; }), entered = new Promise(r => { started = r; });
  const cancellation = new AbortController();
  const owned = store({ get: m.repository.get, async put(value) { started(); await hold; return m.repository.put(value); } },
    { signal: cancellation.signal });
  const pending = owned.stage(receipt); await entered;
  await assert.rejects(owned.stage(receipt), /operation_in_progress/); cancellation.abort();
  await assert.rejects(owned.stage(receipt), /cancelled/); finish(); await assert.rejects(pending, /cancelled/);
  assert.equal(m.writes.length, 1, 'actual pending storage settles, then caller rolls back provisional write');
  await assert.rejects(store({ get: m.repository.get, async put(value) { return { ...blob(value), content_sha256: 'f'.repeat(64) }; } }).stage(receipt), /storage_ack/);
  let expired = false;
  const timed = store({ put: m.repository.put, async get(...args) { const result = await m.repository.get(...args); expired = true; return result; } },
    { checkBudget() { if (expired) throw new Error('owner_deadline'); } });
  const staged = await store(m.repository).stage(receipt);
  await assert.rejects(timed.reopen(receipt, staged.manifest_ref), /owner_deadline/);
  const limited = store(m.repository);
  for (let i = 0; i < Math.floor(L.operations / 7); i++) await limited.readPage(receipt, staged.manifest_ref, 0);
  await assert.rejects(limited.readPage(receipt, staged.manifest_ref, 0), /operations_limit/);
  let called = 0; const badRef = { ...staged.manifest_ref };
  Object.defineProperty(badRef, 'canonical_utf8_bytes', { enumerable: true, get() { called++; return '500'; } });
  await assert.rejects(store(m.repository).readPage(receipt, badRef, 0), /shape/); assert.equal(called, 0);
});
