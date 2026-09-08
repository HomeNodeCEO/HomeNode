import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCustomParcelDiscoveryReadiness } from '../src/services/neighborhoodAssessment/customParcelDiscoveryReadiness.js';

const catalog = () => ({
  table_oid: '123', table_kind: 'r', sync_table_oid: '124', sync_table_kind: 'r',
  parcel_rls_active: false, sync_rls_active: false, geom_ok: true,
  account_id_ok: true, source_record_hash_ok: true, sync_run_id_ok: true, sync_id_ok: true,
});
const counts = () => ({
  table_oid: '123', sync_table_oid: '124', total_rows: '1', null_geometry: '0',
  empty_geometry: '0', invalid_geometry: '0', wrong_type: '0', wrong_srid: '0',
  nonfinite_geometry: '0', outside_wgs84_geometry: '0', unlinked_or_blank_accounts: '0',
  absent_source_hashes: '0', null_sync_run_links: '0', dangling_sync_run_links: '0',
  absent_sync_run_linkage: '0',
});
const exactIndex = () => ({
  schema: 'gis', name: 'unimportant_name', method: 'gist', valid: true, ready: true,
  live: true, partial: false, keyCount: 1, attributeCount: 1, singleExpressionKey: true,
  geographyOperatorClass: true, exactExpressionMatch: true,
  expression: '(geom)::geography',
  definition: 'CREATE INDEX unimportant_name ON gis.dcad_parcels USING gist (((geom)::geography))',
  expressionTruncated: false, definitionTruncated: false,
});
const indexResult = (indexes = [exactIndex()]) => ({ table_oid: '123', total_indexes: String(indexes.length), indexes });

function fixture({ schema = catalog(), rows = counts(), indexes = indexResult(), errorAt = -1, error } = {}) {
  const calls = [];
  const responses = [schema, rows, indexes];
  return {
    calls,
    async query(...args) {
      const position = calls.length;
      calls.push(args);
      if (position === errorAt) throw error;
      assert.ok(position < responses.length, 'no unplanned query');
      return { rows: [responses[position]] };
    },
  };
}

test('exact int64 counts are retained without lossy JS conversion; aggregate output is whitelisted', async () => {
  const rows = { ...counts(), total_rows: '9223372036854775807', null_geometry: '9007199254740993',
    invalid_geometry: '7', wrong_type: '2', wrong_srid: '3', nonfinite_geometry: '4',
    outside_wgs84_geometry: '5', unlinked_or_blank_accounts: '6', absent_source_hashes: '8',
    null_sync_run_links: '9', dangling_sync_run_links: '10', absent_sync_run_linkage: '19', owner: 'must not leak' };
  const result = await auditCustomParcelDiscoveryReadiness(fixture({ rows }));
  assert.equal(result.counts.total_rows, '9223372036854775807');
  assert.equal(result.counts.null_geometry, '9007199254740993');
  assert.equal(result.counts.absent_sync_run_linkage, '19');
  assert.equal(result.counts.owner, undefined);
  assert.equal(result.status, 'blocked');
  assert.equal(result.auditComplete, true);
});

test('clean cache never establishes source coverage or production activation', async () => {
  const result = await auditCustomParcelDiscoveryReadiness(fixture());
  assert.equal(result.status, 'cache_prerequisites_satisfied');
  assert.equal(result.cachePrerequisitesSatisfied, true);
  assert.equal(result.exactGeographyIndexEstablished, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.coverage.status, 'not_established');
  assert.equal(result.remainingPrerequisites.length, 3);
  assert.match(result.remainingPrerequisites.join(' '), /subject-point.*authorized issuer/);
});

test('empty table is not ready', async () => {
  const result = await auditCustomParcelDiscoveryReadiness(fixture({ rows: { ...counts(), total_rows: '0' } }));
  assert.equal(result.cachePrerequisitesSatisfied, false);
  assert.ok(result.blockers.includes('empty_parcel_table'));
});

test('missing tables, fields, wrong types, views and active RLS remain explicitly incomplete', async t => {
  const changes = [
    { table_oid: null, table_kind: null }, { sync_table_oid: null, sync_table_kind: null },
    { geom_ok: false }, { account_id_ok: false }, { source_record_hash_ok: false },
    { sync_run_id_ok: false }, { sync_id_ok: false }, { table_kind: 'v' },
    { sync_table_kind: 'f' }, { parcel_rls_active: true }, { sync_rls_active: true },
  ];
  for (const change of changes) await t.test(JSON.stringify(change), async () => {
    const client = fixture({ schema: { ...catalog(), ...change } });
    const result = await auditCustomParcelDiscoveryReadiness(client);
    assert.equal(client.calls.length, 1);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.auditComplete, false);
    assert.equal(result.counts, null);
    assert.equal(result.totalIndexes, null);
    assert.equal(result.productionReady, false);
    assert.ok(result.blockers.length > 0);
  });
});

