// Literal contract examples, independent of the scanner's implementation.
export const indexedText = ' \n{"0":[null,false,0],"é":{"__proto__":"😀"}}\t';
export const indexedExpected = {
  usage: { input_utf8_bytes: 49, decoded_nodes: 7, decoded_depth: 2,
    numeric_tokens: 1, numeric_token_utf8_bytes: 1 },
  index: { root: 0, index_edges: 6, decoded_key_utf8_bytes: 12, nodes: [
    { kind: 'object', start: 2, end: 45, members: [{ key: '0', value: 1 }, { key: 'é', value: 5 }], elements: null },
    { kind: 'array', start: 7, end: 21, members: null, elements: [2, 3, 4] },
    { kind: 'null', start: 8, end: 12, members: null, elements: null },
    { kind: 'boolean', start: 13, end: 18, members: null, elements: null },
    { kind: 'number', start: 19, end: 20, members: null, elements: null },
    { kind: 'object', start: 26, end: 44, members: [{ key: '__proto__', value: 6 }], elements: null },
    { kind: 'string', start: 39, end: 43, members: null, elements: null },
  ] },
};
export const orderedText = '{"10":1,"2":2,"a":3}';
export const orderedExpected = {
  usage: { input_utf8_bytes: 20, decoded_nodes: 4, decoded_depth: 1,
    numeric_tokens: 3, numeric_token_utf8_bytes: 3 },
  index: { root: 0, index_edges: 3, decoded_key_utf8_bytes: 4, nodes: [
    { kind: 'object', start: 0, end: 20,
      members: [{ key: '10', value: 1 }, { key: '2', value: 2 }, { key: 'a', value: 3 }], elements: null },
    { kind: 'number', start: 6, end: 7, members: null, elements: null },
    { kind: 'number', start: 12, end: 13, members: null, elements: null },
    { kind: 'number', start: 18, end: 19, members: null, elements: null },
  ] },
};

export const invalidDocuments = [
  ['', 'invalid_json'], [' ', 'invalid_json'], ['01', 'invalid_json'], ['+1', 'invalid_json'],
  ['1.', 'invalid_json'], ['1e', 'invalid_json'], ['[1,]', 'invalid_json'], ['{"a":1,}', 'invalid_json'],
  ['[true false]', 'invalid_json'], ['{"a" 1}', 'invalid_json'], ['{"a":}', 'invalid_json'],
  ['NaN', 'invalid_json'], ['Infinity', 'invalid_json'], ['truex', 'invalid_json'],
  ['[0]false', 'invalid_json'], ['{"a":0,"a":1}', 'duplicate_json_key'],
  ['{"a":0,"\\u0061":1}', 'duplicate_json_key'],
  ['{"__proto__":0,"__proto__":1}', 'duplicate_json_key'],
  ['"\\x00"', 'invalid_json'], ['"\\u00xz"', 'invalid_json'], ['"unterminated', 'invalid_json'],
  ['"literal\nnewline"', 'invalid_json'], ['"\\u0000"', 'invalid_unicode'],
  ['"\\ud800"', 'invalid_unicode'], ['"\\udc00"', 'invalid_unicode'],
  ['{"\\ud800":0}', 'invalid_unicode'], ['"\u0000"', 'invalid_unicode'],
  ['"\ud800"', 'invalid_unicode'], ['"\udc00"', 'invalid_unicode'],
  ['1\u2028', 'invalid_json'], ['1\u2029', 'invalid_json'],
];
// [name, text, full-value status/reason, syntax-only status/reason].
export const firstFailures = [
  ['early inexact before trailing comma', '[9007199254740993,]', 'unsupported', 'inexact_numeric', 'unsupported', 'invalid_json'],
  ['early inexact before duplicate', '{"a":9007199254740993,"a":0}', 'unsupported', 'inexact_numeric', 'unsupported', 'duplicate_json_key'],
  ['negative zero before later grammar', '[-0,]', 'unsupported', 'negative_zero', 'unsupported', 'invalid_json'],
  ['exponent limit before later grammar', '[1e999999,]', 'limit_exceeded', 'numeric_exponent_limit', 'unsupported', 'invalid_json'],
  ['nonfinite before later grammar', '[2e308,]', 'unsupported', 'nonfinite_numeric', 'unsupported', 'invalid_json'],
  ['decoded Unicode first', '["\\ud800",9007199254740993]', 'unsupported', 'invalid_unicode', 'unsupported', 'invalid_unicode'],
  ['whole original Unicode before early numeric', '[9007199254740993,"\ud800"]', 'unsupported', 'invalid_unicode', 'unsupported', 'invalid_unicode'],
  ['early numeric before later escaped Unicode', '[9007199254740993,"\\ud800"]', 'unsupported', 'inexact_numeric', 'unsupported', 'invalid_unicode'],
  ['original token cap before malformed exponent', '1'.repeat(257) + 'e', 'limit_exceeded', 'numeric_token_limit', 'unsupported', 'invalid_json'],
  ['duplicate before later numeric', '{"a":0,"a":9007199254740993}', 'unsupported', 'duplicate_json_key', 'unsupported', 'duplicate_json_key'],
  ['earlier malformed value', '[x,1e999999]', 'unsupported', 'invalid_json', 'unsupported', 'invalid_json'],
];
export const rawNumbers = [
  ['1e999999', 'limit_exceeded', 'numeric_exponent_limit'],
  ['1'.repeat(257), 'limit_exceeded', 'numeric_token_limit'],
  ['9007199254740993', 'unsupported', 'inexact_numeric'],
  ['-0', 'unsupported', 'negative_zero'],
  ['1e-324', 'unsupported', 'numeric_underflow'],
  ['2e308', 'unsupported', 'nonfinite_numeric'],
];
