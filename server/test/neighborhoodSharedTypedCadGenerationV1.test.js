import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {getNeighborhoodFrozenCadImprovementProfile as originalProfile} from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';
import { createNeighborhoodSharedTypedCadGenerationV1 as create, NEIGHBORHOOD_SHARED_TYPED_CAD_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile as profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';

const generationId = '12345678-1234-4234-8234-123456789012', stamp = '2026-10-09T00:00:00.000000Z';
const kinds = ['primary','secondary'];
const result = row => ({ rowCount: 1, rows: [structuredClone(row)] });
function fixture({ rowCount = 2, hook = () => null } = {}) {
  const calls = [], rows = []; let header = null;
  const source = { generation_id: generationId, format_version: 1, status: 'complete', source_snapshot: '1:2:',
    source_profile_sha256:originalProfile().profile_ref.content_sha256,source_definition_json:originalProfile().definition_blob.canonical_json,
    started_at: stamp, completed_at: stamp, row_count: String(rowCount), payload_utf8_bytes: String(rowCount * 200),
    layer_counts: Object.fromEntries(kinds.map(k => [k, { row_count: k === 'primary' ? String(rowCount) : '0',
      payload_utf8_bytes: k === 'primary' ? String(rowCount * 200) : '0' }])) };
  const tx = { transaction_id: '1', source_snapshot: '1:2:', isolation: 'repeatable read', read_only: 'off', timezone: 'UTC', backend_pid: 1 };
  const client = { async query(c) {
    calls.push(c); const override = await hook(c, { source, tx, header, rows }); if (override) return override;
    const { text, values: v } = c;
    if (text === SQL.snapshot) return result(tx);
    if (text === SQL.source) return result(source);
    if (text === SQL.read || text === SQL.lock) return header ? result(header) : { rowCount: 0, rows: [] };
    if (text.includes('shared-typed-CAD:begin')) {
      assert.equal(v.length, 6); header = { binding_sha256: v[2], source_metadata: JSON.parse(v[3]), definition_json: v[4],
        progress: JSON.parse(v[5]), status: 'building', completed_at: null }; return { rowCount: 1, rows: [] };
    }
    if (text === SQL.page) {
      const from = Number(v[2] || 0), count = v[1] === 'primary' ? Math.max(0, Math.min(250, rowCount - from)) : 0;
      const page = Array.from({ length: count }, (_, n) => {
        const row_key = String(from + n + 1).padStart(5,'0');
        return { row_key, payload_text: JSON.stringify({account_id:row_key,year_built:'2050',living_area_sqft:'9007199254740993',
          bedroom_count:'3',bath_count:'2.500',number_units:'1',pool:null}) };
      });
      return result({ page_json: JSON.stringify(page), page_count: count, candidate_count: count, next_cursor: page.at(-1)?.row_key ?? v[2] });
    }
    if (text === SQL.insert) {
      assert.equal(v.length, 4); const input = JSON.parse(v[3]); rows.push(...input);
      return result({ inserted_count: input.length, typed_utf8_bytes: String(input.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.typed)), 0)) });
    }
    if (text.includes('shared-typed-CAD:progress')) {
      assert.equal(v.length, 5); header.progress = JSON.parse(v[2]); header.status = v[3];
      header.completed_at = v[3] === 'complete' ? stamp : null; return { rowCount: 1, rows: [] };
    }
    assert.fail(text);
  } };
  return { client, calls, rows, source, tx, header: () => header, builder: o => create(client, { generationId, ...o }) };
}
async function complete(f, p = null) {
  let r; for (let n = 0; n < 30; n++) { r = await f.builder().step(p); p = r.progress; if (r.all_layers_typed) return r; }
  assert.fail('completion bound exceeded');
}

test('CAD reuses one immutable generation/profile cache without any appraisal date or repeated original work', async () => {
  const f = fixture(), r = await complete(f);
  assert.equal(r.status, 'shared_typed_CAD_generation_progress_v1'); assert.equal(Object.hasOwn(r, 'effective_date'), false);
  assert.equal(r.temporal_basis, 'date_neutral_original_syntax'); assert.deepEqual(r.profile, profile());
  assert.equal(r.progress.format, 'shared_frozen_typed_CAD_progress_v1'); assert.equal(r.progress.typed_rows, '2');
  assert.equal(r.authority, 'not_established'); assert.equal(r.source_acquisition, 'not_established'); assert.equal(r.report_update, 'none');
  assert.equal(f.rows[0].typed.observations.reported_living_area.exact_value,'9007199254740993');
  assert.equal(f.rows[0].typed.observations.reported_year_built.exact_value,'2050');
  assert.equal(f.rows[0].typed.observations.reported_pool_flag.state,'missing');
  const from = f.calls.length, reopened = await f.builder().step();
  assert.equal(reopened.advanced, false); assert.equal(reopened.reused, true); assert.deepEqual(reopened.progress, r.progress);
  assert.equal(f.calls.length - from, 6); assert.ok(!f.calls.slice(from).some(c => /:page|:rows|:begin|:progress|FOR UPDATE/.test(c.text)));
  assert.ok(f.calls.filter(c => c.text === SQL.read).every(c => c.values.length === 2));
  assert.ok(!f.calls.some(c => /ST_DWithin|FROM core\.|FROM gis\.|COMMIT|capture_jobs|group_active|effective_date/.test(c.text)));
});

