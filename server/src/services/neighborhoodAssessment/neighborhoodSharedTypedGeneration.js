import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS } from './cohortOriginalSourceChainV1.js';
import { compileNeighborhoodFrozenTypedOriginalV1, getNeighborhoodFrozenTypedOriginalV1Profile,
  compileNeighborhoodFrozenTypedOriginalV2, getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { compileNeighborhoodFrozenTypedCadImprovementV1,getNeighborhoodFrozenTypedCadImprovementV1Profile }
  from './neighborhoodFrozenTypedCadImprovementV1.js';
import { getNeighborhoodFrozenCadImprovementProfile } from './neighborhoodFrozenCadImprovements.js';

export const NEIGHBORHOOD_SHARED_TYPED_LIMITS = Object.freeze({
  rows: 250, page_utf8_bytes: 2_100_000, step_utf8_bytes: 32_000_000,
  rows_per_layer: 2_000_000, total_rows: 14_000_000, total_typed_utf8_bytes: 8_000_000_000,
  total_payload_utf8_bytes: 8_000_000_000, row_key_bytes: 256, snapshot_text_bytes: 65536,
  step_ms: 60_000, queries: 16,
});
const L = NEIGHBORHOOD_SHARED_TYPED_LIMITS, FORMAT = 'shared_frozen_typed_progress_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SNAPSHOT_TEXT = /^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/;
const ROW_KEY_CONTROLS = /[\u0000-\u001f\u007f]/;
const isSnapshotText = value => typeof value === 'string' && Buffer.byteLength(value) <= L.snapshot_text_bytes && SNAPSHOT_TEXT.test(value);
const isRowKey = value => typeof value === 'string' && Buffer.byteLength(value) <= L.row_key_bytes && !ROW_KEY_CONTROLS.test(value);
// Fixed internal column identifiers only; never interpolate a caller-supplied name.
const utcTimestamp = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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
function progressOf(raw, format = FORMAT, kinds = KINDS, totalRows = L.total_rows) {
  if (raw === null) return null;
  const p = data(raw, ['format', 'binding_sha256', 'kind_index', 'after', 'layer_rows', 'typed_rows', 'typed_utf8_bytes']);
  if (p.format !== format || typeof p.binding_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.binding_sha256)
    || !Number.isInteger(p.kind_index) || p.kind_index < 0 || p.kind_index > kinds.length
    || !Number.isSafeInteger(p.layer_rows) || p.layer_rows < 0 || p.layer_rows > L.rows_per_layer
    || !count(p.typed_rows, totalRows) || !count(p.typed_utf8_bytes, L.total_typed_utf8_bytes)
    || Number(p.typed_utf8_bytes) < Number(p.typed_rows)
    || !isRowKey(p.after)
    || (p.after === '') !== (p.layer_rows === 0) || p.kind_index === kinds.length && p.after !== '') fail('invalid_progress');
  return Object.freeze(p);
}
const SNAPSHOT = `/* neighborhood-shared-typed:snapshot */ SELECT txid_current()::text AS transaction_id,
  pg_current_snapshot()::text AS source_snapshot,current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only,current_setting('TimeZone') AS timezone,pg_backend_pid() AS backend_pid`;
function snapshot(result) {
  const r = data(one(result), ['transaction_id', 'source_snapshot', 'isolation', 'read_only', 'timezone', 'backend_pid']);
  if (r.isolation !== 'repeatable read' || r.read_only !== 'off' || r.timezone !== 'UTC'
    || !/^[1-9][0-9]{0,19}$/.test(r.transaction_id ?? '') || !isSnapshotText(r.source_snapshot)
    || !Number.isInteger(r.backend_pid) || r.backend_pid < 1) fail('caller_transaction_required');
  return r;
}
const SOURCE = `/* neighborhood-shared-typed:source */ SELECT source.generation_id::text,source.format_version,source.status,
  source.source_snapshot,${utcTimestamp('source.source_transaction_started_at')} AS started_at,
  ${utcTimestamp('source.completed_at')} AS completed_at,
  source.layer_counts,source.row_count::text,source.payload_utf8_bytes::text
  FROM app.neighborhood_frozen_source_generations source JOIN app.neighborhood_group_generations generation USING(generation_id)
  WHERE source.generation_id=$1::uuid AND generation.status='complete' AND generation.retirement_started_at IS NULL
  FOR SHARE OF generation NOWAIT`;
