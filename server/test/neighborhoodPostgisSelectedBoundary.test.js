import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createNeighborhoodSelectedBoundary, SELECTED_BOUNDARY_VERSION } from '../src/services/neighborhoodAssessment/postgisSelectedBoundary.js';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodTopologyRevision } from '../src/services/neighborhoodAssessment/postgisTopology.js';
import { makeSelectedBoundaryInput, makeSubjectEvidence, makeMockSelectedBoundaryTopology, makeMockSelectedBoundaryOracle,
  polygonEwkbHex, multiPolygonEwkbHex } from './fixtures/neighborhoodSelectedBoundaryFixture.js';

// Mocked admission/lifecycle assertions only. No pg import or database helper:
// these rows cannot establish native union, containment or source authority.
const PRIVATE_ERROR = 'private-driver-detail-never-export-this';
const AUTHORITY_LIMITATIONS = ['source_authenticity_not_verified', 'selection_ranking_not_assessed',
  'parcel_identity_not_authenticated', 'provider_wide_completeness_unknown', 'historical_availability_not_promoted',
  'report_eligibility_not_assessed', 'competitive_market_not_assessed', 'original_source_segment_counts_not_revalidated',
  'native_acceptance_gate_not_completed'];
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const versions = () => ({ postgis_version: '3.5.2', geos_version: '3.9.0-CAPI-1.14.1', proj_version: '9.5.1',
  auth_name: 'EPSG', auth_srid: 26914, proj4text: '+proj=utm +zone=14 +datum=NAD83 +units=m +no_defs',
  srtext: 'PROJCS["NAD83 / UTM zone 14N",UNIT["metre",1,AUTHORITY["EPSG","9001"]]]' });
function ewkbPointCount(hex) {
  const buffer = Buffer.from(hex, 'hex'); let offset = 0;
  const geometry = () => {
    const little = buffer[offset++] === 1;
    const integer = () => { const value = little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset); offset += 4; return value; };
    const flags = integer(), type = flags & 0x0fffffff;
    if (flags & 0x20000000) integer();
    assert.equal(flags & 0xc0000000, 0, 'synthetic test decoder supports exact2D only');
    if (type === 1) { offset += 16; return 1; }
    if (type === 2) { const count = integer(); offset += count * 16; return count; }
    if (type === 3) { const rings = integer(); let points = 0; for (let i = 0; i < rings; i++) { const count = integer(); offset += count * 16; points += count; } return points; }
    if (type === 6) { const parts = integer(); let points = 0; for (let i = 0; i < parts; i++) points += geometry(); return points; }
    throw new Error('unsupported_synthetic_ewkb');
  };
  const count = geometry(); assert.equal(offset, buffer.length); return count;
}
function geometryGroups(config) {
  const arrays = config.values.map(value => {
    if (typeof value !== 'string') return [];
    try { const decoded = JSON.parse(value); return Array.isArray(decoded) ? decoded : []; } catch { return []; }
  });
  return { selected: arrays.find(rows => rows[0]?.id?.startsWith('cell:')) ?? [],
    boundary: arrays.find(rows => rows[0]?.id?.startsWith('edge:')) ?? [],
    subjects: arrays.find(rows => typeof rows[0]?.record_id === 'string') ?? [] };
}
function settingsQueryResult(config) {
  // Model the driver's result cardinality, not a database execution. The old
  // semicolon-separated SET sequence produces QueryResult[], with no .rows.
  const sql = config.text.replace(/^\s*\/\*[^]*?\*\//, '').trim();
  const statements = sql.split(';').filter(statement => statement.trim());
  const result = command => ({ command, rowCount: command === 'SELECT' ? 1 : null, oid: null,
    fields: [], rows: command === 'SELECT' ? [{ set_config: config.values.at(-1) }] : [] });
  return statements.length > 1 ? statements.map(() => result('SET'))
    : result(/^SELECT\b/i.test(sql) ? 'SELECT' : 'SET');
}
function mock({ input = makeSelectedBoundaryInput(), version = versions(), admission, payload, mutateWrapper, oracle,
  failAt, driverError, rollbackFails = false, releaseFails = false, onQuery, settingsResult } = {}) {
  input = clone(input);
  // Bind the explicitly synthetic graph to this test's simulated engine row.
  // This is never done to real native artifacts; changed version responses
  // below remain unbound so the engine-mismatch gate is actually exercised.
  if (input.topology.engine_versions.postgis === 'synthetic-mock-not-executed') {
    const row = versions();
    input.topology.engine_versions = { postgis: row.postgis_version, geos: row.geos_version, proj: row.proj_version,
      spatial_reference_sha256: assessmentEvidenceDigest({ proj4text: row.proj4text, srtext: row.srtext }) };
    rehashTopology(input);
  }
  const calls = [], released = []; let connections = 0;
  const client = {
    release(error) { released.push(error); if (releaseFails) throw new Error(PRIVATE_ERROR); },
    async query(config) {
      calls.push(config);
      const tag = /neighborhood-selected-boundary:(\w+)/.exec(config.text)?.[1] ?? config.text.trim().toLowerCase();
      onQuery?.(tag, config);
      if (tag === failAt || (tag === 'rollback' && rollbackFails)) throw driverError ?? new Error(PRIVATE_ERROR);
      if (tag === 'settings') return settingsResult ?? settingsQueryResult(config);
      if (tag === 'versions') return { rows: [clone(version)] };
      if (tag === 'admission') {
        const groups = geometryGroups(config);
        return { rows: [{ selected_count: groups.selected.length, subject_count: groups.subjects.length,
          boundary_edge_count: groups.boundary.length,
          selected_coordinates: groups.selected.reduce((sum, row) => sum + ewkbPointCount(row.geometry_ewkb), 0),
          subject_coordinates: groups.subjects.reduce((sum, row) => sum + ewkbPointCount(row.geometry_ewkb), 0),
          invalid_selected_count: 0, invalid_subject_count: 0, invalid_edge_count: 0, overlap_pair_count: 0,
          ...clone(admission ?? {}) }] };
      }
      if (tag === 'build') {
        const { boundary, subjects } = geometryGroups(config);
        const selected = input.topology.cells.filter(row => input.selection.selected_cell_ids.includes(row.id));
        const first = selected[0], union = oracle ?? first;
        const defaults = { union_valid: true, connected: true, hole_count: 0, boundary_equals: true,
          cycle_roles: [...new Set(boundary.map(row => row.cycle_id))].map(cycle_id => ({ cycle_id, interior: false })),
          all_subject_covered: true, covered_subject_count: subjects.length,
          anchor: { member_record_id: subjects.find(row => row.record_id === 'dcad_parcels:2')?.record_id ?? subjects[0]?.record_id,
            coordinates: [700015, 3600015], inside_subject: true, inside_union: true },
          geometry: clone(union.geometry), geometry_ewkb: union.geometry_ewkb,
          area_m2: oracle?.area_m2 ?? selected.reduce((sum, row) => sum + row.area_m2, 0),
          perimeter_meters: boundary.reduce((sum, row) => sum + input.topology.edges.find(edge => edge.id === row.id).length_meters, 0),
          output_coordinates: ewkbPointCount(union.geometry_ewkb) };
        if (typeof payload === 'function') payload(defaults, config); else Object.assign(defaults, clone(payload ?? {}));
        const payload_json = JSON.stringify(defaults);
        const wrapper = { payload_json, payload_bytes: Buffer.byteLength(payload_json, 'utf8') };
        mutateWrapper?.(wrapper); return { rows: [wrapper] };
      }
      return { rows: [] };
    },
  };
  const pool = { async connect() { connections++; if (failAt === 'connect') throw driverError ?? new Error(PRIVATE_ERROR); return client; } };
  return { input, pool, calls, client, released, get connections() { return connections; } };
}
async function runMock(options = {}, limits) {
  const context = mock(options);
  const output = await createNeighborhoodSelectedBoundary(context.pool, limits === undefined ? {} : { limits }).validate(context.input);
  return { context, output };
}
const queryTag = call => /neighborhood-selected-boundary:(\w+)/.exec(call.text)?.[1] ?? call.text.trim().toLowerCase();
function rehashSelection(input) {
  const { content_sha256: _digest, ...manifest } = input.selection;
  input.selection.content_sha256 = assessmentEvidenceDigest(manifest);
}
function rehashTopology(input) {
  input.topology.topology_revision = neighborhoodTopologyRevision(input.topology);
  input.selection.topology_revision = input.topology.topology_revision;
  rehashSelection(input);
}
function rebindSubjectChunks(evidence, { upstream = false, metadata = false } = {}) {
  const capture = evidence.capture;
  if (upstream) {
    const ordered = capture.sources.flatMap(source => source.payload.records).toSorted((a, b) => {
      const left = BigInt(a.data.feature.object_id), right = BigInt(b.data.feature.object_id); return left < right ? -1 : left > right ? 1 : 0;
    });
    const digest = createHash('sha256').update(canonicalAssessmentJson(capture.sources[0].payload.projection.definition)).update('\n');
    ordered.forEach(row => digest.update(canonicalAssessmentJson(row)).update('\n'));
    const hash = digest.digest('hex');
    for (const source of capture.sources) {
      source.payload.upstream.upstream_content_sha256 = hash;
      source.payload.upstream.revision = `${evidence.reader_version}:${hash}`;
    }
  }
  const replacement = new Map();
  for (const source of capture.sources) {
    const old = source.id, digest = assessmentEvidenceDigest(source.payload);
    source.id = `${source.payload.metadata.id}:${digest}`; replacement.set(old, source.id);
    const snapshot = capture.source_snapshots.find(row => row.id === old);
    if (snapshot) {
      if (metadata) { const { id: _id, ...fields } = source.payload.metadata; Object.assign(snapshot, fields); }
      snapshot.id = source.id; snapshot.content_sha256 = digest;
    }
  }
  for (const routing of capture.references) {
    routing.source_refs = routing.source_refs.map(id => replacement.get(id) ?? id);
    routing.record_sources.forEach(row => { row.source_ref = replacement.get(row.source_ref) ?? row.source_ref; });
  }
  for (const capability of capture.capability_diagnostics)
    capability.source_refs = capability.source_refs.map(id => replacement.get(id) ?? id);
}
function atomicFailure(output) {
  assert.equal(output.status, 'incomplete');
  assert.equal(output.geometry, null); assert.equal(output.selected_boundary, null);
  assert.equal(output.subject_manifest, null); assert.deepEqual(output.boundary_source_occurrences, []);
  assert.ok(Array.isArray(output.incomplete_reasons) && output.incomplete_reasons.length > 0);
  const encoded = JSON.stringify(output);
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= 16384);
  assert.equal(encoded.includes(PRIVATE_ERROR), false);
  for (const key of ['topology', 'subject_evidence', 'cells', 'edges', 'nodes', 'sources'])
    assert.equal(Object.hasOwn(output, key), false, `no retained ${key} on failure`);
}
async function deniedBeforeConnection(input, limits) {
  let connections = 0;
  const pool = { async connect() { connections++; throw new Error(PRIVATE_ERROR); } };
  let output; let error;
  try { output = await createNeighborhoodSelectedBoundary(pool, limits === undefined ? {} : { limits }).validate(input); }
  catch (caught) { error = caught; }
  assert.equal(connections, 0, 'invalid supplied evidence must not acquire a database client');
  if (error) {
    assert.ok(error instanceof TypeError); assert.match(error.message, /^invalid_[a-z_]+:/);
    assert.equal(error.message.includes(PRIVATE_ERROR), false);
  } else atomicFailure(output);
}

