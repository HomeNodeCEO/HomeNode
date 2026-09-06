import test from 'node:test';
import assert from 'node:assert/strict';
import { scanOriginalJsonText as scan, decodeOriginalNumericText as numeric,
  measureOriginalUnicodeBytes as bytes, classifyOriginalJsonTokenFailure as classify,
  ORIGINAL_JSON_TOKEN_LIMITS } from '../src/services/neighborhoodAssessment/originalJsonTokens.js';
import { decodeNeighborhoodOriginalValue as decode } from '../src/services/neighborhoodAssessment/originalValueDecoding.js';
import { indexedText, indexedExpected, orderedText, orderedExpected,
  invalidDocuments, firstFailures, rawNumbers } from './fixtures/neighborhoodOriginalJsonTokensFixture.js';

const modes = ['full_value', 'validate_only', 'index'];
function failure(fn, status, reason) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.notEqual(caught, undefined, 'a complete result must not escape the refusal');
  assert.deepEqual(classify(caught), { status, reason });
  assert.deepEqual(Reflect.ownKeys(caught), []);
  assert.ok(Object.isFrozen(caught));
  assert.ok(Object.isFrozen(classify(caught)));
  return caught;
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const item of Object.values(value)) frozen(item);
  }
}
function oneUsage(text, numericBytes = 0) {
  return { input_utf8_bytes: Buffer.byteLength(text), decoded_nodes: 1, decoded_depth: 0,
    numeric_tokens: numericBytes ? 1 : 0, numeric_token_utf8_bytes: numericBytes };
}

