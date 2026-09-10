import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortDecisionEvidenceResolver } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { createCustomCohortReviewRepository, CUSTOM_COHORT_REVIEW_STATE_LIMITS } from '../src/services/neighborhoodAssessment/customCohortReviewRepository.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cohortCommandFixture, cohortUuid } from './fixtures/neighborhoodCohortDecisionCommandFixture.js';

const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });
async function fixture(options) {
  const f = await decisionEvidenceFixture(options), header = prepareCustomCohortContextHeader(f.input.context_header_json);
  await f.store.put(f.input.context_header_json);
  const scope = f.input.expected.target, c = header.context_ref, actor = cohortUuid(800);
  const context = { ...c, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const state = { rows: new Map(), calls: [], explicit: true, actorActive: true, failInsert: false, corruptReturn: false,
    isolation: 'read committed', transactionId: '123456789', transforms: {}, stateTransactions: 0 };
  const baseQuery = f.client.query.bind(f.client);
  let savepoint;
  f.client.query = async (sql, params = []) => {
    state.calls.push(sql);
    if (sql === 'SAVEPOINT custom_cohort_review_append' || sql === 'SAVEPOINT custom_cohort_review_state') {
      if (!state.explicit) throw new Error('SAVEPOINT can only be used in transaction blocks');
      savepoint = { rows: new Map(state.rows), blobs: new Map(f.f.state.db) }; return row();
    }
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
      if (state.failRollback) throw new Error('synthetic_rollback_failed');
      state.rows = savepoint.rows; f.f.state.db = savepoint.blobs; return row();
    }
    if (sql.startsWith('RELEASE SAVEPOINT')) return row();
    const contextTag = sql.match(/custom-cohort-context:([a-z-]+)/)?.[1];
    if (contextTag === 'transaction') return row({ transaction_id: '123456789' });
    if (contextTag === 'target') return row(params[0] === scope.organization_id && params[1] === scope.report_file_id
      && params[2] === scope.assignment_file_id && params[3] === scope.account_id ? { id: scope.report_file_id } : null);
    if (contextTag === 'read') return row(params[4] === c.context_id ? context : null);
    const tag = sql.match(/custom-cohort-review:([a-z-]+)/)?.[1];
    if (!tag) return baseQuery(sql, params);
    if (tag.startsWith('state-')) {
      const scoped = [...state.rows.values()].filter(value =>
        ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'context_id', 'context_revision', 'context_sha256']
          .every((key, index) => value[key] === params[index]));
      scoped.sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1);
      const byFact = new Map();
      for (const value of scoped) if (!byFact.has(value.fact_key_sha256)) byFact.set(value.fact_key_sha256, value);
      const heads = [...byFact.values()];
      let result;
      if (tag === 'state-transaction') {
        state.stateTransactions++;
        result = row({ isolation: state.isolation, transaction_id: state.transactionId });
      }
      if (tag === 'state-context-lock') {
        if (state.lockError) throw state.lockError;
        const match = [scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id,
          c.context_id, c.context_revision, c.context_sha256].every((value, index) => value === params[index]);
        result = row(match ? { ...scope, ...c } : null);
      }
      if (tag === 'state-summary') result = row({ head_count: String(heads.length),
        record_utf8_bytes: String(heads.reduce((sum, value) => sum + Number(value.canonical_utf8_bytes), 0)),
        generation: scoped[0]?.generation ?? '0' });
      if (tag === 'state-heads') result = { rows: structuredClone(heads.slice(0, params[7])), rowCount: Math.min(heads.length, params[7]) };
      if (tag === 'state-blobs') {
        const requested = JSON.parse(params[1]);
        const values = requested.map(ref => {
          const stored = f.f.state.db.get(`${params[0]}:${ref.content_sha256}`);
          return { content_sha256: ref.content_sha256, canonical_utf8_bytes: String(ref.canonical_utf8_bytes),
            canonical_utf8: stored && stored.canonical_utf8_bytes === String(ref.canonical_utf8_bytes)
              && Buffer.byteLength(stored.canonical_utf8) === ref.canonical_utf8_bytes ? stored.canonical_utf8 : null };
        });
        result = { rows: values, rowCount: values.length };
      }
      assert.ok(result, tag);
      return state.transforms[tag] ? state.transforms[tag](structuredClone(result), params) : result;
    }
    const ordered = [...state.rows.values()].filter(value => value.organization_id === params[0] && value.context_id === params[1])
      .sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1);
    if (tag === 'actor') return row(state.actorActive ? { id: params[0] } : null);
    if (tag === 'context-lock') return row({ context_id: params[4] });
    if (tag === 'head') return row(ordered[0] ? { generation: ordered[0].generation } : null);
    if (tag === 'fact') {
      const found = ordered.find(value => value.fact_key_sha256 === params[2]);
      return row(found ? { operation_id: found.operation_id, content_sha256: found.content_sha256, generation: found.generation } : null);
    }
    if (tag === 'operation') return row(state.rows.get(`${params[0]}:${params[1]}`));
    if (tag === 'insert') {
      if (state.failInsert) throw new Error('synthetic_insert_failure');
      const keys = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'context_id', 'context_revision', 'context_sha256',
        'operation_id', 'generation', 'fact_key_sha256', 'actor_user_id', 'predecessor_operation_id', 'predecessor_content_sha256',
        'content_sha256', 'canonical_utf8_bytes'];
      const stored = Object.fromEntries(keys.map((key, index) => [key, params[index]]));
      state.rows.set(`${params[0]}:${stored.operation_id}`, stored);
      return row(state.corruptReturn ? { ...stored, actor_user_id: cohortUuid(801) } : stored);
    }
    assert.fail(tag);
  };
  const resolver = createCustomCohortDecisionEvidenceResolver(f.input);
  function command(kind = 'closing_date', op = 1) {
    const value = cohortCommandFixture(kind), evidence = resolver.deriveEvidenceRef(f.sourceRef, f.recordId);
    Object.assign(value, { operation_id: cohortUuid(op), target_ref: resolver.binding.target_ref,
      expected_context: resolver.binding.context_ref, study_ref: resolver.binding.study_ref,
      expected_generation: '0', expected_predecessor: null, subject_ref: { kind: 'capture_candidate', key: f.recordId }, evidence_refs: [evidence] });
    if (kind === 'closing_date') value.claim.value = { date: '2024-03-01', event_evidence_refs: [evidence] };
    if (kind === 'sale_completion') value.claim.value = { completed: true, event_evidence_refs: [evidence] };
    return value;
  }
  return { ...f, state, actor, command, repo: createCustomCohortReviewRepository(f.client, f.scopeJson) };
}

