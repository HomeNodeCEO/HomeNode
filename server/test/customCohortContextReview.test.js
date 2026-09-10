import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortDecisionEvidenceResolver } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cohortCommandFixture, cohortUuid } from './fixtures/neighborhoodCohortDecisionCommandFixture.js';

const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });
const permission = { allowed: true, decision_id: 'fixture-license', policy_revision: 'fixture-license-v1' };
const includesError = (error, pattern) => pattern.test(error?.message ?? '')
  || (error instanceof AggregateError && error.errors.some(child => includesError(child, pattern)));

// Actual owner, context/blob/subject/retained loader, binder and review repository
// over scoped query fakes. Transaction snapshots below model rollback and lost
// acknowledgments; these tests do not establish native locking/MVCC behavior.
async function fixture({ deniedRetainedMapping = null } = {}) {
  const f = await decisionEvidenceFixture();
  let headerJson = f.input.context_header_json, header = prepareCustomCohortContextHeader(headerJson);
  if (deniedRetainedMapping !== null) {
    // Deliberately metadata-only negative fixture. Rebind each enclosing hash,
    // but deny before source loading; this does NOT claim a valid v3 source graph.
    const read = async ref => JSON.parse(await f.store.get(ref.content_sha256, ref.canonical_utf8_bytes));
    const directory = await read(header.body.selection_input), compact = await read(directory.compact_metadata);
    directory.compact_metadata = await f.store.put(json({ ...compact, mapping_version: deniedRetainedMapping }));
    headerJson = json({ ...header.body, selection_input: await f.store.put(json(directory)) });
    header = prepareCustomCohortContextHeader(headerJson);
  }
  await f.store.put(headerJson);
  const scope = f.input.expected.target, contextRef = header.context_ref, actor = cohortUuid(800);
  const context = { ...contextRef, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const target = f.f.state.input.target;
  const state = { calls: [], policies: [], releases: [], connects: 0, commits: 0, rollbacks: 0,
    rows: new Map(), payloadReads: new Map(), assigned: actor, actorActive: true,
    missingAssignment: false, missingContext: false, reportId: scope.report_file_id,
    caseId: target.appraisal_case_id, snapshotId: target.subject_snapshot_id,
    failInsert: false, failCommit: false, failRollback: false, failRelease: false,
    onQuery: null, onPolicy: null, onInsert: null, onCommit: null };
  const payloadHashes = new Set(f.input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(s => s.content_sha256));
  const baseQuery = f.client.query.bind(f.client);
  let transactionSnapshot = null, savepoint = null, open = false;
  const take = () => ({ rows: new Map(state.rows), blobs: new Map(f.f.state.db) });
  const restore = snapshot => { state.rows = new Map(snapshot.rows); f.f.state.db = new Map(snapshot.blobs); };
  const matchesScope = params => params[0] === scope.organization_id && params[1] === scope.report_file_id
    && params[2] === scope.assignment_file_id && params[3] === scope.account_id;
  const client = {
    async query(config) {
      const sql = config.text, params = config.values ?? [];
      state.calls.push({ sql, params: structuredClone(params), timeout: config.query_timeout });
      if (state.onQuery) await state.onQuery(sql, params);
      if (sql.startsWith('BEGIN ')) { assert.equal(open, false); open = true; transactionSnapshot = take(); return row(); }
      if (sql.startsWith('SET LOCAL ')) return row();
      if (sql === 'COMMIT') {
        if (state.onCommit) await state.onCommit();
        state.commits++; open = false;
        if (state.failCommit) throw new Error('synthetic_commit_ack_lost');
        return row();
      }
      if (sql === 'ROLLBACK') {
        state.rollbacks++;
        if (state.failRollback) throw new Error('synthetic_rollback_failure');
        restore(transactionSnapshot); open = false; return row();
      }
      if (sql === 'SAVEPOINT custom_cohort_review_append') { assert.equal(open, true); savepoint = take(); return row(); }
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) { restore(savepoint); return row(); }
      if (sql.startsWith('RELEASE SAVEPOINT')) return row();
      const ownerTag = sql.match(/custom-cohort-capture:([a-z-]+)/)?.[1];
      if (ownerTag === 'assignment') {
        assert.match(sql, /FOR UPDATE NOWAIT/);
        return row(!state.missingAssignment && params[0] === scope.assignment_file_id && params[1] === scope.account_id
          ? { assignment_file_id: scope.assignment_file_id, account_id: scope.account_id, organization_id: scope.organization_id,
            assigned_appraiser_user_id: state.assigned, supervisory_appraiser_user_id: null } : null);
      }
      if (ownerTag === 'report') {
        assert.deepEqual(params, [scope.assignment_file_id, scope.account_id, scope.organization_id]);
        return row({ report_file_id: state.reportId, appraisal_case_id: state.caseId, subject_snapshot_id: state.snapshotId });
      }
      const contextTag = sql.match(/custom-cohort-context:([a-z-]+)/)?.[1];
      if (contextTag === 'transaction') return row({ transaction_id: '123456789' });
      if (contextTag === 'target') return row(matchesScope(params) ? { id: scope.report_file_id } : null);
      if (contextTag === 'read') return row(!state.missingContext && matchesScope(params) && params[4] === contextRef.context_id ? context : null);
      const tag = sql.match(/custom-cohort-review:([a-z-]+)/)?.[1];
      if (tag) {
        const ordered = [...state.rows.values()].filter(r => r.organization_id === params[0] && r.context_id === params[1])
          .sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1);
        if (tag === 'actor') return row(state.actorActive ? { id: params[0] } : null);
        if (tag === 'context-lock') return row(matchesScope(params) && params[4] === contextRef.context_id
          && params[5] === contextRef.context_revision && params[6] === contextRef.context_sha256 ? { context_id: contextRef.context_id } : null);
        if (tag === 'head') return row(ordered[0] ? { generation: ordered[0].generation } : null);
        if (tag === 'fact') {
          const found = ordered.find(r => r.fact_key_sha256 === params[2]);
          return row(found ? { operation_id: found.operation_id, content_sha256: found.content_sha256, generation: found.generation } : null);
        }
        if (tag === 'operation') return row(state.rows.get(`${params[0]}:${params[1]}`));
        if (tag === 'insert') {
          if (state.failInsert) throw new Error('synthetic_review_insert_failure');
          const keys = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'context_id', 'context_revision', 'context_sha256',
            'operation_id', 'generation', 'fact_key_sha256', 'actor_user_id', 'predecessor_operation_id', 'predecessor_content_sha256',
            'content_sha256', 'canonical_utf8_bytes'];
          const stored = Object.fromEntries(keys.map((key, i) => [key, params[i]]));
          state.rows.set(`${stored.organization_id}:${stored.operation_id}`, stored);
          if (state.onInsert) await state.onInsert();
          return row(stored);
        }
        assert.fail(`Unexpected review query: ${tag}`);
      }
      if (sql.includes('neighborhood-cohort-blob:read') && payloadHashes.has(params[1])) {
        assert.ok(state.policies.length > 0, 'source payload read before current policy');
        state.payloadReads.set(params[1], (state.payloadReads.get(params[1]) ?? 0) + 1);
      }
      return baseQuery(sql, params);
    },
    release(error) {
      state.releases.push(error);
      // Model PostgreSQL rolling back an uncommitted discarded connection.
      if (open) { restore(transactionSnapshot); open = false; }
      if (state.failRelease) throw new Error('synthetic_release_failure');
    },
  };
  const authorizeMarketData = async (boundedClient, auth, current, purpose, exposure) => {
    state.policies.push({ boundedClient, auth, current, purpose, exposure });
    assert.deepEqual(exposure, { retention: true, exposure: 'none' });
    assert.equal(current.scope.organization_id, scope.organization_id);
    assert.equal(current.target.workflow_target_id, scope.assignment_file_id);
    return state.onPolicy ? state.onPolicy(state.policies.length, boundedClient) : { ...permission };
  };
  const service = createCustomCohortContextCapture({ pool: { async connect() { state.connects++; return client; } }, authorizeMarketData });
  const resolver = createCustomCohortDecisionEvidenceResolver(f.input);
  const evidence = resolver.deriveEvidenceRef(f.sourceRef, f.recordId);
  function command(kind = 'closing_date', id = 1) {
    const value = cohortCommandFixture(kind);
    Object.assign(value, { operation_id: cohortUuid(id), target_ref: resolver.binding.target_ref,
      expected_context: contextRef, study_ref: resolver.binding.study_ref,
      expected_generation: '0', expected_predecessor: null, subject_ref: { kind: 'capture_candidate', key: f.recordId }, evidence_refs: [evidence] });
    if (kind === 'closing_date') value.claim.value = { date: '2024-03-01', event_evidence_refs: [evidence] };
    if (kind === 'sale_completion') value.claim.value = { completed: true, event_evidence_refs: [evidence] };
    return value;
  }
  const input = commandValue => ({ auth: { userId: actor, displayName: 'Not the actor UUID', email: 'not-used@example.invalid',
    organizations: [{ organizationId: scope.organization_id, roles: ['appraiser'] }] },
  accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, commandJson: json(commandValue ?? command()) });
  f.f.state.calls.length = 0;
  return { f, scope, contextRef, actor, state, client, service, command, input, payloadHashes };
}

