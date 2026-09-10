import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { serializePreparedSalesValue } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { appendAssignmentSalesImportReview as append, getAssignmentSalesImportReviewState as state,
  getAssignmentSalesImportReviewByOperation as operation } from '../../src/services/assignmentSalesCsv/reviewStorage.js';
import { getAssignmentSalesImportMatchProposals as propose } from '../../src/services/assignmentSalesCsv/storage.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const failure = code => error => { assert.equal(error.code, code); return true; };
const interpretation = changes => ({ source_name: 'Synthetic private CSV native review', provenance_note: 'Synthetic fixture only; no source or historical authority.',
  currency: 'USD', living_area_unit: 'sqft', site_area_unit: 'sqft', consideration_field: 'close_price',
  marketing_time_field: 'days_on_market', source_use_confirmed: true, ...changes });
const command = (revision, source = null, rows = []) => ({ review_version: 1, expected_revision: revision,
  source_interpretation: source, row_decisions: rows });
const decision = (row, kind, accounts = []) => ({ receipt_id: row.receipt_id, source_row_number: row.source_row_number,
  decision: kind, account_ids: accounts, note: 'Synthetic reviewer decision, not analysis admission.' });

/** Import-safe and root-run only after canonical migrations in a new verified
 * disposable database. Input names the existing synthetic matching batch with
 * rows 2/4 independently proposed and row 3 retained as a duplicate. No schema
 * setup, service controls, cleanup deletion, global sales or adoption writes.
 * The supplied ownedTransaction must use a separate checked-out connection and
 * roll back on return. Owner APIs keep their genuine connection/COMMIT paths.
 */
