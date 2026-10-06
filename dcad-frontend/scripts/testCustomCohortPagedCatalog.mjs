import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortPagedCatalogReader as reader, requireCustomCohortPagedCatalog as requireCatalog }
  from '../src/features/neighborhood/customCohortPagedCatalog.ts';
import { prepareCustomCohortRecordedCatalogSource as prepare, createCustomCohortRecordedCatalogPageStore as store }
  from '../../server/src/services/neighborhoodAssessment/customCohortRecordedCatalogPages.js';
import { prepareNeighborhoodCohortBlob as blob } from '../../server/src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { customCohortCatalogPageFixture as fixture } from '../../server/test/fixtures/customCohortCatalogPageFixture.js';

const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 30_000 });
async function harness(options) {
  const f = fixture(options), source = await prepare(f.input), originals = new Map(), calls = [];
  const repository = { async put(text) { const r = blob(text); originals.set(r.content_sha256, text); return r; },
    async get(hash) { return originals.get(hash) ?? null; } };
  const staged = await store(repository).stage(source);
  const request = { accountId: f.scope.account_id, assignmentFileId: f.scope.assignment_file_id,
    contextRef: f.context, catalogRef: staged.manifest_ref };
  const ports = { async open(r, options) {
    calls.push({ kind: 'open', r, options }); return store(repository).open(await prepare(f.input), r.catalogRef);
  }, async page(r, index, options) {
    calls.push({ kind: 'page', r, index, options });
    const p = await store(repository).readPage(await prepare(f.input), r.catalogRef, index);
    return { page_ref: p.page_ref, page_json: json(p.page) };
  } };
  return { f, source, staged, request, ports, calls, originals, repository };
}

test('actual retained server originals produce one immutable complete browser catalog without account arrays or fake legacy catalog', async () => {
  const h = await harness(), options = io(), result = await reader(h.ports)(h.request, options);
  const original = await store(h.repository).reopen(await prepare(h.f.input), h.staged.manifest_ref);
  assert.equal(result.catalog_format, 1); assert.equal(result.catalog_version, 3);
  assert.equal(result.authority, 'not_established'); assert.equal(result.account_count, 501);
  assert.deepEqual(result.groups, original.groups); assert.deepEqual(result.subject_membership, h.f.catalog.subject_membership);
  assert.deepEqual(h.calls.map(c => c.kind), ['open', 'page', 'page', 'page', 'open']);
  assert.equal(h.calls.every(c => c.options.signal === options.signal && c.options.deadline === options.deadline), true);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.groups) && Object.isFrozen(result.groups[0]));
  assert.equal(requireCatalog(result), result); assert.throws(() => requireCatalog({ ...result }), /invalid_custom_cohort_paged_catalog/);
  assert.ok(!Object.hasOwn(result, 'pockets')); assert.ok(!JSON.stringify(result).includes('"account_ids":'));
  assert.ok(!Object.hasOwn(result, 'selected')); assert.ok(!Object.hasOwn(result, 'apply'));
});

test('60,001-member, explicit empty and wholly unresolved originals retain exact whole counts with no radius/default selection', async () => {
  for (const options of [{ count: 60001, groupCount: 7 }, { count: 0, groupCount: 0 }, { count: 11, groupCount: 0 }]) {
    const h = await harness(options), result = await reader(h.ports)(h.request, io());
    assert.equal(result.account_count, options.count);
    assert.equal(result.groups.reduce((sum, g) => sum + g.member_count, 0), options.count);
    assert.equal(result.unassigned_account_count, options.groupCount ? 1 : options.count);
    assert.equal(h.calls.filter(c => c.kind === 'page').length, h.source.page_count);
    assert.equal(h.calls.filter(c => c.kind === 'open').length, 2, 'empty also rechecks the final original/current owner');
  }
});

