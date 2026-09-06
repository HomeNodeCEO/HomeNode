import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { neighborhoodTopologyRevision, POSTGIS_TOPOLOGY_VERSION, POSTGIS_TOPOLOGY_LIMITS } from './postgisTopology.js';
import { buildCachedSourceCaptures } from './cachedSourceCaptures.js';

export const SELECTED_BOUNDARY_VERSION = 'postgis-selected-boundary-v1';
export const SELECTED_BOUNDARY_LIMITS = Object.freeze({
  selected_cells: 64, subject_members: 32, topology_bytes: 32_000_000,
  parcel_proof_bytes: 8_000_000, input_bytes: 42_000_000, subject_geometry_bytes: 1_000_000,
  chunk_bytes: 1_500_000, chunks: 1000, records: 50_000, perimeter_edges: 5000,
  rings: 256, perimeter_coordinates: 10_000, selected_coordinates: 20_000,
  subject_coordinates: 10_000, output_bytes: 1_000_000, source_occurrences: 16_384,
  statement_ms: 5000, total_ms: 30_000, connect_ms: 3000,
});
export const SELECTED_BOUNDARY_ERROR_LIMIT_BYTES = 16_384;
const MAXIMUM = { ...SELECTED_BOUNDARY_LIMITS, selected_cells: 256, subject_members: 100 };
const SCOPE_KEYS = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const READER = 'gis-cache-query-v1';
const CAPTURE = 'gis-query:dcad_parcels';
const DCAD_URL = 'https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query';
const WINDOW = [-98.5, 31, -95.5, 34.5];
const DIAGNOSTICS = ['invalid_source_count', 'nonsimple_source_count', 'noded_coordinate_count', 'edge_count', 'cell_count',
  'node_count', 'source_reference_count', 'source_point_incidence_count', 'source_chain_count', 'invalid_source_witness_count',
  'ambiguous_source_order_count', 'invalid_cell_count', 'sliver_cell_count', 'unattributed_edge_count', 'uncovered_source_segment_count',
  'ambiguous_source_edge_count', 'invalid_incidence_count', 'unsupported_boundary_count', 'overlapping_cell_count',
  'multisource_edge_count', 'unused_edge_count', 'dangle_node_count'];
const LIMITATIONS = Object.freeze(['source_authenticity_not_verified', 'selection_ranking_not_assessed',
  'parcel_identity_not_authenticated', 'provider_wide_completeness_unknown', 'historical_availability_not_promoted',
  'report_eligibility_not_assessed', 'competitive_market_not_assessed', 'original_source_segment_counts_not_revalidated',
  'native_acceptance_gate_not_completed']);
const METHOD = Object.freeze({ version: SELECTED_BOUNDARY_VERSION, metric_srid: 26914, display_srid: 4326,
  selection: 'exact_supplied_cell_ids_no_selector_rerun', union: 'ST_UnaryUnion_of_exact_selected_cells',
  subject_coverage: 'ST_Covers_every_complete_captured_exact_account_member',
  anchor: 'ST_PointOnSurface_normalized_subject_member_strict_ST_Contains_both',
  perimeter: 'exact_incident_edges_native_boundary_equality', repair: 'none', snap_tolerance_meters: 0,
  supported_projection_window: WINDOW, source_authority: 'not_verified' });
const failures = new WeakMap();
const invalidErrors = new WeakSet();
const invalid = code => { const error = new TypeError(`invalid_neighborhood_selected_boundary:${code}`); invalidErrors.add(error); throw error; };
function stop(code) { const error = new Error('neighborhood_selected_boundary_incomplete'); failures.set(error, code); throw error; }
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => createHash('sha256').update(canonicalAssessmentJson(value)).digest('hex');
const bytesHash = hex => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function keys(value, expected, field) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== expected.length
    || expected.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}
function text(value, field, max = 200) {
  if (typeof value !== 'string' || !value || value.length > max || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) invalid(field);
  return value;
}
function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field);
  return value;
}
function scoped(value) {
  keys(value, SCOPE_KEYS, 'scope');
  for (const key of SCOPE_KEYS) { text(value[key], 'scope', key === 'account_id' ? 100 : 36); if (key !== 'account_id' && !UUID.test(value[key])) invalid('scope'); }
  return value;
}
function array(value, max, field) { if (!Array.isArray(value)) invalid(field); if (value.length > max) stop('input_limit_exceeded'); return value; }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function limitsOf(value = {}) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid('limits');
  const result = { ...SELECTED_BOUNDARY_LIMITS };
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !Object.hasOwn(MAXIMUM, key) || !descriptor || !Object.hasOwn(descriptor, 'value')
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1 || descriptor.value > MAXIMUM[key]) invalid('limits');
    result[key] = descriptor.value;
  }
  return result;
}

// Inspect property descriptors before reading values. Charge exact JSON framing,
// strings and keys before cloning; never serialize the entire 42MB request.
function copyJson(value, max, clone = true) {
  let bytes = 0, nodes = 0;
  const active = new WeakSet();
  const charge = size => { bytes += size; if (bytes > max) stop('input_limit_exceeded'); };
  const string = value => {
    const remaining = max - bytes;
    if (value.length + 2 > remaining) stop('input_limit_exceeded');
    let size = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || (code >= 8 && code <= 10) || code === 12 || code === 13) size += 2;
      else if (code < 0x20) size += 6;
      else if (code < 0x80) size++;
      else if (code < 0x800) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { size += 4; index++; }
      else if (code >= 0xd800 && code <= 0xdfff) size += 6;
      else size += 3;
      if (size > remaining) stop('input_limit_exceeded');
    }
    charge(size); return value;
  };
  function visit(item, depth) {
    if (++nodes > 2_000_000 || depth > 40) stop('input_limit_exceeded');
    if (typeof item === 'string') return string(item);
    if (item === null || typeof item === 'boolean') { charge(item === null ? 4 : item ? 4 : 5); return item; }
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) invalid('json_number'); charge(JSON.stringify(item).length); return item; }
    if (item && (typeof item === 'object' || typeof item === 'function') && types.isProxy(item)) invalid('json_proxy');
    const isArray = Array.isArray(item);
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== (isArray ? Array.prototype : Object.prototype)) invalid('json_shape');
    if (active.has(item)) invalid('json_cycle'); active.add(item);
    const own = Reflect.ownKeys(item);
    if (own.length > 2_000_000 || own.some(key => typeof key !== 'string')) invalid('json_shape');
    if (isArray && (own.length !== item.length + 1 || item.length > 2_000_000)) invalid('json_array');
    charge(2); const result = clone ? (isArray ? [] : {}) : null;
    let index = 0;
    for (const key of own) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('json_descriptor');
      if (isArray && key !== String(index)) invalid('json_array');
      if (index++) charge(1);
      if (!isArray) { string(key); charge(1); }
      const child = visit(descriptor.value, depth + 1);
      if (clone) Object.defineProperty(result, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    active.delete(item); return clone ? result : item;
  }
  return { value: visit(value, 0), bytes };
}
function streamManifest(value) {
  const hash = createHash('sha256').update('selected-boundary-evidence-v1\n');
  const append = item => {
    if (item === null || typeof item !== 'object') { hash.update(JSON.stringify(item)); return; }
    if (Array.isArray(item)) {
      hash.update('['); item.forEach((child, i) => { if (i) hash.update(','); append(child); }); hash.update(']'); return;
    }
    hash.update('{'); Object.keys(item).sort(compare).forEach((key, i) => {
      if (i) hash.update(','); hash.update(JSON.stringify(key)).update(':'); append(item[key]);
    }); hash.update('}');
  };
  // Preserve JSON type and collection framing. A singleton array must never
  // collide with its bare member, nor an empty array with omitted evidence.
  append(value);
  return hash.digest('hex');
}

