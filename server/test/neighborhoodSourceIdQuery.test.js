import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CACHED_TRANSACTION_IDENTITY_SQL, selectCachedTransactionSourceIdsSql,
  resolveNeighborhoodCachedTransactionClosure } from '../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { createNeighborhoodCachedSourceReader, createNeighborhoodDenseCadEvidenceSourceReader }
  from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodCadEvidenceReadAccess } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const makeIds = count => [ASSESSMENT_SCOPE.account_id,
  ...Array.from({ length: count - 1 }, (_, n) => `SELECT-${String(n).padStart(5, '0')}`)].sort();
const encoded = payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) });
const snapshot = { isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
  backend_pid: 1234, snapshot: '100:100:', transaction_started_at: '2026-09-05T11:59:59.123456Z',
  statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 };
const closureFor = ids => ({ selected_account_ids: ids, source_revision: 'source-id-routing-fixture-v1',
  transactions: [{ source_record_id: '10', sale_id: null, primary_account_id: ids[0], sale_account_id: null, source_record_hash: null }],
  links: [{ parcel_link_id: '100', source_record_id: '10', source_position: 1, parcel_sequence: 1,
    account_id: 'ZZ-CLOSURE-ONLY', is_resolved: false }], legacy: [] });

test('source-ID selector keeps every original small-roster SQL literal and changes only at 10000', () => {
  assert.deepEqual(Object.keys(CACHED_TRANSACTION_IDENTITY_SQL), ['source_ids', 'transaction_identities', 'link_identities', 'legacy_identities']);
  assert.ok(Object.isFrozen(CACHED_TRANSACTION_IDENTITY_SQL));
  assert.equal(hash(CACHED_TRANSACTION_IDENTITY_SQL.source_ids), 'e3acbc57ce013702b5847d4bbd7ed66974cf775f12bb6b0f8b341c3f00311d8f');
  for (const count of [0, 1, 250, 1000, 9999]) assert.equal(selectCachedTransactionSourceIdsSql(count), CACHED_TRANSACTION_IDENTITY_SQL.source_ids);
  const large = selectCachedTransactionSourceIdsSql(10000);
  assert.notEqual(large, CACHED_TRANSACTION_IDENTITY_SQL.source_ids);
  assert.equal(hash(large), 'f9b0f804585ba205f0b2adfd9e04653ba54c0ed2b2d1eed2c60bb687df3ade70');
  for (const count of [10001, 38106, 50000]) assert.equal(selectCachedTransactionSourceIdsSql(count), large);
  for (const value of [-1, 1.5, NaN, Infinity, '10000', null, undefined, {}, 10000n]) {
    assert.throws(() => selectCachedTransactionSourceIdsSql(value), /invalid_neighborhood_source_id_sql_count/);
  }
});

