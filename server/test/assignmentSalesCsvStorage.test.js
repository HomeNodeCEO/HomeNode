import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeAssignmentSalesImportAccess, commitAssignmentSalesImport,
  getAssignmentSalesImportByOperation as get } from '../src/services/assignmentSalesCsv/storage.js';

const actor = '11111111-1111-4111-8111-111111111111', org = '22222222-2222-4222-8222-222222222222';
const input = () => ({ auth: { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] },
  accountId: 'SYNTHETIC-CSV', assignmentFileId: '10', reportFileId: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444', fileName: 'synthetic.csv',
  content: Buffer.from('ListingId,CloseDate,CurrentPrice\nSYNTHETIC,2024-01-01,200000') });
function pool({ initial = 'I', beforeConnect, beforeQuery, releaseFailure } = {}) {
  let state = initial;
  const sql = [], releases = [];
  return { sql, releases, async connect() {
    beforeConnect?.();
    return { getTransactionStatus: () => state, release(error) {
      releases.push(error); if (releaseFailure) throw new Error('private driver text');
    }, async query(config) {
      const text = typeof config === 'string' ? config : config.text;
      sql.push(text); beforeQuery?.(text);
      if (text.startsWith('BEGIN')) state = 'T';
      if (text === 'ROLLBACK' || text === 'COMMIT') state = 'I';
      if (text.includes('assignment-sales:scope')) return { rows: [{ organization_id: org,
        assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null, account_id: 'SYNTHETIC-CSV',
        status: 'draft', signed_at: null, has_signed_snapshot: false }] };
      return { rows: [] };
    } };
  } };
}
const code = suffix => ({ code: `assignment_sales_import_${suffix}` });

test('private CSV service refuses anonymous or malformed targets before connecting', async () => {
  const db = pool();
  await assert.rejects(get(db, { ...input(), auth: null }), { code: 'authentication_required' });
  for (const bad of [{ assignmentFileId: 9007199254740992 }, { assignmentFileId: '01' },
    { assignmentFileId: '9223372036854775808' }, { reportFileId: '' }, { accountId: '' }]) {
    await assert.rejects(get(db, { ...input(), ...bad }), code('invalid_input'));
  }
  assert.equal(db.sql.length, 0);
});

for (const initial of ['T', 'E', undefined, 'unexpected']) {
  test(`private CSV refuses inherited transaction state ${String(initial)}`, async () => {
    const db = pool({ initial: initial === undefined ? null : initial });
    await assert.rejects(get(db, input()), code('transaction_state'));
    assert.ok(db.sql.every(sql => sql === 'ROLLBACK'), 'never BEGIN/COMMIT an inherited transaction');
    assert.equal(db.releases.length, 1); assert.ok(db.releases[0]);
  });
}

test('private CSV reads detach authorization before asynchronous connection acquisition', async () => {
  const request = input();
  const db = pool({ beforeConnect() { request.auth.userId = request.reportFileId;
    request.auth.organizations[0].roles.length = 0; } });
  assert.equal(await get(db, request), null);
  assert.equal(db.releases[0], undefined);
  assert.ok(db.sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});

test('private CSV lookup sanitizes database failures and rolls back', async () => {
  const db = pool({ beforeQuery(sql) { if (sql.includes('assignment-sales:scope')) {
    throw Object.assign(new Error('secret database statement and values'), { code: '42P01' });
  } } });
  await assert.rejects(get(db, input()), error => {
    assert.equal(error.message, 'assignment_sales_import_failed'); return true;
  });
  assert.equal(db.sql.at(-1), 'ROLLBACK'); assert.ok(db.releases[0]);
});

test('private CSV preserves uncertainty for COMMIT transport and post-COMMIT release failures', async () => {
  for (const options of [{ beforeQuery(sql) { if (sql === 'COMMIT') throw Object.assign(new Error('lost'), { code: '08006' }); } },
    { releaseFailure: true }]) {
    await assert.rejects(get(pool(options), input()), code('commit_unknown'));
  }
});

test('private CSV input rejects path/control filenames and write-less roles', async () => {
  for (const fileName of ['', '../sales.csv', 'folder\\sales.csv', 'name\r\n.csv', 'name\u0085.csv']) {
    await assert.rejects(commitAssignmentSalesImport(pool(), { ...input(), fileName }), code('invalid_input'));
  }
  const request = input(); request.auth.organizations[0].roles = ['read_only'];
  await assert.rejects(commitAssignmentSalesImport(pool(), request), code('access_denied'));
  await assert.rejects(authorizeAssignmentSalesImportAccess(pool(), input(), 'sign'), code('invalid_input'));
});
