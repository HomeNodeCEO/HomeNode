import { types } from 'node:util';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { createNeighborhoodFrozenJobSourcePages } from './neighborhoodFrozenSourceClosurePages.js';
import { COHORT_ORIGINAL_SOURCE_CHAIN_V1_KINDS as KINDS } from './cohortOriginalSourceChainV1.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { compileNeighborhoodFrozenTypedOriginalV1, getNeighborhoodFrozenTypedOriginalV1Profile } from './neighborhoodFrozenTypedOriginalV1.js';

const FORMAT = 'frozen_job_typed_original_progress_v1', MAX = 2_000_000;
function fail(reason) { throw new TypeError(`neighborhood_frozen_job_typed_${reason}`); }
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX;
function progressOf(raw) {
  if (raw === null) return null;
  const p = data(raw, ['format', 'binding_sha256', 'kind_index', 'after', 'layer_rows']);
  if (p.format !== FORMAT || typeof p.binding_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.binding_sha256)
    || !Number.isInteger(p.kind_index) || p.kind_index < 0 || p.kind_index > KINDS.length || !integer(p.layer_rows)
    || typeof p.after !== 'string' || Buffer.byteLength(p.after) > 256 || /[\u0000-\u001f\u007f]/.test(p.after)
    || (p.after === '') !== (p.layer_rows === 0) || p.kind_index === KINDS.length && p.after !== '') fail('invalid_progress');
  return Object.freeze(p);
}
function one(result) { if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('invalid_result'); return result.rows[0]; }
const READ = `/* neighborhood-frozen-job-typed:read */ SELECT binding_sha256,profile_sha256,
  to_char(effective_date,'YYYY-MM-DD') AS effective_date,expected_counts,progress,status
  FROM app.neighborhood_custom_cohort_typed_originals WHERE operation_id=$1::uuid AND generation_id=$2::uuid FOR UPDATE NOWAIT`;
const INSERT = `/* neighborhood-frozen-job-typed:rows */ WITH input AS (
  SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(row_key text,original_text text,typed jsonb)
), written AS (
  INSERT INTO app.neighborhood_custom_cohort_typed_original_rows
    (operation_id,generation_id,kind,row_key,account_id,source_record_id,original_payload_sha256,typed)
  SELECT $1::uuid,$2::uuid,$3,original.row_key,original.account_id,original.source_record_id,
    input.typed->'original'->>'payload_sha256',input.typed
  FROM input JOIN app.neighborhood_frozen_source_rows original
    ON original.generation_id=$2::uuid AND original.kind=$3 AND original.row_key=input.row_key
  WHERE original.payload::text=input.original_text
    AND original.account_id IS NOT DISTINCT FROM input.typed->>'account_id'
    AND original.source_record_id::text IS NOT DISTINCT FROM input.typed->>'source_record_id'
  RETURNING 1
) SELECT count(*)::integer AS inserted_count FROM written`;
const COUNTS = `/* neighborhood-frozen-job-typed:counts */ SELECT kind,count(*)::text AS row_count
  FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1::uuid GROUP BY kind`;

/** One bounded indexed row-materialization step. The actual owner alone
 * supplies verified original graph/counts, finished identity closure and CURRENT
 * actor/license at both transaction ends. This DATA primitive cannot acquire,
 * select or publish. All seven scopes include outside/unresolved one-hop rows;
 * no new geometry query, dense IDs, respatialization or numerical rounding.
 * The bounded exact-original text still includes retained parcel EWKB, which
 * is hashed with the row but is neither copied into typed cells nor rendered.
 */
