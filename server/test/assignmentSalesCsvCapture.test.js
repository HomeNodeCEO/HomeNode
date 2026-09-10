import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { validateAssignmentSalesReviewCommand } from '../src/services/assignmentSalesCsv/review.js';
import { prepareCustomCohortPrivateSalesSupplement }
  from '../src/services/neighborhoodAssessment/customCohortPrivateSales.js';
import { serializePreparedSalesValue as canonical, digestPreparedSalesParts }
  from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { captureAssignmentSalesCsv as capture, recheckAssignmentSalesCsvCapture as recheck,
  ASSIGNMENT_SALES_CAPTURE_LIMITS as LIMITS, ASSIGNMENT_SALES_CAPTURE_BATCH_SQL as BATCH_SQL,
  ASSIGNMENT_SALES_CAPTURE_REVIEWS_SQL as REVIEWS_SQL, ASSIGNMENT_SALES_CAPTURE_DECISIONS_SQL as DECISIONS_SQL,
  ASSIGNMENT_SALES_CAPTURE_LOCK_SQL as LOCK_SQL, ASSIGNMENT_SALES_CAPTURE_HEAD_SQL as HEAD_SQL }
  from '../src/services/assignmentSalesCsv/capture.js';

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const code = suffix => ({ code: `assignment_sales_import_${suffix}` });
const capturedAt = '2026-09-10T18:00:00.123456Z';
const target = { organization_id: id(1), report_file_id: id(2),
  assignment_file_id: '9223372036854775807', account_id: '00000000000000017' };
const source = { source_name: 'Original private CSV', provenance_note: 'Declared, not independently verified.\nNo grant.',
  currency: 'USD', living_area_unit: null, site_area_unit: null, consideration_field: 'close_price',
  marketing_time_field: null, source_use_confirmed: true };
