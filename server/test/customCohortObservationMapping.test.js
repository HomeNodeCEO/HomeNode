import test from 'node:test';
import assert from 'node:assert/strict';
import { customCohortObservationMappingVersion as version,
  customCohortObservationProjectionMatches as matches } from '../src/services/neighborhoodAssessment/customCohortObservationMapping.js';

const acquisition = mapping_version => ({ compact_metadata_json: JSON.stringify({ reader_version: 'local-capture-v3', mapping_version }) });

test('legacy observation inputs stay v2 and installed original metadata selects v2 or v3', () => {
  assert.equal(version({}), 2);
  assert.equal(version(acquisition(2)), 2);
  assert.equal(version(acquisition(3)), 3);
});

for (const mapping of [1, 4, '3', null]) test(`unknown mapping ${JSON.stringify(mapping)} cannot select a consumer`, () => {
  assert.throws(() => version(acquisition(mapping)), /metadata_invalid/);
});

test('missing v3 reader identity, malformed or oversized compact metadata reject', () => {
  for (const compact_metadata_json of [null, {}, '{', JSON.stringify({ mapping_version: 3 }),
    JSON.stringify({ reader_version: 'foreign', mapping_version: 3 }), ' '.repeat(64001)]) {
    assert.throws(() => version({ compact_metadata_json }), /metadata_invalid/);
  }
});

test('v3 requires explicitly matching source projection versions; it cannot relabel old chunks', () => {
  assert.equal(matches({ role: 'accounts' }, 2), true);
  assert.equal(matches({ role: 'accounts' }, 3), false);
  for (const selected of [2, 3]) for (const projected of [1, 2, 3, 4, '3', null]) {
    assert.equal(matches({ mapping_version: projected }, selected), projected === selected);
  }
});
