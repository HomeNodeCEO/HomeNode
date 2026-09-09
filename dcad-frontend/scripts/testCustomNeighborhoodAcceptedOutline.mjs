import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedNeighborhoodOutline } from '../src/features/neighborhood/acceptedNeighborhoodOutline.ts';
const outer = [[-97, 32], [-96.9, 32], [-96.9, 32.1], [-97, 32.1], [-97, 32]];
const hole = [[-96.98, 32.02], [-96.92, 32.02], [-96.92, 32.08], [-96.98, 32.08], [-96.98, 32.02]];

test('retains separate polygons and hole subpaths without joining their vertices', () => {
  const geometry = { type: 'MultiPolygon', coordinates: [[outer, hole], [outer.map(([x,y]) => [x + .2, y])]] };
  const before = structuredClone(geometry), result = acceptedNeighborhoodOutline(geometry);
  assert.equal(result.paths.length, 2);
  assert.equal((result.paths[0].match(/M/g) || []).length, 2);
  assert.equal((result.paths[0].match(/ Z/g) || []).length, 2);
  assert.equal((result.paths[1].match(/M/g) || []).length, 1);
  assert.deepEqual(geometry, before); assert.deepEqual(result.geometry, before);
});
for (const invalid of [null, {}, { type: 'Point', coordinates: [-97, 32] }, { type: 'Polygon', coordinates: [] },
  { type: 'Polygon', coordinates: [outer.slice(0, 4)] }, { type: 'Polygon', coordinates: [[[0,0],[1,1],[2,2]]] },
  { type: 'Polygon', coordinates: [[...outer.slice(0, 2), [Infinity, 32.1], ...outer.slice(3)]] }]) {
  test(`invalid or unclosed geometry is unavailable without repair: ${JSON.stringify(invalid)}`, () => {
    assert.equal(acceptedNeighborhoodOutline(invalid), null);
  });
}
test('outline does not replace twists with a rectangle', () => {
  const geometry = { type: 'Polygon', coordinates: [[...outer.slice(0, 2), [-96.95, 32.04], ...outer.slice(2)]] };
  const result = acceptedNeighborhoodOutline(geometry);
  assert.equal((result.paths[0].match(/ L/g) || []).length, 5);
});
