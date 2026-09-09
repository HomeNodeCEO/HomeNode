import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNeighborhoodCachedReadAccess, consumeNeighborhoodCachedReadAccess,
  createNeighborhoodCachedReadAccess, createNeighborhoodSaleWitnessReadAccess,
  describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodSaleWitnessMarketDataPurpose,
} from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createCustomNeighborhoodSourcePolicy } from '../src/security/customNeighborhoodSourcePolicy.js';

const copy = value => structuredClone(value);
const FIELDS = [
  'MlsStatus', 'StandardStatus', 'CloseDate', 'ClosePrice', 'CurrentPrice', 'ListPrice', 'OriginalListPrice', 'Currency',
  'LivingArea', 'LivingAreaUnits', 'AboveGradeFinishedArea', 'AboveGradeFinishedAreaUnits',
  'LotSizeArea', 'LotSizeUnits', 'LotSizeSquareFeet', 'LotSizeAcres',
  'DaysOnMarket', 'CumulativeDaysOnMarket', 'YearBuilt', 'StructuralStyle', 'PropertyType', 'PropertySubType',
  'StructureType', 'PropertyAttachedYN', 'ListingKey', 'ListingId', 'OriginatingSystemName', 'ModificationTimestamp',
];
const PROJECTION = { id: 'cached-sale-scalar-witness-v1', mapping_version: 3, witness_version: 1, fields: FIELDS };
const CONTEXT = {
  target: { report_file_id: '70000000-0000-4000-8000-000000000001', workflow_type: 'custom_appraisal', workflow_target_id: '1' },
  scope: { organization_id: '10000000-0000-4000-8000-000000000001',
    appraisal_case_id: '20000000-0000-4000-8000-000000000001',
    subject_snapshot_id: '30000000-0000-4000-8000-000000000001', account_id: 'R-123' },
  effective_date: '2026-08-31',
};
const PERIOD = { start_date: '2024-09-01', end_date: '2026-08-31' };
const permit = () => ({ allowed: true, decision_id: 'synthetic-witness-test-only', policy_revision: 'synthetic-witness-v1' });
const denied = reason => error => error.code === 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED' && error.reason === reason;
const grantsOf = prepared => ({ selection_grant: prepared.selection_grant, market_grant: prepared.market_grant });

// Synthetic resolver data only. The actual factories mint/check the private
// access capabilities, application permissions and public cadastral grants.
function fixture(mappingVersion = 3, callbacks = {}) {
  const auth = { userId: '80000000-0000-4000-8000-000000000001',
    organizations: [{ organizationId: CONTEXT.scope.organization_id, roles: ['appraiser'] }] };
  const selection = { id: 'synthetic-witness-selection', revision: 1,
    definition_sha256: 'a'.repeat(64), source_sha256: 'b'.repeat(64), account_ids: ['R-123', 'R-456'] };
  const input = { target: copy(CONTEXT.target), selection_reference: { id: selection.id, revision: selection.revision },
    observation_period: copy(PERIOD), knowledge_cutoff: null };
  const events = [];
  const access = (mappingVersion === 3 ? createNeighborhoodSaleWitnessReadAccess : createNeighborhoodCachedReadAccess)({
    resolveAuthorizedAssignment: async () => { events.push('assignment'); return copy(CONTEXT); },
    resolveTrustedSelection: async () => { events.push('selection'); return copy(selection); },
    authorizeMarketData: async (...args) => {
      events.push('policy');
      if (callbacks.authorizeMarketData) return callbacks.authorizeMarketData(...args);
      if (mappingVersion === 3) assert.deepEqual(args[2].source_projection, PROJECTION);
      else assert.equal(Object.hasOwn(args[2], 'source_projection'), false);
      return permit();
    },
    resolveTransactionClosure: async (...args) => {
      events.push('closure');
      if (callbacks.resolveTransactionClosure) return callbacks.resolveTransactionClosure(...args);
      return { selected_account_ids: copy(selection.account_ids), source_revision: 'synthetic-empty-cache-v1',
        transactions: [], links: [], legacy: [] };
    },
  });
  return { access, auth, input, events, prepare: () => access.prepare(auth, copy(input)) };
}
const consume = (f, prepared, mappingVersion = 3, request = prepared.request, auth = f.auth, grants = grantsOf(prepared)) =>
  consumeNeighborhoodCachedReadAccess(f.access, auth, request, grants, mappingVersion);

