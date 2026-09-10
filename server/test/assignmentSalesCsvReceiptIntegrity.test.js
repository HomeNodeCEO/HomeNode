import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { PREPARED_SALES_INTEGRITY_LIMITS as LIMITS, serializePreparedSalesValue as serialize,
  createPreparedSalesDigest, digestPreparedSalesParts, readStoredSalesRows, STORED_SALES_ROWS_SQL }
  from '../src/services/assignmentSalesCsv/receiptIntegrity.js';

const BATCH = '00000000-0000-0000-0000-000000000001';
const receiptId = ordinal => `00000000-0000-0000-0000-${String(ordinal).padStart(12, '0')}`;
const code = suffix => ({ code: `assignment_sales_import_${suffix}` });
const fixtureRow = (ordinal, payload = {}) => ({ receipt_id: receiptId(ordinal), source_row_number: ordinal,
  record_data: { source_row_number: ordinal, ...payload } });
const actualBytes = row => Buffer.byteLength(JSON.stringify(row.record_data));

function page(rows, options = {}) {
  const returnedBytes = rows.reduce((sum, row) => sum + (row.payload_bytes ?? actualBytes(row)), 0);
  const candidateCount = options.candidateCount ?? rows.length;
  const metadata = { candidate_count: candidateCount, metered_count: candidateCount, returned_count: rows.length,
    invalid_count: 0, returned_payload_bytes: returnedBytes,
    next_payload_bytes: candidateCount > rows.length ? (options.nextBytes ?? 100) : null,
    has_more: candidateCount > rows.length, ...options.metadata };
  return { rows: rows.length ? rows.map(row => ({ ...metadata, payload_bytes: actualBytes(row), ...row }))
    : [{ ...metadata, receipt_id: null, source_row_number: null, payload_bytes: null, record_data: null }] };
}

test('canonical JSON sorts all object keys recursively, preserves array order and exact decimals as strings', () => {
  assert.equal(serialize({ z: ['9007199254740993.123456789012', { b: false, a: null }], a: 0 }),
    '{"a":0,"z":["9007199254740993.123456789012",{"a":null,"b":false}]}');
  assert.equal(serialize({ 2: 'two', 10: 'ten', a: 'α🙂' }), '{"10":"ten","2":"two","a":"α🙂"}');
  assert.equal(serialize(-0), '0');
  assert.equal(serialize(Object.assign(Object.create(null), { b: 2, a: 1 })), '{"a":1,"b":2}');
});

test('explicit length framing uses canonical UTF8 bytes, not UTF16 length or insertion order', () => {
  const header = { b: 2, a: 'α🙂' }, rows = [{ z: null, a: [true, 0] }];
  const parts = ['{"a":"α🙂","b":2}', '{"a":[true,0],"z":null}'];
  const expected = createHash('sha256');
  for (const value of parts) expected.update(`${Buffer.byteLength(value)}:`).update(value);
  assert.equal(digestPreparedSalesParts(header, rows), expected.digest('hex'));
  assert.equal(digestPreparedSalesParts(header, rows), digestPreparedSalesParts({ a: 'α🙂', b: 2 }, [{ a: [true, 0], z: null }]));
});

test('incremental and convenience digests agree, binding row order, row changes and header/profile changes', () => {
  const header = { profile_id: 'private_sales_csv_preparation_v1', row_count: 2 };
  const rows = [{ source_row_number: 2, raw_cells: ['x'] }, { source_row_number: 3, raw_cells: ['y'] }];
  const incremental = createPreparedSalesDigest();
  incremental.add(header); rows.forEach(row => incremental.add(row));
  const original = digestPreparedSalesParts(header, rows);
  assert.equal(original, incremental.digest());
  assert.notEqual(original, digestPreparedSalesParts(header, [...rows].reverse()));
  assert.notEqual(original, digestPreparedSalesParts(header, [rows[0], { ...rows[1], raw_cells: ['changed'] }]));
  assert.notEqual(original, digestPreparedSalesParts({ ...header, profile_id: 'other' }, rows));
  assert.notEqual(original, digestPreparedSalesParts(header, rows.slice(0, 1)));
});

