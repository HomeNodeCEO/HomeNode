import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNeighborhoodFrozenTypedOriginalV2 } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { projectNeighborhoodTransactionPackageV1, prepareNeighborhoodTransactionPackagePageV1,
  getNeighborhoodTransactionPackageV1Profile, NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL,
  NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_LIMITS } from '../src/services/neighborhoodAssessment/neighborhoodSharedTransactionPackagesV1.js';

const SOURCE = '9007199254740993', EFFECTIVE = '2026-10-07', PERIOD = { start_date: '2025-01-01', end_date: EFFECTIVE };
const GRAPH = { parcels: 2, accounts: 1, source_records: 2000000, sales: 2000000, sale_links: 2000000, sync_state: 0, sync_runs: 0 };
const PAGE = { kind: 'source_record', cursor: '' };
/** Compile fresh synthetic literals through the actual fixed V2 syntax compiler. */
function row(kind, id, changes = {}, stock = true) {
  const fields = Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(k => [k, { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }]));
  const payload = { id, ...(kind === 'source_records' ? { primary_account_id: 'A', year_built: 2050,
    close_date: '2010-01-01', current_price: '9007199254740993.01',
    source_raw_witness: { witness_version: 2, root_state: 'object', root_json_type: 'object', fields } }
    : { account_id: 'A', source_record_id: SOURCE, ...(kind === 'sales' ? { closing_date: EFFECTIVE, sale_price: '9007199254740993.01' }
      : { source_position: 1, parcel_sequence: Number(id), is_resolved: true }) }), ...changes };
  const typed = compileNeighborhoodFrozenTypedOriginalV2({ kind, row_key: id, payload_text: JSON.stringify(payload) });
  return { stock_member: typed.account_id === null ? null : stock, row: { kind, row_key: id, account_id: typed.account_id,
    source_record_id: typed.source_record_id, original_payload_sha256: typed.original.payload_sha256, typed } };
}
/** Synthetic count envelopes are DATA only, not issued/current-authorized owner evidence. */
function packet(rows, id = SOURCE) {
  rows.sort((a, b) => Buffer.compare(Buffer.from(`${a.row.kind}:${a.row.row_key}`), Buffer.from(`${b.row.kind}:${b.row.row_key}`)));
  return { package_key: id, counts: Object.fromEntries(['source_records', 'sales', 'sale_links'].map(k => [k, String(rows.filter(e => e.row.kind === k).length)])),
    row_count: rows.length, packet_oversize: false, packet_json: JSON.stringify(rows) };
}
/** Reconcile one synthetic complete packet with the retained period and fixed graph maxima. */
const project = (raw, page = PAGE) => projectNeighborhoodTransactionPackageV1(raw, page, GRAPH, EFFECTIVE, PERIOD);
/** Return a complete source/sale/link packet including outside and unknown account evidence. */
function complete() { return packet([row('source_records', SOURCE), row('sales', '10'),
  row('sale_links', '1', { account_id: 'OUTSIDE' }, false), row('sale_links', '2', { account_id: null, is_resolved: false })]); }

test('whole native package retains every all-date/outside/unresolved row without currency, date or price allocation fallback', () => {
  const p = project(complete());
  assert.equal(p.next_cursor, SOURCE); assert.equal(p.end_of_kind, false);
  assert.deepEqual(p.package.counts, { source_records: '1', sales: '1', sale_links: '2' });
  assert.deepEqual(p.package.associations, { native_sale_state: 'unique_native_id', reported_resolved_link_count: 1, unresolved_link_count: 1,
    stock_account_count: 1, outside_account_count: 1, missing_account_row_count: 1, native_row_coverage: 'complete_for_this_package_only',
    provider_parcel_membership: 'not_established', economic_transaction_equivalence: 'not_established', price_allocation: 'not_established' });
  const source = p.package.rows.find(e => e.projection.kind === 'source_records').projection;
  assert.equal(source.normalized.observations.normalized_year_built.state, 'invalid');
  assert.equal(source.normalized.period_disposition.state, 'outside_period');
  assert.equal(source.normalized.observations.normalized_current_price.exact_value, '9007199254740993.01');
  assert.equal(source.normalized.observations.normalized_current_price.unit, null);
  assert.equal(p.package.rows.find(e => e.projection.kind === 'sales').projection.normalized.period_disposition.state, 'in_period');
  for (const e of p.package.rows) assert.equal(e.projection.transaction_eligibility, 'not_established');
  assert.equal(p.package.transaction_eligibility, 'not_established'); assert.equal(p.package.report_update, 'none');
  assert.ok(Object.isFrozen(source.normalized.observations));
});

test('multiple native sale IDs stay explicitly unresolved, source-only packages remain visible and legacy sales fabricate no source', () => {
  const multiple = project(packet([row('source_records', SOURCE), row('sales', '10'), row('sales', '2')]));
  assert.equal(multiple.package.associations.native_sale_state, 'multiple_native_ids_unresolved');
  assert.deepEqual(multiple.package.rows.filter(e => e.projection.kind === 'sales').map(e => e.projection.row_key), ['10', '2']);
  assert.equal(project(packet([row('source_records', SOURCE)])).package.associations.native_sale_state, 'absent');
  const legacy = project(packet([row('sales', '3', { source_record_id: null, closing_date: '2010-01-01' })], '3'), { kind: 'legacy_sale', cursor: '' });
  assert.equal(legacy.package.rows[0].projection.source_record_id, null);
  assert.equal(legacy.package.rows[0].projection.same_payload_reported_sale, null);
  assert.equal(legacy.package.rows[0].projection.normalized.period_disposition.state, 'outside_period');
});

