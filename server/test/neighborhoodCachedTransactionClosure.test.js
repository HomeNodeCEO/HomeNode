import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCachedTransactionClosure, CACHED_TRANSACTION_CLOSURE_LIMITS } from '../src/services/neighborhoodAssessment/cachedTransactionClosure.js';

const transaction = (source = '1', primary = 'A', sale = null, saleAccount = null) => ({ source_record_id: source,
  sale_id: sale, primary_account_id: primary, sale_account_id: saleAccount, source_record_hash: null });
const link = (id = '1', source = '1', account = 'B', sequence = 1) => ({ parcel_link_id: id, source_record_id: source,
  source_position: 1, parcel_sequence: sequence, account_id: account, is_resolved: true });
const fixture = () => ({ selected_account_ids: ['A'], source_revision: 'trusted-resolver-capture-1',
  transactions: [transaction()], links: [link()], legacy: [] });
const reject = (input, reason) => assert.throws(() => validateCachedTransactionClosure(input),
  error => error instanceof TypeError && error.code === 'NEIGHBORHOOD_TRANSACTION_CLOSURE_INVALID' && error.reason === reason);

test('derived one-hop identities remain separate from exact selected population, and include no invented fields', () => {
  const input = fixture(); input.selected_account_ids.push('NO-SALES');
  const before = structuredClone(input), output = validateCachedTransactionClosure(input);
  assert.deepEqual(input, before);
  assert.deepEqual(output.selected_account_ids, ['A', 'NO-SALES']);
  assert.deepEqual(output.closure_account_ids, ['A', 'B']);
  assert.deepEqual(output.source_record_ids, ['1']); assert.deepEqual(output.legacy_sale_ids, []);
  assert.equal(output.version, 1); assert.match(output.closure_sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(output.links[0]), true);
  assert.equal(Object.hasOwn(output, 'membership_complete'), false);
  assert.equal(Object.hasOwn(output, 'authorized'), false);
  input.links[0].account_id = 'C'; assert.equal(output.links[0].account_id, 'B');
});

test('only surrounding spaces normalize; Collin prefixes, punctuation, leading zeroes and case survive', () => {
  const input = fixture(); input.selected_account_ids = ['  R-001  '];
  input.transactions[0].primary_account_id = ' R-001 '; input.links[0].account_id = ' r001 ';
  const output = validateCachedTransactionClosure(input);
  assert.deepEqual(output.selected_account_ids, ['R-001']); assert.deepEqual(output.closure_account_ids, ['R-001', 'r001']);
  const normalized = structuredClone(input); normalized.selected_account_ids[0] = 'R-001'; normalized.transactions[0].primary_account_id = 'R-001';
  normalized.links[0].account_id = 'r001'; assert.equal(validateCachedTransactionClosure(normalized).closure_sha256, output.closure_sha256);
  input.selected_account_ids.push('R-001'); reject(input, 'duplicate_selected_account');
});

test('each source must directly touch original selected accounts, never a newly discovered second hop', () => {
  const input = fixture(); input.transactions.push(transaction('2', 'B')); input.links.push(link('2', '2', 'C'));
  reject(input, 'unanchored_source');
  // A direct association to A makes this a separately seeded source, not recursion.
  input.links.push(link('3', '2', 'A', 2));
  assert.deepEqual(validateCachedTransactionClosure(input).closure_account_ids, ['A', 'B', 'C']);
  const linkOnly = fixture(); linkOnly.transactions[0].primary_account_id = null; linkOnly.links[0].account_id = 'A';
  assert.deepEqual(validateCachedTransactionClosure(linkOnly).closure_account_ids, ['A']);
  const saleOnly = fixture(); saleOnly.transactions = [transaction('1', null, '2', 'A')];
  assert.deepEqual(validateCachedTransactionClosure(saleOnly).closure_account_ids, ['A', 'B']);
});

test('unknown, false, and unresolved-null association metadata is retained without declaring complete membership', () => {
  const input = fixture(); input.links = [link('1', '1', null), link('2', '1', 'B', 2), link('3', '1', null, 3)];
  input.links[0].is_resolved = null; input.links[1].is_resolved = false; input.links[2].is_resolved = false;
  const output = validateCachedTransactionClosure(input);
  assert.deepEqual(output.links.map(row => row.is_resolved), [null, false, false]);
  assert.deepEqual(output.links.map(row => row.account_id), [null, 'B', null]);
  assert.deepEqual(output.closure_account_ids, ['A', 'B']);
  for (const bad of [undefined, 'true', 'false', 0, 1]) {
    const changed = structuredClone(input); changed.links[0].is_resolved = bad;
    reject(changed, bad === undefined ? 'link' : 'is_resolved');
  }
});