const defaultCsv = 'ListingKey,CloseDate,ClosePrice,CurrentPrice,MlsStatus\n'
  + 'first,2024-01-01,275000.000,295000,Closed\nsecond,2024-02-01,310000,320000,Closed\n\nragged';
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function fixture({ csv = defaultCsv, reviewed = true, sourceConfirmed = true, reviews: givenReviews } = {}) {
  const buffer = Buffer.from(csv), preparation = structuredClone(prepareAssignmentSalesCsv(buffer)), { rows, ...header } = preparation;
  const originalRows = rows.map(row => ({ receipt_id: id(100 + row.source_row_number),
    source_row_number: row.source_row_number, record_data: row }));
  const decision = (ordinal, action) => ({ receipt_id: id(100 + ordinal), source_row_number: ordinal,
    decision: action, account_ids: [], note: `${action} reviewed separately` });
  const commands = givenReviews ?? (reviewed ? [
    { source_interpretation: source, row_decisions: [] },
    ...(rows.length ? [{ source_interpretation: null, row_decisions: [decision(2, 'exclude')] },
      { source_interpretation: null, row_decisions: [decision(2, 'clear')] }] : []),
    ...(rows.length > 1 ? [{ source_interpretation: null, row_decisions: [decision(3, 'exclude')] }] : []),
    { source_interpretation: { ...source, currency: null, consideration_field: null,
      source_use_confirmed: sourceConfirmed }, row_decisions: [] },
  ] : []);
  const parents = commands.map((value, index) => {
    const command = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: index,
      ...value });
    const command_json = canonical(command), payload = { review_version: 1,
      source_interpretation: command.source_interpretation,
      row_decisions: command.row_decisions.map(row => ({ ...row,
        record_data: originalRows[row.source_row_number - 2].record_data, match_evidence: null })),
      matching_status: 'reviewed_separately', analysis_status: 'not_evaluated' };
    const payload_json = canonical(payload);
    return { review_id: id(200 + index + 1), revision: index + 1, command, command_json,
      command_sha256: hash(command_json), payload_sha256: hash(payload_json), command_bytes: Buffer.byteLength(command_json),
      payload_bytes: Buffer.byteLength(payload_json), stored_envelope_matches: true };
  });
  const current = new Map();
  for (const parent of parents) for (const row of parent.command.row_decisions) current.set(row.source_row_number,
    { receipt_id: row.receipt_id, source_row_number: row.source_row_number, review_id: parent.review_id,
      revision: parent.revision, decision: row, decision_bytes: bytes(row) });
  const head = parents.at(-1), sourceParent = parents.findLast(parent => parent.command.source_interpretation !== null);
  const batch = { batch_id: id(3), ...target, source_sha256: preparation.source_sha256,
    source_byte_length: buffer.length, actual_source_bytes: buffer.length, actual_source_sha256: hash(buffer),
    preparation_sha256: digestPreparedSalesParts(header, rows), preparation_profile: preparation.profile_id,
    preparation_version: 1, row_count: rows.length, header_bytes: bytes(header), preparation_header: header,
    stored_rows: rows.length, first_row: rows.length ? 2 : null, last_row: rows.length ? rows.length + 1 : null,
    row_bytes: String(rows.reduce((sum, row) => sum + bytes(row), 0)), invalid_rows: 0,
    head_review_id: head?.review_id ?? null, revision: head?.revision ?? null,
    source_review_id: sourceParent?.review_id ?? null, source_revision: sourceParent?.revision ?? null,
    captured_at: capturedAt };
  const f = { buffer, preparation, header, originalRows, parents, current, batch, calls: [], hook: null,
    mode: 'capture', pageSize: 100, input: { target: { ...target }, batchId: id(3), expectedReviewRevision: head?.revision ?? 1 } };
  f.query = async (sql, values = []) => {
    f.calls.push({ sql, values });
    let tag = sql.match(/\/\* ([\w-]+:[\w-]+) \*\//)?.[1] ?? sql;
    let result;
    if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')) result = { rows: [] };
    else if (tag.endsWith(':recheck-transaction')) result = { rows: [{ isolation: 'read committed', read_only: 'off' }] };
    else if (tag.endsWith(':transaction')) result = { rows: [{ isolation: 'repeatable read', read_only: 'on' }] };
    else if (tag.endsWith(':batch')) result = { rows: [batch] };
    else if (tag.endsWith(':reviews')) {
      const refs = new Set([head?.review_id, sourceParent?.review_id, ...[...current.values()].map(row => row.review_id)]);
      const selected = parents.filter(row => refs.has(row.review_id));
      const metadata = { command_count: selected.length, invalid_commands: 0,
        total_command_bytes: String(selected.reduce((sum, row) => sum + row.command_bytes, 0)),
        total_payload_bytes: String(selected.reduce((sum, row) => sum + row.payload_bytes, 0)) };
      result = { rows: selected.map(({ command, ...row }) => ({ ...row, ...metadata })) };
    } else if (tag === 'assignment-sales:bounded-rows') {
      const remaining = originalRows.filter(row => row.source_row_number > values[1]);
      const candidates = remaining.slice(0, values[2] + 1);
      let total = 0;
      const selected = [];
      for (const row of candidates.slice(0, values[2])) {
        if (total + bytes(row.record_data) > 4194304) break;
        selected.push(row); total += bytes(row.record_data);
      }
      const metadata = { candidate_count: candidates.length, metered_count: candidates.length,
        returned_count: selected.length, invalid_count: 0, returned_payload_bytes: total,
        next_payload_bytes: candidates.length > selected.length ? bytes(candidates[selected.length].record_data) : null,
        has_more: candidates.length > selected.length };
      result = { rows: selected.length ? selected.map(row => ({ ...metadata, ...row, payload_bytes: bytes(row.record_data) }))
        : [{ ...metadata, receipt_id: null, source_row_number: null, payload_bytes: null, record_data: null }] };
    } else if (tag.endsWith(':decisions')) result = { rows: originalRows.filter(row => row.source_row_number > values[1])
      .slice(0, 100).map(row => current.get(row.source_row_number) ?? { receipt_id: row.receipt_id,
        source_row_number: row.source_row_number, review_id: null, revision: null, decision: null, decision_bytes: null }) };
    else if (tag.endsWith(':recheck-lock')) result = { rows: [{ batch_id: batch.batch_id,
      source_sha256: batch.source_sha256, preparation_sha256: batch.preparation_sha256, row_count: batch.row_count }] };
    else if (tag.endsWith(':recheck-head')) result = { rows: [{ head_review_id: batch.head_review_id,
      revision: batch.revision, source_review_id: batch.source_review_id }] };
    else throw Error(`Unexpected test SQL ${tag}`);
    result = structuredClone(result);
    return f.hook?.(tag, result, values) ?? result;
  };
  return f;
}

