import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { customCohortPreparedCatalogSqlFixture as harness } from './fixtures/customCohortPreparedCatalogSqlFixture.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from './fixtures/customCohortPreparedCatalogRegistryFixture.js';

test('actual registry publishes display and whole membership coherently, then reopens every stored original without dense replay', async () => {
  const h = harness(), staged = await h.make().prepareMembership();
  assert.equal(staged.status,'prepared'); assert.equal((await h.make().prepareMembership()).status,'reused');
  const first = h.calls.length; h.source.compressed_catalog = h.source.compressed_preview = null;
  const result = await h.make().reopenMembership();
  assert.equal(result.status,'complete_catalog_membership'); assert.equal(result.account_count,501); assert.equal(result.group_count,238);
  assert.deepEqual(result.witness_ref,staged.witness_ref);
  assert.deepEqual(new Set(result.retention_refs.map(r => r.content_sha256)),new Set([...h.originals.keys()].map(k => k.split(':')[1])));
  assert.ok(!h.calls.slice(first).some(c => /registry:(originals|pins|insert)|prepared-catalog-membership:insert/.test(c.sql)));
  assert.ok(!h.calls.some(c => /\b(BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE|TRUNCATE)\b/.test(c.sql)));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.retention_refs));
  const witness = JSON.parse(h.originals.get(`${h.f.scope.organization_id}:${staged.witness_ref.content_sha256}`));
  assert.equal(witness.display_manifest_ref.content_sha256,h.root().manifest_sha256);
  assert.equal(Object.hasOwn(result,'selected'),false); assert.equal(Object.hasOwn(result,'selection_ref'),false);
});

test('12001 actual source observations, explicit empty and unresolved populations retain whole original identity without a capacity switch', async () => {
  for (const spec of [{ count:12001,groupCount:7 },{ count:0,groupCount:0 },{ count:31,groupCount:0 }]) {
    const h = harness(fixture(spec)); await h.make().prepareMembership();
    h.source.compressed_catalog = h.source.compressed_preview = null;
    const value = await h.make().reopenMembership(); assert.equal(value.account_count,spec.count);
    assert.equal(JSON.parse(value.manifest_json).account_count,String(spec.count));
    assert.equal(JSON.parse(value.manifest_json).membership_count,String(spec.count));
    assert.ok(Buffer.byteLength(JSON.stringify(value)) < 100000);
  }
  // Unlike the isolated 60,001-member representation fixture, the ACTUAL old
  // source acquisition still refuses its input-byte ceiling. Keep that refusal
  // visible until durable paged source acquisition is implemented; no fake
  // receipt or relabelled smaller population establishes larger live capacity.
  assert.throws(() => fixture({ count:60001,groupCount:7 }),e => e.code === 'NEIGHBORHOOD_CAPTURE_LIMIT'
    && e.state === 'incomplete' && /input_bytes/.test(e.message));
});

test('a display alone or a newer source without matching membership stays an explicit miss, while changed published pins refuse', async () => {
  const h = harness(); assert.equal(await h.make().reopenMembership(),null);
  await h.make().prepare(); assert.equal(await h.make().reopenMembership(),null);
  // A clean source format fixture proves the legitimate upgrade miss; no old
  // display or member root may be relabelled as a newly prepared derivative.
  const v = harness(); v.source.source_catalog_format_version = 1; await v.make().prepareMembership();
  v.source.source_catalog_format_version = 2; assert.equal(await v.make().reopenMembership(),null);
  const c = harness(); await c.make().prepareMembership(); c.memberRoot().display_manifest_sha256 = '0'.repeat(64);
  const first = c.calls.length; await assert.rejects(c.make().reopenMembership(),/storage_conflict/);
  assert.ok(!c.calls.slice(first).some(call => call.sql.includes('neighborhood-cohort-blob:read')));
  const p = harness(); await p.make().prepareMembership(); p.source.preview_sha256 = 'f'.repeat(64);
  await assert.rejects(p.make().reopenMembership(),/storage_conflict/);
});

test('later original loss and ending registry or source change discard whole provisional membership', async () => {
  for (const broken of ['page','root','source']) {
    const hooks = {}, h = harness(undefined,hooks); const staged = await h.make().prepareMembership();
    const root = JSON.parse(h.originals.get(`${h.f.scope.organization_id}:${staged.witness_ref.content_sha256}`));
    const manifest = JSON.parse(h.originals.get(`${h.f.scope.organization_id}:${root.membership_manifest_ref.content_sha256}`));
    if (broken === 'page') h.originals.delete(`${h.f.scope.organization_id}:${manifest.membership_pages.at(-1).page.content_sha256}`);
    else { let changed = false; hooks.after = sql => {
      if (!changed && sql.includes('neighborhood-cohort-blob:read')) { changed = true;
        if (broken === 'root') h.dropMemberRoot(); else h.source.preview_sha256 = 'f'.repeat(64); }
    }; }
    await assert.rejects(h.make().reopenMembership(),/page_conflict|ending_source|storage_conflict/);
  }
});

