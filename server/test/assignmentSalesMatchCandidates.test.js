import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssignmentSalesMatchCandidates, SALES_MATCH_CANDIDATE_SCHEMA_SQL } from '../src/services/assignmentSalesCsv/matchCandidates.js';
import { proposeAssignmentSalesMatchPage } from '../src/services/assignmentSalesCsv/matchProposals.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { getAssignmentSalesImportMatchProposals } from '../src/services/assignmentSalesCsv/storage.js';
import { prepareAssignmentSalesMatchCandidatesFixture } from './helpers/assignmentSalesMatchCandidatesDatabaseChecks.js';

const AT = '2026-09-10T12:00:00.000Z';
const id = (request_id = 'lookup:1', identifier = '00000000000000001', county_key = null) => ({ request_id,
  kind: 'identifier', identifier, address_key: null, city_key: null, county_key, postal_code5: null });
const address = (request_id = 'lookup:1', county_key = 'DALLAS') => ({ request_id, kind: 'address', identifier: null,
  address_key: '1 MAIN ST', city_key: 'DALLAS', county_key, postal_code5: '75001' });
const candidate = (account_id = '00000000000000001', changes = {}) => ({ account_id, address: '1 MAIN ST',
  city: 'DALLAS', county: 'Dallas', postal_code: '75001', ...changes });
const metadata = (overrides = {}) => ['accounts', 'county', 'address'].map(slot => ({ slot, ready: overrides[slot] ?? true, observed_at: AT }));
const result = (request_id = 'lookup:1', candidates = [candidate()], changes = {}) => ({ request_id,
  probe_count: candidates.length, invalid_count: 0, payload_overflow: false, candidates, ...changes });
