import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { prepareNeighborhoodCohortBlob as blob, createNeighborhoodCohortBlobRepository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortPagedGroupSelectionV1Store } from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { createCustomCohortGroupSelectionRepository as repository,
  prepareCustomCohortGroupSelectionReference as reference } from '../src/services/neighborhoodAssessment/customCohortGroupSelectionRepository.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';

/** SQL-double tests preserve the real original-blob and paged-union verifiers. */
async function fixture() {
  const body = contextFixture(), context = prepareCustomCohortContextHeader(json(body)).context_ref;
  const scope = { organization_id: body.target.organization_id, report_file_id: body.target.report_file_id,
    assignment_file_id: body.target.workflow_target_id, account_id: body.target.account_id };
  const data = new Map(), revisions = new Map(), operations = new Map(), calls = [];
  const state = { head: null, transaction: '88', target: true, fail: null, before: null, badHeadAck: false };
  const result = row => ({ rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] });
  const client = { release() { throw new Error('caller owns release'); }, async query(sql, args = []) {
    const tag = /\/\* ([^*]+) \*\//.exec(sql)?.[1]; calls.push({ tag, sql, args });
    await state.before?.(tag); if (state.fail) throw state.fail;
    if (tag === 'custom-cohort-group-selection:transaction') return result({ transaction_id: state.transaction });
    if (tag === 'custom-cohort-group-selection:target') {
      assert.deepEqual(args, [scope.organization_id, context.context_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id, context.context_revision, context.context_sha256]);
      return result(state.target ? context : null);
    }
    if (tag === 'custom-cohort-group-selection:head') return result(revisions.get(state.head));
    if (tag === 'custom-cohort-group-selection:operation') return result(operations.get(args[1]));
    if (tag === 'custom-cohort-group-selection:insert') {
      if (revisions.has(args[7]) || operations.has(args[8])) return result(null);
      const row = { selection_revision: String(args[7]), operation_id: args[8], request_sha256: args[9],
        selection_sha256: args[10], manifest_content_sha256: args[11], manifest_canonical_utf8_bytes: args[12] };
      revisions.set(args[7], row); operations.set(args[8], row); return result(row);
    }
    if (tag === 'custom-cohort-group-selection:head-insert') {
      if (state.head !== null) return result(null);
      state.head = args[2]; return result({ selection_revision: state.badHeadAck ? '999' : String(args[2]) });
    }
    if (tag === 'custom-cohort-group-selection:head-update') {
      if (state.head !== args[3]) return result(null);
      state.head = args[2]; return result({ selection_revision: state.badHeadAck ? '999' : String(args[2]) });
    }
    if (tag?.startsWith('neighborhood-cohort-blob:')) {
      assert.equal(args[0], scope.organization_id);
      if (tag.endsWith(':read')) return result(data.get(args[1]));
      if (tag.endsWith(':insert')) {
        if (data.has(args[1])) return result(null);
        const original = blob(args[3]); data.set(original.content_sha256, { ...original, canonical_utf8: args[3] });
        return result(data.get(args[1]));
      }
    }
    throw new Error(`unexpected SQL ${tag}`);
  } };
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const catalog_ref = await blobs.put(json({ synthetic_original_catalog: true }));
  const group = `recorded-cad:${'a'.repeat(64)}`, ids = ['A', 'B'];
  const stage = async (revision, empty = false) => {
    const metadataJson = json({ selection_version: 1, usage: 'retained_group_selection_only', scope,
      context_ref: context, catalog_ref, revision, groups: empty ? [] : [{ id: group, member_count: 2,
        account_ids_sha256: digest({ account_ids: ids }) }] });
    async function* pages() { if (!empty) yield ids.map(account_id => ({ account_id, group_id: group })); }
    const original = await createCohortPagedGroupSelectionV1Store(blobs).stage({ metadataJson, membershipPages: pages() });
    return { metadataJson, manifestRef: original.manifest_ref, original };
  };
  const staged = await stage(1);
  calls.length = 0;
  const create = options => repository(client, json(scope), json(context), options);
  return { scope, context, calls, state, data, revisions, operations, create, repo: create(), stage, staged,
    request: { operationId: randomUUID(), expectedSelectionRef: null, metadataJson: staged.metadataJson, manifestRef: staged.manifestRef } };
}

