import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createAssignmentSalesImportRouter } from '../src/modules/assignmentFiles/salesImportRouter.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';

const reportId = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000002';
const batchId = '30000000-0000-4000-8000-000000000003';
const identity = { userId: '40000000-0000-4000-8000-000000000004', organizations: [] };
const base = '/api/accounts/001A-42/assignment-files/7/sales-imports';
const query = `?report_file_id=${reportId}`;
const csv = Buffer.from('ListingId,CloseDate,ClosePrice,MlsStatus\r\nABC-1,1/2/2020,250000,Closed\r\n');
const receipt = { batch_id: batchId, operation_id: operationId, persisted: true, replayed: false,
  matching_status: 'not_evaluated', analysis_status: 'not_evaluated' };
const codeError = code => Object.assign(new Error('sensitive database or source details'), { code });
const scope = { auth: identity, accountId: '001A-42', assignmentFileId: '7', reportFileId: reportId };

function headers(extra = {}) {
  return { 'content-type': 'text/csv', 'idempotency-key': operationId,
    'x-document-file-name': encodeURIComponent('Historical sales.csv'), ...extra };
}

async function fixture(context, { auth = identity, services = {}, mutateRequest, queryParser = 'extended',
  upstreamMiddleware, downstreamErrorHandler } = {}) {
  const calls = [];
  const pool = { connect: async () => { throw new Error('test must not open a database'); } };
  let currentRequest;
  const record = (name, result) => async (receivedPool, input, permission) => {
    assert.equal(receivedPool, pool);
    calls.push({ name, input, permission, body: currentRequest.body, ended: currentRequest.readableEnded });
    if (services[name]) return services[name](input, permission, currentRequest);
    return result;
  };
  const options = {
    pool,
    authorizeAccess: record('authorizeAccess', undefined),
    commitImport: record('commitImport', receipt),
    getImport: record('getImport', receipt),
    getTarget: record('getTarget', { account_id: '001A-42', assignment_file_id: '7', report_file_id: reportId,
      workfile_status: 'draft', can_upload: true }),
    listRows: record('listRows', { batch_id: batchId, rows: [], next_after_row: null }),
    listImports: record('listImports', { imports: [], next_before_batch_id: null }),
    getMatchProposals: record('getMatchProposals', { rows: [], accepted: false, matching_status: 'proposal_only' }),
  };
  const app = express();
  app.set('query parser', queryParser);
  app.use((req, _res, next) => {
    req.mobileAuth = auth;
    currentRequest = req;
    mutateRequest?.(req);
    next();
  });
  // Match the production parser budget; text/csv must not be consumed here.
  app.use(express.json({ limit: '1mb' }));
  if (upstreamMiddleware) app.use(upstreamMiddleware);
  app.use(createAssignmentSalesImportRouter(options));
  if (downstreamErrorHandler) app.use(downstreamErrorHandler);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  context.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, options,
    request: (path = base + query, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init) };
}

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: code });
}

test('constructor requires the storage connection interface and every injected service', () => {
  assert.throws(() => createAssignmentSalesImportRouter(), /assignment_sales_import_pool_required/);
  for (const name of ['authorizeAccess', 'commitImport', 'getImport', 'getTarget', 'listRows', 'listImports', 'getMatchProposals']) {
    assert.throws(() => createAssignmentSalesImportRouter({ pool: { connect() {} }, [name]: null }),
      /assignment_sales_import_router_dependency_required/);
  }
});

test('upload authorizes exact immutable metadata before raw parsing and returns only the committed receipt', async t => {
  const f = await fixture(t);
  const response = await f.request(undefined, { method: 'POST', headers: headers(), body: csv });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), receipt);
  assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess', 'commitImport']);
  assert.deepEqual(f.calls[0].input, { ...scope, operationId, fileName: 'Historical sales.csv' });
  assert.ok(Object.isFrozen(f.calls[0].input));
  assert.equal(f.calls[0].permission, 'write');
  assert.equal(Buffer.isBuffer(f.calls[0].body), false);
  assert.equal(f.calls[0].ended, false);
  assert.deepEqual(f.calls[1].input, { ...scope, operationId, fileName: 'Historical sales.csv', content: csv });
});

