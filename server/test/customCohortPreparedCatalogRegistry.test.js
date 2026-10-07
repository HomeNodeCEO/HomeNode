import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortPreparedCatalogRegistry as registry } from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogRegistry.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from './fixtures/customCohortPreparedCatalogRegistryFixture.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => { const text = Buffer.from(JSON.stringify(value)); return { bytes: text.length, digest: hash(text), packed: gzipSync(text) }; };
function harness(f = fixture(), hooks = {}) {
  const c = encode(f.payload), p = encode(f.preview), originals = new Map(), calls = [];
  const source = { source_catalog_format_version: 2, catalog_sha256: c.digest, catalog_utf8_bytes: c.bytes,
    compressed_catalog_sha256: hash(c.packed), compressed_catalog: c.packed,
    preview_sha256: p.digest, preview_utf8_bytes: p.bytes, compressed_preview_sha256: hash(p.packed), compressed_preview: p.packed };
  let root = null;
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values }); await hooks.before?.(sql, values, source);
    let result;
    if (sql.includes('registry:transaction')) result = { rowCount: 1, rows: [{ transaction_id: hooks.transaction?.() ?? '77' }] };
    else if (/registry:(pins|originals)/.test(sql)) result = hooks.missingSource ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ ...source }] };
    else if (sql.includes('registry:read')) result = root ? { rowCount: 1, rows: [{ ...root,
      current_catalog_format_version: source.source_catalog_format_version,
      ...Object.fromEntries(['catalog_sha256', 'catalog_utf8_bytes', 'compressed_catalog_sha256', 'preview_sha256',
        'preview_utf8_bytes', 'compressed_preview_sha256'].map(k => [`current_${k}`, source[k]])) }] } : { rowCount: 0, rows: [] };
    else if (sql.includes('registry:insert')) {
      if (!root) {
        const fields = ['source_catalog_format_version', 'catalog_sha256', 'catalog_utf8_bytes', 'compressed_catalog_sha256',
          'preview_sha256', 'preview_utf8_bytes', 'compressed_preview_sha256', 'manifest_sha256', 'manifest_utf8_bytes',
          'original_catalog_sha256', 'original_catalog_utf8_bytes', 'source_read_model_sha256', 'roster_account_ids_sha256'];
        root = Object.fromEntries(fields.map((k, i) => [k, values[i + 3]]));
        result = { rowCount: 1, rows: [{ manifest_sha256: root.manifest_sha256 }] };
      } else result = { rowCount: 0, rows: [] };
    } else if (sql.includes('neighborhood-cohort-blob:insert')) {
      const [org, digest, length, text] = values; const id = `${org}:${digest}`, existed = originals.has(id);
      if (!existed) originals.set(id, text);
      result = { rowCount: existed ? 0 : 1, rows: existed ? [] : [{ content_sha256: digest, canonical_utf8_bytes: String(length), canonical_utf8: text }] };
    } else if (sql.includes('neighborhood-cohort-blob:read')) {
      const text = originals.get(`${values[0]}:${values[1]}`);
      result = { rowCount: text === undefined ? 0 : 1, rows: text === undefined ? [] : [{ content_sha256: values[1],
        canonical_utf8_bytes: String(Buffer.byteLength(text)), canonical_utf8: text }] };
    } else throw new Error('unexpected_sql');
    await hooks.after?.(sql, result, source); return result;
  } };
  const make = (options = {}, scope = f.scope) => registry(client, json(scope), json(f.context), options);
  return { f, calls, source, originals, make, root: () => root, dropRoot: () => { root = null; } };
}

test('actual original catalog + independent indexed preview compile once, publish all pages and reuse exact roots', async () => {
  const h = harness(), prepared = await h.make().prepare();
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.authority, 'not_established');
  assert.equal((await h.make().prepare()).status, 'reused');
  const first = h.calls.length, opened = await h.make().open(), complete = await h.make().reopen();
  assert.equal(opened.status, 'display_directory'); assert.equal(complete.metadata.account_count, 501);
  assert.equal(complete.groups.length, 238); assert.equal(JSON.parse(opened.manifest_json).pages.length, 3);
  assert.deepEqual(complete.retention_refs.map(r => r.content_sha256).sort(), [...h.originals.keys()].map(k => k.split(':')[1]).sort());
  for (let i = 0; i < 3; i++) assert.deepEqual(JSON.parse((await h.make().page(i)).page_json).groups, complete.groups.slice(i * 100, i * 100 + 100));
  const reads = h.calls.slice(first);
  assert.ok(!reads.some(c => /registry:(originals|insert|pins)|prepared-(catalog|preview):read/.test(c.sql)));
  assert.ok(reads.some(c => /sha256\(c\.compressed_payload\)/.test(c.sql)));
  assert.ok(reads.every(c => !/SELECT[^]*?\bc\.compressed_payload\s+(?:AS|,)|SELECT[^]*?\bp\.compressed_preview\s*(?:,|FROM)/.test(c.sql)));
  assert.ok(!h.calls.some(c => /\b(?:BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE|TRUNCATE)\b/.test(c.sql)));
  for (const text of h.originals.values()) assert.ok(!text.includes('"account_ids":'));
  assert.ok(Object.isFrozen(complete.groups));
});