test('registers exact complete selection, lost-ACK replay and original reopen without transaction ownership', async () => {
  const f = await fixture(); assert.equal((await f.repo.peekCurrent()).selection_ref, null);
  const stored = await f.repo.put(f.request);
  assert.equal(stored.status, 'stored'); assert.equal(stored.authority, 'not_established');
  assert.equal(stored.selection_ref.selection_sha256, f.staged.original.selection_sha256);
  assert.deepEqual(await f.repo.put(f.request), { ...stored, status: 'reused' });
  assert.deepEqual((await f.repo.peekCurrent()).selection_ref, stored.selection_ref);
  const loaded = await f.repo.getCurrent({ metadataJson: f.staged.metadataJson, selectionRef: stored.selection_ref });
  assert.deepEqual(loaded.original, f.staged.original);
  assert.equal(f.revisions.size, 1); assert.equal(f.operations.size, 1);
  assert.ok(f.calls.every(c => !/\b(BEGIN|COMMIT|ROLLBACK|DELETE|TRUNCATE)\b/.test(c.sql)));
  assert.match(f.calls.find(c => c.tag === 'custom-cohort-group-selection:target' && /UPDATE/.test(c.sql)).sql, /FOR NO KEY UPDATE NOWAIT/);
  assert.match(f.calls.find(c => c.tag === 'custom-cohort-group-selection:target' && /FOR SHARE/.test(c.sql)).sql, /FOR SHARE NOWAIT/);
});

test('explicit empty selection advances once and old/stale operations cannot rewind it', async () => {
  const f = await fixture(), first = await f.repo.put(f.request), empty = await f.stage(2, true);
  const next = { operationId: randomUUID(), expectedSelectionRef: first.selection_ref,
    metadataJson: empty.metadataJson, manifestRef: empty.manifestRef };
  const second = await f.repo.put(next);
  assert.equal(second.selection_ref.selection_revision, 2); assert.equal(empty.original.account_count, 0);
  assert.deepEqual(await f.repo.put(next), { ...second, status: 'reused' });
  await assert.rejects(f.repo.put(f.request), /selection_changed/);
  await assert.rejects(f.repo.getCurrent({ metadataJson: f.staged.metadataJson, selectionRef: first.selection_ref }), /selection_changed/);
  await assert.rejects(f.repo.put({ ...next, operationId: randomUUID() }), /selection_changed/);
  assert.deepEqual((await f.repo.peekCurrent()).selection_ref, second.selection_ref);
  assert.equal(f.revisions.size, 2);
});

test('same operation cannot change inputs, context, revision, manifest or expected predecessor', async () => {
  const f = await fixture(), first = await f.repo.put(f.request), second = await f.stage(1, true);
  await assert.rejects(f.repo.put({ ...f.request, metadataJson: second.metadataJson, manifestRef: second.manifestRef }), /operation_conflict/);
  const bad = json({ ...JSON.parse(f.staged.metadataJson), scope: { ...f.scope, account_id: 'OTHER' } });
  await assert.rejects(f.repo.put({ ...f.request, metadataJson: bad }), /target_mismatch/);
  await assert.rejects(f.repo.put({ ...f.request, expectedSelectionRef: first.selection_ref }), /invalid_revision/);
  assert.equal(f.revisions.size, 1);
});

test('missing or corrupt catalog/manifest/original pages cannot insert a revision or head', async () => {
  for (const kind of ['catalog', 'manifest', 'membership', 'union']) {
    const f = await fixture(), manifest = JSON.parse(f.data.get(f.staged.manifestRef.content_sha256).canonical_utf8);
    const hash = kind === 'catalog' ? JSON.parse(f.staged.metadataJson).catalog_ref.content_sha256
      : kind === 'manifest' ? f.staged.manifestRef.content_sha256
        : kind === 'membership' ? manifest.membership_pages[0].page.content_sha256 : manifest.account_pages[0].page.content_sha256;
    f.data.delete(hash);
    await assert.rejects(f.repo.put(f.request), /missing_catalog|missing_manifest|page_conflict/);
    assert.equal(f.state.head, null); assert.equal(f.revisions.size, 0);
  }
});