test('full-250 and short-tail pages require exact end semantics, and uncertain acknowledgements reopen persisted state', async () => {
  for (const rowCount of [250, 253]) {
    const f = fixture({ rowCount }), first = await f.builder().step();
    assert.equal(first.progress.kind_index, 0); assert.equal(first.progress.layer_rows, 250);
    const from = f.calls.length, opened = await f.builder().step();
    assert.deepEqual(opened.progress, first.progress); assert.equal(opened.advanced, false);
    assert.ok(!f.calls.slice(from).some(c => c.text === SQL.page || c.text === SQL.insert));
    const next = await f.builder().step(opened.progress);
    assert.equal(next.progress.kind_index, 1); assert.equal(next.progress.typed_rows, String(rowCount));
    assert.equal(f.rows.length, rowCount); assert.equal((await complete(f, next.progress)).all_layers_typed, true);
  }
});

test('dates, caller policies, V1 progress, changed definitions/source and stale locks cannot widen reuse', async () => {
  const f = fixture();
  for (const opts of [{ effectiveDate: '2026-10-09' }, { effective_date: '2026-10-09' }, { profile: {} }, { table: 'core.accounts' }])
    assert.throws(() => f.builder(opts), /invalid_input/);
  const first = await f.builder().step();
  await assert.rejects(f.builder().step({ ...first.progress, format: 'shared_frozen_typed_progress_v1' }), /invalid_progress/);
  for (const change of [f => { f.header().definition_json = '{}'; }, f => { f.header().binding_sha256 = 'e'.repeat(64); },
    f => { f.source.source_snapshot = '2:3:'; }, f => { f.header().progress.typed_rows = '1'; }]) {
    const g = fixture(); await complete(g); change(g); await assert.rejects(g.builder().step(), /checkpoint_mismatch/);
  }
  let corrupt = false; const g = fixture({ hook: (c, state) => corrupt && c.text === SQL.lock
    ? result({ ...state.header, binding_sha256: 'e'.repeat(64) }) : null });
  const p = (await g.builder().step()).progress, from = g.calls.length; corrupt = true;
  await assert.rejects(g.builder().step(p), /checkpoint_mismatch/);
  assert.ok(!g.calls.slice(from).some(c => c.text === SQL.page || c.text === SQL.insert));
});

test('caller-owned stable RR/UTC writable transactions, ending checks and a fresh one-step budget remain required', async () => {
  for (const patch of [{ isolation: 'read committed' }, { read_only: 'on' }, { timezone: 'America/Chicago' }]) {
    const f = fixture(); Object.assign(f.tx, patch); await assert.rejects(f.builder().step(), /caller_transaction_required/);
    assert.equal(f.header(), null);
  }
  let probes = 0; const auto = fixture({ hook: (c, state) => c.text === SQL.snapshot && ++probes === 2
    ? result({ ...state.tx, transaction_id: '2' }) : null });
  await assert.rejects(auto.builder().step(), /caller_transaction_changed/); assert.equal(auto.header(), null);
  let sources = 0; const end = fixture({ hook: (c, state) => c.text === SQL.source && ++sources === 2
    ? result({ ...state.source, source_snapshot: '2:3:' }) : null });
  await assert.rejects(end.builder().step(), /source_changed/);
  const f = fixture(), builder = f.builder(), p = (await builder.step()).progress, from = f.calls.length;
  await assert.rejects(builder.step(p), /builder_already_used/); assert.equal(f.calls.length, from);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.builder({ signal: abort.signal }).step(), /cancelled/); assert.equal(f.calls.length, from);
});