// This decoder performs bounded admission and exact endpoint/byte identity, not
// polygon validity. Native PostGIS independently verifies every consumed shape.
function decode(hex, srid, kinds, budget, expectedId = null) {
  if (typeof hex !== 'string' || !HEX.test(hex) || hex.length > 2 * 32_000_000) invalid('ewkb');
  const data = Buffer.from(hex, 'hex'); let offset = 0;
  function need(n) { if (offset + n > data.length) invalid('ewkb'); }
  function geometry(nested = false) {
    need(5); const little = data[offset++] === 1;
    if (!little) invalid('ewkb_ndr');
    const uint = () => { need(4); const n = data.readUInt32LE(offset); offset += 4; return n; };
    const encoded = uint(), hasSrid = (encoded & 0x20000000) !== 0, kind = encoded & 0x0fffffff;
    if (encoded !== kind + (hasSrid ? 0x20000000 : 0) || (!nested && !hasSrid) || (hasSrid && uint() !== srid)) invalid('ewkb_srid_or_dimension');
    if (nested ? kind !== 3 : !kinds.includes(kind)) invalid('ewkb_kind');
    const point = () => {
      need(16); const xy = [data.readDoubleLE(offset), data.readDoubleLE(offset + 8)]; offset += 16;
      if (xy.some(n => !Number.isFinite(n) || Math.abs(n) > 20_000_000)) invalid('ewkb_coordinate');
      if (srid === 4326 && (xy[0] < WINDOW[0] || xy[0] > WINDOW[2] || xy[1] < WINDOW[1] || xy[1] > WINDOW[3])) stop('unsupported_projection_extent');
      if (++budget.count > budget.maximum) stop('input_limit_exceeded'); return xy;
    };
    const points = minimum => {
      const size = uint(); if (size < minimum || size > budget.maximum - budget.count) stop('input_limit_exceeded');
      const result = []; for (let i = 0; i < size; i++) result.push(point()); return result;
    };
    if (kind === 1) return { kind, coordinates: point() };
    if (kind === 2) return { kind, coordinates: points(2) };
    if (kind === 3) {
      const size = uint(); if (!size || size > budget.maximum) invalid('ewkb_rings');
      const rings = [];
      for (let i = 0; i < size; i++) { const ring = points(4); if (!same(ring[0], ring.at(-1))) invalid('ewkb_ring_open'); rings.push(ring); }
      return { kind, coordinates: rings };
    }
    if (kind === 6) {
      const size = uint(); if (!size || size > budget.maximum) invalid('ewkb_parts');
      const polygons = [];
      for (let i = 0; i < size; i++) { const polygon = geometry(true); if (polygon.kind !== 3) invalid('ewkb_part_kind'); polygons.push(polygon.coordinates); }
      return { kind, coordinates: polygons };
    }
    invalid('ewkb_kind');
  }
  const result = geometry();
  if (offset !== data.length || !kinds.includes(result.kind)) invalid('ewkb_shape');
  if (expectedId !== null && expectedId !== `${result.kind === 1 ? 'node' : result.kind === 2 ? 'edge' : 'cell'}:${bytesHash(hex)}`) invalid('geometry_identity');
  return result;
}

