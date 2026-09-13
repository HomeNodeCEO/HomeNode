import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scanOriginalJsonText as scan, classifyOriginalJsonTokenFailure as classify,
  ORIGINAL_JSON_TOKEN_LIMITS as limits } from '../src/services/neighborhoodAssessment/originalJsonTokens.js';
import { indexedText, orderedText, invalidDocuments, firstFailures } from './fixtures/neighborhoodOriginalJsonTokensFixture.js';

const modes = ['full_value', 'validate_only', 'index'];
const hash = text => createHash('sha256').update(text).digest('hex');

// Full JSON.stringify(result) bytes/hashes captured from the unchanged scanner
// on base 636dd6a, before adding the unescaped-token fast path. Non-index modes
// have the same complete result; index goldens include every key/span/counter.
const goldens = [
  ['existing_nested', indexedText,
    130, 'fc305bb31348d8a764e395113e3f756066fb53ca71774321e940df4e073cc260',
    740, '21930e47445e8dd694d0b533ce649bef2e69e52a3d2615cbcef2d8d504bcef27'],
  ['existing_ordered', orderedText,
    130, 'b4c6c6767b49ab416ede28a3c2ac902b663b3867e56a1687261c71267d047a7f',
    526, '710ea42f22edaacb6796a795392659e76f9b046a093f3681e6b33c947e6e041e'],
  ['empty_and_plain', '{"":"","plain":"Alpha 42 / ~","false":"null"}',
    130, '4ed3af740f3feff68cbfb751e462aba48fcafc3f590b099c5ffd0cf68e85e9b2',
    533, '3cacbdf1f94da1beefb54330803a0e39cecf31afbade40ad595d335c2aecbab7'],
  ['escaped_controls', String.raw`{"escaped":"\"\\\/\b\f\n\r\t","plain":"later","\u0061":"\u0062"}`,
    130, 'beeaf806cd2ed1671379a8ed4c8ed0a6c295b84dc0ec9b10636f7311bf3563b4',
    538, 'ca9d2edb0e8be28b7d0c2576cfbb7c465a808962a75f7bf96cd022ef15343439'],
  ['literal_unicode', '{"é":"e\u0301","e\u0301":"é","😀":"𝄞","\u2028":"\u2029","\ufeff":"\u007f"}',
    130, '1878c5ce5740f79b12d13a7a728d9793db6d1f1d2793e7f1d4cc3ebdefcec5e9',
    718, '0505293c6c9485aed26623683547dfdbfd4fdc2bea4265b726c8bd45b60550ad'],
  ['mixed_tokens', String.raw`[{"\u0061":"plain","b":"\ud83d\ude00","😀":"next"},{"a":"\/","b":""},-12.5,1e2,null]`,
    131, '1d6d4d179e7e742b6433e1b0706a2f398d2a81b92b132f1fa1b59510c1febb87',
    1060, '3e63060f7013ea56bb0d07da7525e799c6cd0894e3a54dfd6c28d23e399da23f'],
  ['prototype_keys', String.raw`{"__proto__":"plain","constructor":"next","nested":{"\u005f_proto__":"escaped"}}`,
    130, '49d10263e6462ebad629ae5c72e995dfc5039bd6632fc7c378a68519e568d6b9',
    647, 'c25ac44e9aa8c7a2d36ca8b2608fb6ba746e1549b4f3ac8f31fc39c8967eead4'],
];

