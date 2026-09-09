import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { buildCustomCohortObservationPreview } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { createNeighborhoodSaleWitnessSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareNeighborhoodSelectorInputV1 } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './customCohortRepositoryFixture.js';
import { createTestCachedReadAccess } from './neighborhoodCachedReadAccessFixture.js';
import { setPublic } from './neighborhoodCustomMaterialInputsFixture.js';
import { createNeighborhoodSaleWitnessReadAccess } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { CACHED_SALE_WITNESS_FIELDS, prepareCachedSaleWitness } from '../../src/services/neighborhoodAssessment/cachedSaleWitness.js';

const DEFAULT_RAW_PAYLOAD = Object.freeze({ CurrentPrice: '275000', ListPrice: '280000', ClosePrice: '275000',
  CloseDate: '2024-03-01', MlsStatus: 'Closed', LivingArea: '1850.125', LivingAreaUnits: 'Square Feet',
  PropertySubType: 'Single Family Residence', Currency: 'USD', PropertyAttachedYN: false });

/** Synthetic bounded query-result cells only, NOT an implementation oracle for
 * the PostgreSQL transform or evidence of original provider/ingestion bytes.
 * undefined denotes SQL NULL; null denotes JSON null. For exact numeric text
 * beyond JavaScript Number precision, supply an explicit witness override.
 */
export function syntheticSaleWitness(rawPayload) {
  const object = rawPayload !== null && typeof rawPayload === 'object' && !Array.isArray(rawPayload);
  assert.ok(!object || Object.getPrototypeOf(rawPayload) === Object.prototype, 'synthetic plain JSON object only');
  const kind = value => Array.isArray(value) ? 'array' : typeof value;
  const root = rawPayload === undefined ? 'sql_null' : rawPayload === null ? 'json_null' : object ? 'object' : 'non_object';
  const rootType = rawPayload === undefined ? null : rawPayload === null ? 'null' : kind(rawPayload);
  const fields = Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => {
    let state = 'payload_unavailable', json_type = null, value_text = null, utf8_bytes = null;
    if (object) {
      if (!Object.hasOwn(rawPayload, key)) state = 'absent';
      else if (rawPayload[key] === null) { state = 'json_null'; json_type = 'null'; }
      else {
        const value = rawPayload[key]; json_type = kind(value);
        if (['array', 'object'].includes(json_type)) state = 'non_scalar';
        else {
          assert.ok(['string', 'number', 'boolean'].includes(json_type), 'synthetic JSON scalar only');
          assert.ok(json_type !== 'number' || Number.isFinite(value), 'synthetic finite JSON number only');
          value_text = String(value); utf8_bytes = Buffer.byteLength(value_text);
          state = utf8_bytes > 512 ? 'oversize' : 'scalar';
          if (state === 'oversize') value_text = null;
        }
      }
    }
    return [key, { state, json_type, value_text, utf8_bytes }];
  }));
  return prepareCachedSaleWitness({ witness_version: 1, root_state: root, root_json_type: rootType, fields });
}

