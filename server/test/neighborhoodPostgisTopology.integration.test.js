import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { METRIC_TOPOLOGY_FIXTURES, TOPOLOGY_FIXTURE_ORIGIN, TOPOLOGY_AREA_TOLERANCE_M2,
  TOPOLOGY_LENGTH_TOLERANCE_M, metricTopologyLineWkt, fixturePlanarLineLength,
  fixturePlanarRingArea, projectMetricTopologyFixture } from './fixtures/neighborhoodPostgisTopologyFixture.js';

const near = (actual, expected, tolerance, label) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
const sortedIds = rows => rows.map(row => row.id).sort();
const noPartial = result => {
  assert.equal(result.status, 'incomplete'); assert.equal(result.topology_validated, false);
  assert.deepEqual(result.cells, []); assert.deepEqual(result.edges, []); assert.deepEqual(result.nodes, []);
};

test('fixture-only: Cartesian metre references are explicitly placed in26914, never reinterpreted as longitude/latitude', () => {
  assert.deepEqual(TOPOLOGY_FIXTURE_ORIGIN, { srid: 26914, easting: 700000, northing: 3600000 });
  assert.equal(metricTopologyLineWkt([[0, 0], [100, 100]]), 'LINESTRING (700000 3600000, 700100 3600100)');
  assert.throws(() => metricTopologyLineWkt([[0, 0], [Infinity, 0]]), /invalid_topology_fixture_coordinate/);
  assert.throws(() => metricTopologyLineWkt([[0, 0], [3000, 0]]), /invalid_topology_fixture_coordinate/);
  assert.equal(Object.isFrozen(METRIC_TOPOLOGY_FIXTURES.square.lines[0].coordinates[0]), true);
});

test('fixture-only: independent curved enclosure, square and nested/sliver areas have exact arithmetic oracles', () => {
  const square = fixturePlanarRingArea([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const curved = fixturePlanarRingArea([[0, 0], [100, 0], [120, 25], [120, 75], [100, 100], [0, 100]]);
  assert.equal(square, 10000); assert.equal(curved, 11500);
  assert.equal(METRIC_TOPOLOGY_FIXTURES.curved.expected.union_area_m2, curved);
  near(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.curved.lines), 350 + 2 * Math.sqrt(1025), 1e-10, 'curved perimeter');
  assert.equal(40 * 40, 1600); assert.equal(square - 40 * 40, 8400);
  assert.deepEqual(METRIC_TOPOLOGY_FIXTURES.nested.expected.areas_m2, [1600, 8400]);
  assert.deepEqual(METRIC_TOPOLOGY_FIXTURES.sliver.expected.areas_m2, [100 * 0.005, 10000 - 100 * 0.005]);
  assert.equal(fixturePlanarRingArea([[0, 0], [100, 0], [50, 50]]), 2500);
  assert.equal(fixturePlanarRingArea([[0, 100], [100, 100], [50, 50]]), 2500);
  assert.equal(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.retraced.lines), 500);
  assert.equal(METRIC_TOPOLOGY_FIXTURES.retraced.expected.line_length_m, 400);
});

test('fixture-only: gaps, duplicate evidence and grade separation are explicit and not hidden oracle geometry', () => {
  near(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.gap30.lines), 370, 1e-10, '30 metre gap source length');
  near(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.gapPoint2.lines), 399.8, 1e-10, '0.20 metre gap source length');
  assert.equal(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.duplicate.lines), 500);
  assert.equal(METRIC_TOPOLOGY_FIXTURES.duplicate.expected.line_length_m, 400, 'source overlap must be counted once');
  assert.equal(fixturePlanarLineLength(METRIC_TOPOLOGY_FIXTURES.crossing.lines), 640);
  assert.deepEqual(METRIC_TOPOLOGY_FIXTURES.overpass.stipulated_travel_levels, { '5': 1, '6': 0 });
  assert.equal(METRIC_TOPOLOGY_FIXTURES.overpass.ramp_evidence, false);
  for (const fixture of Object.values(METRIC_TOPOLOGY_FIXTURES)) {
    assert.equal(new Set(fixture.lines.map(row => row.id)).size, fixture.lines.length);
    assert.ok(fixture.lines.every(row => !Object.hasOwn(row, 'polygon') && !Object.hasOwn(row, 'expected_geometry')));
  }
});

