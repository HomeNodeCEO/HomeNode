import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortAssessmentPreparation as prepare } from '../src/services/neighborhoodAssessment/customCohortAssessmentPreparation.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { neighborhoodMemberSetDigest } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareNeighborhoodSelectorInputV1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './fixtures/customCohortRepositoryFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { setPublic } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const NOW = '2026-09-06T08:00:00.123456Z', MS = '2026-09-06T08:00:00.123Z';
const RUN = '60000000-0000-4000-8000-000000000001', GEOMETRY = '010203';
const SNAPSHOT = { backend_pid: 1234, snapshot: '100:100:', transaction_started_at: '2026-09-06T08:00:00.000000Z' };
const readerText = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const schema = [...readerText.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));

// Exercise the ACTUAL subject/spatial/source capture, persistence and reopen
// contracts over bounded query fakes. Not native PostgreSQL/MVCC/rights evidence.
async function retainedFixture({ parcelCount = 2, missingCounty = false } = {}) {
  const f = customCohortRepositoryFixture(), t = f.state.input.target;
  const property = JSON.parse(f.state.input.snapshot.subject_data.pg_text).custom_property_snapshot;
  setPublic(f.state.input, { ...property, location: { account_id: t.account_id, longitude: -96.65, latitude: 32.91,
    source: 'dcad_parcel_query', precision: 'parcel_centroid', status: 'matched', confidence: 'high', review_required: false,
    review_reason: null, match_method: 'parcel_id', source_parcel_id: t.account_id, feature_count: 1,
    metadata: { address_agreement: true }, geocoded_at: '2023-12-31T00:00:00.000Z', source_updated_at: null } });
  const subjectRef = await f.repo.capture(), subject = await f.repo.load(subjectRef), point = await f.repo.loadRecordedPoint(subjectRef);
  const accountIds = [t.account_id, 'R-001'];
  const parcels = Array.from({ length: parcelCount }, (_, index) => ({ object_id: String(9007199254740993n + BigInt(index)),
    account_id: accountIds[index % 2], source_record_hash: 'a'.repeat(64), sync_run_id: RUN, synced_at: NOW,
    source_updated_at: null, geometry_sha256: createHash('sha256').update(Buffer.from(GEOMETRY, 'hex')).digest('hex') }));
  const transaction = { source_record_id: '10', sale_id: '20', primary_account_id: t.account_id,
    sale_account_id: t.account_id, source_record_hash: 'b'.repeat(64) };
  const links = [{ parcel_link_id: '100', source_record_id: '10', source_position: 1,
    parcel_sequence: 1, account_id: 'R-LINKED-ONLY', is_resolved: true }];
  const client = { release() { assert.fail('owner transaction'); }, async query(config) {
    const v = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...SNAPSHOT,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) return { rows: parcels
      .filter(p => v[2] === null || BigInt(p.object_id) > BigInt(v[2])).slice(0, v[3]).map(payload => ({ payload })) };
    if (tag === 'scope') return { rows: [{ case_date: subject.effective_date, snapshot_date: subject.effective_date,
      effective_date: subject.effective_date, captured_at: MS, captured_at_precise: NOW }] };
    if (tag === 'capabilities') return { rows: schema };
    let rows;
    switch (tag) {
      case 'parcels': rows = parcels.filter(p => BigInt(p.object_id) > BigInt(v[1])).slice(0, v[2]).map(p => ({ ...p,
        stored_geometry_ewkb: GEOMETRY, residential_year_built: 2000, residential_area_sqft: '1800.125',
        parcel_area_sqft: '6000', current_market_value: '350000', land_use_category: 'one_unit', classification_confidence: 'high' })); break;
      case 'accounts': rows = accountIds.filter(id => id > v[1]).slice(0, v[2]).map(account_id => ({ account_id,
        county: missingCounty ? null : 'Dallas', subdivision: account_id === t.account_id ? 'Recorded Subject Plat' : 'Recorded Other Plat' })); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(parcelCount), last_run_id: RUN, last_success_at: MS }]; break;
      case 'sync-runs': rows = [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: MS }]; break;
      case 'source-ids': rows = v[1] === '0' ? [{ source_record_id: '10' }] : []; break;
      case 'transaction-identities': rows = [transaction]; break;
      case 'transactions': rows = [{ ...transaction, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
        source_close_date: '2024-03-01', sale_price: '275000', source_current_price: '275000', source_living_area: '1850.125',
        source_year_built: 2001, source_garage_yn: false, source_housing_type: 'Single family', source_days_on_market: 0, data_quality_flags: [] }]; break;
      case 'link-identities': case 'sale-links': rows = links.filter(p => p.parcel_sequence > v[3]).slice(0, v[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(`Unexpected capture query: ${tag}`);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(client, point.geometry_input);
  const scope = customCohortScopeOf(f.state.input), scopeJson = json(scope);
  const target = { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id };
  const readScope = { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id,
    subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id };
  const selector = prepareNeighborhoodSelectorInputV1({ profile_id: 'custom-simple-suburban-radius-v1', target, scope: readScope,
    effective_date: subject.effective_date, selection: { id: 'original-preparation-test', revision: 1, source_sha256: spatial.membership_sha256 },
    geometry_input: point.geometry_input, discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1',
      parcel_predicate: 'all_intersecting_parcels' }, roster: { complete: true, account_count: accountIds.length, account_ids: accountIds } });
  const study = { profile_id: selector.query_input.definition.profile_id,
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, knowledge_cutoff: null };
  const access = createTestCachedReadAccess({ target, scope: readScope, effective_date: subject.effective_date,
    selection: selector.selection, account_ids: accountIds, ...study }, { transactionClosure: {
    source_revision: 'original-preparation-closure', transactions: [transaction], links, legacy: [] } });
  const issued = await access.prepare(), reader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('owner transaction'); } }, { access: access.access });
  const captured = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  const acquisition = consumeNeighborhoodCachedAcquisition(reader, captured);
  const store = createNeighborhoodCohortBlobRepository(f.client, scope.organization_id);
  const body = { intent_version: 1, operation_id: '30000000-0000-4000-8000-000000000001', actor_user_id: access.auth.userId,
    subject_inputs: subjectRef, target: subject.target, effective_date: subject.effective_date, study, created_at: '2026-09-06T07:59:59.000000Z' };
  const retained = { acquisition, spatial, subject, subject_reference: subjectRef, selector, study,
    acquisition_intent: { reference: await store.put(json(body)), body },
    started_at: '2026-09-06T08:00:00.010000Z', completed_at: '2026-09-06T08:00:01.000000Z' };
  const originalQuery = f.client.query.bind(f.client);
  f.client.query = (sql, values) => originalQuery(sql.replace('custom-cohort-capture:transaction', 'custom-cohort-selection:transaction'), values);
  const refs = await persistCustomCohortCaptureInputs(f.client, scopeJson, prepareCustomCohortCaptureInputs(retained));
  const reopened = await loadCustomCohortCaptureInputs(f.client, scopeJson, refs);
  const headerJson = json({ context_version: 1, context_id: body.operation_id, context_revision: '1',
    target: { ...target, ...readScope, snapshot_version: subject.target.snapshot_version }, effective_date: subject.effective_date, ...refs });
  const context = prepareCustomCohortContextHeader(headerJson).context_ref;
  const preview = buildCustomCohortObservationPreview({ context_ref: context, retained_inputs: reopened.retained_inputs,
    selection: { revision: 7, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: reopened.retained_inputs, preview });
  f.state.calls.length = 0;
  return { f, accountIds, catalog, preview, input: { context_header_json: headerJson,
    expected: { context_ref: context, target: scope, observation_period: study.observation_period },
    retained_inputs: reopened.retained_inputs,
    selection: { revision: 7, included_recorded_group_ids: catalog.pockets.map(p => p.id) } } };
}
const base = retainedFixture();
const fresh = async () => structuredClone((await base).input);
function replaceHeader(input, mutate) {
  const header = JSON.parse(input.context_header_json); mutate(header);
  input.context_header_json = json(header);
  input.expected.context_ref = prepareCustomCohortContextHeader(input.context_header_json).context_ref;
}

