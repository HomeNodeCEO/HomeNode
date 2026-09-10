import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { proposeAssignmentSalesMatchPage } from '../src/services/assignmentSalesCsv/matchProposals.js';
import { validateAssignmentSalesReviewCommand as validate, buildAssignmentSalesReviewPayload as build,
  ASSIGNMENT_SALES_REVIEW_LIMITS } from '../src/services/assignmentSalesCsv/review.js';

const A = '00000000000000001', B = '00000000000000002';
const R = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const receipt = index => index === 0 ? R : `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`;
const at = '2026-09-10T12:00:00.123456Z';
const clone = value => JSON.parse(JSON.stringify(value));
const source = changes => ({ source_name: ' Synthetic source ', provenance_note: 'Provided export\nReview note\tkept.',
  currency: null, living_area_unit: null, site_area_unit: null, consideration_field: null,
  marketing_time_field: null, source_use_confirmed: false, ...changes });
const decision = changes => ({ receipt_id: R, source_row_number: 2, decision: 'confirm_proposed_match', account_ids: [A], note: '', ...changes });
const command = changes => ({ review_version: 1, expected_revision: 0, source_interpretation: null, row_decisions: [decision()], ...changes });
const code = suffix => ({ code: `assignment_sales_import_${suffix}` });
const quote = text => /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
async function fixture({ records = [{}], evidenceFor, observedAt = at } = {}) {
  const defaults = { ListingId: 'S1', CloseDate: '2020-01-01', ClosePrice: '282500', ParcelNumber: A,
    ParcelNumber2: '', Address: '1 Synthetic Drive', City: 'Garland', County: 'Dallas', PostalCode: '75041',
    MlsStatus: 'Closed', BuyerFinancing: 'Conventional', SellerContributions: '0', StructuralStyle: 'Single Detached' };
  const actual = records.map((record, index) => ({ ...defaults, ListingId: `S${index + 1}`, ...record }));
  const headers = [...new Set(actual.flatMap(Object.keys))];
  const bytes = Buffer.from([headers, ...actual.map(row => headers.map(key => row[key] ?? ''))].map(cells => cells.map(quote).join(',')).join('\n'));
  return fromBytes(bytes, evidenceFor, observedAt);
}
async function fromBytes(bytes, evidenceFor, observedAt = at) {
  const prepared = prepareAssignmentSalesCsv(bytes), { rows: data, ...header } = prepared;
  const rows = data.map((record_data, index) => ({ receipt_id: receipt(index), source_row_number: record_data.source_row_number, record_data }));
  const batch = { batch_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', source_sha256: prepared.source_sha256,
    preparation_sha256: digestPreparedSalesParts(header, data) };
  const candidate = id => ({ account_id: id, address: '1 Synthetic Dr', city: 'GARLAND', county: 'DALLAS', postal_code: '75041' });
  const proposalPage = await proposeAssignmentSalesMatchPage({ batch, rows }, { readCandidates: ({ requests }) => ({
    observed_at: observedAt, results: requests.map(request => ({ request_id: request.request_id,
      ...(evidenceFor ? evidenceFor(request, candidate) : { status: 'complete', candidates: [candidate(request.identifier || A)] }) })) }) });
  return { command: command(), rows, proposalPage };
}

test('command snapshot keeps explicit unknowns and normalizes only documented identity/order/name fields', () => {
  const input = command({ source_interpretation: source(), row_decisions: [decision({ receipt_id: R.toUpperCase(), account_ids: [B, A] })] });
  const before = clone(input), value = validate(input);
  assert.equal(value.source_interpretation.source_name, 'Synthetic source');
  assert.equal(value.source_interpretation.provenance_note, before.source_interpretation.provenance_note);
  assert.equal(value.source_interpretation.currency, null);
  assert.equal(value.source_interpretation.source_use_confirmed, false);
  assert.equal(value.row_decisions[0].receipt_id, R);
  assert.deepEqual(value.row_decisions[0].account_ids, [A, B]);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(value.source_interpretation)); assert.ok(Object.isFrozen(value.row_decisions[0].account_ids));
});

test('batch-only interpretation and explicit clear/exclude commands are valid; no-op is not', () => {
  assert.deepEqual(validate(command({ source_interpretation: source(), row_decisions: [] })).row_decisions, []);
  for (const choice of ['clear', 'exclude']) assert.equal(validate(command({ row_decisions: [decision({ decision: choice, account_ids: [] })] })).row_decisions[0].decision, choice);
  assert.throws(() => validate(command({ row_decisions: [] })), code('invalid_input'));
});