test('fixture-only: dense primitive intersections exceed safe noding work despite a small source capture', () => {
  const fixture = METRIC_TOPOLOGY_FIXTURES.denseCrossing;
  const horizontal = fixture.lines.filter(row => row.coordinates[0][1] === row.coordinates[1][1]);
  const vertical = fixture.lines.filter(row => row.coordinates[0][0] === row.coordinates[1][0]);
  assert.equal(horizontal.length, 64); assert.equal(vertical.length, 64);
  const properCrossings = horizontal.reduce((count, eastWest) => count + vertical.filter(northSouth =>
    northSouth.coordinates[0][0] > eastWest.coordinates[0][0]
      && northSouth.coordinates[0][0] < eastWest.coordinates[1][0]
      && eastWest.coordinates[0][1] > northSouth.coordinates[0][1]
      && eastWest.coordinates[0][1] < northSouth.coordinates[1][1]).length, 0);
  assert.equal(properCrossings, 4096);
  assert.equal(fixture.lines.length, fixture.expected.primitive_segments);
  assert.equal(fixture.lines.length + 4 * properCrossings, fixture.expected.split_piece_upper_bound);
  assert.ok(fixture.expected.split_piece_upper_bound > 8192);
  assert.equal(fixturePlanarLineLength(fixture.lines), fixture.expected.line_length_m);
  assert.ok(fixture.lines.every(row => row.coordinates.length === 2
    && row.coordinates.every(point => point.every(value => value >= 0 && value <= 100))));
});

test('fixture-only: projection output must be valid line coordinates inside the declared supported extent', async () => {
  const fake = geometry => ({ query: async (_sql, values) => ({ rows: JSON.parse(values[0])
    .map(({ id }) => ({ id, geometry: structuredClone(geometry) })) }) });
  const accepted = await projectMetricTopologyFixture(fake({ type: 'LineString',
    coordinates: [[-96.9, 32.6], [-96.89, 32.61]] }), 'square');
  assert.deepEqual(accepted.capture.query.envelope, [-98, 31, -96, 34]);
  assert.deepEqual(accepted.capture.source_inventory,
    [{ source_layer: 'fixture/roads', source_key: 'synthetic_linework' }]);
  for (const geometry of [
    { type: 'LineString', coordinates: [[-99, 32.6], [-96.89, 32.61]] },
    { type: 'LineString', coordinates: [[-96.9, 35], [-96.89, 32.61]] },
    { type: 'LineString', coordinates: [[-96.9, 32.6], [-95.4, 32.61]] },
    { type: 'LineString', coordinates: [[NaN, 32.6], [-96.89, 32.61]] },
    { type: 'LineString', coordinates: [] }, { type: 'LineString' },
    { type: 'LineString', coordinates: [[-96.9], [-96.89, 32.61]] },
    { type: 'Polygon', coordinates: [] }, null,
  ]) await assert.rejects(projectMetricTopologyFixture(fake(geometry), 'square'),
    /topology_fixture_projection_outside_extent/);
});

