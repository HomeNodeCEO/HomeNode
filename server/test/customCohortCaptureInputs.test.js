import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs as prepare, persistCustomCohortCaptureInputs as persist,
  loadCustomCohortCaptureInputs as load } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareNeighborhoodSelectorInputV1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './fixtures/customCohortRepositoryFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { setPublic } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const NOW = '2026-09-06T08:00:00.123456Z', MS = '2026-09-06T08:00:00.123Z';
const RUN = '60000000-0000-4000-8000-000000000001';
const SNAPSHOT = { backend_pid: 1234, snapshot: '100:100:', transaction_started_at: '2026-09-06T08:00:00.000000Z' };
const GEOMETRY = '010203', GEOMETRY_HASH = createHash('sha256').update(Buffer.from(GEOMETRY, 'hex')).digest('hex');
const readerSource = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const tableText = readerSource.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1];
const CATALOG = [...tableText.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));

// Actual repository, spatial reader, access factory, source reader and consumed
// handoff over bounded query fakes. This is NOT native PostgreSQL/MVCC evidence.
async function fixture({ parcelCount = 2, linkCount = 1, accountCount = 2, omitAccountRows = false, qualityFlags = [] } = {}) {
  const f = customCohortRepositoryFixture(), t = f.state.input.target;
  const originalProperty = JSON.parse(f.state.input.snapshot.subject_data.pg_text).custom_property_snapshot;
  setPublic(f.state.input, { ...originalProperty, location: { account_id: t.account_id, longitude: -96.65, latitude: 32.91,
    source: 'dcad_parcel_query', precision: 'parcel_centroid', status: 'matched', confidence: 'high',
    review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: t.account_id,
    feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2023-12-31T00:00:00.000Z', source_updated_at: null } });
  const subjectRef = await f.repo.capture(), subject = await f.repo.load(subjectRef), point = await f.repo.loadRecordedPoint(subjectRef);
  assert.equal(point.status, 'represented');
  const accountIds = accountCount === 2 ? [t.account_id, 'R-001']
    : [t.account_id, ...Array.from({ length: accountCount - 1 }, (_, i) => `R-${String(i).padStart(62, '0')}`)];
  const parcels = Array.from({ length: parcelCount }, (_, i) => ({ object_id: String(9007199254740993n + BigInt(i)),
    account_id: accountIds[i % accountIds.length], source_record_hash: 'a'.repeat(64), sync_run_id: RUN,
    synced_at: NOW, source_updated_at: null, geometry_sha256: GEOMETRY_HASH }));
  const transaction = { source_record_id: '10', sale_id: '20', primary_account_id: t.account_id,
    sale_account_id: t.account_id, source_record_hash: 'b'.repeat(64) };
  const links = Array.from({ length: linkCount }, (_, i) => ({ parcel_link_id: String(100 + i), source_record_id: '10',
    source_position: 1, parcel_sequence: i + 1, account_id: i % 2 ? null : 'R-LINKED-ONLY', is_resolved: i % 2 ? false : true }));
  const cacheClient = { release() { assert.fail('caller owns release'); }, async query(config) {
    const values = config.values ?? [], tag = config.text.match(/neighborhood-(?:cache|membership):([\w-]+)/)?.[1];
    if (['snapshot', 'snapshot-end', 'caller-snapshot'].includes(tag)) return { rows: [{ ...SNAPSHOT,
      isolation: 'repeatable read', read_only: 'on', timezone: 'UTC', explicit_transaction: true,
      statement_ms: 5000, lock_ms: 1000, idle_ms: 10000 }] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (config.text.includes('neighborhood-membership:parcels')) return { rows: parcels
      .filter(p => values[2] === null || BigInt(p.object_id) > BigInt(values[2])).slice(0, values[3]).map(payload => ({ payload })) };
    if (tag === 'scope') return { rows: [{ case_date: subject.effective_date, snapshot_date: subject.effective_date,
      effective_date: subject.effective_date, captured_at: MS, captured_at_precise: NOW }] };
    if (tag === 'capabilities') return { rows: CATALOG };
    let rows;
    switch (tag) {
      case 'parcels': rows = parcels.filter(p => BigInt(p.object_id) > BigInt(values[1])).slice(0, values[2]).map(p => ({
        ...p, stored_geometry_ewkb: GEOMETRY, residential_year_built: 2000, residential_area_sqft: '1800.125',
        parcel_area_sqft: '6000.00', current_market_value: '350000', land_use_category: 'one_unit', classification_confidence: 'high' })); break;
      case 'accounts': rows = omitAccountRows ? [] : accountIds.filter(id => id > values[1]).slice(0, values[2]).map(account_id => ({ account_id, subdivision: 'Recorded Café Plat' })); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(parcelCount), last_run_id: RUN, last_success_at: MS }]; break;
      case 'sync-runs': rows = [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: MS }]; break;
      case 'source-ids': rows = values[1] === '0' ? [{ source_record_id: '10' }] : []; break;
      case 'transaction-identities': rows = [transaction]; break;
      case 'transactions': rows = [{ ...transaction, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
        source_close_date: '2024-03-01', sale_price: '275000.00', source_current_price: '275000.00', source_living_area: '1850.125',
        source_year_built: 2001, source_garage_yn: false, source_housing_type: 'Recorded label, not an eligibility decision',
        source_days_on_market: 0, data_quality_flags: qualityFlags }]; break;
      case 'link-identities': case 'sale-links': rows = links.filter(p => p.parcel_sequence > values[3]).slice(0, values[4]); break;
      case 'legacy-identities': case 'legacy': rows = []; break;
      default: assert.fail(`Unexpected source query ${tag}`);
    }
    return { rows: rows.map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const spatial = await captureNeighborhoodSpatialMembership(cacheClient, point.geometry_input);
  assert.equal(spatial.status, 'captured');
  const scope = customCohortScopeOf(f.state.input), scopeJson = json(scope);
  const target = { report_file_id: t.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id };
  const readScope = { organization_id: t.organization_id, appraisal_case_id: t.appraisal_case_id, subject_snapshot_id: t.subject_snapshot_id, account_id: t.account_id };
  const selector = prepareNeighborhoodSelectorInputV1({ profile_id: 'custom-simple-suburban-radius-v1', target, scope: readScope,
    effective_date: subject.effective_date, selection: { id: 'original-fixture-selection', revision: 1, source_sha256: spatial.membership_sha256 },
    geometry_input: point.geometry_input, discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
    roster: { complete: true, account_count: accountIds.length, account_ids: accountIds } });
  assert.equal(selector.status, 'prepared');
  const study = { profile_id: selector.query_input.definition.profile_id,
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, knowledge_cutoff: null };
  const access = createTestCachedReadAccess({ target, scope: readScope, effective_date: subject.effective_date,
    selection: selector.selection, account_ids: accountIds, ...study }, { transactionClosure: {
    source_revision: 'original-fixture-closure-v1', transactions: [transaction], links, legacy: [] } });
  const issued = await access.prepare(), reader = createNeighborhoodCachedSourceReader({ connect() { assert.fail('must use owner'); } }, { access: access.access });
  const result = await reader.captureInSnapshot(cacheClient, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(result.status, 'captured', JSON.stringify(result.incomplete_reasons));
  const acquisition = consumeNeighborhoodCachedAcquisition(reader, result);
  const store = createNeighborhoodCohortBlobRepository(f.client, scope.organization_id);
  const intentBody = { intent_version: 1, operation_id: '30000000-0000-4000-8000-000000000001', actor_user_id: access.auth.userId,
    subject_inputs: subjectRef, target: subject.target, effective_date: subject.effective_date, study, created_at: '2026-09-06T07:59:59.000000Z' };
  const intentRef = await store.put(json(intentBody));
  const input = { acquisition, spatial, subject, subject_reference: subjectRef, selector, study,
    acquisition_intent: { reference: intentRef, body: intentBody }, started_at: '2026-09-06T08:00:00.010000Z', completed_at: '2026-09-06T08:00:01.000000Z' };
  const query = f.client.query.bind(f.client);
  f.client.query = (sql, values) => query(sql.replace('custom-cohort-capture:transaction', 'custom-cohort-selection:transaction'), values);
  f.state.calls.length = 0;
  return { ...f, input, scope, scopeJson, store, reader };
}

for (const parcelCount of [2, 1001]) test(`retains/reopens complete original graph with ${parcelCount} spatial rows`, async () => {
  const f = await fixture({ parcelCount, linkCount: 251 }), original = JSON.stringify(f.input);
  const prepared = prepare(f.input);
  assert.equal(f.state.calls.length, 0, 'all bundle preflight is pure');
  assert.ok(prepared.counts.references > prepared.counts.blobs, 'duplicate logical references are charged');
  const refs = await persist(f.client, f.scopeJson, prepared), reopened = await load(f.client, f.scopeJson, refs);
  assert.deepEqual(reopened.refs, refs); assert.deepEqual(reopened.acquisition_intent, f.input.acquisition_intent);
  assert.deepEqual(reopened.study, f.input.study); assert.deepEqual(reopened.subject_reference, f.input.subject_reference);
  assert.deepEqual(reopened.retained_inputs, f.input);
  assert.ok(Object.isFrozen(reopened.retained_inputs.acquisition.capture_result.source_capture.sources));
  assert.throws(() => consumeNeighborhoodCachedAcquisition(f.reader, reopened.retained_inputs.acquisition.capture_result), /original_capture_required/);
  assert.deepEqual(reopened.retained_inputs.acquisition.capture_result.unsupported_capabilities,
    f.input.acquisition.capture_result.unsupported_capabilities);
  assert.equal(reopened.summary.parcel_count, parcelCount); assert.equal(reopened.authority, 'not_established');
  assert.equal(JSON.stringify(f.input), original);
  const texts = [...f.state.db.values()].map(row => row.canonical_utf8);
  for (const originalSource of f.input.acquisition.capture_result.source_capture.sources) assert.ok(texts.includes(json(originalSource.payload)));
  assert.ok(texts.includes(f.input.acquisition.compact_metadata_json));
  assert.ok(texts.some(t => t.includes('R-LINKED-ONLY') && t.includes('closure_links')));
  assert.ok(texts.some(t => t.includes('source_days_on_market') && t.includes('1850.125')));
  assert.ok(texts.some(t => t.includes('9007199254740993')));
  assert.ok(f.state.calls.every(c => ['read', 'insert', 'transaction', 'history-target'].includes(c.tag)));
});

for (const [name, mutate] of [
  ['incomplete original', i => { i.acquisition.capture_result.query_complete = false; }],
  ['foreign snapshot', i => { i.acquisition.capture_result.snapshot.backend_pid++; }],
  ['changed roster', i => { i.spatial.account_ids.pop(); }],
  ['changed parcel evidence', i => { i.spatial.parcels[0].geometry_sha256 = 'f'.repeat(64); }],
  ['changed query metadata', i => { i.acquisition.compact_metadata_json += ' '; }],
  ['changed source payload', i => { i.acquisition.capture_result.source_capture.sources[0].payload.records.push({ record_id: 'fake', data: {} }); }],
  ['missing source chunk', i => { i.acquisition.capture_result.source_capture.sources.pop(); }],
  ['changed source routing', i => { i.acquisition.capture_result.source_capture.references[0].record_sources.pop(); }],
  ['foreign closure identity', i => { i.acquisition.captured_query_request.transaction_closure.links[0].account_id = 'FOREIGN'; }],
  ['selector mismatch', i => { i.selector.selection.source_sha256 = 'f'.repeat(64); }],
  ['subject reference mismatch', i => { i.subject_reference.content_sha256 = 'f'.repeat(64); }],
  ['unsupported study', i => { i.study.profile_id = 'invented'; }],
  ['historical cutoff', i => { i.study.knowledge_cutoff = MS; }],
  ['intent changed actor', i => { i.acquisition_intent.body.actor_user_id = 'other'; }],
  ['intent foreign target', i => { i.acquisition_intent.body.target.report_file_id = RUN; }],
  ['start before intent', i => { i.started_at = '2026-09-06T07:00:00.000000Z'; }],
  ['finish before observed query', i => { i.completed_at = i.started_at; }],
  ['wrong timestamp precision', i => { i.completed_at = MS; }],
]) test(`preflight refuses ${name} without any database activity`, async () => {
  const f = await fixture(), changed = structuredClone(f.input); mutate(changed);
  assert.throws(() => prepare(changed)); assert.equal(f.state.calls.length, 0); assert.equal(f.state.db.size, 6);
});

test('persist refuses copied preparation, foreign scope and missing original intent before writes', async () => {
  const f = await fixture(), prepared = prepare(f.input);
  await assert.rejects(persist(f.client, f.scopeJson, structuredClone(prepared)), /original_preparation_required/);
  await assert.rejects(persist(f.client, json({ ...f.scope, report_file_id: RUN }), prepared), /scope_mismatch/);
  f.state.db.delete(`${f.scope.organization_id}:${f.input.acquisition_intent.reference.content_sha256}`);
  await assert.rejects(persist(f.client, f.scopeJson, prepared), /missing_original_input/);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert').length, 0);
});

test('autocommit and storage errors propagate; owner alone rolls back or commits', async () => {
  const f = await fixture(), prepared = prepare(f.input); let tx = 1;
  f.state.transforms.transaction = () => ({ transaction_id: String(tx++) });
  await assert.rejects(persist(f.client, f.scopeJson, prepared), /caller_transaction_required/);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert').length, 0);
  delete f.state.transforms.transaction;
  const error = Object.assign(new Error('synthetic timeout'), { code: '57014' });
  f.state.error = { tag: 'insert', value: error };
  await assert.rejects(persist(f.client, f.scopeJson, prepared), actual => actual === error);
  assert.equal(f.state.calls.filter(c => c.tag === 'insert').length, 1);
});

test('reopen rejects missing source payload, corrupted originals and substituted dependency refs', async () => {
  const f = await fixture(), refs = await persist(f.client, f.scopeJson, prepare(f.input));
  const sourceHash = f.input.acquisition.capture_result.source_capture.source_snapshots[0].content_sha256;
  const key = `${f.scope.organization_id}:${sourceHash}`, saved = f.state.db.get(key);
  f.state.db.delete(key); await assert.rejects(load(f.client, f.scopeJson, refs), /missing_evidence/);
  f.state.db.set(key, { ...saved, canonical_utf8: '{}' }); await assert.rejects(load(f.client, f.scopeJson, refs), /storage_conflict/);
  f.state.db.set(key, saved);
  const foreign = await f.store.put('{"not_the_study":true}');
  await assert.rejects(load(f.client, f.scopeJson, { ...refs, subject_dependencies: foreign }), /invalid_shape|stored_graph_mismatch/);
  await assert.rejects(load(f.client, json({ ...f.scope, organization_id: RUN }), refs), /missing_evidence/);
  await assert.rejects(load(f.client, json({ ...f.scope, report_file_id: RUN }), refs), /target_mismatch/);
});

test('reopen requires actual stored material-profile and recorded-point descendants, not just matching recomputed hashes', async () => {
  const f = await fixture(), refs = await persist(f.client, f.scopeJson, prepare(f.input));
  const dependencies = JSON.parse(await f.store.get(refs.subject_dependencies.content_sha256, refs.subject_dependencies.canonical_utf8_bytes));
  for (const ref of [dependencies.material_profile.definition_blob, dependencies.recorded_point]) {
    const key = `${f.scope.organization_id}:${ref.content_sha256}`, original = f.state.db.get(key);
    f.state.db.delete(key);
    await assert.rejects(load(f.client, f.scopeJson, refs), /missing_evidence/);
    f.state.db.set(key, original);
  }
  assert.equal((await load(f.client, f.scopeJson, refs)).summary.account_count, 2);
});

test('ref-shaped raw source values remain literal evidence, never graph edges or permission', async () => {
  const qualityFlags = [{ content_sha256: 'literal source value, not a blob reference', canonical_utf8_bytes: 'unknown' }];
  const f = await fixture({ qualityFlags }), refs = await persist(f.client, f.scopeJson, prepare(f.input));
  const retained = await load(f.client, f.scopeJson, refs);
  const records = retained.retained_inputs.acquisition.capture_result.source_capture.sources
    .filter(source => source.payload.projection.definition.role === 'transactions').flatMap(source => source.payload.records);
  assert.deepEqual(records[0].data.raw_projection.data_quality_flags, qualityFlags);
});

test('oversized duplicate logical refs and malformed page directories cannot become cheap deduplicated loads', async () => {
  const f = await fixture(), refs = await persist(f.client, f.scopeJson, prepare(f.input));
  const selection = JSON.parse(await f.store.get(refs.selection_input.content_sha256, refs.selection_input.canonical_utf8_bytes));
  const manifestRef = selection.spatial.parcels;
  const manifest = JSON.parse(await f.store.get(manifestRef.content_sha256, manifestRef.canonical_utf8_bytes));
  manifest.pages.push(manifest.pages[0]);
  selection.spatial.parcels = await f.store.put(json(manifest));
  const altered = { ...refs, selection_input: await f.store.put(json(selection)) };
  await assert.rejects(load(f.client, f.scopeJson, altered), /invalid_directory/);
  assert.equal((await load(f.client, f.scopeJson, refs)).summary.parcel_count, 2);
});

test('retains closure and routing larger than the per-blob canonical JSON ceiling without changing that ceiling', async () => {
  const f = await fixture({ linkCount: 12000 });
  assert.ok(Buffer.byteLength(JSON.stringify(f.input.acquisition.captured_query_request.transaction_closure)) > 1_500_000);
  assert.ok(Buffer.byteLength(JSON.stringify(f.input.acquisition.capture_result.source_capture.references)) > 1_500_000);
  const refs = await persist(f.client, f.scopeJson, prepare(f.input));
  const retained = await load(f.client, f.scopeJson, refs);
  assert.equal(retained.summary.account_count, 2);
  assert.ok([...f.state.db.values()].every(row => Number(row.canonical_utf8_bytes) <= 1_500_000));
});

test('retains a multi-blob query bundle larger than one blob with every original account preserved', async () => {
  const f = await fixture({ parcelCount: 18000, accountCount: 18000, omitAccountRows: true });
  assert.ok(Buffer.byteLength(JSON.stringify(f.input.acquisition.capture_result.query_evidence)) > 1_500_000);
  const refs = await persist(f.client, f.scopeJson, prepare(f.input));
  assert.equal((await load(f.client, f.scopeJson, refs)).summary.account_count, 18000);
  assert.ok([...f.state.db.values()].every(row => Number(row.canonical_utf8_bytes) <= 1_500_000));
});