test('selected boundary: valid synthetic proof reaches native checks and yields only mathematical authority', async () => {
  const context = mock(), original = clone(context.input);
  const output = await createNeighborhoodSelectedBoundary(context.pool).validate(context.input);
  assert.equal(output.status, 'ready', JSON.stringify(output.incomplete_reasons));
  assert.equal(output.version, SELECTED_BOUNDARY_VERSION);
  assert.equal(SELECTED_BOUNDARY_VERSION, 'postgis-selected-boundary-v1');
  assert.deepEqual(context.input, original, 'the caller evidence is never mutated');
  assert.deepEqual(output.authority_limitations, AUTHORITY_LIMITATIONS);
  assert.deepEqual(output.incomplete_reasons, []);
  assert.deepEqual(output.scope, original.scope);
  assert.equal(output.effective_date, original.effective_date); assert.equal(output.knowledge_cutoff, original.knowledge_cutoff);
  assert.equal(output.selection_sha256, original.selection.content_sha256);
  assert.equal(output.topology_revision, original.topology.topology_revision);
  assert.match(output.subject_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(output.geometry.metric_srid, 26914); assert.equal(output.geometry.display_srid, 4326);
  assert.equal(output.geometry.geometry_ewkb_sha256, hashBytes(Buffer.from(output.geometry.geometry_ewkb, 'hex')));
  assert.equal(output.geometry.geometry_sha256, assessmentEvidenceDigest(output.geometry.geometry));
  assert.notEqual(output.geometry.geometry_sha256, output.geometry.geometry_ewkb_sha256);
  assert.deepEqual(output.subject_manifest.members.map(row => row.record_id).sort(), original.subject_evidence.subject.member_record_ids.toSorted());
  assert.ok(output.subject_manifest.members.every(row => /^[a-f0-9]{64}$/.test(row.record_sha256)
    && /^[a-f0-9]{64}$/.test(row.geometry_ewkb_sha256)));
  assert.equal(output.subject_manifest.historical_availability, 'unknown');
  assert.equal(output.subject_manifest.roster_completeness, 'whole_supplied_parcel_capture_only');
  const boundary = output.selected_boundary;
  assert.deepEqual(Object.keys(boundary).sort(), ['revision', 'scope', 'effective_date', 'knowledge_cutoff', 'topology_revision',
    'source_capture_sha256', 'geometry_sha256', 'selected_cell_ids', 'validation', 'exterior', 'interiors', 'label_anchor', 'content_sha256'].sort());
  assert.equal(boundary.source_capture_sha256, original.topology.source_capture_sha256);
  assert.equal(boundary.geometry_sha256, output.geometry.geometry_sha256);
  assert.deepEqual(boundary.selected_cell_ids, original.selection.selected_cell_ids.toSorted());
  assert.deepEqual(Object.keys(boundary.validation).sort(), ['valid', 'connected', 'contains_subject', 'engine', 'revision'].sort());
  assert.equal(boundary.validation.valid, true); assert.equal(boundary.validation.connected, true); assert.equal(boundary.validation.contains_subject, true);
  assert.equal(boundary.label_anchor.validation_revision, boundary.validation.revision);
  assert.equal(boundary.label_anchor.basis, 'validated_subject_interior_point');
  const { content_sha256, ...manifest } = boundary;
  assert.equal(content_sha256, assessmentEvidenceDigest(manifest));
  assert.equal(boundary.exterior.orientation, 'counterclockwise'); assert.deepEqual(boundary.interiors, []);
  assert.equal(boundary.exterior.segments.length, 4);
  for (const segment of boundary.exterior.segments)
    assert.deepEqual(Object.keys(segment).sort(), ['edge_id', 'from_node_id', 'to_node_id', 'reversed'].sort());
  assert.equal(boundary.exterior.segments[0].edge_id, boundary.exterior.segments.map(row => row.edge_id).toSorted()[0]);
  for (const row of output.boundary_source_occurrences)
    assert.deepEqual(row.source_parts, original.topology.edges.find(edge => edge.id === row.edge_id).source_parts);
  assert.ok(Object.isFrozen(output) && Object.isFrozen(boundary.exterior.segments[0]));
  assert.equal(context.connections, 1); assert.equal(context.released.length, 1); assert.equal(context.released[0], undefined);
  const tags = context.calls.map(queryTag);
  for (const tag of ['begin', 'settings', 'versions', 'admission', 'build', 'commit']) assert.ok(tags.includes(tag), tag);
  assert.ok(tags.indexOf('admission') < tags.indexOf('build')); assert.equal(tags.includes('rollback'), false);
  assert.match(context.calls.find(call => queryTag(call) === 'begin').text, /READ ONLY/i);
  assert.ok(context.calls.every(call => Array.isArray(call.values) && Number.isFinite(call.query_timeout) && call.query_timeout > 0));
  for (const call of context.calls) {
    assert.doesNotMatch(call.text, /\b(CREATE|INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\s/i);
    assert.doesNotMatch(call.text, /ST_(MakeValid|Snap|SnapToGrid|Buffer|ConvexHull)\s*\(/i);
  }
});

test('selected boundary: malformed context and exact selection bindings fail before any connection', async () => {
  for (const [name, mutate] of [
    ['input version', input => { input.version = 2; }],
    ['unknown input key', input => { input.ranking_score = 100; }],
    ['rolled effective date', input => { input.effective_date = '2026-02-31'; }],
    ['invalid cutoff', input => { input.knowledge_cutoff = '2026-09-05'; }],
    ['organization', input => { input.scope.organization_id = '00000000-0000-4000-8000-000000000999'; }],
    ['case', input => { input.scope.appraisal_case_id = '00000000-0000-4000-8000-000000000999'; }],
    ['subject snapshot', input => { input.scope.subject_snapshot_id = '00000000-0000-4000-8000-000000000999'; }],
    ['account', input => { input.scope.account_id = 'unrelated-account'; }],
    ['selection old digest', input => { input.selection.revision += '-changed'; }],
    ['selection foreign context rehashed', input => { input.selection.scope.account_id = 'foreign'; rehashSelection(input); }],
    ['selection changed date rehashed', input => { input.selection.effective_date = '2024-01-01'; rehashSelection(input); }],
    ['selection changed cutoff rehashed', input => { input.selection.knowledge_cutoff = '2024-01-01T00:00:00.000Z'; rehashSelection(input); }],
    ['selection foreign topology rehashed', input => { input.selection.topology_revision = `topology:${'f'.repeat(64)}`; rehashSelection(input); }],
    ['selection foreign source rehashed', input => { input.selection.source_capture_sha256 = 'f'.repeat(64); rehashSelection(input); }],
    ['duplicate selected ID', input => { input.selection.selected_cell_ids.push(input.selection.selected_cell_ids[0]); rehashSelection(input); }],
    ['unknown selected ID', input => { input.selection.selected_cell_ids = [`cell:${'f'.repeat(64)}`]; rehashSelection(input); }],
    ['empty selected set', input => { input.selection.selected_cell_ids = []; rehashSelection(input); }],
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input);
    await assert.doesNotReject(() => deniedBeforeConnection(input), name);
  }
});

test('selected boundary: full topology integrity and incidence cannot be replaced by caller ready flags', async () => {
  for (const [name, mutate, rehash] of [
    ['changed source descriptor', input => { input.topology.source_features[0].name = 'changed'; }, false],
    ['changed native bytes', input => { input.topology.cells[0].geometry_ewkb = '00'; }, false],
    ['unsupported version', input => { input.topology.topology_version = 'postgis-planar-v2'; }, false],
    ['unknown source coverage', input => { input.topology.source_coverage.query_coverage = 'unknown'; }, true],
    ['unadmitted source work', input => { input.topology.noding_admission.admitted = false; }, true],
    ['nonzero source failure', input => { input.topology.diagnostics.unattributed_edge_count = 1; }, true],
    ['missing source occurrence', input => { input.topology.edges[0].source_parts = []; }, true],
    ['missing reciprocal cell incidence', input => { input.topology.cells[0].boundary_edge_ids.pop(); }, true],
    ['foreign node', input => { input.topology.edges[0].from_node_id = `node:${'f'.repeat(64)}`; }, true],
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input); if (rehash) rehashTopology(input);
    await assert.doesNotReject(() => deniedBeforeConnection(input), name);
  }
});

test('selected boundary: subject resolution requires every captured account member and full routing closure', async () => {
  for (const [name, mutate] of [
    ['reader policy', evidence => { evidence.reader_version = 'other-reader'; }],
    ['unavailable subject', evidence => { evidence.subject.status = 'unavailable'; }],
    ['missing member', evidence => { evidence.subject.member_record_ids.pop(); }],
    ['foreign member', evidence => { evidence.subject.member_record_ids.push('dcad_parcels:99999'); }],
    ['duplicate member', evidence => { evidence.subject.member_record_ids.push(evidence.subject.member_record_ids[0]); }],
    ['wrong subject account', evidence => { evidence.subject.account_id = 'foreign'; }],
    ['missing source', evidence => { evidence.capture.sources.pop(); }],
    ['duplicate source', evidence => { evidence.capture.sources.push(clone(evidence.capture.sources[0])); }],
    ['missing snapshot', evidence => { evidence.capture.source_snapshots.pop(); }],
    ['duplicate snapshot', evidence => { evidence.capture.source_snapshots.push(clone(evidence.capture.source_snapshots[0])); }],
    ['snapshot integrity', evidence => { evidence.capture.source_snapshots[0].content_sha256 = 'f'.repeat(64); }],
    ['snapshot scope', evidence => { evidence.capture.source_snapshots[0].scope.account_id = 'foreign'; }],
    ['public selected projection', evidence => { evidence.capture.source_snapshots[0].visibility = 'public'; evidence.capture.source_snapshots[0].scope = null; }],
    ['missing routing', evidence => { evidence.capture.references = []; }],
    ['missing record route', evidence => { evidence.capture.references[0].record_sources.pop(); }],
    ['duplicate route', evidence => { evidence.capture.references[0].record_sources.push(clone(evidence.capture.references[0].record_sources[0])); }],
    ['foreign route', evidence => { evidence.capture.references[0].record_sources[0].source_ref = 'foreign'; }],
    ['missing capability', evidence => { evidence.capture.capability_diagnostics = []; }],
    ['unavailable capability', evidence => { evidence.capture.capability_diagnostics[0].status = 'unavailable'; }],
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input.subject_evidence);
    await assert.doesNotReject(() => deniedBeforeConnection(input), name);
  }
  const future = makeSelectedBoundaryInput({ subjectEvidence: makeSubjectEvidence({ capturedAt: '2099-01-01T00:00:00.000Z' }) });
  await deniedBeforeConnection(future);
});

test('selected boundary fixtures: roster, upstream numeric hash, chunk lexical order and geometry bytes are independent', () => {
  const evidence = makeSubjectEvidence(), again = makeSubjectEvidence();
  assert.deepEqual(evidence.subject.member_record_ids, ['dcad_parcels:2', 'dcad_parcels:10']);
  const payload = evidence.capture.sources[0].payload;
  assert.deepEqual(payload.records.map(row => row.record_id), ['dcad_parcels:10', 'dcad_parcels:2']);
  const digestInOrder = records => {
    const digest = createHash('sha256').update(canonicalAssessmentJson(payload.projection.definition)).update('\n');
    records.forEach(row => digest.update(canonicalAssessmentJson(row)).update('\n')); return digest.digest('hex');
  };
  assert.equal(digestInOrder([...payload.records].reverse()), payload.upstream.upstream_content_sha256);
  assert.notEqual(digestInOrder(payload.records), payload.upstream.upstream_content_sha256);
  for (const record of payload.records) {
    assert.equal(record.data.geometry.content_sha256, hashBytes(Buffer.from(record.data.geometry.ewkb, 'hex')));
    assert.equal(record.data.normalized_content_sha256, assessmentEvidenceDigest({ feature: record.data.feature,
      attributes: record.data.attributes, geometry: record.data.geometry }));
  }
  evidence.subject.member_record_ids.pop(); payload.records[0].data.attributes.account_id = 'mutated';
  assert.equal(again.subject.member_record_ids.length, 2); assert.notEqual(again.capture.sources[0].payload.records[0].data.attributes.account_id, 'mutated');
  const scope = { ...again.capture.scope, account_id: 'synthetic-other-account' };
  const input = makeSelectedBoundaryInput({ scope });
  assert.equal(input.subject_evidence.subject.account_id, scope.account_id);
  assert.deepEqual(input.selection.scope, scope); assert.deepEqual(input.subject_evidence.capture.scope, scope);
  const rings = [[[-96.9, 32.6], [-96.9, 32.7], [-96.8, 32.7], [-96.8, 32.6], [-96.9, 32.6]]];
  const polygon = Buffer.from(polygonEwkbHex(rings), 'hex'), multi = Buffer.from(multiPolygonEwkbHex([rings, rings]), 'hex');
  assert.equal(polygon.readUInt32LE(1), 0x20000003); assert.equal(multi.readUInt32LE(1), 0x20000006);
  assert.equal(polygon.readUInt32LE(5), 4326); assert.equal(multi.readUInt32LE(5), 4326);
  assert.equal(ewkbPointCount(polygon.toString('hex')), 5); assert.equal(ewkbPointCount(multi.toString('hex')), 10);
});

test('selected boundary: chunk digests alone cannot hide incomplete partitions, bad geometry or contradictory metadata', async () => {
  for (const [name, mutate, options] of [
    ['partition claims absent chunk', payload => { payload.partition.count = 2; }],
    ['wrong partition ordinal', payload => { payload.partition.index = 1; }],
    ['wrong partition row count', payload => { payload.partition.record_count--; }],
    ['projection incomplete', payload => { payload.projection.complete = false; }],
    ['upstream truncated', payload => { payload.upstream.state = 'truncated'; payload.upstream.complete = false; }],
    ['wrong upstream count', payload => { payload.upstream.row_count++; }],
    ['wrong projection count', payload => { payload.projection.output_record_count++; }],
    ['scope substitution', payload => { payload.scope.account_id = 'foreign'; }],
    ['source substitution', payload => { payload.upstream.id = 'gis-cache:other'; }],
    ['unknown provider', payload => { payload.metadata.provider = 'unknown-provider'; }],
    ['duplicate retained record', payload => { payload.records.push(clone(payload.records[0])); }],
    ['known future validity', payload => { payload.metadata.valid_from = '2099-01-01'; }, { metadata: true }],
    ['expired validity', payload => { payload.metadata.valid_to = '2000-01-01'; }, { metadata: true }],
    ['geometry digest inconsistency', payload => {
      const row = payload.records[0].data; row.geometry.content_sha256 = 'f'.repeat(64);
      row.normalized_content_sha256 = assessmentEvidenceDigest({ feature: row.feature, attributes: row.attributes, geometry: row.geometry });
    }, { upstream: true }],
    ['normalized record inconsistency', payload => { payload.records[0].data.normalized_content_sha256 = 'f'.repeat(64); }, { upstream: true }],
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input.subject_evidence.capture.sources[0].payload);
    rebindSubjectChunks(input.subject_evidence, options);
    await assert.doesNotReject(() => deniedBeforeConnection(input), name);
  }
});

test('selected boundary: source records for another account remain in proof but not in whole-subject geometry', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[-96.8999, 32.6001], [-96.8999, 32.6002],
    [-96.8998, 32.6002], [-96.8998, 32.6001], [-96.8999, 32.6001]]] };
  const evidence = makeSubjectEvidence({ additionalRecords: [{ recordId: '11', accountId: 'unrelated', geometry }] });
  assert.equal(evidence.capture.sources[0].payload.records.length, 3);
  assert.equal(evidence.capture.references[0].record_sources.length, 3);
  assert.equal(evidence.subject.member_record_ids.includes('dcad_parcels:11'), false);
  const { output, context } = await runMock({ input: makeSelectedBoundaryInput({ subjectEvidence: evidence }) });
  assert.equal(output.status, 'ready', JSON.stringify(output.incomplete_reasons));
  assert.equal(output.subject_manifest.members.length, 2);
  const build = context.calls.find(call => queryTag(call) === 'build');
  assert.equal(geometryGroups(build).subjects.some(row => row.record_id === 'dcad_parcels:11'), false);
});

