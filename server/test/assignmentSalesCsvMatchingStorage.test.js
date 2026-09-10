import assert from 'node:assert/strict';
import test from 'node:test';
import { getAssignmentSalesImportMatchProposals as get } from '../src/services/assignmentSalesCsv/storage.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';

const actor = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const report = '33333333-3333-4333-8333-333333333333', batch = '44444444-4444-4444-8444-444444444444';
const rowId = '55555555-5555-4555-8555-555555555555';
const input = () => ({ auth: { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] },
  accountId: 'SYNTHETIC-MATCHING', assignmentFileId: '10', reportFileId: report, batchId: batch });
const preparation = () => prepareAssignmentSalesCsv(Buffer.from(
  'ListingId,CloseDate,ClosePrice,ParcelNumber,County\nTEST-1,2020-01-01,275000,00000000000000001,Dallas'));
function fixture({ ownerPatch, noBatch, before, changedRow, initial = 'I' } = {}) {
  const prepared = preparation(), { rows, ...header } = prepared;
  const record = structuredClone(rows[0]); changedRow?.(record);
  const bytes = Buffer.byteLength(JSON.stringify(record));
  const calls = [], releases = []; let state = initial;
  return { calls, releases, async connect() {
    return { getTransactionStatus: () => state, release: error => releases.push(error), async query(config) {
      const sql = typeof config === 'string' ? config : config.text;
      calls.push({ sql, values: config.values }); before?.(sql);
      if (sql.startsWith('BEGIN')) state = 'T';
      if (sql === 'COMMIT' || sql === 'ROLLBACK') state = 'I';
      if (sql.includes('assignment-sales:scope')) return { rows: [{ organization_id: org, account_id: 'SYNTHETIC-MATCHING',
        report_file_id: report, assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null,
        status: 'signed', signed_at: new Date(), has_signed_snapshot: true, ...ownerPatch }] };
      if (sql.includes('assignment-sales:match-scope')) return { rows: noBatch ? [] : [{ batch_id: batch,
        stored_at: new Date('2026-09-10T12:00:00.000Z'),
        source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows),
        preparation_profile: header.profile_id, preparation_version: header.preparation_version,
        preparation_header: header, row_count: rows.length, stored_row_count: rows.length }] };
      if (sql.includes('assignment-sales:bounded-rows')) return { rows: [{ candidate_count: 1, metered_count: 1,
        invalid_count: 0, returned_count: 1, returned_payload_bytes: bytes, next_payload_bytes: null, has_more: false,
        receipt_id: rowId, source_row_number: 2, payload_bytes: bytes, record_data: record }] };
      if (sql.includes('assignment-sales-match:schema')) return { rows: ['accounts', 'county', 'address'].map(slot =>
        ({ slot, ready: false, observed_at: '2026-09-10T12:00:00.000Z' })) };
      assert.ok(!sql.includes('assignment-sales-match:candidates'), 'incompatible caches must not be queried');
      return { rows: [] };
    } };
  } };
}

test('matching owner uses exact scoped read-only transaction, keeps historical sale and reports unavailable CAD honestly', async () => {
  const db = fixture(), request = input(), result = await get(db, request);
  assert.equal(result.account_id, request.accountId); assert.equal(result.assignment_file_id, '10');
  assert.equal(result.report_file_id, report); assert.equal(result.binding.batch_id, batch);
  assert.equal(result.accepted, false); assert.equal(result.analysis_status, 'not_evaluated');
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].receipt_id, rowId);
  assert.equal(result.rows[0].proposal_status, 'review_required');
  assert.ok(result.rows[0].reasons.includes('candidate_lookup_unavailable'));
  assert.equal(result.next_after_row, null); assert.match(result.proposal_page_sha256, /^[a-f0-9]{64}$/);
  assert.ok(db.calls.some(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(db.calls.every(({ sql }) => !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql)));
  assert.equal(db.calls.at(-1).sql, 'COMMIT'); assert.deepEqual(db.releases, [undefined]);
  const exact = db.calls.find(({ sql }) => sql.includes('assignment-sales:match-scope'));
  assert.deepEqual(exact.values, [batch, org, report, '10', request.accountId]);
});

test('matching observation digest binds actual source row data as well as proposal output', async () => {
  const original = await get(fixture(), input());
  const changed = await get(fixture({ changedRow: row => { row.raw_cells[2] = '275001'; } }), input());
  assert.deepEqual(changed.rows, original.rows);
  assert.notEqual(changed.proposal_page_sha256, original.proposal_page_sha256);
});

test('missing or differently scoped batch cannot reach rows or CAD data', async () => {
  const db = fixture({ noBatch: true });
  await assert.rejects(get(db, input()), { code: 'assignment_sales_import_not_found' });
  assert.ok(!db.calls.some(({ sql }) => sql.includes('bounded-rows') || sql.includes('assignment-sales-match:')));
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
});

for (const ownerPatch of [{ organization_id: report }, { assigned_appraiser_user_id: report }]) {
  test(`assignment/tenant denial precedes batch and CAD reads ${JSON.stringify(ownerPatch)}`, async () => {
    const db = fixture({ ownerPatch });
    await assert.rejects(get(db, input()), { code: 'assignment_sales_import_access_denied' });
    assert.ok(!db.calls.some(({ sql }) => sql.includes('match-scope') || sql.includes('assignment-sales-match:')));
  });
}

test('anonymous and invalid proposal targets/page bounds cannot acquire a connection', async () => {
  const db = fixture();
  await assert.rejects(get(db, { ...input(), auth: null }), { code: 'authentication_required' });
  for (const bad of [{ batchId: '' }, { reportFileId: '' }, { assignmentFileId: '01' },
    { limit: 0 }, { limit: 101 }, { limit: '50' }, { afterRow: -1 }, { afterRow: 10002 }, { afterRow: '0' }]) {
    await assert.rejects(get(db, { ...input(), ...bad }), { code: 'assignment_sales_import_invalid_input' });
  }
  assert.equal(db.calls.length, 0);
});

test('read permission may inspect signed imports but does not become approval/signing authority', async () => {
  const request = input(); request.auth.organizations[0].roles = ['read_only'];
  const result = await get(fixture(), request);
  assert.equal(result.accepted, false); assert.equal(result.rows[0].accepted, false);
  assert.equal(result.rows[0].review_required, true);
});

test('candidate SQL failure rolls back with no leaking SQL or partial proposals', async () => {
  const db = fixture({ before: sql => { if (sql.includes('assignment-sales-match:schema')) {
    throw Object.assign(new Error('sensitive CAD SQL'), { code: '42P01' });
  } } });
  await assert.rejects(get(db, input()), { code: 'assignment_sales_import_failed', message: 'assignment_sales_import_failed' });
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK'); assert.ok(db.releases[0]);
});

test('matching owner refuses an inherited transaction instead of committing another operation', async () => {
  const db = fixture({ initial: 'T' });
  await assert.rejects(get(db, input()), { code: 'assignment_sales_import_transaction_state' });
  assert.ok(db.calls.every(({ sql }) => sql === 'ROLLBACK'));
});