test('actual retained capture is exactly bound but remains diagnostic/incomplete without side effects', async () => {
  const { input, f, preview } = await base, before = JSON.stringify(input), output = prepare(input);
  assert.equal(output.status, 'incomplete'); assert.equal(output.authority, 'not_established');
  assert.equal(output.assessment, null); assert.equal(output.publication, null); assert.equal(output.apply.status, 'blocked');
  assert.deepEqual(output.binding.context_ref, input.expected.context_ref);
  assert.deepEqual(output.binding.target, input.expected.target);
  assert.deepEqual(output.binding.selection, input.selection);
  assert.deepEqual(output.support_gaps, preview.support_gaps);
  assert.deepEqual(output.unavailable_metrics, preview.unavailable_metrics);
  assert.deepEqual(output.runtime_requirements, { authorization: 'not_checked', provider_rights: 'not_checked', subject_freshness: 'not_checked' });
  assert.deepEqual(output.observations.all, { discovery_accounts: 2, parcel_objects: 2,
    canonical_transactions_in_period: 1, transactions_with_multiple_parcel_evidence: 1, source_records_all_dates: 1 });
  assert.deepEqual(output.observations.selected, output.observations.all);
  assert.equal(output.binding.selected_account_set_sha256, neighborhoodMemberSetDigest((await base).accountIds));
  assert.equal(f.state.calls.length, 0); assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(output.observations.selected));
  assert.ok(Buffer.byteLength(json(output)) < 32768);
  assert.doesNotMatch(json(output), /raw_projection|raw_values|canonical_transaction_id|275000|stored_geometry|R-LINKED-ONLY/);
});

