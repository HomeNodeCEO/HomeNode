import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { ASSIGNMENT_SALES_CSV_LIMITS as LIMITS, parseAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/parse.js';

const parse = (text) => parseAssignmentSalesCsv(Buffer.from(text));
const throws = (input, reason) => assert.throws(() => parseAssignmentSalesCsv(input), (error) => {
  assert.equal(error.code, `assignment_sales_csv_${reason}`);
  assert.equal(error.message, error.code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.deepEqual(Object.keys(error), ['code']);
  return true;
});
const fails = (text, reason) => throws(Buffer.from(text), reason);

test('fixed limits are frozen with no caller override surface', () => {
  assert.deepEqual(LIMITS, { maxFileBytes: 8388608, maxDataRows: 10000, maxColumns: 128, maxFieldBytes: 16384, maxCells: 250000 });
  assert.equal(Object.isFrozen(LIMITS), true);
  assert.throws(() => { LIMITS.maxDataRows = Infinity; }, TypeError);
});

test('simple rows preserve strings, original headers and mapping-only trimming', () => {
  const raw = Buffer.from(' AccountNumber ,ClosePrice,Unknown Label\r\n0000123,00125.5000, literal value \r\n');
  const result = parseAssignmentSalesCsv(raw);
  assert.deepEqual(result.headers, [' AccountNumber ', 'ClosePrice', 'Unknown Label']);
  assert.deepEqual(result.columns, ['AccountNumber', 'ClosePrice', 'Unknown Label']);
  assert.deepEqual(result.rows[0].cells, ['0000123', '00125.5000', ' literal value ']);
  assert.equal(result.source_sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.source_byte_length, raw.length);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source_row_number, 2);
  assert.equal(result.rows[0].source_line_number, 2);
  assert.equal(raw.subarray(result.rows[0].byte_start, result.rows[0].byte_end).toString(), '0000123,00125.5000, literal value ');
});

for (const separator of ['\n', '\r\n', '\r']) {
  test(`record separator ${JSON.stringify(separator)} retains exact offsets and no terminal phantom row`, () => {
    const header = 'A,B';
    const first = '1,2';
    const second = '3,4';
    const result = parse([header, first, second, ''].join(separator));
    assert.deepEqual(result.rows.map((row) => row.cells), [['1', '2'], ['3', '4']]);
    assert.deepEqual(result.rows.map((row) => [row.source_row_number, row.source_line_number]), [[2, 2], [3, 3]]);
    assert.deepEqual(result.rows.map((row) => [row.byte_start, row.byte_end]), [
      [header.length + separator.length, header.length + separator.length + first.length],
      [header.length + first.length + 2 * separator.length, header.length + first.length + second.length + 2 * separator.length],
    ]);
  });
}

test('quoted commas, RFC doubled quotes and all embedded line breaks are preserved without normalization', () => {
  const result = parse('A,B,C\n"a,b","say ""yes""","one\r\ntwo\rthree\nfour"\n');
  assert.deepEqual(result.rows[0].cells, ['a,b', 'say "yes"', 'one\r\ntwo\rthree\nfour']);
});

test('BOM and multibyte data keep original absolute byte offsets and physical starting lines', () => {
  const header = '\ufeffId,Text\r\n';
  const records = [
    { value: '001,"α\r\nβ"', separator: '\r\n', line: 2, cells: ['001', 'α\r\nβ'] },
    { value: '', separator: '\r\n', line: 4, cells: [''] },
    { value: '002,🙂', separator: '\r', line: 5, cells: ['002', '🙂'] },
    { value: '003,"x\ry\nz"', separator: '', line: 6, cells: ['003', 'x\ry\nz'] },
  ];
  const input = Buffer.from(header + records.map((record) => record.value + record.separator).join(''));
  const result = parseAssignmentSalesCsv(input);
  assert.deepEqual(result.headers, ['Id', 'Text']);
  let offset = Buffer.byteLength(header);
  for (const [index, record] of records.entries()) {
    const row = result.rows[index];
    assert.deepEqual(row, { source_row_number: index + 2, source_line_number: record.line,
      byte_start: offset, byte_end: offset + Buffer.byteLength(record.value), cells: record.cells });
    assert.equal(input.subarray(row.byte_start, row.byte_end).toString(), record.value);
    offset += Buffer.byteLength(record.value + record.separator);
  }
  assert.equal(result.source_byte_length, input.length);
  assert.equal(result.source_sha256, createHash('sha256').update(input).digest('hex'));
});

test('only the initial file BOM is removed; data BOMs and Unicode text survive', () => {
  const result = parse('\ufeffA,B\n\ufeffvalue,"\ufeffα🙂"');
  assert.deepEqual(result.rows[0].cells, ['\ufeffvalue', '\ufeffα🙂']);
  assert.notEqual(result.source_sha256, parse('A,B\n\ufeffvalue,"\ufeffα🙂"').source_sha256);
});

test('embedded header newline is rejected, not confused with the following data line', () => {
  fails('"A\nB",C\nx,y', 'invalid_header');
});

test('empty intermediate records, all blank cells, whitespace and ragged rows are never dropped', () => {
  const result = parse('A,B,C\n\n,\n,,\n \n1,2\n3,4,5,6\n');
  assert.deepEqual(result.rows.map((row) => row.cells), [[''], ['', ''], ['', '', ''], [' '], ['1', '2'], ['3', '4', '5', '6']]);
  assert.deepEqual(result.rows.map((row) => row.source_row_number), [2, 3, 4, 5, 6, 7]);
  assert.equal(result.rows[0].byte_start, result.rows[0].byte_end);
});

test('LF followed by CR is two separators; CRLF is one', () => {
  const result = parse('A\n\rx\r\ny');
  assert.deepEqual(result.rows.map((row) => [row.source_line_number, row.cells]), [[2, ['']], [3, ['x']], [4, ['y']]]);
});

for (const [suffix, expected] of [['', []], ['\n', []], ['\r\n', []], ['\n\n', [['']]],
  ['\n""', [['']]], ['\n""\n', [['']]], ['\n,', [['', '']]], ['\n"",', [['', '']]]]) {
  test(`header/terminal empty-field case ${JSON.stringify(suffix)}`, () => {
    assert.deepEqual(parse(`A${suffix}`).rows.map((row) => row.cells), expected);
  });
}

test('final quoted empty field is a real zero-byte decoded cell, with encoded bytes retained by offsets', () => {
  const input = Buffer.from('A\n""');
  const row = parseAssignmentSalesCsv(input).rows[0];
  assert.deepEqual(row, { source_row_number: 2, source_line_number: 2, byte_start: 2, byte_end: 4, cells: [''] });
  assert.equal(input.subarray(row.byte_start, row.byte_end).toString(), '""');
});

test('prototype-like and unknown headers are plain strings; formulas are never interpreted', () => {
  const result = parse('__proto__,constructor,toString,Unknown\n=SUM(A1:A9),+1,-10,@SUM(1)');
  assert.deepEqual(result.columns, ['__proto__', 'constructor', 'toString', 'Unknown']);
  assert.deepEqual(result.rows[0].cells, ['=SUM(A1:A9)', '+1', '-10', '@SUM(1)']);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result), ['source_sha256', 'source_byte_length', 'headers', 'columns', 'rows']);
});

