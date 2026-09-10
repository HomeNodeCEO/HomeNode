import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { buildCustomCohortSupportedInputs } from '../src/services/neighborhoodAssessment/customCohortSupportedInputs.js';
import { supportedInputsFixture } from './fixtures/customCohortSupportedInputsFixture.js';

const NOW = '2026-09-09T12:00:00.123456Z';
const FIELDS = ['neighborhood_boundary_geometry', 'neighborhood_boundary_source', 'neighborhood_boundary_label',
  'neighborhood_boundary_north', 'neighborhood_boundary_east', 'neighborhood_boundary_south', 'neighborhood_boundary_west',
  'neighborhood_boundary_saved_at', 'neighborhood_boundary_confirmed', 'neighborhood_boundary_confirmed_at'];
const POLYGON = { type: 'Polygon', coordinates: [
  [[-97, 32], [-96, 32], [-96, 33], [-97, 33], [-97, 32]],
  [[-96.8, 32.2], [-96.8, 32.4], [-96.6, 32.4], [-96.6, 32.2], [-96.8, 32.2]],
] };
const MANUAL = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
  neighborhood_boundary_geometry: POLYGON, neighborhood_boundary_label: 'Synthetic owner boundary, not adopted',
  neighborhood_boundary_north: 'Literal north note', neighborhood_boundary_saved_at: '2026-09-08T12:00:00.000Z' };
