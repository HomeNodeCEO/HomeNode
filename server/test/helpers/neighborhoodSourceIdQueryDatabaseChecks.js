import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { CACHED_TRANSACTION_IDENTITY_SQL, CACHED_TRANSACTION_IDENTITY_ORDER,
  selectCachedTransactionSourceIdsSql } from '../../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';

const relationProbe = `SELECT to_regclass('core.sales_source_records') AS sources,
  to_regclass('core.sale_parcels') AS links,to_regclass('core.sales') AS sales`;
const noSources = { sources: null, links: null, sales: null };
const compareId = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;

function fixture() {
  const sources = [], links = [], sales = [], selected = ['SEL-A', 'SEL-B', 'SEL-C'];
  const sourceKeys = new Set(), saleSourceKeys = new Set();
  const source = (id, account) => {
    id = String(id); assert.ok(!sourceKeys.has(id)); sourceKeys.add(id);
    sources.push({ id, primary_account_id: account });
  };
  const link = (id, account, resolved = true) => links.push({ id: String(links.length + 1),
    source_record_id: id === null ? null : String(id), account_id: account, is_resolved: resolved });
  const sale = (id, account) => {
    if (id !== null) { id = String(id); assert.ok(!saleSourceKeys.has(id)); saleSourceKeys.add(id); }
    sales.push({ id: String(500000 + sales.length), source_record_id: id, account_id: account });
  };
  source('1', 'SEL-A');
  source('2', 'OUTSIDE-PRIMARY'); link('2', 'SEL-B');
  source('10', 'OUTSIDE-PRIMARY'); sale('10', 'SEL-C');
  source('100', 'SEL-A'); link('100', 'SEL-A'); link('100', 'SEL-B'); sale('100', 'SEL-C');
  source('101', 'OUTSIDE-PRIMARY'); link('101', 'SEL-A', false);
  source('102', 'OUTSIDE-PRIMARY');
  for (const account of ['SEL-A', 'SEL-B', 'SEL-C', 'SEL-A', 'UNSELECTED-LINKED']) link('102', account);
  source('103', null); link('103', 'SEL-A', null);
  source('104', null); sale('104', 'SEL-B');
  source('105', null);
  source('106', 'OUTSIDE-PRIMARY'); link('106', null); sale('106', null);
  link(null, 'SEL-A'); sale(null, 'SEL-A');
  // Orphans must remain discovered for the later identity read to reject.
  link('2001', 'SEL-A', false); sale('2002', 'SEL-C'); link('9001', 'OUTSIDE-PRIMARY', false);
  source('201', 'SEL-A'); link('201', 'SECOND-HOP-BRIDGE');
  source('202', 'SECOND-HOP-BRIDGE');
  source('203', 'OUTSIDE-PRIMARY'); link('203', 'SECOND-HOP-BRIDGE');
  source('204', 'OUTSIDE-PRIMARY'); sale('204', 'SECOND-HOP-BRIDGE');
  source('301', 'sel-a'); source('302', ' SEL-A ');
  source('9007199254740992', 'SEL-B');
  source('9007199254740993', 'OUTSIDE-PRIMARY'); link('9007199254740993', 'SEL-A');
  source('9223372036854775807', 'OUTSIDE-PRIMARY'); sale('9223372036854775807', 'SEL-C');
  for (let n = 0; n < 1100; n++) {
    const id = String(1000000 + n * 100);
    source(id, n % 3 === 0 ? 'SEL-A' : 'OUTSIDE-BULK');
    if (n % 3 === 1) link(id, 'SEL-B', n % 11 !== 0);
    if (n % 3 === 2) sale(id, 'SEL-C');
    if (n % 5 === 0) link(id, 'SEL-A');
    if (n % 7 === 0) link(id, 'UNSELECTED-LINKED');
  }
  for (let n = 0; n < 2000; n++) {
    const id = String(10000000 + n * 100), account = 'OUTSIDE-' + (n % 300);
    source(id, account); link(id, account, n % 2 === 0); sale(id, account);
  }
  for (const size of [1, 250, 251, 500, 501]) {
    for (let n = 1; n <= size; n++) source(String(100000000 + size * 10000 + n), `PAGE-${size}`);
  }
  const expectedIds = (accounts, cursor = '0') => {
    const seeds = new Set((accounts ?? []).filter(account => account !== null)), ids = new Set();
    for (const row of sources) if (seeds.has(row.primary_account_id)) ids.add(row.id);
    for (const row of [...links, ...sales]) {
      if (seeds.has(row.account_id) && row.source_record_id !== null) ids.add(row.source_record_id);
    }
    return [...ids].filter(id => BigInt(id) > BigInt(cursor)).sort(compareId);
  };
  const expected = expectedIds(selected);
  assert.equal(expected.length, 1114);
  for (const id of ['1', '2', '10', '100', '101', '102', '103', '104', '201', '2001', '2002',
    '9007199254740992', '9007199254740993', '9223372036854775807']) assert.ok(expected.includes(id));
  for (const id of ['105', '106', '202', '203', '204', '301', '302', '9001']) assert.ok(!expected.includes(id));
  return { sources, links, sales, selected, expectedIds };
}

