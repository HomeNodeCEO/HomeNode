import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CACHED_SALE_WITNESS_V2_VERSION as VERSION, CACHED_SALE_WITNESS_V2_FIELDS as FIELDS,
  CACHED_SALE_WITNESS_V2_LIMITS as LIMITS, CACHED_SALE_WITNESS_V2_SQL as SQL,
  prepareCachedSaleWitnessV2 as prepare } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { CACHED_SALE_WITNESS_FIELDS as LEGACY_FIELDS, CACHED_SALE_WITNESS_LIMITS as LEGACY_LIMITS,
  CACHED_SALE_WITNESS_SQL as LEGACY_SQL, prepareCachedSaleWitness as prepareLegacy } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';

const ALIASES = ['PriceCurrency', 'CurrentPriceCurrency', 'ClosePriceCurrency'];
const entry = (state = 'absent', json_type = null, value_text = null, utf8_bytes = null) => ({ state, json_type, value_text, utf8_bytes });
const scalar = (text, kind = 'string') => entry('scalar', kind, text, Buffer.byteLength(text));
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture(root_state = 'object', root_json_type = 'object') {
  return { witness_version: VERSION, root_state, root_json_type,
    fields: Object.fromEntries(FIELDS.map(key => [key, entry(root_state === 'object' ? 'absent' : 'payload_unavailable')])) };
}
function fails(value, reason) {
  assert.throws(() => prepare(value), error => error instanceof TypeError
    && error.code === 'CACHED_SALE_WITNESS_INVALID' && (!reason || error.reason === reason));
}

test('V2 is an independent exact whitelist and bounded fixed-src SQL, not activation or full-payload transfer', () => {
  assert.equal(VERSION, 2); assert.equal(FIELDS.length, 31); assert.equal(new Set(FIELDS).size, 31);
  assert.deepEqual(FIELDS, [...LEGACY_FIELDS, ...ALIASES]);
  assert.ok(Object.isFrozen(FIELDS)); assert.ok(Object.isFrozen(LIMITS));
  assert.deepEqual(LIMITS, { scalar_utf8_bytes: 512, witness_utf8_bytes: 24_576 });
  assert.deepEqual(LIMITS, LEGACY_LIMITS); assert.notEqual(LIMITS, LEGACY_LIMITS);
  const vocabulary = [...SQL.matchAll(/\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(vocabulary, FIELDS);
  assert.match(SQL, /'witness_version', 2,/);
  assert.match(SQL, /src\.raw_payload ->> keys\.name/);
  assert.match(SQL, /octet_length\(witness\.body::text\) <= 24576/);
  assert.match(SQL, /ELSE NULL::jsonb END/);
  assert.doesNotMatch(SQL, /jsonb_each|SELECT\s+src\.raw_payload\b|raw_payload::text|PrivateRemarks|PublicRemarks|OwnerName|ListAgent|Contact|\$\d|COALESCE|USD/i);
});

test('legacy whitelist, SQL and successful canonical witness hash remain unchanged', () => {
  assert.equal(LEGACY_FIELDS.length, 28);
  assert.equal(sha(LEGACY_SQL), 'd3d7c2dbe370b43cf215bf26adb40121e72a9d399cea9b695df7bb6614b8782f');
  for (const alias of ALIASES) assert.equal(LEGACY_FIELDS.includes(alias), false);
  const legacy = { witness_version: 1, root_state: 'object', root_json_type: 'object',
    fields: Object.fromEntries(LEGACY_FIELDS.map(key => [key, entry()])) };
  legacy.fields.ClosePrice = scalar('9007199254740993.0100', 'number'); legacy.fields.Currency = scalar(' CAD ');
  const original = prepareLegacy(legacy), json = JSON.stringify(original);
  assert.equal(sha(json), 'a1042011cba8a321128d666ae0eac004333989d756a191ee48814b1d0d778b0a');
  const v2 = fixture(); Object.assign(v2.fields, legacy.fields);
  v2.fields.ClosePriceCurrency = scalar('USD');
  const result = prepare(v2);
  assert.equal(JSON.stringify(original), json); assert.deepEqual(prepareLegacy(legacy), original);
  for (const key of LEGACY_FIELDS) assert.deepEqual(result.fields[key], original.fields[key]);
  fails(legacy, 'version');
  assert.throws(() => prepareLegacy(v2), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'version' });
  assert.throws(() => prepareLegacy({ ...v2, witness_version: 1 }), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'shape' });
});

