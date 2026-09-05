import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { validateCachedTransactionClosure } from '../src/services/neighborhoodAssessment/cachedTransactionClosure.js';
import * as security from '../src/security/publicCadastralCatalog.js';
import * as api from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import * as fixture from './fixtures/neighborhoodCachedReadAccessFixture.js';

// Cyber's strengthened API has landed. All tests use its real runtime issuance
// and assertion; absent/weakened prerequisites now fail this suite, not skip it.
const accessTest = test;
const copy = value => JSON.parse(JSON.stringify(value));
const permit = () => ({ allowed: true, decision_id: 'decision-1', policy_revision: 'policy-1' });
const scope = {
  organization_id: '10000000-0000-4000-8000-000000000001',
  appraisal_case_id: '20000000-0000-4000-8000-000000000001',
  subject_snapshot_id: '30000000-0000-4000-8000-000000000001', account_id: 'R-123',
};
const base = () => ({ scope: copy(scope), effective_date: '2026-08-31',
  observation_period: { start_date: '2024-09-01', end_date: '2026-08-31' },
  account_ids: ['R-123', 'R-456'], knowledge_cutoff: null });
const setup = (request = base(), options = {}) => fixture.createTestCachedReadAccess(request, options);
const consume = (context, prepared, request = prepared.request, auth = context.auth, grants = prepared) =>
  api.consumeNeighborhoodCachedReadAccess(context.access, auth, request, {
    selection_grant: grants.selection_grant, market_grant: grants.market_grant,
  });
const refreshSelectionDigest = request => {
  request.selection_sha256 = assessmentEvidenceDigest({ scope: request.scope, effective_date: request.effective_date,
    selection: request.selection, account_ids: [...request.account_ids].sort() });
};
const refreshClosure = request => {
  const raw = request.transaction_closure;
  request.transaction_closure = validateCachedTransactionClosure({ selected_account_ids: request.account_ids,
    source_revision: raw.source_revision, transactions: raw.transactions, links: raw.links, legacy: raw.legacy });
};
const closureFixture = () => ({ source_revision: 'trusted-closure-revision-1', transactions: [{
  source_record_id: '1', sale_id: '10', primary_account_id: 'R-123', sale_account_id: 'R-123', source_record_hash: 'upstream-identity-not-content',
}], links: [{ parcel_link_id: '100', source_record_id: '1', source_position: 1, parcel_sequence: 1,
  account_id: 'R-123', is_resolved: true }, { parcel_link_id: '101', source_record_id: '1', source_position: 2,
  parcel_sequence: 1, account_id: 'R-789', is_resolved: true }], legacy: [] });

test('security prerequisite uses the real runtime grant assertion', () => {
  assert.equal(typeof security.assertPublicCadastralCatalogGrant, 'function');
  assert.throws(() => security.assertPublicCadastralCatalogGrant({ accountId: 'R-123', actorUserId: 'actor', scope: 'public_cadastral_catalog' }), /public_cadastral_scope_required/);
  assert.equal(api.assertNeighborhoodCachedReadAccess(setup().access).prepare instanceof Function, true);
});

accessTest('trusted preparation returns immutable canonical request and opaque original grants', async () => {
  const trusted = base(); trusted.account_ids = [' R-456 ', 'R-123'];
  const context = setup(trusted);
  const prepared = await context.prepare();
  assert.deepEqual(prepared.request.account_ids, ['R-123', 'R-456']);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.request.scope), true);
  assert.equal(Object.isFrozen(prepared.request.account_ids), true);
  assert.deepEqual(Object.keys(prepared.selection_grant), []);
  assert.deepEqual(Object.keys(prepared.market_grant), []);
  const transport = { ...prepared.request, auth: context.auth, selection_grant: prepared.selection_grant, market_grant: prepared.market_grant };
  const accepted = consume(context, prepared, transport);
  assert.deepEqual(accepted, prepared.request);
  assert.equal('auth' in accepted, false);
  assert.equal('selection_grant' in accepted, false);
  assert.equal('market_grant' in accepted, false);
});