test('supported declaration choices remain separate from original normalized values', async () => {
  const input = await fixture({ records: [{ CurrentPrice: '285000', Currency: 'CAD', LivingAreaUnits: 'Square Meters', DaysOnMarket: '0' }] });
  input.command.source_interpretation = source({ currency: 'USD', living_area_unit: 'sqft', site_area_unit: 'acre',
    consideration_field: 'current_price', marketing_time_field: 'cumulative_days_on_market', source_use_confirmed: true });
  const value = await build(input), row = value.row_decisions[0];
  assert.equal(value.source_interpretation.consideration_field, 'current_price');
  assert.equal(value.source_interpretation.marketing_time_field, 'cumulative_days_on_market');
  assert.equal(row.record_data.values.current_price, '285000'); assert.equal(row.record_data.values.close_price, '282500');
  assert.equal(row.record_data.values.currency, 'CAD'); assert.equal(row.record_data.values.living_area_units, 'Square Meters');
  assert.equal(row.record_data.values.days_on_market, 0); assert.equal(Object.hasOwn(row.record_data.values, 'cumulative_days_on_market'), false);
  assert.equal(value.analysis_status, 'not_evaluated');
});

test('genuine fresh proposal is retained as identity-only evidence with the original server row', async () => {
  const input = await fixture(), value = await build(input), row = value.row_decisions[0];
  assert.deepEqual(Object.keys(value).sort(), ['analysis_status', 'matching_status', 'review_version', 'row_decisions', 'source_interpretation']);
  assert.equal(value.matching_status, 'reviewed_separately'); assert.equal(value.analysis_status, 'not_evaluated');
  assert.deepEqual(row.record_data, input.rows[0].record_data);
  assert.equal(row.record_data.persisted, false, 'retain original preparation field; owner produces separate committed receipt');
  assert.equal(row.match_evidence.observed_at, at);
  assert.deepEqual(row.match_evidence.binding, input.proposalPage.binding);
  assert.deepEqual(row.match_evidence.proposal, input.proposalPage.rows[0]);
  assert.equal(row.match_evidence.proposal.accepted, false); assert.equal(row.match_evidence.proposal.review_required, true);
  assert.ok(Object.isFrozen(row.match_evidence.lookups[0].candidates[0]));
  assert.equal(Object.hasOwn(row, 'eligible'), false); assert.equal(Object.hasOwn(value, 'source_rights_granted'), false);
});

test('only reviewed records and their exact lookup subset are retained in a mixed page', async () => {
  const input = await fixture({ records: [{}, { ParcelNumber: B, Address: '2 Other Dr' }] });
  input.command.row_decisions = [decision()];
  const value = await build(input), evidence = value.row_decisions[0].match_evidence;
  assert.equal(value.row_decisions.length, 1);
  assert.deepEqual(evidence.lookups.map(lookup => lookup.request_id), input.proposalPage.rows[0].lookup_ids);
  assert.ok(evidence.lookups.length < input.proposalPage.lookups.length);
  assert.equal(JSON.stringify(value).includes('2 Other Dr'), false);
});

test('changed observation time does not cause a stale page-hash comparison', async () => {
  const first = await build(await fixture()), second = await build(await fixture({ observedAt: '2026-09-10T12:01:00.123456Z' }));
  assert.deepEqual(first.row_decisions[0].account_ids, second.row_decisions[0].account_ids);
  assert.notEqual(first.row_decisions[0].match_evidence.observed_at, second.row_decisions[0].match_evidence.observed_at);
});

test('two supplied parcels confirm as the same sorted exact set without changing original proposal order', async () => {
  const input = await fixture({ records: [{ ParcelNumber: B, ParcelNumber2: A, Address: '' }] });
  input.command.row_decisions[0].account_ids = [B, A];
  const value = await build(input);
  assert.deepEqual(value.row_decisions[0].account_ids, [A, B]);
  assert.deepEqual(value.row_decisions[0].match_evidence.proposal.proposed_account_ids, [B, A]);
});

