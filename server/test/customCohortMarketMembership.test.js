import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCustomCohortMarketMembership } from '../src/services/neighborhoodAssessment/customCohortMarketMembership.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { customCohortSelectionBinding } from '../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';

const contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const selection = () => ({ revision: 7, pockets: [{ id: 'one', label: 'One', account_ids: ['B', 'A'] },
  { id: 'two', label: 'Two', account_ids: ['B', 'C'] }] });
function fixture(accounts = ['A', 'B', 'C'], mutate = () => {}) {
  const records = new Map(), calls = [], pages = [];
  const retain = value => { const json = canonicalAssessmentJson(value), ref = prepareNeighborhoodCohortBlob(json);
    records.set(ref.content_sha256, json); return ref; };
  for (let offset = 0; offset < accounts.length; offset += 250) {
    const entries = accounts.slice(offset, offset + 250), index = pages.length;
    pages.push({ page_index: String(index), entry_count: String(entries.length), page: retain({
      collection_version: 1, kind: 'request_accounts', page_index: String(index), entries }) });
  }
  const manifest = { collection_version: 1, kind: 'request_accounts', entry_count: String(accounts.length), pages };
  mutate(manifest, records);
  const rosterRef = retain(manifest), store = { async get(hash) { calls.push(['manifest', hash]); return records.get(hash) ?? null; },
    async getPreparedBatch(refs) { calls.push(['pages', refs]); return refs.map(ref => records.has(ref.content_sha256)
      ? { reference: ref, canonicalJson: records.get(ref.content_sha256) } : null); } };
  return { args: { store, rosterRef, selection: selection(), contextRef, checkBudget() {} }, calls };
}

test('selected union and binding need only bounded original roster pages, never parcel geometry or sales rows', async () => {
  const f = fixture(), before = JSON.stringify(f.args.selection);
  const result = await checkCustomCohortMarketMembership(f.args);
  assert.deepEqual(result.accountIds, ['A', 'B', 'C']);
  assert.deepEqual(result.binding, customCohortSelectionBinding(f.args.selection, contextRef));
  assert.equal(JSON.stringify(f.args.selection), before);
  assert.equal(f.calls.length, 2);
});

test('dense roster reads retain the existing eight-page / 2 MB batch bounds', async () => {
  const f = fixture(Array.from({ length: 50000 }, (_, index) => `A${index}`));
  f.args.selection = { revision: 1, pockets: [{ id: 'all', label: 'All', account_ids: ['A0', 'A49999'] }] };
  assert.deepEqual((await checkCustomCohortMarketMembership(f.args)).accountIds, ['A0', 'A49999']);
  const batches = f.calls.filter(call => call[0] === 'pages').map(call => call[1]);
  assert.equal(batches.length, 25);
  assert.ok(batches.every(batch => batch.length <= 8 && batch.reduce((sum, ref) => sum + Number(ref.canonical_utf8_bytes), 0) <= 2000000));
});

test('empty selection stays empty and overlapping pockets cannot multiply accounts', async () => {
  const f = fixture(); f.args.selection.pockets = [];
  assert.deepEqual((await checkCustomCohortMarketMembership(f.args)).accountIds, []);
});

test('foreign accounts, duplicate IDs and malformed original manifests cannot authorize a market query', async () => {
  for (const accounts of [['A', 'B'], ['A', 'B', 'B', 'C']]) await assert.rejects(checkCustomCohortMarketMembership(fixture(accounts).args), /invalid_selection/);
  for (const mutate of [m => { m.kind = 'spatial_accounts'; }, m => { m.entry_count = '4'; },
    m => { m.pages[0].page_index = '1'; }, m => { m.pages[0].entry_count = '251'; },
    (m, records) => { records.delete(m.pages[0].page.content_sha256); }, m => { m.extra = true; }]) {
    await assert.rejects(checkCustomCohortMarketMembership(fixture(undefined, mutate).args), /invalid_selection/);
  }
  const f = fixture(); f.args.selection.pockets[0].account_ids.push('A');
  await assert.rejects(checkCustomCohortMarketMembership(f.args), /pocket_membership_limit/);
});

test('cancellation/deadline is checked before and after bounded page reads', async () => {
  const f = fixture(); f.args.checkBudget = () => { throw new Error('cancelled'); };
  await assert.rejects(checkCustomCohortMarketMembership(f.args), /cancelled/);
  assert.equal(f.calls.length, 0);
});