test('actual preparation is captured complete, exact and detached, with current unknown declarations and clear decisions', async () => {
  const f = fixture(), before = JSON.stringify(f.preparation);
  const result = await capture(f.query, f.input);
  assert.deepEqual(Object.keys(result), ['private_sales_capture_version', 'profile_id', 'target', 'batch', 'review',
    'source_interpretation', 'captured_at', 'rows']);
  assert.equal(result.private_sales_capture_version, 1);
  assert.equal(result.profile_id, 'assignment-private-reviewed-sales-v1');
  assert.deepEqual(result.target, target);
  assert.equal(result.captured_at, capturedAt);
  assert.deepEqual(result.rows.map(row => row.record_data), f.preparation.rows);
  assert.equal(result.rows[0].review.decision, 'clear');
  assert.equal(result.rows[0].review.revision, 3);
  assert.equal(result.rows[1].review.decision, 'exclude');
  assert.equal(result.rows[2].review, null);
  assert.equal(result.rows[2].record_data.preparation_disposition, 'empty');
  assert.equal(result.rows[3].record_data.preparation_disposition, 'rejected');
  assert.equal(result.source_interpretation.currency, null, 'new explicit unknown masks old USD');
  assert.equal(result.source_interpretation.consideration_field, null);
  assert.deepEqual(prepareCustomCohortPrivateSalesSupplement(result), result,
    'actual immutable supplement consumer admits the exact reader DTO');
  assert.equal(result.rows[0].record_data.values.close_price, '275000');
  assert.equal(result.rows[0].record_data.values.current_price, '295000');
  assert.equal(result.rows[0].record_data.analysis_status, 'not_evaluated');
  assert.equal(JSON.stringify(f.preparation), before);
  const frozen = value => { if (value && typeof value === 'object') {
    assert(Object.isFrozen(value)); Object.values(value).forEach(frozen);
  } };
  frozen(result);
  f.originalRows[0].record_data.raw_cells[0] = 'later mutation';
  f.input.target.account_id = 'other';
  assert.equal(result.rows[0].record_data.raw_cells[0], 'first');
  assert.equal(result.target.account_id, target.account_id);
  assert.equal(f.calls[0].sql, 'SAVEPOINT assignment_sales_capture_read');
  assert.equal(f.calls.at(-1).sql, 'RELEASE SAVEPOINT assignment_sales_capture_read');
  assert(f.calls.every(call => !/^(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/.test(call.sql)));
});

test('input target is detached before first await, and no default or alias identity is accepted', async () => {
  const f = fixture(), query = f.query;
  f.query = async (sql, values) => { if (sql.startsWith('SAVEPOINT')) f.input.target.account_id = 'changed'; return query(sql, values); };
  const result = await capture(f.query, f.input);
  assert.equal(result.target.account_id, target.account_id);
  assert.deepEqual(f.calls.find(call => call.sql === BATCH_SQL).values, [id(3), target.organization_id,
    target.report_file_id, target.assignment_file_id, target.account_id]);
});

test('canonical JSONB key reordering does not change the original preparation digest', async () => {
  const f = fixture(), reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  f.hook = (tag, result) => tag.includes('bounded-rows') || tag.endsWith(':batch') ? reorder(result) : result;
  assert.equal((await capture(f.query, f.input)).batch.preparation_sha256, f.batch.preparation_sha256);
});

test('full 10,000-row capture has no first-30/100 truncation, duplicates, or missing ordinals', async () => {
  const f = fixture({ csv: 'ListingKey,CloseDate,ClosePrice\n' + Array.from({ length: 10000 }, (_, i) =>
    `key-${i},2020-01-01,${200000 + i}`).join('\n') });
  const result = await capture(f.query, f.input);
  assert.equal(result.rows.length, 10000);
  assert.equal(result.rows.at(-1).source_row_number, 10001);
  assert.equal(new Set(result.rows.map(row => row.receipt_id)).size, 10000);
  assert.equal(f.calls.filter(call => call.sql.includes('assignment-sales:bounded-rows')).length, 100);
  assert.equal(f.calls.filter(call => call.sql === DECISIONS_SQL).length, 100);
});

test('header-only private source is captured as a genuinely empty roster', async () => {
  const f = fixture({ csv: 'ListingKey,CloseDate,ClosePrice' });
  const result = await capture(f.query, f.input);
  assert.deepEqual(result.rows, []);
  assert.equal(f.calls.filter(call => call.sql === DECISIONS_SQL).length, 0);
});

test('confirmed match only retains declared current accounts and does not promote record status or units', async () => {
  const f = fixture({ reviews: [{ source_interpretation: source, row_decisions: [] }, {
    source_interpretation: null, row_decisions: [{ receipt_id: id(102), source_row_number: 2,
      decision: 'confirm_proposed_match', account_ids: ['0017', '0018'], note: 'Identity only' }] }] });
  const result = await capture(f.query, f.input);
  assert.deepEqual(result.rows[0].review.account_ids, ['0017', '0018']);
  assert.equal(result.rows[0].record_data.matching_status, 'not_evaluated');
  assert.equal(result.rows[0].record_data.analysis_status, 'not_evaluated');
  assert.equal(result.source_interpretation.living_area_unit, null);
  assert(!Object.hasOwn(result, 'authorized'));
});

for (const [name, change] of [
  ['organization', f => f.batch.organization_id = id(9)],
  ['report', f => f.batch.report_file_id = id(9)],
  ['assignment', f => f.batch.assignment_file_id = '17'],
  ['account', f => f.batch.account_id = '17'],
  ['batch', f => f.batch.batch_id = id(9)],
  ['source bytes', f => f.batch.actual_source_sha256 = 'a'.repeat(64)],
  ['source length', f => f.batch.actual_source_bytes += 1],
  ['preparation digest', f => f.batch.preparation_sha256 = 'a'.repeat(64)],
  ['profile', f => f.batch.preparation_profile = 'other'],
  ['profile version', f => f.batch.preparation_version = 2],
  ['header source', f => f.batch.preparation_header.source_sha256 = 'a'.repeat(64)],
  ['header row count', f => f.batch.preparation_header.row_count += 1],
  ['stored count', f => f.batch.stored_rows -= 1],
  ['first ordinal', f => f.batch.first_row = 3],
  ['last ordinal', f => f.batch.last_row += 1],
  ['oversize record', f => f.batch.invalid_rows = 1],
  ['noncanonical UTC clock', f => f.batch.captured_at = '2026-09-10T18:00:00.123Z'],
  ['invalid calendar clock', f => f.batch.captured_at = '2026-02-30T18:00:00.123456Z'],
]) test(`capture fails closed on ${name} mismatch`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
  assert(!f.calls.some(call => call.sql.startsWith('RELEASE')));
});