function untouched(f, blobCount) {
  assert.equal(f.state.rows.size, 0); assert.equal(f.f.f.state.db.size, blobCount);
  assert.equal(f.state.commits, 0);
  assert.ok(!f.state.calls.some(({ sql }) => /(?:INSERT INTO|UPDATE|DELETE FROM) app\.(?:custom_appraisal_workfile|custom_neighborhood_acceptance|assignment_files|report_files)/i.test(sql)));
}

for (const mapping of [1, 2, 3, 4]) test(`review authorizes retained mapping${mapping} before rows, independently of current mapping2 owner`, async () => {
  const f = await fixture({ deniedRetainedMapping: mapping });
  f.state.onPolicy = () => ({ allowed: false });
  const before = f.f.f.state.db.size;
  await assert.rejects(f.service.review(f.input()), /market_data_access_denied/);
  assert.equal(f.state.policies.length, 1);
  const purpose = f.state.policies[0].purpose;
  if (mapping === 3) assert.equal(purpose.source_projection.id, 'cached-sale-scalar-witness-v1');
  else assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
  assert.equal(f.state.payloadReads.size, 0);
  untouched(f, before);
});

test('review commits once before minimal immutable receipt; actor is the authenticated UUID and retained graph loads once', async () => {
  const f = await fixture(), before = structuredClone(f.f.f.state.input.sections), output = await f.service.review(f.input());
  assert.deepEqual(Object.keys(output).sort(), ['status', 'reused', 'context_ref', 'decision_ref', 'generation', 'authority'].sort());
  assert.equal(output.status, 'review_recorded'); assert.equal(output.reused, false); assert.equal(output.generation, '1');
  assert.equal(output.authority, 'not_established'); assert.deepEqual(output.context_ref, f.contextRef);
  assert.equal(output.decision_ref.decision_id, f.command().operation_id);
  assert.ok(Object.isFrozen(output) && Object.isFrozen(output.decision_ref));
  assert.doesNotMatch(JSON.stringify(output), /275000|2024-03-01|claim|recorded_reviewer|source:10|raw_projection|Not the actor/);
  assert.equal(f.state.connects, 1); assert.equal(f.state.commits, 1); assert.deepEqual(f.state.releases, [undefined]);
  assert.equal(f.state.calls.at(-1).sql, 'COMMIT');
  assert.equal(f.state.calls.filter(c => c.sql.includes('custom-cohort-capture:assignment')).length, 2);
  assert.deepEqual(f.state.calls.filter(c => c.sql.startsWith('BEGIN ')).map(c => c.sql), ['BEGIN ISOLATION LEVEL READ COMMITTED']);
  assert.equal(f.state.policies.length, 2);
  assert.deepEqual(f.state.policies[0].auth, { userId: f.actor, organizations: f.input().auth.organizations });
  assert.notEqual(f.state.policies[0].boundedClient, f.client);
  assert.equal(f.state.payloadReads.size, f.payloadHashes.size);
  assert.ok([...f.state.payloadReads.values()].every(count => count === 1), 'raw graph must not load twice');
  assert.equal([...f.state.rows.values()][0].actor_user_id, f.actor);
  assert.deepEqual(f.f.f.state.input.sections, before);
  assert.ok(f.state.calls.every(call => Number.isInteger(call.timeout) && call.timeout > 0 && call.timeout <= 6000));
});

