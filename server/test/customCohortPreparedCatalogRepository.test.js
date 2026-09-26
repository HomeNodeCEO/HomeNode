import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortPreparedCatalogRepository,
  rebindCustomCohortPreparedCatalog } from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogRepository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const contextRef = { context_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', context_revision: '1',
  context_sha256: 'a'.repeat(64) };
const scope = { organization_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  report_file_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assignment_file_id: '14', account_id: '123' };
const binding = revision => ({ context_ref: contextRef, selection_revision: revision,
  selection_sha256: hash(JSON.stringify({ pockets: [], revision })) });
const payload = revision => ({ catalog: { catalog_version: 3, catalog_complete: true,
  authority: 'not_established', apply: { status: 'blocked' }, binding: binding(revision),
  pockets: [{ id: 'one', account_ids: ['123'] }], unassigned: { account_ids: [] } },
  recommendation: { authority: 'not_established', apply: { status: 'blocked' },
    binding: binding(revision), sales_aware_area: { status: 'unavailable' } } });

test('prepared catalog is immutable, selection-neutral, and rebinds a later workspace revision', async () => {
  let row = null;
  const client = { async query(sql, parameters) {
    assert.deepEqual(parameters.slice(0, 3), [scope.organization_id, contextRef.context_id, contextRef.context_sha256]);
    if (sql.includes(':exists')) return { rowCount: Number(Boolean(row)), rows: row ? [{ '?column?': 1 }] : [] };
    if (sql.includes(':insert')) {
      assert.equal(row, null);
      row = { payload_sha256: parameters[3], payload_utf8_bytes: parameters[4], compressed_payload: parameters[5] };
      return { rowCount: 1, rows: [{ payload_sha256: row.payload_sha256 }] };
    }
    if (sql.includes(':read')) return { rowCount: Number(Boolean(row)), rows: row ? [{ ...row }] : [] };
    throw new Error('unexpected_sql');
  } };
  const repository = createCustomCohortPreparedCatalogRepository(client, canonicalAssessmentJson(scope), contextRef);
  assert.equal(await repository.exists(), false);
  assert.equal((await repository.put(payload(7))).status, 'prepared');
  const saved = await repository.read();
  assert.equal(saved.catalog.binding.selection_revision, 1);
  assert.equal(saved.catalog.binding.selection_sha256, binding(1).selection_sha256);
  const rebound = rebindCustomCohortPreparedCatalog(saved, 19);
  assert.equal(rebound.catalog.binding.selection_sha256, binding(19).selection_sha256);
  assert.deepEqual(rebound.recommendation.binding, rebound.catalog.binding);
  assert.equal(saved.catalog.binding.selection_revision, 1);
  row.payload_sha256 = '0'.repeat(64);
  await assert.rejects(repository.read(), /custom_cohort_prepared_catalog_storage_conflict/);
});

test('prepared catalog rejects selected-pocket bindings and private data', async () => {
  const client = { query: async () => { throw new Error('unexpected_query'); } };
  const repository = createCustomCohortPreparedCatalogRepository(client, canonicalAssessmentJson(scope), contextRef);
  await assert.rejects(repository.put({ ...payload(2), private_sales: {} }), /invalid_payload/);
  const selected = payload(2);
  selected.catalog.binding.selection_sha256 = hash(JSON.stringify({ pockets: [{ id: 'one' }], revision: 2 }));
  await assert.rejects(repository.put(selected), /invalid_payload/);
});
