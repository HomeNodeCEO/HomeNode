import { createHash } from 'node:crypto';
import { canonicalAssessmentJson, assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCachedSourceCaptures } from '../../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { GRAPH_PREPARATION_VERSION, prepareNeighborhoodLinework } from '../../src/services/neighborhoodAssessment/graphPreparation.js';
import { neighborhoodTopologyRevision, POSTGIS_TOPOLOGY_VERSION, POSTGIS_TOPOLOGY_LIMITS } from '../../src/services/neighborhoodAssessment/postgisTopology.js';

// Synthetic local fixtures only. No reader, provider, PostgreSQL or projection
// call occurs here. Native tests must supply their separately produced topology
// and actual projected subject EWKB; mock topology is never a native oracle.
export const SELECTED_BOUNDARY_FIXTURE_SCOPE = Object.freeze({
  organization_id: '71000000-0000-4000-8000-000000000001',
  appraisal_case_id: '71000000-0000-4000-8000-000000000002',
  subject_snapshot_id: '71000000-0000-4000-8000-000000000003',
  account_id: 'synthetic-selected-subject',
});
export const SELECTED_BOUNDARY_FIXTURE_EFFECTIVE_DATE = '2026-09-05';
export const SELECTED_BOUNDARY_FIXTURE_KNOWLEDGE_CUTOFF = '2026-09-05T12:00:00.000Z';
export const SELECTED_BOUNDARY_FIXTURE_CAPTURED_AT = '2026-09-05T00:00:00.000Z';
export const SELECTED_BOUNDARY_FIXTURE_READER_VERSION = 'gis-cache-query-v1';
export const SELECTED_BOUNDARY_FIXTURE_RECORD_IDS = Object.freeze(['2', '10']);
const PARCEL_KEY = 'dcad_parcels', CAPTURE_ID = 'gis-query:dcad_parcels';
const SERVICE_URL = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query';
const RUN = '71000000-0000-4000-8000-000000000004';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const invalid = field => { throw new TypeError(`invalid_selected_boundary_fixture:${field}`); };

function uint(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) invalid('uint');
  const result = Buffer.alloc(4); result.writeUInt32LE(value); return result;
}
function pointBytes(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) invalid('point');
  const result = Buffer.alloc(16); result.writeDoubleLE(value[0], 0); result.writeDoubleLE(value[1], 8); return result;
}
function ewkb(geometry, srid) {
  const types = { Point: 1, LineString: 2, Polygon: 3, MultiPolygon: 6 };
  const type = types[geometry?.type];
  if (!type) invalid('geometry_type');
  const head = [Buffer.from([1]), uint(type + (srid === null ? 0 : 0x20000000)), ...(srid === null ? [] : [uint(srid)])];
  if (type === 1) return Buffer.concat([...head, pointBytes(geometry.coordinates)]);
  if (!Array.isArray(geometry.coordinates)) invalid('coordinates');
  if (type === 2) return Buffer.concat([...head, uint(geometry.coordinates.length), ...geometry.coordinates.map(pointBytes)]);
  if (type === 3) return Buffer.concat([...head, uint(geometry.coordinates.length), ...geometry.coordinates.flatMap(ring => {
    if (!Array.isArray(ring)) invalid('ring');
    return [uint(ring.length), ...ring.map(pointBytes)];
  })]);
  return Buffer.concat([...head, uint(geometry.coordinates.length), ...geometry.coordinates.map(coordinates => ewkb({ type: 'Polygon', coordinates }, null))]);
}

/** Writes explicit two-dimensional NDR EWKB, without geometric validation,
 * orientation changes, automatic ring closure or coordinate transformation. */
export function geometryEwkbHex(geometry, { srid = 4326 } = {}) { return ewkb(geometry, srid).toString('hex'); }
export function polygonEwkbHex(rings, options) { return geometryEwkbHex({ type: 'Polygon', coordinates: rings }, options); }
export function multiPolygonEwkbHex(polygons, options) { return geometryEwkbHex({ type: 'MultiPolygon', coordinates: polygons }, options); }
export function geometryEwkbBytes(geometry, options) { return Buffer.from(geometryEwkbHex(geometry, options), 'hex'); }

