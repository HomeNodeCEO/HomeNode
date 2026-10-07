import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCustomCohortRetainedCatalogReader as reader } from '../src/services/neighborhoodAssessment/customCohortRetainedCatalogReader.js';
import { prepareCustomCohortRecordedCatalogSource as prepare, createCustomCohortRecordedCatalogPageStore as store,
  CUSTOM_COHORT_RECORDED_CATALOG_PAGE_LIMITS as L } from '../src/services/neighborhoodAssessment/customCohortRecordedCatalogPages.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { customCohortCatalogPageFixture as fixture } from './fixtures/customCohortCatalogPageFixture.js';

async function harness(options) {
  const f = fixture(options), source = await prepare(f.input), originals = new Map(), reads = [];
  const repository = { async put(text) { const r = blob(text); originals.set(r.content_sha256, text); return r; },
    async get(hash, bytes) { reads.push({ hash, bytes }); return originals.get(hash) ?? null; } };
  const staged = await store(repository).stage(source), complete = await store(repository).reopen(source, staged.manifest_ref);
  const binding = { scopeJson: f.input.scopeJson, contextJson: f.input.contextJson, manifestRef: staged.manifest_ref,
    originalCatalogRef: complete.metadata.original_catalog_ref,
    sourceReadModelSha256: complete.metadata.original_read_model_sha256,
    rosterAccountIdsSha256: complete.metadata.roster_account_ids_sha256 };
  reads.length = 0;
  return { f, source, originals, reads, repository, staged, complete, binding };
}

test('fresh reader reopens ACTUAL stored compiler originals without the compiler receipt or full catalog/roster arrays', async () => {
  const h = await harness(), owned = reader(h.repository, h.binding);
  // Remove all ephemeral dense inputs. Only retained originals plus exact
  // internal binding remain; no monkey-patched compiler or synthetic receipt.
  h.f.catalog.pockets = null; h.f.accounts = null; h.f.input.catalogJson = null; h.f.input.rosterJson = null;
  const directory = await owned.open();
  assert.equal(directory.status, 'display_directory'); assert.equal(h.reads.length, 6);
  assert.ok(!Object.hasOwn(directory, 'groups'));
  const groups = [];
  for (let i = 0; i < h.source.page_count; i++) {
    h.reads.length = 0; const p = await owned.page(i);
    assert.equal(h.reads.length, 7); groups.push(...JSON.parse(p.page_json).groups);
  }
  assert.deepEqual(groups, h.complete.groups);
  assert.deepEqual(await reader(h.repository, h.binding).reopen(), h.complete);
  assert.ok(Object.isFrozen((await reader(h.repository, h.binding).reopen()).groups[0]));
});

test('retained 60001-member, explicit empty and wholly unresolved populations match exact stored whole output', async () => {
  for (const options of [{ count: 60001, groupCount: 7 }, { count: 0, groupCount: 0 }, { count: 13, groupCount: 0 }]) {
    const h = await harness(options), result = await reader(h.repository, h.binding).reopen();
    assert.deepEqual(result, h.complete); assert.equal(result.metadata.account_count, options.count);
    assert.equal(result.groups.reduce((n, g) => n + g.member_count, 0), options.count);
    assert.equal(result.authority, 'not_established'); assert.ok(!Object.hasOwn(result, 'selection'));
    if (!options.count) await assert.rejects(reader(h.repository, h.binding).page(0), /page_index/);
  }
});