test('retains an exact bound reviewer command, reopens it and leaves authority unestablished', async () => {
  const f = await fixture(), command = f.command(), result = await f.repo.append(json(command), f.actor);
  assert.equal(result.status, 'stored'); assert.equal(result.generation, '1');
  assert.equal(result.authority, 'not_established'); assert.equal(result.record.purpose, 'retained_reviewer_command');
  assert.equal(result.durability, 'caller_transaction'); assert.equal(result.decision_ref.decision_id, command.operation_id);
  assert.deepEqual((await f.repo.getOperation(command.operation_id)).record, result.record);
  const replay = await f.repo.append(json(command), f.actor);
  assert.equal(replay.status, 'reused'); assert.deepEqual(replay.decision_ref, result.decision_ref); assert.equal(f.state.rows.size, 1);
  const contextLock = f.state.calls.findIndex(sql => sql.includes('custom-cohort-review:context-lock'));
  assert.ok(contextLock >= 0 && f.state.calls.findIndex(sql => sql.includes('custom-cohort-review:head')) > contextLock);
  assert.equal(f.state.calls.some(sql => /INSERT INTO app\.(?:custom_appraisal_workfile|custom_neighborhood_acceptances)/.test(sql)), false);
});

test('context generation and same-fact predecessor are independent; old exact operation remains replayable', async () => {
  const f = await fixture(), first = f.command(), a = await f.repo.append(json(first), f.actor);
  const other = f.command('sale_completion', 2); other.expected_generation = '1';
  const b = await f.repo.append(json(other), f.actor); assert.equal(b.generation, '2');
  const replacement = f.command('closing_date', 3);
  replacement.expected_generation = '2'; replacement.expected_predecessor = a.decision_ref;
  const c = await f.repo.append(json(replacement), f.actor); assert.equal(c.generation, '3');
  assert.equal((await f.repo.append(json(first), f.actor)).status, 'reused');
  assert.equal(f.state.rows.size, 3);
});