test('invalid/accessor references refuse before SQL and submitted objects are detached before await', async () => {
  const f = await fixture(); let invoked = false;
  const evil = { ...f.request, manifestRef: { get content_sha256() { invoked = true; return 'a'.repeat(64); }, canonical_utf8_bytes: '1' } };
  await assert.rejects(f.repo.put(evil), /invalid_input/); assert.equal(invoked, false); assert.equal(f.calls.length, 0);
  for (const changes of [{ selection_version: 2 }, { usage: 'accepted_report' },
    { groups: [{ id: 'not-a-recorded-group', member_count: 2, account_ids_sha256: 'a'.repeat(64) }] }]) {
    await assert.rejects(f.repo.put({ ...f.request, metadataJson: json({ ...JSON.parse(f.staged.metadataJson), ...changes }) }), /invalid_metadata/);
    assert.equal(f.calls.length, 0);
  }
  assert.throws(() => reference({ selection_version: 1, selection_revision: 1, selection_sha256: 'a'.repeat(64),
    manifest_ref: { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '750001' } }), /invalid_reference/);
  const submitted = structuredClone(f.request);
  f.state.before = tag => { if (tag === 'custom-cohort-group-selection:target') {
    submitted.manifestRef.content_sha256 = 'b'.repeat(64); submitted.metadataJson = '{}';
  } };
  assert.deepEqual((await f.repo.put(submitted)).selection_ref.manifest_ref, f.staged.manifestRef);
});

test('captures the original query with its receiver and budget checks surround every SQL call', async () => {
  const f = await fixture();
  // Recreate with a checked receiver, then replace the public callable. The
  // repository must continue using the callable captured at construction.
  const rows = []; let checks = 0;
  const client = { release() {}, async query(sql) {
    assert.equal(this, client); rows.push(sql);
    return { rowCount: sql.includes(':head') ? 0 : 1, rows: sql.includes(':transaction') ? [{ transaction_id: '7' }]
      : sql.includes(':target') ? [f.context] : [] };
  } };
  const repo = repository(client, json(f.scope), json(f.context), { checkBudget() { checks++; } });
  client.query = () => { throw new Error('replacement query must not run'); };
  assert.equal((await repo.peekCurrent()).selection_ref, null);
  assert.equal(rows.length, 4); assert.equal(checks, 8);
});

test('lost transaction, cancellation, SQL failure and bad head acknowledgment require caller rollback', async () => {
  const auto = await fixture(); auto.state.before = tag => {
    if (tag === 'custom-cohort-group-selection:transaction') auto.state.transaction = String(Number(auto.state.transaction) + 1);
  };
  await assert.rejects(auto.repo.put(auto.request), /caller_transaction_required/);
  assert.equal(auto.revisions.size, 0); assert.equal(auto.state.head, null);
  const cancelled = await fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.create({ signal: controller.signal }).put(cancelled.request), /cancelled/);
  assert.equal(cancelled.calls.length, 0);
  const failed = await fixture(), error = new Error('original SQL failure'); failed.state.fail = error;
  await assert.rejects(failed.repo.put(failed.request), actual => actual === error); assert.equal(failed.calls.length, 1);
  const ack = await fixture(); ack.state.badHeadAck = true;
  await assert.rejects(ack.repo.put(ack.request), /storage_conflict/);
  assert.equal(ack.calls.some(c => /COMMIT|ROLLBACK/.test(c.sql)), false);
});

test('additive schema binds complete immutable context/revision history and bounded manifest originals', () => {
  const sql = readFileSync(new URL('../migrations/20261031_custom_cohort_group_selections.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.match(runner, /20261031_custom_cohort_group_selections.sql/);
  assert.match(sql, /UNIQUE \(organization_id,operation_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id,context_id,report_file_id,assignment_file_id,account_id,context_revision,context_sha256\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /BETWEEN 1 AND 750000/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP) TABLE|^\s*(?:BEGIN|COMMIT|ROLLBACK);/m);
  const originalContextChecks = readFileSync(new URL('./helpers/customCohortContextDatabaseChecks.js', import.meta.url), 'utf8');
  const closure = originalContextChecks.split('\n').find(line => line.includes("'TRUNCATE app.neighborhood_custom_cohort_contexts,"));
  assert.match(closure, /app.neighborhood_custom_cohort_group_selections, app.neighborhood_custom_cohort_group_selection_heads/);
  assert.doesNotMatch(closure, /CASCADE/);
  assert.match(originalContextChecks, /error.code === '55000' && \/custom_cohort_context_immutable\//);
});
