import express from 'express';
import { ASSIGNMENT_SALES_CSV_LIMITS } from '../../services/assignmentSalesCsv/parse.js';
import {
  authorizeAssignmentSalesImportAccess,
  commitAssignmentSalesImport,
  getAssignmentSalesImportByOperation,
  getAssignmentSalesImportTarget,
  getAssignmentSalesImportMatchProposals,
  listAssignmentSalesImportRows,
  listAssignmentSalesImports,
} from '../../services/assignmentSalesCsv/storage.js';

const BASE = '/api/accounts/:id/assignment-files/:assignmentFileId/sales-imports';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_INPUT = Symbol('assignment-sales-import-input');
const ERRORS = new Map([
  ['authentication_required', 401],
  ['assignment_sales_import_invalid_input', 400],
  ['assignment_sales_import_access_denied', 403],
  ['assignment_sales_import_not_found', 404],
  ['assignment_sales_import_read_only', 409],
  ['assignment_sales_import_operation_conflict', 409],
  ['assignment_sales_import_preparation_limit', 413],
  ['assignment_sales_import_unsupported_media_type', 415],
  ['assignment_sales_import_unsupported_encoding', 415],
  ['assignment_sales_import_busy', 503],
  ['assignment_sales_import_commit_unknown', 503],
  ['assignment_sales_csv_file_byte_limit', 413],
  ...['invalid_input', 'invalid_utf8', 'nul_byte', 'field_byte_limit', 'malformed_csv',
    'row_limit', 'column_limit', 'cell_limit', 'invalid_header', 'duplicate_header',
    'missing_header', 'unsupported_columns'].map(code => [`assignment_sales_csv_${code}`, 400]),
]);
const invalid = () => Object.assign(new Error('assignment_sales_import_invalid_input'),
  { code: 'assignment_sales_import_invalid_input' });
const fail = code => { throw Object.assign(new Error(code), { code }); };

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value.toLowerCase();
}

function closedQuery(query, allowed) {
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => !allowed.includes(key) || typeof query[key] !== 'string')) throw invalid();
}

function integer(value, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,4})$/.test(value)) throw invalid();
  const number = Number(value);
  if (number < min || number > max) throw invalid();
  return number;
}

function oneHeader(req, name) {
  const count = req.rawHeaders.reduce((total, value, index) =>
    total + (index % 2 === 0 && value.toLowerCase() === name ? 1 : 0), 0);
  const value = req.get(name);
  if (count !== 1 || typeof value !== 'string') throw invalid();
  return value;
}

function uploadMetadata(req) {
  const operationId = uuid(oneHeader(req, 'idempotency-key'));
  const encoded = oneHeader(req, 'x-document-file-name');
  if (encoded.length > 3060) throw invalid();
  let fileName;
  try { fileName = decodeURIComponent(encoded); } catch { throw invalid(); }
  if (!fileName.trim() || fileName.length > 255 || /[\p{Cc}\\/]/u.test(fileName)) throw invalid();
  return { operationId, fileName };
}

function scope(req, queryKeys, needsReport = true) {
  if (!req.mobileAuth?.userId) fail('authentication_required');
  closedQuery(req.query, [...(needsReport ? ['report_file_id'] : []), ...queryKeys]);
  const accountId = req.params.id;
  const assignmentFileId = req.params.assignmentFileId;
  if (typeof accountId !== 'string' || !accountId || accountId.length > 128
    || accountId !== accountId.trim() || /\p{Cc}/u.test(accountId)
    || typeof assignmentFileId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(assignmentFileId)
    || BigInt(assignmentFileId) > 9223372036854775807n) throw invalid();
  return { auth: req.mobileAuth, accountId, assignmentFileId,
    ...(needsReport ? { reportFileId: uuid(req.query.report_file_id) } : {}) };
}

function errorResponse(error, res) {
  let code = error?.code;
  if (error?.type === 'entity.too.large') code = 'assignment_sales_csv_file_byte_limit';
  else if (error?.type === 'encoding.unsupported') code = 'assignment_sales_import_unsupported_encoding';
  else if (['request.aborted', 'request.size.invalid', 'entity.parse.failed'].includes(error?.type)
    || error instanceof URIError) code = 'assignment_sales_import_invalid_input';
  if (!ERRORS.has(code)) code = 'assignment_sales_import_failed';
  return res.set('Cache-Control', 'no-store').status(ERRORS.get(code) || 500).json({ error: code });
}

