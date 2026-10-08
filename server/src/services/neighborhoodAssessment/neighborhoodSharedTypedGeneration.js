import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS } from './cohortOriginalSourceChainV1.js';
import { compileNeighborhoodFrozenTypedOriginalV1, getNeighborhoodFrozenTypedOriginalV1Profile } from './neighborhoodFrozenTypedOriginalV1.js';

export const NEIGHBORHOOD_SHARED_TYPED_LIMITS = Object.freeze({
  rows: 250, page_utf8_bytes: 2_100_000, step_utf8_bytes: 32_000_000,
  rows_per_layer: 2_000_000, total_rows: 14_000_000, total_typed_utf8_bytes: 8_000_000_000,
  step_ms: 60_000, queries: 16,
});
const L = NEIGHBORHOOD_SHARED_TYPED_LIMITS, FORMAT = 'shared_frozen_typed_progress_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function fail(reason) { throw new TypeError(`neighborhood_shared_typed_${reason}`); }
function data(value, keys, optional = []) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (!keys.every(k => names.includes(k)) || names.some(k => typeof k !== 'string'
    || ![...keys, ...optional].includes(k) || !ds[k].enumerable || !Object.hasOwn(ds[k], 'value'))) fail('invalid_input');
  return Object.fromEntries(names.map(k => [k, ds[k].value]));
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const count = (n, max) => typeof n === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(n) && BigInt(n) <= BigInt(max);
function one(result) { if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('invalid_result'); return result.rows[0]; }
function progressOf(raw) {
  if (raw === null) return null;
  const p = data(raw, ['format', 'binding_sha256', 'kind_index', 'after', 'layer_rows', 'typed_rows', 'typed_utf8_bytes']);
  if (p.format !== FORMAT || typeof p.binding_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.binding_sha256)
    || !Number.isInteger(p.kind_index) || p.kind_index < 0 || p.kind_index > KINDS.length
    || !Number.isSafeInteger(p.layer_rows) || p.layer_rows < 0 || p.layer_rows > L.rows_per_layer
    || !count(p.typed_rows, L.total_rows) || !count(p.typed_utf8_bytes, L.total_typed_utf8_bytes)
    || Number(p.typed_utf8_bytes) < Number(p.typed_rows)
    || typeof p.after !== 'string' || Buffer.byteLength(p.after) > 256 || /[\u0000-\u001f\u007f]/.test(p.after)
    || (p.after === '') !== (p.layer_rows === 0) || p.kind_index === KINDS.length && p.after !== '') fail('invalid_progress');
  return Object.freeze(p);
}
const SNAPSHOT = `/* neighborhood-shared-typed:snapshot */ SELECT txid_current()::text AS transaction_id,
  pg_current_snapshot()::text AS source_snapshot,current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only,current_setting('TimeZone') AS timezone,pg_backend_pid() AS backend_pid`;
function snapshot(result) {
  const r = data(one(result), ['transaction_id', 'source_snapshot', 'isolation', 'read_only', 'timezone', 'backend_pid']);
  if (r.isolation !== 'repeatable read' || r.read_only !== 'off' || r.timezone !== 'UTC'
    || !/^[1-9][0-9]{0,19}$/.test(r.transaction_id ?? '') || typeof r.source_snapshot !== 'string'
    || r.source_snapshot.length > 65536 || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(r.source_snapshot)
    || !Number.isInteger(r.backend_pid) || r.backend_pid < 1) fail('caller_transaction_required');
  return r;
}
const SOURCE = `/* neighborhood-shared-typed:source */ SELECT source.generation_id::text,source.format_version,source.status,
  source.source_snapshot,to_char(source.source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
  to_char(source.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
  source.layer_counts,source.row_count::text,source.payload_utf8_bytes::text
  FROM app.neighborhood_frozen_source_generations source JOIN app.neighborhood_group_generations generation USING(generation_id)
  WHERE source.generation_id=$1::uuid AND generation.status='complete' AND generation.retirement_started_at IS NULL
  FOR SHARE OF generation NOWAIT`;
