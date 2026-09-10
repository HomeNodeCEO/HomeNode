import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAssignmentSalesObservations as normalize, ASSIGNMENT_SALES_OBSERVATION_HEADERS as HEADERS }
  from '../src/services/assignmentSalesCsv/observations.js';

// Ordinary fixture values/classification expectations copied from
// dcad-scraper-with-api/tests/test_import_sales.py:source_row and
// StructuralStyleTests/RecordTypeTests. This is NOT universal Python parity:
// permissive Decimal/ints, unknown statuses and implied price meaning differ.
function sourceRow(overrides = {}) {
  return { BedroomsTotal: '3', BathroomsTotalInteger: '2', BathroomsFull: '2', BathroomsHalf: '0', LivingArea: '1800',
    LotSizeArea: '0.2', CurrentPrice: '350000', DaysOnMarket: '12', YearBuilt: '1985', MlsStatus: 'Closed',
    CloseDate: '07/01/2026', SellerContributions: '0', GarageSpaces: '2', GarageYN: 'TRUE', PoolYN: 'FALSE',
    ListingContractDate: '06/01/2026', ParcelNumber: '26272500060150000', BuyerFinancing: 'Conventional',
    StructuralStyle: 'Single Detached', ArchitecturalStyle: 'Traditional', ...overrides };
}

test('ordinary Python fixture field vocabulary/classifications are retained with exact decimal strings', () => {
  const { values: v, issues } = normalize(sourceRow());
  assert.deepEqual([v.bedrooms_total, v.bathrooms_total_integer, v.bathrooms_full, v.bathrooms_half, v.days_on_market, v.year_built], [3, 2, 2, 0, 12, 1985]);
  assert.deepEqual([v.living_area, v.lot_size_area, v.current_price, v.garage_spaces, v.seller_contributions], ['1800', '0.2', '350000', '2', '0']);
  assert.deepEqual([v.close_date, v.listing_contract_date], ['2026-07-01', '2026-06-01']);
  assert.deepEqual([v.garage_yn, v.pool_yn], [true, false]);
  assert.deepEqual([v.record_type, v.housing_type, v.attachment_type], ['closed_sale', 'Single Family', 'detached']);
  assert.equal(v.parcel_number_raw, '26272500060150000'); assert.deepEqual(issues, []);
});

test('all columns are optional; absent status is unknown and never defaults to a sale or listing', () => {
  const { values, issues } = normalize({});
  assert.equal(values.record_type, 'unknown'); assert.equal(values.attachment_type, 'unknown');
  for (const [field, value] of Object.entries(values)) if (!['record_type', 'attachment_type'].includes(field)) assert.equal(value, null, field);
  assert.deepEqual(issues, ['missing_mls_status', 'missing_reported_price', 'missing_housing_type']);
});

test('exact supported header export is frozen, unique and suitable for caller-owned casing admission', () => {
  assert.ok(Object.isFrozen(HEADERS)); assert.equal(new Set(HEADERS.map(s => s.toLowerCase())).size, HEADERS.length);
  for (const key of ['CurrentPrice', 'ClosePrice', 'CloseDate', 'ParcelNumber', 'ListingKey', 'ListingId', 'StateOrProvince',
    'UnparsedAddress', 'CountyOrParish', 'LivingAreaUnits', 'LotSizeUnits', 'Currency']) assert.ok(HEADERS.includes(key));
  assert.equal(normalize({ currentprice: '350000' }).values.current_price, null, 'root owns case mapping; unknown names are not guessed');
});

for (const [raw, expected] of [['9007199254740993.123456789012', '9007199254740993.123456789012'],
  ['123456789012345678.123456789012', '123456789012345678.123456789012'],
  ['123456789012345678901234567890', '123456789012345678901234567890'], ['$350,000.00', '350000'],
  [' +001800.125000 ', '1800.125'], ['.125', '0.125'], ['1.', '1'], ['-$1,200.50', '-1200.5'], ['$-1200.50', '-1200.5'],
  ['-0.000000000000', '0']]) test(`decimal conversion preserves exact bounded value: ${raw}`, () => {
    const { values, issues } = normalize(sourceRow({ CurrentPrice: raw }));
    assert.equal(values.current_price, expected); assert.equal(typeof values.current_price, 'string');
    assert.ok(!issues.includes('invalid_current_price')); assert.equal(values.currency, null);
  });