test('explicit empty selection stays empty even when discovery has transactions and matching named groups', async () => {
  const input = await fresh(); input.selection.included_recorded_group_ids = [];
  const output = prepare(input);
  assert.deepEqual(output.binding.selection.included_recorded_group_ids, []);
  assert.equal(output.observations.all.discovery_accounts, 2);
  assert.ok(Object.values(output.observations.selected).every(value => value === 0));
  assert.equal(output.selection_resolution.subject_included, false);
  assert.equal(output.binding.selected_account_set_sha256, neighborhoodMemberSetDigest([]));
  assert.ok(output.apply.reasons.includes('empty_selection'));
});

test('selected groups resolve exact accounts, preserve revision, and do not pull linked-only parcel identities into stock', async () => {
  const input = await fresh(), { catalog, accountIds } = await base;
  const group = catalog.pockets.find(p => p.account_ids.includes(accountIds[0]));
  input.selection = { revision: 23, included_recorded_group_ids: [group.id] };
  const output = prepare(input);
  assert.equal(output.binding.selection.revision, 23);
  assert.equal(output.selection_resolution.subject_included, true);
  assert.equal(output.observations.selected.discovery_accounts, 1);
  assert.equal(output.observations.selected.canonical_transactions_in_period, 1);
  assert.equal(output.observations.selected.transactions_with_multiple_parcel_evidence, 1);
  assert.equal(output.binding.selected_account_set_sha256, neighborhoodMemberSetDigest([accountIds[0]]));
  input.selection.included_recorded_group_ids = catalog.pockets.filter(p => p.id !== group.id).map(p => p.id);
  const other = prepare(input);
  assert.equal(other.observations.selected.discovery_accounts, 1);
  assert.equal(other.observations.selected.canonical_transactions_in_period, 0);
  assert.equal(other.observations.selected.source_records_all_dates, 0);
});

test('unknown/missing county is explicit unassigned membership, not inferred subdivision identity', async () => {
  const { input } = await retainedFixture({ missingCounty: true });
  input.selection.included_recorded_group_ids = ['discovery:unassigned'];
  const output = prepare(input);
  assert.equal(output.observations.selected.discovery_accounts, 2);
  assert.equal(output.selection_resolution.legal_subdivision_identity, 'not_established');
  assert.equal(output.status, 'incomplete');
});

test('large original multi-page capture is not reduced to a prefix or encoded as one bounded blob', async () => {
  const { input } = await retainedFixture({ parcelCount: 1001 });
  const output = prepare(input);
  assert.equal(output.observations.all.parcel_objects, 1001);
  assert.equal(output.observations.selected.parcel_objects, 1001);
  assert.equal(output.observations.all.discovery_accounts, 2);
});