test('receipt is not delivered while COMMIT acknowledgment is pending', async () => {
  const f = await fixture(); let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.state.onCommit = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  let settled = false;
  const pending = f.service.review(f.input()).finally(() => { settled = true; });
  await started; await Promise.resolve(); assert.equal(settled, false); assert.equal(f.state.releases.length, 0);
  finish(); assert.equal((await pending).status, 'review_recorded'); assert.equal(f.state.commits, 1);
});

test('exact authorized replay returns original generation even after another claim and writes no duplicate', async () => {
  const f = await fixture(), first = await f.service.review(f.input());
  const next = f.command('sale_completion', 2); next.expected_generation = '1';
  assert.equal((await f.service.review(f.input(next))).generation, '2');
  const count = f.f.f.state.db.size, replay = await f.service.review(f.input());
  assert.deepEqual(replay, { ...first, reused: true });
  assert.equal(f.state.rows.size, 2); assert.equal(f.f.f.state.db.size, count);
  assert.equal(f.state.policies.length, 6); assert.equal(f.state.connects, 3);
});

for (const [name, mutate] of [
  ['missing authentication', input => { input.auth = null; }],
  ['rounded assignment', input => { input.assignmentFileId = 9007199254740992; }],
  ['aliased account', input => { input.accountId = ` ${input.accountId}`; }],
  ['body actor', input => { input.actor_user_id = cohortUuid(700); }],
  ['body authority', input => { input.source_policy = { allowed: true }; }],
  ['parsed command object', input => { input.commandJson = JSON.parse(input.commandJson); }],
  ['noncanonical command JSON', input => { input.commandJson = ` ${input.commandJson}`; }],
  ['oversized command', input => { input.commandJson = 'x'.repeat(64001); }],
  ['command assignment mismatch', input => { const c = JSON.parse(input.commandJson); c.target_ref.workflow_target_id = '11'; input.commandJson = json(c); }],
  ['command actor injection', input => { const c = JSON.parse(input.commandJson); c.actor_user_id = cohortUuid(700); input.commandJson = json(c); }],
]) test(`review rejects ${name} before checkout/policy`, async () => {
  const f = await fixture(), value = f.input(); mutate(value);
  await assert.rejects(f.service.review(value));
  assert.equal(f.state.connects, 0); assert.equal(f.state.policies.length, 0); assert.equal(f.state.calls.length, 0);
});

