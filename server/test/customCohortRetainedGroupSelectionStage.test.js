import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCatalogMembershipWitness as prepare,createCustomCohortCatalogMembershipWitnessStore as store }
  from '../src/services/neighborhoodAssessment/customCohortCatalogMembershipWitness.js';
import { createCustomCohortRetainedGroupSelectionStage as stage }
  from '../src/services/neighborhoodAssessment/customCohortRetainedGroupSelectionStage.js';
import { prepareCustomCohortRecordedGroupSelection as derive } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store as selectionStore } from '../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { customCohortCatalogPageFixture as fixture } from './fixtures/customCohortCatalogPageFixture.js';

async function harness(options,hook = () => {}) {
  const f = fixture(options), originals = new Map(),reads = [],writes = [];
  const repository = { async get(hash,bytes) { reads.push(hash); const changed = await hook({ kind:'get',hash,bytes,originals,reads,writes });
    return changed === undefined ? originals.get(hash) ?? null : changed; },
  async put(text) { const ref = blob(text); originals.set(ref.content_sha256,text); writes.push(text);
    const changed = await hook({ kind:'put',text,ref,originals,reads,writes }); return changed ?? ref; } };
  const whole = await store(repository).stage(await prepare(f.input)),w = JSON.parse(whole.witness_json);
  const binding = { scopeJson:f.input.scopeJson,contextJson:f.input.contextJson,manifestRef:w.display_manifest_ref,
    originalCatalogRef:w.original_catalog_ref,sourceReadModelSha256:w.source_read_model_sha256,
    rosterAccountIdsSha256:w.roster_account_ids_sha256,witnessRef:whole.witness_ref };
  reads.length = 0; writes.length = 0;
  const command = ids => json({ command_version:1,actor_user_id:'10000000-0000-4000-8000-000000000009',
    operation_id:'10000000-0000-4000-8000-000000000010',expected_selection_ref:null,
    included_recorded_group_ids:[...ids].sort(),selection_revision:1 });
  return { f,repository,whole,w,binding,command,originals,reads,writes };
}

test('stored original pages stage the exact unchanged v2 command/metadata/page identity without dense source replay', async () => {
  const h = await harness(),ids = [h.f.catalog.pockets[0].id,h.f.catalog.pockets[7].id,'discovery:unassigned'];
  const commandJson = h.command(ids),expected = await derive({ ...h.f.input,includedGroupIds:ids,revision:1,
    commandJson,catalogIdentityVersion:2 });
  const expectedPages = new Map(),port = { async put(text) { const ref = blob(text); expectedPages.set(ref.content_sha256,text); return ref; },
    async get(hash) { return expectedPages.get(hash) ?? null; } };
  const expectedStaged = await selectionStore(port).stage({ metadataJson:expected.metadata_json,membershipPages:expected.membershipPages() });
  h.f.input.catalogJson = null; h.f.input.rosterJson = null; h.f.catalog = null; h.f.accounts = null;
  const actual = await stage(h.repository,h.binding).stage(commandJson);
  assert.equal(actual.status,'staged_group_selection'); assert.equal(actual.authority,'not_established');
  assert.equal(actual.catalog_original_json,expected.catalog_original_json); assert.equal(actual.metadata_json,expected.metadata_json);
  assert.equal(actual.manifest_json,expectedStaged.manifest_json); assert.equal(actual.selection_sha256,expectedStaged.selection_sha256);
  assert.equal(actual.account_count,expectedStaged.account_count); assert.deepEqual(actual.catalog_ref,expected.catalog_ref);
  for (const [hash,text] of expectedPages) assert.equal(h.originals.get(hash),text);
  assert.ok(actual.retention_refs.every(ref => h.originals.has(ref.content_sha256)));
  assert.ok(Object.isFrozen(actual.included_recorded_group_ids));
  assert.equal(Object.hasOwn(actual,'selection_ref'),false); assert.equal(Object.hasOwn(actual,'summary'),false);
});

test('complete 60001, empty selections and unresolved-only originals remain exact without a live capacity switch', async () => {
  for (const options of [{ count:60001,groupCount:7 },{ count:0,groupCount:0 },{ count:37,groupCount:0 }]) {
    const h = await harness(options),ids = h.f.catalog.pockets.map(g => g.id);
    if (h.f.catalog.unassigned.member_count) ids.push('discovery:unassigned');
    for (const selected of [ids,[]]) {
      const result = await stage(h.repository,h.binding).stage(h.command(selected));
      assert.equal(result.account_count,selected.length ? options.count : 0);
      assert.equal(JSON.parse(result.manifest_json).account_count,String(result.account_count));
      assert.ok(h.writes.every(text => Buffer.byteLength(text) <= 750000));
    }
  }
});