export function createNeighborhoodFrozenJobTypedOriginals(client, rawOptions, rawGraph, effectiveDate) {
  const options = data(rawOptions, ['claim', 'scope', 'actorUserId', 'geometryInput', 'discovery', 'subjectIntent', 'checkBudget']);
  if (typeof options.checkBudget !== 'function') fail('invalid_input');
  const graph = data(rawGraph, ['root', 'layer_counts']), ref = data(graph.root, ['content_sha256', 'canonical_utf8_bytes']);
  const root = prepareNeighborhoodCohortBlobReference(ref.content_sha256, ref.canonical_utf8_bytes), counts = data(graph.layer_counts, KINDS);
  if (KINDS.some(k => !integer(counts[k]))) fail('invalid_input');
  const effective = assessmentDate(effectiveDate), profile = getNeighborhoodFrozenTypedOriginalV1Profile();
  const store = createNeighborhoodFrozenJobStock(client, options), check = options.checkBudget; let busy = false;
  return Object.freeze({ async step(rawProgress) {
    const saved = progressOf(rawProgress); check(); if (busy) fail('concurrent_operation'); busy = true;
    try {
      const stock = await store.read(); check();
      const digest = assessmentEvidenceDigest({ stock, graph: { root, layer_counts: counts }, effective_date: effective, profile_ref: profile.profile_ref });
      const p = saved ?? { format: FORMAT, binding_sha256: digest, kind_index: 0, after: '', layer_rows: 0 };
      if (p.binding_sha256 !== digest || p.kind_index < KINDS.length && p.layer_rows > counts[KINDS[p.kind_index]]) fail('binding_changed');
      const parameters = [stock.operation_id, stock.generation_id];
      const read = await client.query({ text: READ, values: parameters, query_timeout: 5000 }); check();
      if (saved) {
        const row = one(read);
        if (row.binding_sha256 !== digest || row.profile_sha256 !== profile.profile_ref.content_sha256 || row.effective_date !== effective
          || !same(row.expected_counts, counts) || !same(row.progress, p) || row.status !== (p.kind_index === KINDS.length ? 'complete' : 'building')) fail('checkpoint_mismatch');
      } else {
        if (read.rowCount !== 0 || read.rows?.length !== 0) fail('checkpoint_mismatch');
        const begin = await client.query({ text: `/* neighborhood-frozen-job-typed:begin */ INSERT INTO app.neighborhood_custom_cohort_typed_originals
          (operation_id,generation_id,binding_sha256,profile_sha256,effective_date,expected_counts,progress)
          VALUES($1::uuid,$2::uuid,$3,$4,$5::date,$6::jsonb,$7::jsonb)`,
        values: [...parameters, digest, profile.profile_ref.content_sha256, effective, JSON.stringify(counts), JSON.stringify(p)], query_timeout: 5000 }); check();
        if (begin?.rowCount !== 1) fail('write_lost');
      }
      if (p.kind_index === KINDS.length) return Object.freeze({ status: 'typed_original_progress', authority: 'not_established',
        coverage: 'individual_original_interpretations_only', progress: saved, advanced: false, all_layers_typed: true, profile_ref: profile.profile_ref });
      const kind = KINDS[p.kind_index], page = await createNeighborhoodFrozenJobSourcePages(client, options).page({ kind, cursor: p.after, rowLimit: 250 }); check();
      const input = page.rows.map(row => ({ row_key: row.row_key, original_text: row.payload_text,
        typed: compileNeighborhoodFrozenTypedOriginalV1({ kind, ...row, effective_date: effective }) }));
      const text = JSON.stringify(input);
      if (Buffer.byteLength(text) > 32_000_000) fail('page_limit');
      if (input.length) {
        const written = one(await client.query({ text: INSERT, values: [...parameters, kind, text], query_timeout: 5000 })); check();
        if (written.inserted_count !== input.length) fail('original_mismatch');
      }
      const seen = p.layer_rows + input.length;
      if (seen > counts[kind] || page.end_of_layer && seen !== counts[kind]) fail('layer_count_mismatch');
      const next = progressOf({ ...p, kind_index: p.kind_index + (page.end_of_layer ? 1 : 0),
        after: page.end_of_layer ? '' : page.next_cursor, layer_rows: page.end_of_layer ? 0 : seen });
      if (next.kind_index === KINDS.length) {
        const actual = await client.query({ text: COUNTS, values: [stock.operation_id], query_timeout: 5000 }); check();
        if (!Array.isArray(actual.rows) || actual.rows.length > KINDS.length || actual.rowCount !== actual.rows.length) fail('invalid_result');
        const recorded = new Map();
        for (const row of actual.rows) {
          if (!KINDS.includes(row.kind) || recorded.has(row.kind) || !/^[1-9][0-9]{0,6}$/.test(row.row_count ?? '') || Number(row.row_count) > MAX) fail('invalid_result');
          recorded.set(row.kind, Number(row.row_count));
        }
        if (KINDS.some(k => (recorded.get(k) ?? 0) !== counts[k])) fail('population_incomplete');
      }
      const update = await client.query({ text: `/* neighborhood-frozen-job-typed:progress */ UPDATE app.neighborhood_custom_cohort_typed_originals
        SET progress=$3::jsonb,status=$4,completed_at=CASE WHEN $4='complete' THEN clock_timestamp() ELSE NULL END
        WHERE operation_id=$1::uuid AND generation_id=$2::uuid AND status='building' AND progress=$5::jsonb`,
      values: [...parameters, JSON.stringify(next), next.kind_index === KINDS.length ? 'complete' : 'building', JSON.stringify(p)], query_timeout: 5000 }); check();
      if (update?.rowCount !== 1) fail('write_lost');
      if (!same(await store.read(), stock)) fail('binding_changed'); check();
      return Object.freeze({ status: 'typed_original_progress', authority: 'not_established', coverage: 'individual_original_interpretations_only',
        progress: next, advanced: true, all_layers_typed: next.kind_index === KINDS.length, profile_ref: profile.profile_ref });
    } finally { busy = false; }
  } });
}