const rectangle = (x, y, width, height = width) => [[x, y], [x, y + height], [x + width, y + height], [x + width, y], [x, y]];
const defaultSubjects = () => [
  { type: 'Polygon', coordinates: [rectangle(-96.8999, 32.6001, 0.0001)] },
  { type: 'Polygon', coordinates: [rectangle(-96.8994, 32.6001, 0.0001)] },
];

function parcelRecord({ recordId, accountId, geometry: suppliedGeometry, attributes: suppliedAttributes = {} }, capturedAt) {
  if (typeof recordId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(recordId)) invalid('record_id');
  if (typeof accountId !== 'string' || !accountId || accountId !== accountId.trim()) invalid('account_id');
  const ewkbHex = typeof suppliedGeometry === 'string' ? suppliedGeometry : geometryEwkbHex(suppliedGeometry);
  if (!/^(?:[0-9a-f]{2})+$/.test(ewkbHex)) invalid('ewkb_hex');
  const feature = { source_key: PARCEL_KEY, dataset: 'gis.dcad_parcels', provider: 'dcad',
    configured_service_url: SERVICE_URL, configured_service_layer: null,
    acquisition_endpoint_history: 'unavailable_in_legacy_run_ledger', object_id: recordId };
  const attributes = Object.fromEntries(['low_parcel_id', 'site_address', 'use_code', 'use_description', 'class_code',
    'class_description', 'property_description', 'subdivision_name', 'structure_type', 'land_use_category',
    'classification_confidence', 'classification_review_reason', 'built_up', 'building_area_sqft', 'residential_area_sqft',
    'residential_year_built', 'land_value', 'improvement_value', 'current_market_value', 'previous_market_value',
    'parcel_area_sqft'].map(key => [key, null]));
  Object.assign(attributes, { account_id: accountId, source_updated_at: capturedAt,
    source_attributes_json: '{"synthetic_fixture":true,"provider_observation":false}' }, clone(suppliedAttributes));
  if (attributes.account_id !== accountId) invalid('attributes_account');
  const geometry = { srid: 4326, serialization: 'postgis-ewkb-ndr-hex', ewkb: ewkbHex,
    content_sha256: sha(Buffer.from(ewkbHex, 'hex')), raw_provider_geometry: 'unavailable_in_legacy_mirror' };
  const content = { feature, attributes, geometry };
  return { record_id: `${PARCEL_KEY}:${recordId}`, data: { ...content,
    normalized_content_sha256: assessmentEvidenceDigest(content),
    ingest: { source_record_hash: sha(`synthetic-ingest:${recordId}`), sync_run_id: RUN, synced_at: capturedAt },
    origin_run: { id: RUN, source_key: PARCEL_KEY, mode: 'full', status: 'complete', started_at: capturedAt, completed_at: capturedAt },
  } };
}

/** Produces the CURRENT reader's parcel-only evidence shape. Geometry entries
 * are GeoJSON or exact EWKB hex; additionalRecords contain recordId/accountId/
 * geometry plus optional attributes. Data is synthetic even when the adapter's
 * configured DCAD identity is preserved. Returned bytes are mutable for tests. */