test('selected boundary: admission rejects every invalid primitive, overlap and count disagreement before union', async () => {
  for (const [field, value] of [['invalid_selected_count', 1], ['invalid_subject_count', 1], ['invalid_edge_count', 1],
    ['overlap_pair_count', 1], ['selected_count', 0], ['subject_count', 1], ['boundary_edge_count', 3],
    ['selected_coordinates', 4], ['subject_coordinates', 9], ['selected_coordinates', 20001],
    ['subject_coordinates', 10001], ['invalid_subject_count', '0'], ['overlap_pair_count', null], ['selected_count', NaN]]) {
    const { output, context } = await runMock({ admission: { [field]: value } });
    atomicFailure(output);
    assert.equal(context.calls.some(call => queryTag(call) === 'build'), false, field);
    assert.equal(context.calls.at(-1).text.toUpperCase().includes('ROLLBACK'), true);
    assert.equal(context.released.length, 1);
  }
});

test('selected boundary: exact engine projection metadata is required before geometric work', async () => {
  for (const mutate of [row => { row.auth_srid = 3857; }, row => { row.auth_name = 'OTHER'; },
    row => { row.proj4text = row.proj4text.replace('+units=m', '+units=us-ft'); },
    row => { row.proj4text = row.proj4text.replace('+zone=14', '+zone=15'); },
    row => { row.srtext = 'UNIT["metre",100]'; }, row => { row.geos_version = ''; }]) {
    const version = versions(); mutate(version);
    const { output, context } = await runMock({ version }); atomicFailure(output);
    assert.equal(context.calls.some(call => ['admission', 'build'].includes(queryTag(call))), false);
    assert.equal(context.released.length, 1);
  }
});