test('malformed/unknown commands, foreign original binding and nested getters refuse before any selected write', async () => {
  const h = await harness(),owned = stage(h.repository,h.binding);
  await assert.rejects(owned.stage(h.command([`recorded-cad:${'f'.repeat(64)}`])),/unknown_group/);
  await assert.rejects(owned.stage('{}'));
  const command = JSON.parse(h.command([])); command.selection_revision = 2;
  await assert.rejects(owned.stage(json(command)),/invalid_command/);
  await assert.rejects(stage(h.repository,{ ...h.binding,scopeJson:json({ ...h.f.scope,account_id:'OTHER' }) }).stage(h.command([])));
  assert.equal(h.writes.length,0);
  const ref = { ...h.binding.witnessRef };
  Object.defineProperty(ref,'content_sha256',{ enumerable:true,get() { assert.fail('getter called'); } });
  assert.throws(() => stage(h.repository,{ ...h.binding,witnessRef:ref }),/shape/);
  assert.throws(() => stage(h.repository,new Proxy(h.binding,{})),/shape/);
});

test('shared lifetime I/O accounting cannot reset by staging another command on the same owner', async () => {
  const h = await harness(),owned = stage(h.repository,h.binding); let refused = false;
  for (let i = 0; i < 50 && !refused; i++) {
    try { await owned.stage(h.command([])); }
    catch (error) { assert.match(error.message,/operations_limit|io_bytes_limit/); refused = true; }
  }
  assert.equal(refused,true); assert.ok(h.reads.length + h.writes.length <= 1024);
});

test('damaged unselected or later originals and ending losses never produce a staged completion receipt', async () => {
  let active = false,ending = false;
  const h = await harness(undefined,({ kind,text,hash,originals }) => {
    if (active && kind === 'get' && hash === h.whole.witness_ref.content_sha256 && ending) return null;
    if (active && kind === 'put' && JSON.parse(text).kind === 'recorded_group_memberships') ending = true;
  });
  const manifest = JSON.parse(h.originals.get(h.w.membership_manifest_ref.content_sha256)),ref = manifest.account_pages.at(-1).page;
  const saved = h.originals.get(ref.content_sha256); h.originals.delete(ref.content_sha256);
  await assert.rejects(stage(h.repository,h.binding).stage(h.command([h.f.catalog.pockets[0].id])));
  assert.equal(h.writes.length,0); h.originals.set(ref.content_sha256,saved);
  active = true;
  await assert.rejects(stage(h.repository,h.binding).stage(h.command([h.f.catalog.pockets[0].id])),/missing_original|missing_or_changed_original/);
  assert.ok(h.writes.length > 0,'failed provisional writes belong to caller rollback');
});

test('lost write acknowledgments, cancellation and budget expiry refuse despite already-staged bytes', async () => {
  for (const failure of ['ack','cancel','deadline']) {
    let active = false,expired = false; const controller = new AbortController();
    const h = await harness(undefined,({ kind,text }) => {
      if (active && kind === 'put') {
        if (failure === 'ack') return { content_sha256:'f'.repeat(64),canonical_utf8_bytes:String(Buffer.byteLength(text)) };
        if (failure === 'cancel') controller.abort();
        if (failure === 'deadline') expired = true;
      }
    }); active = true;
    await assert.rejects(stage(h.repository,h.binding,{ signal:controller.signal,checkBudget() {
      if (expired) throw new Error('owner_deadline'); } }).stage(h.command([])),/storage_ack|cancelled|owner_deadline/);
    assert.equal(h.writes.length,1);
  }
});

test('pending original I/O holds the same finite lane until actual settlement; binding is detached before waits', async () => {
  let active = false,entered,release,held = false;
  const gate = new Promise(r => { entered = r; }),settled = new Promise(r => { release = r; });
  const h = await harness(undefined,async ({ kind }) => { if (active && !held && kind === 'get') { held = true; entered(); await settled; } });
  const binding = structuredClone(h.binding),controller = new AbortController(),owned = stage(h.repository,binding,{ signal:controller.signal });
  active = true; const pending = owned.stage(h.command([])); await gate;
  binding.witnessRef.content_sha256 = 'f'.repeat(64);
  await assert.rejects(owned.stage(h.command([])),/operation_in_progress/);
  controller.abort(); await assert.rejects(owned.stage(h.command([])),/cancelled/);
  release(); await assert.rejects(pending,/cancelled/);
  assert.equal(h.writes.length,0);
  assert.equal((await stage(h.repository,h.binding).stage(h.command([]))).account_count,0);
});