for (const scenario of ['stale-generation', 'missing-predecessor', 'wrong-fact-predecessor', 'changed-actor', 'changed-command']) {
  test(`rejects ${scenario} without another review or blob`, async () => {
    const f = await fixture(), first = f.command(), saved = await f.repo.append(json(first), f.actor);
    const next = f.command('closing_date', 2); next.expected_generation = '1'; next.expected_predecessor = saved.decision_ref;
    let actor = f.actor, expected = /predecessor_conflict/;
    if (scenario === 'stale-generation') { next.expected_generation = '0'; expected = /generation_conflict/; }
    if (scenario === 'missing-predecessor') next.expected_predecessor = null;
    if (scenario === 'wrong-fact-predecessor') Object.assign(next, f.command('sale_completion', 2), { expected_generation: '1', expected_predecessor: saved.decision_ref });
    if (scenario === 'changed-actor') { Object.assign(next, first); actor = cohortUuid(801); expected = /operation_conflict/; }
    if (scenario === 'changed-command') { Object.assign(next, first); next.rationale = 'Different review'; expected = /operation_conflict/; }
    const count = f.f.state.db.size;
    await assert.rejects(f.repo.append(json(next), actor), expected);
    assert.equal(f.state.rows.size, 1); assert.equal(f.f.state.db.size, count);
  });
}

for (const scenario of ['insert-error', 'corrupt-insert', 'inactive-actor', 'protected-file', 'autocommit', 'generation-overflow']) {
  test(`fails safely on ${scenario}`, async () => {
    const f = await fixture(), command = f.command(), count = f.f.state.db.size;
    if (scenario === 'insert-error') f.state.failInsert = true;
    if (scenario === 'corrupt-insert') f.state.corruptReturn = true;
    if (scenario === 'inactive-actor') f.state.actorActive = false;
    if (scenario === 'protected-file') f.f.state.status = 'signed';
    if (scenario === 'autocommit') f.state.explicit = false;
    if (scenario === 'generation-overflow') command.expected_generation = '9223372036854775807';
    await assert.rejects(f.repo.append(json(command), f.actor));
    assert.equal(f.state.rows.size, 0); assert.equal(f.f.state.db.size, count);
  });
}

test('same-organization operation cannot move to another target; exact read does not disclose sibling file', async () => {
  const f = await fixture(), command = f.command(); await f.repo.append(json(command), f.actor);
  const key = `${f.input.expected.target.organization_id}:${command.operation_id}`;
  f.state.rows.get(key).report_file_id = cohortUuid(999);
  assert.equal(await f.repo.getOperation(command.operation_id), null);
  await assert.rejects(f.repo.append(json(command), f.actor), /operation_conflict/);
});

test('supporting review references must be exact, earlier and unsuperseded in this context', async () => {
  const f = await fixture(), first = f.command(), a = await f.repo.append(json(first), f.actor);
  const supported = f.command('sale_completion', 2); supported.expected_generation = '1';
  supported.claim.decision_refs = [a.decision_ref];
  const b = await f.repo.append(json(supported), f.actor);
  assert.equal(b.generation, '2');
  const replace = f.command('closing_date', 3); replace.expected_generation = '2'; replace.expected_predecessor = a.decision_ref;
  const c = await f.repo.append(json(replace), f.actor);
  const next = f.command('sale_completion', 4); next.expected_generation = '3'; next.expected_predecessor = b.decision_ref;
  next.claim.decision_refs = [a.decision_ref];
  await assert.rejects(f.repo.append(json(next), f.actor), /superseded_decision_reference/);
  next.claim.decision_refs = [{ ...c.decision_ref, decision_sha256: 'f'.repeat(64) }];
  await assert.rejects(f.repo.append(json(next), f.actor), /decision_reference/);
  next.claim.decision_refs = [c.decision_ref];
  assert.equal((await f.repo.append(json(next), f.actor)).generation, '4');
});

test('changed retained evidence does not bind and stale material does not append', async () => {
  const f = await fixture(), command = structuredClone(f.command());
  command.evidence_refs[0].record_content_sha256 = 'f'.repeat(64);
  command.claim.value.event_evidence_refs = command.evidence_refs;
  await assert.rejects(f.repo.append(json(command), f.actor), /evidence_reference_mismatch/);
  const original = f.command(); f.f.state.input.snapshot.effective_date = '2026-09-05';
  await assert.rejects(f.repo.append(json(original), f.actor), /effective_date_unresolved|stale_subject/);
  assert.equal(f.state.rows.size, 0);
});