function fixture(rows = [result()], schema = metadata()) {
  const calls = []; return { calls, async query(sql, params) {
    calls.push({ sql, params }); return { rows: sql.includes(':schema') ? schema : rows };
  } };
}
const invoke = (f, requests = [id()]) => readAssignmentSalesMatchCandidates(f.query, { requests });
test('two bounded reads, exact request identity, detached/frozen canonical output and no transaction ownership', async () => {
  const row = candidate(), f = fixture([result('lookup:1', [row])]), request = id();
  const value = await invoke(f, [request]);
  assert.deepEqual(value, { observed_at: AT, results: [{ request_id: 'lookup:1', status: 'complete', candidates: [row] }] });
  row.address = 'ALTERED'; request.identifier = 'CHANGED';
  assert.equal(value.results[0].candidates[0].address, '1 MAIN ST');
  assert.ok(Object.isFrozen(value.results[0].candidates[0])); assert.ok(Object.isFrozen(value.results));
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.calls[1].params[0])[0].identifier, '00000000000000001');
  assert.doesNotMatch(f.calls.map(call => call.sql).join('\n'), /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|BEGIN|COMMIT|ROLLBACK)\b/i);
});
test('installed metadata admission uses equivalent indexed columns, actual types, privileges and no RLS-hidden completeness', () => {
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /indisvalid AND i.indisready AND i.indislive/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /amname='btree'/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /indisunique AND i.indnkeyatts=1/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /i.keys\[1:2\]=ARRAY\['address_key','city_key'\]/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /NOT s.relrowsecurity/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /has_schema_privilege/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /has_table_privilege/);
  assert.match(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /pg_catalog.varchar/);
  assert.doesNotMatch(SALES_MATCH_CANDIDATE_SCHEMA_SQL, /_lookup_idx|accounts_pkey/);
});
test('bounded key probes precede canonical payload, and only exact indexed Collin/address predicates are used', async () => {
  const f = fixture(); await invoke(f); const sql = f.calls[1].sql;
  assert.equal((sql.match(/LIMIT 6/g) || []).length, 3);
  assert.match(sql, /LEFT JOIN LATERAL/); assert.match(sql, /probed AS MATERIALIZED/);
  assert.match(sql, /a\.county='COLLIN' AND a\.normalized_account_id=r\.collin_key/);
  assert.match(sql, /a\.address_key=r\.address_key AND a\.city_key=r\.city_key/);
  assert.match(sql, /a\.is_current=true/); assert.match(sql, /payload_bytes>1572864/);
  assert.match(sql, /char_length\(address\)<=500/); assert.match(sql, /canonical_account_id\)=account_id/);
  assert.doesNotMatch(sql, /ILIKE|regexp_replace|source_record|raw_address|native_account_id|source_attributes/i);
});
test('same county native reference uses existing normalized Collin bridge without rewriting original ID', async () => {
  const f = fixture([result('lookup:1', [candidate(undefined, { county: 'Collin' })])]);
  const value = await invoke(f, [id('lookup:1', 'R-1234-567-89', 'COLLIN')]);
  const sent = JSON.parse(f.calls[1].params[0])[0];
  assert.equal(sent.identifier, 'R-1234-567-89'); assert.equal(sent.collin_key, '123456789');
  assert.equal(value.results[0].status, 'complete');
});
test('R-prefixed native reference infers lookup lane only, never candidate county', async () => {
  const f = fixture([result('lookup:1', [candidate(undefined, { county: null, address: null, city: null, postal_code: null })])]);
  const value = await invoke(f, [id('lookup:1', 'R-1234-567-89')]);
  assert.equal(JSON.parse(f.calls[1].params[0])[0].collin_key, '123456789');
  assert.equal(value.results[0].candidates[0].county, null);
  assert.equal(value.results[0].candidates[0].address, null);
});
test('missing aliases only make address requests unavailable; exact identifier still works', async () => {
  const f = fixture([result()], metadata({ address: false }));
  const value = await invoke(f, [id(), address('lookup:2')]);
  assert.deepEqual(value.results.map(row => row.status), ['complete', 'unavailable']);
  assert.doesNotMatch(f.calls[1].sql, /app\.account_address_aliases/);
  assert.equal(JSON.parse(f.calls[1].params[0]).length, 1);
});
test('unavailable indexed Collin bridge cannot silently become a complete exact-only lookup', async () => {
  const f = fixture([result()], metadata({ county: false }));
  const value = await invoke(f, [id(), id('lookup:2', 'R-1234-567-89')]);
  assert.deepEqual(value.results.map(row => row.status), ['complete', 'unavailable']);
  assert.doesNotMatch(f.calls[1].sql, /app\.county_account_identifiers/);
});
for (const requests of [[id()], [address()], []]) test(`unavailable core source never queries CAD (${requests[0]?.kind ?? 'empty'})`, async () => {
  const f = fixture([], metadata({ accounts: false })), value = await invoke(f, requests);
  assert.equal(f.calls.length, 1); assert.ok(value.results.every(row => row.status === 'unavailable'));
});
test('no usable lanes and an empty request bundle perform metadata only', async () => {
  for (const requests of [[address()], []]) {
    const f = fixture([], metadata({ address: false })); await invoke(f, requests); assert.equal(f.calls.length, 1);
  }
});
test('complete zero results are distinct from unavailable; null/blank source values are not replaced', async () => {
  const f = fixture([result('lookup:1', []), result('lookup:2', [candidate(undefined, { address: '', city: null, county: null, postal_code: null })])]);
  const value = await invoke(f, [address(), id('lookup:2')]);
  assert.deepEqual(value.results[0], { request_id: 'lookup:1', status: 'complete', candidates: [] });
  assert.equal(value.results[1].candidates[0].address, '');
});
test('five candidates remain visibly ambiguous, six-probe sentinel is unavailable without a clipped candidate', async () => {
  const five = Array.from({ length: 5 }, (_, index) => candidate(String(index + 1).padStart(17, '0'))).reverse();
  const f = fixture([result('lookup:1', five), result('lookup:2', [], { probe_count: 6 })]);
  const value = await invoke(f, [address(), address('lookup:2')]);
  assert.equal(value.results[0].candidates.length, 5); assert.equal(value.results[0].candidates[0].account_id, '00000000000000001');
  assert.deepEqual(value.results[1], { request_id: 'lookup:2', status: 'unavailable', candidates: [] });
});
test('duplicate aliases within a fully observed probe set dedupe without inventing extra accounts', async () => {
  const value = await invoke(fixture([result('lookup:1', [candidate()], { probe_count: 5 })]), [address()]);
  assert.equal(value.results[0].status, 'complete'); assert.equal(value.results[0].candidates.length, 1);
});
for (const changes of [{ probe_count: 1, invalid_count: 1 }, { probe_count: 1, payload_overflow: true }]) {
  test(`invalid canonical hop/source size or whole-bundle capacity is unavailable: ${JSON.stringify(changes)}`, async () => {
    assert.equal((await invoke(fixture([result('lookup:1', [], changes)]))).results[0].status, 'unavailable');
  });
}
test('same canonical account has one exact observation across differently scoped requests', async () => {
  const rows = [result(), result('lookup:2', [{ postal_code: '75001', county: 'Dallas', city: 'DALLAS', address: '1 MAIN ST', account_id: '00000000000000001' }])];
  const value = await invoke(fixture(rows), [id(), address('lookup:2')]);
  assert.deepEqual(value.results[0].candidates, value.results[1].candidates);
  rows[1].candidates[0].county = 'Collin';
  await assert.rejects(invoke(fixture(rows), [id(), address('lookup:2')]), error => error.reason === 'candidate_evidence_conflict');
});
test('known contradictory county for a native identifier is unavailable, not guessed', async () => {
  const value = await invoke(fixture(), [id('lookup:1', 'R-1234-567-89')]);
  assert.equal(value.results[0].status, 'unavailable'); assert.deepEqual(value.results[0].candidates, []);
});
for (const changes of [{ address: 'bad\naddress' }, { city: 'x'.repeat(201) }, { county: false }, { postal_code: 75001 }]) {
  test(`source text outside the exact bounded evidence contract stays unavailable (${Object.keys(changes)[0]})`, async () => {
    const value = await invoke(fixture([result('lookup:1', [candidate(undefined, changes)])]));
    assert.equal(value.results[0].status, 'unavailable'); assert.deepEqual(value.results[0].candidates, []);
  });
}
test('600 requests are admitted without a data-row/sale cutoff; aggregate oversized evidence is explicitly unavailable', async () => {
  const requests = Array.from({ length: 600 }, (_, index) => address(`lookup:${index + 1}`, null));
  const small = await invoke(fixture(requests.map(request => result(request.request_id, []))), requests);
  assert.equal(small.results.length, 600); assert.ok(small.results.every(row => row.status === 'complete'));
  const five = Array.from({ length: 5 }, (_, index) => candidate(String(index + 1).padStart(17, '0'), { address: 'x'.repeat(500), city: 'x'.repeat(200), county: 'x'.repeat(100) }));
  const value = await invoke(fixture(requests.map(request => result(request.request_id, five))), requests);
  assert.equal(value.results.length, 600); assert.ok(value.results.every(row => row.status === 'unavailable' && row.candidates.length === 0));
});
const malformedInputs = [null, {}, { requests: [id(), id()] }, { requests: [id('lookup:601')] },
  { requests: Array.from({ length: 601 }, (_, i) => id(`lookup:${i + 1}`)) }, { requests: [{ ...id(), extra: true }] },
  { requests: [{ ...id(), identifier: ' x ' }] }, { requests: [id('lookup:1', 'R-1234-567-89', 'DALLAS')] },
  { requests: [{ ...id(), identifier: 'a; SELECT 1' }] }, { requests: [{ ...address(), city_key: 'Dallas' }] },
  { requests: [{ ...address(), address_key: '1 MAIN STREET' }] }, { requests: [{ ...address(), county_key: 'Dallas County' }] },
  { requests: [{ ...address(), postal_code5: '75001-9999' }] }, { requests: [{ ...address(), identifier: '1234' }] },
  { requests: new Array(1) }, { requests: [Object.assign(Object.create(null), id())] }];