test('a replay returns the original receipt with 200 instead of reporting a new commit', async t => {
  const f = await fixture(t, { services: { commitImport: async () => ({ ...receipt, replayed: true }) } });
  const response = await f.request(undefined, { method: 'POST', headers: headers(), body: csv });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...receipt, replayed: true });
});

test('text/csv larger than the global JSON limit arrives unchanged and UTF-8 charset is supported', async t => {
  const content = Buffer.alloc(1024 * 1024 + 17, 'a');
  const f = await fixture(t);
  const response = await f.request(undefined, { method: 'POST', headers: headers({ 'content-type': 'text/csv; charset="UTF-8"' }), body: content });
  assert.equal(response.status, 201);
  assert.deepEqual(f.calls[1].input.content, content);
});

test('the full 8 MiB raw limit is accepted without a smaller adaptive cap', async t => {
  const f = await fixture(t);
  const response = await f.request(undefined, { method: 'POST', headers: headers(), body: Buffer.alloc(8388608, 'a') });
  assert.equal(response.status, 201);
  assert.equal(f.calls.at(-1).input.content.length, 8388608);
});

test('oversize raw uploads return 413 after authorization but before commit', async t => {
  const f = await fixture(t);
  await expectError(await f.request(undefined, { method: 'POST', headers: headers(), body: Buffer.alloc(8388609, 'a') }),
    413, 'assignment_sales_csv_file_byte_limit');
  assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess']);
});

test('denied access wins before parsing an oversize or compressed upload', async t => {
  const f = await fixture(t, { services: { authorizeAccess: async () => { throw codeError('assignment_sales_import_access_denied'); } } });
  await expectError(await f.request(undefined, { method: 'POST', headers: headers({ 'content-encoding': 'gzip' }),
    body: Buffer.alloc(8388609, 'a') }), 403, 'assignment_sales_import_access_denied');
  assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess']);
  assert.equal(Buffer.isBuffer(f.calls[0].body), false);
});

test('authorization must settle before compressed body validation or storage begins', async t => {
  let entered, rejectAccess;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise((_resolve, reject) => { rejectAccess = reject; });
  const f = await fixture(t, { services: { authorizeAccess: async () => { entered(); await gate; } } });
  const response = f.request(undefined, { method: 'POST', headers: headers({ 'content-encoding': 'gzip' }), body: csv });
  await enteredPromise;
  assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess']);
  assert.equal(f.calls[0].ended, false);
  rejectAccess(codeError('assignment_sales_import_access_denied'));
  await expectError(await response, 403, 'assignment_sales_import_access_denied');
});

test('all endpoints require an authenticated user without a development-mode bypass', async t => {
  const f = await fixture(t, { auth: null });
  for (const path of [base + query, `${base}/target`, `${base}/operations/${operationId}${query}`, `${base}/${batchId}/rows${query}`,
    `${base}/${batchId}/match-proposals${query}`]) {
    await expectError(await f.request(path), 401, 'authentication_required');
  }
  await expectError(await f.request(undefined, { method: 'POST', headers: headers(), body: csv }), 401, 'authentication_required');
  assert.equal(f.calls.length, 0);
});

test('target bootstrap passes only the existing account and assignment to its authorized reader', async t => {
  const f = await fixture(t);
  const response = await f.request(`${base}/target`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).report_file_id, reportId);
  assert.deepEqual(f.calls.map(call => call.name), ['getTarget']);
  assert.deepEqual(f.calls[0].input, { auth: identity, accountId: '001A-42', assignmentFileId: '7' });
  assert.ok(Object.isFrozen(f.calls[0].input));
});

test('matching proposals preserve exact report/batch/page scope and do not invoke a write service', async t => {
  const f = await fixture(t);
  const response = await f.request(`${base}/${batchId}/match-proposals${query}&after_row=51&limit=25`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { rows: [], accepted: false, matching_status: 'proposal_only' });
  assert.deepEqual(f.calls.map(call => call.name), ['getMatchProposals']);
  assert.deepEqual(f.calls[0].input, { ...scope, batchId, afterRow: 51, limit: 25 });
  assert.ok(Object.isFrozen(f.calls[0].input));
});

