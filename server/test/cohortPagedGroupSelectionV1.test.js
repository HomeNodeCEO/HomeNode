import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
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