for (const [index, input] of malformedInputs.entries()) test(`invalid request ${index} fails before query`, async () => {
  let calls = 0; await assert.rejects(readAssignmentSalesMatchCandidates(() => { calls++; }, input)); assert.equal(calls, 0);
});
test('getters and proxy traps are never invoked', async () => {
  let touches = 0; const bad = { ...id() }; Object.defineProperty(bad, 'identifier', { enumerable: true, get() { touches++; return '1234'; } });
  const proxy = new Proxy(id(), { ownKeys() { touches++; throw new Error('raw secret'); } });
  for (const requests of [[bad], [proxy], new Proxy([], { get() { touches++; throw new Error('raw secret'); } })]) {
    await assert.rejects(readAssignmentSalesMatchCandidates(() => { touches++; }, { requests }));
  }
  assert.equal(touches, 0);
});
for (const change of [rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].ready = 'true'; },
  rows => { rows[0].observed_at = '2026-02-30T00:00:00.000Z'; }, rows => { rows[0].observed_at = '2026-09-11T12:00:00.000Z'; }]) {
  test('malformed source admission cannot become complete', async () => { const rows = metadata(); change(rows); await assert.rejects(invoke(fixture([], rows))); });
}
for (const changes of [{ probe_count: 7 }, { probe_count: '1' }, { invalid_count: -1 }, { payload_overflow: 'false' },
  { candidates: [] }, { candidates: [candidate(), candidate()] }, { candidates: [candidate(undefined, { private: true })] },
  { probe_count: 6 }, { payload_overflow: true }, { request_id: 'lookup:2' }]) {
  test(`malformed query result rejected (${JSON.stringify(changes).slice(0, 60)})`, async () => {
    await assert.rejects(invoke(fixture([result('lookup:1', [candidate()], changes)])));
  });
}
test('missing/duplicate result slots and SQL failures fail closed with no raw driver data', async () => {
  for (const rows of [[], [result(), result()]]) await assert.rejects(invoke(fixture(rows)));
  for (const at of [1, 2]) {
    let count = 0; await assert.rejects(readAssignmentSalesMatchCandidates(async () => {
      if (++count === at) throw new Error('SECRET postgresql://secret/source.csv'); return { rows: metadata() };
    }, { requests: [id()] }), error => error.reason === 'candidate_source_unavailable' && !error.message.includes('SECRET') && !error.cause);
  }
});
for (const code of ['55P03', '57014', '40001', '40P01', 'assignment_sales_import_busy']) {
  for (const stage of [1, 2]) test(`fixed busy semantics survive candidate query stage ${stage}: ${code}`, async () => {
    const driver = Object.assign(new Error('SECRET postgresql://private/driver'), { code, detail: 'PRIVATE ROW', cause: new Error('PRIVATE SQL') });
    let count = 0;
    await assert.rejects(readAssignmentSalesMatchCandidates(async () => {
      if (++count === stage) throw driver; return { rows: metadata() };
    }, { requests: [id()] }), error => {
      assert.notEqual(error, driver); assert.equal(error.code, 'assignment_sales_import_busy');
      assert.equal(error.message, 'assignment_sales_import_busy');
      assert.deepEqual(Object.keys(error), ['code']); assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack, /SECRET|PRIVATE|postgresql:/); return true;
    });
  });
}
test('unknown and lookalike error codes do not become retry/busy authority', async () => {
  for (const code of ['42P01', '42501', '57014 extra', 'assignment_sales_import_failed', 'assignment_sales_import_busy_extra', null]) {
    await assert.rejects(readAssignmentSalesMatchCandidates(async () => {
      throw Object.assign(new Error('secret'), { code });
    }, { requests: [id()] }), { reason: 'candidate_source_unavailable' });
  }
});
for (const code of ['55P03', '57014', '40001', '40P01', 'assignment_sales_import_busy']) {
  test(`actual storage owner propagates sanitized candidate busy and rolls back: ${code}`, async () => {
    const actor = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
    const report = '33333333-3333-4333-8333-333333333333', batch = '44444444-4444-4444-8444-444444444444';
    const prepared = prepareAssignmentSalesCsv(Buffer.from('ListingKey,CloseDate,ClosePrice,ParcelNumber,County\nSYNTHETIC,2024-01-01,250000,00000000000000001,Dallas'));
    const { rows, ...header } = prepared, record = rows[0], bytes = Buffer.byteLength(JSON.stringify(record));
    const calls = [], releases = []; let state = 'I';
    const pool = { async connect() { return { getTransactionStatus: () => state, release: error => releases.push(error),
      async query({ text: sql }) {
        calls.push(sql);
        if (sql.startsWith('BEGIN')) state = 'T';
        if (sql === 'COMMIT' || sql === 'ROLLBACK') state = 'I';
        if (sql.includes('assignment-sales:scope')) return { rows: [{ organization_id: org, account_id: 'SYNTHETIC',
          report_file_id: report, assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null,
          status: 'draft', signed_at: null, has_signed_snapshot: false }] };
        if (sql.includes('assignment-sales:match-scope')) return { rows: [{ batch_id: batch, stored_at: AT,
          source_sha256: header.source_sha256, preparation_sha256: 'a'.repeat(64),
          preparation_profile: header.profile_id, preparation_version: header.preparation_version,
          preparation_header: header, row_count: 1, stored_row_count: 1 }] };
        if (sql.includes('assignment-sales:bounded-rows')) return { rows: [{ candidate_count: 1, metered_count: 1,
          invalid_count: 0, returned_count: 1, returned_payload_bytes: bytes, next_payload_bytes: null, has_more: false,
          receipt_id: '55555555-5555-4555-8555-555555555555', source_row_number: 2, payload_bytes: bytes, record_data: record }] };
        if (sql.includes('assignment-sales-match:schema')) throw Object.assign(new Error('PRIVATE SOURCE SQL'), { code });
        return { rows: [] };
      } }; } };
    await assert.rejects(getAssignmentSalesImportMatchProposals(pool, { accountId: 'SYNTHETIC', assignmentFileId: '1',
      reportFileId: report, batchId: batch, auth: { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] } }),
    { code: 'assignment_sales_import_busy', message: 'assignment_sales_import_busy' });
    assert.equal(calls.at(-1), 'ROLLBACK'); assert.ok(!calls.includes('COMMIT'));
    assert.equal(releases.length, 1); assert.equal(releases[0].code, 'assignment_sales_import_busy');
  });
}
test('synthetic setup keeps the optional shared-source table as an unpopulated FK-only parent', async () => {
  const calls = [];
  await prepareAssignmentSalesMatchCandidatesFixture(async (sql, values) => {
    calls.push({ sql, values }); return { rows: sql.includes('current_database()') ? [{ database_name: 'candidate_fixture_test',
      server_address: '127.0.0.1', read_only: 'off', isolation: 'read committed' }] : [] };
  }, { databaseName: 'candidate_fixture_test' });
  assert.match(calls[0].sql, /pg_catalog\.host\(pg_catalog\.inet_server_addr\(\)\)/);
  assert.ok(calls.some(call => call.sql.includes('CREATE TABLE IF NOT EXISTS core.sales_source_records(id bigint PRIMARY KEY)')));
  assert.ok(calls.every(call => !/INSERT\s+INTO\s+core\.sales_source_records/i.test(call.sql)));
});
test('actual parser/preparation and proposal kernel consume reader output as proposal-only', async () => {
  const prepared = prepareAssignmentSalesCsv(Buffer.from('ListingKey,CloseDate,ClosePrice,ParcelNumber,County\nSYNTHETIC,2024-01-01,250000,00000000000000001,Dallas'));
  const input = { batch: { batch_id: '11111111-1111-4111-8111-111111111111', source_sha256: prepared.source_sha256,
    preparation_sha256: 'a'.repeat(64) }, rows: prepared.rows.map(record_data => ({ receipt_id: '22222222-2222-4222-8222-222222222222',
    source_row_number: record_data.source_row_number, record_data })) };
  const f = fixture(); const value = await proposeAssignmentSalesMatchPage(input, {
    readCandidates: requests => readAssignmentSalesMatchCandidates(f.query, requests) });
  assert.equal(f.calls.length, 2); assert.equal(value.rows[0].proposal_status, 'proposed');
  assert.deepEqual(value.rows[0].proposed_account_ids, ['00000000000000001']); assert.equal(value.accepted, false);
  assert.equal(value.analysis_status, 'not_evaluated'); assert.equal(value.rows[0].review_required, true);
});