test('matching proposals reject invalid bounds, alternate scopes and hidden server errors', async t => {
  const f = await fixture(t, { services: { getMatchProposals: () => { throw new Error('sensitive CAD source'); } } });
  for (const suffix of ['&limit=0', '&limit=101', '&after_row=-1', '&after_row=10002', '&after_row[]=2',
    '&organization_id=foreign', '&accepted=true', '&limit=5&limit=6']) {
    await expectError(await f.request(`${base}/${batchId}/match-proposals${query}${suffix}`),
      400, 'assignment_sales_import_invalid_input');
  }
  assert.equal(f.calls.length, 0);
  await expectError(await f.request(`${base}/${batchId}/match-proposals${query}`), 500, 'assignment_sales_import_failed');
});

test('bootstrap cannot accept a caller-supplied report or arbitrary query scope', async t => {
  const f = await fixture(t);
  for (const suffix of [query, '?organization_id=other', '?report_file_id[]=bad']) {
    await expectError(await f.request(`${base}/target${suffix}`), 400, 'assignment_sales_import_invalid_input');
  }
  assert.equal(f.calls.length, 0);
});

test('list forwards only the exact scope and optional UUID cursor', async t => {
  const f = await fixture(t);
  const response = await f.request(`${base}${query}&before_batch_id=${batchId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imports: [], next_before_batch_id: null });
  assert.deepEqual(f.calls.map(call => call.name), ['listImports']);
  assert.deepEqual(f.calls[0].input, { ...scope, beforeBatchId: batchId });
});

test('operation recovery returns the exact receipt and missing receipts return 404', async t => {
  const f = await fixture(t, { services: { getImport: async input => input.operationId === operationId ? receipt : null } });
  const response = await f.request(`${base}/operations/${operationId}${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), receipt);
  assert.deepEqual(f.calls[0].input, { ...scope, operationId });
  await expectError(await f.request(`${base}/operations/${batchId}${query}`), 404, 'assignment_sales_import_not_found');
});

test('row pages use bounded defaults and explicit exact cursors', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`${base}/${batchId}/rows${query}`)).status, 200);
  assert.deepEqual(f.calls[0].input, { ...scope, batchId, afterRow: 0, limit: 50 });
  assert.equal((await f.request(`${base}/${batchId}/rows${query}&after_row=10001&limit=100`)).status, 200);
  assert.deepEqual(f.calls[1].input, { ...scope, batchId, afterRow: 10001, limit: 100 });
});

test('UUIDs normalize case without changing the canonical account or bigint assignment identity', async t => {
  const f = await fixture(t);
  const otherReport = 'a0000000-0000-4000-8000-00000000000b';
  const path = base.replace('/7/', '/9223372036854775807/') + `?report_file_id=${otherReport.toUpperCase()}`;
  assert.equal((await f.request(path)).status, 200);
  assert.equal(f.calls[0].input.reportFileId, otherReport);
  assert.equal(f.calls[0].input.assignmentFileId, '9223372036854775807');
  assert.equal(f.calls[0].input.accountId, '001A-42');
});

for (const suffix of ['', '?report_file_id=', '?report_file_id=null', '?report_file_id[]=x',
  `${query}&report_file_id=${reportId}`, `${query}&organization_id=other`, `${query}&report_file_id[x]=y`]) {
  test(`invalid or ambiguous report scope is rejected before service access: ${suffix || 'absent'}`, async t => {
    const f = await fixture(t);
    await expectError(await f.request(base + suffix), 400, 'assignment_sales_import_invalid_input');
    assert.equal(f.calls.length, 0);
  });
}

for (const suffix of ['&after_row=-1', '&after_row=10002', '&after_row=1.2', '&after_row=01',
  '&after_row=1e2', '&after_row[]=2', '&limit=0', '&limit=101', '&limit[]=1', '&limit=1&limit=2', '&other=x']) {
  test(`row pagination rejects malformed or excessive parameters: ${suffix}`, async t => {
    const f = await fixture(t);
    await expectError(await f.request(`${base}/${batchId}/rows${query}${suffix}`), 400, 'assignment_sales_import_invalid_input');
    assert.equal(f.calls.length, 0);
  });
}

