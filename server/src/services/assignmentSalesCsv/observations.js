import { types } from 'node:util';

const INTEGERS = Object.freeze({ BedroomsTotal: 'bedrooms_total', BathroomsTotalInteger: 'bathrooms_total_integer',
  BathroomsFull: 'bathrooms_full', BathroomsHalf: 'bathrooms_half', DaysOnMarket: 'days_on_market', YearBuilt: 'year_built' });
const DECIMALS = Object.freeze({ LivingArea: 'living_area', LotSizeArea: 'lot_size_area', CurrentPrice: 'current_price', ClosePrice: 'close_price',
  RATIO_CurrentPrice_By_LivingArea: 'ratio_current_price_by_living_area', RATIO_ClosePrice_By_ListPrice: 'ratio_close_price_by_list_price',
  RATIO_ClosePrice_By_OriginalListPrice: 'ratio_close_price_by_original_list_price', RATIO_ClosePrice_By_LivingArea: 'ratio_close_price_by_living_area',
  SellerContributions: 'seller_contributions', GarageSpaces: 'garage_spaces' });
const DATES = Object.freeze({ CloseDate: 'close_date', ListingContractDate: 'listing_contract_date' });
const BOOLEANS = Object.freeze({ GarageYN: 'garage_yn', PoolYN: 'pool_yn' });
const TEXT = Object.freeze({ MlsStatus: 'mls_status', ParcelNumber: 'parcel_number_raw', ParcelNumber2: 'parcel_number2_raw',
  BuyerFinancing: 'buyer_financing', StructuralStyle: 'structural_style', ArchitecturalStyle: 'architectural_style',
  ListingKey: 'listing_key', ListingId: 'listing_id', Address: 'address', UnparsedAddress: 'unparsed_address',
  PropertyAddress: 'property_address', StreetAddress: 'street_address', City: 'city', State: 'state',
  StateOrProvince: 'state_or_province', PostalCode: 'postal_code', Zip: 'zip', County: 'county', CountyOrParish: 'county_or_parish',
  LivingAreaUnits: 'living_area_units', LotSizeUnits: 'lot_size_units', Currency: 'currency', PriceCurrency: 'price_currency',
  CurrentPriceCurrency: 'current_price_currency', ClosePriceCurrency: 'close_price_currency' });
export const ASSIGNMENT_SALES_OBSERVATION_HEADERS = Object.freeze([INTEGERS, DECIMALS, DATES, BOOLEANS, TEXT].flatMap(Object.keys));
const LISTING_STATUSES = new Set(['active', 'active option contract', 'active contingent', 'active kick out', 'active under contract',
  'pending', 'coming soon', 'hold', 'withdrawn', 'expired', 'canceled', 'cancelled', 'temp off market', 'temporarily off market', 'incomplete']);

function admittedPayload(raw) {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new TypeError('assignment_sales_observations_invalid_input');
  const keys = Reflect.ownKeys(raw), copy = Object.create(null);
  if (keys.length > 128) throw new TypeError('assignment_sales_observations_invalid_input');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !key.isWellFormed() || Buffer.byteLength(key) > 16_384 || !d?.enumerable
      || !Object.hasOwn(d, 'value') || typeof d.value !== 'string' || !d.value.isWellFormed()
      || Buffer.byteLength(d.value) > 16_384) throw new TypeError('assignment_sales_observations_invalid_input');
    copy[key] = d.value.trim();
  }
  return copy;
}

