import { createHash } from 'node:crypto';
import { GRAPH_PREPARATION_VERSION } from '../../src/services/neighborhoodAssessment/graphPreparation.js';

// The shared geometry reference has an arbitrary Cartesian origin, NOT an EPSG
// code. These independent fixtures explicitly place their metre offsets here.
// Only source lines are projected for engine input; no expected cell polygon is
// ever supplied to the engine. EPSG round-trip tolerance applies to measurements,
// never to repairing, snapping or filling source geometry.
export const TOPOLOGY_FIXTURE_ORIGIN = Object.freeze({ srid: 26914, easting: 700000, northing: 3600000 });
export const TOPOLOGY_AREA_TOLERANCE_M2 = 0.001;
export const TOPOLOGY_LENGTH_TOLERANCE_M = 0.00001;
const RUN = '70000000-0000-4000-8000-000000000001';
const OBSERVED_AT = '2026-09-05T00:00:00.000Z';
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const line = (id, name, coordinates, extras = {}) => ({ id, name, coordinates, ...extras });
const box = (x, y, size = 100, prefix = 0) => [
  line(String(prefix + 1), 'South Reference Road', [[x, y], [x + size, y]]),
  line(String(prefix + 2), 'East Reference Road', [[x + size, y], [x + size, y + size]]),
  line(String(prefix + 3), 'North Reference Road', [[x + size, y + size], [x, y + size]]),
  line(String(prefix + 4), 'West Reference Road', [[x, y + size], [x, y]]),
];
const square = box(0, 0);
const gapped = gap => [square[0],
  line('2', 'East Reference Road', [[100, 0], [100, 50 - gap / 2]]),
  line('5', 'East Reference Road', [[100, 50 + gap / 2], [100, 100]]), square[2], square[3]];
const crossed = [...square,
  // Endpoints intentionally extend beyond the enclosure. A 4326 round-trip must
  // not turn nanometre endpoint error into an accidental incidence assertion.
  line('5', 'East West Crossing', [[-10, 50], [110, 50]]),
  line('6', 'North South Crossing', [[50, -10], [50, 110]])];
// Only128 source primitives, but every horizontal crosses every vertical:
//64×64=4096 proper intersections. This fixture must be admitted/rejected from
//bounded primitive work before ST_Node, never used as a native memory stress.
const denseCrossing = Array.from({ length: 64 }, (_, index) => {
  const offset = (index + 1) * 100 / 65;
  return [line(String(index + 1), `Horizontal Grid Road ${index + 1}`, [[0, offset], [100, offset]]),
    line(String(index + 65), `Vertical Grid Road ${index + 1}`, [[offset, 0], [offset, 100]])];
}).flat();