test('exact source identity groups permit multiple distinct sale representations but forbid contradictory metadata', () => {
  const input = fixture(); input.transactions = [transaction('1', 'A', '9007199254740993', 'B'), transaction('1', 'A', '9007199254740994', 'C')];
  const output = validateCachedTransactionClosure(input);
  assert.deepEqual(output.source_record_ids, ['1']); assert.deepEqual(output.closure_account_ids, ['A', 'B', 'C']);
  for (const mutate of [row => { row.primary_account_id = 'B'; }, row => { row.source_record_hash = 'another-revision'; }]) {
    const changed = structuredClone(input); mutate(changed.transactions[1]); reject(changed, 'source_identity_mismatch');
  }
  input.transactions.push(transaction('1', 'A')); reject(input, 'source_identity_mismatch');
});

test('all duplicate identity collisions reject instead of silently overwriting evidence', () => {
  let input = fixture(); input.transactions.push({ ...input.transactions[0] }); reject(input, 'duplicate_transaction');
  input = fixture(); input.transactions = [transaction('1', 'A', '8', 'A'), transaction('2', 'A', '8', 'A')]; reject(input, 'duplicate_sale_id');
  input = fixture(); input.links.push({ ...input.links[0] }); reject(input, 'duplicate_link');
  input = fixture(); input.links.push({ ...input.links[0], parcel_link_id: '2' }); reject(input, 'duplicate_link');
  input = fixture(); input.links.push({ ...input.links[0], parcel_sequence: 2 }); reject(input, 'duplicate_link');
  input = fixture(); input.legacy = [{ sale_id: '8', sale_account_id: 'A' }, { sale_id: '8', sale_account_id: 'A' }]; reject(input, 'duplicate_sale_id');
  input = fixture(); input.transactions[0] = transaction('1', 'A', '8', 'A'); input.legacy = [{ sale_id: '8', sale_account_id: 'A' }]; reject(input, 'duplicate_sale_id');
});

test('legacy sales must directly belong to selected accounts and every link must refer to a returned source', () => {
  const input = fixture(); input.legacy = [{ sale_id: '7', sale_account_id: 'B' }]; reject(input, 'legacy_not_selected');
  input.legacy[0].sale_account_id = 'A';
  const output = validateCachedTransactionClosure(input); assert.deepEqual(output.legacy_sale_ids, ['7']);
  input.links[0].source_record_id = '2'; reject(input, 'unknown_source_link');
});

test('bigint IDs remain positive exact strings, and links require positive smallint positions', () => {
  for (const bad of [1, 9007199254740992, 1n, '01', '0', '-1', '1.0', '1e3', '', null, '9223372036854775808']) {
    const input = fixture(); input.transactions[0].source_record_id = bad; reject(input, 'source_record_id');
  }
  for (const bad of [0, -1, 1.5, 32768, '1', null]) {
    const input = fixture(); input.links[0].source_position = bad; reject(input, 'parcel_position');
    input.links[0].source_position = 1; input.links[0].parcel_sequence = bad; reject(input, 'parcel_position');
  }
  const input = fixture(); input.transactions[0].source_record_id = '9223372036854775807'; input.links[0].source_record_id = '9223372036854775807';
  assert.deepEqual(validateCachedTransactionClosure(input).source_record_ids, ['9223372036854775807']);
});

test('accounts, source revisions, optional fields and identity-only shape reject coercion, absence and extra payloads', () => {
  for (const bad of [123, {}, true, null, '', ' ', 'a'.repeat(65), 'A\n']) {
    const input = fixture(); input.selected_account_ids[0] = bad; reject(input, 'account_id');
  }
  for (const bad of [null, '', ' ', 'revision '.repeat(26), ' revision', 123]) {
    const input = fixture(); input.source_revision = bad; reject(input, 'source_revision');
  }
  const missing = fixture(); delete missing.transactions[0].source_record_hash; reject(missing, 'transaction');
  const forged = fixture(); forged.closure_account_ids = ['A', 'B', 'PRIVATE']; reject(forged, 'input');
  const privateRow = fixture(); privateRow.transactions[0].private_remarks = 'not an allowed identity field'; reject(privateRow, 'transaction');
  const hidden = fixture(); Object.defineProperty(hidden.links[0], 'secret', { value: 'not allowed' }); reject(hidden, 'link');
  const getter = fixture(); Object.defineProperty(getter.transactions[0], 'sale_id', { get() { throw new Error('must not execute'); } }); reject(getter, 'transaction');
  const impossible = fixture(); impossible.transactions[0].sale_account_id = 'A'; reject(impossible, 'sale_identity_mismatch');
});