test('exclusions and clears can retain rejected and empty actual receipts without proposing a match', async () => {
  const input = await fromBytes(Buffer.from('Address,CloseDate,ClosePrice\n1 Synthetic Dr,2020-01-01\n,,\n'));
  input.command.row_decisions = input.rows.map((row, index) => decision({ receipt_id: row.receipt_id,
    source_row_number: row.source_row_number, decision: index ? 'clear' : 'exclude', account_ids: [], note: 'Review\r\nretained\tnote' }));
  input.proposalPage = null;
  const value = await build(input);
  assert.deepEqual(value.row_decisions.map(row => row.record_data.preparation_disposition), ['rejected', 'empty']);
  assert.deepEqual(value.row_decisions.map(row => row.match_evidence), [null, null]);
  assert.deepEqual(value.row_decisions.map(row => row.account_ids), [[], []]);
});

test('batch-only declarations never require rows, candidates or an invented capture', async () => {
  const value = await build({ command: command({ source_interpretation: source(), row_decisions: [] }), rows: [], proposalPage: null });
  assert.deepEqual(value.row_decisions, []); assert.equal(value.source_interpretation.source_use_confirmed, false);
  assert.equal(value.analysis_status, 'not_evaluated');
});

for (const fields of [{ source_name: '' }, { source_name: '  ' }, { source_name: 'x'.repeat(201) },
  { source_name: 'hidden\nsource' }, { provenance_note: '\u0000' }, { provenance_note: '\u000b' },
  { provenance_note: '\u007f' }, { provenance_note: '\u0085' }, { provenance_note: 'x'.repeat(1001) },
  { currency: 'CAD' }, { living_area_unit: 'Square Feet' }, { site_area_unit: 'hectare' },
  { consideration_field: 'sale_price' }, { marketing_time_field: 'dom' }, { source_use_confirmed: 'true' },
  { authority: 'approved' }]) {
  test(`unsupported source declaration fails closed: ${JSON.stringify(fields)}`, () => {
    assert.throws(() => validate(command({ source_interpretation: source(fields) })), code('invalid_input'));
  });
}

for (const fields of [{ receipt_id: 'not-an-id' }, { source_row_number: 1 }, { source_row_number: 10002 },
  { source_row_number: '2' }, { decision: 'include' }, { account_ids: [] }, { account_ids: [A, A] },
  { account_ids: [' ' + A] }, { account_ids: [''] }, { account_ids: ['x'.repeat(129)] },
  { account_ids: [7] }, { account_ids: [A + '\n'] }, { note: '\u0000' }, { note: 'x'.repeat(1001) },
  { supported: true }, { decision: 'exclude' }, { decision: 'clear' }]) {
  test(`invalid row review fails closed: ${JSON.stringify(fields)}`, () => {
    assert.throws(() => validate(command({ row_decisions: [decision(fields)] })), code('invalid_input'));
  });
}

test('all fields are required with no implicit unknown, default decision or forged actor', () => {
  for (const key of Object.keys(command())) { const value = command(); delete value[key]; assert.throws(() => validate(value), code('invalid_input')); }
  for (const key of Object.keys(source())) { const value = command({ source_interpretation: source() }); delete value.source_interpretation[key]; assert.throws(() => validate(value), code('invalid_input')); }
  for (const key of Object.keys(decision())) { const value = command(); delete value.row_decisions[0][key]; assert.throws(() => validate(value), code('invalid_input')); }
  assert.throws(() => validate(command({ actor_user_id: R })), code('invalid_input'));
  assert.throws(() => validate(command({ review_version: 2 })), code('invalid_input'));
});

test('revision bounds reserve the next positive int32 value; no coercion or fractional revisions', () => {
  for (const value of [0, 2147483646]) assert.equal(validate(command({ expected_revision: value })).expected_revision, value);
  for (const value of [-1, 0.5, 2147483647, Number.MAX_SAFE_INTEGER, '0', null, NaN, Infinity]) {
    assert.throws(() => validate(command({ expected_revision: value })), code('invalid_input'));
  }
});

test('duplicate receipt identities after UUID normalization and repeated ordinals are rejected', () => {
  assert.throws(() => validate(command({ row_decisions: [decision(), decision({ receipt_id: R.toUpperCase(), source_row_number: 3 })] })), code('invalid_input'));
  assert.throws(() => validate(command({ row_decisions: [decision(), decision({ receipt_id: receipt(1) })] })), code('invalid_input'));
});

