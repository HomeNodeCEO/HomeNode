import assert from 'node:assert/strict';
import test from 'node:test';
import { neighborhoodSelectionStatisticsPatch } from '../src/lib/neighborhoodCharacteristics.ts';

const metric = (base) => ({ low: base + 1, high: base + 3, median: base + 2, count: base + 4 });
const statistics = {
  included_sale_count: 127, included_property_count: 3841,
  sales_profile: { sale_price: metric(100), price_per_square_foot: metric(200), age: metric(300), gla: metric(400) },
  property_profile: { market_value: metric(500), value_per_square_foot: metric(600), age: metric(700), gla: metric(800) },
};
const automatic = {
  neighborhood_value_position: 'above_predominant', neighborhood_value_difference: 10000,
  neighborhood_value_difference_pct: 5, neighborhood_value_conclusion: 'Existing generated text',
  neighborhood_value_conclusion_auto: 'Existing generated text', neighborhood_value_conclusion_signature: 'signature',
  neighborhood_value_conclusion_generated_at: '2026-09-06', neighborhood_value_source: 'sales_comparison_approach',
};

test('all 30 populated statistic fields retain the existing source mapping and raw values', () => {
  const patch = neighborhoodSelectionStatisticsPatch({}, statistics);
  const expected = {
    neighborhood_sale_count: 127, neighborhood_all_property_count: 3841,
    neighborhood_house_price_low: 101, neighborhood_house_price_high: 103, neighborhood_house_price_predominant: 102,
    neighborhood_ppsf_low: 201, neighborhood_ppsf_high: 203, neighborhood_ppsf_predominant: 202,
    neighborhood_age_low: 301, neighborhood_age_high: 303, neighborhood_age_predominant: 302,
    neighborhood_gla_low: 401, neighborhood_gla_high: 403, neighborhood_gla_predominant: 402,
    neighborhood_all_house_price_low: 501, neighborhood_all_house_price_high: 503, neighborhood_all_house_price_predominant: 502,
    neighborhood_all_ppsf_low: 601, neighborhood_all_ppsf_high: 603, neighborhood_all_ppsf_predominant: 602,
    neighborhood_all_age_low: 701, neighborhood_all_age_high: 703, neighborhood_all_age_predominant: 702,
    neighborhood_all_gla_low: 801, neighborhood_all_gla_high: 803, neighborhood_all_gla_predominant: 802,
    neighborhood_all_value_count: 504, neighborhood_all_ppsf_count: 604, neighborhood_all_age_count: 704, neighborhood_all_gla_count: 804,
  };
  assert.equal(Object.keys(expected).length, 30);
  assert.deepEqual(Object.fromEntries(Object.entries(patch).filter(([key]) => !key.startsWith('neighborhood_value_'))), expected);
});

test('identical results preserve generated explanation, signature, and timestamp without regeneration', () => {
  const draft = { ...neighborhoodSelectionStatisticsPatch({}, statistics), ...automatic };
  const patch = neighborhoodSelectionStatisticsPatch(draft, structuredClone(statistics));
  assert.equal(Object.keys(patch).length, 30);
  assert.deepEqual({ ...draft, ...patch }, draft);
});

test('explicit same-statistics area adoption still clears the previous automatic basis', () => {
  const draft = { ...neighborhoodSelectionStatisticsPatch({}, statistics), ...automatic };
  const patch = neighborhoodSelectionStatisticsPatch(draft, statistics, true);
  for (const field of Object.keys(automatic)) assert.equal(patch[field], '', field);
});

test('a changed selection preserves exact manual commentary and unrelated assignment inputs', () => {
  const manual = '\nAppraiser explanation retained exactly.  ';
  const draft = { ...automatic, neighborhood_value_conclusion: manual, lender_name: 'Client', subject_concluded_value: 282500 };
  const before = structuredClone(draft);
  const patch = neighborhoodSelectionStatisticsPatch(draft, statistics);
  assert.equal(Object.hasOwn(patch, 'neighborhood_value_conclusion'), false);
  assert.equal({ ...draft, ...patch }.neighborhood_value_conclusion, manual);
  assert.equal(Object.hasOwn(patch, 'subject_concluded_value'), false);
  assert.equal(Object.hasOwn(patch, 'lender_name'), false);
  assert.deepEqual(draft, before);
});

test('a legacy automatic narrative without any remaining measurements is invalidated', () => {
  const patch = neighborhoodSelectionStatisticsPatch(automatic);
  for (const field of Object.keys(automatic)) assert.equal(patch[field], '', field);
  assert.ok(Object.values(patch).every(value => value === ''));
});

test('reported zero counts and measurements remain zero while absent values remain blank', () => {
  const patch = neighborhoodSelectionStatisticsPatch({}, {
    included_sale_count: 0, included_property_count: 0,
    sales_profile: { age: { low: 0, high: 0, median: 0 } },
    property_profile: { market_value: { count: 0, median: null } },
  });
  for (const field of ['neighborhood_sale_count', 'neighborhood_all_property_count', 'neighborhood_age_low',
    'neighborhood_age_high', 'neighborhood_age_predominant', 'neighborhood_all_value_count']) assert.equal(patch[field], 0);
  for (const field of ['neighborhood_all_house_price_predominant', 'neighborhood_all_ppsf_count',
    'neighborhood_house_price_low']) assert.equal(patch[field], '');
});
