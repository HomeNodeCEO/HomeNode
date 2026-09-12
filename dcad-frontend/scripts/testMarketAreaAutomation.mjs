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

test('starting a redraw preserves the intentionally empty manual draft', () => {
  // beginCustomBoundary switches to appraiser origin and clears the local
  // polygon before the first click. The saved assignment still supplies the
  // old polygon until Close Area; it must not refill that draft on rerender.
  for (const incomingGeometry of [generated, edited, structuredClone(generated)]) {
    assert.equal(shouldAdoptIncomingMarketArea({
      currentGeometry: null,
      currentOrigin: 'appraiser',
      incomingGeometry,
    }), false);
  }
});

test('an untouched empty area still accepts its asynchronously loaded assignment', () => {
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: null,
    currentOrigin: 'automatic',
    incomingGeometry: generated,
  }), true);
});

test('closing and cancelling edits retain the prior origin rules', () => {
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: edited, currentOrigin: 'appraiser', incomingGeometry: generated,
  }), false);
  // Cancelling an automatic outline edit restores its original geometry and
  // origin, allowing a genuinely newer automatic outline again.
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: generated, currentOrigin: 'automatic', incomingGeometry: edited,
  }), true);
  assert.equal(shouldAdoptIncomingMarketArea({
    currentGeometry: generated, currentOrigin: 'automatic', incomingGeometry: structuredClone(generated),
  }), false);
});
