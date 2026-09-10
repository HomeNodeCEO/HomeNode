import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readAssignmentSalesMatchCandidates, SALES_MATCH_CANDIDATE_SCHEMA_SQL } from '../../src/services/assignmentSalesCsv/matchCandidates.js';
import { normalizedCountyAccountKey } from '../../src/services/salesReconciliation.js';

async function identity(query, databaseName, readOnly) {
  assert.equal(typeof query, 'function');
  assert.equal(typeof databaseName, 'string'); assert.match(databaseName, /^[a-z0-9_]+_test$/);
  const row = (await query(`SELECT pg_catalog.current_database() AS database_name,
    pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address,
    pg_catalog.current_setting('transaction_read_only') AS read_only,
    pg_catalog.current_setting('transaction_isolation') AS isolation`)).rows[0];
  assert.equal(row.database_name, databaseName);
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(row.server_address));
  assert.equal(row.read_only, readOnly ? 'on' : 'off');
  if (readOnly) assert.equal(row.isolation, 'repeatable read');
  // Prove an explicit caller-owned transaction rather than acquiring one here.
  await query('SAVEPOINT assignment_sales_match_native_guard');
  await query('RELEASE SAVEPOINT assignment_sales_match_native_guard');
}

/** Import-safe, synthetic fixture setup ONLY. The already verified disposable
 * loopback database and explicit RW transaction belong to the native runner.
 * The runner commits setup before giving its separate RR/RO owner connection
 * to the reader checks. No process, pool, database creation, DROP or cleanup.
 */
export async function prepareAssignmentSalesMatchCandidatesFixture(query, { databaseName }) {
  await identity(query, databaseName, false);
  // These optional production columns/tables are installed by the existing CAD
  // quality/address/reconciliation services, not the canonical UAD migrations.
  // Do not alter any existing values or substitute a different source schema.
  await query(`ALTER TABLE core.accounts
    ADD COLUMN IF NOT EXISTS canonical_account_id text,
    ADD COLUMN IF NOT EXISTS address text,
    ADD COLUMN IF NOT EXISTS city text,
    ADD COLUMN IF NOT EXISTS county text,
    ADD COLUMN IF NOT EXISTS postal_code text;
  -- FK-only parent for minimal UAD fixtures that have no shared sales schema.
  -- No rows are seeded here and no matching/source-coverage claim uses it.
  CREATE TABLE IF NOT EXISTS core.sales_source_records(id bigint PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS app.county_account_identifiers (
    county text NOT NULL, normalized_account_id text NOT NULL, native_account_id text NOT NULL,
    account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
    verification_source text NOT NULL DEFAULT 'manual_sales_reconciliation',
    source_record_id bigint REFERENCES core.sales_source_records(id) ON DELETE SET NULL,
    reviewer text,verified_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(county,normalized_account_id));
  CREATE INDEX IF NOT EXISTS county_account_identifiers_account_idx ON app.county_account_identifiers(account_id,county);
  CREATE TABLE IF NOT EXISTS app.account_address_aliases (
    account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE CASCADE,
    address_key text NOT NULL,city_key text NOT NULL,county_key text,postal_code5 text,
    raw_address text,raw_city text,source_type text NOT NULL DEFAULT 'core_accounts',
    source_priority smallint NOT NULL DEFAULT 100,is_current boolean NOT NULL DEFAULT true,
    source_observed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(account_id,address_key,city_key,source_type));
  CREATE INDEX IF NOT EXISTS account_address_aliases_lookup_idx ON app.account_address_aliases
    (address_key,city_key,county_key,postal_code5,account_id) WHERE is_current=true;
  CREATE INDEX IF NOT EXISTS account_address_aliases_account_idx ON app.account_address_aliases(account_id,is_current,source_priority DESC)`);
  const seed = BigInt('0x' + randomBytes(6).toString('hex'));
  const ids = Array.from({ length: 15 }, (_, index) => (80_000_000_000_000_000n + seed * 20n + BigInt(index)).toString());
  const suffix = seed.toString(), city = `SYNTHETIC ${suffix}`, street = `901 ${suffix} SYNTHETIC ST`;
  const accounts = ids.map((account_id, index) => ({ account_id, county: index === 1 ? 'Collin' : 'Dallas',
    address: street, city, postal_code: '75001', canonical_account_id: null }));
  accounts[2].canonical_account_id = ids[0];
  accounts[3].canonical_account_id = '99999999999999999';
  accounts[4].canonical_account_id = ids[2]; // More than one canonical hop is not silently accepted.
  accounts[12].address = null; accounts[12].city = null; accounts[12].county = null; accounts[12].postal_code = null;
  accounts[13].address = 'X'.repeat(501);
  accounts[14].address = 'SYNTHETIC\nINVALID';
  await query(`INSERT INTO core.accounts(account_id,county,address,city,postal_code,canonical_account_id)
    SELECT account_id,county,address,city,postal_code,canonical_account_id FROM pg_catalog.jsonb_to_recordset($1::jsonb)
    r(account_id text,county text,address text,city text,postal_code text,canonical_account_id text)`, [JSON.stringify(accounts)]);
  const nativeId = `R-99${suffix}-00-01`;
  await query(`INSERT INTO app.county_account_identifiers(county,normalized_account_id,native_account_id,account_id,verification_source)
    VALUES('COLLIN',$1,$2,$3,'synthetic_private_csv_native')`, [normalizedCountyAccountKey(nativeId, 'COLLIN'), nativeId, ids[1]]);
  const aliases = [
    { account_id: ids[0], address_key: street, source_type: 'synthetic_one', is_current: true },
    { account_id: ids[0], address_key: street, source_type: 'synthetic_two', is_current: true },
    { account_id: ids[1], address_key: street, source_type: 'synthetic_foreign_county', is_current: true },
    { account_id: ids[11], address_key: street, source_type: 'synthetic_stale', is_current: false },
    ...ids.slice(5, 11).map(account_id => ({ account_id, address_key: `902 ${suffix} OVERFLOW ST`, source_type: 'synthetic_overflow', is_current: true })),
  ].map(row => ({ ...row, city_key: city, county_key: row.account_id === ids[1] ? 'COLLIN' : 'DALLAS', postal_code5: '75001' }));
  await query(`INSERT INTO app.account_address_aliases(account_id,address_key,city_key,county_key,postal_code5,source_type,is_current)
    SELECT account_id,address_key,city_key,county_key,postal_code5,source_type,is_current FROM pg_catalog.jsonb_to_recordset($1::jsonb)
    r(account_id text,address_key text,city_key text,county_key text,postal_code5 text,source_type text,is_current boolean)`, [JSON.stringify(aliases)]);
  return Object.freeze({ databaseName, accountId: ids[0], collinAccountId: ids[1], aliasAccountId: ids[2],
    brokenAccountId: ids[3], chainedAccountId: ids[4], unknownAccountId: ids[12], oversizedAccountId: ids[13],
    invalidTextAccountId: ids[14], nativeId, addressKey: street, cityKey: city, postalCode: '75001',
    overflowAddressKey: `902 ${suffix} OVERFLOW ST` });
}