accessTest('factory requires explicit trusted callbacks and TTL no greater than 60 seconds', () => {
  const valid = { resolveAuthorizedAssignment() {}, resolveTrustedSelection() {}, authorizeMarketData() {}, resolveTransactionClosure() {} };
  for (const key of Object.keys(valid)) {
    const options = { ...valid }; delete options[key];
    assert.throws(() => api.createNeighborhoodCachedReadAccess(options), /trusted_callbacks_required/);
  }
  for (const ttl_ms of [0, -1, 60_001, 1.5, Infinity, '1000']) {
    assert.throws(() => api.createNeighborhoodCachedReadAccess({ ...valid, ttl_ms }), /ttl_ms/);
  }
  assert.throws(() => api.createNeighborhoodCachedReadAccess({ ...valid, permissionChecker: () => true }), /unknown_key/);
});

accessTest('preparation refuses caller account lists, unbounded references and target mismatches', async () => {
  const context = setup();
  await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput, account_ids: ['R-123', 'ATTACKER'] }), /unknown_key/);
  await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput,
    selection_reference: { id: 'x'.repeat(201), revision: 1 } }), /selection_reference.id/);
  await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput,
    selection_reference: { ...context.prepareInput.selection_reference, revision: 2 } }), /selection_reference_mismatch/);
  await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput,
    target: { ...context.prepareInput.target, report_file_id: '70000000-0000-4000-8000-000000000002' } }), /authorized_target_mismatch/);
});

accessTest('missing, forged and cloned grants reject without invoking services again', async () => {
  let calls = 0;
  const context = setup(base(), { authorizeMarketData: async () => { calls++; return permit(); } });
  const prepared = await context.prepare();
  for (const grants of [{}, { selection_grant: {}, market_grant: {} },
    { selection_grant: { ...prepared.selection_grant }, market_grant: prepared.market_grant },
    { selection_grant: prepared.selection_grant, market_grant: copy(prepared.market_grant) }]) {
    assert.throws(() => consume(context, prepared, prepared.request, context.auth, grants), /original_matching_grants_required/);
  }
  assert.equal(calls, 1);
  assert.deepEqual(consume(context, prepared), prepared.request);
});

accessTest('authority and token pairs from a different factory are rejected', async () => {
  const a = setup(), b = setup();
  const [pa, pb] = await Promise.all([a.prepare(), b.prepare()]);
  for (const access of [undefined, {}, { prepare: a.access.prepare }, { ...a.access }]) {
    assert.throws(() => api.consumeNeighborhoodCachedReadAccess(access, a.auth, pa.request, pa), /authority_required/);
  }
  assert.throws(() => api.consumeNeighborhoodCachedReadAccess(b.access, a.auth, pa.request,
    { selection_grant: pa.selection_grant, market_grant: pa.market_grant }), /original_matching_grants_required/);
  assert.throws(() => consume(a, pa, pa.request, a.auth, { selection_grant: pa.selection_grant, market_grant: pb.market_grant }), /original_matching_grants_required/);
  consume(a, pa); consume(b, pb);
});

accessTest('different original preparations cannot mix token pairs even for the same selection', async () => {
  const context = setup();
  const a = await context.prepare(), b = await context.prepare();
  assert.throws(() => consume(context, a, a.request, context.auth,
    { selection_grant: a.selection_grant, market_grant: b.market_grant }), /original_matching_grants_required/);
  consume(context, a); consume(context, b);
});

accessTest('altered selection IDs and recomputed caller digests cannot expand authority', async () => {
  const context = setup(), prepared = await context.prepare();
  for (const account_ids of [['R-123', 'ATTACKER'], ['R-123', 'R-456', 'ATTACKER'], ['R-123']]) {
    const changed = { ...copy(prepared.request), account_ids };
    assert.throws(() => consume(context, prepared, changed), /selection_digest_mismatch/);
    refreshSelectionDigest(changed);
    refreshClosure(changed);
    assert.throws(() => consume(context, prepared, changed), /request_binding_mismatch/);
  }
  consume(context, prepared);
});