for (const [root, type] of [['sql_null', null], ['json_null', 'null'],
  ...['array', 'string', 'number', 'boolean'].map(type => ['non_object', type])]) {
  test(`V2 preserves unavailable root ${root}/${type} for every currency alias`, () => {
    const result = prepare(fixture(root, type));
    assert.equal(result.root_state, root); assert.equal(result.root_json_type, type);
    assert.ok(Object.values(result.fields).every(value => value.state === 'payload_unavailable'));
  });
}

for (const alias of ['Currency', ...ALIASES]) test(`${alias} preserves every closed scalar/presence state without choosing a currency`, () => {
  const states = [entry(), entry('json_null', 'null'), scalar(''), scalar('  '), scalar('usd'), scalar(' CAD '),
    scalar('0', 'number'), scalar('false', 'boolean'), entry('non_scalar', 'array'), entry('non_scalar', 'object'),
    entry('oversize', 'string', null, 513), entry('oversize', 'number', null, 2_147_483_647)];
  for (const value of states) {
    const input = fixture(); input.fields[alias] = value;
    const result = prepare(input); assert.deepEqual(result.fields[alias], value);
    for (const other of ['Currency', ...ALIASES].filter(key => key !== alias)) assert.deepEqual(result.fields[other], entry());
    assert.deepEqual(Object.keys(result), ['witness_version', 'root_state', 'root_json_type', 'fields']);
  }
});

test('disagreeing currency aliases, raw prices, dates/statuses and unit labels remain independent literal facts', () => {
  const input = fixture();
  Object.assign(input.fields, { Currency: scalar('USD'), PriceCurrency: scalar('CAD'),
    CurrentPriceCurrency: scalar('eur'), ClosePriceCurrency: scalar(' JPY '),
    ClosePrice: scalar('9007199254740993.0100', 'number'), CurrentPrice: scalar('100.00'),
    CloseDate: scalar('2026-09-12'), MlsStatus: scalar('Closed'), StandardStatus: scalar('Active'),
    LivingArea: scalar('1850.1250', 'number'), LivingAreaUnits: scalar('Unknown supplied label') });
  assert.deepEqual(prepare(input), input);
  const absent = fixture(); absent.fields.CurrentPriceCurrency = scalar('USD');
  assert.deepEqual(prepare(absent).fields.CurrentPrice, entry());
  assert.deepEqual(prepare(absent).fields.ClosePrice, entry());
});

test('precision, signed zero, exponent and Unicode scalars survive without Number conversion or normalization', () => {
  for (const value of ['9007199254740993.12345678901234567890', '-0', '1e999', '1.2300E-1000']) {
    const input = fixture(); input.fields.ClosePrice = scalar(value, 'number');
    assert.deepEqual(prepare(input).fields.ClosePrice, input.fields.ClosePrice);
  }
  for (const value of ['€', '💵', 'e\u0301', '<b>CAD</b>\n\t', '\r\n', '\u0001']) {
    const input = fixture(); input.fields.PriceCurrency = scalar(value);
    assert.deepEqual(prepare(input).fields.PriceCurrency, input.fields.PriceCurrency);
  }
});

test('every currency alias enforces exact 512-byte UTF8 scalar boundary and refuses a retained prefix', () => {
  for (const alias of ALIASES) for (const unit of ['a', 'é', '💵']) {
    const text = unit.repeat(512 / Buffer.byteLength(unit)), input = fixture();
    input.fields[alias] = scalar(text); assert.equal(prepare(input).fields[alias].utf8_bytes, 512);
    input.fields[alias] = scalar(`${text}a`); fails(input, 'scalar_mismatch');
    input.fields[alias] = entry('oversize', 'string', null, 513);
    assert.deepEqual(prepare(input).fields[alias], input.fields[alias]);
    input.fields[alias].value_text = text; fails(input, 'oversize_mismatch');
  }
});

function witnessBytes(target) {
  const input = fixture();
  for (const key of FIELDS) input.fields[key] = scalar('a'.repeat(512));
  const delta = target - Buffer.byteLength(JSON.stringify(input));
  assert.ok(delta > 0 && delta < FIELDS.length * 512 * 5);
  let controls = Math.floor(delta / 5), newlines = delta % 5;
  for (const key of FIELDS) {
    const n = Math.min(512, controls); controls -= n;
    const lines = Math.min(512 - n, newlines); newlines -= lines;
    input.fields[key] = scalar('\u0001'.repeat(n) + '\n'.repeat(lines) + 'a'.repeat(512 - n - lines));
  }
  assert.equal(controls, 0); assert.equal(newlines, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(input)), target); return input;
}