test('complete cap and one-over refuse whole packages instead of treating a prefix as completion', () => {
  const rows = [row('source_records', SOURCE), ...Array.from({ length: 249 }, (_, i) => row('sale_links', String(i + 1)))];
  assert.equal(project(packet(rows)).package.rows.length, 250);
  assert.throws(() => project(packet([...rows, row('sale_links', '250')])), /package_row_limit/);
  const prefix = complete(); prefix.row_count--; prefix.packet_json = JSON.stringify(JSON.parse(prefix.packet_json).slice(0, -1));
  assert.throws(() => project(prefix), /invalid_result/);
  const omit = complete(); omit.packet_json = JSON.stringify(JSON.parse(omit.packet_json).slice(0, -1));
  assert.throws(() => project(omit), /invalid_result/);
  assert.throws(() => project({ ...complete(), packet_oversize: true, packet_json: '[]' }), /package_byte_limit/);
  assert.throws(() => project({ ...complete(), packet_json: ' '.repeat(2100001) }), /package_byte_limit/);
});

test('missing sources, foreign associations, duplicate positions, forged cells and unanchored packages fail closed', () => {
  assert.throws(() => project(packet([row('sales', '10')])), /incomplete_native_package/);
  assert.throws(() => project(packet([row('source_records', SOURCE), row('sales', '10', { source_record_id: '99' })])), /foreign_native_association/);
  assert.throws(() => project(packet([row('source_records', SOURCE), row('sale_links', '1'), row('sale_links', '2', { parcel_sequence: 1 })])), /duplicate_link_position/);
  assert.throws(() => project(packet([row('source_records', SOURCE), row('sale_links', '1', { source_position: 0 })])), /invalid_link_position/);
  assert.throws(() => project(packet([row('source_records', SOURCE, {}, false)])), /unanchored/);
  assert.throws(() => project(packet([row('source_records', SOURCE), row('sales', '10', {}, false)])), /conflicting_stock_membership/);
  const bad = complete(), rows = JSON.parse(bad.packet_json); rows[0].row.typed.account_id = 'FORGED'; bad.packet_json = JSON.stringify(rows);
  assert.throws(() => project(bad), /invalid_typed_row/);
  const reversed = complete(); reversed.packet_json = JSON.stringify(JSON.parse(reversed.packet_json).reverse());
  assert.throws(() => project(reversed), /invalid_order_or_row/);
  assert.throws(() => project({ ...complete(), counts: { source_records: '01', sales: '1', sale_links: '2' } }), /invalid_counts/);
  assert.throws(() => project(complete(), { kind: 'source_record', cursor: SOURCE }), /invalid_order/);
  assert.throws(() => project(packet([row('sales', '2', { source_record_id: null })], '2'), { kind: 'legacy_sale', cursor: '3' }), /invalid_order/);
});

test('last package requires a fresh empty probe and source ordering preserves exact BIGINT keys above 2^53', () => {
  assert.equal(project(complete(), { kind: 'source_record', cursor: '9007199254740992' }).next_cursor, SOURCE);
  const empty = { package_key: null, counts: { source_records: '0', sales: '0', sale_links: '0' }, row_count: 0, packet_oversize: false, packet_json: '[]' };
  assert.deepEqual(project(empty, { kind: 'source_record', cursor: SOURCE }), { package: null, next_cursor: SOURCE, end_of_kind: true });
  assert.throws(() => project({ ...empty, packet_json: '[{}]' }), /invalid_result/);
});

test('closed package requests admit no caller facts/authority/dates and reject accessors/proxies before use', () => {
  for (const bad of [{ ...PAGE, rows: [] }, { ...PAGE, effectiveDate: EFFECTIVE }, { ...PAGE, rowLimit: 250 },
    { ...PAGE, kind: 'sales' }, { ...PAGE, cursor: '9223372036854775808' }, new Proxy(PAGE, {}),
    { kind: 'source_record', get cursor() { assert.fail('getter'); } }])
    assert.throws(() => prepareNeighborhoodTransactionPackagePageV1(bad), /invalid_/);
  assert.throws(() => project({ ...complete(), get counts() { assert.fail('getter'); } }), /invalid_input/);
  assert.throws(() => project(new Proxy(complete(), {})), /invalid_input/);
  assert.throws(() => projectNeighborhoodTransactionPackageV1(complete(), PAGE, GRAPH, EFFECTIVE,
    { start_date: PERIOD.start_date, end_date: '2027-01-01' }), /future_or_reversed_period/);
});

test('fixed package plans use installed exact source/key indexes, independent counts and all-or-nothing byte admission without original payloads', () => {
  for (const sql of Object.values(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL)) {
    assert.match(sql, /sum\(n::bigint\) FROM totals\)<=\$5::integer/);
    assert.match(sql, /jsonb_object_agg\(kind,n\)/); assert.match(sql, /count\(\*\)::text/);
    assert.match(sql, /ORDER BY kind COLLATE "C",row_key COLLATE "C"/);
    assert.doesNotMatch(sql, /FROM core\.|FROM gis\.|neighborhood_frozen_source_rows|payload::text|ST_DWithin|INSERT|UPDATE|DELETE|closing_date|sum\(.*price/i);
  }
  assert.match(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL.source_record, /ORDER BY source_record_id LIMIT 1/);
  assert.match(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL.legacy_sale, /t\.source_record_id IS NULL/);
  assert.deepEqual(getNeighborhoodTransactionPackageV1Profile().definition_blob.ref.content_sha256,
    getNeighborhoodTransactionPackageV1Profile().profile_ref.content_sha256);
  assert.equal(NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_LIMITS.rows, 250);
});