accessTest('every scope and immutable selection metadata dimension is digest-bound', async () => {
  const context = setup(), prepared = await context.prepare();
  for (const mutate of [
    request => { request.scope.organization_id = '10000000-0000-4000-8000-000000000002'; },
    request => { request.scope.appraisal_case_id = '20000000-0000-4000-8000-000000000002'; },
    request => { request.scope.subject_snapshot_id = '30000000-0000-4000-8000-000000000002'; },
    request => { request.scope.account_id = 'R-456'; },
    request => { request.selection.id = 'another-selection'; },
    request => { request.selection.revision++; },
    request => { request.selection.definition_sha256 = 'a'.repeat(64); },
    request => { request.selection.source_sha256 = 'b'.repeat(64); },
    request => { request.effective_date = '2026-09-01'; },
  ]) {
    const changed = copy(prepared.request); mutate(changed); refreshSelectionDigest(changed);
    assert.throws(() => consume(context, prepared, changed), /request_binding_mismatch/);
  }
  consume(context, prepared);
});

accessTest('target, workflow, period and knowledge cutoff cannot be changed after preparation', async () => {
  const context = setup(), prepared = await context.prepare();
  for (const mutate of [
    request => { request.target.report_file_id = '70000000-0000-4000-8000-000000000002'; },
    request => { request.target.workflow_target_id = '2'; },
    request => { request.target.workflow_type = 'uad_3_6'; request.target.workflow_target_id = '70000000-0000-4000-8000-000000000003'; },
    request => { request.observation_period.start_date = '2025-01-01'; },
    request => { request.observation_period.end_date = '2026-08-30'; },
    request => { request.knowledge_cutoff = '2026-08-31T00:00:00.000Z'; },
  ]) {
    const changed = copy(prepared.request); mutate(changed);
    assert.throws(() => consume(context, prepared, changed), /request_binding_mismatch/);
  }
  consume(context, prepared);
});

accessTest('actor and exact-organization workflow permission are rechecked at consumption', async () => {
  const context = setup(), prepared = await context.prepare();
  assert.throws(() => consume(context, prepared, prepared.request, { ...context.auth, userId: 'different-actor' }), /actor_mismatch/);
  for (const organizations of [[], [{ organizationId: '10000000-0000-4000-8000-000000000002', roles: ['appraiser'] }],
    [{ organizationId: scope.organization_id, roles: [] }]]) {
    assert.throws(() => consume(context, prepared, prepared.request, { ...context.auth, organizations }), /workflow_read_required/);
  }
  consume(context, prepared);
});

accessTest('preparation cannot borrow read access from another organization', async () => {
  let marketCalls = 0;
  const context = setup(base(), { auth: { userId: 'actor', organizations: [
    { organizationId: '10000000-0000-4000-8000-000000000002', roles: ['appraiser'] },
  ] }, authorizeMarketData: async () => { marketCalls++; return permit(); } });
  await assert.rejects(context.prepare(), /workflow_read_required/);
  assert.equal(marketCalls, 0);
});

accessTest('market permission requires explicit decision identity and covers full link metadata only', async () => {
  for (const decision of [false, true, null, undefined, 1, 'true', { allowed: true }, { association_metadata: 'selected_links_only' }]) {
    const denied = setup(base(), { authorizeMarketData: async () => decision });
    await assert.rejects(denied.prepare(), /market_data_access_denied|market_decision/);
  }
  let observed;
  const context = setup(base(), { authorizeMarketData: async (auth, assignment, purpose) => {
    observed = { auth, assignment, purpose };
    assert.equal(Object.isFrozen(purpose), true);
    assert.equal(Object.isFrozen(assignment.scope), true);
    assert.equal(purpose.association_metadata, 'all_transaction_parcel_links');
    assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
    assert.equal(purpose.additional_cadastral_accounts, false);
    assert.equal(purpose.private_assignment_overlays, false);
    return permit();
  } });
  const prepared = await context.prepare();
  assert.equal(observed.purpose.transaction_scope, 'transactions_intersecting_selection');
  assert.equal(observed.purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
  assert.deepEqual(observed.purpose.source_classes, ['core.sales_source_records', 'core.sales', 'core.sale_parcels']);
  assert.deepEqual(observed.purpose.source_classification, {
    'core.sales_source_records': 'licensed_mls_source_records', 'core.sales': 'canonical_sales',
    'core.sale_parcels': 'transaction_parcel_associations',
  });
  assert.equal(observed.purpose.selection_sha256, prepared.request.selection_sha256);
  assert.equal(observed.assignment.target.workflow_type, 'custom_appraisal');
  assert.equal(observed.assignment.scope.organization_id, scope.organization_id);
  assert.equal(observed.auth, context.auth);
  consume(context, prepared);
});

accessTest('authorization cannot silently change actor or lose organization membership during prepare', async () => {
  const context = setup(base(), { authorizeMarketData: async auth => { auth.organizations = []; return permit(); } });
  await assert.rejects(context.prepare(), /workflow_read_required/);
});

accessTest('grants are single-attempt and expire on monotonic lifetime', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const context = setup(), prepared = await context.prepare();
  consume(context, prepared);
  assert.throws(() => consume(context, prepared), /original_matching_grants_required/);
  const short = setup(base(), { ttl_ms: 50 }), expired = await short.prepare();
  now += 60;
  assert.throws(() => consume(short, expired), /expired_grants/);
  assert.throws(() => consume(short, expired), /original_matching_grants_required/);
});

