import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { NEIGHBORHOOD_SPATIAL_INDEX_NAMES as names, prepareNeighborhoodSpatialIndexes, spatialIndexStatements } from '../scripts/prepareNeighborhoodSpatialIndexes.js';
const sql = await fs.readFile(new URL('../maintenance/neighborhoodSpatialIndexes.sql', import.meta.url), 'utf8');
const memberCode = await fs.readFile(new URL('../src/services/neighborhoodAssessment/cachedSpatialMembership.js', import.meta.url), 'utf8');
const normalize = text => text.replace(/\s+/g, ' ').trim();
const validRows = names.map(name => ({ index_name: name, indisvalid: true, indisready: true,
  table_schema: 'gis', table_name: 'dcad_parcels', method: name.endsWith('_gix') ? 'gist' : 'btree' }));

test('online indexes preserve the complete invalid-geometry gate and spheroid expression', () => {
  const statements = spatialIndexStatements(sql.replaceAll('\r\n', '\n'));
  const gate = memberCode.match(/const INELIGIBLE_SQL = `[^`]*?WHERE ([\s\S]*?)\s+LIMIT 1`;/)?.[1];
  assert.ok(gate);
  assert.equal(normalize(statements[0].split(/\bWHERE\s+/)[1]), normalize(gate));
  assert.match(statements[1], /USING gist \(\(geom::geography\)\)/);
  assert.doesNotMatch(statements.join('\n'), /\b(?:DROP|UPDATE|DELETE|ALTER|BEGIN)\b/);
});
test('inspection is the default and does not build or change session settings', async () => {
  const calls = [];
  const result = await prepareNeighborhoodSpatialIndexes({ query: async q => { calls.push(q); return { rows: [] }; } });
  assert.equal(result.mode, 'inspection_only'); assert.deepEqual(result.missing, names); assert.equal(calls.length, 1);
});
test('invalid concurrent indexes require manual review, never automatic deletion', async () => {
  let calls = 0;
  await assert.rejects(prepareNeighborhoodSpatialIndexes({ query: async () => { calls++; return { rows: [{ ...validRows[0], indisvalid: false }] }; } }, { apply: true }), /requires_manual_review/);
  assert.equal(calls, 1);
});
test('preexisting valid indexes are retained and no duplicate builds are started', async () => {
  const calls = [];
  const result = await prepareNeighborhoodSpatialIndexes({ query: async q => { calls.push(q); return { rows: validRows }; } }, { apply: true });
  assert.equal(result.mode, 'prepared'); assert.equal(calls.filter(q => q.startsWith('CREATE')).length, 0);
});
test('apply builds only missing indexes sequentially and verifies their validity', async () => {
  const calls = [], existing = [];
  const result = await prepareNeighborhoodSpatialIndexes({ query: async q => {
    calls.push(q); if (q.startsWith('CREATE')) existing.push(validRows[existing.length]);
    return { rows: [...existing] };
  } }, { apply: true, log() {} });
  assert.equal(result.mode, 'prepared'); assert.equal(calls.filter(q => q.startsWith('CREATE')).length, 2);
  assert.equal(result.indexes.length, 2);
});
test('unrecognized maintenance statement input is rejected', () => {
  assert.throws(() => spatialIndexStatements('DROP TABLE gis.dcad_parcels;'), /unexpected_spatial_index/);
});
