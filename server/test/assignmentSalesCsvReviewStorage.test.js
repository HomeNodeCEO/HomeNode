import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { appendAssignmentSalesImportReview as append, getAssignmentSalesImportReviewByOperation as receipt,
  getAssignmentSalesImportReviewState as state } from '../src/services/assignmentSalesCsv/reviewStorage.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts, serializePreparedSalesValue } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../src/services/assignmentSalesCsv/review.js';

const actor = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const report = '33333333-3333-4333-8333-333333333333', batchId = '44444444-4444-4444-8444-444444444444';
const operationId = '55555555-5555-4555-8555-555555555555', other = '66666666-6666-4666-8666-666666666666';
const account = '00000000000000001', time = '2026-09-10T12:00:00.000Z';
const rowId = index => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
const code = suffix => ({ code: `assignment_sales_import_${suffix}`, message: `assignment_sales_import_${suffix}` });
const source = changes => ({ source_name: ' Synthetic source ', provenance_note: '', currency: null,
  living_area_unit: null, site_area_unit: null, consideration_field: null, marketing_time_field: null,
  source_use_confirmed: false, ...changes });
const command = changes => ({ review_version: 1, expected_revision: 0, source_interpretation: source(), row_decisions: [], ...changes });
const decision = (index = 0, changes) => ({ receipt_id: rowId(index), source_row_number: index + 2,
  decision: 'confirm_proposed_match', account_ids: [account], note: '', ...changes });
const input = changes => ({ auth: { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] },
  accountId: 'SYNTHETIC-REVIEW', assignmentFileId: '10', reportFileId: report, batchId, operationId,
  command: command(), ...changes });
const marker = (db, name) => db.calls.filter(call => call.sql.includes(name));

/** Mock only query results and connection state. Actual intake, command,
 * candidate adapter, proposal kernel, payload/hash and owner code run here.
 * PostgreSQL constraints/locks are covered by the separate native helper. */