test('invalid account, assignment and path UUID metadata never reaches storage', async t => {
  const f = await fixture(t);
  const paths = [base.replace('001A-42', '%20alias%20') + query, base.replace('001A-42', '%00') + query,
    base.replace('/7/', '/0/') + query, base.replace('/7/', '/07/') + query,
    base.replace('/7/', '/9223372036854775808/') + query, `${base}/operations/not-a-uuid${query}`,
    `${base}/bad/rows${query}`];
  for (const path of paths) await expectError(await f.request(path), 400, 'assignment_sales_import_invalid_input');
  assert.equal(f.calls.length, 0);
});

test('upload metadata rejects missing or malformed operation IDs and file names before access', async t => {
  const f = await fixture(t);
  for (const changes of [{ 'idempotency-key': undefined }, { 'idempotency-key': 'not-uuid' },
    { 'x-document-file-name': undefined }, { 'x-document-file-name': '%' }, { 'x-document-file-name': '%00.csv' },
    { 'x-document-file-name': '%C2%85.csv' }, { 'x-document-file-name': '..%2Fprivate.csv' },
    { 'x-document-file-name': '%5Cprivate.csv' }, { 'x-document-file-name': '%20%20' },
    { 'x-document-file-name': 'a'.repeat(256) }, { 'x-document-file-name': 'a'.repeat(3061) }]) {
    const inputHeaders = Object.fromEntries(Object.entries(headers(changes)).filter(([, value]) => value !== undefined));
    await expectError(await f.request(undefined, { method: 'POST', headers: inputHeaders, body: csv }),
      400, 'assignment_sales_import_invalid_input');
  }
  assert.equal(f.calls.length, 0);
});

test('duplicate upload identity/file-name headers fail closed rather than using joined values', async t => {
  const f = await fixture(t);
  for (const duplicate of ['Idempotency-Key', 'X-Document-File-Name']) {
    const headerPairs = ['Host', new URL(f.url).host, 'Content-Length', String(csv.length), ...Object.entries(headers()).flat()];
    headerPairs.push(duplicate, duplicate === 'Idempotency-Key' ? operationId : 'second.csv');
    const result = await new Promise((resolve, reject) => {
      const request = http.request(f.url + base + query, { method: 'POST', headers: headerPairs }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject);
      request.end(csv);
    });
    assert.deepEqual(result, { status: 400, body: { error: 'assignment_sales_import_invalid_input' } });
  }
  assert.equal(f.calls.length, 0);
});

for (const contentType of ['application/json', 'application/octet-stream', 'text/plain',
  'text/csv; charset=iso-8859-1', 'text/csv; header=present']) {
  test(`non-CSV or unsupported charset/content parameters return 415: ${contentType}`, async t => {
    const f = await fixture(t);
    await expectError(await f.request(undefined, { method: 'POST', headers: headers({ 'content-type': contentType }),
      body: contentType === 'application/json' ? JSON.stringify([{ report_file_id: 'attacker' }]) : csv }),
    415, 'assignment_sales_import_unsupported_media_type');
    assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess']);
  });
}

test('compressed uploads are rejected without decompression or commit', async t => {
  const f = await fixture(t);
  await expectError(await f.request(undefined, { method: 'POST', headers: headers({ 'content-encoding': 'gzip' }), body: csv }),
    415, 'assignment_sales_import_unsupported_encoding');
  assert.deepEqual(f.calls.map(call => call.name), ['authorizeAccess']);
});

test('literal CSV content cannot replace the route scope, actor, operation or filename', async t => {
  const f = await fixture(t);
  const maliciousText = Buffer.from('auth,accountId,assignmentFileId,reportFileId,operationId,fileName\nattacker,other,99,other,other,other.csv\n');
  assert.equal((await f.request(undefined, { method: 'POST', headers: headers(), body: maliciousText })).status, 201);
  assert.deepEqual(f.calls[1].input, { ...scope, operationId, fileName: 'Historical sales.csv', content: maliciousText });
});

test('actual CSV preparation errors return fixed 400 codes without echoing source content', async t => {
  const f = await fixture(t, { services: { commitImport: async input => { prepareAssignmentSalesCsv(input.content); return receipt; } } });
  for (const [content, code] of [[Buffer.from('ListingId,CloseDate,ClosePrice\n"PRIVATE'), 'malformed_csv'],
    [Buffer.from('private,unknown\nsecret,data'), 'unsupported_columns'], [Buffer.from([0xff]), 'invalid_utf8'],
    [Buffer.from('header\0'), 'nul_byte']]) {
    await expectError(await f.request(undefined, { method: 'POST', headers: headers(), body: content }),
      400, `assignment_sales_csv_${code}`);
  }
});

