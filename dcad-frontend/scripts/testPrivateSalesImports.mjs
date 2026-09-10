import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as api from '../src/features/neighborhood/privateSalesImports.ts';
import { prepareAssignmentSalesCsv } from '../../server/src/services/assignmentSalesCsv/prepare.js';
import { proposeAssignmentSalesMatchPage } from '../../server/src/services/assignmentSalesCsv/matchProposals.js';
import { createPreparedSalesDigest } from '../../server/src/services/assignmentSalesCsv/receiptIntegrity.js';
import { checkPrivateSalesMatchProposals } from '../src/features/neighborhood/privateSalesMatchProposals.ts';

const runtime = createRequire(new URL('../package.json', import.meta.url));
const ts = runtime('typescript'), jsx = runtime('react/jsx-runtime');
const { renderToStaticMarkup } = runtime('react-dom/server');
const TARGET = { accountId: 'SYNTHETIC', assignmentFileId: 37, sessionKey: 'synthetic-session' };
const ID = '10000000-0000-4000-8000-000000000001', REPORT = '20000000-0000-4000-8000-000000000001';
const BATCH = '30000000-0000-4000-8000-000000000001';
const bytes = Buffer.from('ListingId,CloseDate,CurrentPrice,Address\r\n"=1+1",2020-01-01,250000,"=HYPERLINK(""x"")"');
const hash = value => createHash('sha256').update(value).digest('hex');
const descriptor = { file_name: 'Synthetic café.csv', file_size: bytes.length, file_sha256: hash(bytes) };
const pending = () => api.makePrivateSalesPending(TARGET, REPORT, descriptor, ID);
const preparation = prepareAssignmentSalesCsv(bytes);
const receipt = (operation = ID) => ({ receipt_version: 1, persisted: true, persistence_status: 'saved', integrity_status: 'verified', batch_id: BATCH,
  operation_id: operation, report_file_id: REPORT, assignment_file_id: '37', account_id: 'SYNTHETIC', file_name: descriptor.file_name,
  source_sha256: descriptor.file_sha256, source_byte_length: bytes.length, preparation_sha256: 'a'.repeat(64),
  preparation_profile: preparation.profile_id, preparation_version: 1, stored_at: '2026-09-10T00:00:00.000Z', actor_user_id: ID,
  row_count: preparation.row_count, summary: preparation.summary, raw_headers: preparation.raw_headers, columns: preparation.columns,
  matching_status: 'not_evaluated', analysis_status: 'not_evaluated', source_interpretation_status: 'not_reviewed' });