function sourceOf(result, generation, cad = false) {
  const kinds=cad?CAD_KINDS:KINDS,totalRows=cad?4_000_000:L.total_rows;
  const r = data(one(result), ['generation_id', 'format_version', 'status', 'source_snapshot', 'started_at',
    'completed_at', 'layer_counts', 'row_count', 'payload_utf8_bytes',...(cad?['source_profile_sha256','source_definition_json']:[])]);
  if (r.generation_id !== generation || r.format_version !== 1 || r.status !== 'complete'
    || !isSnapshotText(r.source_snapshot)
    || !DATE.test(r.started_at ?? '') || !DATE.test(r.completed_at ?? '') || r.completed_at < r.started_at
    || !count(r.row_count, totalRows) || !count(r.payload_utf8_bytes, L.total_payload_utf8_bytes)) fail('source_unavailable');
  if(cad&&(r.source_profile_sha256!==getNeighborhoodFrozenCadImprovementProfile().profile_ref.content_sha256
    ||r.source_definition_json!==getNeighborhoodFrozenCadImprovementProfile().definition_blob.canonical_json))fail('source_unavailable');
  const layers = data(r.layer_counts, kinds); let rows = 0, bytes = 0;
  for (const k of kinds) {
    const c = data(layers[k], ['row_count', 'payload_utf8_bytes']);
    if (!count(c.row_count, L.rows_per_layer) || !count(c.payload_utf8_bytes, L.total_payload_utf8_bytes)
      || (c.row_count === '0' ? c.payload_utf8_bytes !== '0' : Number(c.payload_utf8_bytes) < Number(c.row_count))) fail('source_unavailable');
    layers[k] = c; rows += Number(c.row_count); bytes += Number(c.payload_utf8_bytes);
  }
  if (String(rows) !== r.row_count || String(bytes) !== r.payload_utf8_bytes) fail('source_unavailable');
  return freeze({ ...r, layer_counts: layers });
}
const READ = `/* neighborhood-shared-typed:read */ SELECT binding_sha256,source_metadata,definition_json,progress,status,
  ${utcTimestamp('completed_at')} AS completed_at
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

// Distinct fixed V2 tables/keys; a caller cannot pick a relation or reinterpret
// a retained V1 cache. Source snapshots, page bounds and transaction ownership
// are shared mechanics, not date/profile fallback or activation.
const READ_V2 = `/* neighborhood-shared-typed-v2:read */ SELECT binding_sha256,source_metadata,definition_json,progress,status,
  ${utcTimestamp('completed_at')} AS completed_at
  FROM app.neighborhood_frozen_typed_v2_generations WHERE generation_id=$1::uuid AND profile_sha256=$2`;
const PAGE_V2 = PAGE.replace('neighborhood-shared-typed:page', 'neighborhood-shared-typed-v2:page');
const INSERT_V2 = `/* neighborhood-shared-typed-v2:rows */ WITH input AS (
  SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(row_key text,original_text text,typed jsonb)
), written AS (
  INSERT INTO app.neighborhood_frozen_typed_v2_rows
    (generation_id,profile_sha256,kind,row_key,account_id,source_record_id,original_payload_sha256,typed)
  SELECT $1::uuid,$2,$3,original.row_key,original.account_id,original.source_record_id,
    input.typed->'original'->>'payload_sha256',input.typed FROM input
  JOIN app.neighborhood_frozen_source_rows original ON original.generation_id=$1::uuid AND original.kind=$3 AND original.row_key=input.row_key
  WHERE original.payload::text=input.original_text AND original.account_id IS NOT DISTINCT FROM input.typed->>'account_id'
    AND original.source_record_id::text IS NOT DISTINCT FROM input.typed->>'source_record_id'
    AND encode(sha256(convert_to(original.payload::text,'UTF8')),'hex')=input.typed->'original'->>'payload_sha256'
  RETURNING typed_utf8_bytes AS bytes
) SELECT count(*)::integer AS inserted_count,coalesce(sum(bytes),0)::text AS typed_utf8_bytes FROM written`;
const BEGIN_V1 = `/* neighborhood-shared-typed:begin */ INSERT INTO app.neighborhood_frozen_typed_generations
  (generation_id,profile_sha256,effective_date,binding_sha256,source_metadata,definition_json,progress)
  VALUES($1::uuid,$2,$3::date,$4,$5::jsonb,$6,$7::jsonb)`;
const BEGIN_V2 = `/* neighborhood-shared-typed-v2:begin */ INSERT INTO app.neighborhood_frozen_typed_v2_generations
  (generation_id,profile_sha256,binding_sha256,source_metadata,definition_json,progress)
  VALUES($1::uuid,$2,$3,$4::jsonb,$5,$6::jsonb)`;
const UPDATE_V1 = `/* neighborhood-shared-typed:progress */ UPDATE app.neighborhood_frozen_typed_generations
  SET progress=$4::jsonb,status=$5,completed_at=CASE WHEN $5='complete' THEN clock_timestamp() ELSE NULL END
  WHERE generation_id=$1::uuid AND profile_sha256=$2 AND effective_date=$3::date AND status='building' AND progress=$6::jsonb`;
const UPDATE_V2 = `/* neighborhood-shared-typed-v2:progress */ UPDATE app.neighborhood_frozen_typed_v2_generations
  SET progress=$3::jsonb,status=$4,completed_at=CASE WHEN $4='complete' THEN clock_timestamp() ELSE NULL END
  WHERE generation_id=$1::uuid AND profile_sha256=$2 AND status='building' AND progress=$5::jsonb`;

// A separate companion cache, never two extra kinds inside a retained V1/V2
// graph/profile. All relation and profile choices below are fixed server code.
const CAD_KINDS=Object.freeze(['primary','secondary']);
const SOURCE_CAD=SOURCE.replace('neighborhood-shared-typed:source','neighborhood-shared-typed-CAD:source')
  .replace('app.neighborhood_frozen_source_generations','app.neighborhood_frozen_cad_improvement_generations')
  .replace('source.layer_counts','source.profile_sha256 AS source_profile_sha256,source.definition_json AS source_definition_json,source.layer_counts');
const READ_CAD=READ_V2.replaceAll('neighborhood-shared-typed-v2:','neighborhood-shared-typed-CAD:')
  .replace('app.neighborhood_frozen_typed_v2_generations','app.neighborhood_frozen_typed_cad_generations');
const PAGE_CAD=PAGE.replace('neighborhood-shared-typed:page','neighborhood-shared-typed-CAD:page')
  .replace('app.neighborhood_frozen_source_rows','app.neighborhood_frozen_cad_improvement_rows');
const INSERT_CAD=`/* neighborhood-shared-typed-CAD:rows */ WITH input AS (
  SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(row_key text,original_text text,typed jsonb)
), written AS (
  INSERT INTO app.neighborhood_frozen_typed_cad_rows
    (generation_id,profile_sha256,kind,row_key,account_id,original_payload_sha256,typed)
  SELECT $1::uuid,$2,$3,original.row_key,original.account_id,original.payload_sha256,input.typed FROM input
  JOIN app.neighborhood_frozen_cad_improvement_rows original ON original.generation_id=$1::uuid AND original.kind=$3 AND original.row_key=input.row_key
  WHERE original.payload::text=input.original_text AND original.account_id=input.typed->>'account_id'
    AND original.payload_sha256=input.typed->'original'->>'payload_sha256'
  RETURNING typed_utf8_bytes AS bytes
) SELECT count(*)::integer AS inserted_count,coalesce(sum(bytes),0)::text AS typed_utf8_bytes FROM written`;
const BEGIN_CAD=BEGIN_V2.replaceAll('neighborhood-shared-typed-v2:','neighborhood-shared-typed-CAD:')
  .replace('app.neighborhood_frozen_typed_v2_generations','app.neighborhood_frozen_typed_cad_generations');
const UPDATE_CAD=UPDATE_V2.replaceAll('neighborhood-shared-typed-v2:','neighborhood-shared-typed-CAD:')
  .replace('app.neighborhood_frozen_typed_v2_generations','app.neighborhood_frozen_typed_cad_generations');

/** OFF/unmounted storage builder. Its trusted offline owner must authorize the
 * integrated source mix before and after the caller-owned transaction. No pool,
 * COMMIT, current-user grant, active-generation fallback, job phase or publication
 * is supplied. Reuse is exact generation + retained profile + EFFECTIVE DATE:
 * a different date cannot borrow future-year interpretations. A completed cache
 * is immutable; report owners must still prove scoped originals/closure and live
 * rights. This stage does not yet replace the per-job typed rows or graph copy.
 * Each builder permits one step, successful or failed. Fresh-client bounded
 * continuation requires a fresh builder, not a reset of a transaction budget.
 */
export function createNeighborhoodSharedTypedGeneration(client, rawOptions) {
  return sharedTypedGeneration(client, rawOptions, false);
}

/** Dormant generation/profile-only V2 syntax cache. An authorized offline owner
 * must fence integrated source rights at both transaction ends. No report date,
 * stock/selection, licensed acquisition, route, job dispatcher or worker is
 * supplied. Report consumers must separately apply retained date policies. */
export function createNeighborhoodSharedTypedGenerationV2(client, rawOptions) {
  return sharedTypedGeneration(client, rawOptions, true);
}

/** Dormant generation/profile-only CAD syntax companion. Offline authority,
 * actual job provenance and extra-field source rights are never minted here. */
export function createNeighborhoodSharedTypedCadGenerationV1(client,rawOptions){
  return sharedTypedGeneration(client,rawOptions,'cad');
}

/** Fixed companion metadata DATA validation shared with read-only consumers.
 * Does not authorize a job, issue a head or open any original payload. */
export function prepareNeighborhoodSharedTypedCadSource(result,generationId){
  return sourceOf(result,generationId,true);
}

function sharedTypedGeneration(client, rawOptions, neutral) {
  const cad=neutral==='cad',kinds=cad?CAD_KINDS:KINDS;
  if (typeof client?.query !== 'function') fail('client_required');
  const o = data(rawOptions, neutral ? ['generationId'] : ['generationId', 'effectiveDate'], ['signal', 'checkBudget']);
  if (typeof o.generationId !== 'string' || !UUID.test(o.generationId)
    || o.signal !== undefined && !(o.signal instanceof AbortSignal)
    || o.checkBudget !== undefined && typeof o.checkBudget !== 'function') fail('invalid_input');
  const generation = o.generationId, effective = neutral ? null : assessmentDate(o.effectiveDate), signal = o.signal;
  const profile = cad?getNeighborhoodFrozenTypedCadImprovementV1Profile():neutral ? getNeighborhoodFrozenTypedOriginalV2Profile() : getNeighborhoodFrozenTypedOriginalV1Profile();
  const key = [generation, profile.profile_ref.content_sha256, ...(neutral ? [] : [effective])];
  const format = cad?'shared_frozen_typed_CAD_progress_v1':neutral ? 'shared_frozen_typed_progress_v2' : FORMAT;
  const prepareProgress = raw => progressOf(raw, format,kinds,cad?4_000_000:L.total_rows);
  const read = cad?READ_CAD:neutral ? READ_V2 : READ, lock = `${read} FOR UPDATE NOWAIT`, page = cad?PAGE_CAD:neutral ? PAGE_V2 : PAGE;
  const deadline = performance.now() + L.step_ms; let busy = false, used = false, queries = 0, bytes = 0;
  const check = () => { if (signal?.aborted) fail('cancelled'); o.checkBudget?.();
    if (signal?.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('deadline'); };
  const query = async (text, values) => { check(); if (++queries > L.queries) fail('query_limit');
    const r = await client.query({ text, values, query_timeout: Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))) }); check(); return r; };
  return Object.freeze({ async step(rawProgress = null) {
    const supplied = prepareProgress(rawProgress);
    if (busy) fail('concurrent_operation'); if (used) fail('builder_already_used'); check(); busy = true; used = true;
    try {
      const tx = snapshot(await query(SNAPSHOT));
      // An autocommit client can report repeatable-read defaults but commits each
      // statement. A second probe must detect it BEFORE the first cache write;
      // an ending-only probe would be too late to roll those writes back.
      if (!same(tx, snapshot(await query(SNAPSHOT)))) fail('caller_transaction_changed');
      const source = sourceOf(await query(cad?SOURCE_CAD:SOURCE, [generation]), generation,cad);
      const binding = assessmentEvidenceDigest({ source, profile, ...(neutral ? {} : { effective_date: effective }) });
      const found = await query(read, key); let p;
      if (found.rowCount === 0 && found.rows?.length === 0) {
        if (supplied) fail('checkpoint_mismatch');
        p = prepareProgress({ format, binding_sha256: binding, kind_index: 0, after: '', layer_rows: 0, typed_rows: '0', typed_utf8_bytes: '0' });
        const r = await query(cad?BEGIN_CAD:neutral ? BEGIN_V2 : BEGIN_V1, [...key, binding, JSON.stringify(source), profile.definition_blob.canonical_json, JSON.stringify(p)]);
        if (r?.rowCount !== 1) fail('write_lost');
      } else {
        const h = data(one(found), ['binding_sha256', 'source_metadata', 'definition_json', 'progress', 'status', 'completed_at']); p = prepareProgress(h.progress);
        if (!p || p.binding_sha256 !== binding || h.binding_sha256 !== binding || !same(h.source_metadata, source)
          || h.definition_json !== profile.definition_blob.canonical_json || supplied && !same(supplied, p)
          || h.status !== (p.kind_index === kinds.length ? 'complete' : 'building')
          || (h.status === 'complete' ? !DATE.test(h.completed_at ?? '') : h.completed_at !== null)) fail('checkpoint_mismatch');
        const seen = kinds.slice(0, p.kind_index).reduce((n, k) => n + Number(source.layer_counts[k].row_count), 0) + p.layer_rows;
        if (String(seen) !== p.typed_rows || p.kind_index < kinds.length && p.layer_rows > Number(source.layer_counts[kinds[p.kind_index]].row_count)) fail('checkpoint_mismatch');
        // A lost acknowledgement or a second offline owner may reopen persisted
        // progress without guessing whether the previous transaction committed.
        if (!supplied || p.kind_index === kinds.length) {
          await ending(); return receipt(p, false, true);
        }
        // Completed immutable metadata can be reused concurrently. Only a
        // building-cache continuation needs an exclusive header lock; verify
        // that it is still the same persisted checkpoint before inserting rows.
        if (!same(one(await query(lock, key)), h)) fail('checkpoint_mismatch');
      }
      const kind = kinds[p.kind_index], r = one(await query(page, [generation, kind, p.after, L.rows, L.page_utf8_bytes]));
      if (typeof r.page_json !== 'string' || Buffer.byteLength(r.page_json) > L.page_utf8_bytes
        || !Number.isInteger(r.page_count) || r.page_count < 0 || r.page_count > L.rows
        || !Number.isInteger(r.candidate_count) || r.candidate_count < r.page_count || r.candidate_count > L.rows) fail('page_corrupt');
      let rows; try { rows = JSON.parse(r.page_json); } catch { fail('page_corrupt'); }
      if (!Array.isArray(rows) || rows.length !== r.page_count || !rows.length && r.candidate_count) fail('page_unavailable');
      let last = p.after;
      const input = rows.map(raw => {
        const row = data(raw, ['row_key', 'payload_text']);
        if (!isRowKey(row.row_key) || !row.row_key || Buffer.compare(Buffer.from(row.row_key), Buffer.from(last)) <= 0) fail('page_corrupt');
        last = row.row_key; check();
        return { row_key: row.row_key, original_text: row.payload_text,
          typed: cad?compileNeighborhoodFrozenTypedCadImprovementV1({kind,...row}):neutral ? compileNeighborhoodFrozenTypedOriginalV2({ kind, ...row })
            : compileNeighborhoodFrozenTypedOriginalV1({ kind, ...row, effective_date: effective }) };
      });
      if (r.next_cursor !== last) fail('page_corrupt');
      const encoded = JSON.stringify(input); bytes += Buffer.byteLength(r.page_json) + Buffer.byteLength(encoded);
      if (bytes > L.step_utf8_bytes) fail('byte_limit');
      let writtenBytes = 0;
      if (input.length) {
        const ack = one(await query(cad?INSERT_CAD:neutral ? INSERT_V2 : INSERT, [...key, kind, encoded]));
        if (ack.inserted_count !== input.length || !count(ack.typed_utf8_bytes, L.step_utf8_bytes)
          || Number(ack.typed_utf8_bytes) < input.length) fail('original_mismatch');
        writtenBytes = Number(ack.typed_utf8_bytes);
      }
      const seen = p.layer_rows + input.length, end = r.candidate_count < L.rows && r.page_count === r.candidate_count;
      if (seen > Number(source.layer_counts[kind].row_count) || end && seen !== Number(source.layer_counts[kind].row_count)) fail('layer_count_mismatch');
      const next = prepareProgress({ ...p, kind_index: p.kind_index + (end ? 1 : 0), after: end ? '' : last, layer_rows: end ? 0 : seen,
        typed_rows: String(Number(p.typed_rows) + input.length), typed_utf8_bytes: String(Number(p.typed_utf8_bytes) + writtenBytes) });
      // The database completion trigger independently reconciles every layer
      // against exact INSERT-transition totals (at most seven indexed rows).
      // It neither scans the city cache nor trusts caller-verified progress.
      let update;
      try { update = await query(cad?UPDATE_CAD:neutral ? UPDATE_V2 : UPDATE_V1,
      [...key, JSON.stringify(next), next.kind_index === kinds.length ? 'complete' : 'building', JSON.stringify(p)]); }
      catch (error) {
        if (error?.code === '55000' && error.message === (cad?'neighborhood_shared_typed_cad_population_incomplete':neutral ? 'neighborhood_shared_typed_v2_population_incomplete' : 'neighborhood_shared_typed_population_incomplete')) fail('population_incomplete');
        throw error;
      }
      if (update?.rowCount !== 1) fail('write_lost');
      await ending(); return receipt(next, true, false);

      async function ending() {
        if (!same(sourceOf(await query(cad?SOURCE_CAD:SOURCE, [generation]), generation,cad), source)
          || !same(snapshot(await query(SNAPSHOT)), tx)) fail('source_changed'); check();
      }
      function receipt(progress, advanced, reused) {
        return freeze({ status: cad?'shared_typed_CAD_generation_progress_v1':neutral ? 'shared_typed_generation_progress_v2' : 'shared_typed_generation_progress', authority: 'not_established',
          coverage: 'individual_original_interpretations_only', generation_id: generation,
          ...(neutral ? { temporal_basis: 'date_neutral_original_syntax' } : { effective_date: effective }),
          profile, source_metadata: source, progress, advanced, reused, all_layers_typed: progress.kind_index === kinds.length,
          source_acquisition: 'not_established', report_update: 'none' });
      }
    } finally { busy = false; }
  } });
}

export const NEIGHBORHOOD_SHARED_TYPED_SQL = Object.freeze({ snapshot: SNAPSHOT, source: SOURCE, read: READ, lock: LOCK, page: PAGE, insert: INSERT });
export const NEIGHBORHOOD_SHARED_TYPED_V2_SQL = Object.freeze({ snapshot: SNAPSHOT, source: SOURCE,
  read: READ_V2, lock: `${READ_V2} FOR UPDATE NOWAIT`, page: PAGE_V2, insert: INSERT_V2 });
export const NEIGHBORHOOD_SHARED_TYPED_CAD_SQL=Object.freeze({snapshot:SNAPSHOT,source:SOURCE_CAD,
  read:READ_CAD,lock:`${READ_CAD} FOR UPDATE NOWAIT`,page:PAGE_CAD,insert:INSERT_CAD});
