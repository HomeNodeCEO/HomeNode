import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  editableInputValue,
  normalizeSecondaryImprovements,
  normalizeSectionEditData,
} from '../src/features/propertyDetails/sectionEditData.ts';

test('section edits retain supported data and extension fields', () => {
  assert.deepEqual(normalizeSectionEditData({
    square_footage: 1800,
    bath_count: '2.5',
    extension_field: 'preserved',
    secondary_improvements: [{
      improvement_type: 'Garage',
      area_sqft: '400',
      extension_note: 'detached',
    }],
  }), {
    square_footage: 1800,
    total_area_sqft: undefined,
    stories: undefined,
    bath_count: '2.5',
    extension_field: 'preserved',
    secondary_improvements: [{
      improvement_type: 'Garage',
      construction: undefined,
      floor: undefined,
      exterior_wall: undefined,
      area_sqft: '400',
      extension_note: 'detached',
    }],
  });
});

test('malformed modal data cannot reach input values or array mutation paths', () => {
  assert.deepEqual(normalizeSectionEditData(['not', 'a', 'record']), {});
  assert.deepEqual(normalizeSecondaryImprovements([
    null,
    'invalid',
    { improvement_type: { unsafe: true }, area_sqft: Number.POSITIVE_INFINITY },
  ]), [{
    improvement_type: undefined,
    construction: undefined,
    floor: undefined,
    exterior_wall: undefined,
    area_sqft: undefined,
  }]);
  assert.equal(editableInputValue({ unsafe: true }), '');
  assert.equal(editableInputValue(Number.NaN), '');
  assert.equal(editableInputValue(0), 0);
  assert.equal(editableInputValue('Garage'), 'Garage');
});

test('the reusable section editor contains no explicit any escapes', async () => {
  const source = await readFile(new URL('../src/modals/SectionEditModal.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bas any\b|:\s*any\b|<any>|Record<string,\s*any>/);
  assert.match(source, /normalizeSectionEditData/);
  assert.match(source, /normalizeSecondaryImprovements/);
});
