import test from 'node:test';
import assert from 'node:assert/strict';
import { CACHED_SALE_WITNESS_FIELDS as FIELDS, CACHED_SALE_WITNESS_LIMITS as LIMITS,
  CACHED_SALE_WITNESS_SQL as SQL, prepareCachedSaleWitness as prepare } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';

const entry = (state = 'absent', json_type = null, value_text = null, utf8_bytes = null) => ({ state, json_type, value_text, utf8_bytes });
const scalar = (text, kind = 'string') => entry('scalar', kind, text, Buffer.byteLength(text));
function fixture(root_state = 'object', root_json_type = 'object') {
  return { witness_version: 1, root_state, root_json_type,
    fields: Object.fromEntries(FIELDS.map(key => [key, entry(root_state === 'object' ? 'absent' : 'payload_unavailable')])) };
}
function fails(value, reason) {
  assert.throws(() => prepare(value), error => error.code === 'CACHED_SALE_WITNESS_INVALID' && (!reason || error.reason === reason));
}

test('installed vocabulary and SQL use only fixed src paths, bounded scalars and no full payload transfer', () => {
  assert.equal(FIELDS.length, 28); assert.equal(new Set(FIELDS).size, 28);
  assert.ok(Object.isFrozen(FIELDS)); assert.ok(Object.isFrozen(LIMITS));
  assert.equal(LIMITS.scalar_utf8_bytes, 512); assert.equal(LIMITS.witness_utf8_bytes, 24_576);
  for (const name of FIELDS) assert.ok(SQL.includes(`('${name}')`));
  assert.match(SQL, /FROM \(VALUES /); assert.match(SQL, /src\.raw_payload ->> keys\.name/);
  assert.match(SQL, /octet_length\(witness\.body::text\) <= 24576/);
  assert.match(SQL, /ELSE NULL::jsonb END/);
  assert.doesNotMatch(SQL, /jsonb_each|SELECT\s+src\.raw_payload\b|raw_payload::text|PrivateRemarks|PublicRemarks|OwnerName|ListAgent|Contact|\$\d/i);
});

test('empty object means all allowlisted fields are absent, not that a sale or its source is complete', () => {
  const result = prepare(fixture());
  assert.deepEqual(result.fields.ClosePrice, entry());
  assert.equal(Object.hasOwn(result, 'complete'), false);
  assert.equal(Object.hasOwn(result, 'supported'), false);
  assert.deepEqual(Object.keys(result), ['witness_version', 'root_state', 'root_json_type', 'fields']);
});

for (const [root, type] of [['sql_null', null], ['json_null', 'null'], ...['array', 'string', 'number', 'boolean'].map(type => ['non_object', type])]) {
  test(`unavailable root stays explicit: ${root}/${type}`, () => {
    const result = prepare(fixture(root, type));
    assert.equal(result.root_state, root); assert.equal(result.root_json_type, type);
    assert.ok(Object.values(result.fields).every(value => value.state === 'payload_unavailable'));
  });
}

test('field absence, JSON null, empty text, whitespace, numeric zero and boolean false remain different', () => {
  const input = fixture();
  Object.assign(input.fields, { ClosePrice: entry('json_null', 'null'), CurrentPrice: scalar(''),
    StandardStatus: scalar('  '), DaysOnMarket: scalar('0', 'number'), PropertyAttachedYN: scalar('false', 'boolean') });
  const result = prepare(input);
  for (const key of ['ClosePrice', 'CurrentPrice', 'StandardStatus', 'DaysOnMarket', 'PropertyAttachedYN']) assert.deepEqual(result.fields[key], input.fields[key]);
  assert.equal(result.fields.ListPrice.state, 'absent');
});

test('exact stored numeric text is retained beyond Number precision without currency or unit inference', () => {
  const input = fixture();
  input.fields.ClosePrice = scalar('9007199254740993.0100', 'number');
  input.fields.LivingArea = scalar('1850.1250', 'number');
  const result = prepare(input);
  assert.equal(result.fields.ClosePrice.value_text, '9007199254740993.0100');
  assert.equal(result.fields.LivingArea.value_text, '1850.1250');
  assert.equal(result.fields.Currency.state, 'absent'); assert.equal(result.fields.LivingAreaUnits.state, 'absent');
});

test('source and normalized-source vocabulary does not choose between conflicting claims', () => {
  const input = fixture();
  input.fields.MlsStatus = scalar('Closed'); input.fields.StandardStatus = scalar('Active');
  input.fields.ClosePrice = scalar('100'); input.fields.CurrentPrice = scalar('200');
  assert.deepEqual(prepare(input), input);
});

test('arrays and objects are acknowledged without retaining their contents', () => {
  const input = fixture(); input.fields.StructureType = entry('non_scalar', 'array');
  input.fields.PropertyType = entry('non_scalar', 'object');
  assert.deepEqual(prepare(input), input);
});

test('individual oversize scalars preserve bounded type and length metadata, not partial data', () => {
  const input = fixture(); input.fields.StructuralStyle = entry('oversize', 'string', null, 513);
  input.fields.ClosePrice = entry('oversize', 'number', null, 800);
  assert.deepEqual(prepare(input), input);
  input.fields.StructuralStyle.value_text = 'partial'; fails(input, 'oversize_mismatch');
});

test('UTF8 byte limits preserve multibyte text, not just JS character counts', () => {
  const input = fixture(); input.fields.StructuralStyle = scalar('é'.repeat(256));
  assert.equal(prepare(input).fields.StructuralStyle.utf8_bytes, 512);
  input.fields.StructuralStyle = scalar('é'.repeat(257)); fails(input, 'scalar_mismatch');
});

test('bounded control text and markup are literal stored observations, never HTML or a taxonomy', () => {
  const input = fixture(); input.fields.StructuralStyle = scalar('<b>Condo</b>\nTownhome\t');
  assert.deepEqual(prepare(input).fields.StructuralStyle, input.fields.StructuralStyle);
});

test('whole encoding expansion and SQL overflow sentinel reject atomically', () => {
  const input = fixture();
  for (const key of FIELDS) input.fields[key] = scalar('\u0001'.repeat(512));
  fails(input, 'witness_byte_limit'); fails(null, 'witness_byte_limit');
});

test('admission copies/freeze results without freezing or retaining caller input', () => {
  const input = fixture(), result = prepare(input);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.fields)); assert.ok(Object.isFrozen(result.fields.ClosePrice));
  assert.equal(Object.isFrozen(input), false);
  input.fields.ClosePrice.state = 'changed'; assert.equal(result.fields.ClosePrice.state, 'absent');
});