export const METRIC_TOPOLOGY_FIXTURES = freeze({
  square: { lines: square, expected: { cells: 1, nodes: 4, edges: 4, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400 } },
  closedRing: { lines: [line('1', 'Closed Loop Road', [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]])],
    expected: { cells: 1, nodes: 4, edges: 4, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400 } },
  bowtie: { lines: [line('1', 'Self Crossing Source Road', [[0, 0], [100, 100], [0, 100], [100, 0], [0, 0]])],
    expected: { cells: 2, nodes: 5, edges: 6, areas_m2: [2500, 2500], union_area_m2: 5000, line_length_m: 200 + 200 * Math.sqrt(2) } },
  retraced: { lines: [line('1', 'Repeated Segment Source Road', [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0], [100, 0]])],
    expected: { cells: 1, nodes: 4, edges: 4, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400,
      repeated_segment_length_m: 100 } },
  curved: { lines: [square[0], line('2', 'Curved East Road', [[100, 0], [120, 25], [120, 75], [100, 100]]), square[2], square[3]],
    expected: { cells: 1, areas_m2: [11500], union_area_m2: 11500, line_length_m: 350 + 2 * Math.sqrt(1025) } },
  crossing: { lines: crossed, expected: { cells: 4, nodes: 13, edges: 16,
    areas_m2: [2500, 2500, 2500, 2500], union_area_m2: 10000, line_length_m: 640 } },
  denseCrossing: { lines: denseCrossing, expected: { primitive_segments: 128,
    candidate_crossings: 4096, split_piece_upper_bound: 16512, line_length_m: 12800 } },
  renamed: { lines: [square[0], square[1], line('3', 'Old North Road', [[100, 100], [50, 100]]),
    line('5', 'New North Road', [[50, 100], [0, 100]]), square[3]],
    expected: { cells: 1, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400 } },
  disconnected: { lines: [...square, line('5', 'North Reference Road', [[0, 110], [100, 110]])],
    expected: { cells: 1, areas_m2: [10000], union_area_m2: 10000, line_length_m: 500, unused_line_length_m: 100 } },
  nearParallel: { lines: [...square, line('5', 'Separate Parallel North Observation', [[100, 100.01], [0, 100.01]])],
    expected: { cells: 1, nodes: 6, edges: 5, areas_m2: [10000], union_area_m2: 10000,
      line_length_m: 500, unused_line_length_m: 100, parallel_separation_m: 0.01 } },
  disconnectedPockets: { lines: [...square, ...box(200, 0, 100, 10)],
    expected: { cells: 2, nodes: 8, edges: 8, components: 2, areas_m2: [10000, 10000],
      union_area_m2: 20000, line_length_m: 800, separation_m: 100 } },
  duplicate: { lines: [...square, line('5', 'Independent North Observation', [[100, 100], [0, 100]])],
    expected: { cells: 1, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400, shared_source_length_m: 100 } },
  overlap: { lines: [square[0], square[1],
    line('3', 'North Reference Road', [[100, 100], [75, 100], [25, 100], [0, 100]]), square[3],
    line('5', 'North Overlap Observation', [[25, 100], [75, 100]])],
    expected: { cells: 1, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400, shared_source_length_m: 50 } },
  gap30: { lines: gapped(30), expected: { cells: 0, gap_m: 30, line_length_m: 370 } },
  gapPoint2: { lines: gapped(0.2), expected: { cells: 0, gap_m: 0.2, line_length_m: 399.8 } },
  // Accepted graphPreparation currently admits road/rail classes only. A later
  // mixed creek/plat boundary requires its own explicit source-kind contract;
  // do not relabel that source as a road just to make this fixture succeed.
  documentedClosure: { lines: [...gapped(30), line('6', 'Separately Supplied East Road Segment', [[100, 35], [100, 65]])],
    expected: { cells: 1, areas_m2: [10000], union_area_m2: 10000, line_length_m: 400 } },
  corner: { lines: [...square, ...box(100, 100, 100, 10)],
    expected: { cells: 2, areas_m2: [10000, 10000], union_area_m2: 20000, shared_cell_edges: 0 } },
  nested: { lines: [...square, ...box(30, 30, 40, 10)],
    expected: { cells: 2, areas_m2: [1600, 8400], union_area_m2: 10000, faces_with_holes: 1 } },
  sliver: { lines: [...square, line('5', 'Narrow Sliver Edge', [[0.005, -10], [0.005, 110]])],
    expected: { cells_before_sliver_policy: 2, areas_m2: [0.5, 9999.5], union_area_m2: 10000 } },
  overpass: { lines: crossed.map(row => ({ ...row })),
    stipulated_travel_levels: { '5': 1, '6': 0 }, ramp_evidence: false,
    expected: { cells: 4, areas_m2: [2500, 2500, 2500, 2500], union_area_m2: 10000,
      travel_connectivity: 'not_evaluated', allowed_cross_level_transfer: false } },
});