function subjectOf(input, limits) {
  const evidence = keys(input.subject_evidence, ['version', 'reader_version', 'captured_at', 'subject', 'capture'], 'subject_evidence');
  copyJson(evidence, limits.parcel_proof_bytes, false);
  if (evidence.version !== 1 || evidence.reader_version !== READER) invalid('subject_version');
  if (timestamp(evidence.captured_at, 'captured_at') > input.knowledge_cutoff) stop('subject_knowledge_cutoff');
  const subject = keys(evidence.subject, ['status', 'account_id', 'member_record_ids', 'resolution_policy', 'reasons'], 'subject');
  if (subject.status !== 'resolved' || subject.account_id !== input.scope.account_id
    || subject.resolution_policy !== 'all_exact_account_features_no_alias_or_smallest_area_fallback'
    || !Array.isArray(subject.reasons) || subject.reasons.length) stop('subject_unresolved');
  const claimed = array(subject.member_record_ids, limits.subject_members, 'subject_members');
  if (!claimed.length || claimed.some(id => typeof id !== 'string') || new Set(claimed).size !== claimed.length) invalid('subject_roster');
  const capture = keys(evidence.capture, ['scope', 'source_snapshots', 'sources', 'references', 'capability_diagnostics'], 'subject_capture');
  if (!same(scoped(capture.scope), input.scope)) invalid('subject_scope');
  array(capture.sources, limits.chunks, 'chunks'); array(capture.source_snapshots, limits.chunks, 'snapshots');
  array(capture.references, 1, 'parcel_references'); array(capture.capability_diagnostics, 1, 'parcel_capabilities');
  if (capture.references.length !== 1 || capture.capability_diagnostics.length !== 1) invalid('parcel_descriptor_closure');
  if (!capture.sources.length || capture.sources.length !== capture.source_snapshots.length) invalid('chunk_closure');
  const records = [], chunkIndexes = new Set(), ids = new Set(); let header;
  const snapshotMap = new Map(capture.source_snapshots.map(row => [row.id, row]));
  if (snapshotMap.size !== capture.source_snapshots.length) invalid('snapshot_duplicate');
  for (const source of capture.sources) {
    keys(source, ['id', 'payload'], 'source_chunk');
    const payload = keys(source.payload, ['schema_version', 'scope', 'upstream', 'projection', 'metadata', 'partition', 'records'], 'chunk_payload');
    copyJson(payload, limits.chunk_bytes, false);
    if (payload.schema_version !== 1 || !same(scoped(payload.scope), input.scope) || source.id !== `${CAPTURE}:${digest(payload)}` || ids.has(source.id)) invalid('chunk_identity');
    ids.add(source.id);
    const snapshot = snapshotMap.get(source.id), metadata = payload.metadata;
    if (!snapshot || snapshot.content_sha256 !== digest(payload)) invalid('snapshot_digest');
    if (metadata.id !== CAPTURE || metadata.provider !== 'dcad' || metadata.revision !== READER
      || metadata.observed_at !== evidence.captured_at || !['contemporaneous', 'reconstructed', 'unknown'].includes(metadata.historical_availability)) invalid('parcel_metadata');
    for (const key of ['valid_from', 'valid_to']) if (metadata[key] !== null) assessmentDate(metadata[key], key);
    if ((metadata.valid_from !== null && metadata.valid_from > input.effective_date)
      || (metadata.valid_to !== null && metadata.valid_to < input.effective_date)) stop('subject_temporal_contradiction');
    if (metadata.valid_from !== null || metadata.valid_to !== null || metadata.historical_availability !== 'unknown') invalid('unsupported_parcel_history');
    const partition = keys(payload.partition, ['index', 'count', 'record_count'], 'partition');
    if (!count(partition.index) || partition.count !== capture.sources.length || partition.index >= partition.count
      || chunkIndexes.has(partition.index) || partition.record_count !== payload.records.length) invalid('chunk_partition');
    chunkIndexes.add(partition.index); array(payload.records, limits.records, 'records');
    const nextHeader = { upstream: payload.upstream, projection: payload.projection, metadata };
    if (header && !same(header, nextHeader)) invalid('chunk_header_disagreement'); header = nextHeader;
    records.push(...payload.records); if (records.length > limits.records) stop('input_limit_exceeded');
  }
  const { upstream, projection, metadata } = header, definition = projection.definition;
  if (upstream.id !== 'gis-cache:dcad_parcels' || upstream.key !== 'dcad_parcels' || upstream.state !== 'populated' || upstream.complete !== true
    || upstream.captured_at !== evidence.captured_at || upstream.visibility !== 'assignment_private' || !same(upstream.scope, input.scope)
    || upstream.row_count !== records.length || projection.id !== CAPTURE || projection.revision !== READER || projection.complete !== true
    || projection.input_row_count !== records.length || projection.output_record_count !== records.length) invalid('parcel_capture_incomplete');
  if (definition.reader_version !== READER || definition.source_key !== 'dcad_parcels' || definition.dataset !== 'gis.dcad_parcels'
    || definition.provider !== 'dcad' || definition.service_url !== DCAD_URL || definition.service_layer !== null || definition.partition !== null
    || definition.srid !== 4326 || definition.ordering !== 'object_id_numeric'
    || definition.spatial_predicate !== 'bbox_intersection_and_st_intersects'
    || definition.scope_of_completeness !== 'selected_current_mirror_query_only' || definition.provider_coverage !== 'unknown'
    || definition.historical_availability !== 'unknown' || definition.zoning_registry !== null
    || definition.content_digest_protocol !== 'sha256(canonical_header + LF + each_ordered_canonical_record + LF)') invalid('parcel_projection');
  const atCapture = (value, name) => {
    if (timestamp(value, name) > evidence.captured_at || value > input.knowledge_cutoff) invalid('parcel_metadata_time'); return value;
  };
  const state = definition.raw_source_state;
  if (!state || state.source_key !== 'dcad_parcels' || state.status !== 'current' || state.source_url_matches_catalog !== true
    || state.metadata_oversized !== false || typeof state.last_run_id !== 'string' || !UUID.test(state.last_run_id)
    || state.last_run_id !== state.run_id || state.run_source_key !== 'dcad_parcels' || state.run_status !== 'complete'
    || !['full', 'incremental'].includes(state.run_mode) || typeof state.row_count !== 'string' || !/^(0|[1-9][0-9]*)$/.test(state.row_count)
    || state.row_count.length > 19 || BigInt(state.row_count) < BigInt(records.length)) invalid('parcel_source_state');
  atCapture(state.run_started_at, 'run_started_at'); atCapture(state.run_completed_at, 'run_completed_at'); atCapture(state.last_success_at, 'last_success_at');
  if (state.run_started_at > state.run_completed_at || state.last_success_at < state.run_completed_at) invalid('parcel_metadata_time');
  for (const name of ['last_attempt_at', 'last_source_update_at']) if (state[name] !== null) atCapture(state[name], name);
  const bounds = keys(definition.bounds, ['west', 'south', 'east', 'north'], 'parcel_bounds');
  if (Object.values(bounds).some(value => !Number.isFinite(value)) || bounds.west >= bounds.east || bounds.south >= bounds.north
    || bounds.west < -180 || bounds.east > 180 || bounds.south < -90 || bounds.north > 90
    || bounds.east - bounds.west > 1 || bounds.north - bounds.south > 1) invalid('parcel_bounds');
  const recordIds = new Set(), originRuns = new Map(), members = [], geometryBudget = { count: 0, maximum: limits.subject_coordinates };
  let geometryBytes = 0;
  for (const row of records) {
    keys(row, ['record_id', 'data'], 'parcel_record');
    const data = keys(row.data, ['feature', 'attributes', 'geometry', 'normalized_content_sha256', 'ingest', 'origin_run'], 'parcel_data');
    const feature = data.feature, geometry = data.geometry;
    if (typeof feature.object_id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(feature.object_id) || feature.object_id.length > 19
      || BigInt(feature.object_id) > 9223372036854775807n || row.record_id !== `dcad_parcels:${feature.object_id}` || recordIds.has(row.record_id)
      || feature.source_key !== 'dcad_parcels' || feature.dataset !== 'gis.dcad_parcels' || feature.provider !== 'dcad'
      || feature.configured_service_url !== DCAD_URL || feature.configured_service_layer !== null
      || feature.acquisition_endpoint_history !== 'unavailable_in_legacy_run_ledger') invalid('parcel_record_identity');
    recordIds.add(row.record_id);
    keys(data.ingest, ['source_record_hash', 'sync_run_id', 'synced_at'], 'parcel_ingest');
    keys(data.origin_run, ['id', 'source_key', 'mode', 'status', 'started_at', 'completed_at'], 'parcel_origin');
    const origin = data.origin_run, ingest = data.ingest;
    if (typeof ingest.sync_run_id !== 'string' || !UUID.test(ingest.sync_run_id) || ingest.sync_run_id !== origin.id
      || origin.source_key !== 'dcad_parcels' || origin.status !== 'complete' || !['full', 'incremental'].includes(origin.mode)
      || (ingest.source_record_hash !== null && (typeof ingest.source_record_hash !== 'string' || !SHA.test(ingest.source_record_hash)))) invalid('parcel_origin');
    atCapture(origin.started_at, 'origin_started_at'); atCapture(origin.completed_at, 'origin_completed_at');
    if (origin.started_at > origin.completed_at) invalid('parcel_metadata_time');
    const originDigest = digest(origin);
    if (originRuns.has(origin.id) && originRuns.get(origin.id) !== originDigest) invalid('parcel_origin_disagreement');
    originRuns.set(origin.id, originDigest);
    if (origin.id === state.run_id && (origin.mode !== state.run_mode || origin.status !== state.run_status
      || origin.started_at !== state.run_started_at || origin.completed_at !== state.run_completed_at)) invalid('parcel_origin_disagreement');
    if (ingest.synced_at !== null) {
      atCapture(ingest.synced_at, 'synced_at');
      if (ingest.synced_at < origin.started_at || ingest.synced_at > origin.completed_at) invalid('parcel_metadata_time');
    }
    if (data.attributes.source_updated_at !== null) atCapture(data.attributes.source_updated_at, 'source_updated_at');
    if (data.attributes.account_id !== null) text(data.attributes.account_id, 'parcel_account', 100);
    if (geometry.srid !== 4326 || geometry.serialization !== 'postgis-ewkb-ndr-hex' || typeof geometry.ewkb !== 'string' || !HEX.test(geometry.ewkb)
      || geometry.content_sha256 !== bytesHash(geometry.ewkb) || geometry.raw_provider_geometry !== 'unavailable_in_legacy_mirror'
      || data.normalized_content_sha256 !== digest({ feature, attributes: data.attributes, geometry })) invalid('parcel_record_digest');
    if (data.attributes.account_id === input.scope.account_id) {
      geometryBytes += geometry.ewkb.length / 2; if (geometryBytes > limits.subject_geometry_bytes) stop('input_limit_exceeded');
      const subjectGeometry = decode(geometry.ewkb, 4326, [3, 6], geometryBudget);
      const polygons = subjectGeometry.kind === 3 ? [subjectGeometry.coordinates] : subjectGeometry.coordinates;
      if (polygons.some(polygon => polygon.some(ring => ring.some(point => point[0] < bounds.west || point[0] > bounds.east
        || point[1] < bounds.south || point[1] > bounds.north)))) invalid('subject_outside_capture_bounds');
      members.push({ record_id: row.record_id, geometry_ewkb: geometry.ewkb,
        geometry_ewkb_sha256: geometry.content_sha256, record_sha256: digest(row) });
      if (members.length > limits.subject_members) stop('input_limit_exceeded');
    }
  }
  records.sort((a, b) => BigInt(a.data.feature.object_id) < BigInt(b.data.feature.object_id) ? -1 : 1);
  const upstreamHash = createHash('sha256').update(canonicalAssessmentJson(definition)).update('\n');
  for (const row of records) upstreamHash.update(canonicalAssessmentJson(row)).update('\n');
  const contentHash = upstreamHash.digest('hex');
  if (upstream.upstream_content_sha256 !== contentHash || upstream.revision !== `${READER}:${contentHash}`) invalid('parcel_upstream_digest');
  // Reuse the accepted capture producer to verify every snapshot, partition,
  // route and capability. A row plus one self-supplied chunk hash is insufficient.
  const rebuilt = buildCachedSourceCaptures({ scope: input.scope, captures: [{ metadata, projection, records,
    upstream: { ...upstream, content_sha256: upstream.upstream_content_sha256 } }] });
  const closure = value => ({ scope: value.scope, source_snapshots: [...value.source_snapshots].sort((a, b) => compare(a.id, b.id)),
    sources: [...value.sources].sort((a, b) => compare(a.id, b.id)), references: value.references, capability_diagnostics: value.capability_diagnostics });
  if (streamManifest(closure(rebuilt)) !== streamManifest(closure(capture))) invalid('parcel_capture_closure');
  const numericRoster = records.filter(row => row.data.attributes.account_id === input.scope.account_id).map(row => row.record_id);
  if (!same(numericRoster, claimed)) invalid('subject_roster');
  members.sort((a, b) => compare(a.record_id, b.record_id));
  return { digest: streamManifest({ version: evidence.version, reader_version: READER, captured_at: evidence.captured_at,
    subject, capture_sha256: streamManifest(closure(capture)) }), members, coordinates: geometryBudget.count,
    manifest: { captured_at: evidence.captured_at, upstream_content_sha256: contentHash,
      historical_availability: metadata.historical_availability, roster_completeness: 'whole_supplied_parcel_capture_only',
      members: members.map(({ geometry_ewkb, ...member }) => member) } };
}