test('original-text/hash/identity acknowledgement, page bounds, completion totals and CAS are not bypassed', async () => {
  for (const override of [result({ inserted_count: 1, typed_utf8_bytes: '100' }), result({ inserted_count: 2, typed_utf8_bytes: '0' })]) {
    const f = fixture({ hook: c => c.text === SQL.insert ? override : null }); await assert.rejects(f.builder().step(), /original_mismatch/);
  }
  for (const patch of [{ candidate_count: 251 }, { next_cursor: 'other' }, { page_count: 0, candidate_count: 1, page_json: '[]' },
    { page_count: 0, candidate_count: 0, page_json: 'x'.repeat(2_100_001) }]) {
    const f = fixture({ hook: c => c.text === SQL.page ? result({ page_count: 0, candidate_count: 0, page_json: '[]', next_cursor: '', ...patch }) : null });
    await assert.rejects(f.builder().step(), /page_corrupt|page_unavailable/);
  }
  const incomplete = fixture({ hook: c => {
    if (c.text.includes('shared-typed-CAD:progress') && c.values[3] === 'complete')
      throw Object.assign(new Error('neighborhood_shared_typed_cad_population_incomplete'), { code: '55000' });
  } });
  await assert.rejects(complete(incomplete), /population_incomplete/); assert.equal(incomplete.header().status, 'building');
  const lost = fixture({ hook: c => c.text.includes('shared-typed-CAD:progress') ? { rowCount: 0, rows: [] } : null });
  await assert.rejects(lost.builder().step(), /write_lost/);
  assert.match(SQL.insert, /original.payload::text=input.original_text/); assert.match(SQL.insert, /original.payload_sha256=input.typed/);
});

test('CAD migration separates date-neutral keys, derives two bounded totals and retires before originals without activation', () => {
  const sql = readFileSync(new URL('../migrations/20261117_neighborhood_shared_typed_cad_generations.sql', import.meta.url), 'utf8');
  const registry = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.ok(registry.includes('20261117_neighborhood_shared_typed_cad_generations.sql'));
  assert.match(sql, /PRIMARY KEY\(generation_id,profile_sha256,kind,row_key\)/);
  assert.doesNotMatch(sql, /effective_date date|effective_date\)/);
  assert.match(sql, /NOT \(typed \? 'effective_date'\)/); assert.match(sql, /typed_CAD_improvement_version'='1'/);
  assert.match(sql, /CHECK\(profile_sha256=encode\(sha256/); assert.match(sql, /pg_trigger_depth\(\)<>2/);
  assert.match(sql, /FROM new_rows GROUP BY generation_id,profile_sha256,kind/);
  const header = sql.slice(sql.indexOf('CREATE FUNCTION app.guard_neighborhood_shared_typed_cad_header'), sql.indexOf('CREATE TRIGGER neighborhood_shared_typed_cad_header_guard'));
  assert.doesNotMatch(header, /FROM app.neighborhood_frozen_typed_cad_rows/);
  assert.match(sql, /reject_pinned_neighborhood_group_mutation/); assert.match(sql, /retirement_started_at IS NULL/);
  assert.doesNotMatch(sql, /ALTER TABLE|DROP TABLE|DISABLE|ON DELETE CASCADE/);
  const worker = readFileSync(new URL('../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js', import.meta.url), 'utf8');
  assert.match(worker, /PRUNE_SHARED_TYPED_V2,PRUNE_SHARED_TYPED_V2_TOTALS,PRUNE_SHARED_TYPED_V2_HEADERS,\s*PRUNE_SHARED_TYPED_CAD,PRUNE_SHARED_TYPED_CAD_TOTALS,PRUNE_SHARED_TYPED_CAD_HEADERS,\s*PRUNE_CAD_ORIGINALS,PRUNE_CAD_TOTALS,PRUNE_CAD_HEADERS,PRUNE_ORIGINALS/);
  assert.equal(worker.includes('createNeighborhoodSharedTypedCadGenerationV1'), false);
});

test('foreign original profiles, definitions, legacy progress and over-cap companion populations refuse before writes',async()=>{
  for(const patch of [{source_profile_sha256:'a'.repeat(64)},{source_definition_json:'{}'},
    {row_count:'4000001'},{layer_counts:{parcels:{row_count:'2',payload_utf8_bytes:'400'}}}]){
    const f=fixture();Object.assign(f.source,patch);await assert.rejects(f.builder().step(),/source_unavailable|invalid_input/);
    assert.equal(f.header(),null);assert.equal(f.rows.length,0);
  }
  const f=fixture(),r=await f.builder().step();
  for(const patch of [{format:'shared_frozen_typed_progress_v2'},{kind_index:7},{typed_rows:'4000001'}])
    await assert.rejects(f.builder().step({...r.progress,...patch}),/invalid_progress/);
  assert.match(SQL.source,/neighborhood_frozen_cad_improvement_generations/);
  assert.match(SQL.page,/neighborhood_frozen_cad_improvement_rows/);
  assert.doesNotMatch(SQL.page,/neighborhood_frozen_source_rows/);
});