test('installed witness access prepares and consumes exactly mapping3 once', async () => {
  const f = fixture(), prepared = await f.prepare();
  assert.equal(assertNeighborhoodCachedReadAccess(f.access, 3), f.access);
  assert.deepEqual(f.events, ['assignment', 'selection', 'policy', 'closure']);
  assert.equal(Object.isFrozen(prepared.request), true);
  assert.deepEqual(consume(f, prepared), prepared.request);
  assert.throws(() => consume(f, prepared), denied('original_matching_grants_required'));
});

test('witness purpose pins the complete closed field vocabulary without changing the old purpose', async () => {
  const f = fixture(), prepared = await f.prepare();
  const original = describeNeighborhoodCachedMarketDataPurpose(prepared.request);
  assert.deepEqual(original, {
    kind: 'neighborhood_cached_market_data', selection_sha256: prepared.request.selection_sha256,
    source_classes: ['core.sales_source_records', 'core.sales', 'core.sale_parcels'],
    source_classification: { 'core.sales_source_records': 'licensed_mls_source_records',
      'core.sales': 'canonical_sales', 'core.sale_parcels': 'transaction_parcel_associations' },
    transaction_scope: 'transactions_intersecting_selection', association_metadata: 'all_transaction_parcel_links',
    event_date_scope: 'all_available_dates_for_seeded_transactions', additional_cadastral_accounts: false,
    private_assignment_overlays: false, observation_period: PERIOD, knowledge_cutoff: null,
  });
  const witness = describeNeighborhoodSaleWitnessMarketDataPurpose(prepared.request);
  assert.deepEqual(witness, { ...original, source_projection: PROJECTION });
  assert.equal(FIELDS.length, 28);
  for (const value of [witness, witness.source_projection, witness.source_projection.fields]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => witness.source_projection.fields.push('PrivateRemarks'), TypeError);
  assert.deepEqual(describeNeighborhoodCachedMarketDataPurpose(prepared.request), original);
  consume(f, prepared);
});

for (const [installed, requested] of [[2, 3], [3, 2]]) {
  test(`mapping${installed} capability rejects mapping${requested} before inspecting or consuming its request`, async () => {
    const f = fixture(installed), prepared = await f.prepare();
    let inspected = false;
    const inaccessible = { get scope() { inspected = true; throw new Error('request_was_inspected'); } };
    assert.throws(() => assertNeighborhoodCachedReadAccess(f.access, requested), denied('mapping_profile_mismatch'));
    assert.throws(() => consume(f, prepared, requested, inaccessible), denied('mapping_profile_mismatch'));
    assert.equal(inspected, false);
    assert.deepEqual(consume(f, prepared, installed), prepared.request);
  });
}

test('omitted mapping remains ordinary2 and cannot consume a witness capability', async () => {
  const ordinary = fixture(2), witness = fixture(3);
  const old = await ordinary.prepare(), next = await witness.prepare();
  assert.equal(assertNeighborhoodCachedReadAccess(ordinary.access), ordinary.access);
  assert.throws(() => assertNeighborhoodCachedReadAccess(witness.access), denied('mapping_profile_mismatch'));
  assert.throws(() => consumeNeighborhoodCachedReadAccess(witness.access, witness.auth, next.request, grantsOf(next)), denied('mapping_profile_mismatch'));
  // No mapping/profile field is added to or relabels the retained request.
  assert.deepEqual(next.request, old.request);
  assert.deepEqual(consumeNeighborhoodCachedReadAccess(ordinary.access, ordinary.auth, old.request, grantsOf(old)), old.request);
  consume(witness, next);
});

test('unsupported installed versions cannot bypass profile binding or destroy valid tokens', async () => {
  const f = fixture(), prepared = await f.prepare();
  for (const version of [1, 4, null, '3', NaN]) {
    assert.throws(() => assertNeighborhoodCachedReadAccess(f.access, version), denied('mapping_profile_mismatch'));
    assert.throws(() => consume(f, prepared, version), denied('mapping_profile_mismatch'));
  }
  consume(f, prepared);
});

test('original token pairs cannot cross issuers, including opposite-profile issuers', async () => {
  const a = fixture(3), b = fixture(3), ordinary = fixture(2);
  const pa = await a.prepare(), pb = await b.prepare(), old = await ordinary.prepare();
  assert.throws(() => consume(b, pa), denied('original_matching_grants_required'));
  assert.throws(() => consume(ordinary, pa, 2), denied('original_matching_grants_required'));
  assert.throws(() => consume(a, old, 3), denied('original_matching_grants_required'));
  assert.throws(() => consume(a, pa, 3, pa.request, a.auth,
    { selection_grant: pa.selection_grant, market_grant: pb.market_grant }), denied('original_matching_grants_required'));
  consume(a, pa); consume(b, pb); consume(ordinary, old, 2);
});