test('whole witness exact 24576-byte boundary and one-over reject atomically without dropping aliases', () => {
  const exact = witnessBytes(24_576);
  assert.deepEqual(prepare(exact), exact);
  fails(witnessBytes(24_577), 'witness_byte_limit'); fails(null, 'witness_byte_limit');
  const expanded = fixture(); for (const key of FIELDS) expanded.fields[key] = scalar('\u0001'.repeat(512));
  fails(expanded, 'witness_byte_limit');
});

test('result is detached and deeply frozen while caller input stays mutable', () => {
  const input = fixture(); input.fields.PriceCurrency = scalar('CAD');
  const result = prepare(input);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.fields));
  for (const key of FIELDS) { assert.ok(Object.isFrozen(result.fields[key])); assert.notEqual(result.fields[key], input.fields[key]); }
  assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(input.fields), false);
  input.fields.PriceCurrency.value_text = 'USD'; delete input.fields.ClosePriceCurrency;
  assert.equal(result.fields.PriceCurrency.value_text, 'CAD'); assert.deepEqual(result.fields.ClosePriceCurrency, entry());
});

test('unknown/missing/private keys and invalid roots/versions/nonplain shapes reject', () => {
  for (const mutate of [value => { value.extra = true; }, value => { delete value.fields.PriceCurrency; },
    value => { value.fields.PrivateRemarks = entry(); }, value => { value.fields.pricecurrency = entry(); },
    value => { value.witness_version = 1; }, value => { value.witness_version = '2'; }, value => { value.witness_version = 3; },
    value => { value.root_state = 'absent'; }, value => { value.root_json_type = 'array'; },
    value => { value.fields.CurrentPriceCurrency.extra = true; }, value => { value.fields = []; },
    value => { Object.setPrototypeOf(value.fields, null); }, value => { value[Symbol('hidden')] = true; },
    value => { value.fields.PriceCurrency[Symbol('hidden')] = true; }]) {
    const input = fixture(); mutate(input); fails(input);
  }
  for (const value of [undefined, false, 0, '', [], new Date(), Object.create(null)]) fails(value);
});

test('inconsistent field states and invalid byte/type data cannot enter any currency alias', () => {
  const bad = [entry('absent', 'null'), entry('json_null'), entry('non_scalar', 'number'), entry('payload_unavailable'),
    entry('oversize', 'string', null, 512), entry('oversize', 'boolean', null, 513),
    entry('oversize', 'string', null, 2_147_483_648), entry('scalar', 'string', '', -0),
    entry('scalar', 'string', 'é', 1), entry('scalar', 'string', '', NaN), entry('scalar', 'string', '', '0'),
    scalar('01', 'number'), scalar('NaN', 'number'), scalar('Infinity', 'number'), scalar('TRUE', 'boolean'),
    scalar('\u0000'), scalar('\ud800')];
  for (const alias of ALIASES) for (const value of bad) {
    const input = fixture(); input.fields[alias] = value; fails(input);
  }
  const unavailable = fixture('sql_null', null); unavailable.fields.PriceCurrency = entry(); fails(unavailable, 'root_field_mismatch');
});

test('root, field-directory and nested getters/proxies/hidden properties never execute', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('getter executed'); } };
  for (const place of ['root', 'directory', 'field']) {
    const input = fixture();
    Object.defineProperty(place === 'root' ? input : place === 'directory' ? input.fields : input.fields.PriceCurrency,
      place === 'root' ? 'fields' : place === 'directory' ? 'PriceCurrency' : 'value_text', getter);
    fails(input, 'data_properties_required');
  }
  const hidden = fixture(); Object.defineProperty(hidden.fields, 'PriceCurrency', { value: entry(), enumerable: false });
  fails(hidden, 'data_properties_required');
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor'].map(key => [key, () => { calls++; throw new Error('trap executed'); }]));
  const trap = new Proxy({}, handler), revoked = Proxy.revocable({}, handler); revoked.revoke();
  for (const proxy of [trap, revoked.proxy]) {
    fails(proxy, 'shape');
    const directory = fixture(); directory.fields = proxy; fails(directory, 'shape');
    const nested = fixture(); nested.fields.ClosePriceCurrency = proxy; fails(nested, 'shape');
    const primitive = fixture(); primitive.fields.PriceCurrency.value_text = proxy; fails(primitive, 'presence_mismatch');
  }
  assert.equal(calls, 0);
});