for (const scenario of ['workflow-read-only', 'unassigned-appraiser', 'other-organization', 'missing-assignment', 'wrong-report', 'missing-context']) {
  test(`review denies ${scenario} before reading raw source evidence`, async () => {
    const f = await fixture(), value = f.input(), count = f.f.f.state.db.size;
    if (scenario === 'workflow-read-only') value.auth.organizations[0].roles = ['reviewer'];
    if (scenario === 'unassigned-appraiser') f.state.assigned = cohortUuid(900);
    if (scenario === 'other-organization') value.auth.organizations[0].organizationId = cohortUuid(900);
    if (scenario === 'missing-assignment') f.state.missingAssignment = true;
    if (scenario === 'wrong-report') f.state.reportId = cohortUuid(900);
    if (scenario === 'missing-context') f.state.missingContext = true;
    await assert.rejects(f.service.review(value));
    untouched(f, count); assert.equal(f.state.payloadReads.size, 0); assert.equal(f.state.policies.length, 0);
    assert.equal(f.state.rollbacks, 1); assert.deepEqual(f.state.releases, [undefined]);
  });
}

for (const scenario of ['denied', 'changed-revision', 'changed-decision', 'throw']) {
  test(`first current source policy ${scenario} cannot read retained raw rows or append`, async () => {
    const f = await fixture(), count = f.f.f.state.db.size;
    f.state.onPolicy = () => {
      assert.equal(f.state.payloadReads.size, 0);
      if (scenario === 'throw') throw new Error('synthetic_policy_failure');
      return scenario === 'denied' ? { allowed: false } : { ...permission,
        ...(scenario === 'changed-revision' ? { policy_revision: 'new-policy' } : { decision_id: 'another-decision' }) };
    };
    await assert.rejects(f.service.review(f.input()));
    untouched(f, count); assert.equal(f.state.payloadReads.size, 0); assert.equal(f.state.rollbacks, 1);
  });
}

