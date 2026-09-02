import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  finiteNumberOrBlank,
  mapDcadDetailToProperty,
  propertyDetailsErrorMessage,
} from '../src/features/propertyDetails/propertyMapping.ts';

test('property detail numbers keep real zeroes and leave absent values blank', () => {
  assert.equal(finiteNumberOrBlank(0), 0);
  assert.equal(finiteNumberOrBlank('0'), 0);
  assert.equal(finiteNumberOrBlank(' 125.5 '), 125.5);
  assert.equal(finiteNumberOrBlank(null), '');
  assert.equal(finiteNumberOrBlank(undefined), '');
  assert.equal(finiteNumberOrBlank('  '), '');
  assert.equal(finiteNumberOrBlank({ value: 10 }), '');
  assert.equal(finiteNumberOrBlank(Number.POSITIVE_INFINITY), '');
});

test('DCAD detail mapping preserves supported facts and value fallbacks', () => {
  assert.deepEqual(mapDcadDetailToProperty({
    owner: { name: 'Example Owner' },
    current_year: { market_value: '250000', taxable_value: 200000 },
    value_summary: { land_value: null, improvement_value: 175000 },
    improvements: { land_value: 75000, improvement_value: 999999 },
    characteristics: {
      living_area_sqft: 1800,
      bedrooms: 3,
      baths: '2.5',
      garage_bays: 2,
      year_built: 1998,
      effective_year_built: 2012,
    },
    land: { acreage: '0.25' },
    zoning: 'R-1',
    classification: 'Single Family',
    inspection: { last_year: 2025 },
    features: { solar_panels: true },
    condition: { functional_obsolescence: false },
  }, '12345678901234567'), {
    account_number: '12345678901234567',
    owner_name: 'Example Owner',
    market_value: 250000,
    taxable_value: 200000,
    land_value: 75000,
    improvement_value: 175000,
    square_footage: 1800,
    bedroom_count: 3,
    bath_count: 2.5,
    garage_bay_count: 2,
    land_acreage: 0.25,
    zoning: 'R-1',
    classification: 'Single Family',
    year_built: 1998,
    effective_year_built: 2012,
    last_inspection_year: 2025,
    solar_panels: true,
    functional_obsolescence: false,
  });
});

test('malformed DCAD detail data cannot leak objects into form controls', () => {
  const mapped = mapDcadDetailToProperty({
    owner: { name: { unsafe: true } },
    current_year: { market_value: { amount: 250000 } },
    characteristics: 'not-an-object',
    zoning: ['R-1'],
    features: { solar_panels: 0 },
  }, 'safe-account');
  assert.equal(mapped.owner_name, '');
  assert.equal(mapped.market_value, '');
  assert.equal(mapped.square_footage, '');
  assert.equal(mapped.zoning, '');
  assert.equal(mapped.solar_panels, false);
});

test('property detail errors remain bounded without unsafe exception casts', () => {
  assert.equal(propertyDetailsErrorMessage(new Error('DCAD unavailable')), 'DCAD unavailable');
  assert.equal(propertyDetailsErrorMessage({ message: 'Import timed out' }), 'Import timed out');
  assert.equal(propertyDetailsErrorMessage({ diagnostic: 'secret' }), 'Import failed');
  assert.equal(propertyDetailsErrorMessage(null), 'Import failed');
});

test('the legacy property form boundary contains no explicit any escapes', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/components/PropertyForm.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/pages/PropertyDetails.tsx', import.meta.url), 'utf8'),
  ]);
  for (const source of files) {
    assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
  }
});
