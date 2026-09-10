import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as api from '../src/features/neighborhood/privateSalesReview.ts';
import * as matchApi from '../src/features/neighborhood/privateSalesMatchProposals.ts';
import * as pendingApi from '../src/features/neighborhood/privateSalesReviewPending.ts';
import { prepareAssignmentSalesCsv } from '../../server/src/services/assignmentSalesCsv/prepare.js';
import { validateAssignmentSalesReviewCommand } from '../../server/src/services/assignmentSalesCsv/review.js';
import { proposeAssignmentSalesMatchPage } from '../../server/src/services/assignmentSalesCsv/matchProposals.js';
import { createPreparedSalesDigest } from '../../server/src/services/assignmentSalesCsv/receiptIntegrity.js';

const runtime = createRequire(new URL('../package.json', import.meta.url)), ts = runtime('typescript'), jsx = runtime('react/jsx-runtime');
const { renderToStaticMarkup } = runtime('react-dom/server');
const identity = { accountId: 'SYNTHETIC-REVIEW', assignmentFileId: 37, sessionKey: 'synthetic-session' };
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REPORT = uuid(1), BATCH = uuid(2), OP = uuid(3), ACTOR = uuid(4), REVIEW = uuid(5);
const hash = text => createHash('sha256').update(text).digest('hex');
const source = () => ({ source_name: 'Synthetic MLS', provenance_note: 'Owner-provided test statement only.\nNot a provider grant.',
  currency: null, living_area_unit: null, site_area_unit: null, consideration_field: null, marketing_time_field: null, source_use_confirmed: false });
const decision = (ordinal = 2, type = 'exclude', accounts = []) => ({ receipt_id: uuid(ordinal + 100), source_row_number: ordinal,
  decision: type, account_ids: accounts, note: '' });
const command = overrides => ({ review_version: 1, expected_revision: 0, source_interpretation: null, row_decisions: [decision()], ...overrides });
const io = () => ({ signal: new AbortController().signal, deadlineMs: 3000 });
async function fixture({ after = 0, limit = 50, revision = 0 } = {}) {
  // Actual CSV preparation and proposal kernel; all data are explicitly synthetic.
  const content = Buffer.from('ListingId,CloseDate,CurrentPrice,ClosePrice,ParcelNumber,City,County\nA,2020-01-01,250000,260000,00000000000000001,DALLAS,DALLAS\nB,2020-01-02,270000,280000,00000000000000002,DALLAS,DALLAS');
  const prepared = prepareAssignmentSalesCsv(content), receipt = { receipt_version: 1, persisted: true, persistence_status: 'saved', integrity_status: 'verified',
    batch_id: BATCH, operation_id: OP, report_file_id: REPORT, assignment_file_id: '37', account_id: identity.accountId, file_name: 'synthetic.csv',
    source_sha256: hash(content), source_byte_length: content.length, preparation_sha256: 'a'.repeat(64), preparation_profile: prepared.profile_id,
    preparation_version: 1, stored_at: '2026-09-10T00:00:00.000Z', actor_user_id: ACTOR, row_count: prepared.row_count,
    summary: prepared.summary, raw_headers: prepared.raw_headers, columns: prepared.columns,
    matching_status: 'not_evaluated', analysis_status: 'not_evaluated', source_interpretation_status: 'not_reviewed' };
  const owned = prepared.rows.filter(row => row.source_row_number > after).slice(0, limit).map(record_data => ({ record_data,
    receipt_id: uuid(record_data.source_row_number + 100), source_row_number: record_data.source_row_number }));
  const next = owned.length && owned.at(-1).source_row_number < prepared.row_count + 1 ? owned.at(-1).source_row_number : null;
  const page = { batch_id: BATCH, rows: owned.map(row => ({ ...row.record_data, receipt_id: row.receipt_id, persisted: true })), next_after_row: next };
  const proposal = await proposeAssignmentSalesMatchPage({ batch: { batch_id: BATCH, source_sha256: receipt.source_sha256, preparation_sha256: receipt.preparation_sha256 }, rows: owned },
    { readCandidates: async ({ requests }) => ({ observed_at: '2026-09-10T12:00:00.123456789Z', results: requests.map(request => ({ request_id: request.request_id,
      status: 'complete', candidates: request.identifier.endsWith('1') ? [{ account_id: request.identifier, address: '1 SYNTHETIC ST', city: 'DALLAS', county: 'DALLAS', postal_code: '75001' }] : [] })) }) });
  const transport = { account_id: identity.accountId, assignment_file_id: '37', report_file_id: REPORT, next_after_row: next };
  const { rows, lookups, ...header } = proposal, digest = createPreparedSalesDigest(); digest.add({ ...transport, ...header });
  for (const { record_data, ...row } of owned) { digest.add(row); digest.add(record_data); }
  for (const row of rows) digest.add(row); for (const lookup of lookups) digest.add(lookup);
  const proposals = { ...transport, ...proposal, proposal_page_sha256: digest.digest() };
  const scope = { review_version: 1, account_id: identity.accountId, assignment_file_id: '37', report_file_id: REPORT, batch_id: BATCH,
    source_sha256: receipt.source_sha256, preparation_sha256: receipt.preparation_sha256, matching_status: 'reviewed_separately', analysis_status: 'not_evaluated' };
  const state = { ...scope, revision, last_review_id: revision ? REVIEW : null, source_interpretation: null, source_review_id: null, row_decisions: [], next_after_row: next };
  const ack = (body = command(), replayed = false) => ({ ...scope, persisted: true, review_id: REVIEW, operation_id: OP,
    revision: body.expected_revision + 1, previous_revision: body.expected_revision, actor_user_id: ACTOR, recorded_at: '2026-09-10T12:00:00.000Z',
    command_sha256: 'b'.repeat(64), payload_sha256: 'c'.repeat(64), command: validateAssignmentSalesReviewCommand(body), replayed });
  return { identity, receipt, page, proposals, state, ack };
}
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;
}

