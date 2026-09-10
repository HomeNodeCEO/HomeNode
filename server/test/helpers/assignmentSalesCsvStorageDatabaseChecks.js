import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { prepareAssignmentSalesCsv } from '../../src/services/assignmentSalesCsv/prepare.js';
import { serializePreparedSalesValue } from '../../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { prepareAssignmentSalesMatchCandidatesFixture, runAssignmentSalesMatchCandidatesDatabaseChecks } from './assignmentSalesMatchCandidatesDatabaseChecks.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const headers = ['ListingId', 'CloseDate', 'CurrentPrice', 'Address'];
const quote = value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csv = rows => Buffer.from('\ufeff' + [headers, ...rows].map(row => row.map(quote).join(',')).join('\r\n'));
const sample = () => csv([
  ['A', '2024-03-01', '275000', 'Synthetic café\r\nSecond line'],
  ['A', '2024-03-01', '275000', 'Synthetic café\r\nSecond line'],
  ['B', '2024-03-02', '280000', 'Synthetic second'],
  ['B', '2024-03-02', '285000', 'Synthetic second'],
  ['C', 'not-a-date', 'bad', 'Synthetic third'], ['', '', '', ''], ['bad', 'shape'],
]);
const errorCode = code => error => { assert.equal(error.code, code); return true; };

/** Import-safe. The caller supplies a newly migrated disposable loopback test
 * database. Only fresh synthetic orgs/actors/assignments and their private rows
 * are written; no shared sales, providers, cleanup deletes, DROP or services.
 */
export async function runAssignmentSalesCsvStorageDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { default: pg } = await import('pg');
  const { commitAssignmentSalesImport: commit, getAssignmentSalesImportByOperation: get,
    listAssignmentSalesImportRows: page, getAssignmentSalesImportTarget: getTarget,
    listAssignmentSalesImports: list, getAssignmentSalesImportMatchProposals: propose } = await import('../../src/services/assignmentSalesCsv/storage.js');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 5, connectionTimeoutMillis: 3000,
    statement_timeout: 10000, application_name: 'synthetic_assignment_sales_csv_native' });
  const checks = [];
  const ownedTransaction = async action => {
    const client = await pool.connect(); let problem;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='1500ms'; SET LOCAL timezone='UTC'");
      return await action(client);
    } catch (error) { problem = error; throw error; }
    finally {
      try { if (['T', 'E'].includes(client.getTransactionStatus())) await client.query('ROLLBACK'); }
      catch (error) { problem = error; }
      finally { client.release(problem); }
    }
  };
  const tracedPool = ({ before, after } = {}) => ({ async connect() {
    const client = await pool.connect();
    return { getTransactionStatus: () => client.getTransactionStatus(), release: error => client.release(error),
      async query(config, values) {
        const text = typeof config === 'string' ? config : config.text;
        await before?.({ text, client });
        const result = await client.query(config, values);
        await after?.({ text, client, result }); return result;
      } };
  } });
  try {
    const probe = await pool.connect();
    try {
      verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
        probe.connection?.stream?.remoteAddress, target.databaseName);
      assert.equal((await probe.query('SELECT count(*)::int AS count FROM app.assignment_sales_import_batches')).rows[0].count, 0,
        'This helper refuses a database with existing private import batches');
      assert.equal((await probe.query('SELECT count(*)::int AS count FROM app.assignment_sales_import_rows')).rows[0].count, 0);
    } finally { probe.release(); }
    const orgs = [randomUUID(), randomUUID()], actors = Array.from({ length: 4 }, () => randomUUID());
    for (const id of orgs) await pool.query(`INSERT INTO app_auth.organizations(id,legal_name,display_name)
      VALUES($1,'Synthetic private CSV native','Synthetic private CSV native')`, [id]);
    for (const id of actors) await pool.query(`INSERT INTO app_auth.users(id,email,display_name)
      VALUES($1,$2,'Synthetic private CSV actor')`, [id, `${id}@example.test`]);
    const accountId = `CSV-SYNTHETIC-${randomUUID()}`;
    await pool.query("INSERT INTO core.accounts(account_id,county,address) VALUES($1,'Synthetic','Private CSV fixture only')", [accountId]);
    const auth = (userId, organizationId, roles) => ({ userId, organizations: [{ organizationId, roles }] });
    const appraiser = auth(actors[0], orgs[0], ['appraiser']);
    const reader = auth(actors[1], orgs[0], ['read_only']);
    const unassigned = auth(actors[2], orgs[0], ['appraiser']);
    const assistant = auth(actors[1], orgs[0], ['office_assistant']);
    const foreign = auth(actors[3], orgs[1], ['appraiser']);
    const targets = [];
    for (const [index, organizationId] of [orgs[0], orgs[0], orgs[1], orgs[0]].entries()) {
      const actor = index === 2 ? actors[3] : actors[0], appraisalCase = randomUUID(), snapshot = randomUUID(), reportId = randomUUID();
      await pool.query(`INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date)
        VALUES($1,$2,$3,'2026-09-10')`, [appraisalCase, organizationId, accountId]);
      await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
        VALUES($1,$2,1,'2026-09-10','{"synthetic_private_csv_fixture_only":true}')`, [snapshot, appraisalCase]);
      const assignment = (await pool.query(`INSERT INTO app.assignment_files
        (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
        VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [organizationId, accountId, `CSV-${randomUUID()}`, actor])).rows[0].id;
      await pool.query(`INSERT INTO app.report_files
        (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
        VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [reportId, organizationId, accountId, `CSV-${randomUUID()}`, assignment, appraisalCase, snapshot]);
      await pool.query(`INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name)
        VALUES($1,$2)`, [assignment, `synthetic-csv-${randomUUID()}`]);
      targets.push({ auth: index === 2 ? foreign : appraiser, accountId, assignmentFileId: assignment, reportFileId: reportId });
    }
    const [scope, sibling, foreignScope, inconsistentSignedScope] = targets;
    const protectedState = async () => ({
      assignment: (await pool.query('SELECT to_jsonb(a) AS value FROM app.assignment_files a WHERE id=$1', [scope.assignmentFileId])).rows,
      report: (await pool.query('SELECT to_jsonb(r) AS value FROM app.report_files r WHERE id=$1', [scope.reportFileId])).rows,
      workfile: (await pool.query('SELECT to_jsonb(w) AS value FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1', [scope.assignmentFileId])).rows,
      sections: (await pool.query('SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1 ORDER BY section_key', [scope.assignmentFileId])).rows,
      history: (await pool.query('SELECT to_jsonb(h) AS value FROM app.custom_appraisal_workfile_section_history h WHERE assignment_file_id=$1 ORDER BY id', [scope.assignmentFileId])).rows,
      signed: (await pool.query('SELECT to_jsonb(s) AS value FROM app.custom_appraisal_signed_snapshots s WHERE assignment_file_id=$1', [scope.assignmentFileId])).rows,
    });
    const originalProtected = await protectedState();
    const snapshotRows = async () => ({
      batches: (await pool.query('SELECT to_jsonb(b) AS value FROM app.assignment_sales_import_batches b ORDER BY batch_id')).rows,
      rows: (await pool.query('SELECT to_jsonb(r) AS value FROM app.assignment_sales_import_rows r ORDER BY batch_id,source_row_number')).rows,
    });
    const content = sample(), preparation = prepareAssignmentSalesCsv(content);
    assert.equal(preparation.row_count, 7);
    assert.deepEqual(preparation.rows.map(row => row.preparation_disposition),
      ['needs_review', 'duplicate', 'identity_conflict', 'identity_conflict', 'needs_review', 'empty', 'rejected']);
    const request = { ...scope, operationId: randomUUID(), fileName: 'synthetic-private-sales.csv', content };
    assert.deepEqual(await getTarget(pool, scope), { account_id: scope.accountId, assignment_file_id: scope.assignmentFileId,
      report_file_id: scope.reportFileId, workfile_status: 'draft', can_upload: true });
    assert.equal((await getTarget(pool, { ...scope, auth: reader })).can_upload, false);
    await assert.rejects(getTarget(pool, { ...scope, auth: foreign }), errorCode('assignment_sales_import_access_denied'));
    assert.equal(await get(pool, request), null);
    const receipt = await commit(pool, request);
    assert.equal(receipt.persisted, true); assert.equal(receipt.persistence_status, 'saved'); assert.equal(receipt.replayed, false);
    for (const [key, value] of Object.entries({ receipt_version: 1, operation_id: request.operationId, account_id: accountId,
      report_file_id: scope.reportFileId, assignment_file_id: scope.assignmentFileId, file_name: request.fileName,
      actor_user_id: actors[0], source_sha256: hash(content), source_byte_length: content.length, row_count: 7,
      preparation_profile: preparation.profile_id, preparation_version: 1, matching_status: 'not_evaluated',
      analysis_status: 'not_evaluated', source_interpretation_status: 'not_reviewed' })) assert.equal(receipt[key], value, key);
    assert.deepEqual(receipt.summary, preparation.summary); assert.deepEqual(receipt.columns, preparation.columns);
    assert.deepEqual(receipt.raw_headers, preparation.raw_headers); assert.equal(Object.hasOwn(receipt, 'source_bytes'), false);
    const stored = (await pool.query('SELECT * FROM app.assignment_sales_import_batches WHERE batch_id=$1', [receipt.batch_id])).rows[0];
    assert.deepEqual(stored.source_bytes, content); assert.equal(stored.source_sha256, hash(content));
    const { rows: preparedRows, ...header } = preparation;
    assert.deepEqual(stored.preparation_header, header);
    const digest = createHash('sha256');
    for (const value of [header, ...preparedRows]) {
      const json = serializePreparedSalesValue(value); digest.update(`${Buffer.byteLength(json)}:`).update(json);
    }
    assert.equal(receipt.preparation_sha256, digest.digest('hex'));
    const readAll = async (targetScope, batchId, limit) => {
      const rows = []; let afterRow = 0;
      for (let count = 0; count < 101; count++) {
        const result = await page(pool, { ...targetScope, batchId, afterRow, limit });
        assert.equal(result.batch_id, batchId); assert.ok(result.rows.length <= limit); rows.push(...result.rows);
        if (result.next_after_row === null) return rows;
        assert.equal(result.next_after_row, result.rows.at(-1).source_row_number); assert.ok(result.next_after_row > afterRow);
        afterRow = result.next_after_row;
      }
      assert.fail('Native paging must terminate within its declared row bound');
    };
    const rows = await readAll({ ...scope, auth: reader }, receipt.batch_id, 2);
    assert.equal(rows.length, 7); assert.equal(new Set(rows.map(row => row.receipt_id)).size, 7);
    rows.forEach((row, index) => assert.deepEqual(row, { ...preparedRows[index], receipt_id: row.receipt_id, persisted: true }));
    const { replayed, ...savedReceipt } = receipt;
    assert.deepEqual(await get(pool, { ...request, auth: reader }), savedReceipt);
    assert.equal(savedReceipt.integrity_status, 'verified');
    const alteredRead = tracedPool({ after: ({ text, result }) => {
      if (text.includes('assignment-sales:bounded-rows') && result.rows[0]?.record_data?.raw_cells) {
        result.rows[0].record_data.raw_cells[0] = 'Z';
      }
    } });
    await assert.rejects(get(alteredRead, request), errorCode('assignment_sales_import_invalid_receipt'));
    assert.deepEqual(await get(pool, request), savedReceipt, 'Altered returned content cannot verify solely by matching counts');
    checks.push('real authorized commit retains exact BOM/multiline UTF-8 bytes, framed preparation hash and every duplicate/conflict/rejected/empty row; read-role paging is complete');

    let before = await snapshotRows();
    assert.deepEqual(await commit(pool, request), { ...receipt, replayed: true });
    for (const changed of [{ fileName: 'different.csv' }, { content: Buffer.concat([content, Buffer.from('\r\n')]) }, { auth: assistant }]) {
      await assert.rejects(commit(pool, { ...request, ...changed }), errorCode('assignment_sales_import_operation_conflict'));
    }
    assert.deepEqual(await snapshotRows(), before);
    for (const deniedAuth of [reader, unassigned, foreign, auth(actors[0], orgs[0], [])]) {
      await assert.rejects(commit(pool, { ...request, auth: deniedAuth, operationId: randomUUID() }), errorCode('assignment_sales_import_access_denied'));
    }
    for (const deniedAuth of [unassigned, foreign]) {
      await assert.rejects(get(pool, { ...request, auth: deniedAuth }), errorCode('assignment_sales_import_access_denied'));
    }
    await assert.rejects(get(pool, { ...request, auth: null }), errorCode('authentication_required'));
    await assert.rejects(get(pool, { ...request, reportFileId: sibling.reportFileId }), errorCode('assignment_sales_import_access_denied'));
    assert.equal(await get(pool, { ...sibling, operationId: request.operationId }), null);
    await assert.rejects(page(pool, { ...sibling, batchId: receipt.batch_id }), errorCode('assignment_sales_import_not_found'));
    const otherReceipt = await commit(pool, { ...request, ...foreignScope });
    assert.notEqual(otherReceipt.batch_id, receipt.batch_id);
    await assert.rejects(page(pool, { ...scope, batchId: otherReceipt.batch_id }), errorCode('assignment_sales_import_not_found'));
    checks.push('same-operation replay is exact and actor-bound; read/write roles, unassigned users, organization/report/assignment scopes remain independent even for the same account');

    const bulkContent = csv(Array.from({ length: 205 }, (_, index) => [`S${index}`, '2024-03-01', '275000', 'Synthetic bulk']));
    const bulk = { ...request, operationId: randomUUID(), content: bulkContent };
    before = await snapshotRows(); let inserts = 0;
    const broken = tracedPool({ after: async ({ text }) => {
      if (text.includes('assignment-sales:insert-rows') && ++inserts === 2) throw new Error('synthetic_mid_batch_failure');
    } });
    await assert.rejects(commit(broken, bulk), errorCode('assignment_sales_import_failed'));
    assert.equal(inserts, 2); assert.deepEqual(await snapshotRows(), before);
    const bulkReceipt = await commit(pool, bulk);
    const bulkRows = await readAll(scope, bulkReceipt.batch_id, 100);
    assert.equal(bulkRows.length, 205); assert.deepEqual(bulkRows.map(row => row.source_row_number), Array.from({ length: 205 }, (_, i) => i + 2));
    let wrote = false, lost = false;
    const lostAck = tracedPool({ after: async ({ text }) => {
      if (text.includes('assignment-sales:insert-batch')) wrote = true;
      if (text === 'COMMIT' && wrote && !lost) { lost = true; throw new Error('synthetic_lost_durable_commit_ack'); }
    } });
    const uncertainRequest = { ...request, operationId: randomUUID() };
    const recovered = await commit(lostAck, uncertainRequest);
    assert.equal(lost, true); assert.equal(recovered.replayed, true);
    assert.equal((await get(pool, uncertainRequest)).batch_id, recovered.batch_id);
    checks.push('actual multi-chunk rollback removes parent and earlier rows; all205 rows persist on explicit retry; a lost durable COMMIT acknowledgement reopens exact operation once');

    const race = { ...request, operationId: randomUUID() };
    const outcomes = await Promise.allSettled([commit(pool, race), commit(pool, race)]);
    assert.ok(outcomes.some(result => result.status === 'fulfilled'));
    for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.code, 'assignment_sales_import_busy');
    const raced = await commit(pool, race); assert.equal(raced.replayed, true);
    for (const result of outcomes) if (result.status === 'fulfilled') assert.equal(result.value.batch_id, raced.batch_id);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.assignment_sales_import_batches WHERE operation_id=$1', [race.operationId])).rows[0].count, 1);
    const empty = await commit(pool, { ...request, operationId: randomUUID(), content: csv([]) });
    assert.equal(empty.row_count, 0); assert.equal(empty.persisted, true);
    assert.deepEqual(await page(pool, { ...scope, batchId: empty.batch_id }), { batch_id: empty.batch_id, rows: [], next_after_row: null });
    const longHeaders = [...headers, ...Array.from({ length: 100 }, (_, index) => `Source${index}` + 'x'.repeat(4000))];
    const headerOnly = Buffer.from(longHeaders.join(','));
    const recent = [];
    for (let index = 0; index < 6; index++) recent.push(await commit(pool, { ...request,
      operationId: randomUUID(), fileName: `synthetic-headers-${index}.csv`, content: headerOnly }));
    const listed = await list(pool, scope);
    assert.ok(listed.imports.length < 6, 'SQL header byte budget applies before returning a batch list');
    assert.equal(listed.imports[0].batch_id, recent.at(-1).batch_id, 'Newest committed upload is listed first');
    assert.ok(listed.imports.every(item => item.integrity_status === 'count_checked'));
    assert.equal(listed.next_before_batch_id, listed.imports.at(-1).batch_id);
    const nextListed = await list(pool, { ...scope, beforeBatchId: listed.next_before_batch_id });
    assert.ok(nextListed.imports.length > 0);
    assert.ok(nextListed.imports.every(item => !listed.imports.some(first => item.batch_id === first.batch_id)));
    assert.deepEqual(await list(pool, { ...scope, beforeBatchId: otherReceipt.batch_id }), { imports: [], next_before_batch_id: null });
    checks.push('competing same-operation writers converge on one immutable batch; a header-only CSV commits an explicit complete zero-row batch');

    // All destructive-looking guard probes are transactions on these exclusively
    // synthetic new tables and are rolled back even if a guard unexpectedly fails.
    before = await snapshotRows();
    const rejectsSql = async (sql, values, code) => ownedTransaction(async client => {
      await assert.rejects(client.query(sql, values), errorCode(code));
    });
    for (const relation of ['app.assignment_sales_import_batches', 'app.assignment_sales_import_rows']) {
      await rejectsSql(`UPDATE ${relation} SET batch_id=batch_id WHERE batch_id=$1`, [receipt.batch_id], '55000');
      await rejectsSql(`DELETE FROM ${relation} WHERE batch_id=$1`, [receipt.batch_id], '55000');
    }
    await rejectsSql('TRUNCATE app.assignment_sales_import_rows', [], '55000');
    await rejectsSql('TRUNCATE app.assignment_sales_import_batches,app.assignment_sales_import_rows', [], '55000');
    await rejectsSql(`INSERT INTO app.assignment_sales_import_rows(batch_id,source_row_number,record_data)
      VALUES($1,9,'{"source_row_number":9}')`, [receipt.batch_id], '23514');
    await rejectsSql(`INSERT INTO app.assignment_sales_import_rows(batch_id,source_row_number,record_data)
      VALUES($1,2,'{"source_row_number":2}')`, [receipt.batch_id], '23505');
    const batchColumns = ['batch_id', 'organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'actor_user_id',
      'operation_id', 'file_name', 'source_bytes', 'source_sha256', 'source_byte_length', 'preparation_profile',
      'preparation_version', 'preparation_sha256', 'preparation_header', 'row_count'];
    const clone = async (client, overrides = {}) => {
      const row = { ...stored, batch_id: randomUUID(), operation_id: randomUUID(), ...overrides };
      await client.query(`INSERT INTO app.assignment_sales_import_batches(${batchColumns.join(',')})
        VALUES(${batchColumns.map((_, index) => '$' + (index + 1)).join(',')})`, batchColumns.map(key => row[key]));
      return row.batch_id;
    };
    for (const overrides of [{ organization_id: orgs[1] }, { assignment_file_id: sibling.assignmentFileId },
      { report_file_id: foreignScope.reportFileId }, { actor_user_id: randomUUID() }]) {
      await ownedTransaction(client => assert.rejects(clone(client, overrides), errorCode('23503')));
    }
    for (const overrides of [{ source_sha256: '0'.repeat(64) }, { source_byte_length: content.length + 1 }, { file_name: 'bad\u0085name.csv' }]) {
      await ownedTransaction(client => assert.rejects(clone(client, overrides), errorCode('23514')));
    }
    for (const record of [{}, { source_row_number: '2' }, { source_row_number: 3 }]) await ownedTransaction(async client => {
      const id = await clone(client);
      await assert.rejects(client.query(`INSERT INTO app.assignment_sales_import_rows(batch_id,source_row_number,record_data)
        VALUES($1,2,$2::jsonb)`, [id, JSON.stringify(record)]), errorCode('23514'));
    });
    await ownedTransaction(async client => {
      await clone(client);
      await assert.rejects(client.query('COMMIT'), errorCode('23514'));
      // pg can reject on ErrorResponse just before consuming ReadyForQuery.
      // A read-only protocol barrier observes the completed transaction state.
      await client.query('SELECT 1');
      assert.equal(client.getTransactionStatus(), 'I', 'Failed deferred COMMIT ends the incomplete transaction');
    });
    assert.deepEqual(await snapshotRows(), before);
    checks.push('native immutable UPDATE/DELETE/TRUNCATE, late ordinal/duplicate guards, exact scope/actor FKs, byte hashes, closed ordinal JSON and deferred incomplete-COMMIT rejection');

    const siblingRequest = { ...request, ...sibling, operationId: randomUUID() };
    const siblingReceipt = await commit(pool, siblingRequest);
    await ownedTransaction(async signer => {
      await signer.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [sibling.assignmentFileId]);
      await assert.rejects(commit(pool, { ...siblingRequest, operationId: randomUUID() }), errorCode('assignment_sales_import_busy'));
    });
    // JSON preserves native submillisecond timestamps for exact restoration;
    // node-postgres Date decoding would round those values to milliseconds.
    const originalWorkfile = (await pool.query('SELECT to_jsonb(w) AS value FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1', [sibling.assignmentFileId])).rows[0].value;
    try {
      await pool.query(`UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp(),signed_by='Synthetic metadata gate only'
        WHERE assignment_file_id=$1`, [sibling.assignmentFileId]);
      await assert.rejects(commit(pool, { ...siblingRequest, operationId: randomUUID() }), errorCode('assignment_sales_import_read_only'));
      assert.equal((await get(pool, { ...siblingRequest, auth: reader })).batch_id, siblingReceipt.batch_id);
      assert.equal((await commit(pool, siblingRequest)).replayed, true, 'Existing exact operation can be acknowledged on a signed file without a new import');
    } finally {
      await pool.query(`UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,signed_by=$4,updated_at=$5
        WHERE assignment_file_id=$1`, [sibling.assignmentFileId, originalWorkfile.status, originalWorkfile.signed_at, originalWorkfile.signed_by, originalWorkfile.updated_at]);
    }
    assert.deepEqual((await pool.query('SELECT to_jsonb(w) AS value FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1', [sibling.assignmentFileId])).rows[0].value, originalWorkfile);
    // Deliberately inconsistent synthetic metadata, NOT a valid appraisal or
    // signature. The conservative existence gate must deny even a draft label.
    await pool.query(`INSERT INTO app.custom_appraisal_signed_snapshots
      (assignment_file_id,canonical_file_name,schema_version,snapshot,checksum_sha256,signed_by)
      VALUES($1,$2,1,'{"synthetic_metadata_gate_only":true,"not_an_appraisal_signature":true}',$3,'Synthetic metadata fixture only')`,
    [inconsistentSignedScope.assignmentFileId, `synthetic-invalid-signature-${randomUUID()}`, hash('synthetic-not-a-signature')]);
    await assert.rejects(commit(pool, { ...request, ...inconsistentSignedScope, operationId: randomUUID() }), errorCode('assignment_sales_import_read_only'));
    assert.deepEqual(await protectedState(), originalProtected);
    checks.push('actual signing workfile lock serializes import; signed and draft-plus-snapshot metadata deny new imports, while exact signed-file read/replay remains authorized; protected report state is untouched');
    let matchingFixture;
    await ownedTransaction(async client => {
      matchingFixture = await prepareAssignmentSalesMatchCandidatesFixture((sql, values) => client.query(sql, values),
        { databaseName: target.databaseName });
      await client.query('COMMIT'); // Retain only this new test database's synthetic cache fixtures.
    });
    let nativeMatching;
    await ownedTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      nativeMatching = await runAssignmentSalesMatchCandidatesDatabaseChecks((sql, values) => client.query(sql, values), matchingFixture);
    });
    const matchingContent = Buffer.from(['ListingId,CloseDate,ClosePrice,ParcelNumber,Address,City,County,PostalCode',
      `MATCH-1,2020-01-01,275000,${matchingFixture.accountId},${matchingFixture.addressKey},${matchingFixture.cityKey},Dallas,75001`,
      `MATCH-1,2020-01-01,275000,${matchingFixture.accountId},${matchingFixture.addressKey},${matchingFixture.cityKey},Dallas,75001`,
      `MATCH-2,2020-01-02,280000,${matchingFixture.nativeId},,,Collin,`,
    ].join('\n'));
    const matchingReceipt = await commit(pool, { ...scope, operationId: randomUUID(), fileName: 'synthetic-matching.csv', content: matchingContent });
    const sourceBefore = await snapshotRows(), protectedBefore = await protectedState();
    const observations = await propose(pool, { ...scope, batchId: matchingReceipt.batch_id, limit: 2 });
    assert.equal(observations.account_id, scope.accountId); assert.equal(observations.report_file_id, scope.reportFileId);
    assert.equal(observations.binding.preparation_sha256, matchingReceipt.preparation_sha256);
    assert.equal(observations.rows.length, 2); assert.equal(observations.next_after_row, 3);
    assert.deepEqual(observations.rows[0].proposed_account_ids, [matchingFixture.accountId]);
    assert.equal(observations.rows[0].proposal_status, 'proposed');
    assert.equal(observations.rows[1].proposal_status, 'review_required');
    assert.ok(observations.rows[1].reasons.includes('duplicate_source_row'));
    assert.equal(observations.accepted, false); assert.equal(observations.analysis_status, 'not_evaluated');
    const lastObservation = await propose(pool, { ...scope, auth: reader, batchId: matchingReceipt.batch_id, afterRow: 3, limit: 2 });
    assert.equal(lastObservation.rows.length, 1); assert.equal(lastObservation.next_after_row, null);
    assert.deepEqual(lastObservation.rows[0].proposed_account_ids, [matchingFixture.collinAccountId]);
    for (const denied of [{ ...scope, auth: foreign }, { ...scope, auth: unassigned }]) {
      await assert.rejects(propose(pool, { ...denied, batchId: matchingReceipt.batch_id }), errorCode('assignment_sales_import_access_denied'));
    }
    await assert.rejects(propose(pool, { ...sibling, batchId: matchingReceipt.batch_id }), errorCode('assignment_sales_import_not_found'));
    assert.deepEqual(await snapshotRows(), sourceBefore);
    assert.deepEqual(await protectedState(), protectedBefore);
    checks.push('actual indexed CAD candidate SQL and exact-owner proposal paging match native Dallas/Collin fixtures; duplicates and historical limitations retained, cross-tenant/assignment denied, original receipts/report untouched');
    return { checks, organizations: 2, assignment_targets: 4, original_rows: 7, multi_chunk_rows: 205,
      immutable_synthetic_rows_retained: true, protected_report_unchanged: true, native_matching: nativeMatching };
  } finally { await pool.end(); }
}