test('larger prepared display reopens without dense member arrays or another compiler invocation', async () => {
  const h = harness(fixture({ count: 12001, groupCount: 237 }));
  assert.ok(h.source.preview_utf8_bytes > 4_000_000);
  await h.make().prepare(); h.source.compressed_preview = h.source.compressed_catalog = null;
  const first = h.calls.length, complete = await h.make().reopen();
  assert.equal(complete.metadata.account_count, 12001); assert.equal(complete.groups.length, 238);
  assert.ok(!h.calls.slice(first).some(c => c.sql.includes('registry:originals')));
  assert.ok(Buffer.byteLength(JSON.stringify(complete)) < 200_000);
});

test('explicit empty and wholly unresolved originals preserve their complete display without invented groups', async () => {
  for (const count of [0, 1, 31]) {
    const h = harness(fixture({ count, groupCount: 0 })); await h.make().prepare();
    const complete = await h.make().reopen();
    assert.equal(complete.metadata.account_count, count); assert.equal(complete.metadata.unassigned_account_count, count);
    assert.equal(complete.metadata.assigned_account_count, 0); assert.equal(complete.groups.length, count ? 1 : 0);
    assert.equal(complete.metadata.subject_membership.status, count ? 'unassigned' : 'not_in_discovery');
  }
});

test('unprepared context is a cache miss but registered source disappearance/corruption is not', async () => {
  const h = harness(); assert.equal(await h.make().open(), null);
  await h.make().prepare();
  for (const field of ['catalog_sha256', 'compressed_catalog_sha256', 'preview_sha256', 'compressed_preview_sha256',
    'catalog_utf8_bytes', 'preview_utf8_bytes']) {
    const prior = h.source[field]; h.source[field] = typeof prior === 'string' ? '0'.repeat(64) : prior + 1;
    await assert.rejects(h.make().open(), /storage_conflict/); h.source[field] = prior;
  }
  h.source.source_catalog_format_version = null; await assert.rejects(h.make().open(), /storage_conflict/);
  assert.equal(await harness(undefined, { missingSource: true }).make().prepare(), null);
});

test('a newly published source format misses an old derivative instead of relabelling its roots', async () => {
  const h = harness(); h.source.source_catalog_format_version = 1; await h.make().prepare();
  assert.equal((await h.make().open()).status, 'display_directory');
  h.source.source_catalog_format_version = 2; assert.equal(await h.make().open(), null);
  h.source.source_catalog_format_version = 1; assert.equal((await h.make().open()).status, 'display_directory');
});

test('actual compressed originals, target, context, neutral selection and full partition are required before staging', async () => {
  for (const change of [h => { h.source.compressed_catalog = Buffer.from('broken'); },
    h => { h.source.preview_utf8_bytes++; }, h => { h.source.compressed_preview = gzipSync(Buffer.from('x'.repeat(64_000_001))); }]) {
    const h = harness(); change(h); await assert.rejects(h.make().prepare(), /storage_conflict/);
    assert.equal(h.originals.size, 0); assert.equal(h.root(), null);
  }
  for (const change of [f => { f.preview = { ...f.preview, target: { ...f.preview.target, account_id: 'WRONG' } }; },
    f => { f.payload.catalog.binding.context_ref = { ...f.context, context_sha256: '0'.repeat(64) }; },
    f => { f.payload.catalog.pockets[0].account_ids.push('FOREIGN'); },
    f => { f.payload.catalog.unassigned.account_ids = []; },
    f => { f.payload.private_sales = {}; }, f => { f.preview = { ...f.preview, selection_revision: 2 }; }]) {
    const f = fixture(); change(f); const h = harness(f); await assert.rejects(h.make().prepare());
    assert.equal(h.originals.size, 0); assert.equal(h.root(), null);
  }
});

