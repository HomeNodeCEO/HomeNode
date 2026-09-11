import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { setSection } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';

const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });
const GRANT = { allowed: true, decision_id: 'fixture-license', policy_revision: 'fixture-license-v1' };
const CATALOG = 'report_observation_catalog', SUMMARY = 'report_observation_summary';
import { customCohortOpeningSelection } from '../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';

// Real retained loader/context/subject/presenters over scoped DB query fixtures.
// No native locking, PostgreSQL isolation or actual provider authorization claim.
async function setup(options) {
  const f = await decisionEvidenceFixture(options), header = prepareCustomCohortContextHeader(f.input.context_header_json);
  await f.store.put(f.input.context_header_json);
  const scope = f.input.expected.target, target = f.f.state.input.target;
  const actor = '80000000-0000-4000-8000-000000000001';
  const context = { ...header.context_ref, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const payloads = new Set(f.input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(source => source.content_sha256));
  const state = { calls: [], policies: [], releases: [], connects: 0, commits: 0, rollbacks: 0, sourceReads: 0,
    assigned: actor, onPolicy: null, onCommit: null, failCommit: false };
  const baseQuery = f.client.query.bind(f.client);
  const client = { async query(config) {
    const sql = config.text, params = config.values ?? []; state.calls.push(sql);
    if (sql.startsWith('BEGIN ') || sql.startsWith('SET LOCAL ')) return row();
    if (sql === 'COMMIT') {
      state.commits++; if (state.onCommit) await state.onCommit(state.commits);
      if (state.failCommit) throw new Error('synthetic_commit_ack_lost');
      return row();
    }
    if (sql === 'ROLLBACK') { state.rollbacks++; return row(); }
    const ownerTag = sql.match(/custom-cohort-capture:([a-z-]+)/)?.[1];
    if (ownerTag === 'assignment') {
      assert.deepEqual(params, [scope.assignment_file_id, scope.account_id]);
      return row({ assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
        organization_id: scope.organization_id, assigned_appraiser_user_id: state.assigned, supervisory_appraiser_user_id: null });
    }
    if (ownerTag === 'report') return row({ report_file_id: scope.report_file_id,
      appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
    const tag = sql.match(/custom-cohort-context:([a-z-]+)/)?.[1];
    if (tag === 'transaction') return row({ transaction_id: '123456789' });
    if (tag === 'target') return row({ id: scope.report_file_id });
    if (tag === 'read') return row(params[4] === context.context_id ? context : null);
    if (sql.includes('neighborhood-cohort-blob:read')) {
      const hashes = Array.isArray(params[1]) ? params[1] : [params[1]];
      state.sourceReads += hashes.filter(hash => payloads.has(hash)).length;
    }
    return baseQuery(sql, params);
  }, release(error) { state.releases.push(error); } };
  const service = createCustomCohortContextCapture({ pool: { async connect() { state.connects++; return client; } },
    authorizeMarketData: async (boundedClient, auth, current, purpose, requested) => {
      state.policies.push({ exposure: requested.exposure, sourceReads: state.sourceReads,
        commits: state.commits, call_index: state.calls.length });
      assert.equal(requested.retention, true); assert.equal(auth.userId, actor);
      assert.equal(current.scope.organization_id, scope.organization_id);
      return state.onPolicy ? state.onPolicy(state.policies.length, requested.exposure, boundedClient) : { ...GRANT };
    } });
  const input = { auth: { userId: actor, organizations: [{ organizationId: scope.organization_id, roles: ['appraiser'] }] },
    accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, contextRef: header.context_ref,
    selection: { revision: 7, pockets: [] } };
  return { f, state, service, input };
}

test('omitted/false recommendations preserve exact legacy catalog and only catalog policy checks', async () => {
  const { service, input, state } = await setup();
  const old = await service.catalog(input), explicit = await service.catalog({ ...input, includeRecommendation: false });
  assert.equal(json(old), json(explicit)); assert.equal(Object.hasOwn(old, 'recommendation'), false);
  assert.deepEqual(state.policies.map(call => call.exposure), [CATALOG, CATALOG, CATALOG, CATALOG]);
  assert.equal(state.commits, 4); assert.equal(state.releases.length, 4);
  assert.ok(!state.calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});

test('optional baseline uses both existing exposures before retained rows and after current-material check', async () => {
  const { service, input, state } = await setup();
  const result = await service.catalog({ ...input, includeRecommendation: true });
  assert.deepEqual(state.policies.map(call => call.exposure), [CATALOG, SUMMARY, CATALOG, SUMMARY]);
  assert.equal(state.policies[0].sourceReads, 0); assert.equal(state.policies[1].sourceReads, 0);
  assert.ok(state.policies[2].sourceReads > 0); assert.ok(state.policies[3].sourceReads > 0);
  assert.equal(state.commits, 3); assert.equal(state.rollbacks, 0); assert.equal(state.releases.length, 3);
  const starts = state.calls.flatMap((sql, index) => sql.startsWith('BEGIN ') ? [index] : []);
  assert.deepEqual(starts.map(index => state.calls[index]), ['BEGIN ISOLATION LEVEL READ COMMITTED',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN ISOLATION LEVEL READ COMMITTED']);
  const computation = state.calls.slice(starts[1], starts[2]);
  assert.equal(computation.at(-1), 'COMMIT');
  assert.ok(computation.every(sql => /^(BEGIN |SET LOCAL |COMMIT$)/.test(sql)),
    'this older fixture has unavailable EWKB: the extra read-only phase must not read mutable source tables');
  assert.deepEqual(state.policies.map(call => call.commits), [0, 0, 2, 2],
    'both initial grants precede computation; both final grants follow its committed read-only phase');
  for (const policy of state.policies.slice(2)) assert.ok(state.calls.slice(starts[2], policy.call_index)
    .some(sql => sql.includes('custom-cohort-subject:sections')), 'final grants still follow fresh material comparison');
  assert.equal(result.status, 'catalog'); assert.equal(result.subject_freshness, 'matched');
  assert.deepEqual(result.recommendation.binding, result.catalog.binding);
  assert.equal(result.recommendation.all.member_count, result.catalog.coverage.stock_member_count);
  assert.equal(result.recommendation.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4_000_000);
  assert.ok(!state.calls.some(sql => /neighborhood-(cache|membership|closure):|\b(?:INSERT\s+INTO|UPDATE\s+(?:app|core)\.|DELETE\s+FROM)/i.test(sql)));
});

test('retrospective owner omits actionable recommendations but retains the exact catalog, selection and both policy fences', async () => {
  const { service, input, state, f } = await setup({ effectiveDate: '2026-09-05' });
  const retainedBefore = json(f.input.retained_inputs);
  const ordinary = await service.catalog(input);
  state.policies.length = 0;
  const result = await service.catalog({ ...input, includeRecommendation: true });
  assert.equal(Object.hasOwn(result, 'recommendation'), false);
  assert.equal(json(result), json(ordinary));
  assert.equal(result.catalog.catalog_complete, true);
  assert.deepEqual(result.catalog.pockets.flatMap(p => p.account_ids).sort(), [...f.accountIds].sort());
  assert.deepEqual(input.selection, { revision: 7, pockets: [] });
  assert.equal(result.catalog.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.deepEqual(state.policies.map(call => call.exposure), [CATALOG, SUMMARY, CATALOG, SUMMARY]);
  assert.equal(state.commits, 4); assert.equal(state.rollbacks, 0); assert.equal(state.releases.length, 4);
  assert.ok(!state.calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(json(f.input.retained_inputs), retainedBefore);
  assert.ok(!state.calls.some(sql => /neighborhood-(cache|membership|closure):|\b(?:INSERT\s+INTO|UPDATE\s+(?:app|core)\.|DELETE\s+FROM)/i.test(sql)));
});

for (const effectiveDate of ['2026-09-05', '2026-09-06']) for (const deniedAt of [1, 2, 3, 4]) {
  test(`denial at exposure check ${deniedAt} prevents output for effective date ${effectiveDate}`, async () => {
    const { service, input, state } = await setup({ effectiveDate });
    state.onPolicy = count => count === deniedAt ? { allowed: false } : { ...GRANT };
    await assert.rejects(service.catalog({ ...input, includeRecommendation: true }), /market_data_access_denied/);
    assert.equal(state.policies.length, deniedAt); assert.equal(state.rollbacks, 1);
    assert.equal(state.sourceReads > 0, deniedAt > 2);
  });
}

for (const effectiveDate of ['2026-09-05', '2026-09-06']) for (const changedAt of [2, 3, 4]) {
  test(`policy revision mismatch at exposure check ${changedAt} prevents output for effective date ${effectiveDate}`, async () => {
    const { service, input, state } = await setup({ effectiveDate });
    state.onPolicy = count => ({ ...GRANT, policy_revision: count === changedAt ? 'changed' : GRANT.policy_revision });
    await assert.rejects(service.catalog({ ...input, includeRecommendation: true }), /market_policy_changed/);
    assert.equal(state.policies.length, changedAt); assert.equal(state.sourceReads > 0, changedAt > 2);
  });
}

test('selection binding follows the request, while full-roster recommendations never change with toggles', async () => {
  const { service, input, f } = await setup();
  const first = await service.catalog({ ...input, includeRecommendation: true });
  const second = await service.catalog({ ...input, includeRecommendation: true,
    selection: { revision: 8, pockets: [{ id: 'selected', label: 'Selected recorded groups', account_ids: f.accountIds }] } });
  assert.notEqual(first.recommendation.binding.selection_sha256, second.recommendation.binding.selection_sha256);
  assert.deepEqual(second.recommendation.binding, second.catalog.binding);
  assert.deepEqual({ ...first.recommendation, binding: null }, { ...second.recommendation, binding: null });
});

test('flag and selection are detached before policy await', async () => {
  const { service, input, state } = await setup(), value = { ...input, includeRecommendation: true };
  state.onPolicy = () => { value.includeRecommendation = false; value.selection.revision = 999; return { ...GRANT }; };
  const result = await service.catalog(value);
  assert.equal(result.recommendation.binding.selection_revision, 7);
  assert.deepEqual(state.policies.map(call => call.exposure), [CATALOG, SUMMARY, CATALOG, SUMMARY]);
});

for (const effectiveDate of ['2026-09-05', '2026-09-06']) for (const type of ['material', 'assignment']) test(`fresh ${type} change prevents delivery for effective date ${effectiveDate}`, async () => {
  const { service, input, state, f } = await setup({ effectiveDate });
  state.onCommit = count => {
    if (count !== 1) return;
    if (type === 'material') setSection(f.f.state.input, 1, '{"main_improvement":{"living_area_sqft":9999}}');
    else state.assigned = '80000000-0000-4000-8000-000000000002';
  };
  await assert.rejects(service.catalog({ ...input, includeRecommendation: true }), type === 'material' ? /subject_changed/ : /assignment_access_denied/);
  assert.equal(state.policies.length, 2); assert.equal(state.rollbacks, 1);
});

for (const effectiveDate of ['2026-09-05', '2026-09-06']) test(`cancellation and uncertain COMMIT prevent delivery for effective date ${effectiveDate}`, async () => {
  const before = await setup({ effectiveDate }), controller = new AbortController(); controller.abort();
  await assert.rejects(before.service.catalog({ ...before.input, includeRecommendation: true }, { signal: controller.signal }), /cancelled/);
  assert.equal(before.state.connects, 0);
  const during = await setup({ effectiveDate }), final = new AbortController();
  during.state.onPolicy = count => { if (count === 4) final.abort(); return { ...GRANT }; };
  await assert.rejects(during.service.catalog({ ...during.input, includeRecommendation: true }, { signal: final.signal }), /cancelled/);
  const uncertain = await setup({ effectiveDate }), finalCommit = effectiveDate === '2026-09-06' ? 3 : 2;
  uncertain.state.onCommit = count => { if (count === finalCommit) uncertain.state.failCommit = true; };
  await assert.rejects(uncertain.service.catalog({ ...uncertain.input, includeRecommendation: true }), error => error.outcome_unknown === true);
  assert.equal(uncertain.state.commits, finalCommit);
  assert.deepEqual(uncertain.state.policies.map(call => call.exposure), [CATALOG, SUMMARY, CATALOG, SUMMARY],
    'the lost acknowledgment is still injected after final authorization, not at the new middle commit');
  assert.ok(uncertain.state.releases.at(-1) instanceof Error);
});

test('invalid optional flag is rejected before checkout and cannot act as a caller grant', async () => {
  const { service, input, state } = await setup();
  for (const flag of ['true', 1, null, {}, []]) await assert.rejects(service.catalog({ ...input, includeRecommendation: flag }), /invalid_input/);
  await assert.rejects(service.catalog({ ...input, includeRecommendation: true, source_grant: true }), /invalid_input/);
  assert.equal(state.connects, 0);
});

test('opening catalog/map/statistics equal independent views but read the retained graph only once', async () => {
  const { service, input, state } = await setup({ effectiveDate: '2026-09-05' });
  const catalog = await service.catalog(input);
  const all = [...catalog.catalog.pockets.map(p => p.id),
    ...(catalog.catalog.unassigned.member_count ? ['discovery:unassigned'] : [])];
  for (const ids of [all, all.slice(0, 1), []]) {
    const selection = customCohortOpeningSelection(catalog.catalog, ids, input.selection.revision);
    const ordinary = await service.present({ ...input, selection });
    state.sourceReads = 0; state.policies.length = 0; state.calls.length = 0;
    const opening = await service.catalog({ ...input, initialPreviewGroups: ids, includeRecommendation: true });
    const reads = state.sourceReads;
    assert.deepEqual(opening.initial_preview, ordinary);
    const { initial_preview, ...catalogOnly } = opening;
    assert.deepEqual(catalogOnly, catalog);
    assert.deepEqual(state.policies.map(p => p.exposure), [CATALOG, SUMMARY, CATALOG, SUMMARY]);
    assert.equal(state.policies[1].sourceReads, 0);
    assert.equal(state.calls.filter(sql => sql === 'BEGIN ISOLATION LEVEL READ COMMITTED').length, 2);
    assert.ok(reads > 0);
    state.sourceReads = 0; await service.catalog(input); await service.present({ ...input, selection });
    assert.equal(state.sourceReads, reads * 2, 'two old reads reconstruct twice; the opening reconstructs once');
    assert.equal(initial_preview.apply.status, 'blocked');
  }
});

test('opening group IDs are bounded/copied before checkout, unknown IDs fail without default selection', async () => {
  const { service, input, state } = await setup();
  for (const ids of [null, {}, [null], ['not-a-group'], Array(2),
    ['discovery:unassigned', 'discovery:unassigned'], Array(1026).fill('discovery:unassigned')]) {
    await assert.rejects(service.catalog({ ...input, initialPreviewGroups: ids }), /invalid_input/);
  }
  assert.equal(state.connects, 0);
  await assert.rejects(service.catalog({ ...input, initialPreviewGroups: [`recorded-cad:${'f'.repeat(64)}`] }), /invalid_selection/);
  const value = { ...input, initialPreviewGroups: [] };
  state.onPolicy = () => { value.initialPreviewGroups.push('must-not-be-read'); return { ...GRANT }; };
  const opening = await service.catalog(value);
  const ordinary = await service.present(input);
  assert.deepEqual(opening.initial_preview, ordinary);
});

for (const deniedAt of [1, 2, 3, 4]) test(`opening denies exposure ${deniedAt} even without recommendation`, async () => {
  const { service, input, state } = await setup();
  state.onPolicy = n => n === deniedAt ? { allowed: false } : { ...GRANT };
  await assert.rejects(service.catalog({ ...input, initialPreviewGroups: [] }), /market_data_access_denied/);
  assert.equal(state.policies.length, deniedAt); assert.equal(state.sourceReads > 0, deniedAt > 2);
});

for (const type of ['material', 'assignment', 'policy']) test(`opening still refuses a final ${type} change`, async () => {
  const { service, input, state, f } = await setup();
  state.onCommit = count => {
    if (count !== 1) return;
    if (type === 'material') setSection(f.f.state.input, 1, '{"main_improvement":{"living_area_sqft":9999}}');
    else if (type === 'assignment') state.assigned = '80000000-0000-4000-8000-000000000002';
    else state.onPolicy = () => ({ ...GRANT, policy_revision: 'changed' });
  };
  await assert.rejects(service.catalog({ ...input, initialPreviewGroups: [] }),
    type === 'material' ? /subject_changed/ : type === 'assignment' ? /assignment_access_denied/ : /market_policy_changed/);
});