function fixture(options = {}) {
  const csv = options.csv ?? 'ListingId,CloseDate,ClosePrice,ParcelNumber,County\nTEST-1,2020-01-01,275000,00000000000000001,Dallas';
  const { rows: records, ...header } = prepareAssignmentSalesCsv(Buffer.from(csv));
  const rows = records.map((record_data, index) => ({ receipt_id: rowId(index),
    source_row_number: record_data.source_row_number, record_data }));
  const batch = { batch_id: batchId, source_sha256: header.source_sha256,
    preparation_sha256: digestPreparedSalesParts(header, records) };
  const db = { calls: [], releases: [], connects: 0, committed: [], rows, batch, options,
    async connect() {
      const connection = ++db.connects;
      options.onConnect?.(connection);
      let status = connection === 1 ? (options.initial === undefined ? 'I' : options.initial) : 'I';
      let pending = [];
      return { getTransactionStatus: () => status,
        release: error => db.releases.push({ connection, error }),
        async query(config) {
          const sql = typeof config === 'string' ? config : config.text, values = config.values ?? [];
          const call = { sql, values, connection, query_timeout: config.query_timeout };
          db.calls.push(call); options.beforeQuery?.(call, db);
          if (sql.startsWith('BEGIN')) status = 'T';
          if (sql === 'ROLLBACK') { pending = []; status = 'I'; }
          if (sql === 'COMMIT') {
            if (connection === 1 && options.commitFailure === 'before') {
              throw Object.assign(new Error('private transport failure'), { code: '08006' });
            }
            db.committed.push(...pending); pending = []; status = 'I';
            if (connection === 1 && options.commitFailure === 'after') {
              throw Object.assign(new Error('private lost acknowledgement'), { code: '08006' });
            }
          }
          if (sql.includes('assignment-sales:scope')) return { rows: options.noOwner ? [] : [{ organization_id: org,
            account_id: 'SYNTHETIC-REVIEW', report_file_id: report, assigned_appraiser_user_id: actor,
            supervisory_appraiser_user_id: null, status: 'draft', signed_at: null, has_signed_snapshot: false,
            ...options.ownerPatch }] };
          if (sql.includes('assignment-sales-review:batch')) return { rows: options.noBatch ? [] : [batch] };
          const reviews = [...db.committed, ...pending].sort((a, b) => b.revision - a.revision);
          if (sql.includes('assignment-sales-review:operation')) return { rows: reviews
            .filter(row => row.operation_id === values[1]).map(({ source_interpretation, ...row }) => structuredClone(row)) };
          if (sql.includes('assignment-sales-review:head')) return { rows: options.headRevision !== undefined
            ? [{ review_id: other, revision: options.headRevision }] : reviews.slice(0, 1) };
          if (sql.includes('assignment-sales-review:source')) return { rows: reviews.filter(row => row.source_interpretation !== null)
            .slice(0, 1).map(row => ({ review_id: row.review_id, source_interpretation: structuredClone(row.source_interpretation) })) };
          if (sql.includes('assignment-sales-review:state-rows')) return { rows: rows.filter(row => row.source_row_number > values[1])
            .slice(0, values[2]).map(row => {
              for (const review of reviews) {
                // Match project_assignment_sales_review_rows: the compact
                // projection comes from the command, never enriched evidence.
                const d = JSON.parse(review.command_json).row_decisions.find(d => d.source_row_number === row.source_row_number);
                if (d) return { receipt_id: row.receipt_id, source_row_number: row.source_row_number,
                  review_id: review.review_id, revision: review.revision, decision: d };
              }
              return { receipt_id: row.receipt_id, source_row_number: row.source_row_number, review_id: null, revision: null, decision: null };
            }) };
          if (sql.includes('assignment-sales-review:selected-rows')) {
            const selected = rows.filter(row => values[1].includes(row.source_row_number));
            const bytes = options.totalBytes ?? String(selected.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.record_data)), 0));
            return { rows: selected.map(row => ({ ...structuredClone(row), total_bytes: bytes })) };
          }
          if (sql.includes('assignment-sales-match:schema')) return { rows: ['accounts', 'county', 'address'].map(slot =>
            ({ slot, ready: !options.candidatesUnavailable, observed_at: time })) };
          if (sql.includes('assignment-sales-match:candidates')) return { rows: JSON.parse(values[0]).map(request => ({
            request_id: request.request_id, probe_count: 1, invalid_count: 0, payload_overflow: false,
            candidates: [{ account_id: request.identifier ?? account, address: '1 Synthetic Dr', city: 'GARLAND',
              county: 'DALLAS', postal_code: '75041' }],
          })) };
          if (sql.includes('assignment-sales-review:insert')) {
            const [review_id, batch_id, revision, operation_id, actor_user_id, command_json, command_sha256,
              payload_json, payload_sha256, interpretation] = values;
            assert.equal(batch_id, batchId);
            pending.push({ review_id, revision, operation_id, actor_user_id, command_json, command_sha256,
              payload_json, payload_sha256, source_interpretation: interpretation === null ? null : JSON.parse(interpretation),
              recorded_at: new Date(time) });
          }
          return { rows: [] };
        } };
    } };
  return db;
}

