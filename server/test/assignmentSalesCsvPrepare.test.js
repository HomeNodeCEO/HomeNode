import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';

const headers = ['ListingKey', 'ListingId', 'Address', 'ParcelNumber', 'CloseDate', 'CurrentPrice',
  'MlsStatus', 'StructuralStyle', 'BuyerFinancing', 'SellerContributions'];
const base = ['key-1', 'id-1', '101 Synthetic Ln', 'R-001-002', '8/25/2020', '282500',
  'Closed', 'Single Detached', 'Conventional', '0'];
const quote = value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const csv = (rows, names = headers) => Buffer.from([names, ...rows].map(row => row.map(quote).join(',')).join('\r\n'));
const prepare = rows => prepareAssignmentSalesCsv(csv(rows));

test('historical preparation is explicitly uncommitted, unmatched and not selected', () => {
  const bytes = csv([base]);
  const result = prepareAssignmentSalesCsv(bytes);
  assert.equal(result.persisted, false);
  assert.equal(result.intended_scope, 'assignment_private');
  assert.equal(result.source_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.source_byte_length, bytes.length);
  assert.equal(result.rows[0].values.close_date, '2020-08-25');
  assert.equal(result.rows[0].values.current_price, '282500');
  assert.equal(result.rows[0].values.parcel_number_raw, 'R-001-002');
  assert.equal(result.rows[0].persisted, false);
  assert.equal(result.rows[0].matching_status, 'not_evaluated');
  assert.equal(result.rows[0].analysis_status, 'not_evaluated');
  assert.equal(result.source_interpretation_status, 'not_reviewed');
  assert.equal(result.summary.prepared, 1);
  assert.equal(result.rows[0].source_row_number, 2);
});

test('does not drop blank, ragged, invalid, duplicate or conflicting logical records', () => {
  const malformed = [...base]; malformed[4] = '2/30/2020'; malformed[0] = 'key-2'; malformed[1] = 'id-2';
  const changed = [...base]; changed[5] = '300000';
  const result = prepare([base, base, changed, [], ['bad', 'shape'], malformed]);
  assert.equal(result.row_count, 6);
  assert.equal(Object.values(result.summary).reduce((sum, count) => sum + count, 0), 6);
  assert.deepEqual(result.rows.map(row => row.preparation_disposition),
    ['identity_conflict', 'identity_conflict', 'identity_conflict', 'empty', 'rejected', 'needs_review']);
  assert.deepEqual(result.groups[0].source_row_numbers, [2, 3, 4]);
  assert.equal(result.rows[5].values.close_date, null);
  assert.deepEqual(result.rows[4].raw_cells, ['bad', 'shape']);
});

test('identical content is a duplicate row, not permission to reconcile a sale', () => {
  const result = prepare([base, base, base]);
  assert.deepEqual(result.rows.map(row => row.preparation_disposition), ['prepared', 'duplicate', 'duplicate']);
  assert.equal(result.rows[1].duplicate_of_source_row_number, 2);
  assert.equal(result.rows[2].duplicate_of_source_row_number, 2);
  assert.deepEqual(result.groups, [{ group_id: 'rows:2', kind: 'duplicate_content', source_row_numbers: [2, 3, 4] }]);
});

test('same address alone does not merge different transactions or parcel observations', () => {
  const first = [...base]; first[0] = ''; first[1] = '';
  const next = [...first]; next[4] = '8/25/2022';
  const third = [...first]; third[3] = 'R-999-999';
  const result = prepare([first, next, third]);
  assert.deepEqual(result.groups, []);
  assert.equal(result.summary.prepared, 3);
});

test('MLS key/id conflict bridges mark the entire group, including earlier rows', () => {
  const second = [...base]; second[0] = 'key-2'; second[1] = 'id-2';
  const bridge = [...base]; bridge[0] = 'key-2';
  const result = prepare([base, second, bridge]);
  assert.equal(result.summary.identity_conflict, 3);
  assert.deepEqual(result.groups[0].source_row_numbers, [2, 3, 4]);
  for (const row of result.rows) {
    assert.equal(row.duplicate_of_source_row_number, null);
    assert.ok(row.issues.includes('conflicting_listing_identity'));
  }
});