test('foreign or changed root/metadata/target/context and malformed closed page grammar never yield a completed catalog', async () => {
  const h = await harness(), actualOpen = await h.ports.open(h.request, io());
  const metadata = JSON.parse(actualOpen.metadata_json), root = JSON.parse(actualOpen.manifest_json);
  const headers = [{ ...actualOpen, manifest_ref: { ...actualOpen.manifest_ref, content_sha256: 'f'.repeat(64) } },
    { ...actualOpen, authority: 'established' }, { ...actualOpen, status: 'complete_catalog' },
    { ...actualOpen, metadata_json: json({ ...metadata, account_count: 502 }) },
    { ...actualOpen, metadata_json: json({ ...metadata, scope: { ...metadata.scope, account_id: 'foreign-subject' } }) },
    { ...actualOpen, metadata_json: json({ ...metadata, context_ref: { ...metadata.context_ref, context_sha256: 'd'.repeat(64) } }) },
    { ...actualOpen, manifest_json: json({ ...root, pages: [...root.pages].reverse() }) },
    { ...actualOpen, manifest_json: 'x'.repeat(16001) }, { ...actualOpen, extra: 'source_grant' }];
  for (const header of headers) {
    let pageCalls = 0;
    await assert.rejects(reader({ async open() { return header; }, async page() { pageCalls++; } })(h.request, io()), /invalid_custom_cohort_paged_catalog/);
    assert.equal(pageCalls, 0);
  }
  const actualPage = await h.ports.page(h.request, 0, io()), p = JSON.parse(actualPage.page_json);
  for (const body of [{ ...actualPage, page_ref: { ...actualPage.page_ref, content_sha256: 'f'.repeat(64) } },
    { ...actualPage, page_json: json({ ...p, page_index: '1' }) },
    { ...actualPage, page_json: json({ ...p, groups: [...p.groups].reverse() }) },
    { ...actualPage, page_json: json({ ...p, groups: p.groups.slice(1) }) },
    { ...actualPage, page_json: json({ ...p, account_ids: [] }) },
    { ...actualPage, page_json: json({ ...p, groups: p.groups.map((g, i) => i ? g : { ...g, member_count: 1000000 }) }) },
    { ...actualPage, page_json: actualPage.page_json + ' ' }]) {
    await assert.rejects(reader({ open: h.ports.open, async page() { return body; } })(h.request, io()), /invalid_custom_cohort_paged_catalog/);
  }
});

test('missing last stored page, late current-owner refusal and changed ending originals discard the entire pending result', async () => {
  const h = await harness(), root = JSON.parse(h.originals.get(h.staged.manifest_ref.content_sha256));
  const last = root.pages.at(-1).page_ref, saved = h.originals.get(last.content_sha256);
  h.originals.delete(last.content_sha256);
  await assert.rejects(reader(h.ports)(h.request, io()), /missing_or_changed_original/);
  h.originals.set(last.content_sha256, saved);
  for (const late of ['denied', 'changed']) {
    let opens = 0, pages = 0;
    const open = async (...args) => {
      const header = await h.ports.open(...args);
      if (++opens === 2) {
        if (late === 'denied') throw Object.assign(new Error('current_source_denied'), { status: 403 });
        return { ...header, metadata_json: header.metadata_json + ' ' };
      }
      return header;
    };
    await assert.rejects(reader({ open, async page(...args) { pages++; return h.ports.page(...args); } })(h.request, io()));
    assert.equal(pages, h.source.page_count); assert.equal(opens, 2);
  }
});

test('caller aliases, getters, abort and finite deadline cannot redirect a suspended catalog read', async () => {
  const h = await harness(); let finish, entered;
  const held = new Promise(r => { finish = r; }), started = new Promise(r => { entered = r; });
  const ports = { page: h.ports.page, async open(...args) { entered(); await held; return h.ports.open(...args); } };
  const mutable = structuredClone(h.request), options = io(), pending = reader(ports)(mutable, options);
  await started; mutable.accountId = 'foreign'; mutable.contextRef.context_sha256 = 'd'.repeat(64); mutable.catalogRef.content_sha256 = 'f'.repeat(64);
  finish(); const result = await pending; assert.deepEqual(result.request, h.request);
  const controller = new AbortController(); let release, admit;
  const wait = new Promise(r => { release = r; }), ready = new Promise(r => { admit = r; });
  const cancelled = reader({ page: h.ports.page, async open(...args) { admit(); await wait; return h.ports.open(...args); } })(h.request,
    { signal: controller.signal, deadline: performance.now() + 30000 });
  await ready; controller.abort(); release(); await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(reader(h.ports)(h.request, { ...io(), deadline: performance.now() - 1 }), /custom_workspace_deadline/);
  let getters = 0; const bad = { ...h.request };
  Object.defineProperty(bad, 'catalogRef', { enumerable: true, get() { getters++; return h.request.catalogRef; } });
  await assert.rejects(reader(h.ports)(bad, io()), /invalid_custom_cohort_paged_catalog/); assert.equal(getters, 0);
});

test('late hash settlement remains cancellation-fenced and input original strings are bounded before crypto', async () => {
  const h = await harness(), controller = new AbortController(), original = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const digest = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto.subtle), 'digest');
  try {
    Object.defineProperty(globalThis.crypto.subtle, 'digest', { configurable: true, value: async (...args) => {
      const result = await original(...args); controller.abort(); return result;
    } });
    await assert.rejects(reader(h.ports)(h.request, { signal: controller.signal, deadline: performance.now() + 30000 }), { name: 'AbortError' });
  } finally {
    delete globalThis.crypto.subtle.digest;
    assert.equal(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto.subtle), 'digest').value, digest.value);
  }
  const header = await h.ports.open(h.request, io()); let calls = 0;
  await assert.rejects(reader({ async open() { return { ...header, metadata_json: 'x'.repeat(32001) }; },
    async page() { calls++; } })(h.request, io()), /invalid_custom_cohort_paged_catalog/);
  assert.equal(calls, 0);
});