const NOW = '2026-09-06T08:00:00.123456Z', MS = '2026-09-06T08:00:00.123Z';
const RUN = '60000000-0000-4000-8000-000000000001', GEOMETRY = '010203';
const SNAPSHOT = { backend_pid: 1234, snapshot: '100:100:', transaction_started_at: '2026-09-06T08:00:00.000000Z' };
const readerText = readFileSync(new URL('../../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const schema = [...readerText.match(/const TABLES = Object.freeze\(\{([\s\S]*?)\n\}\);/)[1].matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
schema.push(...['mls_status', 'source_row_number', 'raw_payload'].map(column => ({ relation: 'core.sales_source_records', column })));

// Actual mapping3 factories, original one-use acquisition, subject/spatial
// capture, persistence and reopen over bounded query fakes. No v2 capture is
// modified, rehashed or relabeled. NOT native PostgreSQL/MVCC/rights evidence.
export async function saleWitnessMeaningFixture(options = {}) {
  const { parcelCount = 2, missingCounty = false, saleOverrides = {}, extraTransactions = [] } = options;
  const rawPayload = Object.hasOwn(options, 'rawPayload') ? options.rawPayload : DEFAULT_RAW_PAYLOAD;
  const witness = Object.hasOwn(options, 'witness') ? options.witness : syntheticSaleWitness(rawPayload);
  assert.ok(!Object.hasOwn(options, 'mappingVersion'), 'fixture is original mapping3 only; use decisionEvidenceFixture for original mapping2');
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
  const legacy = extraTransactions.filter(row => row.source_record_id === null).map(row => ({ ...row }));
  const extras = extraTransactions.filter(row => row.source_record_id !== null).map(row => ({ source_mls_status: null, source_row_number: null,
    source_raw_witness: syntheticSaleWitness(undefined), ...row }));
  const transactions = [transaction, ...extras.map(row => Object.fromEntries(Object.keys(transaction).map(key => [key, row[key]])))];
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
      case 'parcels': rows = parcels.filter(p => BigInt(p.object_id) > BigInt(v[1])).slice(0, v[2]).map(({ geometry_sha256, ...p }) => ({ ...p,
        stored_geometry_ewkb: GEOMETRY, residential_year_built: 2000, residential_area_sqft: '1800.125',
        parcel_area_sqft: '6000', current_market_value: '350000', land_use_category: 'one_unit', classification_confidence: 'high' })); break;
      case 'accounts': rows = accountIds.filter(id => id > v[1]).slice(0, v[2]).map(account_id => ({ account_id,
        county: missingCounty ? null : 'Dallas', subdivision: account_id === t.account_id ? 'Recorded Subject Plat' : 'Recorded Other Plat' })); break;
      case 'sync-state': rows = [{ source_key: 'dcad_parcels', status: 'current', row_count: String(parcelCount), last_run_id: RUN, last_success_at: MS }]; break;
      case 'sync-runs': rows = [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', mode: 'full', started_at: '2026-09-05T00:00:00.000Z', completed_at: MS }]; break;
      case 'source-ids': rows = v[1] === '0' ? transactions.map(row => ({ source_record_id: row.source_record_id })) : []; break;
      case 'transaction-identities': rows = transactions; break;
      case 'transactions': rows = [{ ...transaction, record_type: 'closed_sale', sale_closing_date: '2024-03-01',
        source_close_date: '2024-03-01', sale_price: '275000', source_current_price: '275000', source_living_area: '1850.125',
        source_year_built: 2001, source_garage_yn: false, source_housing_type: 'Single family', source_days_on_market: 0,
        source_mls_status: 'Closed', source_row_number: 42, source_raw_witness: witness,
        data_quality_flags: [], ...saleOverrides }, ...extras]; break;
      case 'link-identities': case 'sale-links': rows = links.filter(p => p.parcel_sequence > v[3]).slice(0, v[4]); break;
      case 'legacy-identities': rows = legacy.filter(row => BigInt(row.sale_id) > BigInt(v[1])).slice(0, v[2])
        .map(row => ({ sale_id: row.sale_id, sale_account_id: row.sale_account_id })); break;
      case 'legacy': rows = legacy.filter(row => BigInt(row.sale_id) > BigInt(v[1])).slice(0, v[2]); break;
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
    selection: selector.selection, account_ids: accountIds, ...study }, {
    accessFactory: createNeighborhoodSaleWitnessReadAccess,
    authorizeMarketData: async (_auth, _context, purpose) => {
      assert.deepEqual(purpose.source_projection, { id: 'cached-sale-scalar-witness-v1', mapping_version: 3,
        witness_version: 1, fields: [...CACHED_SALE_WITNESS_FIELDS] });
      return { allowed: true, decision_id: 'synthetic-sale-witness-meaning-only', policy_revision: 'synthetic-witness-meaning-v1' };
    }, transactionClosure: {
    source_revision: 'original-preparation-closure', transactions, links,
    legacy: legacy.map(row => ({ sale_id: row.sale_id, sale_account_id: row.sale_account_id })) } });
  const issued = await access.prepare(), reader = createNeighborhoodSaleWitnessSourceReader({ connect() { assert.fail('owner transaction'); } }, { access: access.access });
  const captured = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(captured.status, 'captured', JSON.stringify(captured.incomplete_reasons));
  const acquisition = consumeNeighborhoodCachedAcquisition(reader, captured);
  assert.equal(JSON.parse(acquisition.compact_metadata_json).mapping_version, 3);
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
  const source = reopened.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.payload.projection.definition.role === 'transactions');
  return { f, client: f.client, store, scopeJson, accountIds, catalog, preview, reader,
    originalRetained: retained, captureResult: captured,
    sourceRef: source.id, recordId: source.payload.records[0].record_id, input: { context_header_json: headerJson,
    expected: { context_ref: context, target: scope, observation_period: study.observation_period },
    retained_inputs: reopened.retained_inputs,
    selection: { revision: 7, included_recorded_group_ids: catalog.pockets.map(p => p.id) } } };
}
