import { Buffer, isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const ASSIGNMENT_SALES_CSV_LIMITS = Object.freeze({
  maxFileBytes: 8388608,
  maxDataRows: 10000,
  maxColumns: 128,
  maxFieldBytes: 16384,
  maxCells: 250000,
});

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const backingBufferOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const copyBytes = Uint8Array.prototype.set;

function reject(reason) {
  const code = `assignment_sales_csv_${reason}`;
  const error = new Error(code);
  error.code = code;
  throw error;
}

function snapshotOf(input) {
  if (types.isProxy(input) || !types.isUint8Array(input)
    || Object.getPrototypeOf(input) !== Buffer.prototype || !Buffer.isBuffer(input)) reject('invalid_input');
  // Never invoke caller-supplied length/buffer/iterator/copy methods or enumerate
  // millions of numeric own keys. Non-byte custom properties are ignored entirely.
  let length;
  let backing;
  try {
    length = byteLengthOf.call(input);
    backing = backingBufferOf.call(input);
  } catch { reject('invalid_input'); }
  if (types.isSharedArrayBuffer(backing)) reject('invalid_input');
  if (length > ASSIGNMENT_SALES_CSV_LIMITS.maxFileBytes) reject('file_byte_limit');
  const snapshot = Buffer.allocUnsafe(length);
  try { copyBytes.call(snapshot, input); } catch { reject('invalid_input'); }
  return snapshot;
}

/**
 * Pure, synchronous, bounded CSV parsing. Offsets address the original file bytes;
 * row numbers count logical records, whereas line numbers count CRLF/LF/CR lines.
 * Cells are literal text, not spreadsheet expressions or authenticated sale facts.
 */
export function parseAssignmentSalesCsv(input) {
  const bytes = snapshotOf(input);
  if (!isUtf8(bytes)) reject('invalid_utf8');
  if (bytes.includes(0)) reject('nul_byte');
  const length = bytes.length;
  let position = length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let line = 1;
  let cellCount = 0;
  let headers = null;
  let columns = null;
  const rows = [];
  const delimiter = (byte) => byte === 44 || byte === 13 || byte === 10;
  const fieldLimit = (size) => {
    if (size > ASSIGNMENT_SALES_CSV_LIMITS.maxFieldBytes) reject('field_byte_limit');
  };

  function field() {
    if (bytes[position] !== 34) {
      const start = position;
      while (position < length && !delimiter(bytes[position])) {
        if (bytes[position] === 34) reject('malformed_csv');
        position += 1;
        fieldLimit(position - start);
      }
      return bytes.toString('utf8', start, position);
    }
    position += 1;
    let segmentStart = position;
    let decodedBytes = 0;
    const segments = [];
    while (position < length) {
      const byte = bytes[position];
      if (byte === 34) {
        segments.push(bytes.toString('utf8', segmentStart, position));
        if (bytes[position + 1] === 34) {
          segments.push('"');
          decodedBytes += 1;
          fieldLimit(decodedBytes);
          position += 2;
          segmentStart = position;
          continue;
        }
        position += 1;
        if (position < length && !delimiter(bytes[position])) reject('malformed_csv');
        return segments.join('');
      }
      if (byte === 13 || byte === 10) {
        const width = byte === 13 && bytes[position + 1] === 10 ? 2 : 1;
        decodedBytes += width;
        fieldLimit(decodedBytes);
        position += width;
        line += 1;
      } else {
        position += 1;
        decodedBytes += 1;
        fieldLimit(decodedBytes);
      }
    }
    reject('malformed_csv');
  }

  while (position < length) {
    if (headers && rows.length === ASSIGNMENT_SALES_CSV_LIMITS.maxDataRows) reject('row_limit');
    const byteStart = position;
    const sourceLine = line;
    const cells = [];
    while (true) {
      if (cells.length === ASSIGNMENT_SALES_CSV_LIMITS.maxColumns) reject('column_limit');
      if (cellCount === ASSIGNMENT_SALES_CSV_LIMITS.maxCells) reject('cell_limit');
      cells.push(field());
      cellCount += 1;
      if (bytes[position] !== 44) break;
      position += 1;
    }
    const byteEnd = position;
    if (position < length) {
      // field() can only stop at a record separator, comma (handled above), or EOF.
      position += bytes[position] === 13 && bytes[position + 1] === 10 ? 2 : 1;
      line += 1;
    }
    if (headers === null) {
      const seen = new Set();
      columns = cells.map((value) => {
        if (/\p{Cc}/u.test(value)) reject('invalid_header');
        const column = value.trim();
        if (!column.length) reject('invalid_header');
        const key = column.toLowerCase();
        if (seen.has(key)) reject('duplicate_header');
        seen.add(key);
        return column;
      });
      headers = Object.freeze(cells);
      Object.freeze(columns);
    } else {
      rows.push(Object.freeze({
        source_row_number: rows.length + 2,
        source_line_number: sourceLine,
        byte_start: byteStart,
        byte_end: byteEnd,
        cells: Object.freeze(cells),
      }));
    }
  }
  if (headers === null) reject('missing_header');
  return Object.freeze({
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    source_byte_length: length,
    headers,
    columns,
    rows: Object.freeze(rows),
  });
}