test('absent batch, unreviewed source, withheld source use, and stale revision are distinct fixed refusals', async () => {
  let f = fixture(); f.hook = (tag, result) => tag.endsWith(':batch') ? { rows: [] } : result;
  await assert.rejects(capture(f.query, f.input), code('not_found'));
  f = fixture({ reviewed: false }); await assert.rejects(capture(f.query, f.input), code('source_not_reviewed'));
  f = fixture({ sourceConfirmed: false }); await assert.rejects(capture(f.query, f.input), code('source_use_not_confirmed'));
  f = fixture(); f.input.expectedReviewRevision -= 1;
  await assert.rejects(capture(f.query, f.input), code('revision_conflict'));
  assert(!f.calls.some(call => call.sql === REVIEWS_SQL));
});

for (const [name, change] of [
  ['changed canonical text', row => row.command_json += ' '],
  ['changed command hash', row => row.command_sha256 = 'a'.repeat(64)],
  ['changed payload hash', row => row.stored_envelope_matches = false],
  ['wrong revision', row => row.revision = 1],
  ['missing command', row => row.command_json = null],
  ['invalid declaration', row => { const value = JSON.parse(row.command_json); value.review_version = 2;
    row.command_json = canonical(value); row.command_bytes = Buffer.byteLength(row.command_json); row.command_sha256 = hash(row.command_json); }],
]) test(`current command envelope rejects ${name}`, async () => {
  const f = fixture(); f.hook = (tag, result) => { if (tag.endsWith(':reviews')) change(result.rows[0]); return result; };
  await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
  assert(!f.calls.some(call => call.sql.includes('assignment-sales:bounded-rows')));
});

for (const [name, change] of [
  ['wrong receipt', row => row.receipt_id = id(999)],
  ['wrong ordinal', row => row.source_row_number = 999],
  ['wrong parent', row => row.review_id = id(999)],
  ['wrong revision', row => row.revision = 2],
  ['subset decision', row => row.decision = {}],
  ['altered decision', row => row.decision.note = 'altered'],
  ['oversize projection', row => row.decision_bytes = 8193],
]) test(`current row projection rejects ${name}`, async () => {
  const f = fixture(); f.hook = (tag, result) => { if (tag.endsWith(':decisions')) change(result.rows[0]); return result; };
  await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
});