for (const [name, mutate, reason] of [
  ['wrong account', i => { i.expected.target.account_id = 'OTHER'; }, 'target_mismatch'],
  ['wrong assignment', i => { i.expected.target.assignment_file_id = '123'; }, 'target_mismatch'],
  ['wrong organization', i => { i.expected.target.organization_id = '90000000-0000-4000-8000-000000000001'; }, 'target_mismatch'],
  ['wrong report', i => { i.expected.target.report_file_id = '90000000-0000-4000-8000-000000000001'; }, 'target_mismatch'],
  ['stale context', i => { i.expected.context_ref.context_sha256 = 'f'.repeat(64); }, 'context_mismatch'],
  ['different period', i => { i.expected.observation_period.start_date = '2023-06-01'; }, 'observation_period_mismatch'],
  ['unknown group', i => { i.selection.included_recorded_group_ids = [`recorded-cad:${'f'.repeat(64)}`]; }, 'unknown_recorded_group'],
  ['empty unassigned group absent from catalog', i => { i.selection.included_recorded_group_ids = ['discovery:unassigned']; }, 'unknown_recorded_group'],
  ['header belongs to another capture', i => replaceHeader(i, h => { h.context_id = '90000000-0000-4000-8000-000000000001'; }), 'capture_identity_mismatch'],
  ['header belongs to another effective date', i => replaceHeader(i, h => { h.effective_date = '2024-06-29'; }), 'effective_date_mismatch'],
  ['header belongs to another snapshot', i => replaceHeader(i, h => { h.target.snapshot_version++; }), 'subject_target_mismatch'],
  ...['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [`changed ${key}`, i => replaceHeader(i,
    h => { h[key].content_sha256 = 'f'.repeat(64); }), 'retained_evidence_mismatch']),
]) test(`rejects ${name} before emitting any diagnostic group`, async () => {
  const input = await fresh(); mutate(input);
  assert.throws(() => prepare(input), error => error.code === 'CUSTOM_COHORT_ASSESSMENT_PREPARATION_INVALID' && error.reason === reason);
});

for (const [name, mutate] of [
  ['duplicate group', i => { i.selection.included_recorded_group_ids.push(i.selection.included_recorded_group_ids[0]); }],
  ['malformed group', i => { i.selection.included_recorded_group_ids = ['ALL']; }],
  ['missing selection', i => { delete i.selection; }],
  ['null selection', i => { i.selection = null; }],
  ['zero revision', i => { i.selection.revision = 0; }],
  ['rounded revision', i => { i.selection.revision = Number.MAX_SAFE_INTEGER + 1; }],
  ['impossible date', i => { i.expected.observation_period.start_date = '2023-02-30'; }],
  ['reversed period', i => { i.expected.observation_period.start_date = '2025-01-01'; }],
  ['changed retained source', i => { i.retained_inputs.acquisition.capture_result.source_capture.sources[0].payload.records.push({ record_id: 'invented' }); }],
  ['changed roster', i => { i.retained_inputs.spatial.account_ids.pop(); }],
  ['changed knowledge cutoff', i => { i.retained_inputs.study.knowledge_cutoff = MS; }],
  ['extra supported-fact claims', i => { i.supported_facts = { housing_eligible: true, completed_sale: true }; }],
  ['extra authority claims', i => { i.expected.provider_rights = true; }],
  ['extra client statistics', i => { i.statistics = { reliability: 100, predominant: 275000 }; }],
  ['caller supplied boundary', i => { i.geometry = { type: 'Polygon', coordinates: [] }; }],
]) test(`does not accept ${name} or default it to all`, async () => {
  const input = await fresh(); mutate(input); assert.throws(() => prepare(input));
});

test('does not invoke accessors, toJSON, or proxy traps while admitting caller data', async () => {
  for (const position of ['root', 'retained', 'selection']) {
    const input = await fresh(); let invoked = 0;
    const object = position === 'root' ? input : position === 'retained' ? input.retained_inputs : input.selection;
    Object.defineProperty(object, 'side_effect', { enumerable: true, get() { invoked++; throw new Error('getter'); } });
    assert.throws(() => prepare(input), /plain_data_required/); assert.equal(invoked, 0);
  }
  const input = await fresh(); let invoked = 0;
  input.toJSON = () => { invoked++; return {}; };
  assert.throws(() => prepare(input), /plain_data_required/); assert.equal(invoked, 0);
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; throw new Error('trap'); } });
  assert.throws(() => prepare(proxy), /plain_data_required/); assert.equal(invoked, 0);
});

test('rejects cycles, sparse arrays, excessive depth, and non-JSON primitives', async () => {
  for (const value of [undefined, 3n, NaN, Infinity, new Date(), new Map()]) {
    const input = await fresh(); input.invalid = value; assert.throws(() => prepare(input), /plain_data_required/);
  }
  const cycle = {}; cycle.self = cycle; assert.throws(() => prepare(cycle), /plain_data_required/);
  const input = await fresh(); input.selection.included_recorded_group_ids = new Array(2);
  assert.throws(() => prepare(input), /plain_data_required/);
  let deep = {}; for (let n = 0; n < 42; n++) deep = { child: deep };
  assert.throws(() => prepare(deep), /input_limit/);
});
