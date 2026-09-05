import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { METRIC_TOPOLOGY_FIXTURES, TOPOLOGY_FIXTURE_ORIGIN, TOPOLOGY_AREA_TOLERANCE_M2,
  TOPOLOGY_LENGTH_TOLERANCE_M, metricTopologyLineWkt, fixturePlanarLineLength,
  fixturePlanarRingArea, projectMetricTopologyFixture } from './fixtures/neighborhoodPostgisTopologyFixture.js';

const near = (actual, expected, tolerance, label) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
const sortedIds = rows => rows.map(row => row.id).sort();
const sourceFeatureId = feature => assessmentEvidenceDigest({ source_key: feature.source_key,
  source_layer: feature.source_layer, source_object_id: feature.source_object_id });
const originalSourceParts = input => input.features.flatMap(feature => {
  assert.ok(['LineString', 'MultiLineString'].includes(feature.geometry.type));
  const parts = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return parts.map((coordinates, index) => ({ feature_id: sourceFeatureId(feature), source_part_index: index + 1,
    geometry: { type: 'LineString', coordinates } }));
});
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

test('fixture-only: one-centimetre parallel evidence and disconnected closed pockets are independent linework', () => {
  const parallel = METRIC_TOPOLOGY_FIXTURES.nearParallel;
  const north = parallel.lines.find(row => row.id === '3');
  const separate = parallel.lines.find(row => row.id === '5');
  assert.deepEqual(separate.coordinates.map(point => point[0]), north.coordinates.map(point => point[0]));
  separate.coordinates.forEach((point, index) => near(point[1] - north.coordinates[index][1],
    parallel.expected.parallel_separation_m, 1e-12, 'explicit Cartesian parallel separation'));
  assert.equal(fixturePlanarLineLength(parallel.lines), 500);
  const pockets = METRIC_TOPOLOGY_FIXTURES.disconnectedPockets;
  const first = pockets.lines.slice(0, 4); const second = pockets.lines.slice(4);
  assert.equal(first.length, 4); assert.equal(second.length, 4);
  assert.equal(Math.min(...second.flatMap(row => row.coordinates.map(point => point[0])))
    - Math.max(...first.flatMap(row => row.coordinates.map(point => point[0]))), pockets.expected.separation_m);
  assert.equal(fixturePlanarRingArea(first.map(row => row.coordinates[0])), 10000);
  assert.equal(fixturePlanarRingArea(second.map(row => row.coordinates[0])), 10000);
  assert.equal(fixturePlanarLineLength(pockets.lines), 800);
});