for (const scenario of ['policy-denied', 'policy-changed', 'assignment-changed', 'report-changed']) {
  test(`final ${scenario} rolls back the tentative review and its blob`, async () => {
    const f = await fixture(), count = f.f.f.state.db.size;
    if (scenario.startsWith('policy')) f.state.onPolicy = call => call === 1 ? { ...permission }
      : scenario === 'policy-denied' ? { allowed: false } : { ...permission, policy_revision: 'changed' };
    if (scenario === 'assignment-changed') f.state.onInsert = () => { f.state.assigned = cohortUuid(900); };
    if (scenario === 'report-changed') f.state.onInsert = () => { f.state.reportId = cohortUuid(900); };
    await assert.rejects(f.service.review(f.input()));
    assert.ok(f.state.calls.some(c => c.sql.includes('custom-cohort-review:insert')));
    untouched(f, count); assert.equal(f.state.rollbacks, 1); assert.deepEqual(f.state.releases, [undefined]);
  });
}

for (const scenario of ['signed-status', 'signed-at', 'signed-snapshot', 'archived', 'stale-material', 'inactive-actor', 'stale-generation']) {
  test(`actual review repository rejects ${scenario} under the owner transaction`, async () => {
    const f = await fixture(), value = f.input(), count = f.f.f.state.db.size;
    if (scenario === 'signed-status') f.f.f.state.status = 'signed';
    if (scenario === 'signed-at') f.f.f.state.signedAt = '2026-09-09T00:00:00Z';
    if (scenario === 'signed-snapshot') f.f.f.state.signed = true;
    if (scenario === 'archived') f.f.f.state.status = 'archived';
    if (scenario === 'stale-material') f.f.f.state.input.snapshot.effective_date = '2026-09-05';
    if (scenario === 'inactive-actor') f.state.actorActive = false;
    if (scenario === 'stale-generation') { const c = JSON.parse(value.commandJson); c.expected_generation = '1'; value.commandJson = json(c); }
    await assert.rejects(f.service.review(value));
    untouched(f, count); assert.equal(f.state.rollbacks, 1);
    assert.ok(f.state.calls.some(c => c.sql.startsWith('ROLLBACK TO SAVEPOINT')));
  });
}

test('replay must reauthorize source access and assignment, not bypass them through operation identity', async () => {
  const f = await fixture(); await f.service.review(f.input());
  const count = f.f.f.state.db.size, reads = [...f.state.payloadReads.values()].reduce((a, b) => a + b, 0);
  f.state.onPolicy = () => ({ allowed: false });
  await assert.rejects(f.service.review(f.input()), /market_data_access_denied/);
  assert.equal([...f.state.payloadReads.values()].reduce((a, b) => a + b, 0), reads);
  assert.equal(f.state.rows.size, 1); assert.equal(f.f.f.state.db.size, count);
  f.state.assigned = cohortUuid(900); const policies = f.state.policies.length;
  await assert.rejects(f.service.review(f.input()), /assignment_access_denied/);
  assert.equal(f.state.policies.length, policies);
});

test('request identity and original command are detached before asynchronous policy work', async () => {
  const f = await fixture(), input = f.input(), original = input.commandJson;
  f.state.onPolicy = call => {
    if (call === 1) { input.auth.userId = cohortUuid(900); input.auth.organizations[0].roles = [];
      input.commandJson = '{}'; input.accountId = 'OTHER'; }
    return { ...permission };
  };
  const result = await f.service.review(input);
  assert.equal(result.decision_ref.decision_id, JSON.parse(original).operation_id);
  assert.equal([...f.state.rows.values()][0].actor_user_id, f.actor);
  assert.ok(f.state.policies.every(p => p.auth.userId === f.actor));
});