const one = value => ({ rowCount: value === null ? 0 : 1, rows: value === null ? [] : [structuredClone(value)] });
const sha = value => createHash('sha256').update(value).digest('hex');
const writes = /\b(?:INSERT\s+INTO|UPDATE\s+app\.|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

// The actual source capture/retention/review and owner modules run. These query
// rows model only a bounded DB projection and a PostGIS answer; native tests
// separately execute PostgreSQL text hashing and geometry validation.
async function setup({ boundary = MANUAL, reviewed = false, afterFirstCommit,
  topology = { is_valid: true, validation_reason: 'Valid Geometry', postgis_version: 'synthetic-query-fixture' },
  afterTopology, policy } = {}) {
  const f = await supportedInputsFixture({ assignmentFileId: '41', saleCount: 1 });
  if (reviewed) await f.reviewAll();
  const adapter = await f.adapterInput(), target = f.input.retained_inputs.subject.target;
  const actor = f.input.retained_inputs.acquisition_intent.body.actor_user_id;
  const workspace = { revision: 19, value: { workspace_version: 1, pending_capture: null, active: {
    context_ref: f.input.expected.context_ref, observation_period: f.input.expected.observation_period,
    selection: { revision: 7, included_recorded_group_ids: [...f.input.selection.included_recorded_group_ids] },
  } } };
  const projection = (value, revision = 5) => {
    const text = JSON.stringify(value);
    return { assignment_file_id: '41', account_id: target.account_id, assignment_revision: revision,
      details_type: 'object', projected_utf8_bytes: Buffer.byteLength(text), projected_sha256: sha(text), projected_json: text };
  };
  const state = { boundary: projection(boundary), boundaryResponse: null, topology, calls: [], connects: 0, releases: [], policyVisits: 0 };
  const request = { auth: { userId: actor, organizations: [{ organizationId: target.organization_id, roles: ['appraiser'] }] },
    accountId: target.account_id, assignmentFileId: '41', contextRef: structuredClone(f.input.expected.context_ref),
    expectedWorkspaceRevision: 19, expectedReviewGeneration: adapter.review_state.binding.generation };
  const grant = f.input.retained_inputs.acquisition.captured_query_request.market_decision;
  const owner = createCustomCohortContextCapture({ pool: { async connect() {
    const phase = ++state.connects;
    return { release(error) { state.releases.push({ phase, error }); }, async query(config) {
      const { text, values } = config; state.calls.push({ phase, ...config });
      assert.ok(Number.isFinite(config.query_timeout) && config.query_timeout > 0 && config.query_timeout <= 6000);
      assert.equal(writes.test(text), false, `preparation must not write: ${text}`);
      if (text === 'COMMIT' && phase === 1 && afterFirstCommit) await afterFirstCommit({ f, state, request, projection });
      if (/^(?:BEGIN |SET LOCAL |COMMIT$|ROLLBACK$)/.test(text)) return one(null);
      if (text.includes('custom-cohort-capture:assignment */')) {
        assert.match(text, /FOR UPDATE NOWAIT/); assert.deepEqual(values, ['41', target.account_id]);
        return one({ assignment_file_id: '41', account_id: target.account_id, organization_id: target.organization_id,
          assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null });
      }
      if (text.includes('custom-cohort-capture:report */')) return one({ report_file_id: target.report_file_id,
        appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
      if (text.includes('custom-cohort-capture:workspace-parent')) return one({ assignment_file_id: '41' });
      if (text.includes('custom-cohort-capture:workspace */')) return one(workspace);
      if (text.includes('custom-cohort-capture:report-editor')) return one({ revision: 3, value_sha256: 'a'.repeat(64) });
      if (text.includes('custom-cohort-capture:report-geography */')) {
        assert.deepEqual(values, ['41', target.account_id, FIELDS, 262144]);
        assert.match(text, /sha256\(convert_to\(fields::text,'UTF8'\)\)/);
        assert.match(text, /octet_length\(fields::text\)/);
        return state.boundaryResponse ?? one(state.boundary);
      }
      if (text.includes('custom-cohort-capture:report-geography-topology')) {
        assert.equal(phase, 1, 'topology is checked once against the exact initial projected geometry');
        assert.deepEqual(JSON.parse(values[0]), JSON.parse(state.boundary.projected_json).neighborhood_boundary_geometry);
        assert.match(text, /ST_IsValid\(geom\)/); assert.match(text, /ST_IsValidReason\(geom\)/);
        assert.doesNotMatch(text, /ST_MakeValid|ST_Buffer|ST_Snap/i);
        if (afterTopology) await afterTopology();
        return one(state.topology);
      }
      if (text.includes('custom-cohort-capture:time')) return one({ value: NOW });
      return f.base.client.query(text, values);
    } };
  } }, authorizeMarketData: async (_client, _auth, _context, _purpose, options) => {
    assert.deepEqual(options, { retention: true, exposure: 'none' });
    const visit = ++state.policyVisits;
    return policy ? policy({ grant, visit }) : { allowed: true, ...grant };
  } });
  const before = [...f.base.f.state.db.entries()].map(([key, value]) => [key, structuredClone(value)]);
  const unchanged = () => assert.deepEqual([...f.base.f.state.db.entries()], before);
  return { f, owner, request, state, adapter, workspace, projection, unchanged };
}

const topologyCalls = state => state.calls.filter(c => c.text.includes('report-geography-topology'));
const projectionCalls = state => state.calls.filter(c => c.text.includes('report-geography */'));
function finalRollback(state) {
  assert.equal(state.calls.filter(c => c.text === 'COMMIT').length, 1);
  assert.equal(state.calls.at(-1).text, 'ROLLBACK');
  assert.deepEqual(state.releases, [{ phase: 1, error: undefined }, { phase: 2, error: undefined }]);
}

test('owner uses exact saved manual Polygon with holes, isolated source binding and no calculation changes', async () => {
  const f = await setup({ reviewed: true }), result = await f.owner.prepareReviewedInputs(f.request);
  const report = result.report_preparation;
  assert.equal(report.report_geography.status, 'manual_geometry_recorded');
  assert.equal(report.report_geography.binding.assignment_revision, 5);
  assert.equal(report.report_geography.binding.projected_sha256, f.state.boundary.projected_sha256);
  assert.equal(report.report_geography.binding.captured_at, '2026-09-09T12:00:00.123Z');
  assert.deepEqual(report.assessment.geographic_neighborhood.geometry, POLYGON);
  assert.deepEqual(report.assessment.geographic_neighborhood.cardinal_summaries,
    { north: 'Literal north note', east: null, south: null, west: null });
  assert.deepEqual(report.assessment.geographic_neighborhood.perimeter, []);
  assert.equal(report.assessment.geographic_neighborhood.validation.contains_subject, null);
  assert.equal(report.status, 'incomplete'); assert.equal(report.apply.status, 'blocked');
  assert.equal(report.candidate.status, 'incomplete'); assert.deepEqual(report.candidate.suggestions, []);
  assert.deepEqual(result.supported_inputs, buildCustomCohortSupportedInputs({ ...f.adapter,
    preparation_input: { ...f.adapter.preparation_input, selection: f.workspace.value.active.selection },
    derived_at: '2026-09-09T12:00:00.123Z' }));
  assert.equal(topologyCalls(f.state).length, 1); assert.equal(projectionCalls(f.state).length, 2);
  for (const phase of [1, 2]) {
    const calls = f.state.calls.filter(c => c.phase === phase), index = tag => calls.findIndex(c => c.text.includes(tag));
    assert.ok(index('assignment */') < index('report-geography */'));
    assert.ok(index('workspace */') < index('report-geography */'));
    assert.ok(index('report-editor') < index('report-geography */'));
  }
  assert.ok(f.state.calls.findIndex(c => c.text.includes(':time')) < f.state.calls.findIndex(c => c.text.includes('report-geography-topology')));
  assert.equal(f.state.policyVisits, 2); f.unchanged();
});

for (const [name, change] of [
  ['assignment revision only', ({ state }) => { state.boundary.assignment_revision++; }],
  ['same-revision geometry bytes', ({ state, projection }) => { state.boundary = projection({ ...MANUAL,
    neighborhood_boundary_geometry: { ...POLYGON, coordinates: [POLYGON.coordinates[0]] } }); }],
  ['same-revision explicit clear', ({ state, projection }) => { state.boundary = projection({
    neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null }); }],
  ['same-revision label', ({ state, projection }) => { state.boundary = projection({ ...MANUAL, neighborhood_boundary_label: 'Changed' }); }],
]) test(`final ${name} change refuses the already prepared report`, async () => {
  const f = await setup({ afterFirstCommit: change });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_geography_changed/);
  assert.equal(topologyCalls(f.state).length, 1); finalRollback(f.state); f.unchanged();
});

test('saved geometry diagnosis remains explicit when unreviewed support cannot produce an assessment', async () => {
  const f = await setup(), result = await f.owner.prepareReviewedInputs(f.request), report = result.report_preparation;
  assert.equal(report.assessment, null); assert.equal(report.publication_bundle, null); assert.equal(report.candidate, null);
  assert.equal(report.report_geography.status, 'manual_geometry_recorded');
  assert.deepEqual(report.report_geography.geometry, POLYGON); assert.equal(report.apply.status, 'blocked'); f.unchanged();
});

for (const [name, boundary, status] of [
  ['absent', {}, 'absent'],
  ['cleared', { neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null }, 'cleared'],
  ['legacy manual', { ...MANUAL, neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' }, 'intent_unverified'],
  ['automatic', { ...MANUAL, neighborhood_boundary_source: 'neighborhood_boundary_automatic_unverified_v1' }, 'intent_unverified'],
  ['engine', { ...MANUAL, neighborhood_boundary_source: 'neighborhood_boundary_engine_v1' }, 'intent_unverified'],
  ['missing manual geometry', { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2' }, 'malformed'],
  ['open ring', { ...MANUAL, neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [POLYGON.coordinates[0].slice(0, -1)] } }, 'malformed'],
  ['string coordinates', { ...MANUAL, neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [POLYGON.coordinates[0].map(p => p.map(String))] } }, 'malformed'],
  ['malformed literal', { ...MANUAL, neighborhood_boundary_north: 42 }, 'malformed'],
]) test(`${name} saved state is explicit and never invokes topology or manufactures geometry`, async () => {
  const f = await setup({ boundary }), result = await f.owner.prepareReviewedInputs(f.request);
  const geo = result.report_preparation.report_geography;
  assert.equal(geo.status, status); assert.equal(geo.geometry, null); assert.equal(geo.oracle_observation, null);
  assert.equal(topologyCalls(f.state).length, 0); assert.equal(projectionCalls(f.state).length, 2); f.unchanged();
});

test('self-intersecting manual polygon keeps an actual false-oracle diagnosis and no repaired geometry', async () => {
  const boundary = { ...MANUAL, neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [
    [[-97, 32], [-96, 33], [-97, 33], [-96, 32], [-97, 32]],
  ] } };
  const f = await setup({ boundary, topology: { is_valid: false, validation_reason: 'Self-intersection[-96.5 32.5]',
    postgis_version: 'synthetic-query-fixture' } });
  const result = await f.owner.prepareReviewedInputs(f.request), geo = result.report_preparation.report_geography;
  assert.equal(geo.status, 'invalid_topology'); assert.equal(geo.geometry, null);
  assert.equal(geo.oracle_observation.is_valid, false); assert.equal(topologyCalls(f.state).length, 1);
  assert.deepEqual(JSON.parse(geo.projection.projected_json), boundary); f.unchanged();
});

for (const [name, change] of [
  ['hash mismatch', row => { row.projected_sha256 = 'b'.repeat(64); }],
  ['byte mismatch', row => { row.projected_utf8_bytes++; }],
  ['zero assignment revision', row => { row.assignment_revision = 0; }],
  ['string assignment revision', row => { row.assignment_revision = '5'; }],
]) test(`invalid projection ${name} is refused before topology`, async () => {
  const f = await setup(); change(f.state.boundary);
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /custom_cohort_report_geography_/);
  assert.equal(topologyCalls(f.state).length, 0); assert.equal(f.state.connects, 1); f.unchanged();
});

test('bounded SQL omission is reported as a limit, not an absent boundary or partial polygon', async () => {
  const f = await setup(); Object.assign(f.state.boundary,
    { projected_utf8_bytes: 262145, projected_json: null, projected_sha256: null });
  const result = await f.owner.prepareReviewedInputs(f.request), geo = result.report_preparation.report_geography;
  assert.equal(geo.status, 'limit_exceeded'); assert.equal(geo.geometry, null);
  assert.equal(geo.binding.projected_utf8_bytes, 262145); assert.equal(topologyCalls(f.state).length, 0); f.unchanged();
});

test('unrelated saved details cannot enter a forged boundary SQL projection', async () => {
  const f = await setup(); f.state.boundary = f.projection({ ...MANUAL, client_name: 'Private synthetic detail' });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /projection_fields/);
  assert.equal(topologyCalls(f.state).length, 0); f.unchanged();
});

for (const [key, value] of [['assignment_file_id', '42'], ['account_id', 'foreign-account']]) {
  test(`foreign ${key} projection is refused before topology`, async () => {
    const f = await setup(); f.state.boundary[key] = value;
    await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_geography_unavailable/);
    assert.equal(topologyCalls(f.state).length, 0); assert.equal(f.state.connects, 1); f.unchanged();
  });
}