test('actual generated preparation survives JSONB-style object order changes but not altered stored cells', () => {
  const preparation = prepareAssignmentSalesCsv(Buffer.from('ListingKey,CloseDate,ClosePrice,MlsStatus\nkey-1,2020-01-01,282500,Closed\n\n'));
  const { rows, ...header } = preparation;
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  const original = digestPreparedSalesParts(header, rows);
  assert.equal(original, digestPreparedSalesParts(reorder(header), reorder(rows)));
  const changed = structuredClone(rows); changed[0].raw_cells[2] = '999999';
  assert.notEqual(original, digestPreparedSalesParts(header, changed));
  assert.equal(rows.length, 2, 'empty record still participates in digest');
});

test('canonical serialization is detached, does not mutate generated values or invoke toJSON/accessors', () => {
  const value = { b: { z: 2, a: 1 }, a: ['x'] }, before = JSON.stringify(value);
  serialize(value); assert.equal(JSON.stringify(value), before);
  let touched = 0;
  const getter = Object.defineProperty({}, 'a', { enumerable: true, get() { touched++; return 1; } });
  const toJSON = { toJSON() { touched++; return {}; } };
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw Error('private'); } });
  for (const input of [getter, toJSON, proxy]) assert.throws(() => serialize(input), code('invalid_receipt'));
  assert.equal(touched, 0);
});

for (const value of [undefined, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n, Symbol('x'), () => 1,
  new Date(), Buffer.from('x'), new Map(), '\ud800']) {
  test(`unsupported generated JSON value ${typeof value} is rejected without coercion`, () => assert.throws(() => serialize(value), code('invalid_receipt')));
}

test('cycles, sparse arrays, custom array properties, symbols and hidden properties are rejected', () => {
  const cyclic = {}; cyclic.a = cyclic;
  const custom = [1]; custom.extra = 2;
  const symbol = { [Symbol('x')]: 1 };
  const hidden = Object.defineProperty({}, 'a', { value: 1 });
  for (const value of [cyclic, Array(2), custom, symbol, hidden]) assert.throws(() => serialize(value), code('invalid_receipt'));
  const shared = { a: 1 };
  assert.equal(serialize([shared, shared]), '[{"a":1},{"a":1}]', 'shared values are not cycles');
});

test('exact two-MiB canonical part bound counts quotes, UTF8 and JSON escapes', () => {
  const exact = 'x'.repeat(LIMITS.partBytes - 2);
  assert.equal(Buffer.byteLength(serialize(exact)), LIMITS.partBytes);
  assert.throws(() => serialize(`${exact}x`), code('preparation_limit'));
  assert.throws(() => serialize('\n'.repeat(LIMITS.partBytes / 2)), code('preparation_limit'));
  assert.throws(() => serialize('🙂'.repeat(LIMITS.partBytes / 4)), code('preparation_limit'));
});

test('depth and node limits bound recursion and generated-part work', () => {
  let allowed = null;
  for (let i = 0; i < LIMITS.depth; i++) allowed = [allowed];
  assert.doesNotThrow(() => serialize(allowed));
  assert.throws(() => serialize([allowed]), code('preparation_limit'));
  assert.throws(() => serialize(Array(LIMITS.nodesPerPart).fill(null)), code('preparation_limit'));
});

test('digest bounds 10001 parts and 32MiB canonical bytes without concatenating the full preparation', () => {
  const exactParts = createPreparedSalesDigest();
  for (let index = 0; index < LIMITS.parts; index++) exactParts.add(null);
  assert.match(exactParts.digest(), /^[a-f0-9]{64}$/);
  const tooMany = createPreparedSalesDigest();
  for (let index = 0; index < LIMITS.parts; index++) tooMany.add(null);
  assert.throws(() => tooMany.add(null), code('preparation_limit'));
  const part = 'x'.repeat(LIMITS.partBytes - 2), exactBytes = createPreparedSalesDigest();
  for (let index = 0; index < 16; index++) exactBytes.add(part);
  assert.match(exactBytes.digest(), /^[a-f0-9]{64}$/);
  const overflow = createPreparedSalesDigest();
  for (let index = 0; index < 16; index++) overflow.add(part);
  assert.throws(() => overflow.add(null), code('preparation_limit'));
});