/** Run before any native coordinator source fixture in a freshly migrated,
 * independently URL/socket-verified loopback test database. Refuse existing
 * source relations; all minimal schema/data changes belong to one rollback.
 * The write-capable fixture transaction proves actual SQL parity, not source
 * authorization, complete acquisition, or a new RR/RO lifecycle guarantee. */
export async function runNeighborhoodSourceIdQueryDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { default: pg } = await import('pg'); // URL and test-mode guard precede pg loading/connection.
  const started = performance.now(), deadline = started + 60_000;
  let queries = 0, begun = false;
  const check = () => assert.ok(performance.now() < deadline, 'source_id_native_work_check_budget');
  const client = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 5000, query_timeout: 6000, application_name: 'neighborhood_source_id_query_native',
    // Preserve native JSONB text rather than comparing a JavaScript re-encoding.
    types: { getTypeParser: (oid, format) => oid === 3802 && format !== 'binary'
      ? value => value : pg.types.getTypeParser(oid, format) } });
  const query = async (text, values) => {
    check(); assert.ok(++queries <= 200, 'source_id_native_query_budget');
    const result = await client.query({ text, values, query_timeout: Math.max(1, Math.min(6000, Math.ceil(deadline - performance.now()))) });
    check(); return result;
  };
  const small = selectCachedTransactionSourceIdsSql(9999), large = selectCachedTransactionSourceIdsSql(10000);
  assert.equal(small, CACHED_TRANSACTION_IDENTITY_SQL.source_ids);
  assert.notEqual(large, small, 'exercise both actual selector branches, never a copied candidate');
  const wrap = (sql, maximum) => `WITH projected AS MATERIALIZED (${sql}), encoded AS (
    SELECT to_jsonb(projected) AS payload FROM projected)
    SELECT CASE WHEN octet_length(payload::text)<=${maximum} THEN payload ELSE NULL END AS payload,
      octet_length(payload::text) AS row_bytes FROM encoded ORDER BY ${CACHED_TRANSACTION_IDENTITY_ORDER['source-ids']}`;
  const data = fixture();
  const wide = [...data.selected, ...Array.from({ length: 38103 }, (_, n) => `EMPTY-${n}`)];
  assert.equal(selectCachedTransactionSourceIdsSql(wide.length), large);
  const pages = async (sql, accounts, cursor = '0', maximum = 64000) => {
    const result = { pages: [], retained: [] };
    for (let index = 0; index < 30; index++) {
      const rows = (await query(wrap(sql, maximum), [accounts, cursor, 251])).rows;
      assert.ok(rows.length <= 251); result.pages.push(rows);
      let previous = BigInt(cursor);
      // Check the lookahead too; returned-byte totals below include it.
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ['payload', 'row_bytes']);
        assert.equal(typeof row.payload, 'string');
        assert.ok(Number.isSafeInteger(row.row_bytes) && row.row_bytes > 0 && row.row_bytes <= maximum);
        assert.equal(Buffer.byteLength(row.payload), row.row_bytes);
        const payload = JSON.parse(row.payload);
        assert.deepEqual(Object.keys(payload), ['source_record_id']);
        assert.match(payload.source_record_id, /^[1-9][0-9]{0,18}$/);
        const id = BigInt(payload.source_record_id);
        assert.ok(id > previous && id <= 9223372036854775807n, 'strict_numeric_source_order'); previous = id;
      }
      result.retained.push(...rows.slice(0, 250));
      if (rows.length <= 250) return result;
      cursor = JSON.parse(rows[249].payload).source_record_id;
    }
    assert.fail('source_id_native_page_budget');
  };
  const compare = async (accounts, cursor = '0', maximum = 64000) => {
    // Deliberately bind the SAME roster/cursor to the two selected SQL strings.
    const a = await pages(small, accounts, cursor, maximum), b = await pages(large, accounts, cursor, maximum);
    assert.deepEqual(a.pages, b.pages, 'every_native_page_payload_bytes_and_order');
    assert.deepEqual(a.retained, b.retained);
    const ids = a.retained.map(row => JSON.parse(row.payload).source_record_id);
    assert.deepEqual(ids, data.expectedIds(accounts, cursor), 'independent_complete_three_arm_union');
    assert.equal(new Set(ids).size, ids.length);
    return a;
  };
  let result;
  try {
    await client.connect();
    verifyNeighborhoodCiConnection((await query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, target.databaseName);
    assert.deepEqual((await query(relationProbe)).rows, [noSources], 'refuse existing source fixtures before any DDL');
    begun = true;
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await query("SET LOCAL timezone='UTC'; SET LOCAL jit=off; SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    await query(`CREATE SCHEMA IF NOT EXISTS core;
      CREATE TABLE core.sales_source_records(id bigint PRIMARY KEY,primary_account_id text);
      CREATE INDEX source_id_native_primary_idx ON core.sales_source_records(primary_account_id);
      CREATE TABLE core.sale_parcels(id bigint PRIMARY KEY,source_record_id bigint,account_id text,is_resolved boolean);
      CREATE INDEX source_id_native_link_idx ON core.sale_parcels(account_id,source_record_id);
      CREATE TABLE core.sales(id bigint PRIMARY KEY,source_record_id bigint UNIQUE,account_id text);
      CREATE INDEX source_id_native_sale_idx ON core.sales(account_id)`);
    await query(`INSERT INTO core.sales_source_records SELECT id,primary_account_id
      FROM jsonb_to_recordset($1::jsonb) AS input(id bigint,primary_account_id text)`, [JSON.stringify(data.sources)]);
    await query(`INSERT INTO core.sale_parcels SELECT id,source_record_id,account_id,is_resolved
      FROM jsonb_to_recordset($1::jsonb) AS input(id bigint,source_record_id bigint,account_id text,is_resolved boolean)`, [JSON.stringify(data.links)]);
    await query(`INSERT INTO core.sales SELECT id,source_record_id,account_id
      FROM jsonb_to_recordset($1::jsonb) AS input(id bigint,source_record_id bigint,account_id text)`, [JSON.stringify(data.sales)]);
    await query('ANALYZE core.sales_source_records; ANALYZE core.sale_parcels; ANALYZE core.sales');
    const baseline = await compare(wide);
    assert.deepEqual(baseline.pages.map(rows => rows.length), [251, 251, 251, 251, 114]);
    const closure = await compare(wide, '0', 2048);
    assert.deepEqual(closure.pages, baseline.pages, 'closure/source wrappers retain identical native bytes');
    const boundaryPages = [];
    for (const [count, lengths] of [[1, [1]], [250, [250]], [251, [251, 1]], [500, [251, 250]], [501, [251, 251, 1]]]) {
      const batch = await compare([`PAGE-${count}`]);
      assert.deepEqual(batch.pages.map(rows => rows.length), lengths);
      boundaryPages.push({ count, page_lengths: lengths });
    }
    for (const cursor of ['3', '100', '1000750', '9007199254740992', '9007199254740993', '9223372036854775806', '9223372036854775807']) {
      await compare(data.selected, cursor);
    }
    // SQL robustness, not admission of these arrays by the production owner.
    for (const accounts of [[], null, [null], [...data.selected, data.selected[0], null, data.selected[1]], ['MISSING'],
      [...data.selected, ...Array.from({ length: 997 }, (_, n) => `EMPTY-${n}`)]]) await compare(accounts);
    const legacy = (await query(CACHED_TRANSACTION_IDENTITY_SQL.legacy_identities, [wide, '0', 251])).rows;
    assert.deepEqual(legacy, data.sales.filter(row => row.source_record_id === null && data.selected.includes(row.account_id))
      .map(row => ({ sale_id: row.id, sale_account_id: row.account_id })));
    assert.equal(legacy.length, 1);
    assert.ok(!data.expectedIds(wide).includes(legacy[0].sale_id), 'null-source legacy remains separate');
    const digest = createHash('sha256');
    for (const row of baseline.retained) digest.update(row.payload).update('\n');
    result = { checks: ['actual_selector_small_large_native_sql_parity', 'three_arm_union_and_one_hop_scope',
      'orphan_and_unresolved_discovery', 'native_jsonb_bytes_and_numeric_keyset_pages', 'separate_null_source_legacy', 'rollback_only_fixture'],
    bound_account_count: wide.length, retained_source_ids: baseline.retained.length, boundary_pages: boundaryPages,
    native_payload_sha256: digest.digest('hex'),
    retained_payload_utf8_bytes: baseline.retained.reduce((sum, row) => sum + row.row_bytes, 0),
    returned_payload_utf8_bytes: baseline.pages.flat().reduce((sum, row) => sum + row.row_bytes, 0) };
    await query('ROLLBACK'); begun = false;
    assert.deepEqual((await query(relationProbe)).rows, [noSources], 'all source fixture relations disappear on rollback');
  } finally {
    try { if (begun) await client.query('ROLLBACK'); } finally { await client.end(); }
  }
  return { ...result, queries, elapsed_ms: Math.ceil(performance.now() - started) };
}