test('altered typed ledger index cannot be silently trusted on reopen', async () => {
  const f = await fixture(), command = f.command(); await f.repo.append(json(command), f.actor);
  const key = `${f.input.expected.target.organization_id}:${command.operation_id}`;
  f.state.rows.get(key).generation = '100';
  await assert.rejects(f.repo.getOperation(command.operation_id), /stored_record_mismatch/);
});

test('conflicting date review is retained as a reviewer assertion, not promoted to a verified sale', async () => {
  const f = await fixture({ saleOverrides: { source_close_date: '2024-04-01' } });
  const result = await f.repo.append(json(f.command()), f.actor);
  assert.equal(result.record.claim_observation.status, 'conflicting_evidence');
  assert.equal(result.record.authority, 'not_established');
  assert.equal(Object.hasOwn(result.record, 'market_eligible'), false);
  assert.equal(Object.hasOwn(result.record, 'assessment'), false);
});

test('raw original command and authenticated actor are separate, bounded inputs', async () => {
  const f = await fixture(), command = f.command();
  for (const value of [command, null, '{"version":1,"version":1}', json({ ...command, actor_user_id: f.actor })]) {
    await assert.rejects(f.repo.append(value, f.actor), /custom_cohort_review_command/);
  }
  for (const actor of ['Reviewer Name', undefined, { userId: f.actor }]) await assert.rejects(f.repo.append(json(command), actor), /identity/);
  assert.equal(f.state.calls.length, 0);
});