export async function runAssignmentSalesCsvReviewDatabaseChecks({ pool, databaseName, input, batchId,
  readerAuth, otherActorAuth, deniedAuths, siblingInput, ownedTransaction }) {
  assert.match(databaseName, /^[a-z0-9_]+_test$/); assert.equal(typeof ownedTransaction, 'function');
  assert.ok(readerAuth && otherActorAuth && Array.isArray(deniedAuths) && deniedAuths.length >= 2 && siblingInput);
  const probe = await pool.connect();
  try {
    assert.equal(probe.getTransactionStatus(), 'I');
    verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, databaseName);
  } finally { probe.release(); }
  const request = { ...input, batchId }, checks = [];
  const originals = (await pool.query(`SELECT receipt_id,source_row_number,record_data FROM app.assignment_sales_import_rows
    WHERE batch_id=$1 ORDER BY source_row_number`, [batchId])).rows;
  assert.equal(originals.length, 3); assert.equal(originals[1].record_data.preparation_disposition, 'duplicate');
  const protectedState = async () => ({
    batch: (await pool.query('SELECT to_jsonb(b) AS value FROM app.assignment_sales_import_batches b WHERE batch_id=$1', [batchId])).rows,
    rows: (await pool.query('SELECT to_jsonb(r) AS value FROM app.assignment_sales_import_rows r WHERE batch_id=$1 ORDER BY source_row_number', [batchId])).rows,
    assignment: (await pool.query('SELECT to_jsonb(a) AS value FROM app.assignment_files a WHERE id=$1', [input.assignmentFileId])).rows,
    report: (await pool.query('SELECT to_jsonb(r) AS value FROM app.report_files r WHERE id=$1', [input.reportFileId])).rows,
    workfile: (await pool.query('SELECT to_jsonb(w) AS value FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1', [input.assignmentFileId])).rows,
    sections: (await pool.query('SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1 ORDER BY section_key', [input.assignmentFileId])).rows,
    history: (await pool.query('SELECT to_jsonb(h) AS value FROM app.custom_appraisal_workfile_section_history h WHERE assignment_file_id=$1 ORDER BY id', [input.assignmentFileId])).rows,
    signed: (await pool.query('SELECT to_jsonb(s) AS value FROM app.custom_appraisal_signed_snapshots s WHERE assignment_file_id=$1 ORDER BY id', [input.assignmentFileId])).rows,
  });
  const protectedBefore = await protectedState();
  const count = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM app.assignment_sales_import_reviews WHERE batch_id=$1) AS reviews,
    (SELECT count(*)::int FROM app.assignment_sales_import_review_rows WHERE batch_id=$1) AS projections`, [batchId])).rows[0];
  assert.deepEqual(await count(), { reviews: 0, projections: 0 });
  assert.equal((await state(pool, request)).revision, 0);

  const firstRequest = { ...request, operationId: randomUUID(), command: command(0, interpretation()) };
  const first = await append(pool, firstRequest);
  assert.equal(first.revision, 1); assert.equal(first.previous_revision, 0); assert.equal(first.persisted, true);
  assert.equal(first.replayed, false); assert.deepEqual(first.command, firstRequest.command);
  assert.equal(first.analysis_status, 'not_evaluated'); assert.equal(first.matching_status, 'reviewed_separately');
  assert.equal(first.actor_user_id, input.auth.userId);
  assert.deepEqual(await append(pool, firstRequest), { ...first, replayed: true });
  assert.deepEqual(await operation(pool, { ...firstRequest, auth: readerAuth }), first);
  assert.equal(await operation(pool, { ...firstRequest, operationId: randomUUID() }), null);
  await assert.rejects(append(pool, { ...firstRequest, command: command(0, interpretation({ provenance_note: 'Changed operation body' })) }),
    failure('assignment_sales_import_operation_conflict'));
  await assert.rejects(append(pool, { ...firstRequest, auth: otherActorAuth }), failure('assignment_sales_import_operation_conflict'));
  await assert.rejects(append(pool, { ...firstRequest, operationId: randomUUID() }), failure('assignment_sales_import_revision_conflict'));
  assert.deepEqual(await count(), { reviews: 1, projections: 0 });
  checks.push('committed source interpretation, exact actor/body operation replay and stale revision rejection');

  await append(pool, { ...request, operationId: randomUUID(), command: command(1, null, [decision(originals[0], 'exclude')]) });
  let current = await state(pool, request);
  assert.equal(current.revision, 2); assert.equal(current.row_decisions[0].decision, 'exclude');
  await append(pool, { ...request, operationId: randomUUID(), command: command(2, null, [decision(originals[0], 'clear')]) });
  current = await state(pool, request);
  assert.equal(current.row_decisions[0].decision, 'clear'); assert.equal(current.row_decisions[0].revision, 3);
  assert.deepEqual(current.source_interpretation, interpretation());
  const proposed = await propose(pool, request);
  const proposedRows = proposed.rows.filter(row => row.proposal_status === 'proposed');
  assert.deepEqual(proposedRows.map(row => row.source_row_number), [2, 4]);
  // Sparse selected rows must be recomputed in their actual contiguous source
  // interval, retaining the duplicate between them; no renumbering or omission.
  const confirmations = proposedRows.map(row => decision(row, 'confirm_proposed_match', row.proposed_account_ids));
  const confirmed = await append(pool, { ...request, operationId: randomUUID(), command: command(3, null, confirmations) });
  assert.equal(confirmed.revision, 4);
  current = await state(pool, request);
  assert.deepEqual(current.row_decisions.map(row => [row.source_row_number, row.decision]), [[2, 'confirm_proposed_match'], [4, 'confirm_proposed_match']]);
  assert.ok(current.row_decisions.every(row => row.revision === 4));
  assert.equal(current.analysis_status, 'not_evaluated');
  const savedPayload = JSON.parse((await pool.query('SELECT payload_json FROM app.assignment_sales_import_reviews WHERE review_id=$1', [confirmed.review_id])).rows[0].payload_json);
  assert.equal(savedPayload.row_decisions.length, 2);
  for (const row of savedPayload.row_decisions) {
    assert.deepEqual(row.record_data, originals.find(original => original.receipt_id === row.receipt_id).record_data);
    assert.equal(row.match_evidence.binding.batch_id, batchId);
    assert.equal(row.match_evidence.proposal.proposal_status, 'proposed');
    assert.deepEqual(row.match_evidence.proposal.proposed_account_ids, row.account_ids);
  }
  await assert.rejects(append(pool, { ...request, operationId: randomUUID(), command: command(4, null,
    [decision(originals[1], 'confirm_proposed_match', confirmations[0].account_ids)]) }), failure('assignment_sales_import_stale_match'));
  await assert.rejects(append(pool, { ...request, operationId: randomUUID(), command: command(4, null,
    [decision(originals[0], 'confirm_proposed_match', ['99999999999999999'])]) }), failure('assignment_sales_import_stale_match'));
  const unknown = interpretation({ currency: null, living_area_unit: null, site_area_unit: null,
    consideration_field: null, marketing_time_field: null, source_use_confirmed: false, provenance_note: 'Explicit unknown correction.' });
  await append(pool, { ...request, operationId: randomUUID(), command: command(4, unknown) });
  current = await state(pool, { ...request, auth: readerAuth });
  assert.equal(current.revision, 5); assert.deepEqual(current.source_interpretation, unknown);
  assert.equal(current.row_decisions.length, 2, 'unknown source correction never erases independent retained row review history');
  const page1 = await state(pool, { ...request, limit: 1 }); assert.equal(page1.next_after_row, 2);
  const page2 = await state(pool, { ...request, limit: 1, afterRow: 2 });
  assert.deepEqual(page2.row_decisions, []); assert.equal(page2.next_after_row, 3);
  const page3 = await state(pool, { ...request, limit: 1, afterRow: 3 }); assert.equal(page3.next_after_row, null);
  assert.equal(page3.row_decisions[0].source_row_number, 4);
  assert.deepEqual(await append(pool, firstRequest), { ...first, replayed: true }, 'replay retains its original revision, not the current head');
  checks.push('exclude/clear/current-head projection, sparse fresh confirmations with duplicate retained, explicit unknown correction and complete pagination');

  const beforeDenials = await count();
  await assert.rejects(append(pool, { ...request, auth: readerAuth, operationId: randomUUID(), command: command(5, unknown) }), failure('assignment_sales_import_access_denied'));
  for (const auth of deniedAuths) {
    await assert.rejects(state(pool, { ...request, auth }), failure('assignment_sales_import_access_denied'));
    await assert.rejects(append(pool, { ...request, auth, operationId: randomUUID(), command: command(5, unknown) }), failure('assignment_sales_import_access_denied'));
  }
  await assert.rejects(state(pool, { ...siblingInput, batchId }), failure('assignment_sales_import_not_found'));
  await assert.rejects(append(pool, { ...siblingInput, batchId, operationId: randomUUID(), command: command(0, unknown) }), failure('assignment_sales_import_not_found'));
  await assert.rejects(state(pool, { ...request, auth: null }), failure('authentication_required'));
  assert.deepEqual(await count(), beforeDenials);
  await ownedTransaction(async signer => {
    await signer.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [input.assignmentFileId]);
    await assert.rejects(append(pool, { ...request, operationId: randomUUID(), command: command(5, unknown) }), failure('assignment_sales_import_busy'));
  });
  const originalWorkfile = protectedBefore.workfile[0].value;
  try {
    await pool.query(`UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp(),signed_by='Synthetic review gate only'
      WHERE assignment_file_id=$1`, [input.assignmentFileId]);
    await assert.rejects(append(pool, { ...request, operationId: randomUUID(), command: command(5, unknown) }), failure('assignment_sales_import_read_only'));
    assert.equal((await state(pool, { ...request, auth: readerAuth })).revision, 5);
    assert.deepEqual(await append(pool, firstRequest), { ...first, replayed: true });
  } finally {
    await pool.query(`UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,signed_by=$4,updated_at=$5
      WHERE assignment_file_id=$1`, [input.assignmentFileId, originalWorkfile.status, originalWorkfile.signed_at,
      originalWorkfile.signed_by, originalWorkfile.updated_at]);
  }
  assert.deepEqual(await protectedState(), protectedBefore);
  checks.push('actual signing lock, signed replay/read-only denial and exact actor/tenant/assignment access without report/source mutation');

  const race = await Promise.allSettled(['A', 'B'].map(label => append(pool, { ...request, operationId: randomUUID(),
    command: command(5, interpretation({ provenance_note: `Synthetic concurrent ${label}` })) })));
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected').reason.code, 'assignment_sales_import_revision_conflict');
  assert.equal((await state(pool, request)).revision, 6);
  const uncertainPool = readbackFails => {
    let committed = false;
    return { async connect() {
      if (committed && readbackFails) throw new Error('Synthetic readback unavailable');
      const client = await pool.connect();
      return { getTransactionStatus: () => client.getTransactionStatus(), release: error => client.release(error), async query(config, values) {
        const sql = typeof config === 'string' ? config : config.text;
        const result = await client.query(config, values);
        if (sql === 'COMMIT' && !committed) { committed = true; throw new Error('Synthetic lost COMMIT acknowledgement'); }
        return result;
      } };
    } };
  };
  const lost = { ...request, operationId: randomUUID(), command: command(6, unknown) };
  const recovered = await append(uncertainPool(false), lost);
  assert.equal(recovered.revision, 7); assert.equal(recovered.replayed, true);
  const unknownCommit = { ...request, operationId: randomUUID(), command: command(7, unknown) };
  await assert.rejects(append(uncertainPool(true), unknownCommit), failure('assignment_sales_import_commit_unknown'));
  const recoveredLater = await operation(pool, unknownCommit);
  assert.equal(recoveredLater.revision, 8); assert.equal(recoveredLater.persisted, true);
  assert.deepEqual(await append(pool, unknownCommit), { ...recoveredLater, replayed: true });
  assert.deepEqual(await count(), { reviews: 8, projections: 4 });
  checks.push('genuine concurrent append CAS and committed-but-lost acknowledgement recovery preserve exactly one actor-bound review');

  let attacks = 0;
  await ownedTransaction(async client => {
    const denied = async (sql, values = [], codes = ['23514']) => {
      await client.query('SAVEPOINT private_csv_review_attack');
      try { await assert.rejects(client.query(sql, values), error => { assert.ok(codes.includes(error.code), error.code); return true; }); attacks += 1; }
      finally { await client.query('ROLLBACK TO SAVEPOINT private_csv_review_attack'); await client.query('RELEASE SAVEPOINT private_csv_review_attack'); }
    };
    const baseCommand = command(8, null, [decision(originals[0], 'exclude')]);
    const basePayload = { review_version: 1, source_interpretation: null, row_decisions: [{ ...baseCommand.row_decisions[0],
      record_data: originals[0].record_data, match_evidence: null }], matching_status: 'reviewed_separately', analysis_status: 'not_evaluated' };
    const parentSql = `INSERT INTO app.assignment_sales_import_reviews(review_id,batch_id,revision,operation_id,actor_user_id,
      command_json,command_sha256,payload_json,payload_sha256,source_interpretation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`;
    const badParent = async change => {
      const value = { command: structuredClone(baseCommand), payload: structuredClone(basePayload), revision: 9,
        batchId, source: null, badCommandHash: false, badPayloadHash: false };
      change(value); const commandJson = serializePreparedSalesValue(value.command), payloadJson = serializePreparedSalesValue(value.payload);
      await denied(parentSql, [randomUUID(), value.batchId, value.revision, randomUUID(), input.auth.userId,
        commandJson, value.badCommandHash ? '0'.repeat(64) : hash(commandJson),
        payloadJson, value.badPayloadHash ? '0'.repeat(64) : hash(payloadJson), value.source === null ? null : serializePreparedSalesValue(value.source)], ['23514', '23505']);
    };
    for (const change of [
      value => { delete value.command.expected_revision; },
      value => { value.command.expected_revision = null; },
      value => { value.command.expected_revision = '8'; },
      value => { value.command.review_version = 2; },
      value => { delete value.command.row_decisions; },
      value => { value.command.row_decisions = {}; },
      value => {
        value.command.row_decisions = Array.from({ length: 101 }, () => structuredClone(value.command.row_decisions[0]));
        value.payload.row_decisions = Array.from({ length: 101 }, () => structuredClone(value.payload.row_decisions[0]));
      },
      value => { value.payload.row_decisions = []; },
      value => { value.payload.review_version = 2; },
      value => { value.payload.analysis_status = 'included'; },
      value => { value.payload.source_interpretation = {}; },
      value => { value.source = {}; },
      value => { value.payload.row_decisions[0].note = 'Different from command'; },
      value => { value.payload.row_decisions[0].record_data = originals[1].record_data; },
      value => { delete value.payload.row_decisions[0].record_data; },
      value => { delete value.payload.row_decisions[0].match_evidence; },
      value => { value.payload.row_decisions[0].match_evidence = true; },
      value => { value.command.row_decisions[0].source_row_number = 3; value.payload.row_decisions[0].source_row_number = 3; },
      value => { value.command.row_decisions[0].receipt_id = originals[1].receipt_id; value.payload.row_decisions[0].receipt_id = originals[1].receipt_id; },
      value => { value.command.row_decisions[0].source_row_number = null; value.payload.row_decisions[0].source_row_number = null; },
      value => { value.command.row_decisions[0].receipt_id = 'not-a-uuid'; value.payload.row_decisions[0].receipt_id = 'not-a-uuid'; },
      value => { value.command.row_decisions.push(structuredClone(value.command.row_decisions[0])); value.payload.row_decisions.push(structuredClone(value.payload.row_decisions[0])); },
      value => { value.badCommandHash = true; }, value => { value.badPayloadHash = true; },
      value => { value.revision = 10; value.command.expected_revision = 9; },
      value => { value.revision = 8; value.command.expected_revision = 7; },
      value => { value.batchId = randomUUID(); },
    ]) await badParent(change);
    const projectionSql = `INSERT INTO app.assignment_sales_import_review_rows
      (batch_id,review_id,revision,source_row_number,receipt_id,decision) VALUES($1,$2,$3,$4,$5,$6::jsonb)`;
    const projected = confirmations[0];
    for (const [reviewId, revision, sourceRow, receipt, value] of [
      [confirmed.review_id, 4, 3, originals[1].receipt_id, {}],
      [confirmed.review_id, 4, 3, originals[1].receipt_id, projected],
      [confirmed.review_id, 4, 3, originals[1].receipt_id, { ...projected, receipt_id: originals[1].receipt_id, source_row_number: 3 }],
      [first.review_id, 4, 3, originals[1].receipt_id, { ...projected, receipt_id: originals[1].receipt_id, source_row_number: 3 }],
      [confirmed.review_id, 4, 2, originals[1].receipt_id, projected],
      [confirmed.review_id, 4, 2, originals[0].receipt_id, projected],
    ]) await denied(projectionSql, [batchId, reviewId, revision, sourceRow, receipt, serializePreparedSalesValue(value)], ['23514', '23503', '23505']);
    for (const sql of [
      'UPDATE app.assignment_sales_import_reviews SET revision=revision WHERE batch_id=$1',
      'DELETE FROM app.assignment_sales_import_reviews WHERE batch_id=$1',
      'UPDATE app.assignment_sales_import_review_rows SET revision=revision WHERE batch_id=$1',
      'DELETE FROM app.assignment_sales_import_review_rows WHERE batch_id=$1',
    ]) await denied(sql, [batchId], ['55000']);
    await denied('TRUNCATE app.assignment_sales_import_reviews,app.assignment_sales_import_review_rows', [], ['55000']);
  });
  assert.deepEqual(await count(), { reviews: 8, projections: 4 });
  assert.deepEqual(await protectedState(), protectedBefore);
  assert.deepEqual((await state(pool, request)).source_interpretation, unknown);
  checks.push('native direct SQL rejects subset/foreign projection, malformed or mismatched command/payload/original row, revision gaps, bad hashes and review mutation');
  return { checks, malformed_sql_cases: attacks, committed_reviews: 8, committed_projection_rows: 4,
    source_and_report_unchanged: true, review_not_analysis_admission: true };
}