test('self-consistent substitute roots cannot change scope, original display or whole membership metadata', async () => {
  for (const field of ['scope','display_manifest_ref','membership_metadata_ref']) {
    const h = harness(); const staged = await h.make().prepareMembership(), key = digest => `${h.f.scope.organization_id}:${digest}`;
    const w = JSON.parse(h.originals.get(key(staged.witness_ref.content_sha256)));
    if (field === 'scope') w.scope = { ...w.scope,account_id:'FOREIGN' };
    else if (field === 'display_manifest_ref') w[field] = { ...w[field],content_sha256:'0'.repeat(64) };
    else {
      const m = JSON.parse(h.originals.get(key(w[field].content_sha256))); m.revision = 2;
      const text = json(m), r = blob(text); h.originals.set(key(r.content_sha256),text); w[field] = r;
    }
    const text = json(w), r = blob(text); h.originals.set(key(r.content_sha256),text);
    Object.assign(h.memberRoot(),{ witness_sha256:r.content_sha256,witness_utf8_bytes:Number(r.canonical_utf8_bytes) });
    await assert.rejects(h.make().reopenMembership(),/retained_membership_binding/);
  }
});

test('same transaction and source fences precede member publication, including lost acknowledgment and cancellation', async () => {
  const hooks = {}, h = harness(undefined,hooks); let n = 0; hooks.transaction = () => String(++n);
  await assert.rejects(h.make().prepareMembership(),/caller_transaction_required/); assert.equal(h.originals.size,0);
  const v = harness(undefined,{ after(sql) { if (sql.includes('prepared-catalog-membership:insert')) throw new Error('lost_ack'); } });
  await assert.rejects(v.make().prepareMembership(),/lost_ack/); // Caller must roll back all provisional bytes/rows.
  const abort = new AbortController(), a = harness(undefined,{ after(sql) { if (sql.includes('neighborhood-cohort-blob:insert')) abort.abort(); } });
  await assert.rejects(a.make({ signal:abort.signal }).prepareMembership(),/cancelled/);
  assert.equal(a.memberRoot(),null); assert.ok(!a.calls.some(c => c.sql.includes('prepared-catalog-membership:insert')));
});

test('pending storage keeps the same finite owner lane until actual settlement after cancellation', async () => {
  const hooks = {}, h = harness(undefined,hooks); await h.make().prepareMembership();
  let enter,release,held = true; const entered = new Promise(r => { enter = r; }), settled = new Promise(r => { release = r; });
  hooks.before = async sql => { if (held && sql.includes('neighborhood-cohort-blob:read')) { held = false; enter(); await settled; } };
  const abort = new AbortController(), owner = h.make({ signal:abort.signal }), pending = owner.reopenMembership(); await entered;
  await assert.rejects(owner.reopenMembership(),/operation_in_progress/); abort.abort();
  await assert.rejects(owner.prepareMembership(),/cancelled/); release(); await assert.rejects(pending,/cancelled/);
  let budget = 0; await assert.rejects(h.make({ checkBudget() { if (++budget > 15) throw new Error('deadline'); } }).reopenMembership(),/deadline/);
  assert.equal((await h.make().reopenMembership()).account_count,501);
});

test('additive member registry migration retains immutable display/blob FKs with no source/report data rewrite', () => {
  const sql = fs.readFileSync(new URL('../migrations/20261103_custom_cohort_catalog_membership_roots.sql',import.meta.url),'utf8');
  const migrations = fs.readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(migrations.indexOf('20261103_custom_cohort_catalog_membership_roots.sql') > migrations.indexOf('20261102_custom_cohort_prepared_catalog_roots.sql'));
  assert.match(sql,/REFERENCES app\.neighborhood_custom_cohort_prepared_catalog_roots/);
  assert.match(sql,/REFERENCES app\.neighborhood_cohort_evidence_blobs/); assert.match(sql,/BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.doesNotMatch(sql,/ALTER TABLE|DROP TABLE|DELETE FROM|UPDATE app|INSERT INTO/);
});