test('frontend command normalization equals real server grammar, without defaults or mutation', () => {
  const raw = command({ source_interpretation: { ...source(), source_name: '  Synthetic MLS  ', provenance_note: 'x\r\n\t<tag>',
    currency: 'USD', consideration_field: 'current_price', marketing_time_field: 'cumulative_days_on_market' }, row_decisions: [
    { ...decision(3, 'confirm_proposed_match', ['B', 'A']), receipt_id: uuid(103).toUpperCase() }, decision(2, 'clear')] });
  const before = structuredClone(raw), checked = api.preparePrivateSalesReviewCommand(raw);
  assert.deepEqual(checked, validateAssignmentSalesReviewCommand(raw)); assert.deepEqual(raw, before);
  assert.deepEqual(checked.row_decisions.map(row => row.source_row_number), [3, 2]); assert.deepEqual(checked.row_decisions[0].account_ids, ['A', 'B']);
  const unknown = api.preparePrivateSalesReviewCommand(command({ source_interpretation: source(), row_decisions: [] }));
  for (const key of ['currency', 'living_area_unit', 'site_area_unit', 'consideration_field', 'marketing_time_field']) assert.equal(unknown.source_interpretation[key], null);
  assert.equal(unknown.source_interpretation.source_use_confirmed, false); assert.equal(api.preparePrivateSalesReviewCommand(command()).source_interpretation, null);
});
for (const [name, mutate] of [
  ['empty command', x => { x.row_decisions = []; }], ['extra field', x => { x.accepted = true; }],
  ['string revision', x => { x.expected_revision = '0'; }], ['exhausted revision', x => { x.expected_revision = 2147483647; }],
  ['unknown row decision', x => { x.row_decisions[0].decision = 'include_in_analysis'; }],
  ['missing ordinal', x => { delete x.row_decisions[0].source_row_number; }], ['ordinal below CSV data', x => { x.row_decisions[0].source_row_number = 1; }],
  ['empty confirmation', x => { x.row_decisions[0].decision = 'confirm_proposed_match'; }],
  ['exclude accounts', x => { x.row_decisions[0].account_ids = ['A']; }],
  ['duplicate receipt', x => { x.row_decisions.push({ ...x.row_decisions[0], source_row_number: 3 }); }],
  ['duplicate ordinal', x => { x.row_decisions.push({ ...x.row_decisions[0], receipt_id: uuid(9) }); }],
  ['duplicate accounts', x => { x.row_decisions = [decision(2, 'confirm_proposed_match', ['A', 'A'])]; }],
  ['account whitespace', x => { x.row_decisions = [decision(2, 'confirm_proposed_match', [' A'])]; }],
  ['too many accounts', x => { x.row_decisions = [decision(2, 'confirm_proposed_match', ['A', 'B', 'C', 'D', 'E', 'F'])]; }],
  ['NUL note', x => { x.row_decisions[0].note = 'x\0'; }], ['C1 note', x => { x.row_decisions[0].note = '\u0080'; }],
  ['unpaired surrogate', x => { x.row_decisions[0].note = '\ud800'; }], ['oversized note', x => { x.row_decisions[0].note = 'x'.repeat(1001); }],
  ['source field omitted', x => { x.source_interpretation = source(); delete x.source_interpretation.currency; }],
  ['source name control before trim', x => { x.source_interpretation = { ...source(), source_name: '\tSynthetic' }; }],
  ['source blank', x => { x.source_interpretation = { ...source(), source_name: '   ' }; }],
  ['source unknown currency', x => { x.source_interpretation = { ...source(), currency: 'CAD' }; }],
  ['source string confirmation', x => { x.source_interpretation = { ...source(), source_use_confirmed: 'true' }; }],
  ['source bool semantics', x => { x.source_interpretation = { ...source(), consideration_field: true }; }],
]) test(`review command rejects ${name} with server parity`, () => {
  const value = command(); mutate(value); assert.throws(() => api.preparePrivateSalesReviewCommand(value)); assert.throws(() => validateAssignmentSalesReviewCommand(value));
});
test('closed descriptors/dense arrays and complete command-byte bound fail without a silent prefix', () => {
  const sparse = command(); sparse.row_decisions = new Array(1); assert.throws(() => api.preparePrivateSalesReviewCommand(sparse));
  const hidden = command(); Object.defineProperty(hidden, 'extra', { value: true }); assert.throws(() => api.preparePrivateSalesReviewCommand(hidden));
  let called = false; const getter = command(); Object.defineProperty(getter, 'expected_revision', { get() { called = true; return 0; }, enumerable: true });
  assert.throws(() => api.preparePrivateSalesReviewCommand(getter)); assert.equal(called, false);
  const large = command({ row_decisions: Array.from({ length: 100 }, (_, i) => ({ ...decision(i + 2), note: '界'.repeat(1000) })) });
  assert.throws(() => api.preparePrivateSalesReviewCommand(large)); assert.throws(() => validateAssignmentSalesReviewCommand(large));
  const padded = command({ source_interpretation: { ...source(), source_name: ' '.repeat(262140) + 'X' } });
  assert.throws(() => api.preparePrivateSalesReviewCommand(padded)); assert.throws(() => validateAssignmentSalesReviewCommand(padded));
});
test('state checks sparse current heads and explicit clear against actual original page, independent of JSONB key order', async () => {
  const f = await fixture({ revision: 3 }); f.state.source_interpretation = source(); f.state.source_review_id = uuid(20);
  f.state.row_decisions = [{ ...decision(3, 'clear'), review_id: uuid(21), revision: 2 }];
  const value = reordered(f.state), before = structuredClone(value);
  assert.deepEqual(api.checkPrivateSalesReviewState(value, f.identity, f.receipt, f.page), value); assert.deepEqual(value, before);
  assert.equal(value.row_decisions[0].decision, 'clear'); assert.equal(value.next_after_row, null);
});
for (const [name, mutate] of [
  ['foreign account', x => { x.account_id = 'FOREIGN'; }], ['foreign assignment', x => { x.assignment_file_id = '38'; }],
  ['numeric assignment', x => { x.assignment_file_id = 37; }], ['foreign report', x => { x.report_file_id = OP; }],
  ['foreign batch', x => { x.batch_id = OP; }], ['foreign source hash', x => { x.source_sha256 = 'd'.repeat(64); }],
  ['foreign preparation hash', x => { x.preparation_sha256 = 'd'.repeat(64); }], ['analysis promotion', x => { x.analysis_status = 'included'; }],
  ['missing last review', x => { x.last_review_id = null; }], ['unbound source', x => { x.source_interpretation = source(); }],
  ['wrong cursor', x => { x.next_after_row = 2; }], ['future row revision', x => { x.row_decisions[0].revision = 3; }],
  ['foreign receipt', x => { x.row_decisions[0].receipt_id = OP; }], ['wrong ordinal', x => { x.row_decisions[0].source_row_number = 3; }],
  ['missing original row', x => { x.row_decisions.push({ ...decision(4), review_id: REVIEW, revision: 1 }); }],
  ['additional raw source', x => { x.raw_source = 'private'; }],
]) test(`current review state rejects ${name}`, async () => {
  const f = await fixture({ revision: 2 }); f.state.row_decisions = [{ ...decision(), review_id: REVIEW, revision: 1 }]; mutate(f.state);
  assert.throws(() => api.checkPrivateSalesReviewState(f.state, identity, f.receipt, f.page));
});
test('receipt validates exact command/operation and historical replay without requiring latest revision', async () => {
  const f = await fixture({ revision: 9 }), body = command({ source_interpretation: source() }), raw = reordered(f.ack(body, true));
  assert.equal(api.checkPrivateSalesReviewReceipt(raw, identity, f.receipt, OP, body).replayed, true);
  assert.equal(api.checkPrivateSalesReviewReceipt(raw, identity, f.receipt, OP, null).revision, 1);
  for (const mutate of [x => { x.operation_id = REVIEW; }, x => { x.command.row_decisions[0].note = 'changed'; },
    x => { x.revision = 9; }, x => { x.previous_revision = 1; }, x => { x.persisted = false; }, x => { x.actor_user_id = 'bad'; },
    x => { x.recorded_at = '2026-02-30T00:00:00.000Z'; }, x => { x.command_sha256 = 'bad'; }, x => { x.replayed = 'true'; }]) {
    const changed = structuredClone(raw); mutate(changed); assert.throws(() => api.checkPrivateSalesReviewReceipt(changed, identity, f.receipt, OP, body));
  }
});
test('page preparation only confirms exact proposed accounts, no browser acceptance or implicit inclusion', async () => {
  const f = await fixture(), confirmed = command({ row_decisions: [decision(2, 'confirm_proposed_match', ['00000000000000001'])] });
  assert.deepEqual(api.preparePrivateSalesReviewForPage(confirmed, f.state, identity, f.receipt, f.page, f.proposals), confirmed);
  for (const [body, proposals] of [[confirmed, null], [command({ row_decisions: [decision(3, 'confirm_proposed_match', ['A'])] }), f.proposals],
    [command({ row_decisions: [decision(2, 'confirm_proposed_match', ['WRONG'])] }), f.proposals],
    [command({ expected_revision: 1 }), f.proposals], [command({ row_decisions: [decision(4)] }), f.proposals]])
    assert.throws(() => api.preparePrivateSalesReviewForPage(body, f.state, identity, f.receipt, f.page, proposals));
  assert.deepEqual(api.preparePrivateSalesReviewForPage(command(), f.state, identity, f.receipt, f.page, null), command());
});
test('client exact page pagination, scoped JSON/operation headers and inconclusive recovery reuse the same ID', async () => {
  const first = await fixture({ limit: 1 }), second = await fixture({ after: 2, limit: 1 }), calls = []; let found = false;
  const client = api.createPrivateSalesReviewClient(identity, { expectedActorUserId: ACTOR, call: async (url, init, options, missing) => {
    calls.push({ url, init, options, missing });
    if (url.includes('/operations/')) return found ? first.ack(command(), true) : null;
    if (init.method === 'POST') { found = true; return first.ack(JSON.parse(init.body)); }
    return new URL(url, 'https://synthetic.invalid').searchParams.get('after_row') === '0' ? first.state : second.state;
  } });
  assert.equal((await client.get(first.receipt, first.page, 0, 1, io())).next_after_row, 2);
  assert.equal((await client.get(second.receipt, second.page, 2, 1, io())).next_after_row, null);
  assert.equal(await client.checkOperation(first.receipt, OP, null, io()), null); assert.equal(calls.length, 3);
  await client.save(first.receipt, OP, command(), io()); assert.equal((await client.checkOperation(first.receipt, OP, command(), io())).replayed, true);
  assert.equal((await client.checkOperation(first.receipt, OP, null, io())).actor_user_id, ACTOR);
  for (const call of calls) assert.equal(new URL(call.url, 'https://synthetic.invalid').searchParams.get('report_file_id'), REPORT);
  const post = calls.find(call => call.init.method === 'POST'); assert.equal(new Headers(post.init.headers).get('Idempotency-Key'), OP);
  assert.equal(new Headers(post.init.headers).get('Content-Type'), 'application/json'); assert.deepEqual(JSON.parse(post.init.body), command());
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(calls[2].missing, true);
});
test('client optional trusted actor and detached expectations refuse foreign/mutated or late-aborted responses', async () => {
  const f = await fixture();
  assert.throws(() => api.createPrivateSalesReviewClient(identity, { expectedActorUserId: 'not-a-user-uuid', call: async () => null }));
  const foreign = api.createPrivateSalesReviewClient(identity, { expectedActorUserId: uuid(999), call: async () => f.ack() });
  await assert.rejects(foreign.checkOperation(f.receipt, OP, null, io()));
  let resolve, calls = 0; const client = api.createPrivateSalesReviewClient(identity, { call: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const controller = new AbortController(), pending = client.get(f.receipt, f.page, 0, 50, { signal: controller.signal });
  controller.abort(); resolve(f.state); await assert.rejects(pending); assert.equal(calls, 1);
  await assert.rejects(client.save(f.receipt, OP, command(), { signal: controller.signal })); assert.equal(calls, 1);
  const body = command(), submitted = client.save(f.receipt, OP, body, io()); body.row_decisions[0].note = 'mutated';
  resolve(f.ack()); assert.equal((await submitted).command.row_decisions[0].note, '');
});

function storage() {
  const values = new Map(); return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('pending review retains only scoped operation plus normalized bounded command, with exact retry after refresh', async () => {
  const f = await fixture(), store = storage(), raw = reordered(command({ source_interpretation: source(),
    row_decisions: [decision(2, 'confirm_proposed_match', ['B', 'A'])] }));
  const pending = pendingApi.makePrivateSalesReviewPending(identity, f.receipt, OP, raw);
  assert.deepEqual(pending.command, validateAssignmentSalesReviewCommand(raw));
  pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, pending);
  pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, pending);
  assert.equal(store.values.size, 1); const reopened = pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt);
  assert.deepEqual(reopened, pending); assert.notEqual(reopened.command, pending.command);
  assert.deepEqual(Object.keys(reopened).sort(), ['pending_version', 'account_id', 'assignment_file_id', 'session_key', 'report_file_id',
    'batch_id', 'source_sha256', 'preparation_sha256', 'operation_id', 'command'].sort());
  assert.doesNotMatch([...store.values.values()].join(''), /raw_cells|record_data|match_evidence|Authorization|source_bytes|Bearer/);
  raw.row_decisions[0].note = 'later caller mutation'; assert.equal(pending.command.row_decisions[0].note, '');
  reopened.command.row_decisions[0].note = 'read copy mutation'; assert.equal(pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt).command.row_decisions[0].note, '');
  pendingApi.clearPrivateSalesReviewPending(store, identity, f.receipt); assert.equal(pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt), null);
});
test('pending review is isolated by exact account/file/session/report/batch and refuses foreign payload under its own key', async () => {
  const f = await fixture(), store = storage(), pending = pendingApi.makePrivateSalesReviewPending(identity, f.receipt, OP, command());
  pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, pending);
  for (const [nextIdentity, nextReceipt] of [
    [{ ...identity, sessionKey: 'other-session' }, f.receipt],
    [{ ...identity, accountId: 'OTHER' }, { ...f.receipt, account_id: 'OTHER' }],
    [{ ...identity, assignmentFileId: 38 }, { ...f.receipt, assignment_file_id: '38' }],
    [identity, { ...f.receipt, report_file_id: REVIEW }], [identity, { ...f.receipt, batch_id: REVIEW }],
  ]) assert.equal(pendingApi.readPrivateSalesReviewPending(store, nextIdentity, nextReceipt), null);
  const key = [...store.values.keys()][0];
  for (const [field, value] of [['account_id', 'FOREIGN'], ['assignment_file_id', '38'], ['session_key', 'foreign'], ['report_file_id', REVIEW],
    ['batch_id', REVIEW], ['source_sha256', 'd'.repeat(64)], ['preparation_sha256', 'd'.repeat(64)]]) {
    store.setItem(key, JSON.stringify({ ...pending, [field]: value }));
    assert.throws(() => pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt), /pending_storage_unavailable/);
  }
});
test('pending review never clobbers an unresolved operation, changed command or invalid existing presence', async () => {
  const f = await fixture(), store = storage(), original = pendingApi.makePrivateSalesReviewPending(identity, f.receipt, OP, command());
  pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, original); const bytes = [...store.values.values()][0];
  for (const changed of [pendingApi.makePrivateSalesReviewPending(identity, f.receipt, REVIEW, command()),
    pendingApi.makePrivateSalesReviewPending(identity, f.receipt, OP, command({ row_decisions: [decision(3, 'clear')] }))]) {
    assert.throws(() => pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, changed)); assert.equal([...store.values.values()][0], bytes);
  }
  const key = [...store.values.keys()][0];
  for (const malformed of ['null', '{}', '{', JSON.stringify({ ...original, accepted: true }),
    JSON.stringify({ ...original, command: { ...original.command, expected_revision: '0' } }), 'x'.repeat(300001)]) {
    store.setItem(key, malformed); assert.throws(() => pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt));
    assert.throws(() => pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, original)); assert.equal(store.getItem(key), malformed);
  }
});
test('throwing or ineffective storage cannot pretend pending review save/read/clear succeeded', async () => {
  const f = await fixture(), value = pendingApi.makePrivateSalesReviewPending(identity, f.receipt, OP, command()), store = storage();
  const failure = () => { throw new Error('SYNTHETIC_PRIVATE_BROWSER_FAILURE'); };
  for (const broken of [{ ...store, setItem: failure }, { ...store, getItem: failure }, { ...store, setItem() {} }])
    assert.throws(() => pendingApi.savePrivateSalesReviewPending(broken, identity, f.receipt, value), error => {
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/); return /pending_storage_unavailable/.test(error.message);
    });
  assert.throws(() => pendingApi.readPrivateSalesReviewPending({ ...store, getItem: failure }, identity, f.receipt));
  pendingApi.savePrivateSalesReviewPending(store, identity, f.receipt, value);
  for (const broken of [{ ...store, removeItem: failure }, { ...store, removeItem() {} }])
    assert.throws(() => pendingApi.clearPrivateSalesReviewPending(broken, identity, f.receipt));
  assert.equal(pendingApi.readPrivateSalesReviewPending(store, identity, f.receipt).operation_id, OP);
});