test('100 decisions and five accounts are supported, excess and sparse arrays rejected without clipping', () => {
  const rows = Array.from({ length: 100 }, (_, i) => decision({ receipt_id: receipt(i), source_row_number: i + 2, decision: 'clear', account_ids: [] }));
  assert.equal(validate(command({ row_decisions: rows })).row_decisions.length, 100);
  assert.throws(() => validate(command({ row_decisions: [...rows, decision()] })), code('invalid_input'));
  const ids = Array.from({ length: 5 }, (_, i) => String(i + 1).padStart(17, '0'));
  assert.equal(validate(command({ row_decisions: [decision({ account_ids: ids })] })).row_decisions[0].account_ids.length, 5);
  assert.throws(() => validate(command({ row_decisions: [decision({ account_ids: [...ids, 'other'] })] })), code('invalid_input'));
  assert.throws(() => validate(command({ row_decisions: new Array(1) })), code('invalid_input'));
});

test('getters, proxies, inherited behavior, cycles and malformed Unicode never execute caller behavior', () => {
  let calls = 0;
  const getter = command(); Object.defineProperty(getter, 'expected_revision', { enumerable: true, get() { calls++; return 0; } });
  const proxy = new Proxy(command(), { ownKeys() { calls++; return []; } });
  const cycle = command(); cycle.self = cycle;
  const custom = Object.assign(Object.create({ toJSON() { calls++; return command(); } }), command());
  for (const value of [getter, proxy, cycle, custom, command({ source_interpretation: source({ source_name: '\ud800' }) })]) {
    assert.throws(() => validate(value), code('invalid_input'));
  }
  assert.equal(calls, 0);
});

test('wrong receipt, ordinal, incomplete account set or stale changed candidate is rejected', async () => {
  for (const changes of [{ receipt_id: receipt(20) }, { source_row_number: 3 }, { account_ids: [B] }, { account_ids: [A, B] }]) {
    const input = await fixture(); input.command.row_decisions[0] = decision(changes);
    await assert.rejects(build(input), code('stale_match'));
  }
  const input = await fixture({ records: [{ ParcelNumber2: B, Address: '' }] });
  await assert.rejects(build(input), code('stale_match'));
});

for (const records of [[{ ListingId: 'same' }, { ListingId: 'same' }],
  [{ ListingId: 'same', ClosePrice: '1' }, { ListingId: 'same', ClosePrice: '2' }]]) {
  test('genuine duplicate/conflicting intake status cannot be confirmed by a forged proposed flag', async () => {
    const input = await fixture({ records }), target = input.rows[1];
    input.command.row_decisions = [decision({ receipt_id: target.receipt_id, source_row_number: target.source_row_number })];
    input.proposalPage = clone(input.proposalPage); input.proposalPage.rows[1].proposal_status = 'proposed';
    input.proposalPage.rows[1].proposed_account_ids = [A];
    await assert.rejects(build(input), code('stale_match'));
  });
}

test('a forged page cannot bypass the actual kernel unit/building rule', async () => {
  const input = await fixture({ records: [{ Address: '1 Synthetic Dr Unit 3' }] });
  assert.equal(input.proposalPage.rows[0].proposal_status, 'review_required');
  input.proposalPage = clone(input.proposalPage);
  Object.assign(input.proposalPage.rows[0], { proposal_status: 'proposed', proposed_account_ids: [A], method: 'supplied_parcel_identifiers', reasons: [] });
  await assert.rejects(build(input), code('stale_match'));
});

test('fresh unresolved, unavailable or ambiguous proposals are never identity confirmations', async () => {
  for (const outcome of [{ status: 'complete', candidates: [] }, { status: 'unavailable', candidates: [] }]) {
    const input = await fixture({ evidenceFor: () => outcome }); await assert.rejects(build(input), code('stale_match'));
  }
  const input = await fixture({ evidenceFor: (_request, candidate) => ({ status: 'complete', candidates: [candidate(A), candidate(B)] }) });
  await assert.rejects(build(input), code('stale_match'));
});

test('request/evidence omissions, altered selected flags and forged analysis status fail exact kernel replay', async () => {
  for (const mutate of [page => { page.lookups.pop(); }, page => { page.lookups.push(page.lookups[0]); },
    page => { page.lookups[0].request.identifier = B; }, page => { page.rows[0].accepted = true; },
    page => { page.analysis_status = 'ready'; }, page => { page.rows[0].proposed_account_ids = [B]; }]) {
    const input = await fixture(); input.proposalPage = clone(input.proposalPage); mutate(input.proposalPage);
    await assert.rejects(build(input), code('stale_match'));
  }
});