export function createAssignmentSalesImportRouter({
  pool,
  authorizeAccess = authorizeAssignmentSalesImportAccess,
  commitImport = commitAssignmentSalesImport,
  getImport = getAssignmentSalesImportByOperation,
  getTarget = getAssignmentSalesImportTarget,
  listRows = listAssignmentSalesImportRows,
  listImports = listAssignmentSalesImports,
  getMatchProposals = getAssignmentSalesImportMatchProposals,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('assignment_sales_import_pool_required');
  if ([authorizeAccess, commitImport, getImport, getTarget, listRows, listImports, getMatchProposals].some(fn => typeof fn !== 'function')) {
    throw new TypeError('assignment_sales_import_router_dependency_required');
  }
  const router = express.Router();
  router.use(BASE, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const action = callback => async (req, res) => {
    try { await callback(req, res); } catch (error) { errorResponse(error, res); }
  };

  router.get(`${BASE}/target`, action(async (req, res) => {
    // Bootstrap resolves only an existing, read-authorized exact target. It
    // neither creates a report nor picks the latest report for this account.
    res.json(await getTarget(pool, Object.freeze(scope(req, [], false))));
  }));

  router.get(BASE, action(async (req, res) => {
    const input = scope(req, ['before_batch_id']);
    if (req.query.before_batch_id !== undefined) input.beforeBatchId = uuid(req.query.before_batch_id);
    // Read owners authorize inside their own scoped transaction; a second
    // preflight here would add a round trip without extending that authority.
    res.json(await listImports(pool, Object.freeze(input)));
  }));

  router.get(`${BASE}/operations/:operationId`, action(async (req, res) => {
    const input = Object.freeze({ ...scope(req, []), operationId: uuid(req.params.operationId) });
    const receipt = await getImport(pool, input);
    if (receipt === null) fail('assignment_sales_import_not_found');
    res.json(receipt);
  }));

  router.get(`${BASE}/:batchId/rows`, action(async (req, res) => {
    const input = Object.freeze({ ...scope(req, ['after_row', 'limit']), batchId: uuid(req.params.batchId),
      afterRow: integer(req.query.after_row, 0, 0, 10001), limit: integer(req.query.limit, 50, 1, 100) });
    res.json(await listRows(pool, input));
  }));

  router.get(`${BASE}/:batchId/match-proposals`, action(async (req, res) => {
    const input = Object.freeze({ ...scope(req, ['after_row', 'limit']), batchId: uuid(req.params.batchId),
      afterRow: integer(req.query.after_row, 0, 0, 10001), limit: integer(req.query.limit, 50, 1, 100) });
    res.json(await getMatchProposals(pool, input));
  }));

  router.post(BASE, async (req, res, next) => {
    try {
      const input = Object.freeze({ ...scope(req, []), ...uploadMetadata(req) });
      // Authorize before the upload parser can buffer the file. The storage
      // owner repeats authorization under its signing/ownership locks.
      await authorizeAccess(pool, input, 'write');
      if (!req.get('content-type')) fail('assignment_sales_import_unsupported_media_type');
      const contentType = oneHeader(req, 'content-type');
      if (!/^text\/csv(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(contentType)) {
        fail('assignment_sales_import_unsupported_media_type');
      }
      res.locals[REQUEST_INPUT] = input;
      next();
    } catch (error) { errorResponse(error, res); }
  }, express.raw({ type: 'text/csv', limit: ASSIGNMENT_SALES_CSV_LIMITS.maxFileBytes, inflate: false }),
  action(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) fail('assignment_sales_csv_invalid_input');
    const receipt = await commitImport(pool, Object.freeze({ ...res.locals[REQUEST_INPUT], content: req.body }));
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  }));

  router.use(BASE, (error, _req, res, _next) => errorResponse(error, res));
  return router;
}