test('missing/older projection cannot hide a decision carried by a retained source/head command', async () => {
  const f = fixture({ reviews: [{ source_interpretation: source, row_decisions: [{ receipt_id: id(102),
    source_row_number: 2, decision: 'exclude', account_ids: [], note: '' }] }] });
  f.current.clear();
  await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
});

test('stored prepared cells altered after hashing fail, including empty/rejected rows', async () => {
  for (const index of [0, 2, 3]) {
    const f = fixture(); f.originalRows[index].record_data.raw_cells[0] = 'altered';
    await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
  }
});

test('missing/duplicate command and projection rows never produce a partial capture', async () => {
  for (const lane of ['reviews', 'decisions']) for (const kind of ['missing', 'duplicate']) {
    const f = fixture(); f.hook = (tag, result) => {
      if (tag.endsWith(`:${lane}`)) {
        if (kind === 'missing') result.rows.pop(); else result.rows.push(result.rows[0]);
      }
      return result;
    };
    await assert.rejects(capture(f.query, f.input), code('invalid_receipt'));
  }
});

test('complete metadata rejects large commands/payloads/preparation before bulk payload reads', async () => {
  for (const field of ['total_command_bytes', 'total_payload_bytes']) {
    const f = fixture(); f.hook = (tag, result) => {
      if (tag.endsWith(':reviews')) for (const row of result.rows) row[field] = String(
        (field === 'total_command_bytes' ? LIMITS.current_command_bytes : LIMITS.current_payload_bytes) + 1);
      return result;
    };
    await assert.rejects(capture(f.query, f.input), code('preparation_limit'));
    assert(!f.calls.some(call => call.sql.includes('assignment-sales:bounded-rows')));
  }
  const f = fixture(); f.batch.row_bytes = String(LIMITS.supplement_bytes + 1);
  await assert.rejects(capture(f.query, f.input), code('preparation_limit'));
  assert(!f.calls.some(call => call.sql === REVIEWS_SQL));
});

test('hostile input accessors and proxies never execute, and inputs are closed before query', async () => {
  let touched = 0;
  const accessor = { ...target };
  Object.defineProperty(accessor, 'account_id', { enumerable: true, get() { touched++; return target.account_id; } });
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw Error('private'); } });
  for (const bad of [accessor, proxy, { ...target, account_id: 17 }, { ...target, assignment_file_id: '01' },
    { ...target, assignment_file_id: '9223372036854775808' }, { ...target, account_id: 'x\nsecret' },
    { ...target, extra: 'alias' }]) {
    const f = fixture(); f.input.target = bad;
    await assert.rejects(capture(f.query, f.input), code('invalid_input'));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(touched, 0);
  const f = fixture(); f.input.extra = true;
  await assert.rejects(capture(f.query, f.input), code('invalid_input'));
  assert.equal(f.calls.length, 0);
});

test('snapshot acquisition refuses wrong isolation or read-write mode before reading private rows', async () => {
  for (const state of [{ isolation: 'read committed', read_only: 'on' }, { isolation: 'repeatable read', read_only: 'off' }]) {
    const f = fixture(); f.hook = (tag, result) => tag.endsWith(':transaction') ? { rows: [state] } : result;
    await assert.rejects(capture(f.query, f.input), code('transaction_state'));
    assert.equal(f.calls.length, 2);
  }
});

test('caller errors propagate untouched, no rollback/commit or replacement error leaks are fabricated', async () => {
  const f = fixture(), problem = Object.assign(new Error('owner cancellation'), { code: 'owner_cancelled' });
  f.hook = tag => { if (tag.endsWith(':reviews')) throw problem; };
  await assert.rejects(capture(f.query, f.input), error => error === problem);
  assert(!f.calls.some(call => /^(COMMIT|ROLLBACK)\b/.test(call.sql)));
});

test('final recheck serializes parent batch then reads fresh head in caller READ COMMITTED, without rereading source rows', async () => {
  const f = fixture(), value = await capture(f.query, f.input);
  f.calls.length = 0;
  assert.equal(await recheck(f.query, value), true);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[0].sql, 'SAVEPOINT assignment_sales_capture_recheck');
  assert.equal(f.calls[2].sql, LOCK_SQL);
  assert.deepEqual(f.calls[2].values, [id(3), target.organization_id, target.report_file_id, target.assignment_file_id, target.account_id]);
  assert.equal(f.calls[3].sql, HEAD_SQL);
  assert.equal(f.calls[4].sql, 'RELEASE SAVEPOINT assignment_sales_capture_recheck');
});