test('missing index and unsuitable catalog facts never establish the exact index', async t => {
  const changes = [
    { valid: false }, { ready: false }, { live: false }, { partial: true }, { method: 'btree' },
    { keyCount: 2 }, { attributeCount: 2 }, { singleExpressionKey: false },
    { geographyOperatorClass: false }, { exactExpressionMatch: false, expression: 'ST_Buffer(geom, 1)' },
    { expressionTruncated: true }, { expression: null },
  ];
  const missing = await auditCustomParcelDiscoveryReadiness(fixture({ indexes: indexResult([]) }));
  assert.equal(missing.totalIndexes, '0');
  assert.equal(missing.exactGeographyIndexEstablished, false);
  for (const change of changes) await t.test(JSON.stringify(change), async () => {
    const result = await auditCustomParcelDiscoveryReadiness(fixture({ indexes: indexResult([{ ...exactIndex(), ...change }]) }));
    assert.equal(result.exactGeographyIndexEstablished, false);
    assert.ok(result.blockers.includes('exact_geography_index_not_established'));
  });
});

test('index names do not determine eligibility and metadata stays bounded', async () => {
  const indexes = Array.from({ length: 32 }, (_, i) => ({ ...exactIndex(), name: `other_${i}` }));
  const result = await auditCustomParcelDiscoveryReadiness(fixture({
    indexes: { ...indexResult(indexes), total_indexes: '100' },
  }));
  assert.equal(result.indexes.length, 32);
  assert.equal(result.indexMetadataTruncated, true);
  assert.equal(result.totalIndexes, '100');
  assert.equal(result.exactGeographyIndexEstablished, true);
});

test('all query errors are preserved by identity, including geometry/count failures', async () => {
  for (let errorAt = 0; errorAt < 3; errorAt += 1) {
    const error = Object.assign(new Error('database failure'), { code: 'XX000' });
    const client = fixture({ errorAt, error });
    await assert.rejects(auditCustomParcelDiscoveryReadiness(client), thrown => thrown === error);
    assert.equal(client.calls.length, errorAt + 1);
  }
});

test('malformed or inconsistent counts fail closed', async () => {
  for (const value of [0, 1n, '-1', '01', '1.5', '1e2', '', null, undefined, '9223372036854775808']) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(fixture({ rows: { ...counts(), total_rows: value } })), TypeError);
  }
  for (const change of [{ null_geometry: '2' }, { absent_sync_run_linkage: '1' }, { table_oid: '456' }, { sync_table_oid: '456' }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(fixture({ rows: { ...counts(), ...change } })), TypeError);
  }
});

test('malformed result envelopes, catalog facts and index metadata fail closed', async () => {
  for (const response of [undefined, {}, { rows: [] }, { rows: [null] }, { rows: [catalog(), catalog()] }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness({ query: async () => response }), TypeError);
  }
  for (const change of [{ geom_ok: 'true' }, { table_oid: '0' }, { table_oid: null }, { table_kind: 'table' }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(fixture({ schema: { ...catalog(), ...change } })), TypeError);
  }
  for (const change of [{ table_oid: '456' }, { total_indexes: 1 }, { indexes: [] }, { indexes: null }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(fixture({ indexes: { ...indexResult(), ...change } })), TypeError);
  }
  for (const change of [{ valid: 'true' }, { keyCount: 0 }, { definition: 'x'.repeat(2049) }, { expression: 'x'.repeat(1025) }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(fixture({ indexes: indexResult([{ ...exactIndex(), ...change }]) })), TypeError);
  }
});

test('queries are fixed read-only SQL and the caller retains connection and transaction ownership', async () => {
  const first = fixture();
  const second = fixture();
  for (const client of [first, second]) {
    client.release = () => assert.fail('must not release caller connection');
    client.end = () => assert.fail('must not close caller connection');
    await auditCustomParcelDiscoveryReadiness(client);
    assert.equal(client.calls.length, 3);
    for (const args of client.calls) {
      assert.equal(args.length, 1);
      assert.match(args[0].trim(), /^(WITH|SELECT)\b/);
      assert.doesNotMatch(args[0], /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|BEGIN|COMMIT|ROLLBACK|REINDEX|VACUUM|GRANT|REVOKE|SET)\b/i);
    }
    const sql = client.calls[1][0];
    assert.doesNotMatch(sql, /::\s*geography|ST_(MakeValid|Transform|Buffer|DWithin)/i);
    assert.match(sql, /ST_DumpPoints/);
    assert.match(sql, /ST_Z/);
    assert.match(sql, /ST_M/);
    assert.match(sql, /NOT EXISTS[\s\S]*gis\.source_sync_runs/);
    assert.match(client.calls[2][0], /indrelid = pg_catalog\.to_regclass\('gis\.dcad_parcels'\)/);
    assert.match(client.calls[2][0], /pg_catalog\.pg_depend/);
    assert.match(client.calls[2][0], /LIMIT 32/);
  }
  assert.deepEqual(first.calls, second.calls);
});

test('requires an explicit caller-owned query connection', async () => {
  for (const value of [null, undefined, {}, { query: true }]) {
    await assert.rejects(auditCustomParcelDiscoveryReadiness(value), TypeError);
  }
});