test('fixture-only: source interval audit identities come from original feature and part occurrence', () => {
  const feature = { source_key: 'synthetic_linework', source_layer: 'fixture/roads', source_object_id: '1',
    geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]], [[1, 0], [0, 0]]] } };
  const parts = originalSourceParts({ features: [feature] });
  assert.deepEqual(parts.map(part => part.source_part_index), [1, 2]);
  assert.ok(parts.every(part => part.feature_id === sourceFeatureId(feature)));
  assert.equal(parts[0].geometry.coordinates, feature.geometry.coordinates[0]);
  assert.equal(parts[1].geometry.coordinates, feature.geometry.coordinates[1]);
  assert.notEqual(sourceFeatureId({ ...feature, source_layer: 'fixture/other-layer' }), sourceFeatureId(feature));
  assert.notEqual(sourceFeatureId({ ...feature, source_key: 'other_capture' }), sourceFeatureId(feature));
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
  const auditSourceIntervals = async (input, result) => {
    // Derive identities and primitives from the supplied capture, not from the
    // returned source descriptors, cells, nearest roads, or repaired geometry.
    const original = originalSourceParts(input);
    const edges = result.edges.map(edge => ({ edge_id: edge.id, edge_ewkb: edge.geometry_ewkb }));
    const refs = result.edges.flatMap(edge => {
      assert.ok(edge.source_parts.length > 0, 'every ready edge must retain source occurrence evidence');
      return edge.source_parts.map(part => ({ ...part, edge_id: edge.id }));
    });
    const occurrenceKey = ref => JSON.stringify([ref.edge_id, ref.feature_id,
      ref.source_part_index, ref.source_segment_index]);
    assert.equal(new Set(refs.map(occurrenceKey)).size, refs.length, 'source occurrences cannot be duplicated');
    for (const ref of refs) {
      assert.equal(ref.source_fraction_basis, 'source_segment');
      assert.ok(Number.isInteger(ref.source_part_index) && ref.source_part_index > 0);
      assert.ok(Number.isInteger(ref.source_segment_index) && ref.source_segment_index > 0);
      assert.ok(Number.isFinite(ref.start_fraction) && ref.start_fraction >= 0 && ref.start_fraction <= 1);
      assert.ok(Number.isFinite(ref.end_fraction) && ref.end_fraction >= 0 && ref.end_fraction <= 1);
      assert.notEqual(ref.start_fraction, ref.end_fraction);
    }
    const { rows: [audit] } = await pool.query(`/* topology-fixture:audit-exact-source-intervals */
      WITH original AS (
        SELECT feature_id,source_part_index,
          ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(geometry),4326),26914) AS geom
        FROM jsonb_to_recordset($1::jsonb) AS item(feature_id text,source_part_index integer,geometry jsonb)
      ), segments AS (
        SELECT feature_id,source_part_index,d.path[1] AS source_segment_index,d.geom
        FROM original CROSS JOIN LATERAL ST_DumpSegments(original.geom) d
        WHERE ST_Length(d.geom)>0
      ), edges AS (
        SELECT edge_id,ST_GeomFromEWKB(decode(edge_ewkb,'hex')) AS geom
        FROM jsonb_to_recordset($2::jsonb) AS item(edge_id text,edge_ewkb text)
      ), refs AS (
        SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(edge_id text,feature_id text,
          source_part_index integer,source_segment_index integer,start_fraction double precision,end_fraction double precision)
      ), reconstructed AS (
        SELECT edges.geom AS edge_geom,segments.geom AS primitive_geom,refs.start_fraction,refs.end_fraction,
          ST_LineSubstring(segments.geom,least(refs.start_fraction,refs.end_fraction),
            greatest(refs.start_fraction,refs.end_fraction)) AS interval_geom
        FROM refs JOIN edges USING(edge_id)
        JOIN segments USING(feature_id,source_part_index,source_segment_index)
      ), all_original_candidates AS (
        -- These small synthetic fixtures permit an independent all-pairs audit:
        -- no implementation bounding-box join or nearest-source selection can
        -- hide an omitted duplicate/retraced original primitive occurrence.
        SELECT edges.edge_id,segments.feature_id,segments.source_part_index,segments.source_segment_index,
          edges.geom AS edge_geom,segments.geom AS primitive_geom,
          ST_LineLocatePoint(segments.geom,ST_StartPoint(edges.geom)) AS start_fraction,
          ST_LineLocatePoint(segments.geom,ST_EndPoint(edges.geom)) AS end_fraction
        FROM edges CROSS JOIN segments
      ), exact_occurrences AS (
        SELECT edge_id,feature_id,source_part_index,source_segment_index
        FROM all_original_candidates
        WHERE start_fraction<>end_fraction
          AND ST_Equals(edge_geom,ST_LineSubstring(primitive_geom,least(start_fraction,end_fraction),greatest(start_fraction,end_fraction)))
          AND ST_AsEWKB(ST_Normalize(edge_geom),'NDR')=ST_AsEWKB(ST_Normalize(ST_LineSubstring(primitive_geom,
            least(start_fraction,end_fraction),greatest(start_fraction,end_fraction))),'NDR')
      ), missing AS (
        SELECT * FROM exact_occurrences EXCEPT SELECT edge_id,feature_id,source_part_index,source_segment_index FROM refs
      ), unexpected AS (
        SELECT edge_id,feature_id,source_part_index,source_segment_index FROM refs EXCEPT SELECT * FROM exact_occurrences
      ) SELECT count(*)::integer AS matched_references,
        bool_and(ST_Equals(edge_geom,interval_geom)) AS exact_intervals,
        bool_and(ST_AsEWKB(ST_Normalize(edge_geom),'NDR')=ST_AsEWKB(ST_Normalize(interval_geom),'NDR')) AS exact_interval_bytes,
        bool_and(start_fraction=ST_LineLocatePoint(primitive_geom,ST_StartPoint(edge_geom))
          AND end_fraction=ST_LineLocatePoint(primitive_geom,ST_EndPoint(edge_geom))) AS exact_endpoint_fractions,
        (SELECT count(*)::integer FROM missing) AS missing_occurrences,
        (SELECT count(*)::integer FROM unexpected) AS unexpected_occurrences
      FROM reconstructed`, [JSON.stringify(original), JSON.stringify(edges), JSON.stringify(refs)]);
    assert.equal(audit.matched_references, refs.length, 'every reference resolves to the exact original feature/part/primitive');
    assert.equal(audit.exact_intervals, true, 'all source intervals must satisfy exact ST_Equals, without distance tolerance');
    assert.equal(audit.exact_interval_bytes, true, 'normalized NDR EWKB must match byte for byte');
    assert.equal(audit.exact_endpoint_fractions, true, 'reported fractions locate the actual edge endpoints on its original primitive');
    assert.equal(audit.missing_occurrences, 0, 'all exact matching source occurrences must be retained');
    assert.equal(audit.unexpected_occurrences, 0, 'nearby or otherwise nonidentical sources must never be attributed');
    assert.equal(result.diagnostics.uncovered_source_segment_count, 0, 'no original positive-length primitive may be partly lost');
    assert.equal(result.diagnostics.ambiguous_source_edge_count, 0,
      'coincident reconstructed intervals cannot establish support between distinct non-collinear originals');
  };
  const buildInput = async (input, options) => {
    const original = structuredClone(input);
    const result = await createNeighborhoodPostgisTopology(pool, options).build(input);
    assert.deepEqual(input, original, 'topology must not mutate the captured source evidence');
    if (result.status === 'ready') await auditSourceIntervals(original, result);
    return result;
  };
  const build = async (name, options) => buildInput(await projectMetricTopologyFixture(pool, name), options);
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
    await t.test('precision oracle: two exact interval witnesses on distinct non-collinear originals require ambiguity rejection', async () => {
      // This deliberately stays in native projected coordinates: converting this
      // one-ULP separation through4326 could change the stated raw-SQL oracle.
      // It is a predicate-level counterexample, NOT a full-service false-ready
      // reproduction. The service's diagnostic-to-incomplete path is separately
      // covered by its mocked tests; ordinary duplicate/overlap builds below
      // must still be ready with zero ambiguous source edges.
      const { rows: [audit] } = await pool.query(`/* topology-fixture:audit-sub-ulp-source-ambiguity */
        WITH originals AS (
          SELECT 1 AS source_id,ST_GeomFromText('LINESTRING(700000 3600000,700100 3600100)',26914) AS geom
          UNION ALL
          SELECT 2,ST_SetSRID(ST_MakeLine(ST_MakePoint(700000,3600000),
            ST_MakePoint(700100,3600100::double precision+4.656612873077393e-10::double precision)),26914)
        ), edge AS (
          SELECT ST_LineSubstring(geom,0,0.25) AS geom FROM originals WHERE source_id=1
        ), located AS (
          SELECT originals.source_id,originals.geom AS source_geom,edge.geom AS edge_geom,
            ST_LineLocatePoint(originals.geom,ST_StartPoint(edge.geom)) AS start_fraction,
            ST_LineLocatePoint(originals.geom,ST_EndPoint(edge.geom)) AS end_fraction
          FROM originals CROSS JOIN edge
        ), intervals AS (
          SELECT *,ST_LineSubstring(source_geom,least(start_fraction,end_fraction),
            greatest(start_fraction,end_fraction)) AS interval_geom FROM located
        ), witnesses AS (
          SELECT * FROM intervals WHERE start_fraction<>end_fraction
            AND ST_AsEWKB(ST_Normalize(edge_geom),'NDR')=ST_AsEWKB(ST_Normalize(interval_geom),'NDR')
        ), incompatible_witness_pairs AS (
          SELECT a.source_id AS first_source_id,b.source_id AS second_source_id
          FROM witnesses a JOIN witnesses b ON a.source_id<b.source_id
          WHERE NOT ST_Relate(a.source_geom,b.source_geom,'1********')
        ) SELECT count(*)::integer AS witness_count,
          bool_and(ST_Equals(edge_geom,interval_geom)) AS exact_intervals,
          bool_and(ST_AsEWKB(ST_Normalize(edge_geom),'NDR')=ST_AsEWKB(ST_Normalize(interval_geom),'NDR')) AS exact_interval_bytes,
          (SELECT ST_AsEWKB(ST_Normalize(a.geom),'NDR')<>ST_AsEWKB(ST_Normalize(b.geom),'NDR')
            FROM originals a JOIN originals b ON a.source_id=1 AND b.source_id=2) AS original_bytes_distinct,
          (SELECT ST_Equals(a.geom,b.geom) FROM originals a JOIN originals b ON a.source_id=1 AND b.source_id=2) AS originals_equal,
          (SELECT ST_Relate(a.geom,b.geom,'1********') FROM originals a JOIN originals b
            ON a.source_id=1 AND b.source_id=2) AS original_positive_interior_support,
          (SELECT ST_CoveredBy(edge.geom,originals.geom) FROM edge JOIN originals ON originals.source_id=2) AS edge_covered_by_second_original,
          (SELECT count(*)::integer FROM incompatible_witness_pairs) AS ambiguous_pair_count,
          EXISTS(SELECT 1 FROM incompatible_witness_pairs) AS ambiguity_guard_rejects
        FROM witnesses`);
      assert.equal(audit.original_bytes_distinct, true);
      assert.equal(audit.originals_equal, false);
      assert.equal(audit.original_positive_interior_support, false);
      assert.equal(audit.edge_covered_by_second_original, false);
      assert.equal(audit.witness_count, 2, 'exact interval bytes alone are insufficient source authority');
      assert.equal(audit.exact_intervals, true);
      assert.equal(audit.exact_interval_bytes, true);
      assert.equal(audit.ambiguous_pair_count, 1);
      assert.equal(audit.ambiguity_guard_rejects, true, 'every pair of matched original primitives must have exact positive-length interior support');
    });
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
    await t.test('a source road only one centimetre away cannot acquire boundary attribution from the north road', async () => {
      const input = await projectMetricTopologyFixture(pool, 'nearParallel');
      const result = await buildInput(input); assertReady(result, 'nearParallel');
      const separateId = sourceFeatureId(input.features.find(feature => feature.source_object_id === '5'));
      const northId = sourceFeatureId(input.features.find(feature => feature.source_object_id === '3'));
      const separate = result.edges.filter(edge => edge.source_parts.some(ref => ref.feature_id === separateId));
      const north = result.edges.filter(edge => edge.source_parts.some(ref => ref.feature_id === northId));
      assert.equal(separate.length, 1); assert.equal(north.length, 1);
      assert.deepEqual(separate[0].cell_ids, []);
      assert.equal(separate[0].source_parts.length, 1, 'the near-parallel edge has only its own original evidence');
      assert.equal(north[0].cell_ids.length, 1);
      assert.ok(result.edges.filter(edge => edge.cell_ids.length > 0)
        .every(edge => edge.source_parts.every(ref => ref.feature_id !== separateId)));
      near(separate[0].length_meters, 100, TOPOLOGY_LENGTH_TOLERANCE_M, 'unused near-parallel source length');
      const { rows: [audit] } = await pool.query(`/* topology-fixture:audit-near-parallel */
        SELECT ST_Distance(ST_GeomFromEWKB(decode($1,'hex')),ST_GeomFromEWKB(decode($2,'hex'))) AS separation,
          ST_Equals(ST_GeomFromEWKB(decode($1,'hex')),ST_GeomFromEWKB(decode($2,'hex'))) AS identical`,
      [separate[0].geometry_ewkb, north[0].geometry_ewkb]);
      near(audit.separation, 0.01, TOPOLOGY_LENGTH_TOLERANCE_M, 'actual projected separation, not an attribution tolerance');
      assert.equal(audit.identical, false);
      await auditMetric(result, 10000);
    });
    await t.test('two fully disconnected closed pockets remain two separate components without an invented connector', async () => {
      const result = await build('disconnectedPockets'); assertReady(result, 'disconnectedPockets');
      assert.ok(result.edges.every(edge => edge.cell_ids.length === 1));
      assert.ok(result.nodes.every(node => node.degree === 2));
      const adjacency = new Map(result.nodes.map(node => [node.id, []]));
      for (const edge of result.edges) {
        adjacency.get(edge.from_node_id).push(edge.to_node_id);
        adjacency.get(edge.to_node_id).push(edge.from_node_id);
      }
      const visited = new Set(); const componentSizes = [];
      for (const node of result.nodes) if (!visited.has(node.id)) {
        const stack = [node.id]; let size = 0;
        while (stack.length) {
          const current = stack.pop();
          if (visited.has(current)) continue;
          visited.add(current); size++;
          stack.push(...adjacency.get(current).filter(id => !visited.has(id)));
        }
        componentSizes.push(size);
      }
      assert.deepEqual(componentSizes, [4, 4]);
      const { rows: [audit] } = await pool.query(`/* topology-fixture:audit-disconnected-pockets */
        SELECT ST_Disjoint(ST_GeomFromEWKB(decode($1,'hex')),ST_GeomFromEWKB(decode($2,'hex'))) AS disjoint,
          ST_Distance(ST_GeomFromEWKB(decode($1,'hex')),ST_GeomFromEWKB(decode($2,'hex'))) AS separation`,
      result.cells.map(cell => cell.geometry_ewkb));
      assert.equal(audit.disjoint, true);
      near(audit.separation, 100, TOPOLOGY_LENGTH_TOLERANCE_M, 'independent closed pocket separation');
      await auditMetric(result, 20000);
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
      const original = await buildInput(input); assertReady(original, 'curved');
      const reversed = structuredClone(input); reversed.features.reverse();
      reversed.features.forEach(feature => feature.geometry.coordinates.reverse());
      const other = await buildInput(reversed); assertReady(other, 'curved');
      assert.deepEqual(sortedIds(other.cells), sortedIds(original.cells));
      assert.deepEqual(sortedIds(other.edges), sortedIds(original.edges));
      assert.deepEqual(sortedIds(other.nodes), sortedIds(original.nodes));
      for (const key of ['cells', 'edges', 'nodes']) assert.deepEqual(
        other[key].map(row => ({ id: row.id, geometry_ewkb: row.geometry_ewkb })),
        original[key].map(row => ({ id: row.id, geometry_ewkb: row.geometry_ewkb })),
        `${key} metric geometry bytes must not change when source ordering/direction changes`);
    });
    await t.test('closed, self-crossing and retraced sources retain occurrence-specific primitive segment provenance', async () => {
      for (const name of ['closedRing', 'bowtie', 'retraced']) {
        const input = await projectMetricTopologyFixture(pool, name);
        const result = await buildInput(input);
        assertReady(result, name);
        await auditMetric(result, METRIC_TOPOLOGY_FIXTURES[name].expected.union_area_m2);
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