test('MLS namespaces are distinct; matching text between a key and id is not a shared identity', () => {
  const first = [...base]; first[0] = 'same'; first[1] = '';
  const next = [...base]; next[0] = ''; next[1] = 'same';
  assert.deepEqual(prepare([first, next]).groups, []);
});

test('MLS identity casing/space variants signal conflict without rewriting original cells', () => {
  const second = [...base]; second[0] = ' KEY-1 '; second[1] = '';
  const result = prepare([base, second]);
  assert.equal(result.summary.identity_conflict, 2);
  assert.equal(result.rows[1].raw_cells[0], ' KEY-1 ');
});

test('preserves unknown/prototype-like columns and treats spreadsheet formulas as inert text', () => {
  const names = [...headers, '__proto__', 'constructor', 'UnknownField'];
  const input = [...base, '=1+1', 'prototype text', 'unrecognized original'];
  const result = prepareAssignmentSalesCsv(csv([input], names));
  assert.deepEqual(result.columns, names);
  assert.deepEqual(result.rows[0].raw_cells, input);
  assert.equal(Object.hasOwn(result.rows[0].values, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('header casing is mapped while the original header bytes/text remain available', () => {
  const names = headers.map(name => ` ${name.toLowerCase()} `);
  const result = prepareAssignmentSalesCsv(csv([base], names));
  assert.equal(result.rows[0].values.current_price, '282500');
  assert.deepEqual(result.raw_headers, names);
  assert.deepEqual(result.columns, names.map(name => name.trim()));
});

test('unrelated CSV headers cannot be treated as sales observations', () => {
  for (const names of [['Address', 'CurrentPrice'], ['CloseDate', 'CurrentPrice'], ['Address', 'CloseDate']]) {
    assert.throws(() => prepareAssignmentSalesCsv(csv([], names)),
      { code: 'assignment_sales_csv_unsupported_columns' });
  }
});

test('ClosePrice is separate from CurrentPrice and does not require a current-price column', () => {
  const result = prepareAssignmentSalesCsv(csv([['101 Test Ln', '2020-01-02', '125000']],
    ['Address', 'CloseDate', 'ClosePrice']));
  assert.equal(result.rows[0].values.close_price, '125000');
  assert.equal(result.rows[0].values.current_price, null);
  assert.equal(result.rows[0].values.record_type, 'unknown');
  assert.equal(result.rows[0].analysis_status, 'not_evaluated');
});

test('header-only file has a zero-row preparation, not a successful database import', () => {
  const result = prepare([]);
  assert.equal(result.row_count, 0);
  assert.equal(result.persisted, false);
  assert.deepEqual(result.groups, []);
});

test('missing row identity remains reviewable and is not silently discarded', () => {
  const row = [...base]; row.fill('', 0, 4);
  const result = prepare([row]);
  assert.equal(result.rows[0].preparation_disposition, 'needs_review');
  assert.ok(result.rows[0].issues.includes('missing_property_identity'));
});

test('byte spans identify exact logical records, including quoted multiline and UTF-8 content', () => {
  const row = [...base]; row[2] = '101 Peña Ln\r\nSuite 2';
  const bytes = csv([row, base]);
  const result = prepareAssignmentSalesCsv(bytes);
  assert.equal(result.rows[0].source_line_number, 2);
  assert.equal(result.rows[1].source_line_number, 4);
  for (let index = 0; index < result.rows.length; index += 1) {
    const observed = result.rows[index];
    assert.equal(bytes.subarray(observed.byte_start, observed.byte_end).toString(),
      [row, base][index].map(quote).join(','));
  }
});

test('large identity groups have linear group references, not quadratic conflict lists', () => {
  const result = prepare(Array.from({ length: 2000 }, (_, index) => {
    const row = [...base]; row[5] = String(100000 + index); return row;
  }));
  assert.equal(result.summary.identity_conflict, 2000);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].source_row_numbers.length, 2000);
  assert.ok(result.rows.every(row => row.group_id === 'rows:2' && !Object.hasOwn(row, 'conflict_rows')));
});