test('selected boundary: union, full-subject Covers and strict anchor gates are independent and fail atomically', async () => {
  for (const [name, mutate] of [
    ['invalid union', row => { row.union_valid = false; }],
    ['disconnected union', row => { row.connected = false; }],
    ['boundary geometry disagreement', row => { row.boundary_equals = false; }],
    ['uncovered secondary parcel', row => { row.all_subject_covered = false; row.covered_subject_count = 1; }],
    ['optimistic coverage boolean', row => { row.covered_subject_count = 1; }],
    ['anchor on subject boundary', row => { row.anchor.inside_subject = false; }],
    ['anchor on selected boundary', row => { row.anchor.inside_union = false; }],
    ['anchor references uncaptured parcel', row => { row.anchor.member_record_id = 'dcad_parcels:999'; }],
    ['nonfinite anchor', row => { row.anchor.coordinates[0] = null; }],
    ['wrong anchor dimensions', row => { row.anchor.coordinates.push(0); }],
    ['missing cycle', row => { row.cycle_roles = []; }],
    ['duplicate cycle', row => { row.cycle_roles.push(clone(row.cycle_roles[0])); }],
    ['foreign cycle', row => { row.cycle_roles[0].cycle_id = `cycle:${'f'.repeat(64)}`; }],
    ['no exterior', row => { row.cycle_roles[0].interior = true; }],
    ['fabricated hole count', row => { row.hole_count = 1; }],
    ['unknown boolean', row => { row.union_valid = null; }],
    ['nonboolean truthy coverage', row => { row.all_subject_covered = 'true'; }],
    ['empty union bytes', row => { row.geometry_ewkb = '00'; }],
    ['nonpolygon display', row => { row.geometry = { type: 'Point', coordinates: [-96.9, 32.6] }; }],
    ['negative area', row => { row.area_m2 = -1; }],
    ['zero perimeter', row => { row.perimeter_meters = 0; }],
    ['inconsistent coordinates', row => { row.output_coordinates = 4; }],
    ['unknown response field', row => { row.unrequested = true; }],
  ]) {
    const { output, context } = await runMock({ payload: mutate }); atomicFailure(output);
    assert.equal(context.calls.some(call => queryTag(call) === 'commit'), false, name);
    assert.equal(context.released.length, 1);
  }
});