function topologyOf(input, limits) {
  const topology = input.topology;
  copyJson(topology, limits.topology_bytes, false);
  const topologyLimits = keys(topology.limits, Object.keys(POSTGIS_TOPOLOGY_LIMITS), 'topology_limits');
  if (Object.entries(POSTGIS_TOPOLOGY_LIMITS).some(([key, maximum]) => !Number.isSafeInteger(topologyLimits[key])
    || topologyLimits[key] < 1 || topologyLimits[key] > maximum)) invalid('topology_limits');
  if (topology.status !== 'ready' || topology.topology_validated !== true || topology.topology_version !== POSTGIS_TOPOLOGY_VERSION
    || topology.metric_srid !== 26914 || topology.display_srid !== 4326 || !Array.isArray(topology.incomplete_reasons) || topology.incomplete_reasons.length
    || topology.topology_revision !== neighborhoodTopologyRevision(topology)) invalid('topology_manifest');
  const policy = keys(topology.performed_policy, ['version', 'requested_policy_version', 'metric_srid', 'snap_tolerance_meters',
    'source_attribution', 'source_fraction_basis', 'source_fraction_interpretation', 'source_occurrence_coverage',
    'source_witness_budgets', 'ambiguous_source_policy', 'supported_projection_window', 'noding_admission_policy',
    'minimum_cell_area_m2', 'geometry_repair', 'travel_graph'], 'topology_policy');
  text(policy.requested_policy_version, 'requested_policy_version');
  if (policy.version !== POSTGIS_TOPOLOGY_VERSION || policy.metric_srid !== 26914 || policy.snap_tolerance_meters !== 0
    || policy.geometry_repair !== 'none' || policy.travel_graph !== 'not_generated' || !same(policy.supported_projection_window, WINDOW)
    || policy.source_attribution !== 'exact_original_endpoint_and_pair_intersection_witness_chains_v1'
    || policy.source_fraction_basis !== 'source_segment' || policy.source_fraction_interpretation !== 'dominant_axis_signed_order_coordinate_v1'
    || policy.source_occurrence_coverage !== 'complete_consecutive_witness_chain_coverage_v1'
    || policy.source_witness_budgets !== 'point_incidences_2S_plus_4P_chains_S_plus_4P_v1'
    || policy.ambiguous_source_policy !== 'require_original_primitive_positive_length_overlap_v1'
    || policy.minimum_cell_area_m2 !== 1 || policy.noding_admission_policy !== 'projected-primitive-bbox-v1') invalid('topology_policy');
  const admission = topology.noding_admission;
  if (!admission || admission.policy !== policy.noding_admission_policy || admission.admitted !== true || admission.candidate_pairs_complete !== true
    || !count(admission.primitive_segments) || !admission.primitive_segments || admission.primitive_segments > topologyLimits.primitive_segments
    || !count(admission.candidate_pairs) || admission.candidate_pairs > topologyLimits.candidate_pairs
    || admission.split_pieces_upper_bound !== admission.primitive_segments + 4 * admission.candidate_pairs
    || !count(admission.original_coordinates) || admission.noded_coordinates_upper_bound !== admission.original_coordinates + 8 * admission.candidate_pairs
    || admission.original_coordinates > topology.limits.input_coordinates || admission.original_coordinates < admission.primitive_segments + 1
    || admission.candidate_pairs > admission.primitive_segments * (admission.primitive_segments - 1) / 2
    || admission.split_pieces_upper_bound > topology.limits.edges || admission.split_pieces_upper_bound > topology.limits.source_references
    || admission.noded_coordinates_upper_bound > topology.limits.edges * 4) invalid('topology_admission');
  const d = keys(topology.diagnostics, DIAGNOSTICS, 'topology_diagnostics');
  if (DIAGNOSTICS.some(key => !count(d[key])) || topology.source_coverage?.query_coverage !== 'complete'
    || topology.source_coverage.provider_coverage !== 'unknown' || topology.source_coverage.historical_coverage !== 'unknown'
    || topology.travel_connectivity !== 'not_evaluated' || d.noded_coordinate_count > topology.limits.edges * 4
    || d.source_point_incidence_count > 2 * admission.primitive_segments + 4 * admission.candidate_pairs
    || d.source_chain_count > admission.split_pieces_upper_bound || d.source_chain_count !== d.source_reference_count
    || ['invalid_source_count', 'invalid_cell_count', 'sliver_cell_count', 'unattributed_edge_count', 'uncovered_source_segment_count',
      'ambiguous_source_edge_count', 'invalid_incidence_count', 'unsupported_boundary_count', 'overlapping_cell_count',
      'invalid_source_witness_count', 'ambiguous_source_order_count'].some(key => d[key] !== 0)) invalid('topology_incomplete');
  const maps = {};
  for (const [name, prefix] of [['cells', 'cell'], ['edges', 'edge'], ['nodes', 'node']]) {
    maps[name] = new Map();
    for (const row of topology[name]) {
      // Match the frozen perimeter consumer's canonical JSON row-byte ceiling.
      // Key ordering does not change token size; precharge before serialization.
      // Source feature/alias descriptors do not use this SQL geometry-row cap.
      copyJson(row, topologyLimits.row_bytes, false);
      if (typeof row.id !== 'string' || !row.id.startsWith(`${prefix}:`) || !SHA.test(row.id.slice(prefix.length + 1))
        || typeof row.geometry_ewkb !== 'string' || !HEX.test(row.geometry_ewkb) || `${prefix}:${bytesHash(row.geometry_ewkb)}` !== row.id
        || row.metric_srid !== 26914 || maps[name].has(row.id)) invalid('topology_identity');
      maps[name].set(row.id, row);
    }
  }
  const featureIds = new Set(topology.source_features.map(row => row.feature_id));
  if (featureIds.size !== topology.source_features.length) invalid('topology_source_identity');
  const sourceParts = new Map();
  for (const feature of topology.source_features) {
    // Accepted v3 retains feature descriptors, not the original line_parts.
    // Validate the supplied part range and global primitive admission; do not
    // invent missing per-part segment counts or claim source re-extraction.
    if (!['LineString', 'MultiLineString'].includes(feature.geometry_type) || !count(feature.source_part_count)
      || !feature.source_part_count || feature.source_part_count > topology.limits.input_parts
      || (feature.geometry_type === 'LineString' && feature.source_part_count !== 1)) invalid('topology_source_descriptor');
    sourceParts.set(feature.feature_id, feature.source_part_count);
  }
  const cellEdges = new Map(), edgeCells = new Map(), degrees = new Map();
  for (const cell of maps.cells.values()) cellEdges.set(cell.id, new Set(array(cell.boundary_edge_ids, topology.limits.edges, 'cell_edges')));
  for (const edge of maps.edges.values()) edgeCells.set(edge.id, new Set(array(edge.cell_ids, 2, 'edge_cells')));
  let refs = 0;
  for (const cell of maps.cells.values()) {
    if (cell.geometry_validated !== true || !Number.isFinite(cell.area_m2) || cell.area_m2 <= 0 || !count(cell.interior_ring_count)
      || !Array.isArray(cell.boundary_edge_ids) || !cell.boundary_edge_ids.length || new Set(cell.boundary_edge_ids).size !== cell.boundary_edge_ids.length
      || cell.boundary_edge_ids.some(id => !edgeCells.get(id)?.has(cell.id))) invalid('topology_incidence');
  }
  for (const edge of maps.edges.values()) {
    if (edge.geometry_validated !== true || !Number.isFinite(edge.length_meters) || edge.length_meters <= 0
      || edge.from_node_id === edge.to_node_id || !maps.nodes.has(edge.from_node_id) || !maps.nodes.has(edge.to_node_id)
      || !Array.isArray(edge.cell_ids) || edge.cell_ids.length > 2 || new Set(edge.cell_ids).size !== edge.cell_ids.length
      || edge.cell_ids.some(id => !cellEdges.get(id)?.has(edge.id))
      || !Array.isArray(edge.source_parts) || !edge.source_parts.length) invalid('topology_incidence');
    degrees.set(edge.from_node_id, (degrees.get(edge.from_node_id) || 0) + 1);
    degrees.set(edge.to_node_id, (degrees.get(edge.to_node_id) || 0) + 1);
    const occurrences = new Set();
    for (const source of edge.source_parts) {
      const id = `${source.feature_id}:${source.source_part_index}:${source.source_segment_index}`;
      if (!featureIds.has(source.feature_id) || !count(source.source_part_index) || source.source_part_index < 1
        || !count(source.source_segment_index) || source.source_segment_index < 1 || occurrences.has(id)
        || source.source_part_index > sourceParts.get(source.feature_id)
        || source.source_segment_index > admission.primitive_segments
        || source.source_fraction_basis !== 'source_segment' || !Number.isFinite(source.start_fraction) || !Number.isFinite(source.end_fraction)
        || source.start_fraction < 0 || source.start_fraction > 1 || source.end_fraction < 0 || source.end_fraction > 1
        || source.start_fraction === source.end_fraction) invalid('topology_source_occurrence');
      occurrences.add(id); if (++refs > limits.source_occurrences) stop('input_limit_exceeded');
    }
  }
  if (topology.diagnostics.cell_count !== maps.cells.size || topology.diagnostics.edge_count !== maps.edges.size
    || topology.diagnostics.node_count !== maps.nodes.size || topology.diagnostics.source_reference_count !== refs) invalid('topology_counts');
  if ([...maps.nodes.values()].some(node => node.degree !== degrees.get(node.id))) invalid('topology_node_degree');
  return maps;
}