test('migration is append-only, registered and pins context, actor, blob and same-fact predecessor', () => {
  const sql = readFileSync(new URL('../migrations/20261014_custom_neighborhood_review_commands.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.match(runner, /20261014_custom_neighborhood_review_commands\.sql/);
  assert.match(sql, /PRIMARY KEY \(organization_id, operation_id\)/);
  assert.match(sql, /UNIQUE \(organization_id, context_id, generation\)/);
  assert.match(sql, /REFERENCES app_auth\.users\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /FOREIGN KEY \(organization_id, report_file_id, assignment_file_id, account_id, context_id, context_revision, context_sha256\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, context_id, fact_key_sha256, predecessor_operation_id, predecessor_content_sha256\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.doesNotMatch(sql, /CREATE POLICY|GRANT |ALTER TABLE .*app_auth|DROP TABLE/);
});

const current = (f, generation) => f.repo.getCurrent(json(f.input.expected.context_ref), generation);
const stateCalls = f => f.state.calls.filter(sql => sql.includes('custom-cohort-review:state-'));
const stateBlobCalls = f => f.state.calls.filter(sql => sql.includes('custom-cohort-review:state-blobs'));

test('exact generation zero returns a complete empty reviewer state without creating any rows', async () => {
  const f = await fixture(), before = f.f.state.db.size;
  const result = await current(f, '0');
  assert.equal(result.review_state_version, 1); assert.equal(result.status, 'current');
  assert.equal(result.authority, 'not_established'); assert.equal(result.durability, 'caller_transaction');
  assert.deepEqual(result.binding, { target: f.input.expected.target, context_ref: f.input.expected.context_ref, generation: '0' });
  assert.equal(result.head_count, 0); assert.deepEqual(result.heads, []);
  assert.equal(result.state_sha256, assessmentEvidenceDigest({ binding: result.binding, domain: 'custom-cohort-review-state-v1', heads: [] }));
  assert.equal(stateBlobCalls(f).length, 0); assert.equal(f.state.rows.size, 0); assert.equal(f.f.state.db.size, before);
  const calls = stateCalls(f);
  assert.match(calls[0], /state-transaction/); assert.match(calls[1], /FOR SHARE NOWAIT/);
  assert.match(calls[2], /state-summary/); assert.match(calls[3], /state-heads/);
  assert.equal(f.state.calls.at(-1), 'RELEASE SAVEPOINT custom_cohort_review_state');
  assert.ok(!f.state.calls.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK$)|\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/.test(sql)));
});

test('current heads preserve an explicit unknown correction, unrelated facts and original diagnostics', async () => {
  const f = await fixture(), first = await f.repo.append(json(f.command()), f.actor);
  const other = f.command('sale_completion', 2); other.expected_generation = '1';
  const second = await f.repo.append(json(other), f.actor);
  const correction = f.command('closing_date', 3);
  correction.expected_generation = '2'; correction.expected_predecessor = first.decision_ref;
  correction.claim = { ...correction.claim, state: 'unknown', value: null, unknown_reason: 'conflicting_evidence' };
  const third = await f.repo.append(json(correction), f.actor);
  f.state.calls = []; const output = await current(f, '3');
  assert.equal(output.head_count, 2);
  assert.deepEqual(new Set(output.heads.map(head => head.decision_ref.decision_id)), new Set([second.decision_ref.decision_id, third.decision_ref.decision_id]));
  const unknown = output.heads.find(head => head.record.command.claim.kind === 'closing_date');
  assert.equal(unknown.record.command.claim.state, 'unknown'); assert.equal(unknown.record.command.claim.value, null);
  assert.deepEqual(unknown.record.claim_observation, third.record.claim_observation);
  assert.deepEqual(output.heads.map(head => head.fact_key_sha256), output.heads.map(head => head.fact_key_sha256).sort());
  const identities = output.heads.map(({ fact_key_sha256, decision_ref, generation }) => ({ fact_key_sha256, decision_ref, generation }));
  assert.equal(output.state_sha256, assessmentEvidenceDigest({ binding: output.binding, domain: 'custom-cohort-review-state-v1', heads: identities }));
  assert.equal(stateBlobCalls(f).length, 1);
  assert.equal(f.state.calls.filter(sql => sql.includes('custom-cohort-context:read')).length, 1, 'one header verification, not per-head');
  assert.ok(!f.state.calls.some(sql => /neighborhood-(cache|membership|closure):|custom-cohort-subject:/.test(sql)), 'no live source or material reread');
  assert.ok(Object.isFrozen(output) && Object.isFrozen(output.heads) && Object.isFrozen(unknown.record.command.claim));
  f.state.transforms['state-heads'] = result => ({ ...result, rows: result.rows.reverse() });
  f.state.transforms['state-blobs'] = result => ({ ...result, rows: result.rows.reverse() });
  assert.deepEqual(await current(f, '3'), output, 'database order cannot change the state digest/result');
});

test('a current command may retain references to subsequently superseded history without factual promotion', async () => {
  const f = await fixture(), first = await f.repo.append(json(f.command()), f.actor);
  const other = f.command('sale_completion', 2); other.expected_generation = '1'; other.claim.decision_refs = [first.decision_ref];
  await f.repo.append(json(other), f.actor);
  const replace = f.command('closing_date', 3); replace.expected_generation = '2'; replace.expected_predecessor = first.decision_ref;
  await f.repo.append(json(replace), f.actor);
  const output = await current(f, '3'), head = output.heads.find(value => value.record.command.claim.kind === 'sale_completion');
  assert.deepEqual(head.record.command.claim.decision_refs, [first.decision_ref]);
  assert.equal(head.record.authority, 'not_established'); assert.equal(Object.hasOwn(output, 'supported_facts'), false);
});

for (const value of [undefined, null, 0, 1, '', '00', '01', '-1', '1.0', ' 1', '9223372036854775808', '1'.repeat(200)]) {
  test(`current-state invalid generation ${String(value).slice(0, 25)} never queries storage`, async () => {
    const f = await fixture();
    await assert.rejects(current(f, value), /state_input/); assert.equal(f.state.calls.length, 0);
  });
}

test('current-state context accepts only exact canonical primitive JSON, never objects/duplicates/extra fields', async () => {
  const f = await fixture(), ref = f.input.expected.context_ref;
  for (const value of [ref, null, '{}', '{', ` ${json(ref)}`, json({ ...ref, allowed: true }),
    `{"context_id":"${ref.context_id}","context_id":"${ref.context_id}"}`, 'x'.repeat(2049)]) {
    await assert.rejects(f.repo.getCurrent(value, '0'));
  }
  assert.equal(f.state.calls.length, 0);
});

for (const generation of ['0', '2', '9223372036854775807']) {
  test(`current-state expected generation ${generation} cannot read generation one`, async () => {
    const f = await fixture(); await f.repo.append(json(f.command()), f.actor); f.state.calls = [];
    await assert.rejects(current(f, generation), /generation_conflict/);
    assert.equal(stateBlobCalls(f).length, 0);
    assert.ok(!f.state.calls.some(sql => sql.includes('neighborhood-cohort-blob:read')));
  });
}

for (const scenario of ['autocommit', 'repeatable-read', 'serializable', 'transaction-changed', 'lock-contention']) {
  test(`current-state ${scenario} fails without releasing or committing the caller connection`, async () => {
    const f = await fixture();
    if (scenario === 'autocommit') f.state.explicit = false;
    if (scenario === 'repeatable-read') f.state.isolation = 'repeatable read';
    if (scenario === 'serializable') f.state.isolation = 'serializable';
    if (scenario === 'transaction-changed') f.state.transforms['state-transaction'] = result => {
      if (f.state.stateTransactions > 1) result.rows[0].transaction_id = '123456790'; return result;
    };
    if (scenario === 'lock-contention') f.state.lockError = Object.assign(new Error('lock not available'), { code: '55P03' });
    await assert.rejects(current(f, '0'), error => scenario === 'lock-contention' ? error.code === '55P03'
      : /SAVEPOINT|caller_transaction_required/.test(error.message));
    assert.ok(!f.state.calls.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK$)/.test(sql)));
    if (scenario !== 'transaction-changed') assert.equal(stateBlobCalls(f).length, 0);
  });
}

