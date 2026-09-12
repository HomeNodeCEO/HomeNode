import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTrestleSourceRecord, persistTrestlePropertyBatch } from '../src/services/trestleReplication.js';

const record = () => ({
  ListingKey: 'SYNTHETIC-SOURCE-EVIDENCE', ListingId: 'SYNTHETIC-1',
  OriginatingSystemName: 'Synthetic provider', ModificationTimestamp: '2026-09-12T12:00:00Z',
  StandardStatus: 'Closed', CloseDate: '2026-09-01',
  CurrentPrice: '350000', ClosePrice: '282500.0100', ListPrice: '330000',
  Currency: ' USD ', PriceCurrency: '', CurrentPriceCurrency: ' CAD ', ClosePriceCurrency: ' EUR ',
  LivingArea: '1800.00', LivingAreaUnits: ' Square Feet ', LotSizeArea: '0.2', LotSizeUnits: ' Acres ',
  LotSizeSquareFeet: '8712', DaysOnMarket: 0, PoolPrivateYN: false,
});

test('supplied Trestle fields retain exact parsed values separately from existing typed calculations', () => {
  const input = Object.freeze(record()), original = structuredClone(input);
  const mapped = mapTrestleSourceRecord(input);
  assert.deepEqual(mapped.raw_payload, original);
  assert.deepEqual(input, original);
  assert.equal(mapped.current_price, 282500.01);
  assert.equal(mapped.living_area, 1800);
  assert.equal(mapped.lot_size_area, 8712);
  assert.equal(mapped.raw_payload.CurrentPrice, '350000');
  assert.equal(mapped.raw_payload.ClosePrice, '282500.0100');
  for (const key of ['close_price', 'currency', 'living_area_units', 'lot_size_units']) assert.ok(!Object.hasOwn(mapped, key));
});

test('missing fields stay absent while null, blanks, zero, and false remain distinct source values', () => {
  const input = { ListingKey: 'SYNTHETIC-MISSING', StandardStatus: 'Closed', ListPrice: '330000',
    Currency: null, PriceCurrency: '', LivingAreaUnits: ' \t ', DaysOnMarket: 0, PoolPrivateYN: false };
  const mapped = mapTrestleSourceRecord(input);
  assert.deepEqual(mapped.raw_payload, input);
  for (const key of ['ClosePrice', 'CurrentPrice', 'LotSizeUnits', 'LivingArea']) assert.ok(!Object.hasOwn(mapped.raw_payload, key));
  assert.equal(mapped.current_price, 330000, 'preserve existing typed fallback without manufacturing raw ClosePrice');
  assert.equal(mapped.raw_payload.Currency, null);
  assert.equal(mapped.raw_payload.PriceCurrency, '');
  assert.equal(mapped.raw_payload.DaysOnMarket, 0);
  assert.equal(mapped.raw_payload.PoolPrivateYN, false);
});

test('units on a blank raw field do not relabel a different typed fallback field', () => {
  const input = { ...record(), LivingArea: '', LivingAreaUnits: 'Square Meters', AboveGradeFinishedArea: '2500',
    AboveGradeFinishedAreaUnits: 'Square Feet', LotSizeArea: '2', LotSizeUnits: 'Acres', LotSizeSquareFeet: '9000' };
  const mapped = mapTrestleSourceRecord(input);
  assert.equal(mapped.living_area, 2500);
  assert.equal(mapped.lot_size_area, 9000);
  assert.equal(mapped.raw_payload.LivingArea, '');
  assert.equal(mapped.raw_payload.LivingAreaUnits, 'Square Meters');
  assert.equal(mapped.raw_payload.AboveGradeFinishedAreaUnits, 'Square Feet');
  assert.ok(!Object.hasOwn(mapped, 'living_area_units'));
  assert.ok(!Object.hasOwn(mapped, 'lot_size_units'));
});

test('existing Trestle persistence carries the unchanged raw record and provider binding in its JSON parameter', async () => {
  const input = record(), calls = [];
  const client = { async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [] }; }, release() {} };
  const pool = { async query() { return { rows: [] }; }, async connect() { return client; } };
  await persistTrestlePropertyBatch(pool, [input]);
  const write = calls.find(call => call.sql.includes('INSERT INTO core.sales_source_records'));
  assert.ok(write);
  const [stored] = JSON.parse(write.parameters[0]);
  assert.deepEqual(stored.raw_payload, input);
  assert.equal(stored.listing_key, input.ListingKey);
  assert.equal(stored.originating_system_name, input.OriginatingSystemName);
  assert.equal(stored.source_modified_at, '2026-09-12T12:00:00.000Z');
  assert.equal(stored.current_price, 282500.01);
  assert.match(write.sql, /raw_payload = EXCLUDED\.raw_payload/);
  assert.match(write.sql, /living_area = COALESCE\(EXCLUDED\.living_area, core\.sales_source_records\.living_area\)/);
  assert.deepEqual(calls.filter(call => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)).map(call => call.sql), ['BEGIN', 'COMMIT']);
});