test('ending original loss, source change or root replacement cannot return a previously valid directory', async () => {
  const hooks = {}, h = harness(undefined, hooks); await h.make().prepare(); let once = false;
  hooks.after = (sql) => { if (!once && sql.includes('neighborhood-cohort-blob:read')) { once = true; h.dropRoot(); } };
  await assert.rejects(h.make().open(), /ending_source/);
  const h2 = harness(); await h2.make().prepare(); h2.originals.delete(`${h2.f.scope.organization_id}:${h2.root().original_catalog_sha256}`);
  await assert.rejects(h2.make().open(), /missing_or_changed_original/);
  const hooks3 = {};
  const h4 = harness(undefined, hooks3); await h4.make().prepare();
  hooks3.after = sql => { if (sql.includes('neighborhood-cohort-blob:read')) h4.source.preview_sha256 = '0'.repeat(64); };
  await assert.rejects(h4.make().page(0), /storage_conflict/);
});

test('a source changed during staging cannot publish the provisional root or silently change its pinned format', async () => {
  for (const field of ['catalog_sha256', 'source_catalog_format_version']) {
    const hooks = {}, h = harness(undefined, hooks);
    hooks.after = sql => { if (sql.includes('neighborhood-cohort-blob:insert'))
      h.source[field] = field.endsWith('sha256') ? '0'.repeat(64) : 1; };
    await assert.rejects(h.make().prepare(), /ending_source/);
    assert.equal(h.root(), null); assert.ok(!h.calls.some(c => c.sql.includes('registry:insert')));
  }
});

test('same caller transaction, scope-bound SQL and source pins remain mandatory on both ends', async () => {
  const hooks = {}, h = harness(undefined, hooks); await h.make().prepare();
  const current = h.calls.length; await h.make().open();
  for (const call of h.calls.slice(current).filter(c => c.sql.includes('registry:read'))) {
    assert.deepEqual(call.values, [h.f.scope.organization_id, h.f.context.context_id, h.f.context.context_sha256,
      h.f.scope.report_file_id, h.f.scope.assignment_file_id, h.f.scope.account_id]);
    assert.match(call.sql, /o\.report_file_id=\$4::uuid AND o\.assignment_file_id=\$5::bigint AND o\.account_id=\$6/);
    assert.match(call.sql, /ORDER BY candidate\.format_version DESC LIMIT 1/);
  }
  let n = 0; hooks.transaction = () => String(++n);
  await assert.rejects(h.make().open(), /caller_transaction_required/);
  const retained = h.originals.size, publications = h.calls.filter(c => c.sql.includes('registry:insert')).length;
  await assert.rejects(h.make().prepare(), /caller_transaction_required/);
  assert.equal(h.originals.size, retained); assert.equal(h.calls.filter(c => c.sql.includes('registry:insert')).length, publications);
  const unowned = harness(undefined, { transaction: () => String(++n) });
  await assert.rejects(unowned.make().prepare(), /caller_transaction_required/);
  assert.equal(unowned.originals.size, 0); assert.equal(unowned.root(), null);
});

test('budget/cancellation retain the busy lane until actual pending I/O settles; no detached continuation', async () => {
  const hooks = {}, h = harness(undefined, hooks); await h.make().prepare();
  let settle, entered; const held = new Promise(r => { settle = r; }), ready = new Promise(r => { entered = r; });
  hooks.before = async sql => { if (sql.includes('neighborhood-cohort-blob:read')) { entered(); await held; } };
  const cancellation = new AbortController(), owner = h.make({ signal: cancellation.signal });
  const pending = owner.open(); await ready;
  await assert.rejects(owner.open(), /operation_in_progress/); cancellation.abort();
  await assert.rejects(owner.open(), /cancelled|operation_in_progress/); settle(); await assert.rejects(pending, /cancelled/);
  let budget = 0; await assert.rejects(h.make({ checkBudget() { if (++budget > 5) throw new Error('synthetic_deadline'); } }).open(), /synthetic_deadline/);
  hooks.before = undefined; assert.equal((await h.make().open()).status, 'display_directory');
  await assert.rejects(h.make().page(21), /page_index/);
});

test('additive migration registers exact immutable derivative FKs without mutating existing source/report tables', () => {
  const sql = fs.readFileSync(new URL('../migrations/20261102_custom_cohort_prepared_catalog_roots.sql', import.meta.url), 'utf8');
  const migrations = fs.readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.ok(migrations.indexOf('20261102_custom_cohort_prepared_catalog_roots.sql') > migrations.indexOf('20261101_custom_cohort_prepared_map_openings.sql'));
  for (const table of ['custom_cohort_prepared_catalogs', 'custom_cohort_prepared_previews', 'cohort_evidence_blobs'])
    assert.match(sql, new RegExp(`REFERENCES app\\.neighborhood_${table}`));
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/); assert.match(sql, /source_catalog_format_version IN \(1,2\)/);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP TABLE|DELETE FROM|INSERT INTO|UPDATE app/);
});
