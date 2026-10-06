import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob,
  NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS as READ_LIMITS } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { stageCohortPagedGroupSelectionV1 as stage, verifyCohortPagedGroupSelectionV1 as verify }
  from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1.js';
import { createCohortPagedGroupSelectionV1Store as createStore }
  from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { customCohortOpeningSelection } from '../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const group = character => `recorded-cad:${character.repeat(64)}`;
const A = group('a'), B = group('b');
const account = index => `account-${String(index).padStart(7, '0')}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scope = { organization_id: '10000000-0000-4000-8000-000000000001',
  report_file_id: '10000000-0000-4000-8000-000000000002', assignment_file_id: '1', account_id: account(0) };
const context_ref = { context_id: '10000000-0000-4000-8000-000000000003', context_revision: '1', context_sha256: 'c'.repeat(64) };
function fixture(groups = [{ id: A, account_ids: [account(0), account(1)] }, { id: B, account_ids: [account(1), account(2)] }]) {
  const descriptors = groups.map(({ id, account_ids }) => ({ id, member_count: account_ids.length,
    account_ids_sha256: sha(json({ account_ids })) })).sort((a, b) => compare(a.id, b.id));
  const metadataJson = json({ selection_version: 1, usage: 'retained_group_selection_only', scope, context_ref,
    catalog_ref: blob(json({ synthetic_catalog: groups })), revision: 7, groups: descriptors });
  const rows = groups.flatMap(({ id, account_ids }) => account_ids.map(account_id => ({ account_id, group_id: id })))
    .sort((a, b) => compare(a.account_id, b.account_id) || compare(a.group_id, b.group_id));
  const union = [...new Set(rows.map(row => row.account_id))].sort(compare);
  const selection = { pockets: union.length ? [{ account_ids: union, id: 'discovery:selected', label: 'Selected observations' }] : [], revision: 7 };
  return { metadataJson, rows, union, groups, selectionSha: sha(JSON.stringify(selection)) };
}
async function* pages(rows, width = 1000) {
  for (let i = 0; i < rows.length; i += width) yield rows.slice(i, i + width);
}
async function retain(f = fixture(), width = 1000) {
  const originals = new Map(), memberPages = [], accountPages = [];
  const keep = array => async value => { originals.set(value.ref.content_sha256, value.page_json); array.push(value); };
  const result = await stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows, width),
    onMembershipPage: keep(memberPages), onAccountPage: keep(accountPages) });
  originals.set(blob(f.metadataJson).content_sha256, f.metadataJson);
  const readPage = async ({ content_sha256 }) => originals.get(content_sha256) ?? null;
  return { result, originals, memberPages, accountPages, readPage };
}

test('overlapping original groups retain lineage but form one exact selected union and legacy digest', async () => {
  const f = fixture(), r = await retain(f, 2);
  assert.equal(r.result.membership_count, 4); assert.equal(r.result.account_count, 3);
  assert.equal(r.result.selection_sha256, f.selectionSha);
  assert.deepEqual(JSON.parse(r.accountPages[0].page_json).entries, f.union);
  const restored = await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json, readPage: r.readPage });
  assert.deepEqual(restored, r.result);
  assert.equal(restored.authority, 'not_established');
});

test('disjoint recorded-group selections keep the existing opening-selection hash byte for byte', async () => {
  const f = fixture([{ id: A, account_ids: [account(0), account(2)] }, { id: B, account_ids: [account(1)] }]);
  const old = customCohortOpeningSelection({ pockets: f.groups, unassigned: { member_count: 0, account_ids: [] } }, [B, A], 7);
  const identity = { pockets: old.pockets.map(p => ({ account_ids: p.account_ids, id: p.id, label: p.label })), revision: 7 };
  const r = await retain(f);
  assert.equal(r.result.selection_sha256, sha(JSON.stringify(identity)));
});

test('explicit empty selection and zero-member groups remain empty rather than broad defaults', async () => {
  for (const groups of [[], [{ id: A, account_ids: [] }]]) {
    const f = fixture(groups), r = await retain(f);
    assert.equal(r.result.account_count, 0); assert.equal(r.result.membership_count, 0);
    assert.equal(r.result.selection_sha256, f.selectionSha);
    assert.deepEqual(r.memberPages, []); assert.deepEqual(r.accountPages, []);
    assert.deepEqual(await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json, readPage: r.readPage }), r.result);
  }
});

test('90,000 unique accounts from overlapping 60,000-account groups are paged without duplicate analytic weight', async () => {
  const groups = [{ id: A, account_ids: Array.from({ length: 60_000 }, (_, i) => account(i)) },
    { id: B, account_ids: Array.from({ length: 60_000 }, (_, i) => account(i + 30_000)) }];
  // Catalog lineage is opaque and independently retained by the future owner;
  // this fixture does not encode that entire catalog in one original blob.
  const descriptors = groups.map(g => ({ id: g.id, member_count: g.account_ids.length,
    account_ids_sha256: sha(json({ account_ids: g.account_ids })) }));
  const metadataJson = json({ selection_version: 1, usage: 'retained_group_selection_only', scope, context_ref,
    catalog_ref: blob(json({ synthetic_catalog_revision: 1 })), revision: 7, groups: descriptors });
  async function* ordered() {
    let batch = [];
    for (let i = 0; i < 90_000; i++) {
      for (const id of [...(i < 60_000 ? [A] : []), ...(i >= 30_000 ? [B] : [])]) {
        batch.push({ account_id: account(i), group_id: id });
        if (batch.length === 1000) { yield batch; batch = []; }
      }
    }
    if (batch.length) yield batch;
  }
  const originals = new Map(); let membershipPages = 0, accountPages = 0;
  const keep = kind => async value => {
    assert.ok(Buffer.byteLength(value.page_json) <= 256_000); originals.set(value.ref.content_sha256, value.page_json);
    if (kind === 'members') membershipPages++; else accountPages++;
  };
  const result = await stage({ metadataJson, membershipPages: ordered(),
    onMembershipPage: keep('members'), onAccountPage: keep('accounts') });
  assert.equal(result.account_count, 90_000); assert.equal(result.membership_count, 120_000);
  assert.equal(membershipPages, 120); assert.equal(accountPages, 90);
  originals.set(blob(metadataJson).content_sha256, metadataJson);
  const expected = { pockets: [{ account_ids: Array.from({ length: 90_000 }, (_, i) => account(i)),
    id: 'discovery:selected', label: 'Selected observations' }], revision: 7 };
  assert.equal(result.selection_sha256, sha(JSON.stringify(expected)));
  assert.deepEqual(await verify({ metadataJson, manifestJson: result.manifest_json,
    readPage: async ({ content_sha256 }) => originals.get(content_sha256) }), result);
});

test('missing, changed, repeated, unknown and reordered memberships never produce a final manifest', async () => {
  const f = fixture();
  for (const rows of [f.rows.slice(0, -1), [...f.rows, f.rows.at(-1)], [f.rows[1], f.rows[0], ...f.rows.slice(2)],
    f.rows.map((r, i) => i === 3 ? { ...r, account_id: account(3) } : r),
    f.rows.map((r, i) => i === 3 ? { ...r, group_id: group('f') } : r)]) {
    await assert.rejects(stage({ metadataJson: f.metadataJson, membershipPages: pages(rows, 2),
      onMembershipPage: async () => {}, onAccountPage: async () => {} }), /count_mismatch|membership_order|group_digest_mismatch|unknown_group/);
  }
});

test('binding, declared limits, duplicate groups and noncanonical metadata refuse before reading rows', async () => {
  const f = fixture(), base = JSON.parse(f.metadataJson);
  for (const value of [
    { ...base, selection_version: 2 }, { ...base, revision: 0 }, { ...base, groups: [...base.groups, base.groups[0]] },
    { ...base, groups: base.groups.toReversed() },
    { ...base, groups: [{ ...base.groups[0], member_count: 1_000_001 }] },
    { ...base, scope: { ...scope, assignment_file_id: '01' } },
    { ...base, context_ref: { ...context_ref, context_revision: '2' } },
    { ...base, catalog_ref: { ...base.catalog_ref, content_sha256: 'NOT A HASH' } },
  ]) {
    let opened = false; async function* unopened() { opened = true; yield f.rows; }
    await assert.rejects(stage({ metadataJson: json(value), membershipPages: unopened(),
      onMembershipPage: async () => {}, onAccountPage: async () => {} }), /invalid_metadata/);
    assert.equal(opened, false);
  }
  await assert.rejects(stage({ metadataJson: ` ${f.metadataJson}`, membershipPages: pages(f.rows),
    onMembershipPage: async () => {}, onAccountPage: async () => {} }), /invalid_metadata/);
});

test('cancellation or aggregate budget failure during staging returns no final selection', async () => {
  const f = fixture(), signal = new AbortController(); let staged = 0;
  await assert.rejects(stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows, 2), signal: signal.signal,
    onMembershipPage: async () => { staged++; signal.abort(); }, onAccountPage: async () => {} }), /cancelled/);
  assert.equal(staged, 1);
  await assert.rejects(stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows),
    checkBudget: () => { throw new Error('synthetic owner deadline'); },
    onMembershipPage: async () => assert.fail('no rows should stage'), onAccountPage: async () => {} }), /synthetic owner deadline/);
});

test('page aliases are isolated before suspension and accessors or sparse entries are refused without invocation', async () => {
  const f = fixture(), rows = structuredClone(f.rows), staged = [];
  const result = await stage({ metadataJson: f.metadataJson, membershipPages: pages(rows),
    onMembershipPage: async value => { staged.push(value.page_json); rows[0].account_id = account(9); },
    onAccountPage: async () => {} });
  assert.equal(result.selection_sha256, f.selectionSha);
  assert.deepEqual(JSON.parse(staged[0]).entries, f.rows);
  const accessor = Object.defineProperty({ group_id: A }, 'account_id', {
    enumerable: true, get() { assert.fail('membership accessor must not run'); },
  });
  for (const rows of [[accessor], Array(1), [{ ...f.rows[0], toJSON() { assert.fail('toJSON must not run'); } }]]) {
    await assert.rejects(stage({ metadataJson: f.metadataJson, membershipPages: pages(rows),
      onMembershipPage: async () => {}, onAccountPage: async () => {} }), /invalid_membership|invalid_page/);
  }
});

test('reopening verifies original membership and union pages and exact context/revision/catalog binding', async () => {
  const f = fixture(), r = await retain(f, 2);
  const wrong = JSON.parse(f.metadataJson);
  for (const metadata of [
    { ...wrong, revision: 8 }, { ...wrong, scope: { ...scope, assignment_file_id: '2' } },
    { ...wrong, context_ref: { ...context_ref, context_sha256: 'e'.repeat(64) } },
    { ...wrong, catalog_ref: { ...wrong.catalog_ref, content_sha256: 'e'.repeat(64) } },
  ]) await assert.rejects(verify({ metadataJson: json(metadata), manifestJson: r.result.manifest_json, readPage: r.readPage }), /invalid_manifest/);
  for (const page of [...r.memberPages, ...r.accountPages]) {
    await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
      readPage: async ref => ref.content_sha256 === page.ref.content_sha256 ? null : r.readPage(ref) }), /page_conflict/);
  }
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: async ref => ref.kind === 'selection_metadata' ? null : r.readPage(ref) }), /metadata_conflict/);
  const altered = JSON.parse(r.result.manifest_json);
  altered.account_count = '2';
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(altered), readPage: r.readPage }), /manifest_conflict/);
  // A self-consistent union page is still rejected when it is not the exact
  // complete union regenerated from the original membership pages.
  const replacement = json({ selection_version: 1, kind: 'selected_accounts', page_index: '0', entries: [account(0), account(1), account(3)] });
  altered.account_count = '3'; altered.account_pages[0].page = blob(replacement);
  r.originals.set(blob(replacement).content_sha256, replacement);
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(altered), readPage: r.readPage }), /union_conflict/);
});

test('immutable store checks storage receipts and exact manifest originals without committing or granting rights', async () => {
  const f = fixture(), originals = new Map();
  const repository = { async put(text) { const ref = blob(text); originals.set(ref.content_sha256, text); return ref; },
    async get(content_sha256) { return originals.get(content_sha256) ?? null; } };
  const store = createStore(repository);
  const result = await store.stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows, 2) });
  assert.deepEqual(await store.verify({ metadataJson: f.metadataJson, manifestRef: result.manifest_ref }), result);
  originals.delete(JSON.parse(result.manifest_json).membership_pages[1].page.content_sha256);
  await assert.rejects(store.verify({ metadataJson: f.metadataJson, manifestRef: result.manifest_ref }), /page_conflict/);
  const bad = createStore({ ...repository, async put() { return { content_sha256: 'f'.repeat(64), canonical_utf8_bytes: '1' }; } });
  await assert.rejects(bad.stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows) }), /storage_conflict/);
  await assert.rejects(store.verify({ metadataJson: f.metadataJson,
    manifestRef: { ...result.manifest_ref, content_sha256: 'f'.repeat(64) } }), /missing_manifest/);
});

test('storage keeps original metadata even if the caller mutates its input during a write', async () => {
  const f = fixture(), originals = new Map(), input = { metadataJson: f.metadataJson, membershipPages: pages(f.rows) };
  const store = createStore({ async put(text) {
    input.metadataJson = json({ ...JSON.parse(f.metadataJson), revision: 9 });
    const ref = blob(text); originals.set(ref.content_sha256, text); return ref;
  }, async get(content_sha256) { return originals.get(content_sha256) ?? null; } });
  const result = await store.stage(input);
  assert.equal(result.selection_sha256, f.selectionSha);
  assert.deepEqual(await store.verify({ metadataJson: f.metadataJson, manifestRef: result.manifest_ref }), result);
});

test('oversize page and manifest references are refused before fetching their originals', async () => {
  const f = fixture(), r = await retain(f), manifest = JSON.parse(r.result.manifest_json);
  let reads = 0; const readPage = async () => { reads++; assert.fail('oversize reference must not be fetched'); };
  manifest.membership_pages[0].page.canonical_utf8_bytes = '256001';
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(manifest), readPage }), /invalid_manifest/);
  const store = createStore({ put: async () => {}, get: readPage });
  await assert.rejects(store.verify({ metadataJson: f.metadataJson,
    manifestRef: { ...r.result.manifest_ref, canonical_utf8_bytes: '750001' } }), /invalid_reference/);
  const getter = Object.defineProperty({ canonical_utf8_bytes: '100' }, 'content_sha256', {
    enumerable: true, get() { assert.fail('reference accessor must not run'); },
  });
  await assert.rejects(store.verify({ metadataJson: f.metadataJson, manifestRef: getter }), /invalid_reference/);
  assert.equal(reads, 0);
});

test('verified union visitors are immutable, ordered and bounded; a later failure never returns completion', async () => {
  const ids = Array.from({ length: 2001 }, (_, i) => account(i));
  const f = fixture([{ id: A, account_ids: ids }]), r = await retain(f);
  const visited = [];
  const restored = await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: r.readPage, onAccountPage: value => {
      assert.ok(Object.isFrozen(value) && Object.isFrozen(value.account_ids) && Object.isFrozen(value.ref));
      assert.ok(value.account_ids.length <= 1000);
      assert.equal(value.page_index, visited.length);
      assert.throws(() => { value.account_ids[0] = 'replacement'; }, TypeError);
      visited.push(value.account_ids);
    } });
  assert.deepEqual(visited.flat(), ids); assert.deepEqual(restored, r.result);
  let provisionalPages = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: ref => ref.content_sha256 === r.accountPages.at(-1).ref.content_sha256 ? null : r.readPage(ref),
    onAccountPage: () => { provisionalPages++; } }), /page_conflict/);
  assert.equal(provisionalPages, 2, 'provisional callbacks are not a final/complete-population result');
  const cancelled = new AbortController();
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: r.readPage, signal: cancelled.signal, onAccountPage: () => cancelled.abort() }), /cancelled/);
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: r.readPage, onAccountPage: async () => { throw new Error('consumer deadline'); } }), /consumer deadline/);
  let reads = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: () => { reads++; }, onAccountPage: false }), /invalid_input/);
  assert.equal(reads, 0);
  const empty = fixture([]), er = await retain(empty);
  await verify({ metadataJson: empty.metadataJson, manifestJson: er.result.manifest_json,
    readPage: er.readPage, onAccountPage: () => assert.fail('empty is not all accounts') });
});

test('fresh bounded batches verify the identical 20,001-account union with fewer read round trips', async () => {
  const ids = Array.from({ length: 20_001 }, (_, i) => account(i));
  const f = fixture([{ id: A, account_ids: ids }]), r = await retain(f);
  let oldReads = 0, singleReads = 0; const batches = [], visited = [];
  const original = await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: ref => { oldReads++; return r.readPage(ref); } });
  const result = await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: ref => { singleReads++; assert.equal(ref.kind, 'selection_metadata'); return r.readPage(ref); },
    readPages: refs => {
      assert.ok(Object.isFrozen(refs) && refs.every(Object.isFrozen));
      assert.ok(refs.length >= 2 && refs.length <= READ_LIMITS.records);
      assert.ok(refs.reduce((sum, ref) => sum + Number(ref.canonical_utf8_bytes), 0) <= READ_LIMITS.bytes);
      assert.ok(refs.every(ref => ref.kind === refs[0].kind));
      batches.push(refs); return Promise.all(refs.map(r.readPage));
    }, onAccountPage: value => {
      assert.ok(Object.isFrozen(value) && Object.isFrozen(value.account_ids));
      assert.equal(value.page_index, visited.length); visited.push(value.account_ids);
    } });
  assert.deepEqual(result, original); assert.deepEqual(result, r.result);
  assert.deepEqual(visited.flat(), ids); assert.equal(oldReads, 43);
  assert.equal(singleReads, 1); assert.equal(batches.length, 6);
  for (const kind of ['recorded_group_memberships', 'selected_accounts']) {
    assert.deepEqual(batches.filter(refs => refs[0].kind === kind).flatMap(refs => refs.map(ref => ref.page_index)),
      Array.from({ length: 21 }, (_, i) => i));
  }
  // Read-call reduction only: no wall-clock latency, installed >50k owner or
  // source-rights/browser/performance claim follows from this representation.
});

test('empty, single-page and old repository reads do not acquire a batch port', async () => {
  for (const f of [fixture([]), fixture()]) {
    const r = await retain(f); let reads = 0;
    assert.deepEqual(await verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
      readPage: ref => { reads++; return r.readPage(ref); },
      readPages: () => assert.fail('empty or single page keeps the original reader') }), r.result);
    assert.equal(reads, f.rows.length ? 3 : 1);
  }
  const f = fixture(), r = await retain(f); let reads = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
    readPage: () => { reads++; }, readPages: false }), /invalid_input/);
  assert.equal(reads, 0);
});

test('batch admission preserves existing 8-record and 2MB ceilings before opening originals', async () => {
  const f = fixture([{ id: A, account_ids: Array.from({ length: 8001 }, (_, i) => account(i)) }]);
  const r = await retain(f), manifest = JSON.parse(r.result.manifest_json);
  // Deliberately inconsistent representation references: exercise admission
  // only, then abort the port. This is not a valid original or capacity proof.
  for (const ref of manifest.membership_pages) ref.page.canonical_utf8_bytes = '256000';
  let batches = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(manifest), readPage: r.readPage,
    readPages: refs => {
      batches++; assert.equal(refs.length, 7);
      assert.equal(refs.reduce((sum, ref) => sum + Number(ref.canonical_utf8_bytes), 0), 1_792_000);
      throw new Error('synthetic admission probe');
    } }), /synthetic admission probe/);
  assert.equal(batches, 1);
  manifest.membership_pages.at(-1).page.canonical_utf8_bytes = '256001';
  let reads = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(manifest),
    readPage: () => { reads++; }, readPages: () => { reads++; } }), /invalid_manifest/);
  assert.equal(reads, 0, 'ALL declared references are validated before metadata or batch I/O');
});

test('batch missing/corrupt/order/shape failures never fall back to individual reads or deliver a result', async () => {
  const f = fixture([{ id: A, account_ids: Array.from({ length: 2001 }, (_, i) => account(i)) }]);
  const r = await retain(f);
  const mutations = [
    values => values.map((text, i) => i === 1 ? null : text),
    values => values.map((text, i) => i === 1 ? `${text} ` : text),
    values => values.toReversed(), values => values.slice(1), values => [...values, values[0]],
    values => { delete values[1]; return values; },
    values => Object.assign(values, { extra: true }),
    values => Object.defineProperty(values, '1', { enumerable: true, get() { assert.fail('accessor must not run'); } }),
    values => new Proxy(values, { get(_target, key) {
      if (key === 'then') return undefined; // Async port Promise assimilation, not verifier admission.
      assert.fail('proxy must not be read');
    } }),
  ];
  for (const mutate of mutations) {
    let singles = 0, batches = 0, callbacks = 0;
    await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json,
      readPage: ref => { singles++; assert.equal(ref.kind, 'selection_metadata'); return r.readPage(ref); },
      readPages: async refs => { batches++; return mutate(await Promise.all(refs.map(r.readPage))); },
      onAccountPage: () => { callbacks++; } }), /page_conflict|batch_conflict/);
    assert.equal(singles, 1); assert.equal(batches, 1); assert.equal(callbacks, 0);
  }
});

test('batch awaits and cached consumption obey cancellation/deadline; late failure keeps visitors provisional', async () => {
  const f = fixture([{ id: A, account_ids: Array.from({ length: 9001 }, (_, i) => account(i)) }]);
  const r = await retain(f); let provisional = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json, readPage: r.readPage,
    readPages: refs => Promise.all(refs.map(ref => ref.content_sha256 === r.accountPages.at(-1).ref.content_sha256
      ? null : r.readPage(ref))), onAccountPage: () => { provisional++; } }), /page_conflict/);
  assert.equal(provisional, 8, 'valid preceding pages are provisional, never a final prefix population');
  for (const mode of ['batch_abort', 'batch_budget', 'cached_abort']) {
    const controller = new AbortController(); let expired = false, batches = 0, callbacks = 0;
    await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: r.result.manifest_json, readPage: r.readPage,
      signal: controller.signal, checkBudget: () => { if (expired) throw new Error('synthetic owner deadline'); },
      readPages: async refs => {
        batches++; const values = await Promise.all(refs.map(r.readPage));
        if (mode === 'batch_abort') controller.abort();
        if (mode === 'batch_budget') expired = true;
        return values;
      }, onAccountPage: () => { callbacks++; if (mode === 'cached_abort') controller.abort(); } }),
    /cancelled|synthetic owner deadline/);
    assert.equal(callbacks, mode === 'cached_abort' ? 1 : 0);
    assert.equal(batches, mode === 'cached_abort' ? 2 : 1);
  }
});

test('self-consistent replacement hashes cannot change batch kind/index/count or the original complete union', async () => {
  const f = fixture([{ id: A, account_ids: Array.from({ length: 2001 }, (_, i) => account(i)) }]);
  const r = await retain(f);
  for (const changes of [{ kind: 'selected_accounts' }, { page_index: '9' }, { entries: [] }]) {
    const manifest = JSON.parse(r.result.manifest_json), first = JSON.parse(r.memberPages[0].page_json);
    const replacement = json({ ...first, ...changes }), reference = blob(replacement);
    manifest.membership_pages[0].page = reference; r.originals.set(reference.content_sha256, replacement);
    await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(manifest), readPage: r.readPage,
      readPages: refs => Promise.all(refs.map(r.readPage)) }), /page_conflict/);
  }
  const manifest = JSON.parse(r.result.manifest_json), last = JSON.parse(r.accountPages.at(-1).page_json);
  const replacement = json({ ...last, entries: [account(2002)] }), reference = blob(replacement);
  manifest.account_pages.at(-1).page = reference; r.originals.set(reference.content_sha256, replacement);
  let provisional = 0;
  await assert.rejects(verify({ metadataJson: f.metadataJson, manifestJson: json(manifest), readPage: r.readPage,
    readPages: refs => Promise.all(refs.map(r.readPage)), onAccountPage: () => { provisional++; } }), /union_conflict/);
  assert.equal(provisional, 2, 'well-hashed per-page callbacks are not authority for a substituted union');
});

test('store uses fresh prepared originals with exact receipts; malformed batches cannot replace original pages', async () => {
  const f = fixture([{ id: A, account_ids: Array.from({ length: 2001 }, (_, i) => account(i)) }]);
  const originals = new Map(); let singles = 0, batches = 0;
  const repository = {
    async put(text) { const ref = blob(text); originals.set(ref.content_sha256, text); return ref; },
    async get(hash) { singles++; return originals.get(hash) ?? null; },
    async getPreparedBatch(refs) {
      assert.equal(this, repository); batches++;
      assert.ok(Object.isFrozen(refs) && refs.every(Object.isFrozen));
      return refs.map(ref => { const text = originals.get(ref.content_sha256);
        return text ? Object.freeze({ canonicalJson: text, reference: blob(text) }) : null;
      });
    },
  };
  const store = createStore(repository), result = await store.stage({ metadataJson: f.metadataJson, membershipPages: pages(f.rows) });
  const batchPort = repository.getPreparedBatch;
  repository.getPreparedBatch = () => assert.fail('captured batch port must retain its original receiver');
  assert.deepEqual(await store.verify({ metadataJson: f.metadataJson, manifestRef: result.manifest_ref }), result);
  assert.equal(singles, 2); assert.equal(batches, 2);
  const variants = [
    values => values.toReversed(), values => values.slice(1), values => [...values, values[0]],
    values => { delete values[1]; return values; },
    values => new Proxy(values, { get(_target, key) {
      if (key === 'then') return undefined; // Async port Promise assimilation, not store admission.
      assert.fail('proxy must not be read');
    } }),
    values => Object.defineProperty(values, '1', { enumerable: true, get() { assert.fail('array getter must not run'); } }),
    values => values.map((value, i) => i ? value : Object.defineProperty({ reference: value.reference }, 'canonicalJson',
      { enumerable: true, get() { assert.fail('entry getter must not run'); } })),
    values => values.map((value, i) => i ? value : new Proxy(value, { get() { assert.fail('entry proxy must not run'); } })),
    values => values.map((value, i) => i ? value : { ...value, reference: new Proxy(value.reference,
      { get() { assert.fail('receipt proxy must not run'); } }) }),
    values => values.map((value, i) => i ? value : { ...value, reference: { ...value.reference, canonical_utf8_bytes: '1' } }),
    values => values.map((value, i) => i ? value : { ...value, canonicalJson: `${value.canonicalJson} ` }),
    values => values.map((value, i) => i ? value : null),
  ];
  for (const mutate of variants) {
    let reads = 0;
    const bad = createStore({ ...repository, async get(hash) { reads++; return originals.get(hash) ?? null; },
      async getPreparedBatch(refs) { return mutate(await batchPort.call(repository, refs)); } });
    await assert.rejects(bad.verify({ metadataJson: f.metadataJson, manifestRef: result.manifest_ref }), /storage_conflict|page_conflict/);
    assert.equal(reads, 2, 'no single-page retry after malformed batch acknowledgment');
  }
});