test('final recheck detaches exact binding before waiting, including a reopened mutable JSON value', async () => {
  const f = fixture(), value = structuredClone(await capture(f.query, f.input));
  f.calls.length = 0;
  f.hook = (tag, result) => {
    if (tag.startsWith('SAVEPOINT')) {
      value.target.account_id = 'changed'; value.batch.batch_id = id(999);
      value.review.revision = 999; value.rows.length = 0;
    }
    return result;
  };
  assert.equal(await recheck(f.query, value), true);
  assert.equal(f.calls.find(call => call.sql === LOCK_SQL).values[0], id(3));
  assert.equal(f.calls.find(call => call.sql === LOCK_SQL).values[4], target.account_id);
});

for (const field of ['batch_id', 'source_sha256', 'preparation_sha256', 'row_count', 'revision', 'head_review_id', 'source_review_id']) {
  test(`final registration rejects changed ${field}`, async () => {
    const f = fixture(), value = await capture(f.query, f.input);
    f.calls.length = 0;
    f.hook = (tag, result) => {
      if (tag.includes(':recheck-') && Object.hasOwn(result.rows[0] ?? {}, field)) result.rows[0][field] =
        typeof result.rows[0][field] === 'number' ? result.rows[0][field] + 1 : 'changed';
      return result;
    };
    await assert.rejects(recheck(f.query, value), code('capture_changed'));
    assert(!f.calls.some(call => call.sql.startsWith('RELEASE')));
  });
}

test('final recheck refuses a stale repeatable-read snapshot and read-only transaction', async () => {
  const f = fixture(), value = await capture(f.query, f.input);
  for (const state of [{ isolation: 'repeatable read', read_only: 'off' }, { isolation: 'read committed', read_only: 'on' }]) {
    f.calls.length = 0;
    f.hook = (tag, result) => tag.endsWith(':recheck-transaction') ? { rows: [state] } : result;
    await assert.rejects(recheck(f.query, value), code('transaction_state'));
    assert.equal(f.calls.length, 2);
  }
});

test('SAVEPOINT requires explicit transaction and NOWAIT lock/cancellation errors remain owner-controlled', async () => {
  const f = fixture(), value = await capture(f.query, f.input);
  for (const [tag, errorCode] of [['SAVEPOINT', '25P01'], [':recheck-lock', '55P03'], [':recheck-head', '57014']]) {
    f.calls.length = 0;
    const problem = Object.assign(new Error('driver-private'), { code: errorCode });
    f.hook = current => { if (current.includes(tag)) throw problem; };
    await assert.rejects(recheck(f.query, value), error => error === problem);
    assert(!f.calls.some(call => /^(COMMIT|ROLLBACK)\b/.test(call.sql)));
  }
});

test('SQL is fixed/exact-scope, numeric newest review ordering, bounded before payload transfer, and never mutates tables', () => {
  assert.match(BATCH_SQL, /b\.organization_id=\$2::uuid[\s\S]+b\.report_file_id=\$3::uuid/);
  assert.match(BATCH_SQL, /pg_catalog\.sha256\(b\.source_bytes\)/);
  assert.match(REVIEWS_SQL, /metered AS MATERIALIZED[\s\S]+budget AS MATERIALIZED/);
  assert.match(REVIEWS_SQL, /total_command_bytes::bigint<=16777216/);
  assert.match(REVIEWS_SQL, /total_payload_bytes::bigint<=67108864/);
  assert.match(REVIEWS_SQL, /CASE WHEN[\s\S]+THEN r\.command_json ELSE NULL END/);
  assert.match(DECISIONS_SQL, /LIMIT 100/);
  assert.match(DECISIONS_SQL, /<=8192[\s\S]+THEN r\.decision ELSE NULL/);
  assert.match(LOCK_SQL, /FOR SHARE NOWAIT$/);
  assert.match(HEAD_SQL, /ORDER BY revision DESC/);
  for (const sql of [BATCH_SQL, REVIEWS_SQL, DECISIONS_SQL, LOCK_SQL, HEAD_SQL]) {
    assert(!/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP)\b/.test(sql));
    assert(!sql.includes('core.sales'));
  }
});