test('missing and duplicate projection rows are not silently interpreted as an empty boundary', async () => {
  for (const kind of ['missing', 'duplicate']) {
    const f = await setup(); f.state.boundaryResponse = kind === 'missing' ? one(null)
      : { rowCount: 2, rows: [f.state.boundary, f.state.boundary] };
    await assert.rejects(f.owner.prepareReviewedInputs(f.request));
    assert.equal(topologyCalls(f.state).length, 0); assert.equal(f.state.connects, 1); f.unchanged();
  }
});

for (const final of [false, true]) test(`${final ? 'final' : 'initial'} source policy denial cannot expose the prepared geography`, async () => {
  const f = await setup({ policy: ({ grant, visit }) => visit === (final ? 2 : 1) ? { allowed: false } : { allowed: true, ...grant } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /market_data_access_denied/);
  if (final) finalRollback(f.state);
  else assert.equal(projectionCalls(f.state).length, 0);
  f.unchanged();
});

test('cancellation during native-oracle work cannot start the final response transaction', async () => {
  const controller = new AbortController();
  const f = await setup({ afterTopology: () => controller.abort() });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request, { signal: controller.signal }), /cancelled/);
  assert.equal(f.state.connects, 1); assert.equal(f.state.releases.length, 1); f.unchanged();
});