test('finalized or failed digest cannot be reused to omit a bad part', () => {
  const digest = createPreparedSalesDigest();
  assert.throws(() => digest.digest(), code('invalid_receipt'));
  digest.add({}); digest.digest();
  assert.throws(() => digest.digest(), code('invalid_receipt'));
  assert.throws(() => digest.add({}), code('invalid_receipt'));
  const bad = createPreparedSalesDigest(); bad.add({});
  assert.throws(() => bad.add(undefined), code('invalid_receipt'));
  assert.throws(() => bad.add({ valid: true }), code('invalid_receipt'));
  assert.throws(() => bad.digest(), code('invalid_receipt'));
});

test('convenience digest refuses invalid row containers and accessor rows', () => {
  let touched = 0;
  const rows = [null]; Object.defineProperty(rows, '0', { get() { touched++; return {}; } });
  for (const value of [null, {}, Array(2), rows, new Proxy([], {})]) assert.throws(() => digestPreparedSalesParts({}, value), code('invalid_receipt'));
  assert.equal(touched, 0);
  assert.throws(() => digestPreparedSalesParts({}, Array(10001).fill(null)), code('preparation_limit'));
});

test('reader transfers only admitted payloads and returns explicit hasMore metadata', async () => {
  const raw = page([fixtureRow(2), fixtureRow(3)], { candidateCount: 3 });
  const calls = [];
  const result = await readStoredSalesRows(async (sql, values) => { calls.push({ sql, values }); return raw; }, BATCH, 0, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, STORED_SALES_ROWS_SQL);
  assert.deepEqual(calls[0].values, [BATCH, 0, 2]);
  assert.deepEqual(result, { rows: [fixtureRow(2), fixtureRow(3)], hasMore: true });
  assert.equal(Object.hasOwn(result.rows[0], 'payload_bytes'), false);
});

test('empty page returns no phantom row and cannot imply more rows', async () => {
  const result = await readStoredSalesRows(async () => page([]), BATCH, 10001, 100);
  assert.deepEqual(result, { rows: [], hasMore: false });
});

test('byte-budget boundary allows exactly4MiB and represents lookahead without its payload', async () => {
  const rows = [fixtureRow(2), fixtureRow(3)].map(row => ({ ...row, payload_bytes: LIMITS.partBytes }));
  const result = await readStoredSalesRows(async () => page(rows, { candidateCount: 3, nextBytes: 1 }), BATCH, 0, 100);
  assert.equal(result.rows.length, 2);
  assert.equal(result.hasMore, true);
});

test('byte-limited continuation and limit-sized continuation have no duplicate/omitted ordinals', async () => {
  const all = Array.from({ length: 7 }, (_, index) => fixtureRow(index + 2));
  const seen = [];
  let after = 0;
  while (true) {
    const candidates = all.filter(row => row.source_row_number > after).slice(0, 4);
    const selected = candidates.slice(0, 2).map(row => ({ ...row, payload_bytes: LIMITS.partBytes }));
    const response = page(selected, { candidateCount: candidates.length, nextBytes: LIMITS.partBytes });
    const result = await readStoredSalesRows(async () => response, BATCH, after, 3);
    seen.push(...result.rows.map(row => row.source_row_number));
    if (!result.hasMore) break;
    after = result.rows.at(-1).source_row_number;
  }
  assert.deepEqual(seen, [2, 3, 4, 5, 6, 7, 8]);
});