test('PostGIS topology: independent source linework, real noding, exact enclosure and fail-closed limits', {
  skip: !process.env.DATABASE_URL, timeout: 360000,
}, async t => {
  // Accepted guard must create and prepare a unique ephemeral CI child before
  // importing pg or opening any direct test connection. No local/shared fallback,
  // DROP, production source tables, or provider calls are permitted here.
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg');
  const { createNeighborhoodPostgisTopology } = await import('../src/services/neighborhoodAssessment/postgisTopology.js');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'neighborhood_topology_integration' });
  const build = async (name, options) => createNeighborhoodPostgisTopology(pool, options).build(await projectMetricTopologyFixture(pool, name));
  const assertReady = (result, name) => {
    const expected = METRIC_TOPOLOGY_FIXTURES[name].expected;
    assert.equal(result.status, 'ready', JSON.stringify(result.incomplete_reasons));
    assert.equal(result.topology_validated, true);
    assert.equal(result.cells.length, expected.cells);
    assert.ok(result.topology_revision);
    assert.ok(result.engine_versions);
    const areas = result.cells.map(cell => cell.area_m2).sort((a, b) => a - b);
    expected.areas_m2.forEach((area, index) => near(areas[index], area, TOPOLOGY_AREA_TOLERANCE_M2, `${name} face${index}`));
    if (expected.nodes !== undefined) assert.equal(result.nodes.length, expected.nodes, `${name} nodes`);
    if (expected.edges !== undefined) assert.equal(result.edges.length, expected.edges, `${name} edges`);
    if (expected.line_length_m !== undefined) near(result.edges.reduce((sum, edge) => sum + edge.length_meters, 0),
      expected.line_length_m, TOPOLOGY_LENGTH_TOLERANCE_M, `${name} dissolved source length`);
    for (const cell of result.cells) {
      assert.equal(cell.geometry_validated, true); assert.equal(cell.geometry.type, 'Polygon');
      assert.ok(cell.geometry_ewkb); assert.ok(cell.boundary_edge_ids.length);
      assert.ok(cell.geometry.coordinates[0].every(([longitude, latitude]) => longitude > -98 && longitude < -95 && latitude > 31 && latitude < 34),
        'API GeoJSON is4326, not raw metre offsets or metric coordinates');
    }
  };
  const auditMetric = async (result, expectedArea) => {
    const ewkb = result.cells.map(cell => cell.geometry_ewkb);
    const { rows: [row] } = await pool.query(`/* topology-fixture:audit-output */
      WITH cells AS (SELECT ST_GeomFromEWKB(decode(value,'hex')) AS geom FROM jsonb_array_elements_text($1::jsonb))
      SELECT count(*)::integer AS cells, bool_and(ST_IsValid(geom)) AS valid,
        min(ST_SRID(geom)) AS min_srid,max(ST_SRID(geom)) AS max_srid,
        sum(ST_Area(geom)) AS summed_area,ST_Area(ST_UnaryUnion(ST_Collect(geom))) AS union_area
      FROM cells`, [JSON.stringify(ewkb)]);
    assert.equal(row.cells, result.cells.length); assert.equal(row.valid, true);
    assert.equal(row.min_srid, 26914); assert.equal(row.max_srid, 26914);
    near(row.summed_area, expectedArea, TOPOLOGY_AREA_TOLERANCE_M2, 'summed faces');
    near(row.union_area, expectedArea, TOPOLOGY_AREA_TOLERANCE_M2, 'nonoverlapping union');
  };
  try {
    await t.test('four supplied square sides form exactly one10000m² face, four nodes and four edges', async () => {
      const result = await build('square'); assertReady(result, 'square');
      for (const row of [...result.cells, ...result.edges, ...result.nodes]) assert.equal(row.metric_srid, 26914);
      assert.equal(result.performed_policy.snap_tolerance_meters, 0);
      assert.equal(result.performed_policy.geometry_repair, 'none');
      await auditMetric(result, 10000);
    });
    await t.test('curved roads remain curved and derive the11500m² enclosure from line evidence only', async () => {
      const result = await build('curved'); assertReady(result, 'curved');
      await auditMetric(result, 11500);
      assert.ok(result.cells[0].geometry.coordinates[0].length > 5, 'not a fabricated rectangle');
    });
    await t.test('proper crossing nodes create four2500m² faces including real degree4 intersection', async () => {
      const result = await build('crossing'); assertReady(result, 'crossing');
      assert.equal(result.nodes.filter(node => node.degree === 4).length, 1);
      assert.equal(result.edges.filter(edge => edge.cell_ids.length === 0).length, 4, 'four supplied dangles are retained');
      await auditMetric(result, 10000);
    });
    await t.test('dense source crossings are refused by primitive admission before any native noding query', async () => {
      const input = await projectMetricTopologyFixture(pool, 'denseCrossing');
      const calls = [];
      const tracedPool = { async connect() {
        const client = await pool.connect();
        return { release: error => client.release(error), async query(config) {
          calls.push(config.text);
          return client.query(config);
        } };
      } };
      const result = await createNeighborhoodPostgisTopology(tracedPool).build(input);
      noPartial(result);
      assert.ok(result.incomplete_reasons.includes('pre_noding_limit_exceeded'));
      assert.equal(result.noding_admission.primitive_segments, 128);
      assert.equal(result.noding_admission.candidate_pairs, 4096);
      assert.equal(result.noding_admission.candidate_pairs_complete, true);
      assert.equal(result.noding_admission.split_pieces_upper_bound, 16512);
      assert.equal(result.noding_admission.admitted, false);
      assert.ok(calls.some(sql => sql.includes('neighborhood-topology:admission')),
        'bounded metric admission may query the isolated database');
      assert.ok(!calls.some(sql => sql.includes('neighborhood-topology:build')),
        'ST_Node/ST_Polygonize must never run for this rejected source capture');
      assert.equal(calls.at(-1), 'ROLLBACK');
    });
    await t.test('road renaming does not break a connected enclosure or join a disconnected namesake', async () => {
      const renamed = await build('renamed'); assertReady(renamed, 'renamed');
      const disconnected = await build('disconnected'); assertReady(disconnected, 'disconnected');
      near(disconnected.edges.filter(edge => edge.cell_ids.length === 0).reduce((sum, edge) => sum + edge.length_meters, 0),
        100, TOPOLOGY_LENGTH_TOLERANCE_M, 'disconnected named road');
      await auditMetric(disconnected, 10000);
    });
    await t.test('duplicate and partial-overlap lines dissolve once while preserving both independent source references', async () => {
      for (const name of ['duplicate', 'overlap']) {
        const result = await build(name); assertReady(result, name);
        const multiple = result.edges.filter(edge => new Set(edge.source_parts.map(part => part.feature_id)).size > 1);
        near(multiple.reduce((sum, edge) => sum + edge.length_meters, 0),
          METRIC_TOPOLOGY_FIXTURES[name].expected.shared_source_length_m, TOPOLOGY_LENGTH_TOLERANCE_M, `${name} shared provenance`);
        for (const edge of multiple) assert.ok(edge.source_parts.every(part => Number.isInteger(part.source_part_index)
          && part.start_fraction >= 0 && part.start_fraction <= 1 && part.end_fraction >= 0 && part.end_fraction <= 1
          && part.start_fraction !== part.end_fraction), 'source direction may reverse its start/end fractions');
        await auditMetric(result, 10000);
      }
    });
    await t.test('30m and0.20m gaps remain open; only a supplied documented boundary can close them', async () => {
      for (const name of ['gap30', 'gapPoint2']) {
        const result = await build(name); noPartial(result);
        assert.ok(result.incomplete_reasons.includes('no_closed_cells'));
      }
      const closed = await build('documentedClosure'); assertReady(closed, 'documentedClosure');
      const closureFeature = closed.source_features.find(feature => feature.source_object_id === '6');
      assert.ok(closureFeature);
      assert.ok(closed.edges.some(edge => edge.source_parts.some(part => part.feature_id === closureFeature.feature_id)),
        'the supplied closure must retain its separate source identity');
    });
    await t.test('point-contact cells are not assigned a positive shared boundary edge', async () => {
      const result = await build('corner'); assertReady(result, 'corner');
      assert.equal(result.edges.filter(edge => edge.cell_ids.length > 1).length, 0);
      await auditMetric(result, 20000);
    });
    await t.test('nested road rings produce a1600m² inner face and8400m² outer face with a hole', async () => {
      const result = await build('nested'); assertReady(result, 'nested');
      assert.equal(result.cells.filter(cell => cell.geometry.coordinates.length > 1).length, 1);
      await auditMetric(result, 10000);
    });
    await t.test('semantic geometry IDs survive source order and line direction changes', async () => {
      const input = await projectMetricTopologyFixture(pool, 'curved');
      const engine = createNeighborhoodPostgisTopology(pool);
      const original = await engine.build(input);
      const reversed = structuredClone(input); reversed.features.reverse();
      reversed.features.forEach(feature => feature.geometry.coordinates.reverse());
      const other = await engine.build(reversed); assertReady(other, 'curved');
      assert.deepEqual(sortedIds(other.cells), sortedIds(original.cells));
      assert.deepEqual(sortedIds(other.edges), sortedIds(original.edges));
      assert.deepEqual(sortedIds(other.nodes), sortedIds(original.nodes));
    });
    await t.test('closed, self-crossing and retraced sources retain occurrence-specific primitive segment provenance', async () => {
      for (const name of ['closedRing', 'bowtie', 'retraced']) {
        const input = await projectMetricTopologyFixture(pool, name);
        const result = await createNeighborhoodPostgisTopology(pool).build(input);
        assertReady(result, name);
        await auditMetric(result, METRIC_TOPOLOGY_FIXTURES[name].expected.union_area_m2);
        const originalSources = result.source_features.map(source => ({ feature_id: source.feature_id,
          geometry: input.features.find(feature => feature.source_object_id === source.source_object_id).geometry }));
        const references = result.edges.flatMap(edge => edge.source_parts.map(part => ({
          ...part, edge_ewkb: edge.geometry_ewkb,
        })));
        assert.ok(references.every(part => part.source_fraction_basis === 'source_segment'
          && Number.isInteger(part.source_segment_index) && part.source_segment_index > 0
          && part.start_fraction >= 0 && part.start_fraction <= 1 && part.end_fraction >= 0 && part.end_fraction <= 1));
        // This checks returned provenance against the independently supplied
        // source occurrence, not against a cell polygon from the implementation.
        // Distance tolerance is numeric measurement tolerance only; the fixture
        // does not move either line, snap a point, or repair any geometry.
        const { rows: [audit] } = await pool.query(`/* topology-fixture:audit-source-occurrences */
          WITH original AS (
            SELECT feature_id,ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(geometry),4326),26914) AS geom
            FROM jsonb_to_recordset($1::jsonb) AS item(feature_id text,geometry jsonb)
          ), segments AS (
            SELECT feature_id, d.path[1] AS source_segment_index,d.geom FROM original
            CROSS JOIN LATERAL ST_DumpSegments(original.geom) d
          ), refs AS (
            SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(feature_id text,source_part_index integer,
              source_segment_index integer,start_fraction double precision,end_fraction double precision,edge_ewkb text)
          ) SELECT count(*)::integer AS matched_references,
            max(ST_HausdorffDistance(ST_GeomFromEWKB(decode(refs.edge_ewkb,'hex')),
              ST_LineSubstring(segments.geom,least(refs.start_fraction,refs.end_fraction),
                greatest(refs.start_fraction,refs.end_fraction)))) AS maximum_distance
          FROM refs JOIN segments USING(feature_id,source_segment_index)`, [JSON.stringify(originalSources), JSON.stringify(references)]);
        assert.equal(audit.matched_references, references.length);
        near(audit.maximum_distance, 0, TOPOLOGY_LENGTH_TOLERANCE_M, `${name} primitive reconstruction`);
        if (name === 'retraced') {
          const repeated = result.edges.filter(edge => edge.source_parts.length > 1);
          near(repeated.reduce((sum, edge) => sum + edge.length_meters, 0), 100, TOPOLOGY_LENGTH_TOLERANCE_M, 'retraced source coverage');
          assert.ok(repeated.some(edge => {
            const segments = edge.source_parts.map(part => part.source_segment_index).sort((a, b) => a - b);
            return segments.includes(1) && segments.includes(5);
          }), 'both occurrences of the same source segment must survive');
        }
      }
    });
    await t.test('planar crossings do not grant cross-level travel or geographic inclusion authority', async () => {
      const result = await build('overpass'); assertReady(result, 'overpass');
      assert.equal(result.travel_connectivity, 'not_evaluated');
      assert.equal(Object.hasOwn(result, 'travel_edges'), false);
      assert.ok(result.edges.every(edge => !Object.hasOwn(edge, 'crossing_allowed')));
      assert.ok(result.cells.every(cell => !Object.hasOwn(cell, 'competitive_eligible') && !Object.hasOwn(cell, 'selection_score')));
    });
    await t.test('subsquare-metre slivers fail closed rather than being silently discarded or merged', async () => {
      const result = await build('sliver'); noPartial(result);
      assert.ok(result.incomplete_reasons.includes('sliver_cells'));
    });
    await t.test('invalid source geometry, nonzero snap and caller-raised limits cannot issue topology SQL', async () => {
      const input = await projectMetricTopologyFixture(pool, 'square');
      let connects = 0;
      const deniedPool = { connect() { connects++; throw new Error('unexpected fixture database use'); } };
      const engine = createNeighborhoodPostgisTopology(deniedPool);
      const snap = structuredClone(input); snap.policy.snap_tolerance_meters = 0.05;
      const snapResult = await engine.build(snap); noPartial(snapResult);
      assert.ok(snapResult.incomplete_reasons.includes('unsupported_projection_policy'));
      const invalid = structuredClone(input); invalid.features[0].geometry.coordinates[0] = [500, 500];
      const invalidResult = await engine.build(invalid); noPartial(invalidResult);
      assert.ok(invalidResult.incomplete_reasons.includes('source_preparation_incomplete'));
      assert.throws(() => createNeighborhoodPostgisTopology(deniedPool, { limits: { cells: 1025 } }));
      assert.equal(connects, 0);
    });
    await t.test('input, cell and output budgets never emit a partial graph', async () => {
      for (const [name, limits, expected] of [
        ['square', { input_parts: 1 }, 'input_limit_exceeded'],
        ['crossing', { cells: 1 }, 'topology_limit_exceeded'],
        ['square', { output_bytes: 1 }, 'topology_limit_exceeded'],
      ]) {
        const result = await build(name, { limits }); noPartial(result);
        assert.ok(result.incomplete_reasons.includes(expected), JSON.stringify(result.incomplete_reasons));
      }
    });
  } finally { await pool.end(); }
});
