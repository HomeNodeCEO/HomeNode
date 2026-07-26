import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const ratingsSource = await readFile(
  new URL('../src/lib/conditionQualityRatings.ts', import.meta.url),
  'utf8',
);
const ratingsUrl = moduleDataUrl(transpile(ratingsSource));

const studySource = (
  await readFile(
    new URL('../src/lib/conditionQualityStudy.ts', import.meta.url),
    'utf8',
  )
).replace(
  "from './conditionQualityRatings'",
  `from '${ratingsUrl}'`,
);
const {
  calculateConditionQualityStudy,
  calculateRatingAdjustment,
  factoredStudyAmount,
} = await import(moduleDataUrl(transpile(studySource)));

const snowmassSales = [
  { id: 'innsbrook', price: 300000, condition: 'C3-C2', quality: 'Q4' },
  { id: 'matterhorn', price: 329000, condition: 'C3-C2', quality: 'Q3' },
  { id: 'vail', price: 304500, condition: 'C3-C2', quality: 'Q4' },
  { id: 'snowmass', price: 230000, condition: 'C4-C3', quality: 'Q4' },
  { id: 'red-river', price: 376500, condition: 'C3-C2', quality: 'Q3' },
  { id: 'briar-creek', price: 246000, condition: 'C4-C3', quality: 'Q4' },
];

const result = calculateConditionQualityStudy(snowmassSales);
assert.equal(result.selectedSaleCount, 6);
assert.equal(result.condition.groups.length, 2);
assert.equal(result.quality.groups.length, 2);

const conditionTransition = result.condition.transitions[0];
assert.equal(conditionTransition.label, 'C3-C2 to C4-C3');
assert.equal(
  conditionTransition.options.find((option) => option.id === 'median').amount,
  78800,
);
assert.equal(
  conditionTransition.options.find((option) => option.id === 'average').amount,
  89500,
);

const qualityTransition = result.quality.transitions[0];
assert.equal(qualityTransition.label, 'Q3 to Q4');
assert.equal(
  qualityTransition.options.find((option) => option.id === 'median').amount,
  79800,
);
assert.equal(
  qualityTransition.options.find((option) => option.id === 'average').amount,
  82600,
);

assert.equal(
  calculateRatingAdjustment(78800, 'C4-C3', 'C3-C2', 'condition'),
  -78800,
);
assert.equal(
  calculateRatingAdjustment(78800, 'C4-C3', 'C4', 'condition'),
  39400,
);
assert.equal(
  calculateRatingAdjustment(78800, 'C4-C3', 'C4-C3', 'condition'),
  0,
);
assert.equal(factoredStudyAmount(78800, 50), 39400);

console.log('Condition and quality study tests passed.');
