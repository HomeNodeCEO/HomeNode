import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
    if (sql.includes(':exists')) assert.match(sql, /format_version IN \(1,2\)[\s\S]*LIMIT 1/);
    if (sql.includes(':read')) assert.match(sql, /format_version IN \(1,2\)[\s\S]*ORDER BY format_version DESC LIMIT 1/);
    if (sql.includes(':exists')) return { rowCount: Number(Boolean(row)), rows: row ? [{ '?column?': 1 }] : [] };
    if (sql.includes(':insert')) {
      assert.match(sql, /\$3,2,3,\$4/);
      assert.equal(row, null);
      row = { format_version: 2, payload_sha256: parameters[3], payload_utf8_bytes: parameters[4], compressed_payload: parameters[5] };
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

test('only old scoreless catalogs miss the cache; working v1 maps and complete v2 dispositions are reusable', async () => {
  const old = payload(1);
  let version = 1;
  const client = { async query(sql) {
    assert.match(sql, /ORDER BY format_version DESC LIMIT 1/);
    const bytes = Buffer.from(JSON.stringify(old));
    return { rowCount: 1, rows: [{ format_version: version, payload_sha256: hash(bytes), payload_utf8_bytes: bytes.length,
      compressed_payload: gzipSync(bytes) }] };
  } };
  const repository = createCustomCohortPreparedCatalogRepository(client, canonicalAssessmentJson(scope), contextRef);
  assert.deepEqual(await repository.read(), old, 'existing recommendations do not pay for a rebuild');
  delete old.recommendation;
  assert.equal(await repository.read(), null, 'a scoreless v1 snapshot is replayed once into v2');
  version = 2;
  assert.deepEqual(await repository.read(), old, 'intentional v2 omissions do not cause endless replay');
  old.prepared_secondary_map = { version: 2, basis: 'current_retained_cad_snapshot_diagnostic_only', groups: [] };
  assert.deepEqual(await repository.read(), old);
  assert.deepEqual(rebindCustomCohortPreparedCatalog(await repository.read(), 8).prepared_secondary_map,
    old.prepared_secondary_map, 'color scores remain selection-neutral on rebind');
});

test('the read-path existence probe admits working v1 while write-through only checks the current format', async () => {
  const queries = [];
  const client = { async query(sql, parameters) {
    queries.push(sql);
    assert.deepEqual(parameters, [scope.organization_id, contextRef.context_id, contextRef.context_sha256]);
    assert.match(sql, /LIMIT 1/, 'two immutable format versions must still return one existence row');
    const found = sql.includes('format_version IN (1,2)');
    return { rowCount: found ? 1 : 0, rows: found ? [{}] : [] };
  } };
  const repository = createCustomCohortPreparedCatalogRepository(client, canonicalAssessmentJson(scope), contextRef);
  assert.equal(await repository.exists(), true, 'v1 is available for checked read reuse');
  assert.equal(await repository.exists({ currentOnly: true }), false, 'scoreless v1 can still upgrade into v2');
  assert.match(queries[1], /format_version=2/);
});