function sourceOf(result, generation) {
  const r = data(one(result), ['generation_id', 'format_version', 'status', 'source_snapshot', 'started_at',
    'completed_at', 'layer_counts', 'row_count', 'payload_utf8_bytes']);
  if (r.generation_id !== generation || r.format_version !== 1 || r.status !== 'complete'
    || typeof r.source_snapshot !== 'string' || r.source_snapshot.length > 65536
    || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(r.source_snapshot)
    || !DATE.test(r.started_at ?? '') || !DATE.test(r.completed_at ?? '') || r.completed_at < r.started_at
    || !count(r.row_count, L.total_rows) || !count(r.payload_utf8_bytes, 8_000_000_000)) fail('source_unavailable');
  const layers = data(r.layer_counts, KINDS); let rows = 0, bytes = 0;
  for (const k of KINDS) {
    const c = data(layers[k], ['row_count', 'payload_utf8_bytes']);
    if (!count(c.row_count, L.rows_per_layer) || !count(c.payload_utf8_bytes, 8_000_000_000)
      || (c.row_count === '0' ? c.payload_utf8_bytes !== '0' : Number(c.payload_utf8_bytes) < Number(c.row_count))) fail('source_unavailable');
    layers[k] = c; rows += Number(c.row_count); bytes += Number(c.payload_utf8_bytes);
  }
  if (String(rows) !== r.row_count || String(bytes) !== r.payload_utf8_bytes) fail('source_unavailable');
  return freeze({ ...r, layer_counts: layers });
}
const READ = `/* neighborhood-shared-typed:read */ SELECT binding_sha256,source_metadata,definition_json,progress,status,
  to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at
  FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1::uuid AND profile_sha256=$2 AND effective_date=$3::date`;
const LOCK = `${READ} FOR UPDATE NOWAIT`;
// All seven source layers use their existing C-collated native-text PK here.
// This cache order is distinct from the job's native-numeric acquisition order;
// it neither skips originals nor supplies a job continuation or source grant.
const PAGE = `/* neighborhood-shared-typed:page */ WITH candidates AS MATERIALIZED (
  SELECT row_key,jsonb_build_object('row_key',row_key,'payload_text',payload::text) AS encoded
  FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1::uuid AND kind=$2
    AND row_key>$3::text COLLATE "C" ORDER BY row_key LIMIT $4::integer
), sized AS (
  SELECT *,sum(octet_length(encoded::text)+2) OVER(ORDER BY row_key) AS bytes FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes+2<=$5::bigint)
SELECT coalesce(jsonb_agg(encoded ORDER BY row_key),'[]'::jsonb)::text AS page_json,
  count(*)::integer AS page_count,(SELECT count(*)::integer FROM candidates) AS candidate_count,
  coalesce((SELECT row_key FROM admitted ORDER BY row_key DESC LIMIT 1),$3) AS next_cursor FROM admitted`;
const INSERT = `/* neighborhood-shared-typed:rows */ WITH input AS (
  SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(row_key text,original_text text,typed jsonb)
), written AS (
  INSERT INTO app.neighborhood_frozen_typed_rows
    (generation_id,profile_sha256,effective_date,kind,row_key,account_id,source_record_id,original_payload_sha256,typed)
  SELECT $1::uuid,$2,$3::date,$4,original.row_key,original.account_id,original.source_record_id,
    input.typed->'original'->>'payload_sha256',input.typed FROM input
  JOIN app.neighborhood_frozen_source_rows original ON original.generation_id=$1::uuid AND original.kind=$4 AND original.row_key=input.row_key
  WHERE original.payload::text=input.original_text AND original.account_id IS NOT DISTINCT FROM input.typed->>'account_id'
    AND original.source_record_id::text IS NOT DISTINCT FROM input.typed->>'source_record_id'
  RETURNING typed_utf8_bytes AS bytes
) SELECT count(*)::integer AS inserted_count,coalesce(sum(bytes),0)::text AS typed_utf8_bytes FROM written`;
const COUNTS = `/* neighborhood-shared-typed:counts */ SELECT kind,count(*)::text AS row_count,
  sum(typed_utf8_bytes)::text AS typed_utf8_bytes FROM app.neighborhood_frozen_typed_rows
  WHERE generation_id=$1::uuid AND profile_sha256=$2 AND effective_date=$3::date GROUP BY kind`;

/** OFF/unmounted storage builder. Its trusted offline owner must authorize the
 * integrated source mix before and after the caller-owned transaction. No pool,
 * COMMIT, current-user grant, active-generation fallback, job phase or publication
 * is supplied. Reuse is exact generation + retained profile + EFFECTIVE DATE:
 * a different date cannot borrow future-year interpretations. A completed cache
 * is immutable; report owners must still prove scoped originals/closure and live
 * rights. This stage does not yet replace the per-job typed rows or graph copy.
 */
