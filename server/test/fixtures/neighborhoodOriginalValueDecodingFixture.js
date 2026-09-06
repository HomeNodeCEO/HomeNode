// Literal representation fixtures, not provider/database or workflow evidence.
// Expected values come from the frozen decoder contract, before any execution.
export const decodedScalars = [
  ['zero', 'numeric', '0', 0], ['scaled zero', 'numeric', '0.00', 0],
  ['manual zero exponent', 'numeric', '0e+1000', 0],
  ['scaled year', 'numeric', '1990.0', 1990], ['decimal scale', 'numeric', '1250.00', 1250],
  ['positive exponent', 'numeric', '1e3', 1000], ['negative exponent', 'numeric', '125e-2', 1.25],
  ['canonical decimal', 'numeric', '0.1', 0.1], ['negative decimal', 'numeric', '-0.1', -0.1],
  ['exact unsafe integer', 'numeric', '9007199254740992', 9007199254740992],
  ['smallest canonical subnormal', 'numeric', '5e-324', 5e-324],
  ['subnormal decimal equivalent', 'numeric', '0.5e-323', 5e-324],
  ['max finite rendering', 'numeric', '1.7976931348623157e308', 1.7976931348623157e308],
  ['first Gregorian year', 'date', '0001-01-01', '0001-01-01'],
  ['last Gregorian year', 'date', '9999-12-31', '9999-12-31'],
  ['century leap year', 'date', '2000-02-29', '2000-02-29'],
  ['timestamp retains six digits', 'timestamptz', '2024-02-29 23:59:59.123456+00', '2024-02-29T23:59:59.123456Z'],
  ['timestamp pads three digits', 'timestamptz', '2024-02-29T23:59:59.123+00:00', '2024-02-29T23:59:59.123000Z'],
  ['timestamp omitted fraction', 'timestamptz', '0001-01-01 00:00:00Z', '0001-01-01T00:00:00.000000Z'],
  ['timestamp one digit', 'timestamptz', '9999-12-31T23:59:59.9Z', '9999-12-31T23:59:59.900000Z'],
  ['canonical microsecond', 'utc6', '2026-09-06T12:00:00.000001Z', '2026-09-06T12:00:00.000001Z'],
];
export const refusedNumerics = [
  ['NaN', 'nonfinite_numeric'], ['Infinity', 'nonfinite_numeric'], ['-Infinity', 'nonfinite_numeric'],
  ['9007199254740993', 'inexact_numeric'], ['0.10000000000000001', 'inexact_numeric'],
  ['1.7976931348623158e308', 'inexact_numeric'], ['2e308', 'nonfinite_numeric'],
  ['1e-324', 'numeric_underflow'], ['-1e-324', 'numeric_underflow'], ['4e-324', 'inexact_numeric'],
  ['-0', 'negative_zero'], ['-0.00e2', 'negative_zero'], ['-0e-1000', 'negative_zero'],
  ['', 'invalid_numeric_text'], [' 1', 'invalid_numeric_text'], ['1 ', 'invalid_numeric_text'],
  ['+1', 'invalid_numeric_text'], ['01', 'invalid_numeric_text'], ['.5', 'invalid_numeric_text'],
  ['1.', 'invalid_numeric_text'], ['0x10', 'invalid_numeric_text'], ['1_000', 'invalid_numeric_text'],
  ['1e', 'invalid_numeric_text'], ['1,000', 'invalid_numeric_text'], ['１２', 'invalid_numeric_text'],
];
export const refusedJson = [
  ['', 'invalid_json'], [' ', 'invalid_json'], ['[1,]', 'invalid_json'], ['{"a":1,}', 'invalid_json'],
  ['[1 2]', 'invalid_json'], ['{"a" 1}', 'invalid_json'], ['{"a":}', 'invalid_json'],
  ['{"a":1} false', 'invalid_json'], ['truex', 'invalid_json'], ['[01]', 'invalid_json'],
  ['[.5]', 'invalid_json'], ['[+1]', 'invalid_json'], ['[1e+]', 'invalid_json'],
  ['NaN', 'invalid_json'], ['undefined', 'invalid_json'], ['"unterminated', 'invalid_json'],
  ['"\\q"', 'invalid_json'], ['"\\u00zz"', 'invalid_json'], ['"\\u123"', 'invalid_json'],
  ['"a\nb"', 'invalid_json'], ['{"a":1,"a":2}', 'duplicate_json_key'],
  ['{"a":1,"\\u0061":2}', 'duplicate_json_key'],
  ['{"__proto__":1,"\\u005f_proto__":2}', 'duplicate_json_key'],
  ['"\\u0000"', 'invalid_unicode'], ['"\u0000"', 'invalid_unicode'],
  ['"\\ud800"', 'invalid_unicode'], ['"\\udc00"', 'invalid_unicode'],
  ['"\ud800"', 'invalid_unicode'], ['"\udc00"', 'invalid_unicode'],
  ['{"\\u0000":1}', 'invalid_unicode'], ['{"\\ud800":1}', 'invalid_unicode'],
];
export const refusedDates = ['0000-01-01', '1900-02-29', '2023-02-29', '2024-04-31', '2024-00-01',
  '2024-01-00', '2024-13-01', '2024-01-32', '2024-1-01', '2024-01-01 ',
  '2024-01-01T00:00:00Z', 'infinity', '0001-01-01 BC', '+010000-01-01'];