for (const header of ['', '\ufeff']) test(`empty/BOM-only file is missing header ${JSON.stringify(header)}`, () => fails(header, 'missing_header'));
for (const header of ['\n', ',', 'A,', ' ,B', '"",B', '\tA,B', '"A\rB",C', 'A\u007f,B', 'A\u0085,B']) {
  test(`empty or control header is rejected ${JSON.stringify(header)}`, () => fails(header, 'invalid_header'));
}
for (const header of ['A,A', 'A,a', ' a ,A', '"A",a', 'K,K']) {
  test(`case-insensitive trimmed duplicate header is rejected ${JSON.stringify(header)}`, () => fails(header, 'duplicate_header'));
}

for (const text of ['A\nx"y', 'A\n"x', 'A\n"x"y', 'A\n"x" ', 'A\n "x"',
  'A\n"x"\t', 'A\n"x""', 'A\n"', 'A\n""x', 'A\nx,"y\n', 'a"b\nx']) {
  test(`malformed quoting is rejected without row content ${JSON.stringify(text)}`, () => fails(text, 'malformed_csv'));
}

test('quotes can be data only when doubled inside a quoted field', () => {
  assert.deepEqual(parse('A\n""""').rows[0].cells, ['"']);
  assert.deepEqual(parse('A\n"""quoted"""').rows[0].cells, ['"quoted"']);
});