export function makeSubjectEvidence({ geometries = defaultSubjects(), accountId, scope = SELECTED_BOUNDARY_FIXTURE_SCOPE,
  capturedAt = SELECTED_BOUNDARY_FIXTURE_CAPTURED_AT, recordIds, additionalRecords = [] } = {}) {
  const owner = { ...scope, account_id: accountId ?? scope.account_id };
  if (!Array.isArray(geometries) || !Array.isArray(additionalRecords)) invalid('records');
  const ids = recordIds ?? geometries.map((_, index) => index < 2 ? SELECTED_BOUNDARY_FIXTURE_RECORD_IDS[index] : String(index + 19));
  if (!Array.isArray(ids) || ids.length !== geometries.length) invalid('record_ids');
  const records = [...geometries.map((geometry, index) => parcelRecord({ recordId: ids[index], accountId: owner.account_id, geometry }, capturedAt)),
    ...additionalRecords.map(row => parcelRecord(row, capturedAt))].sort((a, b) => {
    const left = BigInt(a.data.feature.object_id), right = BigInt(b.data.feature.object_id);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const state = { source_key: PARCEL_KEY, status: 'current', source_vintage: 'synthetic-fixture-v1',
    source_url_matches_catalog: true, metadata_oversized: false, row_count: String(records.length),
    last_run_id: RUN, last_success_at: capturedAt, last_attempt_at: capturedAt, last_source_update_at: capturedAt,
    run_id: RUN, run_source_key: PARCEL_KEY, run_mode: 'full', run_status: 'complete', run_started_at: capturedAt, run_completed_at: capturedAt };
  const definition = { reader_version: SELECTED_BOUNDARY_FIXTURE_READER_VERSION, source_key: PARCEL_KEY,
    dataset: 'gis.dcad_parcels', provider: 'dcad', service_url: SERVICE_URL, service_layer: null, partition: null,
    bounds: { west: -97.1, south: 32.1, east: -96.2, north: 33.0 }, srid: 4326,
    spatial_predicate: 'bbox_intersection_and_st_intersects', ordering: 'object_id_numeric',
    scope_of_completeness: 'selected_current_mirror_query_only', provider_coverage: 'unknown', historical_availability: 'unknown',
    postgis_version: 'synthetic-fixture-not-executed', raw_source_state: state, zoning_registry: null,
    limits: { page_rows: 250, total_rows: 20000, total_bytes: 8000000, record_bytes: 128000, page_bytes: 512000,
      total_wire_bytes: 16000000, subject_members: 32, statement_ms: 5000, total_ms: 30000 },
    content_digest_protocol: 'sha256(canonical_header + LF + each_ordered_canonical_record + LF)' };
  const upstreamHash = createHash('sha256').update(canonicalAssessmentJson(definition)).update('\n');
  for (const record of records) upstreamHash.update(canonicalAssessmentJson(record)).update('\n');
  const contentHash = upstreamHash.digest('hex');
  const captured = buildCachedSourceCaptures({ scope: owner, captures: [{
    upstream: { id: 'gis-cache:dcad_parcels', key: PARCEL_KEY, state: records.length ? 'populated' : 'present_empty', complete: true,
      row_count: records.length, revision: `${SELECTED_BOUNDARY_FIXTURE_READER_VERSION}:${contentHash}`, content_sha256: contentHash,
      captured_at: capturedAt, visibility: 'assignment_private', scope: owner },
    metadata: { id: CAPTURE_ID, provider: 'dcad', revision: SELECTED_BOUNDARY_FIXTURE_READER_VERSION,
      valid_from: null, valid_to: null, observed_at: capturedAt, historical_availability: 'unknown' },
    projection: { id: CAPTURE_ID, revision: SELECTED_BOUNDARY_FIXTURE_READER_VERSION, definition,
      input_row_count: records.length, output_record_count: records.length, complete: true }, records,
  }] });
  const subjectRows = records.filter(row => row.data.attributes.account_id === owner.account_id);
  return clone({ version: 1, reader_version: SELECTED_BOUNDARY_FIXTURE_READER_VERSION, captured_at: capturedAt,
    subject: { status: subjectRows.length ? 'resolved' : 'unavailable', account_id: owner.account_id,
      member_record_ids: subjectRows.map(row => row.record_id),
      resolution_policy: 'all_exact_account_features_no_alias_or_smallest_area_fallback',
      reasons: subjectRows.length ? [] : ['subject_account_not_resolved'] },
    capture: { scope: captured.scope, source_snapshots: captured.source_snapshots, sources: captured.sources,
      references: captured.references, capability_diagnostics: captured.capability_diagnostics } });
}

function ringArea(ring) {
  return Math.abs(ring.slice(1).reduce((sum, point, index) => sum + ring[index][0] * point[1] - point[0] * ring[index][1], 0)) / 2;
}
const toMetric = point => [700000 + point[0], 3600000 + point[1]];
// Deliberately stipulated display correspondence for mocks, NOT a CRS transform.
const mockDisplay = point => [-96.9 + point[0] / 100000, 32.6 + point[1] / 100000];
const geometryId = (kind, hex) => `${kind}:${sha(Buffer.from(hex, 'hex'))}`;

/** Arithmetic mock expectations, separate from the strict input. The affine
 * display coordinates deliberately are NOT proof of a real CRS transformation.
 * For hole, select just the annular cell; fillHole models selecting both cells. */
export function makeMockSelectedBoundaryOracle({ variant = 'square', fillHole = false } = {}) {
  const outer = variant === 'adjacent'
    ? [[0, 0], [0, 100], [100, 100], [200, 100], [200, 0], [100, 0], [0, 0]]
    : rectangle(0, 0, 100);
  if (!['square', 'adjacent', 'hole'].includes(variant)) invalid('mock_oracle_variant');
  const rings = [outer, ...(variant === 'hole' && !fillHole ? [[...rectangle(30, 30, 40)].reverse()] : [])];
  const geometry = { type: 'Polygon', coordinates: rings.map(ring => ring.map(mockDisplay)) };
  const metricGeometry = { type: 'Polygon', coordinates: rings.map(ring => ring.map(toMetric)) };
  const anchor = [15, 15];
  return { geometry, geometry_ewkb: geometryEwkbHex(metricGeometry, { srid: 26914 }),
    area_m2: ringArea(outer) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0),
    anchor_geometry: { type: 'Point', coordinates: mockDisplay(anchor) },
    anchor_geometry_ewkb: geometryEwkbHex({ type: 'Point', coordinates: toMetric(anchor) }, { srid: 26914 }) };
}

/** Synthetic graph-shaped mock. Valid EWKB encoding and content hashes do NOT
 * make this a native topology result. Only isolated unit tests may use it. */
export function makeMockSelectedBoundaryTopology({ variant = 'square' } = {}) {
  const square = rectangle(0, 0, 100), inner = rectangle(30, 30, 40);
  const variants = { square: [[square]], adjacent: [[square], [rectangle(100, 0, 100)]],
    hole: [[square, [...inner].reverse()], [inner]], disconnected: [[square], [rectangle(200, 0, 100)]],
    corner: [[square], [rectangle(100, 100, 100)]] };
  if (!Object.hasOwn(variants, variant)) invalid('mock_variant');
  const cells = [], edgeByKey = new Map(), nodeByKey = new Map();
  function node(point) {
    const key = canonicalAssessmentJson(point);
    if (!nodeByKey.has(key)) {
      const hex = geometryEwkbHex({ type: 'Point', coordinates: toMetric(point) }, { srid: 26914 });
      nodeByKey.set(key, { id: geometryId('node', hex), degree: 0, metric_srid: 26914, geometry_ewkb: hex,
        geometry: { type: 'Point', coordinates: mockDisplay(point) } });
    }
    return nodeByKey.get(key);
  }
  for (const rings of variants[variant]) {
    const geometry = { type: 'Polygon', coordinates: rings.map(ring => ring.map(toMetric)) };
    const hex = geometryEwkbHex(geometry, { srid: 26914 });
    const cell = { id: geometryId('cell', hex), area_m2: ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0),
      geometry_validated: true, metric_srid: 26914, geometry_ewkb: hex,
      geometry: { type: 'Polygon', coordinates: rings.map(ring => ring.map(mockDisplay)) },
      boundary_edge_ids: [], interior_ring_count: rings.length - 1 };
    for (const ring of rings) for (let index = 1; index < ring.length; index++) {
      const points = [ring[index - 1], ring[index]].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const key = canonicalAssessmentJson(points);
      if (!edgeByKey.has(key)) {
        const from = node(points[0]), to = node(points[1]); from.degree++; to.degree++;
        const edgeHex = geometryEwkbHex({ type: 'LineString', coordinates: points.map(toMetric) }, { srid: 26914 });
        edgeByKey.set(key, { id: geometryId('edge', edgeHex), from_node_id: from.id, to_node_id: to.id,
          length_meters: Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]),
          geometry_validated: true, geometry: { type: 'LineString', coordinates: points.map(mockDisplay) },
          geometry_ewkb: edgeHex, metric_srid: 26914, cell_ids: [], source_parts: [] });
      }
      const edge = edgeByKey.get(key); edge.cell_ids.push(cell.id); cell.boundary_edge_ids.push(edge.id);
    }
    cell.boundary_edge_ids.sort(compare); cells.push(cell);
  }
  const edges = [...edgeByKey.values()];
  const prepared = prepareNeighborhoodLinework({ version: GRAPH_PREPARATION_VERSION,
    capture: { id: `synthetic-selected-${variant}`, revision: 'synthetic-capture-1', acquired_at: SELECTED_BOUNDARY_FIXTURE_CAPTURED_AT,
      coverage: 'complete', expected_feature_count: edges.length,
      query: { crs: 'EPSG:4326', envelope: [-97, 32, -96.5, 33], layers: ['synthetic/roads'] },
      source_inventory: [{ source_layer: 'synthetic/roads', source_key: 'synthetic_linework' }],
      source_states: [{ source_key: 'synthetic_linework', status: 'current', last_run_id: RUN }],
      origin_runs: [{ id: RUN, source_key: 'synthetic_linework', mode: 'full', status: 'complete' }] },
    aliases: { revision: 'synthetic-aliases-1', coverage: 'complete', records: [] },
    policy: { version: 'synthetic-zero-snap-1', metric_srid: 26914, snap_tolerance_meters: 0 },
    features: edges.map((edge, index) => ({ source_key: 'synthetic_linework', source_layer: 'synthetic/roads', source_object_id: String(index + 1),
      source_record_hash: sha(`synthetic-edge:${index}`), sync_run_id: RUN, source_vintage: 'synthetic-mock-only',
      name: `Synthetic Edge ${index + 1}`, base_name: `Synthetic Edge ${index + 1}`, road_class: 'primary',
      repair_revision: 'synthetic-no-repair', original_geometry_sha256: null, geometry: edge.geometry })) });
  if (prepared.status !== 'ready_for_preprocessing') invalid('mock_source_preparation');
  edges.forEach((edge, index) => {
    const feature = prepared.features.find(row => row.source_object_id === String(index + 1));
    edge.source_parts.push({ feature_id: feature.feature_id, source_part_index: 1, source_segment_index: 1,
      source_fraction_basis: 'source_segment', start_fraction: 0, end_fraction: 1 });
    edge.cell_ids.sort(compare);
  });
  const nodes = [...nodeByKey.values()], s = edges.length;
  // An explicitly conservative mock admission count; no native query occurred.
  const p = s * (s - 1) / 2;
  const output = { status: 'ready', topology_validated: true, topology_revision: null,
    topology_version: POSTGIS_TOPOLOGY_VERSION, metric_srid: 26914, display_srid: 4326,
    source_capture_sha256: prepared.capture_sha256, linework_content_sha256: prepared.linework_content_sha256,
    source_coverage: { query_coverage: 'complete', provider_coverage: 'unknown', historical_coverage: 'unknown' },
    engine_versions: { postgis: 'synthetic-mock-not-executed', geos: 'synthetic-mock-not-executed', proj: 'synthetic-mock-not-executed',
      spatial_reference_sha256: sha('synthetic-stipulated-EPSG26914-mock') },
    performed_policy: { version: POSTGIS_TOPOLOGY_VERSION, requested_policy_version: 'synthetic-zero-snap-1', metric_srid: 26914,
      snap_tolerance_meters: 0, source_attribution: 'exact_original_endpoint_and_pair_intersection_witness_chains_v1',
      source_fraction_basis: 'source_segment', source_fraction_interpretation: 'dominant_axis_signed_order_coordinate_v1',
      source_occurrence_coverage: 'complete_consecutive_witness_chain_coverage_v1', source_witness_budgets: 'point_incidences_2S_plus_4P_chains_S_plus_4P_v1',
      ambiguous_source_policy: 'require_original_primitive_positive_length_overlap_v1', supported_projection_window: [-98.5, 31, -95.5, 34.5],
      noding_admission_policy: 'projected-primitive-bbox-v1', minimum_cell_area_m2: 1, geometry_repair: 'none', travel_graph: 'not_generated' },
    cells: cells.sort((a, b) => compare(a.id, b.id)), edges: edges.sort((a, b) => compare(a.id, b.id)), nodes: nodes.sort((a, b) => compare(a.id, b.id)),
    source_features: prepared.features, source_aliases: prepared.aliases, source_limitations: prepared.limitations,
    diagnostics: { invalid_source_count: 0, nonsimple_source_count: 0, noded_coordinate_count: s * 2, edge_count: s,
      cell_count: cells.length, node_count: nodes.length, source_reference_count: s, source_point_incidence_count: s * 2,
      source_chain_count: s, invalid_source_witness_count: 0, ambiguous_source_order_count: 0, invalid_cell_count: 0,
      sliver_cell_count: 0, unattributed_edge_count: 0, uncovered_source_segment_count: 0, ambiguous_source_edge_count: 0,
      invalid_incidence_count: 0, unsupported_boundary_count: 0, overlapping_cell_count: 0, multisource_edge_count: 0,
      unused_edge_count: 0, dangle_node_count: 0 },
    noding_admission: { policy: 'projected-primitive-bbox-v1', primitive_segments: s, original_coordinates: s * 2,
      candidate_pairs: p, candidate_pairs_complete: true, split_pieces_upper_bound: s + 4 * p,
      noded_coordinates_upper_bound: s * 2 + 8 * p, admitted: true },
    incomplete_reasons: [], travel_connectivity: 'not_evaluated', limits: { ...POSTGIS_TOPOLOGY_LIMITS } };
  output.topology_revision = neighborhoodTopologyRevision(output);
  return output;
}

export function makeSelectedBoundaryInput({ topology = makeMockSelectedBoundaryTopology(), selectedCellIds, subjectEvidence,
  scope, effectiveDate = SELECTED_BOUNDARY_FIXTURE_EFFECTIVE_DATE,
  knowledgeCutoff = SELECTED_BOUNDARY_FIXTURE_KNOWLEDGE_CUTOFF, selectionRevision = 'synthetic-selection-1' } = {}) {
  const owner = clone(scope ?? subjectEvidence?.capture.scope ?? SELECTED_BOUNDARY_FIXTURE_SCOPE);
  const selection = { revision: selectionRevision, scope: clone(owner), effective_date: effectiveDate, knowledge_cutoff: knowledgeCutoff,
    topology_revision: topology.topology_revision, source_capture_sha256: topology.source_capture_sha256,
    selected_cell_ids: clone(selectedCellIds ?? topology.cells.map(row => row.id)) };
  selection.content_sha256 = assessmentEvidenceDigest(selection);
  return { version: 1, scope: owner, effective_date: effectiveDate, knowledge_cutoff: knowledgeCutoff, topology: clone(topology), selection,
    subject_evidence: subjectEvidence ? clone(subjectEvidence) : makeSubjectEvidence({ scope: owner }) };
}
