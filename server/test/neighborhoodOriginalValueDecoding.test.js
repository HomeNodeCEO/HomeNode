import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNeighborhoodOriginalValue as decode, ORIGINAL_VALUE_DECODER_VERSION,
  ORIGINAL_VALUE_DECODER_LIMITS } from '../src/services/neighborhoodAssessment/originalValueDecoding.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { assertNeighborhoodJsonbStorage } from '../src/services/neighborhoodAssessment/jsonbStorage.js';
import { decodedScalars, refusedNumerics, refusedJson, refusedDates, refusedTimestamps, wholeTokenRefusals,
  completeSnapshotText, completeSnapshotValue, expectedDecoded, expectedFailure, scalarUsage,
} from './fixtures/neighborhoodOriginalValueDecodingFixture.js';

const kinds = ['jsonb', 'numeric', 'date', 'timestamptz', 'utc6'];
function rejected(kind, state, text, reason, status = 'unsupported') {
  const result = decode(kind, state, text);
  assert.deepEqual(result, expectedFailure(kind, state, status, reason));
  assert.ok(Object.isFrozen(result));
  return result;
}

test('one primitive API and fixed immutable capacities', () => {
  assert.equal(ORIGINAL_VALUE_DECODER_VERSION, 1);
  assert.deepEqual(ORIGINAL_VALUE_DECODER_LIMITS, {
    input_bytes: 1500000, decoded_nodes: 100000, decoded_depth: 35,
    numeric_token_bytes: 256, numeric_exponent: 1000,
    output_bytes: 1500000, output_nodes: 100000, output_depth: 40, output_jsonb_bytes: 2000000,
  });
  assert.ok(Object.isFrozen(ORIGINAL_VALUE_DECODER_LIMITS));
  assert.throws(() => { ORIGINAL_VALUE_DECODER_LIMITS.input_bytes = Infinity; }, TypeError);
});
for (const kind of kinds) test(`${kind}: SQL null remains explicit`, () => {
  assert.deepEqual(decode(kind, 'sql_null', null), expectedDecoded(kind, 'sql_null', null,
    { input_utf8_bytes: 0, decoded_nodes: 0, decoded_depth: 0, numeric_tokens: 0, numeric_token_utf8_bytes: 0 }));
});
test('JSON null is distinct from SQL null and from present', () => {
  assert.deepEqual(decode('jsonb', 'json_null', 'null'), expectedDecoded('jsonb', 'json_null', null, scalarUsage('null')));
  rejected('jsonb', 'present', 'null', 'storage_state_mismatch', 'invalid_input');
  rejected('jsonb', 'present', ' null ', 'storage_state_mismatch', 'invalid_input');
  for (const text of [' null', 'null ', 'false', '0', null, undefined]) {
    rejected('jsonb', 'json_null', text, 'storage_state_mismatch', 'invalid_input');
  }
});
for (const kind of kinds) test(`${kind}: contradictory state/text is refused`, () => {
  for (const text of ['', 'null', 0, false, {}, undefined]) rejected(kind, 'sql_null', text, 'storage_state_mismatch', 'invalid_input');
  for (const text of [null, undefined, 1, true, {}, []]) rejected(kind, 'present', text, 'storage_state_mismatch', 'invalid_input');
  if (kind !== 'jsonb') rejected(kind, 'json_null', 'null', 'storage_state_mismatch', 'invalid_input');
});
for (const [name, kind, text, value] of decodedScalars) test(`scalar: ${name}`, () => {
  assert.deepEqual(decode(kind, 'present', text), expectedDecoded(kind, 'present', value, scalarUsage(text, kind === 'numeric')));
});
for (const [text, reason] of refusedNumerics) test(`numeric refuses ${JSON.stringify(text)}`, () => {
  rejected('numeric', 'present', text, reason);
});
for (const [text, reason] of refusedJson) test(`JSON refuses ${JSON.stringify(text)}`, () => {
  rejected('jsonb', 'present', text, reason);
});
for (const text of refusedDates) test(`date refuses ${JSON.stringify(text)}`, () => rejected('date', 'present', text, 'invalid_date_text'));
for (const text of refusedTimestamps) test(`timestamp refuses ${JSON.stringify(text)}`, () => rejected('timestamptz', 'present', text, 'invalid_timestamp_text'));
for (const { kind, text, reason, label } of wholeTokenRefusals) {
  test(`whole-token ${kind} refuses final ${label}`, () => rejected(kind, 'present', text, reason));
}
test('JSON document trailing whitespace stays valid independently of strict scalar text', () => {
  for (const suffix of ['\n', '\r', '\r\n']) {
    assert.deepEqual(decode('jsonb', 'present', '1' + suffix), expectedDecoded('jsonb', 'present', 1,
      { input_utf8_bytes: 1 + suffix.length, decoded_nodes: 1, decoded_depth: 0, numeric_tokens: 1, numeric_token_utf8_bytes: 1 }));
  }
  for (const suffix of ['\u2028', '\u2029']) rejected('jsonb', 'present', '1' + suffix, 'invalid_json');
});
for (const text of ['2024-01-01T00:00:00Z', '2024-01-01T00:00:00.123Z', '2024-01-01 00:00:00.123456Z',
  '2024-01-01T00:00:00.123456+00', '0000-01-01T00:00:00.123456Z', '2024-01-01T24:00:00.123456Z']) {
  test(`canonical Utc6 refuses ${text}`, () => rejected('utc6', 'present', text, 'invalid_timestamp_text'));
}