const rowPage = () => ({ batch_id: BATCH, rows: preparation.rows.map(row => ({ ...row, receipt_id: ID, persisted: true })), next_after_row: null });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal });
function storage() {
  const values = new Map(); return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function client(request) { return api.createPrivateSalesImportsClient(TARGET, { request, urlFor: path => path }); }
async function matchFixture({ source, candidates, after = 0, limit = 50 } = {}) {
  const content = Buffer.from(source ?? 'ListingId,CloseDate,CurrentPrice,ClosePrice,ParcelNumber,City,County\nA,2020-01-01,250000,260000,00000000000000001,DALLAS,DALLAS\nB,2020-01-02,270000,280000,00000000000000002,DALLAS,DALLAS');
  const prepared = prepareAssignmentSalesCsv(content), saved = { ...receipt(), source_sha256: hash(content), source_byte_length: content.length,
    row_count: prepared.row_count, summary: prepared.summary, raw_headers: prepared.raw_headers, columns: prepared.columns };
  const selected = prepared.rows.filter(row => row.source_row_number > after).slice(0, limit);
  const owned = selected.map(row => ({ receipt_id: `50000000-0000-4000-8000-${String(row.source_row_number).padStart(12, '0')}`,
    source_row_number: row.source_row_number, record_data: row }));
  const batch = { batch_id: BATCH, source_sha256: saved.source_sha256, preparation_sha256: saved.preparation_sha256 };
  const proposal = await proposeAssignmentSalesMatchPage({ batch, rows: owned }, { readCandidates: async ({ requests }) => ({
    observed_at: '2026-09-10T12:00:00.123456789Z', results: requests.map(request => ({ request_id: request.request_id,
      status: 'complete', candidates: candidates ?? [{ account_id: request.identifier, address: '123 SYNTHETIC ST', city: 'DALLAS', county: 'DALLAS', postal_code: '75001' }] })) }) });
  const next = selected.length && selected.at(-1).source_row_number < saved.row_count + 1 ? selected.at(-1).source_row_number : null;
  const context = { account_id: TARGET.accountId, assignment_file_id: '37', report_file_id: REPORT, next_after_row: next };
  const { rows, lookups, ...header } = proposal, digest = createPreparedSalesDigest(); digest.add({ ...context, ...header });
  for (const { record_data, ...identity } of owned) { digest.add(identity); digest.add(record_data); }
  for (const row of rows) digest.add(row); for (const lookup of lookups) digest.add(lookup);
  const result = { ...context, ...proposal, proposal_page_sha256: digest.digest() };
  const page = { batch_id: BATCH, rows: owned.map(row => ({ ...row.record_data, receipt_id: row.receipt_id, persisted: true })), next_after_row: next };
  return { receipt: saved, page, result, expected: { identity: TARGET, receipt: saved, page } };
}

test('real preparation/kernel proposals retain exact row identity and only current-observation status', async () => {
  const f = await matchFixture(), before = structuredClone(f);
  assert.deepEqual(checkPrivateSalesMatchProposals(f.result, f.expected), f.result);
  assert.deepEqual(f.result.rows.map(row => row.proposed_account_ids), [['00000000000000001'], ['00000000000000002']]);
  assert.equal(f.result.accepted, false); assert.equal(f.page.rows[0].values.current_price, '250000');
  assert.equal(f.page.rows[0].values.close_price, '260000'); assert.deepEqual(f, before);
});

for (const [name, mutate] of [
  ['account', value => { value.account_id = 'FOREIGN'; }], ['file', value => { value.assignment_file_id = '38'; }],
  ['report', value => { value.report_file_id = ID; }], ['batch', value => { value.binding.batch_id = ID; }],
  ['source hash', value => { value.binding.source_sha256 = 'b'.repeat(64); }],
  ['preparation hash', value => { value.binding.preparation_sha256 = 'b'.repeat(64); }],
  ['digest syntax', value => { value.proposal_page_sha256 = 'not-a-sha'; }], ['accepted page', value => { value.accepted = true; }],
  ['accepted row', value => { value.rows[0].accepted = true; }], ['matching authority', value => { value.rows[0].matching_status = 'matched'; }],
  ['ordinal', value => { value.rows[0].source_row_number++; }], ['row identity', value => { value.rows[0].receipt_id = ID; }],
  ['dropped row', value => { value.rows.pop(); }], ['cursor', value => { value.next_after_row = 2; }],
  ['issues', value => { value.rows[0].preparation_issues = ['changed']; }],
  ['unobserved proposal', value => { value.rows[0].proposed_account_ids = ['FOREIGN']; }],
  ['unknown lookup', value => { value.rows[0].lookup_ids = ['lookup:600']; }],
  ['unavailable proposed lookup', value => { value.lookups[0].status = 'unavailable'; }],
  ['sparse proposed IDs', value => { value.rows[0].proposed_account_ids = new Array(1); }],
  ['unknown reason', value => { value.rows[0].reasons = ['grant_implied']; }],
  ['invalid date', value => { value.observed_at = '2026-02-30T00:00:00Z'; }],
  ['missing limitation', value => { value.limitations.pop(); }], ['source/private extra', value => { value.secret_notes = 'unexpected'; }],
]) test(`match proposal display rejects ${name}`, async () => {
  const f = await matchFixture(), changed = structuredClone(f.result); mutate(changed);
  assert.throws(() => checkPrivateSalesMatchProposals(changed, f.expected), /private_sales_match_invalid_response/);
});

test('actual unresolved, review-required and empty rows are preserved, never automatically proposed', async () => {
  for (const options of [{ candidates: [] }, { source: 'ListingId,CloseDate,CurrentPrice,ParcelNumber,County\nA,2020-01-01,1,bad,DALLAS' },
    { source: 'ListingId,CloseDate,CurrentPrice\n,,' }]) {
    const f = await matchFixture(options); checkPrivateSalesMatchProposals(f.result, f.expected);
    assert.notEqual(f.result.rows[0].proposal_status, 'proposed'); assert.deepEqual(f.result.rows[0].proposed_account_ids, []);
    assert.ok(f.result.rows[0].reasons.length); assert.equal(f.result.rows[0].review_required, true);
  }
});

test('proposal client preserves explicit page cursor, GET-only transport and abort guards', async () => {
  const first = await matchFixture({ limit: 1 }), second = await matchFixture({ after: 2, limit: 1 }), calls = [];
  const service = client(async (url, init) => { calls.push({ url, init });
    return json(new URL(url, 'https://synthetic.invalid').searchParams.get('after_row') === '0' ? first.result : second.result); });
  assert.equal((await service.matchProposals(first.receipt, first.page, 0, 1, io())).next_after_row, 2);
  assert.equal((await service.matchProposals(second.receipt, second.page, 2, 1, io())).next_after_row, null);
  assert.equal(calls.length, 2); for (const call of calls) {
    assert.ok(call.url.includes(`/${BATCH}/match-proposals?`)); assert.equal(call.init.method, undefined);
    assert.equal(new URL(call.url, 'https://synthetic.invalid').searchParams.get('report_file_id'), REPORT);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.matchProposals(first.receipt, first.page, 0, 1, { signal: abort.signal })); assert.equal(calls.length, 2);
});
test('actual server preparation row shape and exact receipt scope are admitted without analysis authority', () => {
  assert.deepEqual(api.checkPrivateSalesReceipt(receipt(), TARGET, REPORT, pending()), receipt());
  assert.deepEqual(api.checkPrivateSalesRows(rowPage(), receipt(), 0, 50), rowPage());
  assert.equal(rowPage().rows[0].raw_cells[0], '=1+1');
});
for (const [key, value] of Object.entries({ account_id: 'FOREIGN', assignment_file_id: 37, report_file_id: ID,
  operation_id: BATCH, source_sha256: 'b'.repeat(64), file_name: 'changed.csv', source_byte_length: bytes.length + 1,
  persisted: false, row_count: '1', preparation_version: 2, stored_at: '2026-02-30T00:00:00.000Z', analysis_status: 'included' })) {
  test(`receipt refuses mismatched or malformed ${key}`, () => assert.throws(() =>
    api.checkPrivateSalesReceipt({ ...receipt(), [key]: value }, TARGET, REPORT, pending())));
}
test('receipt rejects missing/extra fields and contradictory summary counts', () => {
  const missing = receipt(); delete missing.columns;
  for (const value of [missing, { ...receipt(), raw_source: 'unexpected' },
    { ...receipt(), summary: { ...receipt().summary, prepared: 9 } }]) assert.throws(() => api.checkPrivateSalesReceipt(value, TARGET, REPORT));
});
test('count-checked list receipts cannot acknowledge an unresolved upload', () => {
  const listed = { ...receipt(), integrity_status: 'count_checked' };
  assert.equal(api.checkPrivateSalesReceipt(listed, TARGET, REPORT).integrity_status, 'count_checked');
  assert.throws(() => api.checkPrivateSalesReceipt(listed, TARGET, REPORT, pending()));
});
test('chronological list permits short bounded-header pages and does not sort random UUIDs', async () => {
  const imports = [{ ...receipt(), batch_id: ID, integrity_status: 'count_checked' },
    { ...receipt(), batch_id: BATCH, stored_at: '2026-09-09T00:00:00.000Z', integrity_status: 'count_checked' }];
  const value = { imports, next_before_batch_id: BATCH };
  assert.deepEqual(await client(async () => json(value)).list(REPORT, null, io()), value);
  await assert.rejects(client(async () => json({ ...value, imports: imports.toReversed() })).list(REPORT, null, io()));
});
test('row pages reject partial-as-complete, foreign batch, ordinal holes and non-scalar raw observations', () => {
  for (const change of [value => { value.batch_id = ID; }, value => { value.rows = []; },
    value => { value.rows[0].source_row_number = 3; }, value => { value.rows[0].values = { nested: {} }; },
    value => { value.rows[0].persisted = false; }, value => { value.next_after_row = 2; }]) {
    const value = structuredClone(rowPage()); change(value); assert.throws(() => api.checkPrivateSalesRows(value, receipt(), 0, 50));
  }
});
test('row pagination preserves byte-short prefixes, exact ordinals and a genuinely empty data-row file', async () => {
  const original = Buffer.from('ListingId,CloseDate,CurrentPrice\nA,2020-01-01,1\nB,2020-01-02,2');
  const prepared = prepareAssignmentSalesCsv(original), saved = { ...receipt(), row_count: prepared.row_count,
    summary: prepared.summary, raw_headers: prepared.raw_headers, columns: prepared.columns,
    source_sha256: hash(original), source_byte_length: original.length };
  const rows = prepared.rows.map((row, index) => ({ ...row, receipt_id: index === 0 ? ID : BATCH, persisted: true }));
  const calls = [], service = client(async url => {
    calls.push(url); const after = Number(new URL(url, 'https://synthetic.invalid').searchParams.get('after_row'));
    return json({ batch_id: BATCH, rows: [rows[after === 0 ? 0 : 1]], next_after_row: after === 0 ? 2 : null });
  });
  const first = await service.rows(saved, 0, 50, io()), second = await service.rows(saved, first.next_after_row, 50, io());
  assert.equal(first.next_after_row, 2); assert.deepEqual([...first.rows, ...second.rows], rows); assert.equal(second.next_after_row, null);
  assert.ok(calls.every(url => new URL(url, 'https://synthetic.invalid').searchParams.get('report_file_id') === REPORT));
  const header = prepareAssignmentSalesCsv(Buffer.from('ListingId,CloseDate,CurrentPrice\n'));
  const empty = { ...saved, row_count: 0, summary: header.summary };
  assert.deepEqual(api.checkPrivateSalesRows({ batch_id: BATCH, rows: [], next_after_row: null }, empty, 0, 50).rows, []);
});
test('pending metadata is minimal, exact-target/session isolated and malformed presence never absence', () => {
  const store = storage(), saved = pending();
  api.savePrivateSalesPending(store, TARGET, saved);
  assert.deepEqual(api.readPrivateSalesPending(store, TARGET), { status: 'restored', pending: saved });
  for (const changed of [{ accountId: 'OTHER' }, { assignmentFileId: 38 }, { sessionKey: 'other-session' }])
    assert.deepEqual(api.readPrivateSalesPending(store, { ...TARGET, ...changed }), { status: 'absent' });
  assert.doesNotMatch([...store.values.values()].join(''), /raw_cells|HYPERLINK|content|draft/);
  for (const raw of ['null', '{}', '{', JSON.stringify({ ...saved, session_key: 'other' })]) {
    store.setItem(api.privateSalesPendingKey(TARGET), raw); assert.equal(api.readPrivateSalesPending(store, TARGET).status, 'invalid');
  }
  assert.throws(() => api.savePrivateSalesPending({ ...store, setItem() { throw new Error('quota'); } }, TARGET, saved));
});
test('raw upload uses exact bytes, encoded filename and reusable idempotency UUID', async () => {
  const calls = [], service = client(async (url, init) => { calls.push({ url, init }); return json({ ...receipt(), replayed: calls.length > 1 }); });
  for (let i = 0; i < 2; i++) await service.commit(pending(), bytes, io());
  for (const call of calls) {
    assert.equal(call.init.method, 'POST'); assert.equal(new Headers(call.init.headers).get('idempotency-key'), ID);
    assert.equal(new Headers(call.init.headers).get('x-document-file-name'), encodeURIComponent(descriptor.file_name));
    assert.equal(new Headers(call.init.headers).get('content-type'), 'text/csv');
    assert.deepEqual(Buffer.from(await call.init.body.arrayBuffer()), bytes);
    assert.equal(new URL(call.url, 'https://synthetic.invalid').searchParams.get('report_file_id'), REPORT);
  }
});
test('wrong selected bytes fail before HTTP and do not replace operation identity', async () => {
  let calls = 0; await assert.rejects(client(async () => { calls++; }).commit(pending(), Buffer.from('wrong'), io())); assert.equal(calls, 0);
});
test('404 check is inconclusive and does not remove pending metadata or start another upload', async () => {
  const store = storage(); api.savePrivateSalesPending(store, TARGET, pending()); let calls = 0;
  assert.equal(await client(async () => { calls++; return json({ error: 'not found' }, 404); }).check(pending(), io()), null);
  assert.equal(api.readPrivateSalesPending(store, TARGET).status, 'restored'); assert.equal(calls, 1);
});
test('bounded request timeout and HTTP errors never expose arbitrary server text', async () => {
  await assert.rejects(client(() => new Promise(() => {})).target({ ...io(), deadlineMs: 10 }), /private_sales_request_interrupted/);
  await assert.rejects(client(async () => json({ error: 'SYNTHETIC_SECRET_DRIVER_TEXT' }, 500)).target(io()), error => {
    assert.doesNotMatch(error.message, /SECRET/); assert.equal(error.status, 500); return true;
  });
});
test('aborted preflight/hash cannot issue POST and response scalar/cursor types stay strict', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(client(async () => { calls++; }).commit(pending(), bytes, { signal: controller.signal })); assert.equal(calls, 0);
  await assert.rejects(client(async () => json({ imports: [receipt()], next_before_batch_id: 1 })).list(REPORT, null, io()));
});
test('only bounded fixed input error codes are definitive, never generic statuses or raw error strings', async () => {
  for (const [status, code] of [[400, 'assignment_sales_csv_malformed_csv'], [413, 'assignment_sales_csv_file_byte_limit'],
    [415, 'assignment_sales_import_unsupported_media_type']]) {
    await assert.rejects(client(async () => json({ error: code }, status)).commit(pending(), bytes, io()), error => error.code === 'input_rejected');
  }
  for (const [status, body] of [[400, { error: 'unexpected' }], [403, { error: 'assignment_sales_csv_malformed_csv' }],
    [400, { error: 'assignment_sales_csv_malformed_csv', extra: 'x'.repeat(1024) }]]) {
    await assert.rejects(client(async () => json(body, status)).commit(pending(), bytes, io()), error => error.code === 'request_failed');
  }
});
test('unused404/errors, late responses and active bodies are canceled even when the request ignores abort', async () => {
  const response = (status, canceled) => new Response(new ReadableStream({ cancel: canceled }),
    { status, headers: { 'content-type': 'application/json' } });
  for (const status of [404, 500]) {
    let canceled = 0; const result = client(async () => response(status, () => canceled++)).check(pending(), io());
    if (status === 404) assert.equal(await result, null); else await assert.rejects(result);
    assert.equal(canceled, 1);
  }
  let resolve, canceled = 0;
  const late = client(() => new Promise(done => { resolve = done; })).target({ ...io(), deadlineMs: 5 });
  await assert.rejects(late); resolve(response(200, () => canceled++)); await new Promise(done => setTimeout(done, 5));
  assert.equal(canceled, 1);
  canceled = 0;
  await assert.rejects(client(async () => response(200, () => canceled++)).target({ ...io(), deadlineMs: 5 }));
  assert.equal(canceled, 1);
});