test('all decimal measurements and ratios use exact strings rather than floating arithmetic', () => {
  const raw = { LivingArea: '1800.123456789012', LotSizeArea: '.123456789012', CurrentPrice: '9007199254740993',
    ClosePrice: '9007199254740994', SellerContributions: '100.000000000001', GarageSpaces: '2.5',
    RATIO_CurrentPrice_By_LivingArea: '123.456789012345', RATIO_ClosePrice_By_ListPrice: '.987654321012',
    RATIO_ClosePrice_By_OriginalListPrice: '1.000000000001', RATIO_ClosePrice_By_LivingArea: '123.456789012346' };
  const { values: v } = normalize(sourceRow(raw));
  assert.equal(v.living_area, raw.LivingArea); assert.equal(v.lot_size_area, '0.123456789012');
  assert.equal(v.close_price, raw.ClosePrice); assert.equal(v.current_price, raw.CurrentPrice);
  assert.equal(v.seller_contributions, raw.SellerContributions); assert.equal(v.garage_spaces, '2.5');
  assert.equal(v.ratio_current_price_by_living_area, raw.RATIO_CurrentPrice_By_LivingArea);
  assert.equal(v.ratio_close_price_by_list_price, '0.987654321012');
  assert.equal(v.ratio_close_price_by_original_list_price, '1.000000000001');
  assert.equal(v.ratio_close_price_by_living_area, raw.RATIO_ClosePrice_By_LivingArea);
});

test('nonfinite/exponent/ambiguous and oversized decimal forms become null with fixed field issues', () => {
  for (const raw of ['NaN', 'Infinity', '-Infinity', '1e3', '1E-5', '0x10', '1_000', '12,34', '1,23,456', '1.234,56',
    '(100)', '10$', '$$10', 'USD 100', '--1', '+-1', '1 000', '0.1234567890123', '1'.repeat(31), '0'.repeat(97)]) {
    const input = sourceRow({ CurrentPrice: raw }), before = JSON.stringify(input), result = normalize(input);
    assert.equal(result.values.current_price, null, raw); assert.ok(result.issues.includes('invalid_current_price'), raw);
    assert.equal(JSON.stringify(input), before); assert.ok(result.issues.every(issue => /^[a-z_]+$/.test(issue)));
  }
});

test('blank values are missing, not malformed or fabricated zero', () => {
  const r = normalize(sourceRow({ CurrentPrice: ' \t ', ClosePrice: '', LivingArea: ' ', BedroomsTotal: '', GarageYN: ' ' }));
  for (const field of ['current_price', 'close_price', 'living_area', 'bedrooms_total', 'garage_yn']) {
    assert.equal(r.values[field], null); assert.ok(!r.issues.includes(`invalid_${field}`));
  }
});

test('CurrentPrice never becomes ClosePrice and a close-only record does not require invented current price', () => {
  assert.equal(normalize(sourceRow()).values.close_price, null);
  const result = normalize(sourceRow({ CurrentPrice: '', ClosePrice: '$282,500.00' }));
  assert.equal(result.values.current_price, null); assert.equal(result.values.close_price, '282500');
  assert.ok(!result.issues.includes('missing_reported_price'));
});

test('safe PostgreSQL integer bounds, zero, negative observations and future years are explicit', () => {
  for (const [raw, expected] of [['0', 0], ['+03', 3], ['2147483647', 2147483647], ['-2147483648', -2147483648]]) {
    assert.equal(normalize(sourceRow({ DaysOnMarket: raw })).values.days_on_market, expected);
  }
  const negative = normalize(sourceRow({ DaysOnMarket: '-1', BedroomsTotal: '-1' }));
  assert.ok(negative.issues.includes('negative_days_on_market')); assert.ok(negative.issues.includes('negative_bedrooms_total'));
  assert.equal(normalize(sourceRow({ YearBuilt: '2099' })).values.year_built, 2099, 'not compared with current clock');
  for (const raw of ['2147483648', '-2147483649', '9007199254740993', '1.0', '1e2', 'NaN', '1_000']) {
    const r = normalize(sourceRow({ DaysOnMarket: raw })); assert.equal(r.values.days_on_market, null);
    assert.ok(r.issues.includes('invalid_days_on_market'));
  }
  for (const raw of ['0', '-1', '10000']) {
    const r = normalize(sourceRow({ YearBuilt: raw })); assert.equal(r.values.year_built, null); assert.ok(r.issues.includes('invalid_year_built'));
  }
});