test('all caller inputs are snapshotted before async pure replay yields', async () => {
  const original = await fixture(), input = clone(original); input.command.source_interpretation = source();
  const pending = build(input);
  input.command.row_decisions[0].account_ids[0] = B; input.command.source_interpretation.currency = 'USD';
  input.rows[0].record_data.values.parcel_number_raw = B;
  input.proposalPage.lookups[0].candidates[0].account_id = B;
  const value = await pending;
  assert.deepEqual(value.row_decisions[0].account_ids, [A]); assert.equal(value.source_interpretation.currency, null);
  assert.deepEqual(value.row_decisions[0].record_data, original.rows[0].record_data);
  assert.deepEqual(value.row_decisions[0].match_evidence.proposal, original.proposalPage.rows[0]);
});

test('builder rejects malformed server row identity and forged outer payload properties', async () => {
  for (const mutate of [input => { input.rows[0].record_data.source_row_number = 3; },
    input => { input.rows.push(clone(input.rows[0])); }, input => { input.rows = new Array(1); },
    input => { input.rows[0].receipt_id = 'not-a-receipt'; }, input => { input.actor_user_id = R; },
    input => { input.proposalPage.private_owner = 'not allowed'; }]) {
    const input = clone(await fixture()); mutate(input);
    await assert.rejects(build(input), code('invalid_input'));
  }
});

test('builder rejects getters in raw stored rows and fresh evidence without invoking them', async () => {
  let touches = 0;
  const input = clone(await fixture());
  Object.defineProperty(input.rows[0].record_data, 'raw_cells', { enumerable: true, get() { touches++; return []; } });
  await assert.rejects(build(input), code('invalid_input'));
  const another = clone(await fixture());
  another.proposalPage.lookups[0].candidates[0] = new Proxy({}, { ownKeys() { touches++; return []; } });
  await assert.rejects(build(another), code('invalid_input'));
  assert.equal(touches, 0);
});

test('stored row material cannot change while retaining an old proposed flag/evidence', async () => {
  const input = clone(await fixture()); input.rows[0].record_data.values.parcel_number_raw = B;
  await assert.rejects(build(input), code('stale_match'));
});

test('malformed or foreign fresh evidence cannot become an accepted match', async () => {
  for (const mutate of [page => { page.binding.source_sha256 = 'bad'; },
    page => { page.observed_at = '2026-02-30T00:00:00Z'; },
    page => { page.lookups[0].status = 'verified'; },
    page => { page.lookups[0].candidates[0].private_data = 'not requested'; },
    page => { page.rows[0].receipt_id = receipt(20); }]) {
    const input = clone(await fixture()); mutate(input.proposalPage);
    await assert.rejects(build(input), code('stale_match'));
  }
});

test('command byte ceiling is explicit even when individual Unicode notes fit their field limits', () => {
  const rows = Array.from({ length: 100 }, (_, i) => decision({ receipt_id: receipt(i), source_row_number: i + 2,
    decision: 'clear', account_ids: [], note: '\u4e00'.repeat(1000) }));
  assert.throws(() => validate(command({ row_decisions: rows })), code('preparation_limit'));
});

test('a decision list has all-or-nothing validation; one stale match cannot return earlier successes', async () => {
  const input = await fixture({ records: [{}, { ParcelNumber: B, Address: '' }] });
  input.command.row_decisions = [decision(), decision({ receipt_id: receipt(1), source_row_number: 3, account_ids: [A] })];
  await assert.rejects(build(input), code('stale_match'));
});

test('two individually valid large original rows cannot exceed the 2MiB complete review payload', async () => {
  const headers = ['Address', 'CloseDate', 'ClosePrice', ...Array.from({ length: 80 }, (_, i) => `Unused${i}`)];
  const record = ['1 Synthetic Dr', '2020-01-01', '282500', ...Array.from({ length: 80 }, () => 'x'.repeat(14000))];
  const input = await fromBytes(Buffer.from([headers, record, record].map(cells => cells.join(',')).join('\n')));
  input.command.row_decisions = input.rows.map(row => decision({ receipt_id: row.receipt_id, source_row_number: row.source_row_number,
    decision: 'exclude', account_ids: [] })); input.proposalPage = null;
  await assert.rejects(build(input), code('preparation_limit'));
  input.command.row_decisions.pop();
  const smaller = await build(input);
  assert.equal(smaller.row_decisions.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(smaller)) <= ASSIGNMENT_SALES_REVIEW_LIMITS.payload_bytes);
});