export function createNeighborhoodSharedTypedGeneration(client, rawOptions) {
  if (typeof client?.query !== 'function') fail('client_required');
  const o = data(rawOptions, ['generationId', 'effectiveDate'], ['signal', 'checkBudget']);
  if (typeof o.generationId !== 'string' || !UUID.test(o.generationId)
    || o.signal !== undefined && !(o.signal instanceof AbortSignal)
    || o.checkBudget !== undefined && typeof o.checkBudget !== 'function') fail('invalid_input');
  const generation = o.generationId, effective = assessmentDate(o.effectiveDate), signal = o.signal;
  const profile = getNeighborhoodFrozenTypedOriginalV1Profile(), key = [generation, profile.profile_ref.content_sha256, effective];
  const deadline = performance.now() + L.step_ms; let busy = false, queries = 0, bytes = 0;
  const check = () => { if (signal?.aborted) fail('cancelled'); o.checkBudget?.();
    if (signal?.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('deadline'); };
  const query = async (text, values) => { check(); if (++queries > L.queries) fail('query_limit');
    const r = await client.query({ text, values, query_timeout: Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))) }); check(); return r; };
  return Object.freeze({ async step(rawProgress = null) {
    const supplied = progressOf(rawProgress); check(); if (busy) fail('concurrent_operation'); busy = true;
    try {
      const tx = snapshot(await query(SNAPSHOT));
      if (!same(tx, snapshot(await query(SNAPSHOT)))) fail('caller_transaction_changed');
      const source = sourceOf(await query(SOURCE, [generation]), generation);
      const binding = assessmentEvidenceDigest({ source, profile, effective_date: effective });
      const found = await query(READ, key); let p;
      if (found.rowCount === 0 && found.rows?.length === 0) {
        if (supplied) fail('checkpoint_mismatch');
        p = progressOf({ format: FORMAT, binding_sha256: binding, kind_index: 0, after: '', layer_rows: 0, typed_rows: '0', typed_utf8_bytes: '0' });
        const r = await query(`/* neighborhood-shared-typed:begin */ INSERT INTO app.neighborhood_frozen_typed_generations
          (generation_id,profile_sha256,effective_date,binding_sha256,source_metadata,definition_json,progress)
          VALUES($1::uuid,$2,$3::date,$4,$5::jsonb,$6,$7::jsonb)`, [...key, binding, JSON.stringify(source), profile.definition_blob.canonical_json, JSON.stringify(p)]);
        if (r?.rowCount !== 1) fail('write_lost');
      } else {
        const h = data(one(found), ['binding_sha256', 'source_metadata', 'definition_json', 'progress', 'status', 'completed_at']); p = progressOf(h.progress);
        if (!p || p.binding_sha256 !== binding || h.binding_sha256 !== binding || !same(h.source_metadata, source)
          || h.definition_json !== profile.definition_blob.canonical_json || supplied && !same(supplied, p)
          || h.status !== (p.kind_index === KINDS.length ? 'complete' : 'building')
          || (h.status === 'complete' ? !DATE.test(h.completed_at ?? '') : h.completed_at !== null)) fail('checkpoint_mismatch');
        const seen = KINDS.slice(0, p.kind_index).reduce((n, k) => n + Number(source.layer_counts[k].row_count), 0) + p.layer_rows;
        if (String(seen) !== p.typed_rows || p.kind_index < KINDS.length && p.layer_rows > Number(source.layer_counts[KINDS[p.kind_index]].row_count)) fail('checkpoint_mismatch');
        // A lost acknowledgement or a second offline owner may reopen persisted
        // progress without guessing whether the previous transaction committed.
        if (!supplied || p.kind_index === KINDS.length) {
          await ending(); return receipt(p, false, true);
        }
        // Completed immutable metadata can be reused concurrently. Only a
        // building-cache continuation needs an exclusive header lock; verify
        // that it is still the same persisted checkpoint before inserting rows.
        if (!same(one(await query(LOCK, key)), h)) fail('checkpoint_mismatch');
      }
      const kind = KINDS[p.kind_index], r = one(await query(PAGE, [generation, kind, p.after, L.rows, L.page_utf8_bytes]));
      if (typeof r.page_json !== 'string' || Buffer.byteLength(r.page_json) > L.page_utf8_bytes
        || !Number.isInteger(r.page_count) || r.page_count < 0 || r.page_count > L.rows
        || !Number.isInteger(r.candidate_count) || r.candidate_count < r.page_count || r.candidate_count > L.rows) fail('page_corrupt');
      let rows; try { rows = JSON.parse(r.page_json); } catch { fail('page_corrupt'); }
      if (!Array.isArray(rows) || rows.length !== r.page_count || !rows.length && r.candidate_count) fail('page_unavailable');
      let last = p.after;
      const input = rows.map(raw => {
        const row = data(raw, ['row_key', 'payload_text']);
        if (typeof row.row_key !== 'string' || !row.row_key || Buffer.byteLength(row.row_key) > 256
          || /[\u0000-\u001f\u007f]/.test(row.row_key) || Buffer.compare(Buffer.from(row.row_key), Buffer.from(last)) <= 0) fail('page_corrupt');
        last = row.row_key; check();
        return { row_key: row.row_key, original_text: row.payload_text,
          typed: compileNeighborhoodFrozenTypedOriginalV1({ kind, ...row, effective_date: effective }) };
      });
      if (r.next_cursor !== last) fail('page_corrupt');
      const encoded = JSON.stringify(input); bytes += Buffer.byteLength(r.page_json) + Buffer.byteLength(encoded);
      if (bytes > L.step_utf8_bytes) fail('byte_limit');
      let writtenBytes = 0;
      if (input.length) {
        const ack = one(await query(INSERT, [...key, kind, encoded]));
        if (ack.inserted_count !== input.length || !count(ack.typed_utf8_bytes, L.step_utf8_bytes)
          || Number(ack.typed_utf8_bytes) < input.length) fail('original_mismatch');
        writtenBytes = Number(ack.typed_utf8_bytes);
      }
      const seen = p.layer_rows + input.length, end = r.candidate_count < L.rows && r.page_count === r.candidate_count;
      if (seen > Number(source.layer_counts[kind].row_count) || end && seen !== Number(source.layer_counts[kind].row_count)) fail('layer_count_mismatch');
      const next = progressOf({ ...p, kind_index: p.kind_index + (end ? 1 : 0), after: end ? '' : last, layer_rows: end ? 0 : seen,
        typed_rows: String(Number(p.typed_rows) + input.length), typed_utf8_bytes: String(Number(p.typed_utf8_bytes) + writtenBytes) });
      if (next.kind_index === KINDS.length) {
        const totals = await query(COUNTS, key), foundCounts = new Map(); let actualBytes = 0;
        if (!Array.isArray(totals.rows) || totals.rowCount !== totals.rows.length || totals.rows.length > KINDS.length) fail('invalid_result');
        for (const r of totals.rows) {
          if (!KINDS.includes(r.kind) || foundCounts.has(r.kind) || !count(r.row_count, L.rows_per_layer) || r.row_count === '0'
            || !count(r.typed_utf8_bytes, L.total_typed_utf8_bytes) || Number(r.typed_utf8_bytes) < Number(r.row_count)) fail('invalid_result');
          foundCounts.set(r.kind, r.row_count); actualBytes += Number(r.typed_utf8_bytes);
        }
        if (KINDS.some(k => (foundCounts.get(k) ?? '0') !== source.layer_counts[k].row_count)
          || next.typed_rows !== source.row_count || next.typed_utf8_bytes !== String(actualBytes)) fail('population_incomplete');
      }
      const update = await query(`/* neighborhood-shared-typed:progress */ UPDATE app.neighborhood_frozen_typed_generations
        SET progress=$4::jsonb,status=$5,completed_at=CASE WHEN $5='complete' THEN clock_timestamp() ELSE NULL END
        WHERE generation_id=$1::uuid AND profile_sha256=$2 AND effective_date=$3::date AND status='building' AND progress=$6::jsonb`,
      [...key, JSON.stringify(next), next.kind_index === KINDS.length ? 'complete' : 'building', JSON.stringify(p)]);
      if (update?.rowCount !== 1) fail('write_lost');
      await ending(); return receipt(next, true, false);

      async function ending() {
        if (!same(sourceOf(await query(SOURCE, [generation]), generation), source)
          || !same(snapshot(await query(SNAPSHOT)), tx)) fail('source_changed'); check();
      }
      function receipt(progress, advanced, reused) {
        return freeze({ status: 'shared_typed_generation_progress', authority: 'not_established',
          coverage: 'individual_original_interpretations_only', generation_id: generation, effective_date: effective,
          profile, source_metadata: source, progress, advanced, reused, all_layers_typed: progress.kind_index === KINDS.length,
          source_acquisition: 'not_established', report_update: 'none' });
      }
    } finally { busy = false; }
  } });
}

export const NEIGHBORHOOD_SHARED_TYPED_SQL = Object.freeze({ snapshot: SNAPSHOT, source: SOURCE, read: READ, lock: LOCK, page: PAGE, insert: INSERT, counts: COUNTS });
