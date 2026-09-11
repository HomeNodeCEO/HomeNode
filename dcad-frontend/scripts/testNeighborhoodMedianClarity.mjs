import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateNeighborhoodRepresentativeness, neighborhoodRangeLabel, formatNeighborhoodRangeValue,
  NEIGHBORHOOD_RANGE_ROWS, NEIGHBORHOOD_ALL_PROPERTY_ROWS } from '../src/lib/neighborhoodCharacteristics.ts';

const base = {
  neighborhood_house_price_predominant: 300000, neighborhood_all_house_price_predominant: 300000,
  neighborhood_ppsf_predominant: 200, neighborhood_all_ppsf_predominant: 200,
  neighborhood_gla_predominant: 1800, neighborhood_all_gla_predominant: 1800,
};
const years = { ...base, neighborhood_age_low: 1951, neighborhood_age_high: 2006, neighborhood_age_predominant: 1970,
  neighborhood_all_age_low: 1940, neighborhood_all_age_high: 2020, neighborhood_all_age_predominant: 1970 };

test('a wide year-built range and equal medians never become 100% age similarity', () => {
  const result = calculateNeighborhoodRepresentativeness(years);
  const age = result.factors.find(f => f.key === 'age');
  assert.equal(age.label, 'Year Built');
  assert.equal(age.similarityScore, null);
  assert.equal(age.deviationPercent, null);
  assert.match(age.comparisonNote, /Median gap: 0 years/);
  assert.match(result.narrative, /3 scored measures/);
  assert.match(result.narrative, /do not mean individual properties are alike/);
});
test('calendar-year differences are not divided by the year number', () => {
  const result = calculateNeighborhoodRepresentativeness({ ...years, neighborhood_age_predominant: 1990 });
  assert.match(result.factors.find(f => f.key === 'age').comparisonNote, /20 years/);
  assert.equal(result.factors.find(f => f.key === 'age').similarityScore, null);
});
test('elapsed-age comparison retains its original result and explains its median-only scope', () => {
  const result = calculateNeighborhoodRepresentativeness({ ...base, neighborhood_age_predominant: 28, neighborhood_all_age_predominant: 30 });
  assert.equal(result.factors.find(f => f.key === 'age').similarityScore, 93.3);
  assert.match(result.narrative, /4 scored measures/);
});
test('mixed age/year and contradictory ranges are never percentage scored', () => {
  for (const draft of [{ ...years, neighborhood_all_age_predominant: 30 }, { ...years, neighborhood_age_low: 20 }]) {
    const result = calculateNeighborhoodRepresentativeness(draft);
    assert.equal(result.factors.find(f => f.key === 'age').similarityScore, null);
    assert.match(result.narrative, /units need review/);
  }
});
test('year comparison cannot satisfy the minimum three percentage-comparable measures', () => {
  const result = calculateNeighborhoodRepresentativeness({ ...years, neighborhood_gla_predominant: '' });
  assert.equal(result.score, null);
  assert.match(result.narrative, /At least three comparable/);
});
test('both static grids and print share ungrouped years, honest fractional medians, and money precision', () => {
  for (const rows of [NEIGHBORHOOD_RANGE_ROWS, NEIGHBORHOOD_ALL_PROPERTY_ROWS]) {
    assert.equal(neighborhoodRangeLabel(rows[2], years), 'Year Built');
    assert.equal(formatNeighborhoodRangeValue(1951, rows[2]), '1951');
    assert.equal(formatNeighborhoodRangeValue('2,006', rows[2]), '2006');
    assert.equal(formatNeighborhoodRangeValue(1970.5, rows[2]), '1970.5');
    assert.equal(formatNeighborhoodRangeValue(null, rows[2]), 'Not reported');
    assert.equal(formatNeighborhoodRangeValue(300000, rows[0]), '300,000');
    assert.equal(formatNeighborhoodRangeValue(123.45678, rows[1]), '123.46');
    assert.equal(formatNeighborhoodRangeValue(1800, rows[3]), '1,800');
  }
});
test('review calculations never mutate saved assignment data', () => {
  const input = Object.freeze({ ...years });
  calculateNeighborhoodRepresentativeness(input);
  assert.deepEqual(input, years);
});
