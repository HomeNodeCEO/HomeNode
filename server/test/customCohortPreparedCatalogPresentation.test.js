import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortPreparedCatalogRequest as request, presentCustomCohortPreparedCatalogResponse as present }
  from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogTransport.js';
import { customCohortPreparedCatalogSqlFixture as sqlFixture } from './fixtures/customCohortPreparedCatalogSqlFixture.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from './fixtures/customCohortPreparedCatalogRegistryFixture.js';

async function original(count, groupCount) {
  const h = sqlFixture(fixture({ count, groupCount })); await h.make().prepare();
  const body = request({ assignment_file_id: h.f.scope.assignment_file_id, context_ref: h.f.context });
  const out = { status: 'available', authority: 'not_established', context_ref: h.f.context,
    target: { account_id: h.f.scope.account_id, assignment_file_id: body.assignment_file_id }, catalog: await h.make().open() };
  return { h, body, out };
}
function replaceMetadata(out, mutate) {
  const result = structuredClone(out), metadata = JSON.parse(result.catalog.metadata_json); mutate(metadata);
  result.catalog.metadata_json = json(metadata);
  const root = JSON.parse(result.catalog.manifest_json); root.metadata_ref = blob(result.catalog.metadata_json);
  result.catalog.manifest_json = json(root); result.catalog.manifest_ref = blob(result.catalog.manifest_json); return result;
}

test('pure presentation preserves actual empty and unresolved compiler originals and directory versus page semantics', async () => {
  for (const count of [0, 1, 31, 501]) {
    const f = await original(count, count > 31 ? 237 : 0);
    assert.deepEqual(present(f.out, f.body, f.h.f.scope.account_id), f.out);
    const root = JSON.parse(f.out.catalog.manifest_json);
    for (let i = 0; i < root.pages.length; i++) {
      const page = { ...f.out, page_index: i, catalog: await f.h.make().page(i) };
      assert.deepEqual(present(page, request({ ...f.body, page_index: i }, true), f.h.f.scope.account_id, true), page);
    }
    assert.ok(!JSON.stringify(f.out).includes('"account_ids":'));
  }
});

test('self-consistent hashes never authorize alternate scope, source rows, counts or subject private data', async () => {
  const f = await original(501, 237);
  for (const mutate of [m => { m.scope.account_id = 'FOREIGN'; }, m => { m.scope.assignment_file_id = '99'; },
    m => { m.context_ref.context_sha256 = '0'.repeat(64); }, m => { m.subject_membership.source_rows = ['PRIVATE']; },
    m => { m.source_rows = ['PRIVATE']; }, m => { m.assigned_account_count = 0; },
    m => { m.limitations = ['\u0001']; }, m => { m.roster_account_ids_sha256 = {}; }])
    assert.throws(() => present(replaceMetadata(f.out, mutate), f.body, f.h.f.scope.account_id), /invalid_response/);
});

test('request grammar detaches only bounded syntax and refuses accessors, proxy and supplied roots', () => {
  const body = { assignment_file_id: '8', context_ref: { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) } };
  assert.deepEqual(request(body), body); assert.throws(() => request({ ...body, manifest_ref: {} }));
  assert.throws(() => request(Object.defineProperty({ ...body }, 'context_ref', { enumerable: true, get() { assert.fail('getter'); } })));
  assert.throws(() => request(new Proxy(body, { ownKeys() { assert.fail('proxy'); } })));
  for (const page_index of [-1, 21, '0', null]) assert.throws(() => request({ ...body, page_index }, true));
});