test('source-only review locks exact assignment/batch, hashes canonical data and returns a fresh committed receipt', async () => {
  const db = fixture(), request = input(), saved = await append(db, request);
  assert.equal(db.connects, 2); assert.equal(db.committed.length, 1);
  assert.equal(saved.persisted, true); assert.equal(saved.replayed, false); assert.equal(saved.previous_revision, 0);
  assert.equal(saved.revision, 1); assert.equal(saved.actor_user_id, actor); assert.equal(saved.recorded_at, time);
  assert.equal(saved.account_id, request.accountId); assert.equal(saved.report_file_id, report); assert.equal(saved.assignment_file_id, '10');
  assert.equal(saved.batch_id, batchId); assert.equal(saved.analysis_status, 'not_evaluated');
  assert.equal(saved.matching_status, 'reviewed_separately');
  assert.deepEqual(saved.command, validateAssignmentSalesReviewCommand(request.command));
  assert.equal(saved.command.source_interpretation.source_use_confirmed, false);
  const stored = db.committed[0], payload = JSON.parse(stored.payload_json);
  assert.equal(stored.command_json, serializePreparedSalesValue(saved.command));
  assert.equal(stored.command_sha256, hash(stored.command_json)); assert.equal(stored.payload_sha256, hash(stored.payload_json));
  assert.equal(stored.payload_json, serializePreparedSalesValue(payload));
  assert.deepEqual(payload.row_decisions, []); assert.equal(payload.analysis_status, 'not_evaluated');
  assert.equal(saved.payload_json, undefined, 'raw server evidence is not exposed in a receipt');
  assert.equal(marker(db, 'selected-rows').length, 0); assert.equal(marker(db, 'assignment-sales-match:').length, 0);
  const locked = marker(db, 'assignment-sales:workfile-lock')[0], batched = marker(db, 'assignment-sales-review:batch');
  assert.ok(db.calls.indexOf(locked) < db.calls.indexOf(batched[0]));
  assert.match(batched[0].sql, /FOR UPDATE/); assert.doesNotMatch(batched[1].sql, /FOR UPDATE/);
  for (const call of batched) assert.deepEqual(call.values, [batchId, org, report, '10', request.accountId]);
  for (const call of marker(db, 'assignment-sales:scope')) assert.deepEqual(call.values, ['10', request.accountId, report]);
  assert.equal(db.calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.ok(db.calls.every(call => Number.isInteger(call.query_timeout) && call.query_timeout > 0 && call.query_timeout <= 12000));
  assert.ok(db.calls.filter(call => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(call.sql))
    .every(call => /FOR (?:UPDATE|SHARE)|assignment-sales-review:insert/.test(call.sql)));
  assert.ok(db.releases.every(release => release.error === undefined));
});

for (const bad of [{ batchId: '' }, { operationId: '' }, { reportFileId: '' }, { assignmentFileId: '01' },
  { assignmentFileId: '9223372036854775808' }, { accountId: '' }, { command: null },
  { command: command({ expected_revision: -1 }) }, { command: command({ expected_revision: 2147483647 }) },
  { command: command({ row_decisions: [], source_interpretation: null }) }]) {
  test(`invalid review input cannot acquire a connection ${JSON.stringify(bad)}`, async () => {
    const db = fixture(); await assert.rejects(append(db, input(bad)), code('invalid_input'));
    assert.equal(db.connects, 0);
  });
}

test('anonymous and read-only actors cannot acquire a review write connection', async () => {
  const db = fixture(); await assert.rejects(append(db, input({ auth: null })), { code: 'authentication_required' });
  const request = input(); request.auth.organizations[0].roles = ['read_only'];
  await assert.rejects(append(db, request), code('access_denied')); assert.equal(db.connects, 0);
});

for (const initial of ['T', 'E', null, 'unknown']) {
  test(`inherited/unknown transaction ${initial} is never begun or committed by the review owner`, async () => {
    const db = fixture({ initial }); await assert.rejects(append(db, input()), code('transaction_state'));
    assert.ok(db.calls.every(call => call.sql === 'ROLLBACK')); assert.equal(db.committed.length, 0);
    assert.equal(db.releases.length, 1); assert.ok(db.releases[0].error);
  });
}

for (const options of [{ noOwner: true }, { ownerPatch: { organization_id: other } },
  { ownerPatch: { assigned_appraiser_user_id: other } }]) {
  test(`authorization rejects before batch or CAD data ${JSON.stringify(options)}`, async () => {
    const db = fixture(options); await assert.rejects(append(db, input()), code('access_denied'));
    assert.equal(marker(db, 'assignment-sales-review:').length, 0);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  });
}

test('an absent/cross-scope batch never reaches review heads or stored CSV rows', async () => {
  const db = fixture({ noBatch: true }); await assert.rejects(append(db, input()), code('not_found'));
  assert.equal(marker(db, 'assignment-sales-review:operation').length, 0);
  assert.equal(marker(db, 'selected-rows').length, 0); assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

for (const ownerPatch of [{ status: 'signed' }, { status: 'finalized' }, { signed_at: new Date(time) }, { has_signed_snapshot: true }]) {
  test(`a new review is blocked for signed/read-only workfiles ${JSON.stringify(ownerPatch)}`, async () => {
    const db = fixture({ ownerPatch }); await assert.rejects(append(db, input()), code('read_only'));
    assert.equal(marker(db, 'assignment-sales-review:head').length, 0);
    assert.equal(marker(db, 'assignment-sales-review:insert').length, 0);
  });
}

test('stale expected revision rejects before row loading, lookup, or insert', async () => {
  const db = fixture({ headRevision: 2 }); await assert.rejects(append(db, input()), code('revision_conflict'));
  assert.equal(marker(db, 'selected-rows').length, 0); assert.equal(marker(db, 'assignment-sales-match:').length, 0);
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0);
});

test('an exact actor-bound source-only replay stays idempotent even after signing or a newer head', async () => {
  const options = {}, db = fixture(options), request = input(), first = await append(db, request);
  options.ownerPatch = { status: 'signed', signed_at: new Date(time), has_signed_snapshot: true };
  options.headRevision = 9;
  const second = await append(db, request);
  assert.equal(second.review_id, first.review_id); assert.equal(second.replayed, true); assert.equal(second.persisted, true);
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 1); assert.equal(db.committed.length, 1);
});

test('the same operation cannot replace a different source command', async () => {
  const db = fixture(); await append(db, input());
  await assert.rejects(append(db, input({ command: command({ source_interpretation: source({ currency: 'USD' }) }) })), code('operation_conflict'));
  assert.equal(db.committed.length, 1); assert.equal(marker(db, 'assignment-sales-review:insert').length, 1);
});

test('an operation belongs to its recording actor, not merely an authorized coworker', async () => {
  const db = fixture(); await append(db, input()); db.committed[0].actor_user_id = other;
  await assert.rejects(append(db, input()), code('operation_conflict'));
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 1);
});

