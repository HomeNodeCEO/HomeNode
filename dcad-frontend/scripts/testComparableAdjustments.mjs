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

const schedule = [
  {
    dimensionKey: 'bathrooms',
    fromGroupValue: 2,
    toGroupValue: 3,
    amount: 87_000,
  },
  {
    dimensionKey: 'bathrooms',
    fromGroupValue: 3,
    toGroupValue: 4,
    amount: 149_500,
  },
];

assert.equal(bathroomEquivalentValue(null, 2, 1), 2.5);
assert.equal(bathroomEquivalentValue(null, 2, 2), 3);
assert.equal(bathroomEquivalentValue(null, null, null, 2.2), 3);
assert.equal(bathroomEquivalentValue(null, 3, 1), 3.5);

assert.equal(
  calculateNumericGroupedAdjustment(schedule, 'bathrooms', 2, 2.5),
  -43_500,
  'A comparable with one superior half bath should receive half the full adjustment downward.',
);
assert.equal(
  calculateNumericGroupedAdjustment(schedule, 'bathrooms', 2.5, 2),
  43_500,
  'A comparable with one inferior half bath should receive half the full adjustment upward.',
);
assert.equal(
  calculateNumericGroupedAdjustment(schedule, 'bathrooms', 3, 3.5),
  -74_750,
  '2.2 and 3.1 differ by only one half bath after equivalent-bath conversion.',
);
assert.equal(
  calculateNumericGroupedAdjustment(schedule, 'bathrooms', 3.5, 3),
  74_750,
  'The same half-bath difference should reverse direction when the subject is superior.',
);
assert.equal(
  calculateNumericGroupedAdjustment(schedule, 'bathrooms', 3.5, 2),
  161_750,
  'A comparison spanning multiple bath intervals should combine both selected studies.',
);

const updatedSchedule = [
  schedule[0],
  {
    ...schedule[1],
    amount: 81_700,
  },
];
assert.equal(
  calculateNumericGroupedAdjustment(updatedSchedule, 'bathrooms', 3.5, 2),
  127_850,
  'Changing a selected study should replace that interval amount in the resulting schedule.',
);
assert.equal(
  calculateNumericGroupedAdjustment([schedule[1]], 'bathrooms', 2, 2.5),
  0,
  'A study must not affect a comparison that does not cross its feature interval.',
);

console.log('Comparable adjustment tests passed.');