test('pre-abort and elapsed aggregate deadline reject without checkout', async () => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.review(f.input(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(f.service.review(f.input(), { deadline: performance.now() }), /deadline_exceeded/);
  assert.equal(f.state.connects, 0);
});

test('cancellation while policy waits rolls back, closes its bounded client, and cannot issue late source queries', async () => {
  const f = await fixture(), controller = new AbortController(), count = f.f.f.state.db.size;
  let ready, lateClient, finish;
  const entered = new Promise(resolve => { ready = resolve; });
  f.state.onPolicy = (_call, client) => { lateClient = client; ready(); return new Promise(resolve => { finish = resolve; }); };
  const pending = f.service.review(f.input(), { signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(pending, /cancelled/);
  untouched(f, count); assert.equal(f.state.payloadReads.size, 0); assert.equal(f.state.rollbacks, 1);
  const calls = f.state.calls.length;
  await assert.rejects(lateClient.query('SELECT private_late_source'), /closed_operation/);
  assert.equal(f.state.calls.length, calls); finish({ ...permission }); await Promise.resolve();
});

test('cancellation after tentative insert discards/rolls back the connection and cannot produce a receipt', async () => {
  const f = await fixture(), controller = new AbortController(), count = f.f.f.state.db.size;
  f.state.onInsert = () => controller.abort();
  await assert.rejects(f.service.review(f.input(), { signal: controller.signal }), error => includesError(error, /cancelled/));
  untouched(f, count); assert.equal(f.state.releases.length, 1); assert.ok(f.state.releases[0]);
});

test('insert driver failure discards uncertain connection and rolls back all tentative effects', async () => {
  const f = await fixture(), count = f.f.f.state.db.size; f.state.failInsert = true;
  await assert.rejects(f.service.review(f.input()), /synthetic_review_insert_failure/);
  untouched(f, count); assert.equal(f.state.releases.length, 1); assert.ok(f.state.releases[0]);
});

test('failed rollback does not mask denial and discards its connection once', async () => {
  const f = await fixture(), count = f.f.f.state.db.size; f.state.failRollback = true; f.state.assigned = cohortUuid(900);
  await assert.rejects(f.service.review(f.input()), /assignment_access_denied/);
  untouched(f, count); assert.equal(f.state.releases.length, 1); assert.match(f.state.releases[0].message, /rollback_failure/);
});

test('lost COMMIT acknowledgment reports unknown outcome, never blindly retries, then exact authorized retry reuses', async () => {
  const f = await fixture(); f.state.failCommit = true;
  await assert.rejects(f.service.review(f.input()), error => error.outcome_unknown === true && /commit_ack_lost/.test(error.message));
  assert.equal(f.state.connects, 1); assert.equal(f.state.commits, 1); assert.equal(f.state.rollbacks, 0);
  assert.equal(f.state.rows.size, 1); assert.equal(f.state.releases.length, 1); assert.ok(f.state.releases[0]);
  f.state.failCommit = false;
  const result = await f.service.review(f.input());
  assert.equal(result.reused, true); assert.equal(result.generation, '1'); assert.equal(f.state.rows.size, 1);
  assert.equal(f.state.policies.length, 4);
});

test('post-COMMIT release failure remains unknown outcome, not a successful receipt or false rollback', async () => {
  const f = await fixture(); f.state.failRelease = true;
  await assert.rejects(f.service.review(f.input()), error => error.outcome_unknown === true && /release_failure/.test(error.message));
  assert.equal(f.state.commits, 1); assert.equal(f.state.rows.size, 1); assert.equal(f.state.rollbacks, 0);
});

test('cancellation during checkout releases one late client without BEGIN or policy', async () => {
  const f = await fixture(), controller = new AbortController(); let give;
  const releases = [], calls = [];
  const owner = createCustomCohortContextCapture({ pool: { connect: () => new Promise(resolve => { give = resolve; }) },
    authorizeMarketData: () => assert.fail('must not call policy') });
  const pending = owner.review(f.input(), { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve(); controller.abort();
  await assert.rejects(pending, /cancelled/);
  give({ release: error => releases.push(error), query: value => calls.push(value) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(releases.length, 1); assert.ok(releases[0]); assert.equal(calls.length, 0);
});
