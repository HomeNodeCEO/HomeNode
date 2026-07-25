import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourceUrl = new URL('../src/lib/comparableAdjustments.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const {
  bathroomEquivalentValue,
  calculateNumericGroupedAdjustment,
} = await import(moduleUrl);

const oneToTwoBathStudy = {
  dimensionKey: 'bathrooms',
  fromGroupValue: 1,
  toGroupValue: 2,
  amount: 98_000,
};
const threeToFourBathStudy = {
  dimensionKey: 'bathrooms',
  fromGroupValue: 3,
  toGroupValue: 4,
  amount: 149_500,
};

assert.equal(bathroomEquivalentValue(null, 2, 1), 2.5);
assert.equal(bathroomEquivalentValue(null, 2, 2), 3);
assert.equal(bathroomEquivalentValue(null, null, null, 2.2), 3);
assert.equal(bathroomEquivalentValue(null, 3, 1), 3.5);

assert.equal(
  calculateNumericGroupedAdjustment([oneToTwoBathStudy], 'bathrooms', 2, 2.5),
  -49_000,
  'A comparable with one superior half bath should receive half the full adjustment downward.',
);
assert.equal(
  calculateNumericGroupedAdjustment([oneToTwoBathStudy], 'bathrooms', 2.5, 2),
  49_000,
  'A comparable with one inferior half bath should receive half the full adjustment upward.',
);
assert.equal(
  calculateNumericGroupedAdjustment([oneToTwoBathStudy], 'bathrooms', 3, 3.5),
  -49_000,
  '2.2 and 3.1 differ by only one half bath after equivalent-bath conversion.',
);
assert.equal(
  calculateNumericGroupedAdjustment([oneToTwoBathStudy], 'bathrooms', 3.5, 3),
  49_000,
  'The same half-bath difference should reverse direction when the subject is superior.',
);
assert.equal(
  calculateNumericGroupedAdjustment([oneToTwoBathStudy], 'bathrooms', 7, 8),
  -98_000,
  'A 1-to-2 bath study should supply the same unit rate to a 7-to-8 bath difference.',
);
assert.equal(
  calculateNumericGroupedAdjustment([threeToFourBathStudy], 'bathrooms', 2, 2.5),
  -74_750,
  'A 3-to-4 bath study should apply to any half-bath difference.',
);
assert.equal(
  calculateNumericGroupedAdjustment(
    [oneToTwoBathStudy, threeToFourBathStudy],
    'bathrooms',
    2,
    2.5,
  ),
  -74_750,
  'The most recently selected study should replace the prior universal rate.',
);
assert.equal(
  calculateNumericGroupedAdjustment(
    [{
      dimensionKey: 'garage',
      fromGroupValue: 0,
      toGroupValue: 1,
      amount: 10_000,
    }],
    'garage',
    2,
    0,
  ),
  20_000,
  'A selected garage study should apply once for every garage-space difference.',
);

console.log('Comparable adjustment tests passed.');