function selectionOf(input, maps, limits) {
  const decision = keys(input.selection, ['revision', 'scope', 'effective_date', 'knowledge_cutoff', 'topology_revision', 'source_capture_sha256', 'selected_cell_ids', 'content_sha256'], 'selection');
  text(decision.revision, 'selection_revision');
  const { content_sha256, ...manifest } = decision;
  if (!SHA.test(content_sha256) || digest(manifest) !== content_sha256 || !same(scoped(decision.scope), input.scope)
    || decision.effective_date !== input.effective_date || decision.knowledge_cutoff !== input.knowledge_cutoff
    || decision.topology_revision !== input.topology.topology_revision || decision.source_capture_sha256 !== input.topology.source_capture_sha256) invalid('selection_manifest');
  const selected = array(decision.selected_cell_ids, limits.selected_cells, 'selected_cells');
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !maps.cells.has(id))) invalid('selected_cell_ids');
  const ids = [...selected].sort(compare), set = new Set(ids);
  const selectedBudget = { count: 0, maximum: limits.selected_coordinates };
  const cells = ids.map(id => { const cell = maps.cells.get(id); decode(cell.geometry_ewkb, 26914, [3], selectedBudget, id); return { id, geometry_ewkb: cell.geometry_ewkb }; });
  const edges = [...maps.edges.values()].filter(edge => edge.cell_ids.filter(id => set.has(id)).length === 1).sort((a, b) => compare(a.id, b.id));
  if (!edges.length || edges.length > limits.perimeter_edges) stop('perimeter_limit_exceeded');
  const nodes = new Map(), adjacency = new Map(), edgePoints = new Map();
  const budget = { count: 0, maximum: limits.perimeter_coordinates };
  for (const edge of edges) {
    const points = decode(edge.geometry_ewkb, 26914, [2], budget, edge.id).coordinates;
    if (points.length !== 2) invalid('nonprimitive_boundary_edge'); edgePoints.set(edge.id, points);
    for (const [index, id] of [edge.from_node_id, edge.to_node_id].entries()) {
      if (!nodes.has(id)) nodes.set(id, decode(maps.nodes.get(id).geometry_ewkb, 26914, [1], budget, id).coordinates);
      if (!same(points[index], nodes.get(id))) invalid('boundary_endpoint');
      if (!adjacency.has(id)) adjacency.set(id, []); adjacency.get(id).push(edge);
    }
  }
  if (2 * edges.length + nodes.size !== budget.count || [...adjacency.values()].some(rows => rows.length !== 2)) stop('boundary_cycle_invalid');
  const unused = new Set(edges.map(edge => edge.id)), cycles = [], edgeCycles = new Map();
  for (const first of edges) {
    if (!unused.has(first.id)) continue;
    const segments = []; let edge = first, from = first.from_node_id;
    do {
      if (!unused.has(edge.id)) stop('boundary_cycle_invalid'); unused.delete(edge.id);
      const reversed = edge.to_node_id === from, to = reversed ? edge.from_node_id : edge.to_node_id;
      segments.push({ edge_id: edge.id, from_node_id: from, to_node_id: to, reversed });
      from = to; edge = adjacency.get(from).find(candidate => candidate.id !== edge.id);
    } while (from !== segments[0].from_node_id);
    if (segments.length < 3 || edge.id !== first.id) stop('boundary_cycle_invalid');
    const origin = nodes.get(segments[0].from_node_id);
    const signed = segments.reduce((area, segment) => { const a = nodes.get(segment.from_node_id), b = nodes.get(segment.to_node_id);
      return area + (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]); }, 0);
    if (!Number.isFinite(signed) || signed === 0) stop('boundary_cycle_invalid');
    const id = `cycle:${digest(segments.map(segment => segment.edge_id).sort(compare))}`;
    for (const segment of segments) edgeCycles.set(segment.edge_id, id);
    cycles.push({ id, signed, segments }); if (cycles.length > limits.rings) stop('perimeter_limit_exceeded');
  }
  return { ids, cells, edges, cycles, selected_coordinates: selectedBudget.count,
    boundary: edges.map(edge => ({ id: edge.id, geometry_ewkb: edge.geometry_ewkb, cycle_id: edgeCycles.get(edge.id) })) };
}