test('input mutation during the first await cannot change command, target, actor, or recovery scope', async () => {
  const request = input(), expected = structuredClone(request);
  const db = fixture({ onConnect: index => { if (index === 1) {
    request.command.source_interpretation.currency = 'USD'; request.command.expected_revision = 50;
    request.auth.userId = other; request.auth.organizations[0].organizationId = other;
    request.auth.organizations[0].roles.length = 0;
    request.accountId = 'OTHER-ACCOUNT'; request.assignmentFileId = '11'; request.reportFileId = other;
    request.batchId = other; request.operationId = other;
  } } });
  const saved = await append(db, request);
  assert.deepEqual(saved.command, validateAssignmentSalesReviewCommand(expected.command));
  assert.equal(saved.actor_user_id, actor); assert.equal(saved.operation_id, operationId);
  for (const call of marker(db, 'assignment-sales-review:batch')) assert.deepEqual(call.values,
    [batchId, org, report, '10', expected.accountId]);
});

test('fresh candidate evidence is obtained under the write owner and retained without analysis approval', async () => {
  const db = fixture(), request = input({ command: command({ source_interpretation: null, row_decisions: [decision()] }) });
  const saved = await append(db, request), payload = JSON.parse(db.committed[0].payload_json), d = payload.row_decisions[0];
  assert.equal(saved.persisted, true); assert.equal(d.match_evidence.observed_at, time);
  assert.deepEqual(d.match_evidence.binding, db.batch); assert.deepEqual(d.account_ids, [account]);
  assert.deepEqual(d.record_data, db.rows[0].record_data); assert.equal(d.record_data.persisted, false);
  assert.equal(d.match_evidence.proposal.accepted, false); assert.equal(payload.analysis_status, 'not_evaluated');
  assert.equal(marker(db, 'assignment-sales-match:schema').length, 1);
  assert.equal(marker(db, 'assignment-sales-match:candidates').length, 1);
  assert.ok(db.calls.indexOf(marker(db, 'assignment-sales:workfile-lock')[0])
    < db.calls.indexOf(marker(db, 'assignment-sales-match:schema')[0]));
});