export const refusedTimestamps = ['0000-01-01T00:00:00Z', '1900-02-29 00:00:00+00',
  '2024-01-01T24:00:00Z', '2024-01-01T00:60:00Z', '2024-01-01T00:00:60Z',
  '2024-01-01T00:00:00', '2024-01-01T00:00:00+01', '2024-01-01T00:00:00-00',
  '2024-01-01T00:00:00.1234567Z', '2024-01-01T00:00:00.Z', '2024-01-01T00:00:00Z ',
  'infinity', '2024-1-01T00:00:00Z'];

// Strict scalar text must refuse every line terminator, without trimming it.
export const wholeTokenRefusals = [
  ['numeric', '1', 'invalid_numeric_text'],
  ['timestamptz', '2024-02-29 12:34:56.123456+00', 'invalid_timestamp_text'],
  ['utc6', '2024-02-29T12:34:56.123456Z', 'invalid_timestamp_text'],
  ['date', '2024-02-29', 'invalid_date_text'],
].flatMap(([kind, prefix, reason]) => [
  ['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['LS', '\u2028'], ['PS', '\u2029'],
].map(([label, suffix]) => ({ kind, text: prefix + suffix, reason, label })));

export const completeSnapshotText = '{"subject_data":{"manual":{"site_area":0,"year_built":1990.0},"public":{"owner":"ACME LLC","gla":2250.00}},"source_manifest":{"complete":false,"rows":[null,true,"1990",0.1,5e-324]}}';
export const completeSnapshotValue = {
  subject_data: { manual: { site_area: 0, year_built: 1990 }, public: { owner: 'ACME LLC', gla: 2250 } },
  source_manifest: { complete: false, rows: [null, true, '1990', 0.1, 5e-324] },
};

export function expectedDecoded(kind, state, value, usage) {
  return { decoder_version: 1, interpretation: 'representation_only', status: 'decoded', reason: null,
    kind, storage_state: state, value, usage };
}
export function expectedFailure(kind, state, status, reason) {
  return { decoder_version: 1, interpretation: 'representation_only', status, reason,
    kind, storage_state: state, value: null, usage: null };
}
export const scalarUsage = (text, numeric = false) => ({
  input_utf8_bytes: Buffer.byteLength(text, 'utf8'), decoded_nodes: 1, decoded_depth: 0,
  numeric_tokens: numeric ? 1 : 0, numeric_token_utf8_bytes: numeric ? text.length : 0,
});
