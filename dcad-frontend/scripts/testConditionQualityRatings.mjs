import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/lib/conditionQualityRatings.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const {
  deriveRatingAdjustments,
  inferAutoRatings,
  ratingScore,
  shiftRating,
} = await import(moduleUrl);

assert.equal(ratingScore('C4-C3', 'condition'), 3.5);
assert.equal(ratingScore('Q4-Q3', 'quality'), 3.5);
assert.equal(shiftRating('C4-C3', 'condition', -1), 'C3-C2');
assert.equal(shiftRating('Q4', 'quality', -1), 'Q3');

const snowmassSales = [
  { id: '3209 Innsbrook Dr', price: 300_000 },
  { id: '2105 Matterhorn Dr', price: 329_000 },
  { id: '2005 Vail Dr', price: 304_500 },
  { id: '2013 Snowmass Ln', price: 230_000 },
  { id: '2301 Red River Dr', price: 376_500 },
  { id: '1806 Briar Creek Cir', price: 246_000 },
];

const inferred = inferAutoRatings(snowmassSales, 'C4-C3', 'Q4');
const inferredByAddress = new Map(
  inferred.suggestions.map((suggestion) => [suggestion.id, suggestion]),
);

assert.deepEqual(
  inferredByAddress.get('3209 Innsbrook Dr'),
  { id: '3209 Innsbrook Dr', condition: 'C3-C2', quality: 'Q4' },
);
assert.deepEqual(
  inferredByAddress.get('2105 Matterhorn Dr'),
  { id: '2105 Matterhorn Dr', condition: 'C3-C2', quality: 'Q3' },
);
assert.deepEqual(
  inferredByAddress.get('2005 Vail Dr'),
  { id: '2005 Vail Dr', condition: 'C3-C2', quality: 'Q4' },
);
assert.deepEqual(
  inferredByAddress.get('2013 Snowmass Ln'),
  { id: '2013 Snowmass Ln', condition: 'C4-C3', quality: 'Q4' },
);
assert.deepEqual(
  inferredByAddress.get('2301 Red River Dr'),
  { id: '2301 Red River Dr', condition: 'C3-C2', quality: 'Q3' },
);
assert.deepEqual(
  inferredByAddress.get('1806 Briar Creek Cir'),
  { id: '1806 Briar Creek Cir', condition: 'C4-C3', quality: 'Q4' },
);

const ratedSales = snowmassSales.map((sale) => ({
  ...sale,
  condition: inferredByAddress.get(sale.id).condition,
  quality: inferredByAddress.get(sale.id).quality,
}));
const adjustments = deriveRatingAdjustments(
  ratedSales,
  'C4-C3',
  'Q4',
);

assert.equal(adjustments.conditionBaselineMedian, 238_000);
assert.equal(adjustments.conditionRate, 64_250);
assert.equal(adjustments.postConditionQualityMedian, 238_000);
assert.equal(adjustments.qualityRate, 50_500);

const adjustmentByAddress = new Map(
  adjustments.adjustments.map((adjustment) => [adjustment.id, adjustment]),
);
assert.deepEqual(
  adjustmentByAddress.get('2105 Matterhorn Dr'),
  {
    id: '2105 Matterhorn Dr',
    conditionAdjustment: -64_250,
    qualityAdjustment: -50_500,
  },
);
assert.deepEqual(
  adjustmentByAddress.get('1806 Briar Creek Cir'),
  {
    id: '1806 Briar Creek Cir',
    conditionAdjustment: 0,
    qualityAdjustment: 0,
  },
);

console.log('Condition and quality rating tests passed.');