test('all supplied parcels must remain in the freshly proposed confirmation set', async () => {
  const second = '00000000000000002';
  const csv = 'ListingId,CloseDate,ClosePrice,ParcelNumber,ParcelNumber2,County\n'
    + `TEST-1,2020-01-01,275000,${account},${second},Dallas`;
  const db = fixture({ csv });
  await assert.rejects(append(db, input({ command: command({ row_decisions: [decision()] }) })), code('stale_match'));
  assert.equal(db.committed.length, 0);
  await append(db, input({ command: command({ row_decisions: [decision(0, { account_ids: [second, account] })] }) }));
  const saved = JSON.parse(db.committed[0].payload_json).row_decisions[0];
  assert.deepEqual(saved.account_ids, [account, second]); assert.equal(saved.match_evidence.lookups.length, 2);
});

test('confirmation arrays are detached before the owner acquires its connection', async () => {
  const request = input({ command: command({ source_interpretation: null, row_decisions: [decision()] }) });
  const db = fixture({ onConnect: connection => { if (connection === 1) {
    request.command.row_decisions[0].account_ids[0] = '00000000000000099';
    request.command.row_decisions[0].receipt_id = other;
    request.command.row_decisions.length = 0;
  } } });
  const saved = await append(db, request);
  assert.deepEqual(saved.command.row_decisions, [decision()]);
});

test('confirmations preserve full intervening proposal context but persist only requested decisions', async () => {
  const csv = 'ListingId,CloseDate,ClosePrice,ParcelNumber,County\n'
    + [1, 2, 3].map(n => `TEST-${n},2020-01-01,275000,00000000000000001,Dallas`).join('\n');
  const db = fixture({ csv });
  await append(db, input({ command: command({ source_interpretation: null, row_decisions: [decision(0), decision(2)] }) }));
  assert.deepEqual(marker(db, 'selected-rows')[0].values, [batchId, [2, 3, 4]]);
  assert.deepEqual(JSON.parse(db.committed[0].payload_json).row_decisions.map(row => row.source_row_number), [2, 4]);
});

test('a confirmation span larger than 100 rows rejects without a row transfer or CAD lookup', async () => {
  const db = fixture();
  await assert.rejects(append(db, input({ command: command({ row_decisions: [decision(), decision(100)] }) })), code('invalid_input'));
  assert.equal(marker(db, 'selected-rows').length, 0); assert.equal(marker(db, 'assignment-sales-match:').length, 0);
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0); assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('the exact 100-row confirmation span is supported without a top-30 cap', async () => {
  const csv = 'ListingId,CloseDate,ClosePrice,ParcelNumber,County\n'
    + Array.from({ length: 100 }, (_, index) => `TEST-${index},2020-01-01,275000,${account},Dallas`).join('\n');
  const db = fixture({ csv });
  await append(db, input({ command: command({ source_interpretation: null, row_decisions: [decision(0), decision(99)] }) }));
  const ordinals = marker(db, 'selected-rows')[0].values[1];
  assert.equal(ordinals.length, 100); assert.equal(ordinals[0], 2); assert.equal(ordinals.at(-1), 101);
  assert.deepEqual(JSON.parse(db.committed[0].payload_json).row_decisions.map(row => row.source_row_number), [2, 101]);
});

for (const kind of ['exclude', 'clear']) {
  test(`${kind} preserves the immutable row identity without inferring a match or querying CAD`, async () => {
    const db = fixture(); await append(db, input({ command: command({ source_interpretation: null,
      row_decisions: [decision(0, { decision: kind, account_ids: [] })] }) }));
    const payload = JSON.parse(db.committed[0].payload_json), d = payload.row_decisions[0];
    assert.equal(d.decision, kind); assert.equal(d.match_evidence, null); assert.deepEqual(d.record_data, db.rows[0].record_data);
    assert.equal(payload.analysis_status, 'not_evaluated'); assert.equal(marker(db, 'assignment-sales-match:').length, 0);
  });
}

test('changed/unavailable current candidates cannot save a stale confirmation', async () => {
  const db = fixture({ candidatesUnavailable: true });
  await assert.rejects(append(db, input({ command: command({ row_decisions: [decision()] }) })), code('stale_match'));
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0); assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('mismatched immutable receipt identity cannot be excluded under another row number', async () => {
  const db = fixture(); await assert.rejects(append(db, input({ command: command({ row_decisions: [decision(0,
    { receipt_id: other, decision: 'exclude', account_ids: [] })] }) })), code('stale_match'));
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0);
});

test('a missing selected stored ordinal cannot become an empty successful review', async () => {
  const db = fixture(); db.rows.length = 0;
  await assert.rejects(append(db, input({ command: command({ row_decisions: [decision()] }) })), code('invalid_input'));
  assert.equal(marker(db, 'assignment-sales-match:').length, 0);
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0);
});