test('selected boundary: malformed or over-budget serialized responses never expose a partial result', async () => {
  for (const mutateWrapper of [row => { row.payload_bytes++; }, row => { row.payload_bytes = '100'; },
    row => { row.payload_bytes = 1000001; }, row => { row.payload_json = row.payload_json.slice(0, -1); },
    row => { row.payload_json = '{}'; row.payload_bytes = 2; }, row => { row.payload_json = null; },
    row => { row.payload_bytes = -1; }]) {
    const { output, context } = await runMock({ mutateWrapper }); atomicFailure(output);
    assert.equal(context.calls.some(call => queryTag(call) === 'commit'), false);
  }
});

test('selected boundary: exact coordinate and complete-output caps admit at the limit, never a prefix', async () => {
  const at = await runMock({}, { perimeter_coordinates: 12 });
  assert.equal(at.output.status, 'ready', JSON.stringify(at.output.incomplete_reasons));
  const below = await runMock({}, { perimeter_coordinates: 11 }); atomicFailure(below.output);
  assert.equal(below.context.calls.some(call => queryTag(call) === 'build'), false);
  for (const limits of [{ subject_members: 1 }, { perimeter_edges: 3 }, { source_occurrences: 3 },
    { selected_coordinates: 4 }, { subject_coordinates: 9 }, { records: 1 }, { topology_bytes: 1 },
    { parcel_proof_bytes: 1 }, { input_bytes: 1 }, { subject_geometry_bytes: 1 }, { chunk_bytes: 1 }]) {
    const { output, context } = await runMock({}, limits); atomicFailure(output);
    assert.equal(context.calls.some(call => queryTag(call) === 'build'), false, JSON.stringify(limits));
  }
  const tiny = await runMock({}, { output_bytes: 1 }); atomicFailure(tiny.output);
  assert.equal(tiny.output.geometry, null);
  assert.ok(Buffer.byteLength(JSON.stringify(tiny.output)) > 1, 'failure control envelope has its own bounded allowance');
  assert.throws(() => createNeighborhoodSelectedBoundary(mock().pool, { limits: { selected_cells: 257 } }), TypeError);
  assert.throws(() => createNeighborhoodSelectedBoundary(mock().pool, { limits: { subject_members: 101 } }), TypeError);
  for (const value of [0, -1, 1.5, Infinity, NaN, '12', null])
    assert.throws(() => createNeighborhoodSelectedBoundary(mock().pool, { limits: { perimeter_coordinates: value } }), TypeError);
  assert.throws(() => createNeighborhoodSelectedBoundary(mock().pool, { limits: { imaginary: 1 } }), TypeError);
  const raised = await runMock({}, { selected_cells: 256, subject_members: 100 });
  assert.equal(raised.output.status, 'ready');
  assert.equal(raised.output.limits.selected_cells, 256); assert.equal(raised.output.limits.subject_members, 100);
});

test('selected boundary: pool, query, rollback and release errors remain private and release exactly once', async () => {
  for (const failAt of ['connect', 'begin', 'settings', 'versions', 'admission', 'build', 'commit']) {
    const error = Object.assign(new Error(PRIVATE_ERROR), { selected_boundary_reason: PRIVATE_ERROR,
      boundary_reason: PRIVATE_ERROR, topology_reason: PRIVATE_ERROR, code: PRIVATE_ERROR });
    const { output, context } = await runMock({ failAt, driverError: error }); atomicFailure(output);
    assert.equal(context.released.length, failAt === 'connect' ? 0 : 1, failAt);
    assert.equal(output.incomplete_reasons.includes(PRIVATE_ERROR), false);
    if (!['connect', 'begin'].includes(failAt)) assert.equal(context.calls.some(call => queryTag(call) === 'rollback'), true);
  }
  const primary = await runMock({ failAt: 'build' });
  const releaseFailure = await runMock({ failAt: 'build', releaseFails: true });
  atomicFailure(releaseFailure.output); assert.deepEqual(releaseFailure.output.incomplete_reasons, primary.output.incomplete_reasons);
  assert.equal(releaseFailure.context.released.length, 1);
  const rollbackFailure = await runMock({ failAt: 'build', rollbackFails: true });
  atomicFailure(rollbackFailure.output); assert.equal(rollbackFailure.context.released.length, 1);
  assert.ok(rollbackFailure.context.released[0], 'failed rollback destroys rather than reuses the client');
  const afterCommit = await runMock({ releaseFails: true }); atomicFailure(afterCommit.output);
  assert.equal(afterCommit.context.released.length, 1);
});

test('selected boundary: delayed acquisition releases late clients and consumes late release errors', async () => {
  let released = 0, queried = 0;
  const pool = { connect: () => new Promise(resolve => setTimeout(() => resolve({
    query() { queried++; throw new Error(PRIVATE_ERROR); },
    release() { released++; throw new Error(PRIVATE_ERROR); },
  }), 15)) };
  const output = await createNeighborhoodSelectedBoundary(pool, { limits: { connect_ms: 1 } }).validate(makeSelectedBoundaryInput());
  atomicFailure(output);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(queried, 0); assert.equal(released, 1);
});

