import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortDecisionEvidenceResolver } from '../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { createCustomCohortReviewRepository } from '../src/services/neighborhoodAssessment/customCohortReviewRepository.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cohortCommandFixture, cohortUuid } from './fixtures/neighborhoodCohortDecisionCommandFixture.js';

const row = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });
async function fixture(options) {
  const f = await decisionEvidenceFixture(options), header = prepareCustomCohortContextHeader(f.input.context_header_json);
  await f.store.put(f.input.context_header_json);
  const scope = f.input.expected.target, c = header.context_ref, actor = cohortUuid(800);
  const context = { ...c, header_content_sha256: header.header_blob.ref.content_sha256,
    header_canonical_utf8_bytes: header.header_blob.ref.canonical_utf8_bytes };
  const state = { rows: new Map(), calls: [], explicit: true, actorActive: true, failInsert: false, corruptReturn: false };
  const baseQuery = f.client.query.bind(f.client);
  let savepoint;
  f.client.query = async (sql, params = []) => {
    state.calls.push(sql);
    if (sql === 'SAVEPOINT custom_cohort_review_append') {
      if (!state.explicit) throw new Error('SAVEPOINT can only be used in transaction blocks');
      savepoint = { rows: new Map(state.rows), blobs: new Map(f.f.state.db) }; return row();
    }
    if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
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