const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object'
  ? [node, ...walk(node.props?.children)] : [];
const textOf = node => Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object'
  ? textOf(node.props?.children) : node == null ? '' : String(node);
function harness(t, request, store = storage(), timers = { setTimeout, clearTimeout }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: store });
  let fiber, currentFiber, cursor = 0, dirty = false, tree, props = { ...TARGET, readOnly: false };
  const same = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) { const owner = currentFiber, index = cursor++; if (!(index in owner.cells)) owner.cells[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.cells[index], value => { if (!owner.live) return; owner.cells[index] = typeof value === 'function' ? value(owner.cells[index]) : value; dirty = true; }]; },
    useRef(value) { const index = cursor++; currentFiber.cells[index] ??= { current: value }; return currentFiber.cells[index]; },
    useEffect(setup, deps) { const owner = currentFiber, index = cursor++, old = owner.cells[index]; if (!old || !same(old.deps, deps)) {
      const effect = { deps, setup, cleanup: old?.cleanup }; owner.cells[index] = effect;
      owner.effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); });
    } },
  };
  const source = readFileSync(new URL('../src/features/neighborhood/components/PrivateSalesImportsPanel.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const module = { exports: {} }, imports = { react, 'react/jsx-runtime': jsx, '../privateSalesImports': api,
    '@/lib/api': { fetchWithApplicationAuthentication: request, makeUrl: (path, params) => {
      assert.equal(path.includes('?'), false, 'shared makeUrl receives path and params separately');
      const query = new URLSearchParams(params).toString(); return path + (query ? '?' + query : '');
    } } };
  new Script(`(function(require,module,exports,setTimeout,clearTimeout){${output.outputText}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key)); return imports[key];
  }, module, module.exports, timers.setTimeout, timers.clearTimeout);
  const Panel = module.exports.default;
  const cleanup = () => { if (fiber) { fiber.live = false; fiber.cells.forEach(cell => cell?.cleanup?.()); fiber = null; } };
  function render(next = props) {
    props = next; dirty = false; const owner = Panel(props);
    if (!fiber || fiber.key !== owner.key) { cleanup(); fiber = { key: owner.key, cells: [], effects: [], live: true }; }
    currentFiber = fiber; cursor = 0; tree = owner.type(owner.props); currentFiber = null;
    fiber.effects.splice(0).forEach(effect => effect());
  }
  const flush = () => { let count = 0; while (dirty) { assert.ok(++count < 50); render(); } };
  render(); flush();
  t.after(() => { cleanup(); if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  return { store, get props() { return props; }, text: () => textOf(tree), html: () => renderToStaticMarkup(tree),
    render(next) { render(next); flush(); }, open() { tree.props.onToggle({ currentTarget: { open: true } }); flush(); },
    button(label) { return walk(tree).find(node => node.type === 'button' && textOf(node) === label); },
    click(label, direct = false) { const node = this.button(label); assert.ok(node, label); if (!direct) assert.equal(Boolean(node.props.disabled), false); node.props.onClick(); flush(); },
    file(value) { walk(tree).find(node => node.type === 'input').props.onChange({ currentTarget: { files: [value] } }); flush(); },
    async settle() { for (let i = 0; i < 25; i++) { await new Promise(resolve => setTimeout(resolve, 1)); flush(); } },
    strictReplay() { const effects = fiber.cells.filter(cell => cell?.setup); effects.forEach(effect => effect.cleanup?.()); effects.forEach(effect => { effect.cleanup = effect.setup(); }); flush(); },
  };
}
function fakeServer() {
  const calls = []; let saved = null, loseAck = false, blocked = null;
  return { calls, get saved() { return saved; }, set loseAck(value) { loseAck = value; }, set blocked(value) { blocked = value; },
    async request(url, init) {
      calls.push({ url, init }); if (blocked) await blocked;
      const path = new URL(url, 'https://synthetic.invalid').pathname;
      if (path.endsWith('/target')) return json({ account_id: TARGET.accountId, assignment_file_id: '37', report_file_id: REPORT, workfile_status: 'draft', can_upload: true });
      if (init.method === 'POST') { saved = receipt(new Headers(init.headers).get('idempotency-key')); if (loseAck) throw new Error('lost acknowledgement'); return json({ ...saved, replayed: false }); }
      if (path.includes('/operations/')) return saved ? json(saved) : json({}, 404);
      if (path.endsWith('/rows')) return json(rowPage());
      return json({ imports: saved ? [{ ...saved, integrity_status: 'count_checked' }] : [], next_before_batch_id: null });
    } };
}
async function matchServer(options = {}) {
  const initial = await matchFixture(options), calls = []; let hold = null;
  return { calls, set hold(value) { hold = value; }, async request(url, init) {
    calls.push({ url, init }); const parsed = new URL(url, 'https://synthetic.invalid');
    if (parsed.pathname.endsWith('/target')) return json({ account_id: TARGET.accountId, assignment_file_id: '37',
      report_file_id: REPORT, workfile_status: 'draft', can_upload: true });
    if (parsed.pathname.endsWith('/rows') || parsed.pathname.endsWith('/match-proposals')) {
      const f = await matchFixture({ ...options, after: Number(parsed.searchParams.get('after_row')), limit: Number(parsed.searchParams.get('limit')) });
      if (parsed.pathname.endsWith('/rows')) return json(f.page);
      if (hold) await hold; return json(f.result);
    }
    return json({ imports: [{ ...initial.receipt, integrity_status: 'count_checked' }], next_before_batch_id: null });
  } };
}

test('rendered proposals require explicit action, preserve saved rows and reset on page changes without auto matching', async t => {
  const source = 'ListingId,CloseDate,CurrentPrice,ClosePrice,ParcelNumber,City,County\n' + Array.from({ length: 51 }, (_, i) =>
    `S${i},2020-01-01,250000,260000,${String(i + 1).padStart(17, '0')},DALLAS,DALLAS`).join('\n');
  const db = await matchServer({ source }), h = harness(t, db.request); h.open(); await h.settle();
  assert.equal(db.calls.length, 2); assert.equal(h.button('Check account match proposals'), undefined);
  h.click('View row receipts'); await h.settle(); assert.equal(db.calls.length, 3);
  assert.doesNotMatch(h.text(), /Proposed account IDs:/); h.click('Check account match proposals'); await h.settle();
  assert.match(h.text(), /Proposed account IDs: 00000000000000001/); assert.match(h.text(), /CurrentPrice is not ClosePrice/);
  assert.match(h.text(), /persistent match review is not available/); assert.equal(h.button('Approve'), undefined);
  const count = db.calls.length; h.render({ ...h.props, readOnly: true }); await h.settle(); assert.equal(db.calls.length, count);
  h.click('Next rows'); await h.settle(); assert.doesNotMatch(h.text(), /Proposed account IDs:/);
  assert.match(h.text(), /Source row 52:/); assert.equal(db.calls.filter(call => call.url.includes('/match-proposals?')).length, 1);
  h.click('Check account match proposals'); await h.settle(); assert.match(h.text(), /Proposed account IDs: 00000000000000051/);
  assert.equal(db.calls.at(-1).init.method, undefined); assert.equal(h.store.values.size, 0);
});

test('rendered unresolved proposals show reasons without approving or hiding original row receipts', async t => {
  const db = await matchServer({ candidates: [] }), h = harness(t, db.request); h.open(); await h.settle();
  h.click('View row receipts'); await h.settle(); h.click('Check account match proposals'); await h.settle();
  assert.match(h.text(), /Account match: unresolved/); assert.match(h.text(), /no unique candidate/);
  assert.doesNotMatch(h.text(), /Proposed account IDs:/); assert.match(h.text(), /Source row 2:/); assert.match(h.html(), /250000/);
});

test('match response from a disposed file/session is aborted and cannot repaint the next file', async t => {
  const db = await matchServer(), h = harness(t, db.request); h.open(); await h.settle(); h.click('View row receipts'); await h.settle();
  let release; db.hold = new Promise(resolve => { release = resolve; }); h.click('Check account match proposals');
  const old = db.calls.at(-1).init.signal; h.render({ ...h.props, assignmentFileId: 38, sessionKey: 'new-user-session' });
  release(); await h.settle(); assert.equal(old.aborted, true); assert.doesNotMatch(h.text(), /Proposed account IDs:|Source row/);
  assert.equal(h.button('Check account match proposals'), undefined);
});
test('rendered panel is closed/network-idle until opened; rerenders and StrictMode replay do not refetch', async t => {
  const db = fakeServer(), h = harness(t, db.request); h.strictReplay(); await h.settle(); assert.equal(db.calls.length, 0);
  assert.match(h.text(), /Private neighborhood sales/); h.open(); await h.settle(); assert.equal(db.calls.length, 2);
  h.render({ ...h.props }); await h.settle(); assert.equal(db.calls.length, 2); assert.match(h.text(), /Older sales alone/);
});
test('rendered lost acknowledgement keeps ID; explicit check restores saved receipt without a second POST', async t => {
  const db = fakeServer(), h = harness(t, db.request); h.open(); await h.settle();
  h.file(new File([bytes], descriptor.file_name)); db.loseAck = true; h.click('Save private CSV'); await h.settle();
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 1);
  const retained = api.readPrivateSalesPending(h.store, TARGET); assert.equal(retained.status, 'restored');
  assert.equal(retained.pending.operation_id, db.saved.operation_id); assert.match(h.text(), /could not be confirmed/);
  h.click('Check saved upload'); await h.settle(); assert.equal(api.readPrivateSalesPending(h.store, TARGET).status, 'absent');
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 1); assert.match(h.text(), /1 saved rows/);
  h.click('View row receipts'); await h.settle(); assert.match(h.html(), /=HYPERLINK/); assert.doesNotMatch(h.html(), /<script/);
});
test('pending reload checks exact ID, keeps404 metadata and wrong selected file cannot issue POST', async t => {
  const store = storage(); api.savePrivateSalesPending(store, TARGET, pending());
  const db = fakeServer(), h = harness(t, db.request, store); h.open(); await h.settle();
  assert.ok(db.calls.some(call => call.url.includes('/operations/' + ID))); assert.match(h.text(), /does not prove/);
  h.file(new File([Buffer.from('wrong')], 'different.csv')); h.click('Retry same upload'); await h.settle();
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 0); assert.equal(api.readPrivateSalesPending(store, TARGET).pending.operation_id, ID);
});
test('fresh definitive input rejection releases only its new ID; the corrected file can be submitted', async t => {
  const db = fakeServer(); let rejected = true;
  const h = harness(t, (url, init) => init.method === 'POST' && rejected
    ? json({ error: 'assignment_sales_csv_malformed_csv' }, 400) : db.request(url, init));
  h.open(); await h.settle(); h.file(new File([bytes], descriptor.file_name)); h.click('Save private CSV'); await h.settle();
  assert.equal(api.readPrivateSalesPending(h.store, TARGET).status, 'absent'); assert.match(h.text(), /was not saved/);
  rejected = false; h.file(new File([bytes], descriptor.file_name)); h.click('Save private CSV'); await h.settle();
  assert.match(h.text(), /1 saved rows/);
});
test('a previously uncertain operation remains pending after a definitive retry rejection', async t => {
  const db = fakeServer(), store = storage(); api.savePrivateSalesPending(store, TARGET, pending());
  let rejected = true; const posts = [];
  const h = harness(t, (url, init) => {
    if (init.method === 'POST') { posts.push(new Headers(init.headers).get('idempotency-key'));
      if (rejected) return json({ error: 'assignment_sales_csv_malformed_csv' }, 400); }
    return db.request(url, init);
  }, store);
  h.open(); await h.settle(); h.file(new File([bytes], descriptor.file_name)); h.click('Retry same upload'); await h.settle();
  assert.equal(api.readPrivateSalesPending(store, TARGET).pending.operation_id, ID);
  rejected = false; h.click('Retry same upload'); await h.settle(); assert.deepEqual(posts, [ID, ID]);
  assert.equal(api.readPrivateSalesPending(store, TARGET).status, 'absent');
});
test('busy observer tracks settled operations, not render changes or unresolved metadata', async t => {
  const db = fakeServer(), h = harness(t, db.request), first = [], second = [];
  h.render({ ...h.props, onBusyChange: value => first.push(value) }); h.open(); await h.settle(); assert.deepEqual(first, [true, false]);
  h.render({ ...h.props, onBusyChange: value => second.push(value) }); await h.settle(); assert.deepEqual(second, []);
  h.file(new File([bytes], descriptor.file_name)); db.loseAck = true; h.click('Save private CSV'); await h.settle();
  assert.deepEqual(second, [true, false]); assert.equal(api.readPrivateSalesPending(h.store, TARGET).status, 'restored');
});
test('read-only transition during file read prevents POST and does not discard prior recovery metadata', async t => {
  const db = fakeServer(), store = storage(); api.savePrivateSalesPending(store, TARGET, pending());
  const h = harness(t, db.request, store); h.open(); await h.settle();
  let release; h.file({ size: bytes.length, name: descriptor.file_name, arrayBuffer: () => new Promise(done => { release = done; }) });
  h.click('Retry same upload'); h.render({ ...h.props, readOnly: true }); release(bytes); await h.settle();
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 0);
  assert.equal(api.readPrivateSalesPending(store, TARGET).pending.operation_id, ID);
});

for (const interruption of ['deadline', 'read_only']) test(`stalled file read releases busy on ${interruption}; late bytes cannot POST or replace pending identity`, async t => {
  const db = fakeServer(), store = storage(), deadlines = new Map(); api.savePrivateSalesPending(store, TARGET, pending());
  const timers = {
    setTimeout(callback, delay) { assert.equal(delay, 45000); const key = {}; deadlines.set(key, callback); return key; },
    clearTimeout(key) { deadlines.delete(key); },
  };
  const h = harness(t, db.request, store, timers); h.open(); await h.settle(); assert.equal(deadlines.size, 0);
  const busy = []; h.render({ ...h.props, onBusyChange: value => busy.push(value) });
  let release; h.file({ size: bytes.length, name: descriptor.file_name, arrayBuffer: () => new Promise(done => { release = done; }) });
  h.click('Retry same upload'); assert.deepEqual(busy, [true]); assert.equal(deadlines.size, 1);
  if (interruption === 'deadline') [...deadlines.values()][0](); else h.render({ ...h.props, readOnly: true });
  await h.settle(); // The file read has NOT completed: completion must not be required to release busy.
  assert.deepEqual(busy, [true, false]); assert.equal(deadlines.size, 0);
  assert.equal(h.button('Check saved upload').props.disabled, false);
  assert.equal(api.readPrivateSalesPending(store, TARGET).pending.operation_id, ID);
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 0);
  release(bytes); await h.settle();
  assert.deepEqual(busy, [true, false]); assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 0);
  assert.equal(api.readPrivateSalesPending(store, TARGET).pending.operation_id, ID);
});
test('read-only direct callback denies writes; file/session change ignores late response and returns closed', async t => {
  const db = fakeServer(), h = harness(t, db.request); h.open(); await h.settle(); h.file(new File([bytes], descriptor.file_name));
  h.render({ ...h.props, readOnly: true }); h.click('Save private CSV', true); await h.settle();
  assert.equal(db.calls.filter(call => call.init.method === 'POST').length, 0);
  const busy = []; h.render({ ...h.props, onBusyChange: value => busy.push(value) });
  let release; db.blocked = new Promise(resolve => { release = resolve; }); h.click('Refresh saved uploads');
  const oldSignal = db.calls.at(-1).init.signal; h.render({ ...h.props, sessionKey: 'new-session' }); release(); await h.settle();
  assert.equal(oldSignal.aborted, true); assert.equal(h.button('Refresh saved uploads'), undefined); assert.doesNotMatch(h.text(), /saved rows/);
  assert.deepEqual(busy, [true, false], 'old-session disposal releases host busy once without accepting its late result');
});