export function metricTopologyLineWkt(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) throw new TypeError('invalid_topology_fixture_line');
  return `LINESTRING (${coordinates.map(point => {
    if (!Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value) || Math.abs(value) > 2000)) {
      throw new TypeError('invalid_topology_fixture_coordinate');
    }
    return `${TOPOLOGY_FIXTURE_ORIGIN.easting + point[0]} ${TOPOLOGY_FIXTURE_ORIGIN.northing + point[1]}`;
  }).join(', ')})`;
}

export function fixturePlanarLineLength(lines) {
  return lines.reduce((sum, row) => sum + row.coordinates.slice(1).reduce((length, point, index) =>
    length + Math.hypot(point[0] - row.coordinates[index][0], point[1] - row.coordinates[index][1]), 0), 0);
}

export function fixturePlanarRingArea(ring) {
  return Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

/** Fixture-only projection into the engine's declared RFC7946 input CRS. Caller
 * supplies a client connected to the accepted isolated CI child database. */
export async function projectMetricTopologyFixture(client, fixtureName) {
  const fixture = METRIC_TOPOLOGY_FIXTURES[fixtureName];
  if (!fixture) throw new TypeError('unknown_topology_fixture');
  const records = fixture.lines.map(row => ({ id: row.id, wkt: metricTopologyLineWkt(row.coordinates) }));
  const { rows } = await client.query(`/* topology-fixture:project-lines */
    SELECT item.id, ST_AsGeoJSON(ST_Transform(ST_GeomFromText(item.wkt,26914),4326),15)::jsonb AS geometry
    FROM jsonb_to_recordset($1::jsonb) AS item(id text,wkt text) ORDER BY item.id COLLATE "C"`, [JSON.stringify(records)]);
  if (rows.length !== records.length || new Set(rows.map(row => row.id)).size !== records.length) throw new Error('topology_fixture_projection_incomplete');
  const geometry = new Map(rows.map(row => [row.id, row.geometry]));
  // This is a synthetic query extent, not the independent enclosure oracle.
  // Keep it inside the service's declared projection support and verify all
  // projected input vertices are covered; no implicit clipping is permitted.
  const envelope = [-98, 31, -96, 34];
  if (rows.some(row => row.geometry?.type !== 'LineString' || !Array.isArray(row.geometry.coordinates)
    || row.geometry.coordinates.length < 2 || row.geometry.coordinates.some(point =>
      !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value))
      || point[0] < envelope[0] || point[1] < envelope[1] || point[0] > envelope[2] || point[1] > envelope[3]))) {
    throw new Error('topology_fixture_projection_outside_extent');
  }
  const layers = [...new Set(fixture.lines.map(row => row.layer || 'fixture/roads'))].sort();
  return {
    version: GRAPH_PREPARATION_VERSION,
    capture: { id: `synthetic-topology-${fixtureName}`, revision: '1', acquired_at: OBSERVED_AT,
      coverage: 'complete', expected_feature_count: records.length,
      query: { crs: 'EPSG:4326', envelope, layers },
      source_inventory: layers.map(source_layer => ({ source_layer, source_key: 'synthetic_linework' })),
      source_states: [{ source_key: 'synthetic_linework', status: 'current', last_run_id: RUN }],
      origin_runs: [{ id: RUN, source_key: 'synthetic_linework', mode: 'full', status: 'complete' }] },
    aliases: { revision: 'synthetic-aliases-1', coverage: 'complete', records: [] },
    policy: { version: 'synthetic-planar-1', metric_srid: 26914, snap_tolerance_meters: 0 },
    features: fixture.lines.map(row => ({ source_key: 'synthetic_linework', source_layer: row.layer || 'fixture/roads',
      source_object_id: row.id, source_record_hash: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      sync_run_id: RUN, source_vintage: 'synthetic-metric-fixture-v1', name: row.name,
      base_name: row.name, road_class: 'primary',
      repair_revision: 'synthetic-no-repair-1', original_geometry_sha256: null,
      geometry: geometry.get(row.id) })),
  };
}