function frozen(value) {
  if (value !== null && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}
function refuses(text, mode, status, reason) {
  let failure;
  try { scan(text, mode); } catch (error) { failure = error; }
  assert.notEqual(failure, undefined, 'no partial scanner result may escape');
  assert.deepEqual(classify(failure), { status, reason });
  assert.deepEqual(Reflect.ownKeys(failure), []);
  assert.ok(Object.isFrozen(failure));
  assert.ok(Object.isFrozen(classify(failure)));
}

for (const [name, text, plainBytes, plainHash, indexBytes, indexHash] of goldens) {
  for (const mode of modes) test(`pre-edit full scanner golden: ${name}/${mode}`, () => {
    const result = scan(text, mode), serialized = JSON.stringify(result);
    assert.equal(Buffer.byteLength(serialized), mode === 'index' ? indexBytes : plainBytes);
    assert.equal(hash(serialized), mode === 'index' ? indexHash : plainHash);
    frozen(result);
    assert.deepEqual(scan(text, mode), result);
  });
}

test('only tokens containing a backslash use JSON.parse, with the escape flag reset per token', t => {
  const parse = JSON.parse, calls = [];
  t.mock.method(JSON, 'parse', text => { calls.push(text); return parse(text); });
  const text = String.raw`["plain","","a\\b","\u0061","é",{"\u0062":"next","c":"x\/y"},"last"]`;
  for (const mode of modes) {
    calls.length = 0;
    scan(text, mode);
    assert.deepEqual(calls, [String.raw`"a\\b"`, String.raw`"\u0061"`, String.raw`"\u0062"`, String.raw`"x\/y"`]);
  }
});

test('literal and escaped keys have identical identity without normalization or prototype assignment', () => {
  const pairs = [
    ['"a"', String.raw`"\u0061"`], ['"é"', String.raw`"\u00e9"`],
    ['"e\u0301"', String.raw`"e\u0301"`], ['"😀"', String.raw`"\ud83d\ude00"`],
    ['"__proto__"', String.raw`"\u005f_proto__"`], ['"/"', String.raw`"\/"`],
    [String.raw`"\t"`, String.raw`"\u0009"`], [String.raw`"\""`, String.raw`"\u0022"`],
    [String.raw`"\\"`, String.raw`"\u005c"`],
  ];
  for (const [a, b] of pairs) for (const [first, second] of [[a, b], [b, a]]) {
    for (const mode of modes) refuses(`{${first}:0,${second}:9007199254740993}`, mode, 'unsupported', 'duplicate_json_key');
  }
  const distinct = scan(String.raw`{"a":"plain","\\u0061":"literal escape text","é":0,"é":1}`, 'index');
  assert.deepEqual(distinct.index.nodes[0].members.map(item => item.key), ['a', '\\u0061', 'é', 'é']);
  assert.equal(distinct.index.decoded_key_utf8_bytes, 12);
});

test('unescaped Unicode offsets are UTF-16 positions while key and input charges are UTF-8', () => {
  const text = '{"é":"e\u0301","😀":"𝄞","\u2028":"\u2029","\ufeff":"\u007f"}';
  const result = scan(text, 'index');
  assert.deepEqual(result.usage, { input_utf8_bytes: 48, decoded_nodes: 5, decoded_depth: 1,
    numeric_tokens: 0, numeric_token_utf8_bytes: 0 });
  assert.deepEqual(result.index.nodes.map(node => [node.start, node.end]), [[0, 36], [5, 9], [15, 19], [24, 27], [32, 35]]);
  assert.deepEqual(result.index.nodes.slice(1).map(node => text.slice(node.start, node.end)), ['"e\u0301"', '"𝄞"', '"\u2029"', '"\u007f"']);
  assert.equal(result.index.decoded_key_utf8_bytes, 12);
  for (const whitespace of ['\u2028', '\u2029', '\ufeff', '\u007f']) {
    for (const mode of modes) refuses('"plain"' + whitespace, mode, 'unsupported', 'invalid_json');
  }
});

test('every existing grammar and numeric first-failure example keeps its classified refusal', () => {
  for (const [text, reason] of invalidDocuments) {
    for (const mode of modes) refuses(text, mode, 'unsupported', reason);
  }
  for (const [, text, fullStatus, fullReason, rawStatus, rawReason] of firstFailures) {
    refuses(text, 'full_value', fullStatus, fullReason);
    for (const mode of ['validate_only', 'index']) refuses(text, mode, rawStatus, rawReason);
  }
});

test('raw controls and lone surrogates cannot bypass the original grammar or Unicode check', () => {
  for (const mode of modes) {
    for (let code = 0; code < 32; code++) {
      const character = String.fromCharCode(code), reason = code === 0 ? 'invalid_unicode' : 'invalid_json';
      refuses('"prefix' + character + 'suffix"', mode, 'unsupported', reason);
      refuses('{"key' + character + '":"value"}', mode, 'unsupported', reason);
    }
    for (const surrogate of ['\ud800', '\udfff', '\ud800x', '\udfff\ud800']) {
      refuses('"' + surrogate + '"', mode, 'unsupported', 'invalid_unicode');
      // The whole-original Unicode check still precedes earlier bad grammar.
      refuses('[x,"' + surrogate + '"]', mode, 'unsupported', 'invalid_unicode');
    }
    for (const escaped of [String.raw`"\ud800"`, String.raw`"\udfff"`, String.raw`"\u0000"`]) {
      refuses(escaped, mode, 'unsupported', 'invalid_unicode');
      refuses('[x,' + escaped + ']', mode, 'unsupported', 'invalid_json');
    }
    for (const malformed of [String.raw`"\x"`, String.raw`"\u012x"`, '"trailing\\', '"plain']) {
      refuses(malformed, mode, 'unsupported', 'invalid_json');
    }
  }
});

test('unescaped and escaped string leaves retain the exact byte ceiling in all three modes', () => {
  const texts = ['"' + 'é'.repeat(749999) + '"', '"' + String.raw`\u00e9`.repeat(249999) + 'abcd"'];
  for (const text of texts) {
    assert.equal(Buffer.byteLength(text), limits.input_bytes);
    for (const mode of modes) {
      const result = scan(text, mode);
      assert.deepEqual(result.usage, { input_utf8_bytes: 1500000, decoded_nodes: 1, decoded_depth: 0,
        numeric_tokens: 0, numeric_token_utf8_bytes: 0 });
      if (mode === 'index') assert.deepEqual(result.index.nodes, [
        { kind: 'string', start: 0, end: text.length, members: null, elements: null },
      ]);
      refuses(text + 'x', mode, 'limit_exceeded', 'input_bytes');
    }
  }
});

test('maximum unescaped key preserves decoded-key bytes without retaining extra string values', () => {
  const key = 'é'.repeat(749996) + 'aa', text = '{"' + key + '":0}';
  assert.equal(Buffer.byteLength(text), limits.input_bytes);
  const result = scan(text, 'index');
  assert.equal(result.index.decoded_key_utf8_bytes, 1499994);
  assert.deepEqual(result.index.nodes[0].members, [{ key, value: 1 }]);
  assert.equal(result.index.index_edges, 1);
  assert.deepEqual(Object.keys(result), ['usage', 'index']);
  assert.deepEqual(Object.keys(result.index.nodes[1]), ['kind', 'start', 'end', 'members', 'elements']);
  refuses(text + ' ', 'index', 'limit_exceeded', 'input_bytes');
});

test('string leaves retain the same depth, node and index-edge ceilings', () => {
  const deep = '['.repeat(35) + '"plain"' + ']'.repeat(35);
  const wide = '[' + Array(99999).fill('""').join(',') + ']';
  for (const mode of modes) {
    assert.equal(scan(deep, mode).usage.decoded_depth, 35);
    refuses('[' + deep + ']', mode, 'limit_exceeded', 'decoded_depth');
    const result = scan(wide, mode);
    assert.deepEqual(result.usage, { input_utf8_bytes: 299998, decoded_nodes: 100000, decoded_depth: 1,
      numeric_tokens: 0, numeric_token_utf8_bytes: 0 });
    if (mode === 'index') {
      assert.equal(result.index.nodes.length, 100000);
      assert.equal(result.index.index_edges, 99999);
      assert.equal(result.index.nodes.at(-1).end, wide.length - 1);
    }
    refuses(wide.slice(0, -1) + ',""]', mode, 'limit_exceeded', 'decoded_nodes');
  }
});