for (const suffix of [[0xff], [0xc0, 0xaf], [0x80], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xef, 0xbb]]) {
  test(`invalid UTF-8 byte sequence ${suffix.join(',')} is globally rejected`, () => {
    throws(Buffer.concat([Buffer.from('A\n'), Buffer.from(suffix)]), 'invalid_utf8');
  });
}
for (const text of ['A\0\nx', 'A\nx\0', 'A\n"x\0y"']) test('NUL is globally rejected', () => fails(text, 'nul_byte'));

test('other data control characters remain literal strings rather than silently normalized', () => {
  assert.deepEqual(parse('A\n\t\u0001\u007f\u0085').rows[0].cells, ['\t\u0001\u007f\u0085']);
});

for (const input of [null, undefined, 'A\nx', ['A', 'x'], { length: 3 }, new Uint8Array([65, 10, 120]), new ArrayBuffer(3)]) {
  test(`non-Buffer input ${typeof input} is rejected`, () => throws(input, 'invalid_input'));
}

test('Buffer proxy and subclass are rejected without executing traps', () => {
  let touched = 0;
  const proxy = new Proxy(Buffer.from('A\nx'), { get() { touched += 1; throw new Error('private'); },
    getPrototypeOf() { touched += 1; throw new Error('private'); } });
  throws(proxy, 'invalid_input');
  class DerivedBuffer extends Buffer {}
  const derived = Buffer.from('A\nx');
  Object.setPrototypeOf(derived, DerivedBuffer.prototype);
  throws(derived, 'invalid_input');
  assert.equal(touched, 0);
});

test('a proxy inserted into a Buffer prototype chain is not traversed by admission', () => {
  let touched = 0;
  const input = Buffer.from('A\nx');
  const prototype = new Proxy({}, { getPrototypeOf() { touched += 1; throw new Error('must not traverse'); },
    get() { touched += 1; throw new Error('must not read'); } });
  Object.setPrototypeOf(input, prototype);
  throws(input, 'invalid_input');
  assert.equal(touched, 0);
});

test('shared backing memory and detached typed-array storage are refused', () => {
  throws(Buffer.from(new SharedArrayBuffer(3)), 'invalid_input');
  const array = new ArrayBuffer(3);
  const input = Buffer.from(array);
  structuredClone(array, { transfer: [array] });
  throws(input, 'invalid_input');
});

test('custom Buffer properties are never evaluated, even when shadowing length/buffer/copy methods', () => {
  const input = Buffer.from('A\nx');
  let touched = 0;
  for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'constructor', 'toString', 'subarray', 'slice', 'copy', 'privateProperty', Symbol.iterator]) {
    Object.defineProperty(input, key, { get() { touched += 1; throw new Error('must not evaluate'); } });
  }
  const result = parseAssignmentSalesCsv(input);
  assert.equal(result.source_byte_length, 3);
  assert.deepEqual(result.rows[0].cells, ['x']);
  assert.equal(touched, 0);
});

test('nonzero-offset Buffer view hashes and locates only its bytes, without modifying backing storage', () => {
  const backing = Buffer.from('private-prefixA\nxprivate-suffix');
  const original = Buffer.from(backing);
  const input = backing.subarray(14, 17);
  assert.equal(input.toString(), 'A\nx');
  const result = parseAssignmentSalesCsv(input);
  assert.equal(result.source_sha256, createHash('sha256').update('A\nx').digest('hex'));
  assert.equal(result.rows[0].byte_start, 2);
  assert.deepEqual(backing, original);
});

test('snapshot output is deeply frozen, detached from caller mutation and contains no raw Buffer', () => {
  const input = Buffer.from('A,B\nx,y');
  const result = parseAssignmentSalesCsv(input);
  const json = JSON.stringify(result);
  input.fill(0);
  assert.equal(JSON.stringify(result), json);
  for (const value of [result, result.headers, result.columns, result.rows, result.rows[0], result.rows[0].cells]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => result.rows[0].cells.push('different'), TypeError);
});

