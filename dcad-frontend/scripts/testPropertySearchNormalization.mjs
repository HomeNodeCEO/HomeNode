import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeSearchRows,
  propertySearchErrorMessage,
} from '../src/features/propertySearch/searchResults.ts';

test('property search normalizes direct and wrapped result arrays', () => {
  const row = {
    account_id: ' 12345678901234567 ',
    address: '100 Main St',
    city: 'Duncanville',
    latest_market_value: '$250,000',
    search_match: 'exact_address',
    data_quality_flags: ['missing_owner', 17],
    resolved_from_legacy: true,
  };
  const expected = {
    account_id: '12345678901234567',
    address: '100 Main St',
    street_name: null,
    city: 'Duncanville',
    postal_code: null,
    search_match: 'exact_address',
    owner: null,
    situs_address: null,
    latest_market_value: '$250,000',
    data_quality_status: null,
    data_quality_flags: ['missing_owner'],
    canonical_account_id: null,
    requested_account_id: null,
    resolved_from_legacy: true,
  };

  assert.deepEqual(normalizeSearchRows([row]), [expected]);
  assert.deepEqual(normalizeSearchRows({ results: [row] }), [expected]);
  assert.deepEqual(normalizeSearchRows({ rows: [row] }), [expected]);
});

test('property search drops malformed rows and sanitizes unsafe optional fields', () => {
  assert.deepEqual(normalizeSearchRows(null), []);
  assert.deepEqual(normalizeSearchRows({ results: 'not-an-array' }), []);
  assert.deepEqual(normalizeSearchRows([
    null,
    {},
    { account_id: 17 },
    {
      account_id: 'valid-account',
      address: { injected: true },
      latest_market_value: { amount: 250000 },
      search_match: 'unrecognized',
      resolved_from_legacy: 'true',
    },
  ]), [{
    account_id: 'valid-account',
    address: null,
    street_name: null,
    city: null,
    postal_code: null,
    search_match: null,
    owner: null,
    situs_address: null,
    latest_market_value: null,
    data_quality_status: null,
    data_quality_flags: null,
    canonical_account_id: null,
    requested_account_id: null,
    resolved_from_legacy: undefined,
  }]);
});

test('property search errors remain readable without unsafe exception casts', () => {
  assert.equal(propertySearchErrorMessage(new Error('search unavailable')), 'search unavailable');
  assert.equal(propertySearchErrorMessage({ message: 'bounded provider error' }), 'bounded provider error');
  assert.equal(propertySearchErrorMessage('network offline'), 'network offline');
  assert.equal(propertySearchErrorMessage(null), 'null');
});

test('the search page uses checked normalization without explicit any escapes', async () => {
  const source = await readFile(
    new URL('../src/pages/PropertySearch.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /normalizeSearchRows\(input\)/);
  assert.match(source, /propertySearchErrorMessage\(e\)/);
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>/);
  assert.doesNotMatch(source, /typeof \(api as/);
});
