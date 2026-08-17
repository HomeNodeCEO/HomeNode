import assert from 'node:assert/strict';
import test from 'node:test';

import {
  includeCustomMarketArea,
  marketAreaOriginFromSource,
  resolveInitialMarketAreaGeometry,
  shouldAdoptIncomingMarketArea,
} from '../src/lib/marketAreaGeometry.ts';

const generated = {
  type: 'Polygon',
  coordinates: [[[-96.9, 32.6], [-96.8, 32.6], [-96.8, 32.7], [-96.9, 32.6]]],
};
const edited = {
  type: 'Polygon',
  coordinates: [[[-96.91, 32.59], [-96.79, 32.59], [-96.79, 32.71], [-96.91, 32.59]]],
};

test('assignment geometry is authoritative over browser-saved and generated areas', () => {
  assert.equal(resolveInitialMarketAreaGeometry({
    assignmentGeometry: edited,
    savedStudyGeometry: generated,
    suggestedGeometry: generated,
  }), edited);
});

test('a generated boundary automatically enables the custom market study', () => {
  assert.deepEqual(includeCustomMarketArea(['city', 'zip'], generated), ['city', 'zip', 'custom']);
});

test('an appraiser edit is not overwritten by a later generated suggestion', () => {
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: edited,
    currentOrigin: 'appraiser',
    incomingGeometry: generated,
  }), false);
});

test('clearing an area blocks automatic reseeding until the appraiser resets it', () => {
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: null,
    currentOrigin: 'cleared',
    incomingGeometry: generated,
  }), false);
  assert.equal(marketAreaOriginFromSource('appraiser_defined_area_cleared', null), 'cleared');
});
