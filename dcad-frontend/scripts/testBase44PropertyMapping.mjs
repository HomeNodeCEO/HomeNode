import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  finitePropertyNumber,
  mapMergedToBase44Property,
  propertyLoadErrorMessage,
} from '../src/features/propertyDetails/base44PropertyMapping.ts';

test('Base44 numeric parsing preserves zero and rejects malformed values', () => {
  assert.equal(finitePropertyNumber(0), 0);
  assert.equal(finitePropertyNumber('$1,250'), 1250);
  assert.equal(finitePropertyNumber(' 2.5 '), 2.5);
  assert.equal(finitePropertyNumber(null), '');
  assert.equal(finitePropertyNumber({ amount: 10 }), '');
  assert.equal(finitePropertyNumber(Number.POSITIVE_INFINITY), '');
});

test('Base44 mapping preserves established merged-response precedence', () => {
  assert.deepEqual(mapMergedToBase44Property({
    account: {
      account_id: 'account-from-api',
      address: '123 Main St',
      county: 'Dallas',
      latest_market_value: 250000,
      latest_capped_value: 220000,
      latest_improvement_value: 180000,
      latest_land_value: 70000,
      neighborhood_code: 'N-1',
      subdivision: 'Example Estates',
      legal_description: 'LOT 1',
    },
    owner_summary: { owner_name: 'Example Owner', mailing_address: 'PO Box 1' },
    owner_parties: [{ ownership_pct: 50 }],
    primary_improvements: {
      living_area_sqft: 1800,
      total_living_area: 1900,
      bedroom_count: 3,
      bath_count: '2.5',
      building_class: 'Single Family',
      year_built: 1998,
      effective_year_built: 2010,
      percent_complete: 100,
      pool: false,
    },
    neighborhood: { multiplier: '1.05' },
    land: { acreage: '0.25' },
    garage_bay_count: 2,
    solar_panels: true,
    functional_obsolescence: false,
    photos: ['https://example.com/one.jpg'],
  }, 'fallback'), {
    account_number: 'account-from-api',
    address: '123 Main St',
    photos: ['https://example.com/one.jpg'],
    market_value: 250000,
    appraised_value: 220000,
    improvement_value: 180000,
    land_value: 70000,
    neighborhood_multiplier: 1.05,
    county: 'Dallas',
    square_footage: 1800,
    total_living_area: 1900,
    land_acreage: 0.25,
    bedroom_count: 3,
    bath_count: 2.5,
    garage_bay_count: 2,
    solar_panels: true,
    functional_obsolescence: false,
    classification: 'Single Family',
    year_built: 1998,
    effective_year_built: 2010,
    last_inspection_year: '',
    neighborhood_code: 'N-1',
    subdivision: 'Example Estates',
    owner_name: 'Example Owner',
    owner_mailing_address: 'PO Box 1',
    ownership_percent: 50,
    legal_description: 'LOT 1',
    percent_complete: 100,
    stories: null,
    construction_type: null,
    foundation_type: null,
    roof_type: null,
    roof_material: null,
    fence_type: null,
    exterior_material: null,
    basement: null,
    heating_type: null,
    air_conditioning: null,
    pool: false,
    protest_history: [],
  });
});

test('Base44 mapping keeps malformed response values out of render paths', () => {
  const mapped = mapMergedToBase44Property({
    account: { address: { unsafe: true }, county: ['Dallas'] },
    primary_improvements: { living_area_sqft: { amount: 1800 }, pool: 'no' },
    owner_summary: { owner_name: { unsafe: true } },
    photos: ['https://example.com/safe.jpg', { unsafe: true }, ''],
    protest_history: [{ year: 2025, status: {}, initial_value: 10, final_value: 5 }],
  }, 'fallback-account');
  assert.equal(mapped.account_number, 'fallback-account');
  assert.equal(mapped.address, '');
  assert.equal(mapped.county, '');
  assert.equal(mapped.square_footage, '');
  assert.equal(mapped.owner_name, null);
  assert.equal(mapped.pool, null);
  assert.deepEqual(mapped.photos, ['https://example.com/safe.jpg']);
  assert.deepEqual(mapped.protest_history, []);
});

test('Base44 load errors are bounded without stringifying arbitrary objects', () => {
  assert.equal(propertyLoadErrorMessage(new Error('County API unavailable')), 'County API unavailable');
  assert.equal(propertyLoadErrorMessage({ message: 'Request timed out' }), 'Request timed out');
  assert.equal(propertyLoadErrorMessage({ secret: 'do not show' }), 'Load failed');
  assert.equal(propertyLoadErrorMessage(new Error('x'.repeat(200))).length, 160);
});

test('the Base44 property page contains no explicit any escapes', async () => {
  const source = await readFile(new URL('../src/pages/PropertyDetailsBase44.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
  assert.match(source, /mapMergedToBase44Property/);
});