test('exact scope/context lock has no newest-context or sibling-file fallback', async () => {
  const f = await fixture(), reference = { ...f.input.expected.context_ref, context_id: cohortUuid(999) };
  await assert.rejects(f.repo.getCurrent(json(reference), '0'), /missing_context/);
  const other = createCustomCohortReviewRepository(f.client, json({ ...f.input.expected.target, account_id: 'other' }));
  await assert.rejects(other.getCurrent(json(f.input.expected.context_ref), '0'), /missing_context/);
  assert.equal(stateBlobCalls(f).length, 0);
});

for (const scenario of ['count', 'aggregate-bytes', 'record-bytes', 'missing-head', 'duplicate-head', 'wrong-generation',
  'wrong-context', 'wrong-target', 'wrong-fact', 'predecessor-pair']) {
  test(`current-state ${scenario} metadata fails before original record payload loading`, async () => {
    const f = await fixture(); await f.repo.append(json(f.command()), f.actor); f.state.calls = [];
    if (scenario === 'count') f.state.transforms['state-summary'] = result => { result.rows[0].head_count = '5001'; return result; };
    if (scenario === 'aggregate-bytes') f.state.transforms['state-summary'] = result => {
      result.rows[0].record_utf8_bytes = String(CUSTOM_COHORT_REVIEW_STATE_LIMITS.aggregate_record_utf8_bytes + 1); return result;
    };
    if (scenario === 'record-bytes') {
      f.state.transforms['state-summary'] = result => { result.rows[0].record_utf8_bytes = '128001'; return result; };
      f.state.transforms['state-heads'] = result => { result.rows[0].canonical_utf8_bytes = '128001'; return result; };
    }
    if (scenario === 'missing-head') f.state.transforms['state-heads'] = () => ({ rowCount: 0, rows: [] });
    if (scenario === 'duplicate-head') f.state.transforms['state-heads'] = result => ({ rowCount: 2, rows: [result.rows[0], result.rows[0]] });
    if (scenario === 'wrong-generation') f.state.transforms['state-heads'] = result => { result.rows[0].generation = '2'; return result; };
    if (scenario === 'wrong-context') f.state.transforms['state-heads'] = result => { result.rows[0].context_sha256 = 'f'.repeat(64); return result; };
    if (scenario === 'wrong-target') f.state.transforms['state-heads'] = result => { result.rows[0].assignment_file_id = '10'; return result; };
    if (scenario === 'wrong-fact') f.state.transforms['state-heads'] = result => { result.rows[0].fact_key_sha256 = 'invalid'; return result; };
    if (scenario === 'predecessor-pair') f.state.transforms['state-heads'] = result => { result.rows[0].predecessor_content_sha256 = 'f'.repeat(64); return result; };
    await assert.rejects(current(f, '1'));
    assert.equal(stateBlobCalls(f).length, 0);
    assert.ok(!f.state.calls.some(sql => sql.includes('neighborhood-cohort-blob:read')));
  });
}

