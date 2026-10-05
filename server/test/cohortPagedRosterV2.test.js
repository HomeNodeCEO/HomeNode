import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { stageCohortPagedRosterV2, verifyCohortPagedRosterV2 }
  from '../src/services/neighborhoodAssessment/cohortPagedRosterV2.js';
import { createCohortLocalQueryEvidenceFixture }
  from './fixtures/neighborhoodCohortLocalQueryEvidenceFixture.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const scope = { account_id: 'account-000000-12345678901234567890', organization_id: 'org',
  appraisal_case_id: 'case', subject_snapshot_id: 'subject' };
const selection = { id: 'selection', revision: 1, definition_sha256: 'a'.repeat(64),
  source_sha256: 'b'.repeat(64) };
const account = index => `account-${String(index).padStart(6, '0')}-12345678901234567890`;
function fixture(total) {
  const selectionHash = createHash('sha256').update('{"account_ids":[');
  const queryAccounts = [];
  for (let index = 0; index < total; index++) {
    const encoded = JSON.stringify(account(index));
    selectionHash.update(index ? `,${encoded}` : encoded);
    queryAccounts.push(encoded);
  }
  selectionHash.update('],"effective_date":"2026-08-31","scope":')
    .update(canonicalAssessmentJson(scope)).update(',"selection":')
    .update(canonicalAssessmentJson(selection)).update('}');
  const expectedSelectionSha256 = selectionHash.digest('hex');
  const compactMetadataJson = canonicalAssessmentJson({ scope, effective_date: '2026-08-31',
    authorization: { selection, selection_sha256: expectedSelectionSha256 } });
  const queryHash = createHash('sha256').update(compactMetadataJson);
  for (const encoded of queryAccounts) queryHash.update(encoded).update('\n');
  const expectedQuerySha256 = queryHash.digest('hex');
  return { compactMetadataJson, expectedSelectionSha256, expectedQuerySha256 };
}
async function* pages(total) {
  for (let start = 0; start < total; start += 1_000)
    yield Array.from({ length: Math.min(1_000, total - start) }, (_, offset) => account(start + offset));
}

test('streamed authorization digest matches the original canonical JSON for small populations', async () => {
  const input = fixture(3), staged = [];
  assert.equal(input.expectedSelectionSha256, sha(canonicalAssessmentJson({
    scope, effective_date: '2026-08-31', selection,
    account_ids: [account(0), account(1), account(2)],
  })));
  const result = await stageCohortPagedRosterV2({ ...input, pages: pages(3),
    declaredAccountCount: 3, onPage: async page => staged.push(page) });
  assert.equal(result.entry_count, 3);
  assert.equal(result.page_count, 1);
  assert.equal(JSON.parse(staged[0].page_json).entries.length, 3);
  assert.equal(sha(result.manifest_json), result.manifest_sha256);
  const reopened = await verifyCohortPagedRosterV2({ ...input, manifestJson: result.manifest_json,
    readPage: async ({ page_index }) => staged[page_index].page_json });
  assert.deepEqual(reopened, result);
});

test('streamed digests verify unchanged v1 selection and query identities', async () => {
  const old = createCohortLocalQueryEvidenceFixture(), staged = [];
  async function* originalPages() { yield old.accountIds; }
  const result = await stageCohortPagedRosterV2({
    compactMetadataJson: canonicalAssessmentJson(old.metadata), pages: originalPages(),
    declaredAccountCount: old.accountIds.length,
    expectedSelectionSha256: old.metadata.authorization.selection_sha256,
    expectedQuerySha256: old.bundle.captured_query_selection_sha256,
    onPage: async page => staged.push(page),
  });
  assert.equal(result.entry_count, old.accountIds.length);
  assert.equal(staged.length, 1);
});

test('a 60,000-account roster passes without a giant authorization preimage', async () => {
  const input = fixture(60_000);
  assert.ok(Buffer.byteLength(JSON.stringify(Array.from({ length: 60_000 }, (_, i) => account(i))))
    > 1_500_000, 'legacy canonical authorization ceiling is exceeded');
  let pageCount = 0;
  const result = await stageCohortPagedRosterV2({ ...input, pages: pages(60_000),
    declaredAccountCount: 60_000, onPage: async page => {
      assert.equal(page.page_index, pageCount++);
      assert.ok(page.page_bytes < 256_000);
    } });
  assert.equal(pageCount, 60);
  assert.equal(result.entry_count, 60_000);
  assert.equal(JSON.parse(result.manifest_json).pages.length, 60);
});

test('missing, reordered, repeated and changed pages never verify as a complete population', async () => {
  const input = fixture(3), onPage = async () => {};
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: pages(2),
    declaredAccountCount: 3, onPage }), /count_mismatch/);
  async function* reordered() { yield [account(0), account(2), account(1)]; }
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: reordered(),
    declaredAccountCount: 3, onPage }), /account_order/);
  async function* repeated() { yield [account(0), account(1)]; yield [account(1)]; }
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: repeated(),
    declaredAccountCount: 3, onPage }), /account_order/);
  async function* changed() { yield [account(0), account(1), account(4)]; }
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: changed(),
    declaredAccountCount: 3, onPage }), /selection_mismatch/);
});

test('declared counts beyond the bounded streaming contract fail before reading pages', async () => {
  const input = fixture(1);
  let opened = false;
  async function* unread() { opened = true; yield [account(0)]; }
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: unread(),
    declaredAccountCount: 1_000_001, onPage: async () => {} }), /account_limit/);
  assert.equal(opened, false);
});

test('cancellation between pages prevents final manifest publication', async () => {
  const input = fixture(1_001), abort = new AbortController();
  let staged = 0;
  await assert.rejects(stageCohortPagedRosterV2({ ...input, pages: pages(1_001),
    declaredAccountCount: 1_001, signal: abort.signal, onPage: async () => {
      staged++; abort.abort();
    } }), /cancelled/);
  assert.equal(staged, 1);
});

test('reopen rejects missing, changed, and reordered original pages', async () => {
  const input = fixture(1_001), stored = [];
  const result = await stageCohortPagedRosterV2({ ...input, pages: pages(1_001),
    declaredAccountCount: 1_001, onPage: async page => stored.push(page.page_json) });
  for (const readPage of [
    async ({ page_index }) => page_index ? null : stored[0],
    async ({ page_index }) => page_index ? stored[1].replace(account(1_000), account(1_002)) : stored[0],
    async ({ page_index }) => stored[1 - page_index],
  ]) {
    await assert.rejects(verifyCohortPagedRosterV2({ ...input,
      manifestJson: result.manifest_json, readPage }), /page_conflict/);
  }
});
