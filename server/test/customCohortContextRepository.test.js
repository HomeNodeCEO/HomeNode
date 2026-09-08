import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextHeader as prepare } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortContextRepository as repository } from '../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

function fixture() {
  const body = contextFixture(), target = body.target, calls = [], data = new Map(), contexts = new Map();
  const scope = { organization_id: target.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.workflow_target_id, account_id: target.account_id };
  const result = row => ({ rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] });
  const storeBlob = text => { const ref = blob(text); data.set(ref.content_sha256, { ...ref, canonical_utf8: text }); return ref; };
  storeBlob('{"synthetic":true}');
  const state = { transaction: '88', targetPresent: true, fail: null };
  const client = { release() { throw new Error('repository must not release caller client'); }, async query(sql, args = []) {
    const tag = /\/\* ([^*]+) \*\//.exec(sql)?.[1]; calls.push({ tag, sql, args });
    if (state.fail) throw state.fail;
    if (tag === 'custom-cohort-context:transaction') return result({ transaction_id: state.transaction });
    if (tag === 'custom-cohort-context:target') {
      assert.deepEqual(args, Object.values(scope)); return result(state.targetPresent ? { id: target.report_file_id } : null);
    }
    if (tag?.startsWith('neighborhood-cohort-blob:')) {
      assert.equal(args[0], target.organization_id);
      if (tag.endsWith(':read')) return result(data.get(args[1]));
      if (tag.endsWith(':insert')) { if (data.has(args[1])) return result(null); return result(data.get(storeBlob(args[3]).content_sha256)); }
    }
    if (tag === 'custom-cohort-context:read') { assert.deepEqual(args.slice(0, 4), Object.values(scope)); return result(contexts.get(args[4])); }
    if (tag === 'custom-cohort-context:insert') {
      assert.deepEqual(args.slice(0, 4), Object.values(scope));
      if (contexts.has(args[4])) return result(null);
      const row = { context_id: args[4], context_revision: '1', context_sha256: args[5], header_content_sha256: args[6], header_canonical_utf8_bytes: args[7] };
      contexts.set(args[4], row); return result(row);
    }
    throw new Error(`Unexpected query: ${tag}`);
  } };
  return { body, scope, calls, data, contexts, state, client, repo: repository(client, json(scope)) };
}
test('retains exact header, replays without mutation and reloads all original dependency blobs', async () => {
  const f = fixture(), text = json(f.body), prepared = prepare(text);
  assert.deepEqual(await f.repo.put(text), { status: 'stored', authority: 'not_established', context_ref: prepared.context_ref });
  assert.deepEqual(await f.repo.put(text), { status: 'reused', authority: 'not_established', context_ref: prepared.context_ref });
  assert.deepEqual(await f.repo.get(json(prepared.context_ref)), prepared);
  assert.equal(f.contexts.size, 1); assert.equal(f.data.size, 2);
  assert.ok(f.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE|CREATE|FOR UPDATE)\b/.test(call.sql)));
  assert.ok(f.calls.filter(call => call.tag === 'custom-cohort-context:read').every(call => call.sql.includes('report_file_id=$2')));
});
test('invalid or mismatched submitted target causes no SQL calls', async () => {
  const f = fixture(); f.body.target.account_id = 'another';
  await assert.rejects(f.repo.put(json(f.body)), /target_mismatch/); assert.equal(f.calls.length, 0);
  await assert.rejects(f.repo.put('{}'), /invalid_shape/); assert.equal(f.calls.length, 0);
  assert.throws(() => repository({ query() {} }, json(f.scope)), /caller_client_required/);
});
test('missing scoped target and missing dependencies cannot insert a context or header', async () => {
  for (const missing of ['target', 'dependency']) {
    const f = fixture(); if (missing === 'target') f.state.targetPresent = false; else f.data.clear();
    await assert.rejects(f.repo.put(json(f.body)), missing === 'target' ? /target_not_found/ : /missing_evidence/);
    assert.equal(f.contexts.size, 0);
    assert.equal(f.calls.some(c => c.tag.endsWith(':insert')), false);
  }
});
test('unknown exact context returns null but a digest/revision conflict never does', async () => {
  const f = fixture(), ref = prepare(json(f.body)).context_ref;
  assert.equal(await f.repo.get(json(ref)), null);
  await f.repo.put(json(f.body));
  await assert.rejects(f.repo.get(json({ ...ref, context_sha256: '0'.repeat(64) })), /storage_conflict/);
  const changed = structuredClone(f.body); changed.effective_date = '2024-03-01';
  await assert.rejects(f.repo.put(json(changed)), /storage_conflict/);
  assert.deepEqual((await f.repo.get(json(ref))).body, f.body);
});
test('corrupt or missing persisted evidence is detected on exact reads', async () => {
  for (const corrupt of ['header', 'dependency', 'bytes', 'identity']) {
    const f = fixture(), { context_ref: ref, header_blob: header } = prepare(json(f.body));
    await f.repo.put(json(f.body));
    if (corrupt === 'header') f.data.get(header.ref.content_sha256).canonical_utf8 = '{}';
    if (corrupt === 'dependency') f.data.delete(f.body.study_input.content_sha256);
    if (corrupt === 'bytes') f.contexts.get(ref.context_id).header_canonical_utf8_bytes = '2';
    if (corrupt === 'identity') f.contexts.get(ref.context_id).context_revision = '2';
    await assert.rejects(f.repo.get(json(ref)), /storage_conflict|missing_evidence/);
  }
});
test('autocommit/replaced transactions and database failures do not retry or take transaction ownership', async () => {
  const f = fixture(), original = f.client.query;
  f.client.query = async (...args) => { if (args[0].includes('custom-cohort-context:transaction')) f.state.transaction = String(Number(f.state.transaction) + 1); return original(...args); };
  const repo = repository(f.client, json(f.scope));
  await assert.rejects(repo.put(json(f.body)), /caller_transaction_required/);
  assert.equal(f.contexts.size, 0);
  const g = fixture(), error = new Error('synthetic SQL failure'); g.state.fail = error;
  await assert.rejects(g.repo.put(json(g.body)), actual => actual === error);
  assert.equal(g.calls.length, 1);
});
test('additive context migration binds full tenant/file identity and protects immutable history', () => {
  const sql = readFileSync(new URL('../migrations/20261012_neighborhood_custom_cohort_contexts.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.match(runner, /20261012_neighborhood_custom_cohort_contexts.sql/);
  assert.match(sql, /PRIMARY KEY \(organization_id, context_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, report_file_id, assignment_file_id, account_id\)/);
  assert.match(sql, /REFERENCES app.report_files \(organization_id, id, custom_assignment_file_id, account_id\) ON DELETE RESTRICT/);
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /FOR EACH STATEMENT/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP) TABLE|^\s*(?:BEGIN|COMMIT|ROLLBACK);/m);
});

test('captures the original query callable and preserves its client receiver', async () => {
  const f = fixture(), original = f.client.query;
  f.client.query = function (...args) {
    assert.equal(this, f.client);
    return Reflect.apply(original, this, args);
  };
  const captured = repository(f.client, json(f.scope));
  f.client.query = () => { throw new Error('must not use a later replacement'); };
  assert.equal(await captured.get(json(prepare(json(f.body)).context_ref)), null);
  assert.equal(f.calls.length, 4);
});
