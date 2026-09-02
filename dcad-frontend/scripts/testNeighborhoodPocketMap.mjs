import assert from 'node:assert/strict';

import { makeNeighborhoodPocketFeatureCollection } from '../src/lib/neighborhoodPocketMap.ts';

const collection = makeNeighborhoodPocketFeatureCollection([
  {
    parcel_object_id: 1,
    pocket_id: 'pocket:one',
    primary_population: true,
    system_selected: true,
    recommended_population: true,
    score: 91,
    point: { type: 'Point', coordinates: [-96.8, 32.7] },
  },
  {
    parcel_object_id: 2,
    pocket_id: 'pocket:one',
    primary_population: true,
    system_selected: true,
    recommended_population: true,
    score: 79,
    point: { type: 'Point', coordinates: [-96.799, 32.701] },
  },
  {
    parcel_object_id: 3,
    pocket_id: 'pocket:two',
    primary_population: false,
    system_selected: true,
    appraiser_override: 'removed',
    score: 55,
    point: { type: 'Point', coordinates: [-96.81, 32.71] },
  },
]);

assert.equal(collection.features.length, 2);
const included = collection.features.find((feature) => feature.id === 'pocket:one');
assert.equal(included.properties.status, 'included');
assert.equal(included.properties.recommended, true);
assert.equal(included.properties.property_count, 2);
assert.equal(included.properties.average_score, 85);
assert.equal(included.geometry.coordinates[0].length, 5);
assert.deepEqual(
  included.geometry.coordinates[0][0],
  included.geometry.coordinates[0].at(-1),
);

const removed = collection.features.find((feature) => feature.id === 'pocket:two');
assert.equal(removed.properties.status, 'removed');
assert.equal(removed.properties.included, false);
assert.equal(removed.geometry.coordinates[0].length, 5);

console.log('neighborhood pocket map tests passed');