test('unknown/missing keys, roots, versions and nonplain values reject', () => {
  for (const mutate of [value => { value.extra = true; }, value => { delete value.fields.ClosePrice; },
    value => { value.fields.PrivateRemarks = entry(); }, value => { value.witness_version = 2; },
    value => { value.witness_version = '1'; }, value => { value.root_state = 'absent'; },
    value => { value.root_json_type = 'string'; }, value => { value.fields.ClosePrice.extra = true; },
    value => { value.fields = []; }, value => { Object.setPrototypeOf(value.fields, null); },
    value => { value[Symbol('hidden')] = true; }]) {
    const value = fixture(); mutate(value); fails(value);
  }
  for (const value of [undefined, false, 0, '', [], new Date(), Object.create(null)]) fails(value);
});

test('inconsistent presence, type, value and byte metadata rejects', () => {
  const bad = [entry('absent', 'null'), entry('json_null'), entry('non_scalar', 'number'), entry('payload_unavailable'),
    entry('oversize', 'string', null, 512), entry('oversize', 'boolean', null, 600), entry('oversize', 'string', null, 2_147_483_648),
    entry('scalar', 'string', '', -0), entry('scalar', 'string', 'é', 1), entry('scalar', 'number', '01', 2),
    scalar('NaN', 'number'), scalar('TRUE', 'boolean'), scalar('\u0000'), scalar('\ud800')];
  for (const item of bad) { const value = fixture(); value.fields.ClosePrice = item; fails(value); }
  const unavailable = fixture('sql_null', null); unavailable.fields.ClosePrice = entry(); fails(unavailable, 'root_field_mismatch');
});

test('getters, hidden properties and proxies reject before any user getter/trap is invoked', () => {
  let calls = 0;
  const getter = fixture(); Object.defineProperty(getter, 'fields', { enumerable: true, get() { calls++; throw new Error('getter ran'); } });
  fails(getter, 'data_properties_required');
  const fieldGetter = fixture(); Object.defineProperty(fieldGetter.fields.ClosePrice, 'state', { enumerable: true, get() { calls++; } });
  fails(fieldGetter, 'data_properties_required');
  const hidden = fixture(); Object.defineProperty(hidden, 'witness_version', { value: 1, enumerable: false }); fails(hidden, 'data_properties_required');
  const trap = new Proxy({}, { get() { calls++; }, ownKeys() { calls++; }, getPrototypeOf() { calls++; } });
  fails(trap, 'shape');
  const nested = fixture(); nested.fields.ClosePrice = trap; fails(nested, 'shape');
  const revoked = Proxy.revocable({}, {}); revoked.revoke(); fails(revoked.proxy, 'shape');
  assert.equal(calls, 0);
});