const VERSION_SQL = `SELECT postgis_lib_version() AS postgis_version,postgis_geos_version() AS geos_version,
  postgis_proj_version() AS proj_version,auth_name,auth_srid,proj4text,srtext FROM spatial_ref_sys WHERE srid=26914`;
const INPUT_SQL = `WITH cells AS MATERIALIZED (
  SELECT id,ST_GeomFromEWKB(decode(geometry_ewkb,'hex')) AS geom FROM jsonb_to_recordset($1::jsonb) AS r(id text,geometry_ewkb text)
), edges AS MATERIALIZED (
  SELECT id,cycle_id,ST_GeomFromEWKB(decode(geometry_ewkb,'hex')) AS geom FROM jsonb_to_recordset($2::jsonb) AS r(id text,geometry_ewkb text,cycle_id text)
), subjects AS MATERIALIZED (
  SELECT record_id,ST_GeomFromEWKB(decode(geometry_ewkb,'hex')) AS original,
    ST_Transform(ST_GeomFromEWKB(decode(geometry_ewkb,'hex')),26914) AS geom
  FROM jsonb_to_recordset($3::jsonb) AS r(record_id text,geometry_ewkb text)
)`;
const extent = geom => `(ST_XMin(Box2D(${geom}))>=-98.5 AND ST_XMax(Box2D(${geom}))<=-95.5
  AND ST_YMin(Box2D(${geom}))>=31 AND ST_YMax(Box2D(${geom}))<=34.5)`;
const ADMISSION_SQL = `${INPUT_SQL}, cell_checks AS MATERIALIZED (
  SELECT *,ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND GeometryType(geom)='POLYGON' AND ST_SRID(geom)=26914
    AND ST_NDims(geom)=2 AND ST_Area(geom)>0 AND ${extent('ST_Transform(geom,4326)')} AS valid FROM cells
), subject_checks AS MATERIALIZED (
  SELECT *,ST_IsValid(original) AND ST_IsValid(geom) AND NOT ST_IsEmpty(original) AND NOT ST_IsEmpty(geom)
    AND GeometryType(original) IN ('POLYGON','MULTIPOLYGON') AND ST_SRID(original)=4326 AND ST_NDims(original)=2
    AND ST_Area(geom)>0 AND ${extent('original')} AS valid FROM subjects
), selected_overlap_pairs AS (
  SELECT 1 FROM cell_checks a JOIN cell_checks b ON a.id<b.id AND a.geom && b.geom
  WHERE NOT EXISTS(SELECT 1 FROM cell_checks WHERE valid IS DISTINCT FROM true)
    AND ST_Relate(a.geom,b.geom,'2********') LIMIT 1
) SELECT (SELECT count(*)::integer FROM cells) AS selected_count,
  (SELECT count(*)::integer FROM subjects) AS subject_count,(SELECT count(*)::integer FROM edges) AS boundary_edge_count,
  (SELECT COALESCE(sum(ST_NPoints(geom)),0)::integer FROM cells) AS selected_coordinates,
  (SELECT COALESCE(sum(ST_NPoints(original)),0)::integer FROM subjects) AS subject_coordinates,
  (SELECT count(*)::integer FROM cell_checks WHERE valid IS DISTINCT FROM true) AS invalid_selected_count,
  (SELECT count(*)::integer FROM subject_checks WHERE valid IS DISTINCT FROM true) AS invalid_subject_count,
  (SELECT count(*)::integer FROM edges WHERE (ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND GeometryType(geom)='LINESTRING'
    AND ST_SRID(geom)=26914 AND ST_NDims(geom)=2 AND ST_NPoints(geom)=2 AND ST_Length(geom)>0) IS DISTINCT FROM true) AS invalid_edge_count,
  (SELECT count(*)::integer FROM selected_overlap_pairs) AS overlap_pair_count`;
function buildSql(limits) {
  return `${INPUT_SQL}, dissolved AS MATERIALIZED (
    SELECT ST_Normalize(ST_UnaryUnion(ST_Collect(geom ORDER BY id))) AS geom FROM cells
  ), usable AS MATERIALIZED (
    SELECT geom FROM dissolved WHERE ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND GeometryType(geom)='POLYGON'
      AND ST_SRID(geom)=26914 AND ST_NDims(geom)=2 AND ST_Area(geom)>0
  ), perimeter AS MATERIALIZED (SELECT ST_UnaryUnion(ST_Collect(geom ORDER BY id)) AS geom FROM edges),
  cycles AS MATERIALIZED (SELECT cycle_id,ST_UnaryUnion(ST_Collect(geom ORDER BY id)) AS geom FROM edges GROUP BY cycle_id),
  rings AS MATERIALIZED (
    SELECT 0 AS index,ST_ExteriorRing(geom) AS geom FROM usable
    UNION ALL SELECT i,ST_InteriorRingN(u.geom,i) FROM usable u CROSS JOIN LATERAL generate_series(1,ST_NumInteriorRings(u.geom)) i
  ), roles AS MATERIALIZED (
    SELECT c.cycle_id,r.index>0 AS interior FROM cycles c JOIN rings r ON ST_Equals(c.geom,r.geom)
  ), coverage AS MATERIALIZED (
    SELECT s.*,ST_Covers(u.geom,s.geom) AS covered FROM subjects s CROSS JOIN usable u
  ), points AS MATERIALIZED (
    SELECT record_id,geom,ST_PointOnSurface(ST_Normalize(geom)) AS point FROM coverage WHERE covered
  ), anchor AS MATERIALIZED (
    SELECT p.record_id,p.point,ST_Contains(p.geom,p.point) AS inside_subject,ST_Contains(u.geom,p.point) AS inside_union
    FROM points p CROSS JOIN usable u WHERE ST_Contains(p.geom,p.point) AND ST_Contains(u.geom,p.point)
    ORDER BY p.record_id COLLATE "C" LIMIT 1
  ), result AS (
    SELECT jsonb_build_object('union_valid',EXISTS(SELECT 1 FROM usable),'connected',EXISTS(SELECT 1 FROM usable),
      'hole_count',(SELECT ST_NumInteriorRings(geom) FROM usable),
      'boundary_equals',COALESCE((SELECT ST_Equals(ST_Boundary(u.geom),p.geom) FROM usable u CROSS JOIN perimeter p),false),
      'cycle_roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('cycle_id',cycle_id,'interior',interior) ORDER BY cycle_id) FROM roles),'[]'::jsonb),
      'all_subject_covered',COALESCE((SELECT bool_and(covered) FROM coverage),false),
      'covered_subject_count',(SELECT count(*)::integer FROM coverage WHERE covered),
      'anchor',(SELECT jsonb_build_object('member_record_id',record_id,'coordinates',jsonb_build_array(ST_X(point),ST_Y(point)),
        'inside_subject',inside_subject,'inside_union',inside_union) FROM anchor),
      'geometry',(SELECT ST_AsGeoJSON(ST_ForcePolygonCCW(ST_Transform(geom,4326)),15,0)::jsonb FROM usable),
      'geometry_ewkb',(SELECT encode(ST_AsEWKB(geom,'NDR'),'hex') FROM usable),
      'area_m2',(SELECT ST_Area(geom) FROM usable),'perimeter_meters',(SELECT ST_Perimeter(geom) FROM usable),
      'output_coordinates',(SELECT ST_NPoints(geom)::integer FROM usable))::text AS payload_json
  ) SELECT CASE WHEN octet_length(payload_json)<=${limits.output_bytes} THEN payload_json END AS payload_json,
    octet_length(payload_json)::integer AS payload_bytes FROM result`;
}