test('JSON scalars retain type, empty structures and false/zero distinctions', () => {
  for (const [text, value, numeric] of [['false', false, false], ['0', 0, true], ['""', '', false],
    ['"1990"', '1990', false], ['{}', {}, false], ['[]', [], false]]) {
    assert.deepEqual(decode('jsonb', 'present', text), expectedDecoded('jsonb', 'present', value, scalarUsage(text, numeric)));
  }
});
test('valid escapes and paired Unicode retain their decoded characters', () => {
  const text = String.raw`["\"\\\/\b\f\n\r\t","\ud83d\ude00","é","😀"]`;
  const result = decode('jsonb', 'present', text);
  assert.equal(result.status, 'decoded');
  assert.deepEqual(result.value, ['"\\/\b\f\n\r\t', '😀', 'é', '😀']);
  assert.deepEqual(result.usage, { input_utf8_bytes: Buffer.byteLength(text), decoded_nodes: 5, decoded_depth: 1,
    numeric_tokens: 0, numeric_token_utf8_bytes: 0 });
});
test('full snapshot retains all values and exact usage; it is not a workflow projector', () => {
  const result = decode('jsonb', 'present', completeSnapshotText);
  assert.equal(result.status, 'decoded');
  assert.deepEqual(result.value, completeSnapshotValue);
  assert.deepEqual(result.usage, { input_utf8_bytes: Buffer.byteLength(completeSnapshotText), decoded_nodes: 16,
    decoded_depth: 3, numeric_tokens: 5, numeric_token_utf8_bytes: 23 });
  const unsupportedOriginal = '{"consumed":0,"unconsumed":{"value":9007199254740993}}';
  rejected('jsonb', 'present', unsupportedOriginal, 'inexact_numeric');
  assert.equal(unsupportedOriginal, '{"consumed":0,"unconsumed":{"value":9007199254740993}}');
});
test('JSON numeric leaves use original precision checks, not a rounded parsed value', () => {
  for (const [text, reason] of [['9007199254740993', 'inexact_numeric'], ['-0.00', 'negative_zero'],
    ['1e-324', 'numeric_underflow'], ['2e308', 'nonfinite_numeric']]) {
    rejected('jsonb', 'present', `{"rows":[${text}]}`, reason);
  }
});
test('own __proto__ and integer-like keys preserve actual shared encoder semantics', () => {
  const text = '{"10":"ten","2":"two","__proto__":{"polluted":true},"constructor":4,"a":1}';
  const result = decode('jsonb', 'present', text);
  assert.equal(result.status, 'decoded');
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.hasOwn(result.value, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  assert.equal(canonicalAssessmentJson(result.value), '{"2":"two","10":"ten","__proto__":{"polluted":true},"a":1,"constructor":4}');
});
test('value/result are fresh frozen data and no authority keys or source error escape', () => {
  const first = decode('jsonb', 'present', '{"array":[{"x":1},2]}');
  const second = decode('jsonb', 'present', '{"array":[{"x":1},2]}');
  assert.deepEqual(first, second); assert.notEqual(first, second); assert.notEqual(first.value, second.value);
  for (const value of [first, first.value, first.value.array, first.value.array[0], first.usage]) assert.ok(Object.isFrozen(value));
  assert.throws(() => first.value.array.push(3), TypeError);
  assert.throws(() => { first.value.array[0].x = 9; }, TypeError);
  assert.deepEqual(Object.keys(first).sort(), ['decoder_version', 'interpretation', 'kind', 'reason', 'status', 'storage_state', 'usage', 'value']);
  const bad = rejected('jsonb', 'present', '{"secret-marker":', 'invalid_json');
  assert.ok(!JSON.stringify(bad).includes('secret-marker'));
});
test('all nonprimitive argument positions are refused without traps or coercion', () => {
  let touched = 0;
  const hostile = new Proxy({}, { get() { touched++; throw new Error('secret trap'); },
    ownKeys() { touched++; throw new Error('secret trap'); }, getPrototypeOf() { touched++; throw new Error('secret trap'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const objects = [hostile, revoked.proxy, new String('jsonb'), [], {}, () => {}, Symbol('marker'), 1n];
  for (const value of objects) {
    assert.deepEqual(decode(value, 'present', '0'), expectedFailure(null, 'present', 'invalid_input', 'invalid_argument'));
    assert.deepEqual(decode('jsonb', value, '0'), expectedFailure('jsonb', null, 'invalid_input', 'invalid_argument'));
    rejected('jsonb', 'present', value, 'storage_state_mismatch', 'invalid_input');
  }
  assert.equal(touched, 0);
  assert.deepEqual(decode('jsonb', 'absent', null), expectedFailure('jsonb', null, 'invalid_input', 'invalid_argument'));
  assert.deepEqual(decode('bogus', 'present', '0'), expectedFailure(null, 'present', 'invalid_input', 'invalid_argument'));
  assert.deepEqual(decode(), expectedFailure(null, null, 'invalid_input', 'invalid_argument'));
  assert.deepEqual(decode('jsonb', 'present', '0', { input_bytes: Infinity }), expectedFailure('jsonb', 'present', 'invalid_input', 'invalid_argument'));
});

test('numeric token 256/257-byte and exponent 1000/1001 gates are independently reachable', () => {
  const exact = '0.' + '0'.repeat(254);
  assert.equal(exact.length, 256);
  assert.equal(decode('numeric', 'present', exact).status, 'decoded');
  rejected('numeric', 'present', exact + '0', 'numeric_token_limit', 'limit_exceeded');
  for (const token of ['0e1000', '0e-1000', '0e+0001000']) assert.equal(decode('numeric', 'present', token).status, 'decoded');
  for (const token of ['0e1001', '0e-1001', '-0e1001', '0e99999999', '10e1000', '0.12e-999']) {
    rejected('numeric', 'present', token, 'numeric_exponent_limit', 'limit_exceeded');
  }
  rejected('jsonb', 'present', '[' + exact + '0]', 'numeric_token_limit', 'limit_exceeded');
  rejected('numeric', 'present', '1e1000', 'nonfinite_numeric');
  rejected('numeric', 'present', '1e-1000', 'numeric_underflow');
});
test('original ASCII byte boundary can succeed because whitespace is retained only externally', () => {
  const input = ' '.repeat(1499999) + '0';
  const result = decode('jsonb', 'present', input);
  assert.deepEqual(result, expectedDecoded('jsonb', 'present', 0, { input_utf8_bytes: 1500000, decoded_nodes: 1,
    decoded_depth: 0, numeric_tokens: 1, numeric_token_utf8_bytes: 1 }));
  rejected('jsonb', 'present', ' ' + input, 'input_bytes', 'limit_exceeded');
});
test('original multibyte and escaped byte boundaries count real UTF-8 before parsing', () => {
  const value = 'é'.repeat(500000);
  const input = ' '.repeat(499998) + '"' + value + '"';
  assert.equal(Buffer.byteLength(input), 1500000);
  const result = decode('jsonb', 'present', input);
  assert.equal(result.status, 'decoded'); assert.equal(result.value, value);
  assert.equal(result.usage.input_utf8_bytes, 1500000);
  rejected('jsonb', 'present', ' ' + input, 'input_bytes', 'limit_exceeded');
  const escaped = '    "' + '\\u00e9'.repeat(249999) + '"';
  assert.equal(Buffer.byteLength(escaped), 1500000);
  assert.equal(decode('jsonb', 'present', escaped).status, 'decoded');
  rejected('jsonb', 'present', escaped + ' ', 'input_bytes', 'limit_exceeded');
});
test('depth 35/36 uses root-zero accounting before full parsing', () => {
  const input = '['.repeat(35) + '0' + ']'.repeat(35);
  const result = decode('jsonb', 'present', input);
  assert.equal(result.status, 'decoded'); assert.equal(result.usage.decoded_depth, 35); assert.equal(result.usage.decoded_nodes, 36);
  rejected('jsonb', 'present', '[' + input + ']', 'decoded_depth', 'limit_exceeded');
});
test('complete envelope metadata lowers successful nodes below the parser ceiling', () => {
  const array = n => '[' + '0,'.repeat(n - 1) + '0]';
  const result = decode('jsonb', 'present', array(99986));
  assert.equal(result.status, 'decoded'); assert.equal(result.usage.decoded_nodes, 99987);
  assert.doesNotThrow(() => canonicalAssessmentJson(result));
  rejected('jsonb', 'present', array(99987), 'output_limit', 'limit_exceeded');
  rejected('jsonb', 'present', array(99999), 'output_limit', 'limit_exceeded');
  rejected('jsonb', 'present', array(100000), 'decoded_nodes', 'limit_exceeded');
});
test('exact full-output byte boundary succeeds; next byte returns only fixed failure', () => {
  // Result schema contributes fixed ASCII overhead with a seven-digit input size.
  const template = expectedDecoded('jsonb', 'present', '', scalarUsage(''));
  template.usage.input_utf8_bytes = 1500000;
  const overhead = Buffer.byteLength(JSON.stringify(template));
  const value = 'a'.repeat(1500000 - overhead);
  const input = JSON.stringify(value);
  assert.ok(Buffer.byteLength(input) < 1500000);
  const expected = expectedDecoded('jsonb', 'present', value, scalarUsage(input));
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), 1500000);
  assert.deepEqual(decode('jsonb', 'present', input), expected);
  rejected('jsonb', 'present', JSON.stringify(value + 'a'), 'output_limit', 'limit_exceeded');
});
test('JSONB expansion limit is independent of small canonical/input/node sizes', () => {
  // 1e308 occupies 309 PG numeric bytes; each array separator adds two.
  for (const [count, status] of [[6429, 'decoded'], [6430, 'limit_exceeded']]) {
    const input = '[' + Array(count).fill('1e308').join(',') + ']';
    const usage = { input_utf8_bytes: input.length, decoded_nodes: count + 1, decoded_depth: 1,
      numeric_tokens: count, numeric_token_utf8_bytes: count * 5 };
    const expected = expectedDecoded('jsonb', 'present', Array(count).fill(1e308), usage);
    assert.ok(Buffer.byteLength(canonicalAssessmentJson(expected)) < 100000);
    if (status === 'decoded') {
      assert.ok(assertNeighborhoodJsonbStorage(expected) <= 2000000);
      assert.deepEqual(decode('jsonb', 'present', input), expected);
    } else {
      assert.throws(() => assertNeighborhoodJsonbStorage(expected), /neighborhood_jsonb_storage_limit:bytes/);
      rejected('jsonb', 'present', input, 'output_limit', 'limit_exceeded');
    }
  }
});