for (const [code, status] of [['assignment_sales_import_read_only', 409], ['assignment_sales_import_operation_conflict', 409],
  ['assignment_sales_import_busy', 503], ['assignment_sales_import_commit_unknown', 503],
  ['assignment_sales_import_access_denied', 403], ['assignment_sales_import_not_found', 404],
  ['assignment_sales_import_preparation_limit', 413], ['assignment_sales_csv_row_limit', 400]]) {
  test(`known failure returns only its fixed allowlisted status/code: ${code}`, async t => {
    const f = await fixture(t, { services: { commitImport: async () => { throw codeError(code); } } });
    await expectError(await f.request(undefined, { method: 'POST', headers: headers(), body: csv }), status, code);
  });
}

test('unrecognized service and database errors never escape through code or message', async t => {
  const f = await fixture(t, { services: { listImports: async () => { throw codeError('assignment_sales_import_secret_connection_url'); } } });
  await expectError(await f.request(), 500, 'assignment_sales_import_failed');
  assert.deepEqual(f.calls.map(call => call.name), ['listImports']);
});

test('each read owner can deny access without a redundant preflight transaction or fallback', async t => {
  const deny = async () => { throw codeError('assignment_sales_import_access_denied'); };
  const f = await fixture(t, { services: { listImports: deny, getImport: deny, listRows: deny } });
  for (const path of [base + query, `${base}/operations/${operationId}${query}`, `${base}/${batchId}/rows${query}`]) {
    await expectError(await f.request(path), 403, 'assignment_sales_import_access_denied');
  }
  assert.deepEqual(f.calls.map(call => call.name), ['listImports', 'getImport', 'listRows']);
});

test('target bootstrap access denial remains private and does not fall back to a report listing', async t => {
  const f = await fixture(t, { services: { getTarget: async () => { throw codeError('assignment_sales_import_access_denied'); } } });
  await expectError(await f.request(`${base}/target`), 403, 'assignment_sales_import_access_denied');
  assert.deepEqual(f.calls.map(call => call.name), ['getTarget']);
});

test('unrelated upstream and global JSON errors pass through the CSV router unchanged', async t => {
  const upstream = Object.assign(new Error('original document handler failure'), { status: 409 });
  const forwarded = [];
  const f = await fixture(t, {
    upstreamMiddleware: (req, _res, next) => req.path === '/outside-csv' ? next(upstream) : next(),
    downstreamErrorHandler: (error, _req, res, _next) => {
      forwarded.push(error);
      res.status(error.status || 500).json({ original_handler: true });
    },
  });
  const documentError = await f.request('/outside-csv');
  assert.equal(documentError.status, 409);
  assert.deepEqual(await documentError.json(), { original_handler: true });
  assert.equal(documentError.headers.get('cache-control'), null);
  assert.equal(forwarded[0], upstream);
  const jsonError = await f.request('/unrelated-json', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(jsonError.status, 400);
  assert.deepEqual(await jsonError.json(), { original_handler: true });
  assert.equal(jsonError.headers.get('cache-control'), null);
  assert.equal(forwarded[1].type, 'entity.parse.failed');
  assert.equal(f.calls.length, 0);
});

test('the scoped CSV parser still sanitizes upload errors instead of forwarding them upstream', async t => {
  const forwarded = [];
  const f = await fixture(t, {
    downstreamErrorHandler: (error, _req, res, _next) => { forwarded.push(error); res.status(599).end(); },
    services: { commitImport: async input => { prepareAssignmentSalesCsv(input.content); return receipt; } },
  });
  await expectError(await f.request(undefined, {
    method: 'POST', headers: headers({ 'content-encoding': 'gzip' }), body: csv,
  }), 415, 'assignment_sales_import_unsupported_encoding');
  await expectError(await f.request(undefined, {
    method: 'POST', headers: headers(), body: 'ListingId,CloseDate,ClosePrice\n"incomplete',
  }), 400, 'assignment_sales_csv_malformed_csv');
  assert.equal(forwarded.length, 0);
});