function versionsOf(row, topology) {
  if (!row || row.auth_name !== 'EPSG' || row.auth_srid !== 26914 || typeof row.proj4text !== 'string' || typeof row.srtext !== 'string'
    || !/(?:^|\s)\+proj=utm(?:\s|$)/.test(row.proj4text) || !/(?:^|\s)\+zone=14(?:\s|$)/.test(row.proj4text)
    || !/(?:^|\s)\+datum=NAD83(?:\s|$)/.test(row.proj4text) || !/(?:^|\s)\+units=m(?:\s|$)/.test(row.proj4text)
    || !/UNIT\["(?:metre|meter)",1(?:\]|,)/i.test(row.srtext)) stop('unsupported_projection_policy');
  for (const key of ['postgis_version', 'geos_version', 'proj_version']) if (typeof row[key] !== 'string' || !row[key] || row[key].length > 256) stop('engine_version_unavailable');
  const result = { postgis: row.postgis_version, geos: row.geos_version, proj: row.proj_version,
    spatial_reference_sha256: digest({ proj4text: row.proj4text, srtext: row.srtext }) };
  if (!same(result, topology.engine_versions)) stop('topology_engine_version_mismatch'); return result;
}
function release(client, error) {
  try { const result = client.release(error); if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); return false; } return true; }
  catch { return false; }
}
async function connect(pool, timeout) {
  let expired = false, timer;
  const pending = Promise.resolve().then(() => pool.connect()).then(client => { if (expired) { release(client, true); stop('connection_timeout'); } return client; });
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => {
    expired = true; const error = new Error('neighborhood_selected_boundary_incomplete'); failures.set(error, 'connection_timeout'); reject(error);
  }, timeout); })]); } finally { clearTimeout(timer); }
}

/** Geometry-only local seam. Callers must supply authorized immutable server
 * evidence and an already-bounded pool. No provider, schema, persistent write,
 * scoring, report eligibility or signing authority is implemented here. Native
 * acceptance is deliberately a later independent gate, not proved by mocks. */