for (const driverCode of ['42P01', '55P03']) {
  test(`fresh candidate SQL ${driverCode} rolls back and exposes only a fixed error`, async () => {
    const db = fixture({ beforeQuery: ({ sql }) => { if (sql.includes('assignment-sales-match:schema')) {
      throw Object.assign(new Error('SELECT private_source; password=do-not-expose'), { code: driverCode });
    } } });
    await assert.rejects(append(db, input({ command: command({ row_decisions: [decision()] }) })),
      code(driverCode === '55P03' ? 'busy' : 'failed'));
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); assert.equal(db.committed.length, 0);
    assert.equal(marker(db, 'assignment-sales-review:insert').length, 0); assert.ok(db.releases[0].error);
  });
}

test('an insert SQL failure rolls back without returning a fake saved receipt', async () => {
  const db = fixture({ beforeQuery: ({ sql }) => { if (sql.includes('assignment-sales-review:insert')) {
    throw Object.assign(new Error('private constraint details'), { code: '23514' });
  } } });
  await assert.rejects(append(db, input()), code('failed'));
  assert.equal(db.committed.length, 0); assert.equal(db.connects, 1); assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('lost COMMIT acknowledgement recovers the same canonical operation on a fresh connection', async () => {
  const db = fixture({ commitFailure: 'after' }), saved = await append(db, input());
  assert.equal(saved.persisted, true); assert.equal(saved.replayed, true); assert.equal(db.connects, 2);
  assert.equal(db.committed.length, 1); assert.equal(marker(db, 'assignment-sales-review:insert').length, 1);
  assert.equal(db.releases[0].error.code, 'assignment_sales_import_commit_unknown');
  assert.equal(db.releases[1].error, undefined);
});

test('an uncertain write with no committed operation remains unknown, never automatically reinserts', async () => {
  const db = fixture({ commitFailure: 'before' }); await assert.rejects(append(db, input()), code('commit_unknown'));
  assert.equal(db.connects, 2); assert.equal(db.committed.length, 0); assert.equal(marker(db, 'assignment-sales-review:insert').length, 1);
});

test('readback failure after COMMIT stays unknown while the saved review remains recoverable', async () => {
  const db = fixture({ beforeQuery: ({ sql, connection }) => { if (connection === 2 && sql.includes('assignment-sales:scope')) {
    throw Object.assign(new Error('private readback outage'), { code: '08006' });
  } } });
  await assert.rejects(append(db, input()), code('commit_unknown')); assert.equal(db.committed.length, 1);
  const recovered = await receipt(db, input()); assert.equal(recovered.persisted, true); assert.equal(recovered.revision, 1);
});

test('metered selected rows exceeding 4 MiB fail before proposal assembly and insert', async () => {
  const db = fixture({ totalBytes: '4194305' });
  await assert.rejects(append(db, input({ command: command({ row_decisions: [decision()] }) })), code('preparation_limit'));
  assert.equal(marker(db, 'assignment-sales-match:').length, 0); assert.equal(marker(db, 'assignment-sales-review:insert').length, 0);
});

test('valid original CSV rows that would exceed the 2 MiB review payload are rejected as a whole', async () => {
  const names = Array.from({ length: 70 }, (_, index) => `Uninterpreted${index}`), cells = names.map(() => 'x'.repeat(16000));
  const csv = [['ListingId', 'CloseDate', 'ClosePrice', 'ParcelNumber', ...names],
    ['L1', '2020-01-01', '275000', account, ...cells], ['L2', '2020-01-01', '275000', account, ...cells]]
    .map(row => row.join(',')).join('\n');
  const db = fixture({ csv }), choices = [0, 1].map(index => decision(index, { decision: 'exclude', account_ids: [] }));
  await assert.rejects(append(db, input({ command: command({ row_decisions: choices }) })), code('preparation_limit'));
  assert.equal(marker(db, 'assignment-sales-review:insert').length, 0); assert.equal(db.committed.length, 0);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

test('empty review state is explicit and a read-only actor may inspect a signed assignment', async () => {
  const db = fixture({ ownerPatch: { status: 'signed', has_signed_snapshot: true, signed_at: new Date(time) } });
  const request = input(); request.auth.organizations[0].roles = ['read_only'];
  const result = await state(db, request);
  assert.equal(result.revision, 0); assert.equal(result.last_review_id, null); assert.equal(result.source_interpretation, null);
  assert.deepEqual(result.row_decisions, []); assert.equal(result.next_after_row, null);
  assert.equal(result.analysis_status, 'not_evaluated'); assert.equal(marker(db, 'assignment-sales:workfile-lock').length, 0);
  assert.ok(db.calls.some(call => call.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});

test('review state preserves latest source choice while paging visible unreviewed and reviewed rows', async () => {
  const csv = 'ListingId,CloseDate,ClosePrice,ParcelNumber\n'
    + [1, 2, 3].map(n => `L${n},2020-01-01,275000,${account}`).join('\n');
  const db = fixture({ csv }); await append(db, input());
  await append(db, input({ operationId: other, command: command({ expected_revision: 1, source_interpretation: null,
    row_decisions: [decision(1, { decision: 'exclude', account_ids: [] })] }) }));
  const first = await state(db, input({ limit: 1 }));
  assert.equal(first.revision, 2); assert.equal(first.source_interpretation.source_name, 'Synthetic source');
  assert.deepEqual(first.row_decisions, []); assert.equal(first.next_after_row, 2, 'unreviewed visible rows still advance the cursor');
  const second = await state(db, input({ afterRow: 2, limit: 1 }));
  assert.equal(second.next_after_row, 3); assert.equal(second.row_decisions[0].source_row_number, 3);
  assert.equal(second.row_decisions[0].decision, 'exclude'); assert.equal(second.row_decisions[0].revision, 2);
  assert.deepEqual(Object.keys(second.row_decisions[0]).sort(),
    ['account_ids', 'decision', 'note', 'receipt_id', 'review_id', 'revision', 'source_row_number']);
  assert.equal(second.row_decisions[0].record_data, undefined); assert.equal(second.row_decisions[0].match_evidence, undefined);
  assert.deepEqual(marker(db, 'assignment-sales-review:state-rows').at(-1).values, [batchId, 2, 2]);
});

test('receipt lookup absence remains null; malformed page metadata is rejected before any connection', async () => {
  const db = fixture(); assert.equal(await receipt(db, input()), null);
  const idle = fixture();
  for (const bad of [{ afterRow: -1 }, { afterRow: '0' }, { afterRow: 10002 }, { limit: 0 }, { limit: 101 }, { limit: '50' }]) {
    await assert.rejects(state(idle, input(bad)), code('invalid_input'));
  }
  assert.equal(idle.connects, 0);
});

for (const part of ['command', 'payload']) {
  test(`a damaged stored ${part} digest cannot be exposed as a committed review receipt`, async () => {
    const db = fixture(); await append(db, input()); db.committed[0][`${part}_sha256`] = '0'.repeat(64);
    await assert.rejects(receipt(db, input()), code('invalid_receipt'));
  });
}