test('selected boundary: hostile options/input shapes reject without invoking accessors or proxy traps', async () => {
  let invoked = 0;
  const accessorOptions = Object.defineProperty({}, 'limits', { enumerable: true, get() { invoked++; return {}; } });
  const proxyOptions = new Proxy({}, { ownKeys() { invoked++; return []; }, getPrototypeOf() { invoked++; return Object.prototype; } });
  const proxyLimits = new Proxy({}, { ownKeys() { invoked++; return []; } });
  for (const options of [accessorOptions, proxyOptions, { limits: proxyLimits }, { limits: { selected_cells: -0 } }])
    assert.throws(() => createNeighborhoodSelectedBoundary(mock().pool, options), TypeError);
  for (const mutate of [
    input => Object.defineProperty(input, 'scope', { enumerable: true, get() { invoked++; return {}; } }),
    input => { input.subject_evidence = new Proxy({}, { ownKeys() { invoked++; return []; }, getPrototypeOf() { invoked++; return Object.prototype; } }); },
    input => { input.subject_evidence.toJSON = () => { invoked++; return {}; }; },
    input => { input.subject_evidence.loop = input; },
    input => { input.topology.edges[0].source_parts[0].start_fraction = -0; },
    input => { input[Symbol('hidden')] = true; },
    input => Object.defineProperty(input, 'hidden', { value: true, enumerable: false }),
    input => { let cursor = input; for (let i = 0; i < 41; i++) { cursor.nested = {}; cursor = cursor.nested; } },
    input => { const huge = []; huge.length = 2000001; input.subject_evidence.huge = huge; },
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input); await deniedBeforeConnection(input);
  }
  assert.equal(invoked, 0);
});

test('selected boundary: subject vertices must fit captured query bounds and current-reader history stays unknown', async () => {
  const outside = { type: 'Polygon', coordinates: [[[-97.2, 32.6], [-97.2, 32.7],
    [-97.0, 32.7], [-97.0, 32.6], [-97.2, 32.6]]] };
  await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: makeSubjectEvidence({ geometries: [outside] }) }));
  for (const mutate of [
    payload => { payload.metadata.valid_from = '2024-01-01'; payload.metadata.historical_availability = 'reconstructed'; },
    payload => { payload.metadata.valid_to = '2099-01-01'; },
    payload => { payload.projection.definition.historical_availability = 'contemporaneous'; },
    payload => { payload.projection.definition.provider_coverage = 'complete'; },
  ]) {
    const input = makeSelectedBoundaryInput(); mutate(input.subject_evidence.capture.sources[0].payload);
    rebindSubjectChunks(input.subject_evidence, { metadata: true, upstream: true });
    await deniedBeforeConnection(input);
  }
});

function signedCycle(ring, topology) {
  const point = id => { const bytes = Buffer.from(topology.nodes.find(row => row.id === id).geometry_ewkb, 'hex');
    return [bytes.readDoubleLE(9), bytes.readDoubleLE(17)]; };
  const origin = point(ring.segments[0].from_node_id);
  return ring.segments.reduce((sum, segment, index) => {
    assert.equal(segment.to_node_id, ring.segments[(index + 1) % ring.segments.length].from_node_id);
    const from = point(segment.from_node_id), to = point(segment.to_node_id);
    return sum + (from[0] - origin[0]) * (to[1] - origin[1]) - (to[0] - origin[0]) * (from[1] - origin[1]);
  }, 0);
}

test('selected boundary: adjacent cells remove their shared edge and shuffled inputs retain deterministic cycles', async () => {
  const topology = makeMockSelectedBoundaryTopology({ variant: 'adjacent' });
  const shared = topology.edges.find(row => row.cell_ids.length === 2);
  assert.ok(shared); assert.equal(topology.edges.length, 7);
  const input = makeSelectedBoundaryInput({ topology }), oracle = makeMockSelectedBoundaryOracle({ variant: 'adjacent' });
  const first = await runMock({ input, oracle }); assert.equal(first.output.status, 'ready', JSON.stringify(first.output.incomplete_reasons));
  assert.equal(first.output.selected_boundary.exterior.segments.length, 6);
  assert.ok(first.output.selected_boundary.exterior.segments.every(row => row.edge_id !== shared.id));
  assert.ok(first.output.boundary_source_occurrences.every(row => row.edge_id !== shared.id));
  assert.ok(signedCycle(first.output.selected_boundary.exterior, first.context.input.topology) > 0);
  const reordered = clone(input);
  for (const collection of ['cells', 'edges', 'nodes', 'source_features', 'source_aliases']) reordered.topology[collection].reverse();
  // The reader's numeric member roster is an unchanged wire claim, unlike
  // unordered topology collections. It must not be rewritten for this test.
  const second = await runMock({ input: reordered, oracle }); assert.equal(second.output.status, 'ready');
  assert.deepEqual(second.output.geometry, first.output.geometry);
  assert.deepEqual(second.output.selected_boundary.exterior, first.output.selected_boundary.exterior);
  assert.deepEqual(second.output.boundary_source_occurrences, first.output.boundary_source_occurrences);
  reordered.selection.selected_cell_ids.reverse(); rehashSelection(reordered);
  const decision = await runMock({ input: reordered, oracle }); assert.equal(decision.output.status, 'ready');
  assert.deepEqual(decision.output.geometry, first.output.geometry, 'selection input order never alters geometry');
  assert.deepEqual(decision.output.selected_boundary.exterior, first.output.selected_boundary.exterior);
  assert.notEqual(decision.output.selection_sha256, first.output.selection_sha256, 'the exact supplied decision remains bound');
});

test('selected boundary: holes keep independent clockwise cycles and count toward the shared coordinate budget', async () => {
  const topology = makeMockSelectedBoundaryTopology({ variant: 'hole' });
  const annulus = topology.cells.find(row => row.interior_ring_count === 1), inner = topology.cells.find(row => row.interior_ring_count === 0);
  const input = makeSelectedBoundaryInput({ topology, selectedCellIds: [annulus.id] });
  const options = { input, oracle: makeMockSelectedBoundaryOracle({ variant: 'hole' }), payload(row, config) {
    row.hole_count = 1;
    row.cycle_roles.forEach(role => { role.interior = geometryGroups(config).boundary
      .filter(edge => edge.cycle_id === role.cycle_id).every(edge => inner.boundary_edge_ids.includes(edge.id)); });
  } };
  const result = await runMock(options, { perimeter_coordinates: 24 });
  assert.equal(result.output.status, 'ready', JSON.stringify(result.output.incomplete_reasons));
  const boundary = result.output.selected_boundary;
  assert.equal(boundary.interiors.length, 1); assert.equal(boundary.exterior.segments.length, 4);
  assert.equal(boundary.interiors[0].segments.length, 4);
  assert.ok(signedCycle(boundary.exterior, result.context.input.topology) > 0);
  assert.ok(signedCycle(boundary.interiors[0], result.context.input.topology) < 0);
  assert.equal(result.output.geometry.geometry.coordinates.length, 2);
  const below = await runMock(options, { perimeter_coordinates: 23 }); atomicFailure(below.output);
  assert.equal(below.context.calls.some(call => queryTag(call) === 'build'), false);
  const filled = await runMock({ input: makeSelectedBoundaryInput({ topology }), oracle: makeMockSelectedBoundaryOracle({ variant: 'hole', fillHole: true }) });
  assert.equal(filled.output.status, 'ready'); assert.deepEqual(filled.output.selected_boundary.interiors, []);
  assert.equal(filled.output.boundary_source_occurrences.length, 4, 'only deliberate selection fills the inner cell');
});

test('selected boundary: disconnected and corner-only cells are not silently joined or expanded', async () => {
  for (const variant of ['disconnected', 'corner']) {
    const input = makeSelectedBoundaryInput({ topology: makeMockSelectedBoundaryTopology({ variant }) });
    const result = await runMock({ input, payload: { connected: false } }); atomicFailure(result.output);
    assert.equal(result.context.calls.some(call => queryTag(call) === 'commit'), false);
    assert.deepEqual(result.context.input.selection.selected_cell_ids, input.selection.selected_cell_ids);
  }
});