accessTest('a stalled authorization callback cannot mint fresh grants after the preparation deadline', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  let callbackReturned = false;
  const context = setup(base(), { ttl_ms: 10, authorizeMarketData: async () => {
    await Promise.resolve(); now += 25; callbackReturned = true; return permit();
  } });
  await assert.rejects(context.prepare(), /preparation_expired/);
  assert.equal(callbackReturned, true);
});

accessTest('invalid selection identities and unsupported period inputs reject', async () => {
  for (const account_ids of [['R-123', ' R-123 '], ['R-456'], ['R-123', 42], ['R-123', 'x'.repeat(65)],
    ['R-123', 'BAD\u0000ID'], [], Array.from({ length: 50_001 }, (_, index) => `A${index}`)]) {
    await assert.rejects(setup({ ...base(), account_ids }).prepare(), /account_id/);
  }
  const context = setup();
  for (const observation_period of [
    { start_date: '2026-09-01', end_date: '2026-08-31' },
    { start_date: '2026-01-01', end_date: '2026-09-01' },
    { start_date: '2026-02-30', end_date: '2026-08-31' },
  ]) await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput, observation_period }));
  await assert.rejects(context.access.prepare(context.auth, { ...context.prepareInput, knowledge_cutoff: 'yesterday' }), /knowledge_cutoff/);
});

accessTest('equivalent normalized request order is accepted but duplicates and extra scope keys are rejected', async () => {
  const context = setup(), prepared = await context.prepare();
  const duplicate = copy(prepared.request); duplicate.account_ids.push(' R-123 ');
  assert.throws(() => consume(context, prepared, duplicate), /account_ids/);
  const extra = copy(prepared.request); extra.scope.other_org = 'anything';
  assert.throws(() => consume(context, prepared, extra), /unknown_key/);
  const reversed = copy(prepared.request); reversed.account_ids.reverse();
  assert.deepEqual(consume(context, prepared, reversed), prepared.request);
});

accessTest('UAD-only target is supported without a Custom file and remains independently bound', async () => {
  const context = setup(base(), { target: {
    report_file_id: '70000000-0000-4000-8000-000000000004', workflow_type: 'uad_3_6',
    workflow_target_id: '70000000-0000-4000-8000-000000000005',
  } });
  const prepared = await context.prepare();
  assert.equal(prepared.request.target.workflow_type, 'uad_3_6');
  assert.equal(prepared.request.target.workflow_target_id, '70000000-0000-4000-8000-000000000005');
  consume(context, prepared);
});