test('data-row bound counts blank records and permits exactly 10000 data rows', () => {
  const result = parse(`A\n${'\n'.repeat(LIMITS.maxDataRows)}`);
  assert.equal(result.rows.length, LIMITS.maxDataRows);
  assert.equal(result.rows.at(-1).source_row_number, LIMITS.maxDataRows + 1);
  fails(`A\n${'\n'.repeat(LIMITS.maxDataRows + 1)}`, 'row_limit');
});

test('128 columns allowed; extra header or ragged-data column rejected', () => {
  const header = Array.from({ length: LIMITS.maxColumns }, (_, index) => `H${index}`).join(',');
  const data = Array(LIMITS.maxColumns).fill('x').join(',');
  const result = parse(`${header}\n${data}`);
  assert.equal(result.columns.length, LIMITS.maxColumns);
  assert.equal(result.rows[0].cells.length, LIMITS.maxColumns);
  fails(`${header},extra`, 'column_limit');
  fails(`A\n${data},`, 'column_limit');
});

test('field limits measure exact decoded UTF8 bytes, including multibyte characters and doubled quotes', () => {
  const literal = 'x'.repeat(LIMITS.maxFieldBytes);
  assert.equal(parse(`A\n${literal}`).rows[0].cells[0].length, LIMITS.maxFieldBytes);
  assert.equal(parse(`${literal}\nx`).headers[0].length, LIMITS.maxFieldBytes);
  fails(`A\n${literal}x`, 'field_byte_limit');
  fails(`${literal}x\ny`, 'field_byte_limit');
  const unicode = '🙂'.repeat(LIMITS.maxFieldBytes / 4);
  assert.equal(Buffer.byteLength(parse(`A\n"${unicode}"`).rows[0].cells[0]), LIMITS.maxFieldBytes);
  fails(`A\n"${unicode}x"`, 'field_byte_limit');
  const quotes = '""'.repeat(LIMITS.maxFieldBytes);
  assert.equal(parse(`A\n"${quotes}"`).rows[0].cells[0], '"'.repeat(LIMITS.maxFieldBytes));
  fails(`A\n"${quotes}"""`, 'field_byte_limit');
  const newlines = '\r\n'.repeat(LIMITS.maxFieldBytes / 2);
  assert.equal(Buffer.byteLength(parse(`A\n"${newlines}"`).rows[0].cells[0]), LIMITS.maxFieldBytes);
  fails(`A\n"${newlines}\r"`, 'field_byte_limit');
});

test('250000-cell bound includes header cells and never silently truncates a complete record set', () => {
  const width = 25;
  const header = Array.from({ length: width }, (_, index) => `H${index}`).join(',');
  const data = `${Array(width).fill('x').join(',')}\n`;
  const input = `${header}\n${data.repeat(9999)}`;
  const result = parse(input);
  assert.equal(result.rows.length, 9999);
  assert.equal(result.headers.length + result.rows.reduce((sum, row) => sum + row.cells.length, 0), LIMITS.maxCells);
  fails(`${input}x`, 'cell_limit');
});

test('8MiB exact file is permitted when all other bounds fit, and the next byte is refused before parsing', () => {
  const header = 'A\n';
  const record = `${'x'.repeat(LIMITS.maxFieldBytes)}\n`;
  const fullRows = Math.floor((LIMITS.maxFileBytes - header.length) / record.length);
  const tail = LIMITS.maxFileBytes - header.length - fullRows * record.length;
  const input = Buffer.from(header + record.repeat(fullRows) + 'x'.repeat(tail));
  assert.equal(input.length, LIMITS.maxFileBytes);
  const result = parseAssignmentSalesCsv(input);
  assert.equal(result.source_byte_length, LIMITS.maxFileBytes);
  assert.equal(result.rows.length, fullRows + Number(tail > 0));
  throws(Buffer.concat([input, Buffer.from('x')]), 'file_byte_limit');
});

test('BOM bytes count toward file bound and source digest, not decoded header field length', () => {
  const header = 'H'.repeat(LIMITS.maxFieldBytes);
  const result = parse(`\ufeff${header}\nx`);
  assert.equal(result.headers[0].length, LIMITS.maxFieldBytes);
  assert.equal(result.source_byte_length, 3 + LIMITS.maxFieldBytes + 2);
});