test('selected boundary: every stipulated duplicate/retraced source occurrence survives traversal without interpolation', async () => {
  const input = makeSelectedBoundaryInput(), edge = input.topology.edges[0];
  edge.source_parts.push({ ...edge.source_parts[0], source_segment_index: 2, start_fraction: 1, end_fraction: 0 });
  input.topology.diagnostics.source_reference_count++; input.topology.diagnostics.source_chain_count++;
  input.topology.diagnostics.multisource_edge_count = 1; rehashTopology(input);
  const result = await runMock({ input }); assert.equal(result.output.status, 'ready', JSON.stringify(result.output.incomplete_reasons));
  assert.deepEqual(result.output.boundary_source_occurrences.find(row => row.edge_id === edge.id).source_parts, edge.source_parts);
  assert.ok(result.output.selected_boundary.exterior.segments.some(row => row.reversed));
});

test('selected boundary: all real builder chunks participate even when only two records belong to the subject', async () => {
  const geometry = { type: 'Polygon', coordinates: [[[-96.8999, 32.6001], [-96.8999, 32.6002],
    [-96.8998, 32.6002], [-96.8998, 32.6001], [-96.8999, 32.6001]]] };
  const evidence = makeSubjectEvidence({ additionalRecords: Array.from({ length: 1001 }, (_, index) => ({
    recordId: String(index + 100), accountId: 'unrelated-account', geometry,
  })) });
  assert.equal(evidence.capture.sources.length, 2, 'actual accepted capture builder partitions this modest fixture');
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.capture)) < 8000000);
  assert.deepEqual(evidence.capture.sources.map(row => row.payload.partition.index), [0, 1]);
  assert.equal(evidence.capture.sources.reduce((sum, row) => sum + row.payload.records.length, 0), 1003);
  const result = await runMock({ input: makeSelectedBoundaryInput({ subjectEvidence: evidence }) });
  assert.equal(result.output.status, 'ready', JSON.stringify(result.output.incomplete_reasons));
  assert.equal(result.output.subject_manifest.members.length, 2);
  const truncated = clone(evidence), missingId = truncated.capture.sources.pop().id;
  truncated.capture.source_snapshots = truncated.capture.source_snapshots.filter(row => row.id !== missingId);
  for (const routing of truncated.capture.references) {
    routing.source_refs = routing.source_refs.filter(id => id !== missingId);
    routing.record_sources = routing.record_sources.filter(row => row.source_ref !== missingId);
  }
  for (const capability of truncated.capture.capability_diagnostics)
    capability.source_refs = capability.source_refs.filter(id => id !== missingId);
  await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: truncated }));
});

test('selected boundary: result byte limit covers proof, sources, limits, hashes and JSON framing', async () => {
  const base = await runMock(); assert.equal(base.output.status, 'ready');
  let exact = Buffer.byteLength(JSON.stringify(base.output));
  for (let i = 0; i < 4; i++) exact = Buffer.byteLength(JSON.stringify({ ...base.output,
    limits: { ...base.output.limits, output_bytes: exact } }));
  const at = await runMock({}, { output_bytes: exact });
  assert.equal(at.output.status, 'ready', JSON.stringify(at.output.incomplete_reasons));
  assert.equal(Buffer.byteLength(JSON.stringify(at.output)), exact);
  const below = await runMock({}, { output_bytes: exact - 1 }); atomicFailure(below.output);
  assert.equal(below.context.calls.some(call => queryTag(call) === 'commit'), false);
});

test('selected boundary: expired total budget after native response rolls back and withholds all geometry', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const result = await runMock({ onQuery(tag) { if (tag === 'build') now = 30001; } });
  atomicFailure(result.output);
  assert.equal(result.context.calls.some(call => queryTag(call) === 'commit'), false);
  assert.equal(result.context.calls.some(call => queryTag(call) === 'rollback'), true);
  assert.equal(result.context.released.length, 1);
});

test('selected boundary: older originating runs stay distinct from latest source state and bound every sync time', async () => {
  function historicalRun(syncedAt = '2026-09-04T12:00:00.000Z') {
    const evidence = makeSubjectEvidence();
    for (const source of evidence.capture.sources) for (const row of source.payload.records) {
      row.data.origin_run = { ...row.data.origin_run, id: 'f3aa7e6e-9fc2-4c5c-8e44-918ac19a96d2',
        started_at: '2026-09-04T00:00:00.000Z', completed_at: '2026-09-04T23:00:00.000Z' };
      row.data.ingest.sync_run_id = row.data.origin_run.id;
      row.data.ingest.synced_at = syncedAt;
    }
    rebindSubjectChunks(evidence, { upstream: true });
    return evidence;
  }
  for (const syncedAt of ['2026-09-04T00:00:00.000Z', '2026-09-04T12:00:00.000Z', '2026-09-04T23:00:00.000Z']) {
    const result = await runMock({ input: makeSelectedBoundaryInput({ subjectEvidence: historicalRun(syncedAt) }) });
    assert.equal(result.output.status, 'ready', JSON.stringify(result.output.incomplete_reasons));
    assert.equal(result.output.subject_manifest.historical_availability, 'unknown',
      'an earlier completed mirror run is not evidence of historical availability');
  }
  for (const syncedAt of ['2026-09-03T23:59:59.999Z', '2026-09-04T23:00:00.001Z'])
    await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: historicalRun(syncedAt) }));
  const inconsistent = historicalRun();
  inconsistent.capture.sources[0].payload.records[0].data.origin_run.completed_at = '2026-09-04T22:00:00.000Z';
  rebindSubjectChunks(inconsistent, { upstream: true });
  await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: inconsistent }));
  const latestDisagreement = historicalRun();
  for (const source of latestDisagreement.capture.sources) for (const row of source.payload.records) {
    row.data.origin_run.id = source.payload.projection.definition.raw_source_state.run_id;
    row.data.ingest.sync_run_id = row.data.origin_run.id;
  }
  rebindSubjectChunks(latestDisagreement, { upstream: true });
  await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: latestDisagreement }));
});

test('selected boundary: capture proof preserves array framing and reader query bounds are strict', async () => {
  for (const keys of [['references'], ['capability_diagnostics'], ['references', 'capability_diagnostics']]) {
    const input = makeSelectedBoundaryInput();
    for (const key of keys) input.subject_evidence.capture[key] = input.subject_evidence.capture[key][0];
    await deniedBeforeConnection(input);
  }
  for (const bounds of [
    { west: -97.1, south: 32.1, east: -97, north: 33 },
    { west: -96.2, south: 32.1, east: -97.1, north: 33 },
    { west: -97.1, south: 32.1, east: -96.2, north: 34 },
    { west: -97.1, south: 32.1, east: '-96.2', north: 33 },
  ]) {
    const evidence = makeSubjectEvidence();
    evidence.capture.sources.forEach(source => { source.payload.projection.definition.bounds = bounds; });
    rebindSubjectChunks(evidence, { upstream: true });
    await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: evidence }));
  }
  const reordered = makeSelectedBoundaryInput();
  reordered.subject_evidence.subject.member_record_ids.reverse();
  await deniedBeforeConnection(reordered);
});

test('selected boundary: constructor accepts only omitted or plain options without coercion', () => {
  const pool = { connect() { throw new Error('constructor_must_not_connect'); } };
  assert.equal(typeof createNeighborhoodSelectedBoundary(pool).validate, 'function');
  assert.equal(typeof createNeighborhoodSelectedBoundary(pool, {}).validate, 'function');
  for (const options of [true, false, 1, 0, null, [], [1], 'options', { limits: undefined }])
    assert.throws(() => createNeighborhoodSelectedBoundary(pool, options), TypeError);
});