test('fixed capacities are immutable and separate from later evidence serialization', () => {
  assert.deepEqual(ORIGINAL_JSON_TOKEN_LIMITS, {
    input_bytes: 1500000, decoded_nodes: 100000, decoded_depth: 35,
    numeric_token_bytes: 256, numeric_exponent: 1000,
    index_nodes: 100000, index_edges: 99999, index_key_bytes: 1500000,
  });
  assert.ok(Object.isFrozen(ORIGINAL_JSON_TOKEN_LIMITS));
  assert.throws(() => { ORIGINAL_JSON_TOKEN_LIMITS.input_bytes = Infinity; }, TypeError);
});
test('literal UTF-16 spans retain nested object, array, Unicode and prototype-sensitive keys', () => {
  const result = scan(indexedText, 'index');
  assert.deepEqual(result, indexedExpected);
  assert.equal(indexedText.length, 46);
  assert.equal(Buffer.byteLength(indexedText), 49);
  assert.deepEqual(result.index.nodes.map(n => indexedText.slice(n.start, n.end)), [
    '{"0":[null,false,0],"é":{"__proto__":"😀"}}', '[null,false,0]',
    'null', 'false', '0', '{"__proto__":"😀"}', '"😀"',
  ]);
  frozen(result);
});
test('integer-looking object members retain original order, independently of object enumeration', () => {
  assert.deepEqual(scan(orderedText, 'index'), orderedExpected);
});
test('escaped keys decode once into ordered strings without filtering or normalizing Unicode', () => {
  const text = '{"\\u0061":1,"é":2,"\\ud83d\\ude00":3,"e\\u0301":4}';
  const result = scan(text, 'index');
  assert.deepEqual(result.index.nodes[0].members, [
    { key: 'a', value: 1 }, { key: 'é', value: 2 }, { key: '😀', value: 3 }, { key: 'é', value: 4 },
  ]);
  assert.equal(result.index.decoded_key_utf8_bytes, 10);
  assert.deepEqual(result.index.nodes.slice(1).map(n => text.slice(n.start, n.end)), ['1', '2', '3', '4']);
});
for (const [text, kind, memberValue, elementValue, numberBytes] of [
  ['null', 'null', null, null, 0], ['false', 'boolean', null, null, 0],
  ['true', 'boolean', null, null, 0], ['0', 'number', null, null, 1],
  ['""', 'string', null, null, 0], ['"1990"', 'string', null, null, 0],
  ['{}', 'object', [], null, 0], ['[]', 'array', null, [], 0],
]) test(`scalar or empty root ${text} retains only typed spans`, () => {
  assert.deepEqual(scan(' \t' + text + '\r\n', 'index'), {
    usage: oneUsage(' \t' + text + '\r\n', numberBytes),
    index: { root: 0, nodes: [{ kind, start: 2, end: 2 + text.length, members: memberValue, elements: elementValue }],
      index_edges: 0, decoded_key_utf8_bytes: 0 },
  });
});
test('non-index modes return only usage and preserve the existing full-decoder usage', () => {
  for (const mode of ['full_value', 'validate_only']) {
    const result = scan(indexedText, mode);
    assert.deepEqual(result, { usage: indexedExpected.usage, index: null });
    frozen(result);
  }
  assert.deepEqual(decode('jsonb', 'present', indexedText).usage, indexedExpected.usage);
});
test('owned frozen results cannot affect later calls or expose input text copies', () => {
  const first = scan(indexedText, 'index');
  const second = scan(indexedText, 'index');
  assert.notEqual(first, second);
  assert.notEqual(first.index.nodes, second.index.nodes);
  assert.notEqual(first.index.nodes[0].members, second.index.nodes[0].members);
  assert.throws(() => { first.index.nodes[0].members[0].key = 'other'; }, TypeError);
  assert.throws(() => { first.index.nodes.push({}); }, TypeError);
  assert.deepEqual(second, indexedExpected);
  assert.deepEqual(Object.keys(first), ['usage', 'index']);
  for (const node of first.index.nodes) assert.deepEqual(Object.keys(node), ['kind', 'start', 'end', 'members', 'elements']);
});
for (const [text, reason] of invalidDocuments) test(`every mode validates complete document ${JSON.stringify(text)}`, () => {
  for (const mode of modes) failure(() => scan(text, mode), 'unsupported', reason);
});
for (const [name, text, fullStatus, fullReason, rawStatus, rawReason] of firstFailures) {
  test(`first-failure policy: ${name}`, () => {
    failure(() => scan(text, 'full_value'), fullStatus, fullReason);
    for (const mode of ['validate_only', 'index']) failure(() => scan(text, mode), rawStatus, rawReason);
    const decoded = decode('jsonb', 'present', text);
    assert.equal(decoded.status, fullStatus);
    assert.equal(decoded.reason, fullReason);
    assert.equal(decoded.value, null);
    assert.equal(decoded.usage, null);
  });
}
for (const [text, status, reason] of rawNumbers) test(`unconsumed number remains original syntax: ${text.slice(0, 40)}`, () => {
  for (const mode of ['validate_only', 'index']) {
    const result = scan(text, mode);
    assert.deepEqual(result.usage, oneUsage(text, text.length));
    if (mode === 'index') assert.deepEqual(result.index.nodes, [
      { kind: 'number', start: 0, end: text.length, members: null, elements: null },
    ]);
    else assert.equal(result.index, null);
  }
  failure(() => scan(text, 'full_value'), status, reason);
  failure(() => numeric(text, 'invalid_numeric_text'), status, reason);
  assert.equal(decode('numeric', 'present', text).reason, reason);
});
test('raw exponent digits are not Number-converted or expanded in syntax-only modes', () => {
  const text = '[1e' + '9'.repeat(5000) + ',9007199254740993,-0]';
  for (const mode of ['validate_only', 'index']) {
    const result = scan(text, mode);
    assert.deepEqual(result.usage, { input_utf8_bytes: 5024, decoded_nodes: 4, decoded_depth: 1,
      numeric_tokens: 3, numeric_token_utf8_bytes: 5020 });
  }
});
test('numeric bridge preserves exact decimal, unsafe exact integer and subnormal controls', () => {
  for (const [text, expected] of [['0.1', 0.1], ['5e-324', 5e-324], ['9007199254740992', 9007199254740992],
    ['100e-2', 1], ['0e1000', 0], ['1E+002', 100]]) {
    assert.equal(numeric(text, 'invalid_numeric_text'), expected);
    assert.deepEqual(scan(text, 'full_value').usage, oneUsage(text, text.length));
  }
});
test('numeric failure reasons follow the fixed caller enum, without coercion', () => {
  for (const text of ['', '01', '+1', '1\n', '1\r', '1\u2028', '1\u2029']) {
    failure(() => numeric(text, 'invalid_json'), 'unsupported', 'invalid_json');
    failure(() => numeric(text, 'invalid_numeric_text'), 'unsupported', 'invalid_numeric_text');
  }
});
test('escaped string parsing accepts valid controls, paired surrogates and JSON whitespace', () => {
  const text = String.raw`["\"\\\/\b\f\n\r\t","\ud83d\ude00","é","😀"]`;
  for (const mode of modes) assert.deepEqual(scan(text, mode).usage, {
    input_utf8_bytes: Buffer.byteLength(text), decoded_nodes: 5, decoded_depth: 1,
    numeric_tokens: 0, numeric_token_utf8_bytes: 0,
  });
  for (const suffix of ['\n', '\r', '\r\n', '\t ']) {
    for (const mode of modes) assert.deepEqual(scan('1' + suffix, mode).usage, oneUsage('1' + suffix, 1));
  }
});
test('invalid scan primitives and arity are refused without property access or coercion', () => {
  let touched = 0;
  const hostile = new Proxy({}, { get() { touched++; throw new Error('private'); },
    ownKeys() { touched++; throw new Error('private'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const text of [null, undefined, 0, false, 1n, Symbol('x'), new String('0'), hostile, revoked.proxy]) {
    failure(() => scan(text, 'index'), 'invalid_input', 'invalid_argument');
  }
  for (const mode of [null, undefined, '', 'INDEX', {}, hostile, revoked.proxy]) {
    failure(() => scan('0', mode), 'invalid_input', 'invalid_argument');
  }
  failure(() => scan('0'), 'invalid_input', 'invalid_argument');
  failure(() => scan('0', 'index', {}), 'invalid_input', 'invalid_argument');
  assert.equal(touched, 0);
});
test('numeric and Unicode helper admission cannot invoke supplied objects', () => {
  let touched = 0;
  const hostile = { toString() { touched++; throw new Error('private'); },
    valueOf() { touched++; throw new Error('private'); } };
  failure(() => numeric(hostile, 'invalid_json'), 'invalid_input', 'invalid_argument');
  failure(() => numeric('0', hostile), 'invalid_input', 'invalid_argument');
  failure(() => numeric('0', 'not_a_reason'), 'invalid_input', 'invalid_argument');
  failure(() => numeric('0'), 'invalid_input', 'invalid_argument');
  failure(() => numeric('0', 'invalid_json', 1), 'invalid_input', 'invalid_argument');
  failure(() => bytes(hostile), 'invalid_input', 'invalid_argument');
  failure(() => bytes('0', 1), 'invalid_input', 'invalid_argument');
  failure(() => bytes(), 'invalid_input', 'invalid_argument');
  assert.equal(touched, 0);
  assert.equal(bytes('aé€😀'), 10);
});
test('foreign failures, revoked proxies and Error getters cannot spoof private metadata', () => {
  let touched = 0;
  const foreign = new Error('private input');
  Object.defineProperty(foreign, 'status', { get() { touched++; throw new Error('private'); } });
  Object.defineProperty(foreign, 'reason', { get() { touched++; throw new Error('private'); } });
  const hostile = new Proxy({}, { get() { touched++; throw new Error('private'); },
    getPrototypeOf() { touched++; throw new Error('private'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const error of [foreign, hostile, revoked.proxy, {}, { status: 'unsupported', reason: 'invalid_json' },
    null, undefined, 0, 'invalid_json', Symbol('x'), () => {}]) assert.equal(classify(error), null);
  assert.equal(touched, 0);
  const token = failure(() => scan('{"private":"secret",', 'index'), 'unsupported', 'invalid_json');
  assert.throws(() => { token.reason = 'secret'; }, TypeError);
  assert.throws(() => { classify(token).reason = 'secret'; }, TypeError);
  assert.deepEqual(classify(token), { status: 'unsupported', reason: 'invalid_json' });
  assert.equal(classify({ ...token }), null);
});
test('original byte admission precedes grammar and is exact at 1,500,000 ASCII bytes', () => {
  const text = ' '.repeat(1499999) + '0';
  for (const mode of modes) assert.deepEqual(scan(text, mode).usage, oneUsage(text, 1));
  for (const mode of modes) failure(() => scan(text + 'x', mode), 'limit_exceeded', 'input_bytes');
  failure(() => scan('x'.repeat(1500001), 'index'), 'limit_exceeded', 'input_bytes');
});
test('a maximum-byte raw number remains unconverted in both syntax-only modes', () => {
  const text = '1' + '0'.repeat(1499999);
  for (const mode of ['validate_only', 'index']) assert.deepEqual(scan(text, mode).usage, oneUsage(text, 1500000));
  failure(() => scan(text, 'full_value'), 'limit_exceeded', 'numeric_token_limit');
});
test('multibyte original text is charged by UTF-8 bytes before string decoding', () => {
  const text = '"' + 'é'.repeat(749999) + '"';
  assert.equal(Buffer.byteLength(text), 1500000);
  assert.deepEqual(scan(text, 'index').usage, oneUsage(text));
  failure(() => scan(text + ' ', 'index'), 'limit_exceeded', 'input_bytes');
});
test('100,000 indexed nodes and 99,999 edges are reachable; next child is refused atomically', () => {
  const text = '[' + Array(99999).fill('0').join(',') + ']';
  const result = scan(text, 'index');
  assert.deepEqual(result.usage, { input_utf8_bytes: 199999, decoded_nodes: 100000, decoded_depth: 1,
    numeric_tokens: 99999, numeric_token_utf8_bytes: 99999 });
  assert.equal(result.index.nodes.length, 100000);
  assert.equal(result.index.index_edges, 99999);
  assert.equal(result.index.nodes[0].elements.length, 99999);
  assert.equal(result.index.nodes[0].elements[99998], 99999);
  assert.deepEqual(result.index.nodes[99999], { kind: 'number', start: 199997, end: 199998, members: null, elements: null });
  assert.ok(Object.isFrozen(result.index.nodes));
  const excess = text.slice(0, -1) + ',0]';
  for (const mode of modes) failure(() => scan(excess, mode), 'limit_exceeded', 'decoded_nodes');
  // The independent node bound precedes index_nodes/index_edges; those guards
  // cannot be reached separately by a valid document with these fixed limits.
});
test('root-zero depth 35 is reachable; depth 36 is refused in every mode', () => {
  const valid = '['.repeat(35) + '0' + ']'.repeat(35);
  for (const mode of modes) assert.deepEqual(scan(valid, mode).usage, {
    input_utf8_bytes: 71, decoded_nodes: 36, decoded_depth: 35, numeric_tokens: 1, numeric_token_utf8_bytes: 1,
  });
  for (const mode of modes) failure(() => scan('[' + valid + ']', mode), 'limit_exceeded', 'decoded_depth');
});
test('maximum-byte single key obeys syntax overhead; independent key-byte overflow is unreachable', () => {
  const text = '{"' + 'a'.repeat(1499994) + '":0}';
  assert.equal(Buffer.byteLength(text), 1500000);
  const result = scan(text, 'index');
  assert.equal(result.index.decoded_key_utf8_bytes, 1499994);
  assert.equal(result.index.index_edges, 1);
  assert.equal(result.index.nodes.length, 2);
  failure(() => scan(text.slice(0, -1) + ' }', 'index'), 'limit_exceeded', 'input_bytes');
});