test('source IDs sort numerically without unsafe conversion; input permutations have identical immutable digest', () => {
  const input = fixture(); input.selected_account_ids = ['Z', 'A'];
  input.transactions = [transaction('10', 'A', '12', 'Z'), transaction('2', 'Z', '11', 'A'), transaction('9007199254740993', 'A')];
  input.links = [link('12', '10', 'B', 2), link('11', '10', null, 1), link('13', '2', 'C')];
  input.legacy = [{ sale_id: '101', sale_account_id: 'Z' }, { sale_id: '100', sale_account_id: 'A' }];
  const first = validateCachedTransactionClosure(input);
  for (const key of ['selected_account_ids', 'transactions', 'links', 'legacy']) input[key].reverse();
  assert.deepEqual(validateCachedTransactionClosure(input), first);
  assert.deepEqual(first.source_record_ids, ['2', '10', '9007199254740993']);
  assert.deepEqual(first.legacy_sale_ids, ['100', '101']);
});

test('revision, exact selection, every association field and unknown flags participate in the digest', () => {
  const initial = fixture(), digest = validateCachedTransactionClosure(initial).closure_sha256;
  for (const mutate of [input => { input.source_revision = 'capture-2'; }, input => { input.selected_account_ids.push('NO-SALES'); },
    input => { input.transactions[0].source_record_hash = 'hash-2'; }, input => { input.transactions[0].primary_account_id = 'B'; input.links[0].account_id = 'A'; },
    input => { input.links[0].parcel_link_id = '2'; }, input => { input.links[0].source_position = 2; },
    input => { input.links[0].parcel_sequence = 2; }, input => { input.links[0].is_resolved = null; },
    input => { input.links[0].account_id = null; }, input => { input.legacy.push({ sale_id: '7', sale_account_id: 'A' }); }]) {
    const input = structuredClone(initial); mutate(input); assert.notEqual(validateCachedTransactionClosure(input).closure_sha256, digest);
  }
});

test('configured limits only lower caps; identity/account overflow is atomic and byte charging precedes future row access', () => {
  for (const limits of [{ accounts: 50001 }, { identity_records: 100001 }, { bytes: 8000001 }, { bytes: 0 }, { unknown: 1 }]) {
    assert.throws(() => validateCachedTransactionClosure(fixture(), { limits }), /:limits/);
  }
  assert.equal(Object.isFrozen(CACHED_TRANSACTION_CLOSURE_LIMITS), true);
  assert.throws(() => validateCachedTransactionClosure(fixture(), { limits: { identity_records: 1 } }), /:identity_limit/);
  assert.throws(() => validateCachedTransactionClosure(fixture(), { limits: { accounts: 1 } }), /:account_limit/);
  const union = fixture(); union.selected_account_ids.push('NO-SALES');
  assert.throws(() => validateCachedTransactionClosure(union, { limits: { accounts: 2 } }), /:account_limit/, 'the distinct union, not two separate lists, shares the account cap');
  const input = fixture(); input.transactions.push(transaction('2')); input.links = [];
  Object.defineProperty(input.transactions, 1, { get() { throw new Error('future row must not be read'); } });
  assert.throws(() => validateCachedTransactionClosure(input, { limits: { bytes: 1150 } }), /:metadata_limit/);
  const sparse = fixture(); sparse.links = Array(1); reject(sparse, 'identity_array_entry');
});

test('hashing is streamed above the single-object canonical limit, while total metadata stays bounded', () => {
  const input = fixture(); input.links = []; input.transactions = [];
  for (let index = 1; index <= 15000; index++) input.transactions.push(transaction(String(index)));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 1_500_000);
  const output = validateCachedTransactionClosure(input);
  assert.equal(output.transactions.length, 15000); assert.equal(output.source_record_ids.length, 15000);
  assert.match(output.closure_sha256, /^[0-9a-f]{64}$/);
  input.transactions.reverse(); assert.equal(validateCachedTransactionClosure(input).closure_sha256, output.closure_sha256);
  assert.throws(() => validateCachedTransactionClosure(input, { limits: { bytes: 1_500_000 } }), /:metadata_limit/);
});