test('dates accept explicit US CSV or ISO dates, including real Gregorian leap boundaries', () => {
  for (const [raw, expected] of [['7/1/2026', '2026-07-01'], ['2026-07-01', '2026-07-01'], ['2/29/2000', '2000-02-29'],
    ['2024-02-29', '2024-02-29'], ['1/1/0001', '0001-01-01']]) assert.equal(normalize(sourceRow({ CloseDate: raw })).values.close_date, expected);
  for (const raw of ['2/29/1900', '2026-02-29', '2026-04-31', '13/01/2026', '07/00/2026', '2026-7-1', '07-01-2026',
    '07/01/26', '0000-01-01', '2026-07-01T00:00:00Z']) {
    const r = normalize(sourceRow({ CloseDate: raw })); assert.equal(r.values.close_date, null, raw); assert.ok(r.issues.includes('invalid_close_date'));
  }
  assert.ok(normalize(sourceRow({ ListingContractDate: '2026-07-02' })).issues.includes('listing_contract_date_after_close_date'));
});

test('boolean forms match ordinary Python acceptance; false/zero never becomes missing', () => {
  for (const raw of ['TRUE', 'T', 'yes', 'Y', '1', ' true ']) assert.equal(normalize({ GarageYN: raw }).values.garage_yn, true);
  for (const raw of ['FALSE', 'F', 'no', 'N', '0', ' false ']) assert.equal(normalize({ PoolYN: raw }).values.pool_yn, false);
  for (const raw of ['maybe', '2', 'null']) {
    const r = normalize({ GarageYN: raw }); assert.equal(r.values.garage_yn, null); assert.ok(r.issues.includes('invalid_garage_yn'));
  }
});

test('only explicit Closed is a sale; known listing statuses remain listings and unknowns remain unknown', () => {
  for (const raw of ['Closed', ' CLOSED ', 'closed']) assert.equal(normalize({ MlsStatus: raw }).values.record_type, 'closed_sale');
  for (const raw of ['Active', 'Pending', 'Active Option Contract', 'Coming Soon', 'Withdrawn', 'Expired', 'Cancelled']) {
    const r = normalize({ MlsStatus: raw }); assert.equal(r.values.record_type, 'listing');
    for (const issue of ['missing_close_date', 'missing_seller_contributions', 'missing_buyer_financing']) assert.ok(!r.issues.includes(issue));
  }
  for (const raw of ['Sold', 'future provider status', 'Closed?', '0']) {
    const r = normalize({ MlsStatus: raw, CloseDate: '07/01/2026', CurrentPrice: '350000' });
    assert.equal(r.values.record_type, 'unknown'); assert.equal(r.values.mls_status, raw); assert.ok(r.issues.includes('unrecognized_mls_status'));
  }
});

test('ordinary Python structural-style classifications retain unknown and conflicting attachment distinctions', () => {
  for (const [raw, expected] of [['Single Detached', ['Single Family', 'detached']], ['Attached or 1/2 Duplex', ['Attached/Duplex', 'attached']],
    ['Attached or 1/2 Duplex, Single Detached', ['Mixed/Review', 'mixed']], ['Condo/Townhome', ['Condo/Townhome', 'attached']],
    ['Apartment', ['Attached', 'attached']], ['Garden/Zero Lot Line', ['Garden/Zero Lot Line', 'unknown']],
    ['Farm/Ranch House', ['Farm/Ranch House', 'unknown']], ['Provider custom style', ['Provider custom style', 'unknown']], ['', [null, 'unknown']]]) {
    const r = normalize({ StructuralStyle: raw }); assert.deepEqual([r.values.housing_type, r.values.attachment_type], expected);
  }
  assert.ok(normalize({ StructuralStyle: 'Single Detached; Attached' }).issues.includes('conflicting_attachment_classification'));
  assert.ok(normalize({ StructuralStyle: 'Apartment' }).issues.includes('attached_housing_type'));
});

