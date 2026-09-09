import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { createCustomCohortDecisionEvidenceResolver } from '../../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { createCustomCohortReviewRepository } from '../../src/services/neighborhoodAssessment/customCohortReviewRepository.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const DEPS = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const reason = expected => error => error.reason === expected;
const sqlstate = expected => error => error.code === expected;

/** Actual repository/retained graph on the preceding coordinator + checkpoint
 * fixture only. No database creation, schema changes, production policy grants,
 * services or authenticated HTTP are provided by this helper. The policy and
 * principal below are explicitly synthetic; repository persistence grants no
 * supported-fact or dataset authority. Caller owns the disposable database. */
export async function runCustomCohortReviewDatabaseChecks(connectionString) {
  const database = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: database.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, query_timeout: 9000, application_name: 'custom_cohort_review_native_test' });
  const checks = []; let fixture, restoreStatus = false;
  async function begin(client, isolation = 'READ COMMITTED') {
    assert.ok(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation));
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query("SET LOCAL statement_timeout='7000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='15000ms'");
  }
  async function transaction(execute, commit = false, isolation = 'READ COMMITTED') {
    const client = await pool.connect(); let discard;
    try { await begin(client, isolation); const result = await execute(client); await client.query(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch (cleanup) { discard = cleanup; } throw error; }
    finally { client.release(discard); }
  }
  try {
    const probe = await pool.connect();
    try { verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, database.databaseName); } finally { probe.release(); }
    const identity = await pool.query(`SELECT a.id::text AS assignment_file_id,a.account_id,a.organization_id,
      a.assigned_appraiser_user_id AS actor_id,r.id AS report_file_id,r.subject_snapshot_id,c.effective_date::text,
      w.status,w.signed_at::text,w.signed_by,w.updated_at::text
      FROM app.assignment_files a
      JOIN app.report_files r ON r.custom_assignment_file_id=a.id AND r.account_id=a.account_id AND r.organization_id=a.organization_id
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
      JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id AND c.account_id=a.account_id AND c.organization_id=a.organization_id
      JOIN app_auth.organizations o ON o.id=a.organization_id
      JOIN app_auth.users u ON u.id=a.created_by_user_id AND u.id=a.assigned_appraiser_user_id
      WHERE a.account_id=$1 AND o.legal_name=$2 AND u.display_name=$3`,
    ['CAPTURE-COORD-SUBJECT', 'Synthetic Custom capture', 'Synthetic capture actor']);
    assert.equal(identity.rowCount, 1, 'requires the exact preceding synthetic coordinator fixture'); fixture = identity.rows[0];
    assert.equal(fixture.effective_date, '2024-06-30');
    assert.equal(fixture.status, 'signed'); assert.equal(fixture.signed_by, 'Synthetic native signed-state guard');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_signed_snapshots WHERE assignment_file_id=$1',
      [fixture.assignment_file_id])).rows[0].n, 0, 'only the earlier synthetic status guard may be reset, never a signed artifact');
    // The checkpoint helper deliberately ends with a synthetic signed-state
    // guard. Reopen ONLY that identified fixture and restore its exact metadata
    // in finally; a new coordinator capture must see current material inputs.
    restoreStatus = true;
    await pool.query(`UPDATE app.custom_appraisal_workfiles SET status='draft',signed_at=NULL,signed_by=NULL
      WHERE assignment_file_id=$1`, [fixture.assignment_file_id]);
    const scope = { organization_id: fixture.organization_id, report_file_id: fixture.report_file_id,
      assignment_file_id: fixture.assignment_file_id, account_id: fixture.account_id }, scopeJson = json(scope);
    const target = { accountId: fixture.account_id, assignmentFileId: fixture.assignment_file_id };
    const auth = { userId: fixture.actor_id, organizations: [{ organizationId: fixture.organization_id, roles: ['appraiser'] }] };
    const period = { start_date: '2023-07-01', end_date: fixture.effective_date };
    const protectedState = async () => {
      const queries = [
        ['sections', 'SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1 ORDER BY section_key'],
        ['histories', 'SELECT to_jsonb(h) AS value FROM app.custom_appraisal_workfile_section_history h WHERE assignment_file_id=$1 ORDER BY id'],
        ['acceptances', 'SELECT to_jsonb(a) AS value FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1 ORDER BY id'],
        ['signatures', 'SELECT to_jsonb(s) AS value FROM app.custom_appraisal_signed_snapshots s WHERE assignment_file_id=$1 ORDER BY id'],
        ['report', 'SELECT to_jsonb(r) AS value FROM app.report_files r WHERE custom_assignment_file_id=$1'],
        ['assignment', 'SELECT to_jsonb(a) AS value FROM app.assignment_files a WHERE id=$1'],
      ];
      return Object.fromEntries(await Promise.all(queries.map(async ([name, sql]) => [name,
        (await pool.query(sql, [fixture.assignment_file_id])).rows])));
    };
    const before = await protectedState(); assert.equal(before.acceptances.length, 0);
    const policyCalls = [];
    const owner = createCustomCohortContextCapture({ pool,
      authorizeMarketData: async (_client, principal, context, purpose, options) => {
        assert.equal(principal.userId, fixture.actor_id); assert.equal(context.scope.organization_id, fixture.organization_id);
        assert.equal(options.retention, true); assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
        policyCalls.push(options.exposure);
        return { allowed: true, decision_id: 'synthetic_native_review_fixture_only', policy_revision: 'synthetic-review-v1' };
      } });
    const captured = await owner.capture({ ...target, auth, operationId: randomUUID(), observationPeriod: period });
    assert.equal(captured.status, 'registered'); assert.equal(captured.reused, false); assert.ok(policyCalls.length >= 2);
    const prepared = await transaction(async client => {
      const header = await createCustomCohortContextRepository(client, scopeJson).get(json(captured.context_ref));
      assert.ok(header);
      const retained = await loadCustomCohortCaptureInputs(client, scopeJson, Object.fromEntries(DEPS.map(key => [key, header.body[key]])));
      const resolver = createCustomCohortDecisionEvidenceResolver({ context_header_json: header.header_blob.canonical_json,
        expected: { context_ref: captured.context_ref, target: scope, observation_period: period },
        retained_inputs: retained.retained_inputs, selection: { revision: 1, included_recorded_group_ids: [] } });
      const source = retained.retained_inputs.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'transactions');
      assert.ok(source && source.payload.records.length > 0, 'genuine coordinator transaction-role record required');
      const record = source.payload.records[0], ref = resolver.deriveEvidenceRef(source.id, record.record_id);
      const date = record.data.raw_projection.sale_closing_date;
      assert.equal(date, '2024-03-01', 'exact prior native fixture, not an invented reviewer date');
      return { binding: resolver.binding, subject: { kind: 'capture_candidate', key: record.record_id }, ref, date };
    });
    const command = (generation, predecessor = null, overrides = {}) => ({ version: 1, operation_id: randomUUID(),
      target_ref: prepared.binding.target_ref, expected_context: prepared.binding.context_ref, study_ref: prepared.binding.study_ref,
      expected_generation: String(generation), expected_predecessor: predecessor, subject_ref: prepared.subject,
      claim: { kind: 'closing_date', qualifier: { basis: 'event' }, state: 'known',
        value: { date: prepared.date, event_evidence_refs: [prepared.ref] }, unknown_reason: null, decision_refs: [] },
      evidence_refs: [prepared.ref], rationale: 'Synthetic native retained-date reviewer command; not factual certification.', ...overrides });
    const repo = client => createCustomCohortReviewRepository(client, scopeJson);
    const append = (value, actor = fixture.actor_id, commit = true) => transaction(client => repo(client).append(json(value), actor), commit);
    const totals = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM app.custom_neighborhood_review_commands WHERE organization_id=$1) AS reviews,
      (SELECT count(*)::int FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1) AS blobs`, [scope.organization_id])).rows[0];
    const firstCommand = command(0), first = await append(firstCommand);
    assert.equal(first.status, 'stored'); assert.equal(first.generation, '1'); assert.equal(first.authority, 'not_established');
    assert.equal(first.record.claim_observation.status, 'matched'); assert.equal(first.record.claim_observation.observed_date, prepared.date);
    assert.equal(first.durability, 'caller_transaction');
    const opened = await transaction(client => repo(client).getOperation(firstCommand.operation_id));
    assert.equal(opened.status, 'retained'); assert.deepEqual(opened.record, first.record); assert.deepEqual(opened.decision_ref, first.decision_ref);
    checks.push('fresh coordinator capture, actual retained-graph reference and matched closing-date command commit and reopen exactly');

    const replacementCommand = command(1, first.decision_ref, { claim: { ...firstCommand.claim,
      state: 'unknown', value: null, unknown_reason: 'conflicting_evidence' } });
    const replacement = await append(replacementCommand); assert.equal(replacement.generation, '2');
    const otherCommand = command(2, null, { claim: { kind: 'sale_completion', qualifier: { basis: 'event' },
      state: 'unknown', value: null, unknown_reason: 'missing_evidence', decision_refs: [] } });
    const other = await append(otherCommand); assert.equal(other.generation, '3');
    const replay = await append(firstCommand); assert.equal(replay.status, 'reused'); assert.deepEqual(replay.record, first.record);
    assert.equal(replay.generation, '1'); assert.equal((await totals()).reviews, 3);
    await assert.rejects(append({ ...firstCommand, rationale: 'Different synthetic review command' }), reason('operation_conflict'));
    await transaction(async client => {
      const actor = randomUUID(); await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic alternate review actor')", [actor, `${actor}@example.test`]);
      await assert.rejects(repo(client).append(json(firstCommand), actor), reason('operation_conflict'));
    });
    await assert.rejects(append(command(2, replacement.decision_ref)), reason('generation_conflict'));
    await assert.rejects(append(command(3, first.decision_ref)), reason('predecessor_conflict'));
    await assert.rejects(append(command(3, other.decision_ref)), reason('predecessor_conflict'));
    const badRef = structuredClone(firstCommand); badRef.operation_id = randomUUID(); badRef.expected_generation = '3';
    badRef.evidence_refs[0].record_content_sha256 = 'f'.repeat(64);
    badRef.claim.value.event_evidence_refs[0].record_content_sha256 = 'f'.repeat(64);
    await assert.rejects(append(badRef), /evidence_reference_mismatch/);
    checks.push('independent per-fact predecessor and context generation, unknown correction, other-fact null predecessor, exact historical replay and changed command/actor/ref conflicts');

    const conditions = code => ({ kind: 'material_condition', qualifier: { basis: 'condition', condition_code: code },
      state: 'unknown', value: null, unknown_reason: 'unreviewed_material_condition', decision_refs: [] });
    const a = await pool.connect(), b = await pool.connect();
    const winnerCommand = command(3, null, { claim: conditions('synthetic-a') });
    const loserCommand = command(3, null, { claim: conditions('synthetic-b') });
    try {
      await begin(a); await begin(b);
      const winner = await repo(a).append(json(winnerCommand), fixture.actor_id); assert.equal(winner.generation, '4');
      await assert.rejects(repo(b).append(json(loserCommand), fixture.actor_id), sqlstate('55P03'));
      await a.query('COMMIT'); await b.query('ROLLBACK');
    } finally { await a.query('ROLLBACK').catch(() => {}); await b.query('ROLLBACK').catch(() => {}); a.release(); b.release(); }
    await assert.rejects(append(loserCommand), reason('generation_conflict')); assert.equal((await totals()).reviews, 4);
    const rollbackCommand = command(4, null, { claim: conditions('synthetic-rollback') }), beforeRollback = await totals();
    await assert.rejects(append(command(4, null, { claim: { ...conditions('synthetic-stale-support'), decision_refs: [first.decision_ref] } })),
      reason('superseded_decision_reference'));
    await assert.rejects(append(command(4, null, { claim: { ...conditions('synthetic-missing-support'),
      decision_refs: [{ decision_id: randomUUID(), decision_sha256: 'a'.repeat(64) }] } })), reason('decision_reference'));
    await transaction(async client => {
      await client.query('CREATE TEMP TABLE native_review_prior_write(marker integer) ON COMMIT DROP');
      await client.query('INSERT INTO native_review_prior_write VALUES(1)');
      await assert.rejects(repo(client).append(json(loserCommand), fixture.actor_id), reason('generation_conflict'));
      assert.equal((await client.query('SELECT marker FROM native_review_prior_write')).rows[0].marker, 1);
      assert.equal((await repo(client).append(json(rollbackCommand), fixture.actor_id)).generation, '5');
    });
    assert.deepEqual(await totals(), beforeRollback);
    assert.equal(await transaction(client => repo(client).getOperation(rollbackCommand.operation_id)), null);
    checks.push('competing real transactions yield one generation; stale loser cannot retry over it; savepoint preserves owner work and outer rollback removes review plus blob');

    await transaction(async client => {
      await client.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,
        '{custom_property_snapshot,improvement,living_area_sqft}',to_jsonb((subject_data#>>'{custom_property_snapshot,improvement,living_area_sqft}')::integer+1)) WHERE id=$1`,
      [fixture.subject_snapshot_id]);
      await assert.rejects(repo(client).append(json(rollbackCommand), fixture.actor_id), reason('stale_subject'));
    });
    await transaction(async client => {
      await client.query('UPDATE app_auth.users SET active=false WHERE id=$1', [fixture.actor_id]);
      await assert.rejects(repo(client).append(json(rollbackCommand), fixture.actor_id), reason('actor_unavailable'));
    });
    for (const status of ['signed', 'archived']) await transaction(async client => {
      await client.query(`UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=CASE WHEN $2='signed' THEN clock_timestamp() ELSE NULL END
        WHERE assignment_file_id=$1`, [fixture.assignment_file_id, status]);
      await assert.rejects(repo(client).append(json(rollbackCommand), fixture.actor_id), /protected_workfile/);
      assert.equal((await repo(client).getOperation(firstCommand.operation_id)).generation, '1', 'historical read does not relabel current material');
    });
    await transaction(client => assert.rejects(repo(client).append(json(rollbackCommand), fixture.actor_id), /read_committed_transaction_required/), false, 'REPEATABLE READ');
    const autocommit = await pool.connect();
    try { await assert.rejects(repo(autocommit).append(json(rollbackCommand), fixture.actor_id), sqlstate('25P01')); }
    finally { autocommit.release(); }
    assert.deepEqual(await totals(), beforeRollback);
    checks.push('actual material change, inactive actor, signed/archive state, REPEATABLE READ and autocommit fail closed without durable review; retained history remains readable');

    await transaction(async client => {
      const foreign = { ...scope, account_id: 'CAPTURE-COORD-OTHER' };
      assert.equal(await createCustomCohortReviewRepository(client, json(foreign)).getOperation(firstCommand.operation_id), null);
      await assert.rejects(createCustomCohortReviewRepository(client, json(foreign)).append(json(firstCommand), fixture.actor_id), /target_not_found/);
      const columns = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'context_id', 'context_revision', 'context_sha256',
        'operation_id', 'generation', 'fact_key_sha256', 'actor_user_id', 'predecessor_operation_id', 'predecessor_content_sha256', 'content_sha256', 'canonical_utf8_bytes'];
      const deniedSql = async (sql, values, code) => {
        await client.query('SAVEPOINT native_review_denial');
        try { await assert.rejects(client.query(sql, values), sqlstate(code)); }
        finally { await client.query('ROLLBACK TO SAVEPOINT native_review_denial'); await client.query('RELEASE SAVEPOINT native_review_denial'); }
      };
      for (const sql of ['UPDATE app.custom_neighborhood_review_commands SET generation=generation WHERE organization_id=$1',
        'DELETE FROM app.custom_neighborhood_review_commands WHERE organization_id=$1']) await deniedSql(sql, [scope.organization_id], '55000');
      await deniedSql('TRUNCATE app.custom_neighborhood_review_commands', [], '55000');
      // Closed test-only SQL projections, not a product field/value interpolator.
      const cloned = async (changes, parameters, code) => {
        assert.ok(Object.keys(changes).every(key => columns.includes(key)));
        const expressions = columns.map(key => changes[key] ?? key);
        await deniedSql(`INSERT INTO app.custom_neighborhood_review_commands (${columns.join(',')}) SELECT ${expressions.join(',')}
          FROM app.custom_neighborhood_review_commands WHERE organization_id=$1 AND operation_id=$2`,
        [scope.organization_id, firstCommand.operation_id, ...parameters], code);
      };
      const fresh = { operation_id: '$3::uuid', generation: '100::bigint' };
      await cloned({ ...fresh, context_sha256: "repeat('f',64)" }, [randomUUID()], '23503');
      await cloned({ ...fresh, account_id: "'CAPTURE-COORD-OTHER'" }, [randomUUID()], '23503');
      await cloned({ ...fresh, organization_id: '$4::uuid' }, [randomUUID(), randomUUID()], '23503');
      await cloned({ ...fresh, actor_user_id: '$4::uuid' }, [randomUUID(), randomUUID()], '23503');
      await cloned({ ...fresh, content_sha256: "repeat('e',64)" }, [randomUUID()], '23503');
      await cloned({ ...fresh, predecessor_operation_id: '$4::uuid', predecessor_content_sha256: '$5' },
        [randomUUID(), other.decision_ref.decision_id, other.decision_ref.decision_sha256], '23503');
      await cloned({ operation_id: '$3::uuid' }, [randomUUID()], '23505');
    });
    checks.push('direct UPDATE/DELETE/TRUNCATE rejected; native exact-context/account/org/actor/blob/predecessor FKs and generation uniqueness enforce storage boundaries');
    assert.deepEqual(await totals(), beforeRollback);

    // Unlike the repository checks above, this is the actual internal owner:
    // workflow + assignment authorization, retention-only policy both before
    // full graph loading and after the append, and outer transaction ownership.
    const ownerCalls = [], observedPool = { async connect() {
      ownerCalls.push({ sql: 'native-owner:connect' });
      const client = await pool.connect();
      return { query(statement, values) {
        ownerCalls.push({ sql: typeof statement === 'string' ? statement : statement.text });
        return client.query(statement, values);
      }, release(error) { client.release(error); } };
    } };
    const grant = { allowed: true, decision_id: 'synthetic_native_review_fixture_only', policy_revision: 'synthetic-review-v1' };
    const policySeen = [];
    const checkedPolicy = async (_client, principal, context, purpose, options) => {
      assert.equal(principal.userId, fixture.actor_id); assert.equal(context.scope.organization_id, scope.organization_id);
      assert.equal(context.target.report_file_id, scope.report_file_id); assert.equal(context.target.workflow_target_id, scope.assignment_file_id);
      assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
      assert.deepEqual(options, { retention: true, exposure: 'none' }); policySeen.push(options.exposure); return grant;
    };
    const reviewer = createCustomCohortContextCapture({ pool: observedPool, authorizeMarketData: checkedPolicy });
    const reviewInput = value => ({ ...target, auth, commandJson: json(value) });
    const ownerCommand = command(4, replacement.decision_ref), beforeOwner = await totals();
    const ownerReceipt = await reviewer.review(reviewInput(ownerCommand));
    assert.deepEqual(Object.keys(ownerReceipt).sort(), ['status', 'reused', 'context_ref', 'decision_ref', 'generation', 'authority'].sort());
    assert.deepEqual(ownerReceipt, { status: 'review_recorded', reused: false, context_ref: captured.context_ref,
      decision_ref: { decision_id: ownerCommand.operation_id, decision_sha256: ownerReceipt.decision_ref.decision_sha256 },
      generation: '5', authority: 'not_established' });
    assert.match(ownerReceipt.decision_ref.decision_sha256, /^[a-f0-9]{64}$/);
    assert.equal(policySeen.length, 2);
    assert.equal(ownerCalls.filter(call => call.sql === 'COMMIT').length, 1);
    const committed = await transaction(client => repo(client).getOperation(ownerCommand.operation_id));
    assert.deepEqual(committed.decision_ref, ownerReceipt.decision_ref); assert.equal(committed.record.actor_user_id, auth.userId);
    assert.equal(committed.record.claim_observation.status, 'matched');
    const afterOwner = await totals();
    assert.deepEqual(afterOwner, { reviews: beforeOwner.reviews + 1, blobs: beforeOwner.blobs + 1 });
    const historical = await reviewer.review(reviewInput(firstCommand));
    assert.deepEqual(historical, { status: 'review_recorded', reused: true, context_ref: captured.context_ref,
      decision_ref: first.decision_ref, generation: '1', authority: 'not_established' });
    assert.deepEqual(await totals(), afterOwner); assert.equal(policySeen.length, 4);
    checks.push('actual owner authorizes retention-only source use, commits one review/blob, returns only opaque receipt and replays original historical generation without a new write');

    const nextOwnerCommand = () => command(5, null, { claim: conditions(`synthetic-owner-${randomUUID()}`) });
    for (const deniedAuth of [
      { userId: fixture.actor_id, organizations: [{ organizationId: scope.organization_id, roles: ['read_only'] }] },
      { userId: randomUUID(), organizations: [{ organizationId: scope.organization_id, roles: ['appraiser'] }] },
      { userId: fixture.actor_id, organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] },
    ]) {
      const baseline = await totals(), callStart = ownerCalls.length, policyStart = policySeen.length;
      await assert.rejects(reviewer.review({ ...reviewInput(nextOwnerCommand()), auth: deniedAuth }), /assignment_access_denied/);
      assert.deepEqual(await totals(), baseline); assert.equal(policySeen.length, policyStart);
      assert.ok(!ownerCalls.slice(callStart).some(call => call.sql.includes('custom-cohort-context:read')),
        'workflow, assignment and organization denial precede retained-context reads');
    }
    const cancelled = new AbortController(); cancelled.abort();
    const cancellationStart = ownerCalls.length, beforeCancellation = await totals();
    await assert.rejects(reviewer.review(reviewInput(nextOwnerCommand()), { signal: cancelled.signal }), /cancelled/);
    assert.equal(ownerCalls.length, cancellationStart, 'already-cancelled owner must not acquire a client');
    assert.deepEqual(await totals(), beforeCancellation);
    checks.push('actual owner rejects read-only workflow, unassigned appraiser and foreign organization before retained reads; pre-aborted signal acquires no client and writes nothing');

    for (const mode of ['initial_denied', 'initial_denied_replay', 'final_revoked', 'final_changed']) {
      const baseline = await totals(), value = mode === 'initial_denied_replay' ? firstCommand : nextOwnerCommand();
      let policyCount = 0, tentativeObserved = false;
      const gated = createCustomCohortContextCapture({ pool: observedPool,
        authorizeMarketData: async (client, principal, context, purpose, options) => {
          await checkedPolicy(client, principal, context, purpose, options); policyCount++;
          if (mode.startsWith('initial_denied')) return { allowed: false };
          if (policyCount === 1) return grant;
          // Prove these rows exist inside the real owner transaction before the
          // final policy refuses; outside counts must then prove full rollback.
          const pending = await client.query(`SELECT r.actor_user_id::text,r.content_sha256,b.content_sha256 AS blob_sha256
            FROM app.custom_neighborhood_review_commands r JOIN app.neighborhood_cohort_evidence_blobs b
              ON b.organization_id=r.organization_id AND b.content_sha256=r.content_sha256
            WHERE r.organization_id=$1 AND r.operation_id=$2`, [scope.organization_id, value.operation_id]);
          assert.equal(pending.rowCount, 1); assert.equal(pending.rows[0].actor_user_id, fixture.actor_id);
          assert.equal(pending.rows[0].content_sha256, pending.rows[0].blob_sha256); tentativeObserved = true;
          return mode === 'final_revoked' ? { allowed: false } : { ...grant, policy_revision: 'synthetic-review-changed-final' };
        } });
      const callStart = ownerCalls.length;
      await assert.rejects(gated.review(reviewInput(value)), mode === 'final_changed' ? /market_policy_changed/ : /market_data_access_denied/);
      assert.equal(policyCount, mode.startsWith('initial_denied') ? 1 : 2);
      assert.equal(tentativeObserved, !mode.startsWith('initial_denied'));
      assert.deepEqual(await totals(), baseline);
      const calls = ownerCalls.slice(callStart);
      assert.equal(calls.some(call => call.sql === 'COMMIT'), false);
      assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
      if (mode.startsWith('initial_denied')) assert.ok(!calls.some(call => call.sql.includes('custom-cohort-subject:history-target')),
        'denied initial source grant must precede full original graph/subject loading, including replay');
      else assert.equal(await transaction(client => repo(client).getOperation(value.operation_id)), null);
    }
    checks.push('initial source denial also gates replay; final revocation or revision change rolls back the real tentative review and canonical blob with no successful COMMIT');
    assert.deepEqual(await totals(), afterOwner); assert.deepEqual(await protectedState(), before);
    assert.equal(pool.waitingCount, 0);
    checks.push('review retention does not change workspace/accepted sections, history, signatures, report or assignment rows');
    return { checks, fixture: { ...scope, context_ref: captured.context_ref },
      limitations: ['synthetic principal and source policy exercise actual internal owner, not authenticated HTTP or production source-rights activation',
        'reviewer command provenance only, not certified facts or Apply', 'signed-state guard only, no signature artifact generated'] };
  } finally {
    try {
      if (restoreStatus) await pool.query(`UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3::timestamptz,
        signed_by=$4,updated_at=$5::timestamptz WHERE assignment_file_id=$1`,
      [fixture.assignment_file_id, fixture.status, fixture.signed_at, fixture.signed_by, fixture.updated_at]);
    } finally { await pool.end(); }
  }
}