test('copied tokens or authority never acquire witness access and leave originals usable', async () => {
  const f = fixture(), prepared = await f.prepare();
  for (const grants of [copy(grantsOf(prepared)),
    { selection_grant: { ...prepared.selection_grant }, market_grant: prepared.market_grant },
    { selection_grant: prepared.selection_grant, market_grant: { ...prepared.market_grant } }]) {
    assert.throws(() => consume(f, prepared, 3, prepared.request, f.auth, grants), denied('original_matching_grants_required'));
  }
  assert.throws(() => consumeNeighborhoodCachedReadAccess({ ...f.access }, f.auth, prepared.request, grantsOf(prepared), 3), denied('authority_required'));
  consume(f, prepared);
});

test('witness grants retain exact actor, target and organization workflow checks', async () => {
  const f = fixture(), prepared = await f.prepare();
  assert.throws(() => consume(f, prepared, 3, prepared.request, { ...f.auth, userId: 'different-actor' }), denied('actor_mismatch'));
  for (const organizations of [[], [{ organizationId: '10000000-0000-4000-8000-000000000002', roles: ['appraiser'] }]]) {
    assert.throws(() => consume(f, prepared, 3, prepared.request, { ...f.auth, organizations }), denied('workflow_read_required'));
  }
  for (const patch of [{ workflow_target_id: '2' }, { report_file_id: '70000000-0000-4000-8000-000000000002' }]) {
    const changed = { ...copy(prepared.request), target: { ...prepared.request.target, ...patch } };
    assert.throws(() => consume(f, prepared, 3, changed), denied('request_binding_mismatch'));
  }
  consume(f, prepared);
});

test('a caller cannot supply its own projection, version or field list', async () => {
  const f = fixture();
  for (const injected of [{ mappingVersion: 2 }, { mapping_version: 3 }, { source_projection: PROJECTION }, { fields: ['PrivateRemarks'] }]) {
    await assert.rejects(f.access.prepare(f.auth, { ...copy(f.input), ...injected }), denied('prepare.unknown_key'));
  }
  assert.deepEqual(f.events, []);
  const prepared = await f.prepare();
  assert.throws(() => consume(f, prepared, 3, { ...prepared.request, source_projection: PROJECTION }), denied('request.unknown_key'));
  consume(f, prepared);
});

test('the same frozen witness purpose must be approved before the closure resolver executes', async () => {
  let release, entered, purpose;
  const policyEntered = new Promise(resolve => { entered = resolve; });
  const policyDecision = new Promise(resolve => { release = resolve; });
  const f = fixture(3, {
    authorizeMarketData: async (_auth, _context, value) => {
      purpose = value;
      assert.deepEqual(value.source_projection, PROJECTION);
      entered();
      return policyDecision;
    },
    resolveTransactionClosure: async (_auth, _context, selection, value) => {
      assert.equal(value, purpose);
      assert.equal(Object.isFrozen(value.source_projection.fields), true);
      return { selected_account_ids: selection.account_ids, source_revision: 'synthetic-approved-closure', transactions: [], links: [], legacy: [] };
    },
  });
  const pending = f.prepare();
  await policyEntered;
  assert.deepEqual(f.events, ['assignment', 'selection', 'policy']);
  release(permit());
  const prepared = await pending;
  assert.deepEqual(f.events, ['assignment', 'selection', 'policy', 'closure']);
  consume(f, prepared);
});

test('explicit witness policy denial stops preparation before any closure read', async () => {
  const f = fixture(3, { authorizeMarketData: async () => ({ allowed: false }) });
  await assert.rejects(f.prepare(), denied('market_data_access_denied'));
  assert.deepEqual(f.events, ['assignment', 'selection', 'policy']);
});

test('the existing production purpose policy denies witnesses before SQL or closure access', async () => {
  const policy = createCustomNeighborhoodSourcePolicy({ datasetRevision: 'synthetic-existing-source-profile',
    providerRevisions: [{ provider_id: 'synthetic-provider', revision: 'synthetic-terms' }] });
  let sqlCalls = 0;
  const client = { async query() { sqlCalls++; throw new Error('must_not_read_organization_or_sources'); } };
  const f = fixture(3, { authorizeMarketData: async (auth, context, purpose) => {
    for (const exposure of ['none', 'report_observation_summary', 'report_observation_members', 'report_observation_catalog']) {
      assert.deepEqual(await policy(client, auth, context, purpose, { retention: true, exposure }), { allowed: false });
    }
    return policy(client, auth, context, purpose, { retention: true, exposure: 'none' });
  } });
  await assert.rejects(f.prepare(), denied('market_data_access_denied'));
  assert.equal(sqlCalls, 0);
  assert.deepEqual(f.events, ['assignment', 'selection', 'policy']);
});