for (const scenario of ['missing', 'wrong-hash', 'wrong-length', 'changed-byte', 'extra-row', 'wrong-actor', 'wrong-fact', 'wrong-study']) {
  test(`current-state original envelope ${scenario} is rejected without partial output`, async () => {
    const f = await fixture(), saved = await f.repo.append(json(f.command()), f.actor); f.state.calls = [];
    if (['wrong-actor', 'wrong-fact', 'wrong-study'].includes(scenario)) {
      if (scenario === 'wrong-actor') f.state.transforms['state-heads'] = result => { result.rows[0].actor_user_id = cohortUuid(999); return result; };
      if (scenario === 'wrong-fact') f.state.transforms['state-heads'] = result => { result.rows[0].fact_key_sha256 = 'f'.repeat(64); return result; };
      if (scenario === 'wrong-study') {
        const body = structuredClone(saved.record); body.command.study_ref.definition_sha256 = 'f'.repeat(64);
        const reference = await f.store.put(json(body));
        const indexed = [...f.state.rows.values()][0]; Object.assign(indexed, reference);
      }
    } else f.state.transforms['state-blobs'] = result => {
      const blob = result.rows[0];
      if (scenario === 'missing') blob.canonical_utf8 = null;
      if (scenario === 'wrong-hash') blob.content_sha256 = 'f'.repeat(64);
      if (scenario === 'wrong-length') blob.canonical_utf8_bytes = '1';
      if (scenario === 'changed-byte') blob.canonical_utf8 = blob.canonical_utf8.replace('retained_reviewer_command', 'retained_reviewer_commanD');
      if (scenario === 'extra-row') { result.rows.push(blob); result.rowCount++; }
      return result;
    };
    await assert.rejects(current(f, '1'), /stored_record_mismatch|missing_record/);
    assert.equal(f.state.calls.at(-2), 'ROLLBACK TO SAVEPOINT custom_cohort_review_state');
  });
}

test('failed read preserves caller prior writes and surfaces failed savepoint cleanup', async () => {
  const f = await fixture(), saved = await f.repo.append(json(f.command()), f.actor);
  const before = new Map(f.f.state.db);
  await assert.rejects(current(f, '0'), /generation_conflict/);
  assert.deepEqual(f.f.state.db, before); assert.equal(f.state.rows.size, 1);
  assert.deepEqual((await f.repo.getOperation(saved.decision_ref.decision_id)).decision_ref, saved.decision_ref);
  f.state.failRollback = true;
  await assert.rejects(current(f, '0'), error => error instanceof AggregateError
    && error.message === 'custom_cohort_review_state_rollback_failed' && error.errors.length === 2);
});

test('SQL record batch bounds both declared and actual bytes and never transfers a mismatched blob', async () => {
  const f = await fixture(); await f.repo.append(json(f.command()), f.actor); await current(f, '1');
  const sql = stateBlobCalls(f)[0];
  assert.match(sql, /b\.canonical_utf8_bytes=requested\.canonical_utf8_bytes/);
  assert.match(sql, /octet_length\(b\.canonical_utf8\)=requested\.canonical_utf8_bytes/);
  assert.match(sql, /THEN b\.canonical_utf8 ELSE NULL END/);
  assert.match(sql, /b\.organization_id=\$1 AND b\.content_sha256=requested\.content_sha256/);
});

// Capacity-only synthetic ledger index. Each original envelope still passes
// the real blob encoder/storage and readback admission. This does not claim
// 5000 appends, source verification, native locking, or reviewer fact authority.
async function syntheticHead(f, index) {
  const command = f.command('closing_date', 10000 + index);
  command.expected_generation = String(index - 1);
  command.claim = { kind: 'material_condition', qualifier: { basis: 'condition', condition_code: `synthetic:${index}` },
    state: 'unknown', value: null, unknown_reason: 'missing_evidence', decision_refs: [] };
  const fact = assessmentEvidenceDigest({ domain: 'custom-cohort-review-fact-slot-v1',
    subject_ref: command.subject_ref, kind: command.claim.kind, qualifier: command.claim.qualifier });
  const body = { review_record_version: 1, purpose: 'retained_reviewer_command', authority: 'not_established',
    actor_user_id: f.actor, generation: String(index), fact_key_sha256: fact, command,
    claim_observation: { status: 'not_evaluated', reason: 'claim_meaning_resolver_unavailable' } };
  const reference = await f.store.put(json(body));
  const ref = f.input.expected.context_ref;
  const indexed = { ...f.input.expected.target, ...ref, operation_id: command.operation_id, generation: String(index),
    fact_key_sha256: fact, actor_user_id: f.actor, predecessor_operation_id: null, predecessor_content_sha256: null, ...reference };
  f.state.rows.set(`${indexed.organization_id}:${indexed.operation_id}`, indexed);
}