// Deliberately narrower than Python Decimal: no exponent, NaN/infinity,
// parentheses, misplaced currency markers or malformed thousands grouping.
// Bound ORIGINAL digits (<=30 total, <=12 fractional) before canonicalization;
// never pass decimal measurements through Number or infer a currency from '$'.
function decimal(value) {
  if (value.length > 96) return null;
  let body = value, sign = '';
  if (/^[+-]/.test(body)) { sign = body[0]; body = body.slice(1); }
  if (body.startsWith('$')) {
    body = body.slice(1);
    if (!sign && /^[+-]/.test(body)) { sign = body[0]; body = body.slice(1); }
  }
  const match = /^(?:(\d+(?:,\d+)*)(?:\.(\d*))?|\.(\d+))$/.exec(body);
  if (!match) return null;
  const whole = match[1] ?? '0', fraction = match[2] ?? match[3] ?? '';
  if (whole.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(whole)) return null;
  const digits = whole.replaceAll(',', '');
  if (digits.length + fraction.length > 30 || fraction.length > 12) return null;
  const integer = digits.replace(/^0+(?=\d)/, ''), tail = fraction.replace(/0+$/, '');
  const unsigned = `${integer}${tail ? `.${tail}` : ''}`;
  return sign === '-' && unsigned !== '0' ? `-${unsigned}` : unsigned;
}
function integer(value) {
  if (value.length > 16 || !/^[+-]?\d+$/.test(value)) return null;
  const result = BigInt(value);
  return result >= -2147483648n && result <= 2147483647n ? Number(result) : null;
}
function date(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value), csv = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !csv) return null;
  const [year, month, day] = iso ? iso.slice(1).map(Number) : [Number(csv[3]), Number(csv[1]), Number(csv[2])];
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function boolean(value) {
  const upper = value.toUpperCase();
  return ['TRUE', 'T', 'YES', 'Y', '1'].includes(upper) ? true
    : ['FALSE', 'F', 'NO', 'N', '0'].includes(upper) ? false : null;
}
function housing(value) {
  if (!value) return [null, 'unknown'];
  const normalized = value.toLowerCase(), detached = normalized.includes('single detached');
  const attached = ['attached', 'duplex', 'condo/townhome', 'apartment'].some(marker => normalized.includes(marker));
  if (attached && detached) return ['Mixed/Review', 'mixed'];
  if (attached) return [normalized.includes('condo/townhome') ? 'Condo/Townhome'
    : normalized.includes('duplex') || normalized.includes('attached') ? 'Attached/Duplex' : 'Attached', 'attached'];
  if (detached) return ['Single Family', 'detached'];
  if (normalized.includes('garden/zero lot line')) return ['Garden/Zero Lot Line', 'unknown'];
  if (normalized.includes('farm/ranch house')) return ['Farm/Ranch House', 'unknown'];
  return [value, 'unknown'];
}

/** Observation normalization only. The caller retains untouched raw cells and
 * source bytes; this neither matches accounts nor qualifies sales/historical stock.
 * Ordinary Python import fields/styles are reused, but its permissive numbers,
 * unrecognized-status=>listing rule and currency-assuming price thresholds are not. */
export function normalizeAssignmentSalesObservations(rawPayload) {
  const raw = admittedPayload(rawPayload), values = {}, issues = [];
  const read = (header) => Object.hasOwn(raw, header) ? raw[header] : '';
  for (const [mapping, convert] of [[INTEGERS, integer], [DECIMALS, decimal], [DATES, date], [BOOLEANS, boolean]]) {
    for (const [header, field] of Object.entries(mapping)) {
      const value = read(header); values[field] = value ? convert(value) : null;
      if (value && values[field] === null) issues.push(`invalid_${field}`);
    }
  }
  for (const [header, field] of Object.entries(TEXT)) values[field] = read(header) || null;
  const status = values.mls_status?.toLowerCase();
  values.record_type = status === 'closed' ? 'closed_sale' : LISTING_STATUSES.has(status) ? 'listing' : 'unknown';
  if (values.record_type === 'unknown') issues.push(status ? 'unrecognized_mls_status' : 'missing_mls_status');
  [values.housing_type, values.attachment_type] = housing(values.structural_style);
  for (const field of ['current_price', 'close_price', 'living_area', 'lot_size_area']) {
    if (values[field] !== null && (values[field] === '0' || values[field].startsWith('-'))) issues.push(`non_positive_${field}`);
  }
  if (values.current_price === null && values.close_price === null) issues.push('missing_reported_price');
  for (const field of ['bedrooms_total', 'bathrooms_total_integer', 'bathrooms_full', 'bathrooms_half', 'days_on_market']) {
    if (values[field] !== null && values[field] < 0) issues.push(`negative_${field}`);
  }
  if (values.year_built !== null && (values.year_built < 1 || values.year_built > 9999)) {
    values.year_built = null; issues.push('invalid_year_built');
  }
  if (values.record_type === 'closed_sale') {
    if (values.close_date === null) issues.push('missing_close_date');
    if (values.seller_contributions === null) issues.push('missing_seller_contributions');
    if (values.buyer_financing === null) issues.push('missing_buyer_financing');
  }
  if (values.close_date && values.listing_contract_date && values.listing_contract_date > values.close_date) issues.push('listing_contract_date_after_close_date');
  if (values.attachment_type === 'mixed') issues.push('conflicting_attachment_classification');
  else if (values.attachment_type === 'attached') issues.push('attached_housing_type');
  if (values.housing_type === null) issues.push('missing_housing_type');
  return Object.freeze({ values: Object.freeze(values), issues: Object.freeze([...new Set(issues)]) });
}