export function createNeighborhoodSelectedBoundary(pool, options = {}) {
  let safeOptions;
  try { safeOptions = copyJson(options, 16_384).value; }
  catch (error) { if (invalidErrors.has(error)) throw error; invalid('options_limit'); }
  if (!safeOptions || typeof safeOptions !== 'object' || Object.getPrototypeOf(safeOptions) !== Object.prototype
    || Object.keys(safeOptions).some(key => key !== 'limits')) invalid('options');
  if (!pool || typeof pool.connect !== 'function') invalid('pool');
  const limits = limitsOf(safeOptions.limits);
  return { async validate(raw) {
    let input, subject, selection, maps, engineVersions = null, client, begun = false, releaseError, result, reason;
    const started = performance.now();
    const check = () => { if (performance.now() - started >= limits.total_ms) stop('duration_limit'); };
    const query = async (tag, sql, values = []) => {
      check(); const remaining = Math.max(1, Math.min(limits.statement_ms + 1000, Math.floor(limits.total_ms - (performance.now() - started))));
      const value = await client.query({ text: `/* neighborhood-selected-boundary:${tag} */ ${sql}`, values, query_timeout: remaining });
      check();
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.rows)) stop('invalid_native_result');
      return value.rows;
    };
    try {
      input = copyJson(raw, limits.input_bytes).value;
      keys(input, ['version', 'scope', 'effective_date', 'knowledge_cutoff', 'topology', 'selection', 'subject_evidence'], 'input');
      if (input.version !== 1) invalid('version'); scoped(input.scope);
      assessmentDate(input.effective_date); timestamp(input.knowledge_cutoff, 'knowledge_cutoff');
      maps = topologyOf(input, limits); selection = selectionOf(input, maps, limits); subject = subjectOf(input, limits); check();
    } catch (error) {
      if (invalidErrors.has(error)) throw error;
      if (!failures.has(error)) throw new TypeError('invalid_neighborhood_selected_boundary:input_evidence');
      reason = failures.get(error);
    }
    if (!reason) try {
      client = await connect(pool, Math.min(limits.connect_ms, Math.max(1, limits.total_ms - (performance.now() - started))));
      begun = true; await query('begin', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // A single statement retains pg's single QueryResult shape. Multiple SET
      // commands return QueryResult[], which must not bypass strict row checks.
      await query('settings', `SELECT pg_catalog.set_config('statement_timeout',$1,true),
        pg_catalog.set_config('lock_timeout',$2,true),
        pg_catalog.set_config('idle_in_transaction_session_timeout',$3,true)`, [`${limits.statement_ms}ms`, '1000ms', '10000ms']);
      const versions = await query('versions', VERSION_SQL); if (versions.length !== 1) stop('unsupported_projection_policy');
      engineVersions = versionsOf(versions[0], input.topology);
      const parameters = [canonicalAssessmentJson(selection.cells), canonicalAssessmentJson(selection.boundary),
        canonicalAssessmentJson(subject.members.map(({ record_id, geometry_ewkb }) => ({ record_id, geometry_ewkb })))];
      const admitted = await query('admission', ADMISSION_SQL, parameters);
      const fields = ['selected_count', 'subject_count', 'boundary_edge_count', 'selected_coordinates', 'subject_coordinates',
        'invalid_selected_count', 'invalid_subject_count', 'invalid_edge_count', 'overlap_pair_count'];
      if (admitted.length !== 1 || Object.keys(admitted[0]).length !== fields.length || fields.some(key => !count(admitted[0][key]))) stop('invalid_native_result');
      const a = admitted[0];
      if (a.selected_count !== selection.cells.length || a.subject_count !== subject.members.length || a.boundary_edge_count !== selection.edges.length
        || a.selected_coordinates !== selection.selected_coordinates || a.subject_coordinates !== subject.coordinates) stop('invalid_native_result');
      if (a.invalid_selected_count || a.invalid_subject_count || a.invalid_edge_count) stop('invalid_native_geometry');
      if (a.overlap_pair_count) stop('selected_interiors_overlap');
      const rows = await query('build', buildSql(limits), parameters);
      if (rows.length !== 1 || !count(rows[0].payload_bytes) || rows[0].payload_bytes > limits.output_bytes
        || typeof rows[0].payload_json !== 'string' || Buffer.byteLength(rows[0].payload_json) !== rows[0].payload_bytes) stop('output_limit_exceeded');
      let payload; try { payload = JSON.parse(rows[0].payload_json); } catch { stop('invalid_native_result'); }
      copyJson(payload, limits.output_bytes, false);
      keys(payload, ['union_valid', 'connected', 'hole_count', 'boundary_equals', 'cycle_roles', 'all_subject_covered', 'covered_subject_count',
        'anchor', 'geometry', 'geometry_ewkb', 'area_m2', 'perimeter_meters', 'output_coordinates'], 'native_payload');
      if (payload.union_valid !== true || payload.connected !== true) stop('selected_union_not_connected_polygon');
      if (payload.boundary_equals !== true) stop('boundary_spatial_mismatch');
      if (payload.all_subject_covered !== true || payload.covered_subject_count !== subject.members.length) stop('subject_not_wholly_covered');
      if (!count(payload.hole_count) || payload.hole_count + 1 !== selection.cycles.length || payload.cycle_roles.length !== selection.cycles.length) stop('boundary_cycle_invalid');
      if (!payload.anchor || !subject.members.some(member => member.record_id === payload.anchor.member_record_id)
        || payload.anchor.inside_subject !== true || payload.anchor.inside_union !== true || !Array.isArray(payload.anchor.coordinates)
        || payload.anchor.coordinates.length !== 2 || payload.anchor.coordinates.some(value => !Number.isFinite(value) || Math.abs(value) > 20_000_000)) stop('label_anchor_incomplete');
      const outputBudget = { count: 0, maximum: limits.selected_coordinates };
      const metric = decode(payload.geometry_ewkb, 26914, [3], outputBudget);
      if (payload.output_coordinates !== outputBudget.count || metric.coordinates.length !== payload.hole_count + 1
        || !Number.isFinite(payload.area_m2) || payload.area_m2 <= 0 || !Number.isFinite(payload.perimeter_meters) || payload.perimeter_meters <= 0
        || payload.geometry?.type !== 'Polygon' || !Array.isArray(payload.geometry.coordinates)
        || payload.geometry.coordinates.length !== metric.coordinates.length) stop('invalid_native_result');
      let displayCount = 0;
      for (const ring of payload.geometry.coordinates) {
        if (!Array.isArray(ring) || ring.length < 4 || !same(ring[0], ring.at(-1))) stop('invalid_native_result');
        for (const point of ring) {
          if (++displayCount > limits.selected_coordinates || !Array.isArray(point) || point.length !== 2 || point.some(value => !Number.isFinite(value))
            || point[0] < WINDOW[0] || point[0] > WINDOW[2] || point[1] < WINDOW[1] || point[1] > WINDOW[3]) stop('invalid_native_result');
        }
      }
      if (displayCount !== outputBudget.count) stop('invalid_native_result');
      const roles = new Map(payload.cycle_roles.map(row => [row.cycle_id, row.interior]));
      if (roles.size !== selection.cycles.length || [...roles.values()].some(value => typeof value !== 'boolean')
        || [...roles.values()].filter(value => !value).length !== 1) stop('boundary_cycle_invalid');
      const rings = selection.cycles.map(cycle => {
        if (!roles.has(cycle.id)) stop('boundary_cycle_invalid'); const interior = roles.get(cycle.id);
        let segments = cycle.segments;
        if ((cycle.signed > 0) === interior) segments = [...segments].reverse().map(segment => ({ edge_id: segment.edge_id,
          from_node_id: segment.to_node_id, to_node_id: segment.from_node_id, reversed: !segment.reversed }));
        const first = segments.reduce((best, segment, index) => compare(segment.edge_id, segments[best].edge_id) < 0 ? index : best, 0);
        return { ring_id: cycle.id, orientation: interior ? 'clockwise' : 'counterclockwise', segments: [...segments.slice(first), ...segments.slice(0, first)] };
      });
      const geometry = { metric_srid: 26914, display_srid: 4326, geometry: payload.geometry, geometry_ewkb: payload.geometry_ewkb,
        geometry_ewkb_sha256: bytesHash(payload.geometry_ewkb), geometry_sha256: digest(payload.geometry) };
      const validationRevision = `validation:${digest({ method: METHOD, engine_versions: engineVersions, topology_revision: input.topology.topology_revision,
        selection_sha256: input.selection.content_sha256, subject_evidence_sha256: subject.digest, geometry,
        cycles: rings, anchor: payload.anchor, scope: input.scope, effective_date: input.effective_date, knowledge_cutoff: input.knowledge_cutoff })}`;
      const boundary = { revision: `boundary:${digest({ validation_revision: validationRevision })}`, scope: input.scope,
        effective_date: input.effective_date, knowledge_cutoff: input.knowledge_cutoff, topology_revision: input.topology.topology_revision,
        source_capture_sha256: input.topology.source_capture_sha256, geometry_sha256: geometry.geometry_sha256, selected_cell_ids: selection.ids,
        validation: { valid: true, connected: true, contains_subject: true, engine: SELECTED_BOUNDARY_VERSION, revision: validationRevision },
        exterior: rings.find(ring => ring.orientation === 'counterclockwise'), interiors: rings.filter(ring => ring.orientation === 'clockwise').sort((a, b) => compare(a.ring_id, b.ring_id)),
        label_anchor: { metric_srid: 26914, coordinates: payload.anchor.coordinates, basis: 'validated_subject_interior_point', validation_revision: validationRevision } };
      boundary.content_sha256 = digest(boundary);
      result = { status: 'ready', version: SELECTED_BOUNDARY_VERSION, scope: input.scope, effective_date: input.effective_date,
        knowledge_cutoff: input.knowledge_cutoff, topology_revision: input.topology.topology_revision, selection_sha256: input.selection.content_sha256,
        subject_evidence_sha256: subject.digest, engine_versions: engineVersions, method: METHOD, geometry, subject_manifest: subject.manifest,
        boundary_source_occurrences: selection.edges.map(edge => ({ edge_id: edge.id, source_parts: edge.source_parts })),
        selected_boundary: boundary, incomplete_reasons: [], authority_limitations: LIMITATIONS, limits };
      if (copyJson(result, limits.output_bytes, false).bytes > limits.output_bytes) stop('output_limit_exceeded');
      await query('commit', 'COMMIT'); begun = false; check();
    } catch (error) {
      reason = failures.get(error) || 'native_query_unavailable';
      if (begun && client) try { await client.query({ text: 'ROLLBACK', query_timeout: Math.min(limits.statement_ms + 1000, 6000) }); }
      catch { releaseError = new Error('neighborhood_selected_boundary_rollback_failed'); }
    } finally {
      if (client && !release(client, releaseError) && !reason) reason = 'connection_release_failed';
    }
    if (reason) {
      result = { status: 'incomplete', version: SELECTED_BOUNDARY_VERSION, geometry: null, subject_manifest: null,
        selected_boundary: null, boundary_source_occurrences: [], incomplete_reasons: [reason], metadata_not_returned: true,
        authority_limitations: LIMITATIONS, failure_control_budget_bytes: SELECTED_BOUNDARY_ERROR_LIMIT_BYTES };
      if (Buffer.byteLength(JSON.stringify(result)) > SELECTED_BOUNDARY_ERROR_LIMIT_BYTES) invalid('failure_control');
    }
    return freeze(result);
  } };
}