test('selected boundary: exact input budget counts escaped keys and values before semantic validation', async () => {
  const cases = [
    ['control', '\u0000\u0001\b\t\n\f\r\u001f'],
    ['quotes-backslashes', '"\\"\\'],
    ['paired-surrogate', '\ud83d\ude42'],
    ['lone-high-surrogate', '\ud800'],
    ['lone-low-surrogate', '\udc00'],
    ['non-ascii', 'é\u07ff\u0800中文\u2028'],
  ];
  for (const [label, value] of cases) {
    const input = makeSelectedBoundaryInput();
    // Unknown only at the semantic layer: preflight must first count this
    // small, plain-JSON nested field exactly, including escaped key bytes.
    input.test_budget_only = { [value]: { value } };
    const exact = Buffer.byteLength(JSON.stringify(input), 'utf8');
    let connections = 0;
    const pool = { connect() { connections++; throw new Error(PRIVATE_ERROR); } };
    await assert.rejects(createNeighborhoodSelectedBoundary(pool, { limits: { input_bytes: exact } }).validate(input),
      { name: 'TypeError', message: 'invalid_neighborhood_selected_boundary:input' }, label);
    const below = await createNeighborhoodSelectedBoundary(pool, { limits: { input_bytes: exact - 1 } }).validate(input);
    atomicFailure(below);
    assert.deepEqual(below.incomplete_reasons, ['input_limit_exceeded'], label);
    assert.equal(connections, 0);
  }
});

test('selected boundary: nested MultiPolygon and impossible EWKB point counts reject before connection', async () => {
  const polygon = [[[-96.8999, 32.6001], [-96.8999, 32.6002], [-96.8998, 32.6002],
    [-96.8998, 32.6001], [-96.8999, 32.6001]]];
  const validMulti = Buffer.from(multiPolygonEwkbHex([polygon]), 'hex');
  const nestedHeader = Buffer.alloc(13);
  nestedHeader.writeUInt8(1, 0); nestedHeader.writeUInt32LE(0x20000006, 1);
  nestedHeader.writeUInt32LE(4326, 5); nestedHeader.writeUInt32LE(1, 9);
  const impossiblePoints = Buffer.from(polygonEwkbHex(polygon), 'hex');
  impossiblePoints.writeUInt32LE(0xffffffff, 13);
  for (const bytes of [Buffer.concat([nestedHeader, validMulti]), impossiblePoints]) {
    const evidence = makeSubjectEvidence(), record = evidence.capture.sources[0].payload.records[0];
    record.data.geometry.ewkb = bytes.toString('hex');
    record.data.geometry.content_sha256 = hashBytes(bytes);
    record.data.normalized_content_sha256 = assessmentEvidenceDigest({ feature: record.data.feature,
      attributes: record.data.attributes, geometry: record.data.geometry });
    rebindSubjectChunks(evidence, { upstream: true });
    await deniedBeforeConnection(makeSelectedBoundaryInput({ subjectEvidence: evidence }));
  }
});

test('selected boundary: settings use one parameterized SELECT and never accept a multi-result array', async () => {
  const legacy = settingsQueryResult({ text: "/* neighborhood-selected-boundary:settings */ SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'", values: [] });
  assert.equal(Array.isArray(legacy), true); assert.equal(legacy.length, 3);
  assert.equal(Object.hasOwn(legacy, 'rows'), false, 'multi-statement driver shape differs from a single QueryResult');
  const successful = await runMock();
  assert.equal(successful.output.status, 'ready', JSON.stringify(successful.output.incomplete_reasons));
  assert.equal(successful.context.calls.some(call => queryTag(call) === 'build'), true);
  const settings = successful.context.calls.find(call => queryTag(call) === 'settings');
  const sql = settings.text.replace(/^\s*\/\*[^]*?\*\//, '').trim();
  assert.match(sql, /^SELECT\b/i);
  assert.equal(sql.split(';').filter(statement => statement.trim()).length, 1);
  assert.match(sql, /pg_catalog\.set_config\(\s*'statement_timeout'\s*,\s*\$1\s*,\s*true\s*\)/i);
  assert.match(sql, /pg_catalog\.set_config\(\s*'lock_timeout'\s*,\s*\$2\s*,\s*true\s*\)/i);
  assert.match(sql, /pg_catalog\.set_config\(\s*'idle_in_transaction_session_timeout'\s*,\s*\$3\s*,\s*true\s*\)/i);
  assert.deepEqual(settings.values, ['5000ms', '1000ms', '10000ms']);
  assert.equal(Array.isArray(settingsQueryResult(settings)), false);
  const refused = await runMock({ settingsResult: legacy }); atomicFailure(refused.output);
  assert.deepEqual(refused.output.incomplete_reasons, ['invalid_native_result']);
  assert.equal(refused.context.calls.some(call => queryTag(call) === 'versions'), false);
  assert.equal(refused.context.calls.some(call => queryTag(call) === 'rollback'), true);
  assert.equal(refused.context.released.length, 1);
});

test('selected boundary: rehashing cannot waive a topology producer\'s own primitive, pair or row limits', async () => {
  const topology = makeMockSelectedBoundaryTopology({ variant: 'adjacent' });
  assert.equal(topology.noding_admission.primitive_segments, 7);
  assert.equal(topology.noding_admission.candidate_pairs, 21);
  const rowBytes = Math.max(...['cells', 'edges', 'nodes'].flatMap(key => topology[key]
    .map(row => Buffer.byteLength(canonicalAssessmentJson(row), 'utf8'))));
  for (const [key, below] of [['primitive_segments', 1], ['primitive_segments', 6],
    ['candidate_pairs', 1], ['candidate_pairs', 20], ['row_bytes', 1], ['row_bytes', rowBytes - 1]]) {
    const input = makeSelectedBoundaryInput({ topology });
    input.topology.limits[key] = below; rehashTopology(input);
    await deniedBeforeConnection(input);
  }
  const exact = makeSelectedBoundaryInput({ topology });
  Object.assign(exact.topology.limits, { primitive_segments: 7, candidate_pairs: 21, row_bytes: rowBytes });
  rehashTopology(exact);
  const result = await runMock({ input: exact, oracle: makeMockSelectedBoundaryOracle({ variant: 'adjacent' }) });
  assert.equal(result.output.status, 'ready', JSON.stringify(result.output.incomplete_reasons));
  assert.equal(result.context.calls.some(call => queryTag(call) === 'build'), true);
  assert.deepEqual(result.output.geometry.geometry, makeMockSelectedBoundaryOracle({ variant: 'adjacent' }).geometry);
});

test('selected boundary: submitted admission SQL uses a non-keyword selected-overlap CTE', async () => {
  const { output, context } = await runMock();
  assert.equal(output.status, 'ready', JSON.stringify(output.incomplete_reasons));
  const admission = context.calls.find(call => queryTag(call) === 'admission');
  assert.ok(admission, 'inspect the actual submitted admission query, not a separate SQL fixture');
  assert.match(admission.text, /\bselected_overlap_pairs\s+AS\s*\(/i);
  assert.match(admission.text, /\bFROM\s+selected_overlap_pairs\b/i);
  assert.doesNotMatch(admission.text, /\boverlaps\s+AS\s*\(|\bFROM\s+overlaps\b/i);
  assert.match(admission.text, /ST_Relate\(\s*a\.geom\s*,\s*b\.geom\s*,\s*'2\*{8}'\s*\)/i);
  assert.match(admission.text, /\bAS\s+overlap_pair_count\b/i);
});