test('identifiers, address variants and reported units/currency are trim-only; no matching or conversions', () => {
  const r = normalize({ ParcelNumber: ' R-13743-00L-0900-1 ', ParcelNumber2: ' 000-abc ', ListingKey: ' NtReIs-Key-123 ', ListingId: ' 0021298422 ',
    Address: ' 1808 Sheffield Ct ', UnparsedAddress: ' Address A ', PropertyAddress: ' Address B ', StreetAddress: ' Address C ',
    City: ' Frisco ', State: ' tx ', StateOrProvince: ' Texas ', County: ' Collin County ', CountyOrParish: ' Collin ',
    PostalCode: ' 07504-0031 ', Zip: ' 07504 ', LivingArea: '1800', LotSizeArea: '0.2', LivingAreaUnits: ' SqFt ',
    LotSizeUnits: ' Acres ', Currency: ' USD ', PriceCurrency: ' usd ', CurrentPriceCurrency: ' CAD ', ClosePriceCurrency: ' EUR ' }).values;
  assert.equal(r.parcel_number_raw, 'R-13743-00L-0900-1'); assert.equal(r.parcel_number2_raw, '000-abc');
  assert.equal(r.listing_key, 'NtReIs-Key-123'); assert.equal(r.listing_id, '0021298422');
  assert.deepEqual([r.address, r.unparsed_address, r.property_address, r.street_address], ['1808 Sheffield Ct', 'Address A', 'Address B', 'Address C']);
  assert.deepEqual([r.city, r.state, r.state_or_province, r.county, r.county_or_parish, r.postal_code, r.zip],
    ['Frisco', 'tx', 'Texas', 'Collin County', 'Collin', '07504-0031', '07504']);
  assert.deepEqual([r.living_area_units, r.lot_size_units, r.currency, r.price_currency, r.current_price_currency, r.close_price_currency],
    ['SqFt', 'Acres', 'USD', 'usd', 'CAD', 'EUR']);
  assert.equal(r.lot_size_area, '0.2'); assert.equal(Object.hasOwn(r, 'account_id'), false);
  const ordinary = normalize(sourceRow()).values;
  assert.equal(ordinary.living_area_units, null); assert.equal(ordinary.lot_size_units, null); assert.equal(ordinary.currency, null);
});

test('unknown headers cannot inject fields, issue text or prototype state; raw payload is untouched', () => {
  const raw = Object.fromEntries([['__proto__', 'private'], ['constructor', 'private'], ['AccountId', 'fake'], ['record_type', 'closed_sale'],
    ['unknown', '=HYPERLINK("private")'], ['Address', ' <script>source text</script> ']]), before = JSON.stringify(raw);
  const result = normalize(raw); assert.equal(JSON.stringify(raw), before);
  assert.equal(result.values.record_type, 'unknown'); assert.equal(result.values.address, '<script>source text</script>');
  assert.equal(Object.hasOwn(result.values, 'account_id'), false); assert.equal(Object.hasOwn(result.values, '__proto__'), false);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.values)); assert.ok(Object.isFrozen(result.issues));
  assert.throws(() => { result.values.current_price = '1'; }, TypeError);
});

test('getters, proxies, unsupported object shapes and nonstring cells reject without evaluating values', () => {
  let touched = 0;
  const getter = Object.defineProperty({}, 'CurrentPrice', { enumerable: true, get() { touched++; return '350000'; } });
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; return Object.prototype; }, ownKeys() { touched++; return []; } });
  for (const raw of [getter, proxy, [], null, new Date(), { CurrentPrice: 1 }, { GarageYN: false }, { CurrentPrice: null },
    Object.defineProperty({}, 'CurrentPrice', { value: '1' }), { [Symbol('field')]: '1' }]) {
    assert.throws(() => normalize(raw), /assignment_sales_observations_invalid_input/);
  }
  assert.equal(touched, 0); assert.equal(normalize(Object.create(null)).values.record_type, 'unknown');
});

test('parser-aligned header/cell bounds and valid Unicode are enforced before normalization', () => {
  assert.equal(normalize({ Address: 'é'.repeat(8192) }).values.address.length, 8192);
  for (const raw of [{ Address: 'é'.repeat(8193) }, { Address: '\ud800' }, { ['x'.repeat(16_385)]: '' },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`H${i}`, '']))]) assert.throws(() => normalize(raw), /invalid_input/);
});