test('large source-ID SQL keeps all three original membership arms, UNION distinct, numeric cursor and outer limit', () => {
  const sql = selectCachedTransactionSourceIdsSql(10000);
  assert.equal((sql.match(/\bUNION\b/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /UNION ALL/);
  assert.match(sql, /WITH selected_accounts AS MATERIALIZED \(\s+SELECT unnest\(\$1::text\[\]\) AS account_id/);
  for (const fragment of [
    'FROM core.sales_source_records src\n      JOIN selected_accounts selected ON src.primary_account_id=selected.account_id WHERE src.id>$2::bigint',
    'FROM core.sale_parcels sp\n      JOIN selected_accounts selected ON sp.account_id=selected.account_id WHERE sp.source_record_id>$2::bigint',
    'FROM core.sales sale\n      JOIN selected_accounts selected ON sale.account_id=selected.account_id',
    'WHERE sale.source_record_id IS NOT NULL AND sale.source_record_id>$2::bigint',
    ') SELECT id::text AS source_record_id FROM ids WHERE id>$2::bigint ORDER BY id LIMIT $3',
  ]) assert.ok(sql.includes(fragment), fragment);
  assert.equal((sql.match(/>\$2::bigint/g) ?? []).length, 4);
  assert.doesNotMatch(sql, /close_date|closing_date|record_type|price|area|year_built|remarks|raw_payload|county|TRIM|UPPER|LOWER|is_resolved|RECURSIVE|JOIN core\./i);
  assert.match(CACHED_TRANSACTION_IDENTITY_SQL.legacy_identities, /source_record_id IS NULL/);
});

function closureClient(closure, intercept = () => {}) {
  const calls = [];
  const client = { release() { assert.fail('closure must not release caller client'); }, async query(config) {
    const tag = config.text.match(/neighborhood-closure:([\w-]+)/)?.[1];
    assert.ok(tag); calls.push({ tag, ...config });
    const replacement = intercept(tag, config);
    if (replacement !== undefined) return replacement;
    if (tag === 'snapshot') return { rows: [{ ...snapshot }] };
    if (tag === 'source-ids') return { rows: closure.transactions.map(row => encoded({ source_record_id: row.source_record_id })) };
    if (tag === 'transaction-identities') return { rows: closure.transactions.map(row => encoded({ ...row })) };
    if (tag === 'link-identities') return { rows: closure.links.map(row => encoded({ ...row })) };
    if (tag === 'legacy-identities') return { rows: [] };
    assert.fail('unexpected closure SQL');
  } };
  return { client, calls };
}

for (const count of [9999, 10000]) test(`closure selects ${count} original validated accounts, never its expanded linked roster`, async () => {
  const ids = makeIds(count), closure = closureFor(ids);
  const input = { selected_account_ids: [...ids].reverse(), source_revision: closure.source_revision };
  input.selected_account_ids[0] = ` ${input.selected_account_ids[0]} `;
  let mutated = false;
  const fixture = closureClient(closure, tag => {
    if (tag === 'snapshot' && !mutated) { mutated = true; input.selected_account_ids.push('MUTATED-AFTER-VALIDATION'); }
  });
  const result = await resolveNeighborhoodCachedTransactionClosure(fixture.client, input);
  assert.equal(result.status, 'captured', result.reason);
  assert.equal(result.counts.accounts, count + 1, 'linked account is retained but never reseeded');
  assert.deepEqual(result.transaction_closure.selected_account_ids, ids);
  const sources = fixture.calls.filter(call => call.tag === 'source-ids');
  assert.equal(sources.length, 1);
  for (const call of sources) {
    assert.ok(call.text.includes(selectCachedTransactionSourceIdsSql(count)));
    assert.deepEqual(call.values, [ids, '0', 251]);
    assert.ok(!call.values[0].includes('ZZ-CLOSURE-ONLY'));
    assert.ok(!call.values[0].includes('MUTATED-AFTER-VALIDATION'));
  }
  assert.deepEqual(fixture.calls.slice(0, 2).map(call => call.tag), ['snapshot', 'snapshot']);
  assert.equal(fixture.calls.find(call => call.tag === 'legacy-identities').values[0].length, count);
});

test('large closure roster still requires input and caller snapshot checks before discovery', async () => {
  const ids = makeIds(10000), closure = closureFor(ids), invalid = closureClient(closure);
  await assert.rejects(resolveNeighborhoodCachedTransactionClosure(invalid.client, {
    selected_account_ids: [...ids, ids[0]], source_revision: closure.source_revision,
  }));
  assert.equal(invalid.calls.length, 0);
  const unsafe = closureClient(closure, tag => tag === 'snapshot' ? { rows: [{ ...snapshot, read_only: 'off' }] } : undefined);
  const result = await resolveNeighborhoodCachedTransactionClosure(unsafe.client, {
    selected_account_ids: ids, source_revision: closure.source_revision,
  });
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'caller_snapshot_transaction_required');
  assert.deepEqual(unsafe.calls.map(call => call.tag), ['snapshot']);
});

// Query-boundary routing doubles. Native SQL/JSONB set/byte parity is covered by
// neighborhoodSourceIdQueryDatabaseChecks, not by these compact JSON fakes.
const readerSource = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const tableText = readerSource.slice(readerSource.indexOf('const TABLES'), readerSource.indexOf('const SQL'));
const sourceCatalog = [...tableText.matchAll(/\['(core\.(?:sales_source_records|sales|sale_parcels))', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
assert.equal(new Set(sourceCatalog.map(row => row.relation)).size, 3);
function readerClient() {
  const calls = []; let connects = 0;
  const client = { release() {}, async query(config) {
    const tag = config.text.match(/neighborhood-cache:([\w-]+)/)?.[1];
    assert.ok(tag); calls.push({ tag, ...config });
    if (['begin', 'settings', 'rollback', 'commit'].includes(tag)) return { rows: [] };
    if (tag === 'scope') return { rows: [{ case_date: '2024-06-30', snapshot_date: '2024-06-30', effective_date: '2024-06-30',
      captured_at: '2026-09-05T12:00:00.000Z', captured_at_precise: '2026-09-05T12:00:00.000000Z' }] };
    if (tag === 'capabilities') return { rows: sourceCatalog.map(row => ({ ...row })) };
    if (['source-ids', 'legacy-identities'].includes(tag)) return { rows: [] };
    assert.fail(`unexpected source SQL ${tag}; no facts may be read after association drift`);
  } };
  return { calls, get connects() { return connects; }, pool: { async connect() { connects++; return client; } } };
}
async function preparedReader(count, dense = false) {
  const ids = makeIds(count), input = { scope: { ...ASSESSMENT_SCOPE }, account_ids: ids, effective_date: '2024-06-30',
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } };
  const access = createTestCachedReadAccess(input, { transactionClosure: closureFor(ids),
    ...(dense ? { accessFactory: createNeighborhoodCadEvidenceReadAccess } : {}) });
  const prepared = await access.prepare(), fixture = readerClient();
  const reader = (dense ? createNeighborhoodDenseCadEvidenceSourceReader : createNeighborhoodCachedSourceReader)(fixture.pool, { access: access.access });
  return { ids, fixture, reader, input: { ...prepared.request, auth: access.auth,
    selection_grant: prepared.selection_grant, market_grant: prepared.market_grant } };
}
for (const dense of [false, true]) for (const count of [9999, 10000]) test(`independent ${dense ? 'dense4' : 'mapping2'} reader selects ${count} original granted accounts and retains drift checks`, async () => {
  const { ids, fixture, reader, input } = await preparedReader(count, dense);
  assert.equal(input.transaction_closure.selected_account_ids.length, count);
  assert.deepEqual(input.transaction_closure.closure_account_ids, [ids[0], 'ZZ-CLOSURE-ONLY'].sort());
  const result = await reader.capture(input);
  assert.equal(result.status, 'incomplete'); assert.ok(result.incomplete_reasons.includes('transaction_association_drift'));
  const sources = fixture.calls.filter(call => call.tag === 'source-ids');
  assert.equal(sources.length, 1);
  assert.ok(sources[0].text.includes(selectCachedTransactionSourceIdsSql(count)));
  assert.deepEqual(sources[0].values, [ids, '0', 251]);
  assert.ok(!sources[0].values[0].includes('ZZ-CLOSURE-ONLY'));
  assert.deepEqual(fixture.calls.slice(0, 4).map(call => call.tag), ['begin', 'settings', 'scope', 'capabilities']);
  assert.ok(!fixture.calls.some(call => ['transactions', 'sale-links', 'legacy'].includes(call.tag)));
});

test('large-roster independent reader refuses changed stock or missing rights before connecting', async () => {
  const { fixture, reader, input } = await preparedReader(10000);
  await assert.rejects(reader.capture({ ...input, account_ids: input.account_ids.slice(1) }));
  await assert.rejects(reader.capture({ ...input, market_grant: null }));
  assert.equal(fixture.connects, 0); assert.equal(fixture.calls.length, 0);
});