test('foreign scope/context/source pins or root references cannot relabel stored originals', async () => {
  const h = await harness();
  for (const b of [
    { ...h.binding, scopeJson: json({ ...h.f.scope, report_file_id: '10000000-0000-4000-8000-000000000004' }) },
    { ...h.binding, contextJson: json({ ...h.f.context, context_sha256: 'd'.repeat(64) }) },
    { ...h.binding, sourceReadModelSha256: 'd'.repeat(64) },
    { ...h.binding, rosterAccountIdsSha256: 'd'.repeat(64) },
    { ...h.binding, originalCatalogRef: { ...h.binding.originalCatalogRef, content_sha256: 'd'.repeat(64) } },
    { ...h.binding, manifestRef: { ...h.binding.manifestRef, content_sha256: 'd'.repeat(64) } },
  ]) await assert.rejects(reader(h.repository, b).reopen(), /binding|missing_or_changed_original/);
  let called = 0; const bad = { ...h.binding };
  Object.defineProperty(bad, 'manifestRef', { enumerable: true, get() { called++; return h.binding.manifestRef; } });
  assert.throws(() => reader(h.repository, bad), /shape/); assert.equal(called, 0);
  assert.throws(() => reader(h.repository, new Proxy(h.binding, {})), /shape/);
  assert.throws(() => reader(h.repository, { ...h.binding, account_ids: [] }), /shape/);
});

test('every missing or changed original prevents whole reopen; directory/page never claims other pages were read', async () => {
  const h = await harness();
  for (const r of h.staged.retention_refs) {
    const saved = h.originals.get(r.content_sha256);
    h.originals.delete(r.content_sha256);
    await assert.rejects(reader(h.repository, h.binding).reopen(), /missing_or_changed_original/);
    h.originals.set(r.content_sha256, saved + ' ');
    await assert.rejects(reader(h.repository, h.binding).reopen(), /missing_or_changed_original/);
    h.originals.set(r.content_sha256, saved);
  }
  const root = JSON.parse(h.originals.get(h.binding.manifestRef.content_sha256)), last = root.pages.at(-1).page_ref;
  h.originals.delete(last.content_sha256);
  assert.equal((await reader(h.repository, h.binding).open()).status, 'display_directory');
  assert.deepEqual(JSON.parse((await reader(h.repository, h.binding).page(0)).page_json).groups, h.complete.groups.slice(0, 100));
  await assert.rejects(reader(h.repository, h.binding).reopen(), /missing_or_changed_original/);
});

test('self-consistent stored references still cannot bypass complete directory, metadata or original descriptor grammar', async () => {
  const changes = [
    ({ root }) => { root.group_count = '1'; },
    ({ root }) => { root.pages.reverse(); },
    ({ root }) => { root.pages[0].group_count = '99'; },
    ({ metadata }) => { metadata.assigned_account_count++; },
    ({ metadata }) => { metadata.subject_membership.assigned_pocket_id = 'discovery:unassigned'; },
    ({ metadata }) => { metadata.limitations.push(metadata.limitations[0]); },
    ({ original }) => { original.selection_command = { actor_user_id: 'not-a-display-original' }; },
    ({ original }) => { original.groups.reverse(); },
    ({ original }) => { original.groups[3].member_count++; },
    ({ original }) => { original.groups[3].account_ids_sha256 = 'd'.repeat(64); },
    ({ page }) => { page.groups[0].label = 'bad\u0000label'; },
    ({ page }) => { page.groups[0].member_count++; },
    ({ page }) => { page.account_ids = []; },
  ];
  for (const mutate of changes) {
    const h = await harness(), root = JSON.parse(h.originals.get(h.binding.manifestRef.content_sha256));
    const metadata = JSON.parse(h.originals.get(root.metadata_ref.content_sha256));
    const original = JSON.parse(h.originals.get(h.binding.originalCatalogRef.content_sha256));
    const page = JSON.parse(h.originals.get(root.pages[0].page_ref.content_sha256));
    mutate({ root, metadata, original, page });
    const keep = value => {
      // Deliberately corrupt storage can have self-consistent hash/length even
      // when the canonical blob admission would have refused the original.
      // This is not a producer receipt or a valid registry registration.
      const encoded = json(value), r = { content_sha256: createHash('sha256').update(encoded).digest('hex'),
        canonical_utf8_bytes: String(Buffer.byteLength(encoded)) };
      h.originals.set(r.content_sha256, encoded); return r;
    };
    h.binding.originalCatalogRef = keep(original); metadata.original_catalog_ref = h.binding.originalCatalogRef;
    root.metadata_ref = keep(metadata); page.metadata_ref = root.metadata_ref;
    // Normal cases use the first named page; deliberate reversed directory
    // fails admission before its page content could be interpreted.
    root.pages[0].page_ref = keep(page); h.binding.manifestRef = keep(root);
    await assert.rejects(reader(h.repository, h.binding).reopen());
  }
});