test('SQL meters only limited keys before loading selected payloads and never transfers lookahead JSON', () => {
  assert.match(STORED_SALES_ROWS_SQL, /candidate_keys AS MATERIALIZED/);
  assert.match(STORED_SALES_ROWS_SQL, /ORDER BY source_row_number LIMIT \(\$3::integer \+ 1\)/);
  assert.match(STORED_SALES_ROWS_SQL, /metered AS MATERIALIZED/);
  assert.match(STORED_SALES_ROWS_SQL, /octet_length\(pg_catalog.convert_to\(r.record_data::text, 'UTF8'\)\)/);
  assert.match(STORED_SALES_ROWS_SQL, /sum\(payload_bytes\).*ROWS UNBOUNDED PRECEDING/);
  assert.match(STORED_SALES_ROWS_SQL, /selected_keys AS MATERIALIZED/);
  assert.match(STORED_SALES_ROWS_SQL, /payload_bytes BETWEEN 1 AND 2097152/);
  assert.match(STORED_SALES_ROWS_SQL, /cumulative_bytes <= 4194304/);
  assert.match(STORED_SALES_ROWS_SQL, /LEFT JOIN selected_keys k ON s.invalid_count = 0/);
  assert.match(STORED_SALES_ROWS_SQL, /r.source_row_number = k.source_row_number AND r.receipt_id = k.receipt_id/);
  assert.doesNotMatch(STORED_SALES_ROWS_SQL, /pg_column_size|SELECT \* FROM app|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
});

for (const args of [[BATCH, -1, 1], [BATCH, 10002, 1], [BATCH, '0', 1], [BATCH, 0, 0], [BATCH, 0, 101],
  [BATCH, 0, 1.5], ['not-a-uuid', 0, 1], [{ toString: () => BATCH }, 0, 1]]) {
  test(`invalid row reader args ${JSON.stringify(args)} fail before query`, async () => {
    let called = false;
    await assert.rejects(readStoredSalesRows(async () => { called = true; }, ...args), code('invalid_receipt'));
    assert.equal(called, false);
  });
}

const badMetadata = [
  { candidate_count: '1' }, { metered_count: 2 }, { returned_count: 0 }, { invalid_count: 1 },
  { returned_payload_bytes: 0 }, { returned_payload_bytes: LIMITS.pagePayloadBytes + 1 },
  { has_more: 'false' }, { has_more: true }, { next_payload_bytes: 0 }, { next_payload_bytes: LIMITS.partBytes + 1 },
];
for (const metadata of badMetadata) {
  test(`inconsistent row metadata ${JSON.stringify(metadata)} fails closed`, async () => {
    await assert.rejects(readStoredSalesRows(async () => page([fixtureRow(2)], { metadata }), BATCH, 0, 1), code('invalid_receipt'));
  });
}

test('short pages must really be byte-limited, not silently truncated', async () => {
  await assert.rejects(readStoredSalesRows(async () => page([fixtureRow(2)], { candidateCount: 2, nextBytes: 100 }), BATCH, 0, 100), code('invalid_receipt'));
});

test('invalid, missing, duplicate or altered record identity fails instead of omitting rows', async () => {
  for (const rows of [[fixtureRow(3)], [fixtureRow(2), fixtureRow(4)],
    [fixtureRow(2), { ...fixtureRow(3), receipt_id: receiptId(2) }],
    [{ ...fixtureRow(2), receipt_id: 'bad' }], [{ ...fixtureRow(2), record_data: { source_row_number: 3 } }],
    [{ ...fixtureRow(2), record_data: null }], [{ ...fixtureRow(2), payload_bytes: 1 }]]) {
    await assert.rejects(readStoredSalesRows(async () => page(rows), BATCH, 0, 100), code('invalid_receipt'));
  }
});

test('metadata changes across result rows or missing aggregate row fail closed', async () => {
  const response = page([fixtureRow(2), fixtureRow(3)]);
  response.rows[1].candidate_count = 3;
  for (const result of [response, { rows: [] }, { rows: null }, { ...page([fixtureRow(2)]), rowCount: 0 }]) {
    await assert.rejects(readStoredSalesRows(async () => result, BATCH, 0, 2), code('invalid_receipt'));
  }
});

test('oversized/corrupt metered record fails without requiring its large payload', async () => {
  const result = page([], { candidateCount: 1, metadata: { invalid_count: 1 } });
  assert.equal(result.rows[0].record_data, null);
  await assert.rejects(readStoredSalesRows(async () => result, BATCH, 0, 100), code('invalid_receipt'));
});

test('database failures propagate to the existing transaction owner; helper acquires no connection or retry', async () => {
  const problem = Object.assign(new Error('database failure'), { code: '57014' });
  let count = 0;
  await assert.rejects(readStoredSalesRows(async () => { count++; throw problem; }, BATCH, 0, 1), value => value === problem);
  assert.equal(count, 1);
});
