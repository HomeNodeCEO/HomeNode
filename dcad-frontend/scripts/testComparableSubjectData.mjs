import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  accountNeedsRoomRefresh,
  boundedErrorMessage,
  mergeSubjectData,
  responseSummary,
  subjectFromAccountResponse,
  subjectFromDetailResponse,
} from '../src/lib/comparableSubjectData.ts';

test('account responses populate only checked comparable subject fields', () => {
  const subject = subjectFromAccountResponse({
    account: {
      address: '1909 Snowmass Ln',
      latest_market_value: '325000',
      neighborhood_code: 'N-1',
    },
    primary_improvements: {
      living_area_sqft: 1840,
      bedroom_count: 3,
      baths_full: 2,
      baths_half: 1,
      basement: false,
      pool: 'T',
    },
    housing_profile: { attachment_type: 'Detached', structural_style: 'Ranch' },
  }, 'A-1');

  assert.equal(subject.accountId, 'A-1');
  assert.equal(subject.total_living_area, 1840);
  assert.equal(subject.market_value, '325000');
  assert.equal(subject.basement, false);
  assert.equal(subject.attachment_type, 'detached');
  assert.equal(subject.structural_style, 'Ranch');
});

test('detail responses safely derive site and improvement evidence', () => {
  const subject = subjectFromDetailResponse({ detail: {
    property_location: { address: 'Subject', neighborhood: 'N-2' },
    value_summary: { market_value: 410000 },
    main_improvement: { total_living_area: 2100, bedroom_count: 4 },
    land_detail: [{ area_sqft: '8,000' }, null, { area_sqft: 400 }],
    secondary_improvements: [
      { imp_type: 'Basement', area_size: 500 },
      { improvement_desc: 'Attached Garage', area_sqft: 450 },
      { description: 'Solar panel array', area_sqft: 120 },
      { description: 'Swimming Pool' },
    ],
  } }, 'A-2', { derivePool: true });

  assert.equal(subject.land_size_sqft, 8400);
  assert.equal(subject.basement_sqft, 500);
  assert.equal(subject.garage_area_sqft, 450);
  assert.equal(subject.solar_panels, true);
  assert.equal(subject.solar_area_sqft, 120);
  assert.equal(subject.pool, 'T');
  assert.equal(subject.nbhd_code, 'N-2');
});

test('malformed detail values stay out of comparable state', () => {
  const subject = subjectFromDetailResponse({
    detail: {
      property_location: { address: { hostile: true } },
      main_improvement: { total_living_area: Number.POSITIVE_INFINITY, pool: {} },
      land_detail: [1, null, 'bad'],
      secondary_improvements: { description: 'garage' },
      housing_profile: { attachment_type: 'unexpected' },
    },
  }, 'A-3');

  assert.equal(subject.address, null);
  assert.equal(subject.total_living_area, null);
  assert.equal(subject.land_size_sqft, null);
  assert.equal(subject.attachment_type, 'unknown');
  assert.equal(subject.pool, null);
});

test('enrichment fills missing fields without replacing authoritative account values', () => {
  const merged = mergeSubjectData(
    { accountId: 'A-4', address: 'DB ADDRESS', market_value: 0, bedroom_count: null },
    { accountId: 'A-4', address: 'SCRAPER ADDRESS', market_value: 500000, bedroom_count: 3 },
    'A-4',
  );
  assert.equal(merged.address, 'DB ADDRESS');
  assert.equal(merged.market_value, 0);
  assert.equal(merged.bedroom_count, 3);
});

test('room refresh, summary, and error boundaries are deterministic', () => {
  assert.equal(accountNeedsRoomRefresh({ primary_improvements: { bedroom_count: 3, bath_count: 2 } }), false);
  assert.equal(accountNeedsRoomRefresh({ primary_improvements: { bedroom_count: null, bath_count: 2 } }), true);
  assert.equal(responseSummary({ content: '  ready  ' }), 'ready');
  assert.equal(responseSummary({ summary: { unsafe: true } }), '');
  assert.equal(boundedErrorMessage(new Error('network down'), 'fallback'), 'network down');
  assert.equal(boundedErrorMessage({ message: 'untrusted' }, 'fallback'), 'fallback');
});

test('the comparable-sales page uses checked data and bounded scraper requests', async () => {
  const [page, boundary] = await Promise.all([
    readFile(new URL('../src/pages/ComparableSalesAnalysis.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/comparableSubjectData.ts', import.meta.url), 'utf8'),
  ]);
  const explicitAny = /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/;
  assert.doesNotMatch(page, explicitAny);
  assert.doesNotMatch(boundary, explicitAny);
  assert.match(page, /AbortSignal\.timeout\(15_000\)/);
  assert.match(page, /subjectFromDetailResponse/);
});