function walk(node) {
  if (!node || typeof node !== 'object') return []; const children = node.props?.children;
  return [node, ...(Array.isArray(children) ? children.flat(Infinity) : [children]).flatMap(walk)];
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  return typeof node === 'object' ? textOf(node.props?.children) : String(node);
}
// Actual component transpiled with deterministic hooks; this is not a browser
// or a claim to exercise React's concurrent scheduler. Real DOM output is SSR.
function harness(t, initial) {
  let fiber, current, cursor, dirty, tree, props = initial;
  const equalDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) { const owner = current, index = cursor++; if (!(index in owner.cells)) owner.cells[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.cells[index], value => { if (!owner.live) return; owner.cells[index] = typeof value === 'function' ? value(owner.cells[index]) : value; dirty = true; }]; },
    useRef(value) { const index = cursor++; current.cells[index] ??= { current: value }; return current.cells[index]; },
    useEffect(setup, deps) { const owner = current, index = cursor++, old = owner.cells[index]; if (!old || !equalDeps(old.deps, deps)) {
      const effect = { deps, setup, cleanup: old?.cleanup }; owner.cells[index] = effect; owner.effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); });
    } },
  };
  const source = readFileSync(new URL('../src/features/neighborhood/components/PrivateSalesReviewPanel.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const module = { exports: {} }, imports = { react, 'react/jsx-runtime': jsx, '../privateSalesReview': api, '../privateSalesMatchProposals': matchApi };
  new Script(`(function(require,module,exports){${output.outputText}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), key); return imports[key];
  }, module, module.exports);
  const cleanup = () => { if (fiber) { fiber.live = false; fiber.cells.forEach(cell => cell?.cleanup?.()); fiber = null; } };
  function render(next = props) {
    props = next; dirty = false; const owner = module.exports.default(props);
    if (!fiber || owner.key !== fiber.key) { cleanup(); fiber = { key: owner.key, cells: [], effects: [], live: true }; }
    current = fiber; cursor = 0; tree = owner.type(owner.props); current = null; fiber.effects.splice(0).forEach(effect => effect());
  }
  const flush = () => { let i = 0; while (dirty) { assert.ok(++i < 20); render(); } }; render(); flush(); t.after(cleanup);
  return { get props() { return props; }, text: () => textOf(tree), html: () => renderToStaticMarkup(tree), nodes: () => walk(tree),
    render(next) { render(next); flush(); }, button: label => walk(tree).find(node => node.type === 'button' && textOf(node) === label),
    click(label, direct = false) { const node = this.button(label); assert.ok(node, label); if (!direct) assert.equal(Boolean(node.props.disabled), false, label);
      node.props.onClick(); flush(); },
    field: label => walk(tree).find(node => node.props?.['aria-label'] === label),
    change(label, value, direct = false) { const node = this.field(label); assert.ok(node, label); if (!direct) assert.equal(Boolean(node.props.disabled), false, label);
      node.props.onChange({ currentTarget: node.props.type === 'checkbox' ? { checked: value } : { value } }); flush(); },
    strictReplay() { const effects = fiber.cells.filter(cell => cell?.setup); effects.forEach(effect => effect.cleanup?.()); effects.forEach(effect => { effect.cleanup = effect.setup(); }); flush(); },
    dispose: cleanup,
  };
}
function propsFor(f, overrides = {}) { return { identity, receipt: f.receipt, page: f.page, reviewState: f.state, proposals: f.proposals,
  readOnly: false, busy: false, onSave() {}, ...overrides }; }
test('rendered review is controlled and collapsed with unknown meanings, no mount/rerender submission', async t => {
  const f = await fixture(), saves = [], h = harness(t, propsFor(f, { onSave: command => saves.push(command) }));
  h.render({ ...h.props }); h.strictReplay(); assert.deepEqual(saves, []);
  assert.match(h.text(), /No saved review yet/); assert.doesNotMatch(h.text(), /Saved review revision 0/);
  assert.equal(h.nodes().find(node => node.type === 'details').props.open, undefined);
  assert.equal(h.nodes().filter(node => node.type === 'details' && node.props['data-review-row']).length, 2);
  assert.ok(h.nodes().filter(node => node.type === 'details').every(node => node.props.open === undefined));
  for (const label of ['Currency', 'Living area unit', 'Site area unit', 'Consideration field', 'Marketing time field']) assert.equal(h.field(label).props.value, '');
  assert.equal(h.field('Source use confirmation').props.checked, false); assert.match(h.text(), /does not automatically add any row to analysis/);
  assert.match(h.text(), /CurrentPrice is not ClosePrice/); assert.equal(h.button('Save staged review').props.disabled, true);
  h.click('Stage confirmation of all 1 proposed matches on this page'); assert.deepEqual(saves, []); h.click('Save staged review');
  assert.deepEqual(saves, [command({ row_decisions: [decision(2, 'confirm_proposed_match', ['00000000000000001'])] })]);
  assert.equal(h.button('Stage confirm row 3').props.disabled, true);
});
test('rendered exclude/clear and exact notes are explicit commands, never receipt mutation', async t => {
  const f = await fixture(), before = JSON.stringify(f), saves = [], h = harness(t, propsFor(f, { onSave: command => saves.push(command) }));
  h.click('Stage exclude row 2'); h.change('Review note for row 2', '<script>not evaluated</script>\n=1+1');
  h.click('Stage clear row 3'); assert.match(h.text(), /staged excluded/); assert.match(h.text(), /staged review cleared/); h.click('Save staged review');
  assert.deepEqual(saves[0].row_decisions.map(row => [row.decision, row.account_ids]), [['exclude', []], ['clear', []]]);
  assert.equal(saves[0].row_decisions[0].note, '<script>not evaluated</script>\n=1+1');
  assert.equal(h.nodes().some(node => node.type === 'script'), false); assert.match(h.html(), /&lt;script&gt;/);
  assert.equal(JSON.stringify(f), before); h.click('Discard staged changes'); assert.equal(h.button('Save staged review').props.disabled, true);
});
test('rendered interpretation requires a declared name; explicit values never alias price/marketing fields', async t => {
  const f = await fixture(), saves = [], h = harness(t, propsFor(f, { onSave: command => saves.push(command) }));
  h.change('Currency', 'USD'); h.click('Save staged review'); assert.deepEqual(saves, []); assert.match(h.text(), /a source name is required/);
  h.change('Source name', '  Synthetic MLS  '); h.change('Provenance note', 'Test-only\nstatement'); h.change('Consideration field', 'current_price');
  h.change('Marketing time field', 'cumulative_days_on_market'); h.change('Source use confirmation', true); h.click('Save staged review');
  const declared = saves[0].source_interpretation; assert.equal(declared.source_name, 'Synthetic MLS'); assert.equal(declared.consideration_field, 'current_price');
  assert.equal(declared.marketing_time_field, 'cumulative_days_on_market'); assert.equal(declared.living_area_unit, null);
  assert.equal(declared.source_use_confirmed, true); assert.deepEqual(saves[0].row_decisions, []);
});
for (const blocked of [{ readOnly: true }, { busy: true }, { reloadRequired: true }, { reviewState: null }])
  test(`rendered ${Object.keys(blocked)[0]} blocks direct stale save/stage/input callbacks`, async t => {
    const f = await fixture(), saves = [], h = harness(t, propsFor(f, { onSave: body => saves.push(body) }));
    h.click('Stage exclude row 2'); const save = h.button('Save staged review').props.onClick, stage = h.button('Stage clear row 3').props.onClick;
    const sourceEdit = h.field('Source name').props.onChange; h.render({ ...h.props, ...blocked });
    save(); stage(); sourceEdit({ currentTarget: { value: 'stale' } }); assert.deepEqual(saves, []);
    assert.equal(Boolean(h.button('Save staged review').props.disabled), true);
  });
test('rendered page change drops hidden staged rows but preserves source edit and rejects old page callbacks', async t => {
  const first = await fixture({ limit: 1 }), second = await fixture({ after: 2, limit: 1 }), saves = [], h = harness(t, propsFor(first, { onSave: body => saves.push(body) }));
  h.change('Source name', 'Synthetic staged source'); h.click('Stage exclude row 2'); const oldSave = h.button('Save staged review').props.onClick;
  h.render({ ...h.props, page: second.page, reviewState: second.state, proposals: second.proposals }); oldSave(); assert.deepEqual(saves, []);
  assert.equal(h.field('Source name').props.value, 'Synthetic staged source'); assert.doesNotMatch(h.text(), /Source row 2/);
  h.click('Stage clear row 3'); h.click('Save staged review'); assert.deepEqual(saves[0].row_decisions, [decision(3, 'clear')]);
});
test('rendered durable revision/session changes reset staging; disposed callbacks cannot save', async t => {
  const f = await fixture(), saves = [], h = harness(t, propsFor(f, { onSave: body => saves.push(body) }));
  h.change('Source name', 'unsaved'); h.click('Stage exclude row 2'); const oldSave = h.button('Save staged review').props.onClick;
  h.render({ ...h.props, identity: { ...identity, sessionKey: 'new-session' } }); oldSave(); assert.deepEqual(saves, []);
  assert.equal(h.field('Source name').props.value, ''); h.click('Stage exclude row 2');
  const later = { ...f.state, revision: 1, last_review_id: REVIEW, source_interpretation: source(), source_review_id: REVIEW };
  h.render({ ...h.props, reviewState: later }); assert.equal(h.field('Source name').props.value, 'Synthetic MLS');
  assert.equal(h.button('Save staged review').props.disabled, true); h.click('Stage clear row 2'); const disposed = h.button('Save staged review').props.onClick;
  h.dispose(); disposed(); assert.deepEqual(saves, []);
});
test('rendered recovery remains explicit and readable while readonly; busy does not allow reload callbacks', async t => {
  const f = await fixture(); let reloads = 0; const h = harness(t, propsFor(f, { readOnly: true, reloadRequired: true, onReload: () => { reloads++; } }));
  assert.match(h.text(), /uncertain operation ID must be preserved/); h.click('Reload saved review'); assert.equal(reloads, 1);
  const old = h.button('Reload saved review').props.onClick; h.render({ ...h.props, busy: true }); old(); assert.equal(reloads, 1);
  assert.equal(h.field('Source name').props.disabled, true);
});