test('5000 complete heads use one admitted blob batch and streamed identity digest; 5001 never returns a prefix', async () => {
  const f = await fixture();
  for (let index = 1; index <= 5000; index++) await syntheticHead(f, index);
  f.state.calls = [];
  const output = await current(f, '5000');
  assert.equal(output.head_count, 5000); assert.equal(output.heads.length, 5000);
  assert.equal(new Set(output.heads.map(value => value.decision_ref.decision_id)).size, 5000);
  assert.ok(output.heads.every(value => value.record.command.claim.state === 'unknown'));
  const bytes = Buffer.byteLength(JSON.stringify(output));
  assert.ok(bytes > 1_500_000, 'large full states must not use the small-document canonicalizer');
  assert.ok(bytes <= CUSTOM_COHORT_REVIEW_STATE_LIMITS.output_utf8_bytes);
  assert.equal(stateBlobCalls(f).length, 1);
  assert.equal(f.state.calls.filter(sql => sql.includes('custom-cohort-context:read')).length, 1);
  const identity = { binding: output.binding, domain: 'custom-cohort-review-state-v1',
    heads: output.heads.map(head => ({ decision_ref: head.decision_ref, fact_key_sha256: head.fact_key_sha256, generation: head.generation })) };
  // Independent canonical serializer for this identity-only fixture; preserve
  // the production global canonicalizer's unchanged resource ceilings.
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  assert.equal(output.state_sha256, createHash('sha256').update(canonical(identity)).digest('hex'));
  await syntheticHead(f, 5001); f.state.calls = [];
  await assert.rejects(current(f, '5001'), /state_limit/);
  assert.equal(stateBlobCalls(f).length, 0);
  assert.ok(!f.state.calls.some(sql => sql.includes('neighborhood-cohort-blob:read')));
});

test('all admitted original bytes are metered before loading records, independently of the head cap', async () => {
  const f = await fixture(); await syntheticHead(f, 1);
  const declared = CUSTOM_COHORT_REVIEW_STATE_LIMITS.aggregate_record_utf8_bytes;
  f.state.transforms['state-summary'] = result => { result.rows[0].record_utf8_bytes = String(declared); return result; };
  await assert.rejects(current(f, '1'), /stored_record_mismatch/, 'exact aggregate bound is admitted but must equal complete metadata');
  assert.equal(stateBlobCalls(f).length, 0);
  f.state.transforms['state-summary'] = result => { result.rows[0].record_utf8_bytes = String(declared + 1); return result; };
  await assert.rejects(current(f, '1'), /state_limit/);
  assert.equal(stateBlobCalls(f).length, 0);
});

test('head/fact/current SQL orders the numeric column, not the text generation output alias', async () => {
  const f = await fixture();
  let previous = null;
  for (let generation = 1; generation <= 11; generation++) {
    const command = f.command('closing_date', generation);
    command.expected_generation = String(generation - 1); command.expected_predecessor = previous?.decision_ref ?? null;
    previous = await f.repo.append(json(command), f.actor);
  }
  const result = await current(f, '11'); assert.equal(result.head_count, 1);
  assert.equal(result.heads[0].generation, '11'); assert.deepEqual(result.heads[0].decision_ref, previous.decision_ref);
  for (const tag of ['head', 'fact', 'state-heads']) {
    const queries = f.state.calls.filter(sql => sql.includes(`custom-cohort-review:${tag} */`));
    assert.ok(queries.length > 0);
    for (const sql of queries) {
      assert.match(sql, /FROM app\.custom_neighborhood_review_commands reviews/);
      assert.match(sql, /ORDER BY (?:reviews\.fact_key_sha256,)?reviews\.generation DESC/);
    }
  }
  // Query fixtures use BigInt; native tests separately prove actual PostgreSQL
  // alias resolution and progression across generations 9, 10 and 11.
});