test('exact 2049-group directory reopens every descriptor while greater group or page bounds remain refused', async () => {
  const h = await harness({ count: 4097, groupCount: 2048 }), result = await reader(h.repository, h.binding).reopen();
  assert.equal(result.groups.length, 2049); assert.equal(result.metadata.account_count, 4097);
  assert.deepEqual(result, h.complete);
  assert.equal(JSON.parse((await reader(h.repository, h.binding).page(20)).page_json).groups.length, 49);
  const root = JSON.parse(h.originals.get(h.binding.manifestRef.content_sha256)); root.group_count = '2050';
  const encoded = json(root), reference = blob(encoded); h.originals.set(reference.content_sha256, encoded);
  await assert.rejects(reader(h.repository, { ...h.binding, manifestRef: reference }).open(), /count/);
});

test('late original disappearance, caller alias mutation and held storage cancellation stay fenced through actual settlement', async () => {
  const h = await harness(); let n = 0;
  const missing = reader({ async get(...args) {
    const value = await h.repository.get(...args); if (++n === 4) h.originals.delete(h.binding.originalCatalogRef.content_sha256); return value;
  } }, h.binding);
  const saved = h.originals.get(h.binding.originalCatalogRef.content_sha256);
  await assert.rejects(missing.page(0), /missing_or_changed_original/);
  h.originals.set(h.binding.originalCatalogRef.content_sha256, saved);
  let enter, finish; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { finish = r; });
  const bound = structuredClone(h.binding), cancellation = new AbortController();
  const owned = reader({ async get(...args) { enter(); await held; return h.repository.get(...args); } }, bound,
    { signal: cancellation.signal });
  const pending = owned.reopen(); await entered;
  bound.manifestRef.content_sha256 = 'd'.repeat(64); bound.scopeJson = '{}';
  await assert.rejects(owned.open(), /operation_in_progress/);
  cancellation.abort(); finish(); await assert.rejects(pending, /cancelled/);
  assert.deepEqual(await reader(h.repository, h.binding).reopen(), h.complete);
  let release, started; const wait = new Promise(r => { release = r; }), ready = new Promise(r => { started = r; });
  const aliases = structuredClone(h.binding), pinned = reader({ async get(...args) { started(); await wait; return h.repository.get(...args); } }, aliases);
  const read = pinned.open(); await ready; aliases.sourceReadModelSha256 = 'd'.repeat(64); aliases.manifestRef.content_sha256 = 'd'.repeat(64);
  release(); assert.equal((await read).status, 'display_directory');
});

test('fresh current-owner budget refusal and aggregate storage ceilings cannot be reset by a page call', async () => {
  const h = await harness(); let expired = false;
  const timed = reader({ async get(...args) { const value = await h.repository.get(...args); expired = true; return value; } }, h.binding,
    { checkBudget() { if (expired) throw new Error('owner_deadline'); } });
  await assert.rejects(timed.open(), /owner_deadline/);
  const bounded = reader(h.repository, h.binding); let refused = false;
  for (let i = 0; i < L.operations && !refused; i++) {
    try { await bounded.page(0); } catch (e) { assert.match(e.message, /operations_limit|io_bytes_limit/); refused = true; }
  }
  assert.equal(refused, true);
  for (const index of [-1, 21, 0.5, '0', NaN, Infinity]) {
    const before = h.reads.length; await assert.rejects(reader(h.repository, h.binding).page(index), /page_index/);
    assert.equal(h.reads.length, before);
  }
});