accessTest('licensed market decision precedes closure resolution and rejection prevents any closure query', async () => {
  let calls = 0;
  const denied = setup(base(), { authorizeMarketData: async () => ({ allowed: false, decision_id: 'deny', policy_revision: 'policy-1' }),
    resolveTransactionClosure: async () => { calls++; throw new Error('must not run'); } });
  await assert.rejects(denied.prepare(), /market_data_access_denied/);
  assert.equal(calls, 0);
  const events = [];
  const context = setup(base(), { authorizeMarketData: async () => { events.push('licensed'); return permit(); },
    resolveTransactionClosure: async (auth, assignment, selected, purpose) => {
      events.push('closure');
      assert.equal(auth, context.auth);
      assert.equal(assignment.scope.organization_id, scope.organization_id);
      assert.equal(Object.isFrozen(selected), true);
      assert.deepEqual(selected.account_ids, ['R-123', 'R-456']);
      assert.equal(purpose.selection_sha256, selected.selection_sha256);
      return { selected_account_ids: selected.account_ids, ...closureFixture() };
    } });
  const prepared = await context.prepare();
  assert.deepEqual(events, ['licensed', 'closure']);
  assert.deepEqual(prepared.request.account_ids, ['R-123', 'R-456']);
  assert.deepEqual(prepared.request.transaction_closure.closure_account_ids, ['R-123', 'R-789']);
  assert.equal(Object.isFrozen(prepared.request.transaction_closure.links[0]), true);
  assert.equal(prepared.request.transaction_closure.closure_account_ids.includes('R-456'), false);
  consume(context, prepared);
});

accessTest('trusted closure cannot assert extra account IDs or reseed transactions from linked accounts', async () => {
  const raw = { selected_account_ids: base().account_ids, ...closureFixture() };
  for (const changed of [
    { ...raw, closure_account_ids: ['ATTACKER'] },
    { ...raw, selected_account_ids: ['R-123', 'R-456', 'ATTACKER'] },
    { ...raw, transactions: [...raw.transactions, { source_record_id: '2', sale_id: '20',
      primary_account_id: 'R-789', sale_account_id: 'R-789', source_record_hash: null }] },
  ]) {
    const context = setup(base(), { resolveTransactionClosure: async () => copy(changed) });
    await assert.rejects(context.prepare(), /transaction_closure/);
  }
});

accessTest('closure content, source revision and recomputed digests remain bound to original capabilities', async () => {
  const context = setup(base(), { transactionClosure: closureFixture() }), prepared = await context.prepare();
  for (const mutate of [
    request => { request.transaction_closure.source_revision = 'different-source-revision'; },
    request => { request.transaction_closure.links[1].account_id = 'ATTACKER'; },
    request => { request.transaction_closure.links[1].is_resolved = false; },
    request => { request.transaction_closure.transactions[0].source_record_hash = 'different-original-record'; },
    request => { request.transaction_closure.transactions[0].sale_id = '11'; },
    request => { request.transaction_closure.links.pop(); },
  ]) {
    const changed = copy(prepared.request); mutate(changed);
    assert.throws(() => consume(context, prepared, changed), /transaction_closure.binding/);
    refreshClosure(changed);
    assert.throws(() => consume(context, prepared, changed), /request_binding_mismatch/);
  }
  consume(context, prepared);
});

accessTest('market decision identity and policy revision cannot be replaced or merely asserted', async () => {
  const context = setup(), prepared = await context.prepare();
  for (const mutate of [
    request => { request.market_decision.decision_id = 'new-decision'; },
    request => { request.market_decision.policy_revision = 'new-policy'; },
  ]) {
    const changed = copy(prepared.request); mutate(changed);
    assert.throws(() => consume(context, prepared, changed), /request_binding_mismatch/);
  }
  assert.throws(() => consume(context, prepared, { ...prepared.request, market_decision: true }), /market_decision/);
  consume(context, prepared);
});

accessTest('closure callback latency and permission revocation count against authorization freshness', async t => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const expired = setup(base(), { ttl_ms: 10, resolveTransactionClosure: async (_auth, _context, selected) => {
    now += 11;
    return { selected_account_ids: selected.account_ids, ...closureFixture() };
  } });
  await assert.rejects(expired.prepare(), /preparation_expired/);
  const revoked = setup(base(), { resolveTransactionClosure: async (auth, _context, selected) => {
    auth.organizations = [];
    return { selected_account_ids: selected.account_ids, ...closureFixture() };
  } });
  await assert.rejects(revoked.prepare(), /workflow_read_required/);
});