/** Caller supplies its own fresh RR/RO connection after committing the above
 * synthetic setup. These are actual SQL results, not query-double claims.
 */
export async function runAssignmentSalesMatchCandidatesDatabaseChecks(query, fixture) {
  await identity(query, fixture.databaseName, true);
  const metadata = (await query(SALES_MATCH_CANDIDATE_SCHEMA_SQL)).rows;
  assert.deepEqual(metadata.map(row => [row.slot, row.ready]), [['accounts', true], ['address', true], ['county', true]]);
  const identifier = (request_id, identifier, county_key = null) => ({ request_id, kind: 'identifier', identifier,
    address_key: null, city_key: null, county_key, postal_code5: null });
  const address = (request_id, county_key = 'DALLAS', address_key = fixture.addressKey) => ({ request_id, kind: 'address',
    identifier: null, address_key, city_key: fixture.cityKey, county_key, postal_code5: fixture.postalCode });
  const requests = [identifier('lookup:1', fixture.accountId), identifier('lookup:2', fixture.aliasAccountId),
    identifier('lookup:3', fixture.nativeId, 'COLLIN'), address('lookup:4'), address('lookup:5', null),
    address('lookup:6', 'DALLAS', fixture.overflowAddressKey), identifier('lookup:7', fixture.brokenAccountId),
    identifier('lookup:8', fixture.chainedAccountId), identifier('lookup:9', fixture.unknownAccountId),
    identifier('lookup:10', fixture.oversizedAccountId), identifier('lookup:11', fixture.invalidTextAccountId),
    address('lookup:12', 'DALLAS', fixture.addressKey.replace('901 ', '903 '))];
  const executed = [];
  const observed = await readAssignmentSalesMatchCandidates(async (sql, values) => {
    executed.push({ sql, values }); return query(sql, values);
  }, { requests });
  assert.equal(executed.length, 2);
  const result = id => observed.results.find(row => row.request_id === id);
  assert.equal(result('lookup:1').status, 'complete'); assert.equal(result('lookup:1').candidates[0].account_id, fixture.accountId);
  assert.deepEqual(result('lookup:2').candidates, result('lookup:1').candidates);
  assert.equal(result('lookup:3').candidates[0].account_id, fixture.collinAccountId);
  assert.deepEqual(result('lookup:4').candidates, result('lookup:1').candidates);
  assert.equal(result('lookup:5').candidates.length, 2, 'county-less address must preserve conflicting county accounts');
  for (const id of ['lookup:6', 'lookup:7', 'lookup:8', 'lookup:10', 'lookup:11']) {
    assert.equal(result(id).status, 'unavailable'); assert.deepEqual(result(id).candidates, []);
  }
  assert.deepEqual(result('lookup:9').candidates[0], { account_id: fixture.unknownAccountId,
    address: null, city: null, county: null, postal_code: null });
  assert.equal(result('lookup:12').status, 'complete'); assert.deepEqual(result('lookup:12').candidates, []);
  const many = Array.from({ length: 600 }, (_, index) => identifier(`lookup:${index + 1}`, fixture.accountId));
  const page = await readAssignmentSalesMatchCandidates(query, { requests: many });
  assert.equal(page.results.length, 600); assert.ok(page.results.every(row => row.status === 'complete' && row.candidates.length === 1));
  // EXPLAIN confirms the generated statement is valid without asserting that a
  // tiny synthetic table must use an index when PostgreSQL prefers a seq scan.
  const plan = (await query('EXPLAIN (FORMAT JSON) ' + executed[1].sql, executed[1].values)).rows;
  assert.equal(plan.length, 1);
  return Object.freeze({ status: 'passed', checks: Object.freeze(['actual_required_source_admission',
    'exact_and_one_hop_canonical_identity', 'indexed_native_collin_bridge', 'address_duplicate_and_county_ambiguity',
    'overflow_broken_chain_and_invalid_source_unavailable', 'unknown_and_empty_not_guessed',
    'six_hundred_request_bundle', 'actual_generated_sql_explain']) });
}
