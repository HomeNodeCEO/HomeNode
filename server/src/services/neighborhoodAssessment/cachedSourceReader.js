import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { buildCachedSourceCaptures } from './cachedSourceCaptures.js';
import { buildCohortLocalQueryEvidenceV1 } from './cohortQueryEvidence.js';
import { assertNeighborhoodCachedReadAccess, consumeNeighborhoodCachedReadAccess } from './cachedReadAccess.js';
import { validateCachedTransactionClosure } from './cachedTransactionClosure.js';
import { CACHED_ROW_MAPPING_VERSION, mapCachedAccountRow, mapCachedParcelRow,
  mapCachedSaleLinkRow, mapCachedSaleRow } from './cachedRowMappings.js';

export const NEIGHBORHOOD_CACHE_READER_VERSION = 'local-capture-v3';
export const NEIGHBORHOOD_CACHE_READER_LIMITS = Object.freeze({
  records: 100_000, bytes: 30_000_000, row_bytes: 64_000, page_size: 250,
  selected_accounts: 50_000, duration_ms: 30_000, statement_ms: 5000, connect_ms: 3000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIGINT = /^(?:0|[1-9][0-9]{0,18})$/;
const SCOPE = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const TABLES = Object.freeze({
  parcels: ['gis.dcad_parcels', 'object_id account_id low_parcel_id residential_year_built residential_area_sqft parcel_area_sqft current_market_value land_use_category classification_confidence classification_review_reason subdivision_name source_record_hash source_updated_at sync_run_id synced_at geom'],
  accounts: ['core.accounts', 'account_id county subdivision neighborhood_code legal_description'],
  source_records: ['core.sales_source_records', 'id source_name source_filename source_sha256 source_record_hash transaction_fingerprint listing_key listing_id source_system_name source_modified_at loaded_at updated_at primary_account_id record_type close_date listing_contract_date current_price living_area parcel_number_raw parcel_number2_raw match_status has_multiple_parcel_numbers multi_parcel_status has_unresolved_parcel requires_additional_review data_quality_flags'],
  sales: ['core.sales', 'id source_record_id account_id closing_date sale_price source loaded_at'],
  sale_links: ['core.sale_parcels', 'id source_record_id source_position parcel_sequence parcel_role parcel_number_raw parcel_number_normalized account_id match_method is_resolved loaded_at'],
  sync_state: ['gis.source_sync_state', 'source_key status source_vintage row_count last_attempt_at last_success_at last_source_update_at last_run_id updated_at'],
  sync_runs: ['gis.source_sync_runs', 'id source_key mode status records_seen records_written records_deleted started_at completed_at'],
});
const SQL = Object.freeze({
  scope: `SELECT c.effective_date::text AS case_date, s.effective_date::text AS snapshot_date,
    COALESCE(s.effective_date,c.effective_date)::text AS effective_date,
    to_char(observation.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
    to_char(observation.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at_precise
    FROM app.appraisal_cases c JOIN app.appraisal_subject_snapshots s ON s.appraisal_case_id=c.id
    CROSS JOIN LATERAL (SELECT clock_timestamp() AS observed_at) observation
    WHERE c.organization_id=$1 AND c.id=$2 AND s.id=$3 AND c.account_id=$4 LIMIT 2`,
  capabilities: `SELECT n.nspname || '.' || c.relname AS relation, a.attname AS column
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname || '.' || c.relname = ANY($1::text[]) AND c.relkind IN ('r','p','v','m')`,
  parcels: `SELECT object_id::text,account_id,low_parcel_id,residential_year_built,
    residential_area_sqft::text,parcel_area_sqft::text,current_market_value::text,
    land_use_category,classification_confidence,classification_review_reason,subdivision_name,
    source_record_hash,source_updated_at::text,sync_run_id::text,synced_at::text,
    encode(ST_AsEWKB(geom),'hex') AS stored_geometry_ewkb
    FROM gis.dcad_parcels parcel WHERE account_id=ANY($1::text[]) AND parcel.object_id>$2::bigint
    ORDER BY parcel.object_id LIMIT $3`,
  accounts: `SELECT account_id,county,subdivision,neighborhood_code,legal_description
    FROM core.accounts WHERE account_id=ANY($1::text[]) AND account_id COLLATE "C">$2::text COLLATE "C"
    ORDER BY account_id COLLATE "C" LIMIT $3`,
  source_ids: `WITH ids AS (
    SELECT id FROM core.sales_source_records WHERE primary_account_id=ANY($1::text[])
    UNION SELECT source_record_id FROM core.sale_parcels WHERE account_id=ANY($1::text[])
    UNION SELECT source_record_id FROM core.sales WHERE account_id=ANY($1::text[]) AND source_record_id IS NOT NULL
    ) SELECT id::text AS source_record_id FROM ids WHERE id>$2::bigint ORDER BY id LIMIT $3`,
  transaction_identities: `SELECT src.id::text AS source_record_id,sale.id::text AS sale_id,
    src.primary_account_id,sale.account_id AS sale_account_id,src.source_record_hash
    FROM core.sales_source_records src LEFT JOIN core.sales sale ON sale.source_record_id=src.id
    WHERE src.id=ANY($1::bigint[]) ORDER BY src.id,sale.id LIMIT $2`,
  link_identities: `SELECT id::text AS parcel_link_id,source_record_id::text,source_position,
    parcel_sequence,account_id,is_resolved FROM core.sale_parcels sp
    WHERE source_record_id=ANY($1::bigint[])
      AND (source_record_id,source_position,parcel_sequence)>($2::bigint,$3::smallint,$4::smallint)
    ORDER BY sp.source_record_id,sp.source_position,sp.parcel_sequence LIMIT $5`,
  legacy_identities: `SELECT id::text AS sale_id,account_id AS sale_account_id FROM core.sales
    WHERE account_id=ANY($1::text[]) AND source_record_id IS NULL AND id>$2::bigint
    ORDER BY id LIMIT $3`,
  transactions: `SELECT src.id::text AS source_record_id,src.source_name,src.source_filename,
    src.source_sha256,src.source_record_hash,src.transaction_fingerprint,
    src.listing_key,src.listing_id,src.source_system_name,src.source_modified_at::text,
    src.loaded_at::text AS source_loaded_at,src.updated_at::text AS source_updated_at,
    src.primary_account_id,src.record_type,src.close_date::text AS source_close_date,
    src.listing_contract_date::text,src.current_price::text AS source_current_price,
    src.living_area::text AS source_living_area,src.parcel_number_raw,src.parcel_number2_raw,
    src.match_status,src.has_multiple_parcel_numbers,src.multi_parcel_status,
    src.has_unresolved_parcel,src.requires_additional_review,src.data_quality_flags,
    sale.id::text AS sale_id,sale.account_id AS sale_account_id,
    sale.closing_date::text AS sale_closing_date,sale.sale_price::text,
    sale.source AS sale_source,sale.loaded_at::text AS sale_loaded_at
    FROM core.sales_source_records src LEFT JOIN core.sales sale ON sale.source_record_id=src.id
    WHERE src.id=ANY($1::bigint[]) ORDER BY src.id,sale.id LIMIT $2`,
  sale_links: `SELECT id::text AS parcel_link_id,source_record_id::text,source_position,
    parcel_sequence,parcel_role,parcel_number_raw,parcel_number_normalized,account_id,
    match_method,is_resolved,loaded_at::text AS link_loaded_at FROM core.sale_parcels sp
    WHERE source_record_id=ANY($1::bigint[])
      AND (source_record_id,source_position,parcel_sequence)>($2::bigint,$3::smallint,$4::smallint)
    ORDER BY sp.source_record_id,sp.source_position,sp.parcel_sequence LIMIT $5`,
  legacy: `SELECT id::text AS sale_id,source_record_id::text,account_id AS sale_account_id,
    closing_date::text AS sale_closing_date,sale_price::text,source AS sale_source,
    loaded_at::text AS sale_loaded_at FROM core.sales
    WHERE account_id=ANY($1::text[]) AND source_record_id IS NULL AND id>$2::bigint
    ORDER BY id LIMIT $3`,
  sync_state: `SELECT source_key,status,source_vintage,row_count::text,last_attempt_at::text,
    last_success_at::text,last_source_update_at::text,last_run_id::text,updated_at::text
    FROM gis.source_sync_state WHERE source_key='dcad_parcels' LIMIT 2`,
  sync_runs: `SELECT id::text,source_key,mode,status,records_seen::text,records_written::text,
    records_deleted::text,started_at::text,completed_at::text
    FROM gis.source_sync_runs WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT $2`,
});
const ORDER = Object.freeze({
  parcels:"(payload->>'object_id')::bigint", accounts:"payload->>'account_id' COLLATE \"C\"",
  'source-ids':"(payload->>'source_record_id')::bigint",
  'transaction-identities':"(payload->>'source_record_id')::bigint,(payload->>'sale_id')::bigint",
  'link-identities':"(payload->>'source_record_id')::bigint,(payload->>'source_position')::smallint,(payload->>'parcel_sequence')::smallint",
  'legacy-identities':"(payload->>'sale_id')::bigint",
  transactions:"(payload->>'source_record_id')::bigint,(payload->>'sale_id')::bigint",
  'sale-links':"(payload->>'source_record_id')::bigint,(payload->>'source_position')::smallint,(payload->>'parcel_sequence')::smallint",
  legacy:"(payload->>'sale_id')::bigint", 'sync-state':"payload->>'source_key' COLLATE \"C\"", 'sync-runs':"payload->>'id' COLLATE \"C\"",
});
const MAPPERS={ parcels:mapCachedParcelRow, accounts:mapCachedAccountRow,
  transactions:mapCachedSaleRow, sale_links:mapCachedSaleLinkRow };

const INTERNAL_INVALID = new WeakSet();
const INTERNAL_INCOMPLETE = new WeakMap();
function invalid(field) {
  const error=new TypeError(`invalid_neighborhood_cache_reader:${field}`);
  INTERNAL_INVALID.add(error);
  throw error;
}
function incomplete(reason) {
  const error = new Error('neighborhood_cache_capture_incomplete');
  INTERNAL_INCOMPLETE.set(error,reason);
  throw error;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function text(value, field, max = 100) {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length>max || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}
function big(value) {
  if (typeof value !== 'string' || !BIGINT.test(value) || BigInt(value)>9223372036854775807n) incomplete('invalid_source_identity');
  return value;
}
// SQL sets UTC; accept its explicit UTC text and canonical ISO without allowing
// Date.parse to normalize invalid Gregorian dates, offsets or subsecond order.
function sourceTime(value) {
  if (typeof value!=='string') return null;
  const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::00)?)$/.exec(value);
  if (!match) return null;
  const second=`${match[1]}T${match[2]}.000Z`;
  const milliseconds=Date.parse(second);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString()!==second) return null;
  return BigInt(milliseconds)*1000n+BigInt((match[3]||'').padEnd(6,'0'));
}
function sourceCount(value) {
  return typeof value==='string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value)<=9223372036854775807n ? BigInt(value) : null;
}
function releaseSafely(client,error) {
  try { client.release(error); return true; } catch { return false; }
}
function limitsOf(overrides) {
  const result = { ...NEIGHBORHOOD_CACHE_READER_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value<1 || value>result[key]) invalid('limits');
    result[key]=value;
  }
  return result;
}
function requestOf(input, limits) {
  if (!input || !input.scope) invalid('scope');
  const scope = Object.fromEntries(SCOPE.map(key => {
    const value = text(input.scope[key], key);
    if (key !== 'account_id' && !UUID.test(value)) invalid(key);
    return [key,key === 'account_id' ? value : value.toLowerCase()];
  }));
  const effective_date = assessmentDate(input.effective_date);
  const start_date = assessmentDate(input.observation_period?.start_date);
  const end_date = assessmentDate(input.observation_period?.end_date);
  if (start_date>end_date || end_date>effective_date) invalid('observation_period');
  if (!Array.isArray(input.account_ids) || !input.account_ids.length || input.account_ids.length>limits.selected_accounts) invalid('account_ids');
  const account_ids = input.account_ids.map(value => text(value,'account_id',64)).sort(compare);
  if (new Set(account_ids).size!==account_ids.length || !account_ids.includes(scope.account_id)) invalid('account_ids');
  const knowledge_cutoff = input.knowledge_cutoff ?? null;
  if (knowledge_cutoff!==null && (typeof knowledge_cutoff!=='string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(knowledge_cutoff)
    || !Number.isFinite(Date.parse(knowledge_cutoff)) || new Date(knowledge_cutoff).toISOString()!==knowledge_cutoff)) invalid('knowledge_cutoff');
  return { scope,effective_date,observation_period:{ start_date,end_date },account_ids,knowledge_cutoff };
}
async function connectBounded(pool, timeout) {
  let expired=false;
  let timer;
  const pending=Promise.resolve().then(() => pool.connect()).then(client => {
    if (expired) { releaseSafely(client); incomplete('connection_timeout'); }
    return client;
  });
  try {
    return await Promise.race([pending,new Promise((_,reject) => {
      timer=setTimeout(() => { expired=true; const error=new Error('neighborhood_cache_connection_timeout');
        INTERNAL_INCOMPLETE.set(error,'connection_timeout'); reject(error); },timeout);
    })]);
  } finally { clearTimeout(timer); }
}

/** Background-only, injected cache reader. Requires the original server-issued
 * selection and independent licensed-market capabilities before any connection.
 * The relational scope check is additional integrity, not authorization. The
 * one-hop transaction closure never seeds more sales or adds stock members.
 * No schema creation, provider calls, jobs, report writes,
 * mutation locks, current-date cohorts, enrichment views, or database pool globals.
 * A successful capture certifies this selected SQL query only, not real-world
 * transaction completeness, historical facts, housing type or provider coverage.
 */
export function createNeighborhoodCachedSourceReader(pool, { limits: overrides = {}, access } = {}) {
  if (typeof pool?.connect!=='function') invalid('pool');
  assertNeighborhoodCachedReadAccess(access);
  const limits=limitsOf(overrides);
  return { async capture(input) {
    const authorized=consumeNeighborhoodCachedReadAccess(access,input?.auth,input,{
      selection_grant:input?.selection_grant,market_grant:input?.market_grant });
    const request=requestOf(authorized,limits);
    const started=performance.now();
    const counts={ records:0, bytes:0, queries:0 };
    let client;
    let began=false;
    let releaseError;
    let primaryFailure=null;
    let invalidFailure=null;
    let capturedAt=null;
    let capturedAtPrecise=null;
    let observationTime=null;
    let capabilities={};
    const groups=Object.fromEntries(['parcels','accounts','transactions','sale_links','gis_sync'].map(key => [key,[]]));
    const identities=Object.fromEntries(Object.keys(groups).map(key => [key,new Set()]));
    const missing=new Set();
    const failedCapture=reasons => freeze({ status:'incomplete',query_complete:false,scope:request.scope,
      reader_version:NEIGHBORHOOD_CACHE_READER_VERSION,captured_at:capturedAt,source_capture:null,
      capabilities,incomplete_reasons:reasons,counts });
    const check=() => { if (performance.now()-started>limits.duration_ms) incomplete('duration_limit'); };
    const query=async (tag,sql,values=[]) => {
      check(); counts.queries++;
      const result=await client.query({ text:`/* neighborhood-cache:${tag} */ ${sql}`,values,
        query_timeout:limits.statement_ms+1000 });
      check();
      return result.rows;
    };
    const rows=async (tag,sql,values=[]) => {
      // Limit each projected row in PostgreSQL BEFORE sending large geometry or
      // quality arrays to Node. No arbitrary raw_payload/remarks are selected.
      const maximum=limits.row_bytes;
      const result=await query(tag,`WITH projected AS MATERIALIZED (${sql}), encoded AS (
        SELECT to_jsonb(projected) AS payload FROM projected)
        SELECT CASE WHEN octet_length(payload::text)<=${maximum} THEN payload ELSE NULL END AS payload,
          octet_length(payload::text) AS row_bytes FROM encoded ORDER BY ${ORDER[tag]}`,values);
      return result.map(row => {
        if (!row.payload || !Number.isSafeInteger(row.row_bytes) || row.row_bytes>maximum) incomplete('row_bytes_limit');
        return row.payload;
      });
    };
    const retain=(group,id,payload) => {
      check();
      if (identities[group].has(id)) incomplete('duplicate_source_identity');
      // Preserve the entire mapper wrapper: raw values, mapped values, explicit
      // gaps and mapping digest. None of these claims is an eligibility approval.
      const record={ record_id:id,data:MAPPERS[group]?MAPPERS[group](payload):payload };
      const bytes=Buffer.byteLength(canonicalAssessmentJson(record));
      if (++counts.records>limits.records) incomplete('record_limit');
      if ((counts.bytes+=bytes)>limits.bytes) incomplete('byte_limit');
      identities[group].add(id); groups[group].push(record);
    };
    const available=key => {
      if (capabilities[key].state!=='available') { missing.add(`${key}:${capabilities[key].state}`); return false; }
      return true;
    };
    const page=async (tag,sql,values,cursorIndex,cursorOf,onRow) => {
      let cursor=values[cursorIndex];
      while (true) {
        const result=await rows(tag,sql,values);
        for (const row of result.slice(0,limits.page_size)) onRow(row);
        if (result.length<=limits.page_size) return;
        const next=cursorOf(result[limits.page_size-1]);
        if (next===cursor) incomplete('nonadvancing_cursor');
        cursor=next; values[cursorIndex]=next;
      }
    };
    try {
      client=await connectBounded(pool,limits.connect_ms);
      // Once BEGIN is attempted, even a client timeout leaves server state
      // uncertain. Always rollback (or destroy on failed rollback) before release.
      began=true;
      await query('begin','BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await query('settings',`SET LOCAL statement_timeout='${limits.statement_ms}ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'`);
      const scopeRows=await query('scope',SQL.scope,SCOPE.map(key => request.scope[key]));
      if (scopeRows.length!==1) invalid('scope_mismatch');
      const canonical=scopeRows[0];
      if (!canonical.effective_date || canonical.effective_date!==request.effective_date
        || (canonical.case_date && canonical.snapshot_date && canonical.case_date!==canonical.snapshot_date)) invalid('effective_date_conflict');
      capturedAt=canonical.captured_at;
      capturedAtPrecise=canonical.captured_at_precise;
      observationTime=sourceTime(capturedAtPrecise);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt ?? '')
        || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString()!==capturedAt
        || observationTime===null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(capturedAtPrecise ?? '')
        || observationTime/1000n!==BigInt(Date.parse(capturedAt))) incomplete('capture_time_unavailable');
      if (request.knowledge_cutoff!==null) incomplete('historical_knowledge_capture_required');
      for (const account_id of request.account_ids) {
        if (++counts.records>limits.records) incomplete('record_limit');
        counts.bytes+=Buffer.byteLength(canonicalAssessmentJson({ record_id:`selected:${account_id}`,data:{ account_id } }));
        if (counts.bytes>limits.bytes) incomplete('byte_limit');
      }
      const catalog=await query('capabilities',SQL.capabilities,[Object.values(TABLES).map(([table]) => table)]);
      capabilities=Object.fromEntries(Object.entries(TABLES).map(([key,[table,columns]]) => {
        const present=new Set(catalog.filter(row => row.relation===table).map(row => row.column));
        const absent=columns.split(' ').filter(column => !present.has(column));
        return [key,{ relation:table,state:!present.size?'absent':absent.length?'unsupported_schema':'available',missing_columns:absent }];
      }));
      const n=limits.page_size+1;
      const originRuns=new Set();
      let syncState=null;
      if (available('parcels')) {
        await page('parcels',SQL.parcels,[request.account_ids,'-1',n],1,row => big(row.object_id),row => {
          retain('parcels',`parcel:${big(row.object_id)}`,row);
          if (typeof row.sync_run_id==='string' && UUID.test(row.sync_run_id)) originRuns.add(row.sync_run_id);
          else missing.add('parcels:origin_run_unknown');
        });
        const seen=new Set(groups.parcels.map(row => row.data.raw_projection.account_id));
        if (request.account_ids.some(id => !seen.has(id))) missing.add('parcels:selected_accounts_not_covered');
      }
      if (available('accounts')) await page('accounts',SQL.accounts,[request.account_ids,'',n],1,row => text(row.account_id,'source_account'),row => retain('accounts',`account:${row.account_id}`,row));
      if (available('sync_state')) {
        const states=await rows('sync-state',SQL.sync_state);
        if (states.length!==1) missing.add('parcels:sync_state_unknown');
        else { [syncState]=states; retain('gis_sync','state:dcad_parcels',syncState);
          if (typeof syncState.last_run_id==='string' && UUID.test(syncState.last_run_id)) originRuns.add(syncState.last_run_id);
          else missing.add('parcels:last_run_unknown');
          if (syncState.status!=='current') missing.add('parcels:sync_not_complete');
          const success=sourceTime(syncState.last_success_at);
          if (success===null || success>observationTime) missing.add('parcels:sync_success_unverifiable');
          const sourceRows=sourceCount(syncState.row_count);
          if (sourceRows===null || sourceRows<BigInt(groups.parcels.length)) missing.add('parcels:sync_count_contradiction');
        }
      }
      if (available('sync_runs')) {
        const ids=[...originRuns].sort(compare);
        const completed=new Set();
        for (let at=0;at<ids.length;at+=limits.page_size) {
          const batch=ids.slice(at,at+limits.page_size);
          const found=await rows('sync-runs',SQL.sync_runs,[batch,batch.length+1]);
          if (found.length>batch.length) incomplete('duplicate_source_identity');
          for (const run of found) { retain('gis_sync',`run:${run.id}`,run);
            const start=sourceTime(run.started_at),end=sourceTime(run.completed_at);
            const success=sourceTime(syncState?.last_success_at);
            if (run.status==='complete' && run.source_key==='dcad_parcels'
              && start!==null && end!==null && start<=end && end<=observationTime
              && success!==null && end<=success) completed.add(run.id);
          }
        }
        if (ids.some(id => !completed.has(id))) missing.add('parcels:origin_run_not_complete');
      }
      // Every discovery arm is required. Do not call missing secondary-link
      // capability an exhaustive primary-account-only result.
      const salesAvailable=['source_records','sales','sale_links'].map(available).every(Boolean);
      if (salesAvailable) {
        // Check only seeded transaction/association identities first, under the
        // separate market capability. Never discover sales using closure-only
        // accounts. A changed/missing association makes this whole attempt
        // incomplete before reading price/MLS projections or returning data.
        const identityRows={transactions:[],links:[],legacy:[]};
        const seedIds=[];
        const retainIdentity=(group,row) => {
          check();
          if (++counts.records>limits.records) incomplete('record_limit');
          counts.bytes+=Buffer.byteLength(canonicalAssessmentJson(row));
          if (counts.bytes>limits.bytes) incomplete('byte_limit');
          identityRows[group].push(row);
        };
        let after='0';
        while (true) {
          const found=await rows('source-ids',SQL.source_ids,[request.account_ids,after,n]);
          const ids=found.slice(0,limits.page_size).map(row => big(row.source_record_id));
          if (ids.length) {
            seedIds.push(...ids);
            const identities=await rows('transaction-identities',SQL.transaction_identities,[ids,ids.length+1]);
            if (identities.length>ids.length) incomplete('duplicate_source_identity');
            if (identities.length<ids.length || ids.some(id => !identities.some(row => row.source_record_id===id))) incomplete('source_identity_missing');
            for (const row of identities) retainIdentity('transactions',row);
            let cursor=['0',0,0];
            while (true) {
              const links=await rows('link-identities',SQL.link_identities,[ids,...cursor,n]);
              for (const row of links.slice(0,limits.page_size)) retainIdentity('links',row);
              if (links.length<=limits.page_size) break;
              const last=links[limits.page_size-1];
              const next=[big(last.source_record_id),last.source_position,last.parcel_sequence];
              if (next.join(':')===cursor.join(':')) incomplete('nonadvancing_cursor');
              cursor=next;
            }
          }
          if (found.length<=limits.page_size) break;
          const next=ids.at(-1);
          if (next===after) incomplete('nonadvancing_cursor');
          after=next;
        }
        await page('legacy-identities',SQL.legacy_identities,[request.account_ids,'0',n],1,
          row => big(row.sale_id),row => retainIdentity('legacy',row));
        const observedClosure=validateCachedTransactionClosure({selected_account_ids:request.account_ids,
          source_revision:authorized.transaction_closure.source_revision,...identityRows});
        if (observedClosure.closure_sha256!==authorized.transaction_closure.closure_sha256) incomplete('transaction_association_drift');
        for (let at=0;at<seedIds.length;at+=limits.page_size) {
          const ids=seedIds.slice(at,at+limits.page_size);
            const transactions=await rows('transactions',SQL.transactions,[ids,ids.length+1]);
            if (transactions.length>ids.length) incomplete('duplicate_source_identity');
            const seen=new Set();
            for (const row of transactions) { const id=big(row.source_record_id); seen.add(id); retain('transactions',`source:${id}`,row); }
            if (ids.some(id => !seen.has(id))) incomplete('source_identity_missing');
            let cursor=['0',0,0];
            while (true) {
              const links=await rows('sale-links',SQL.sale_links,[ids,...cursor,n]);
              for (const row of links.slice(0,limits.page_size)) retain('sale_links',`link:${big(row.parcel_link_id)}`,row);
              if (links.length<=limits.page_size) break;
              const last=links[limits.page_size-1];
              const next=[big(last.source_record_id),last.source_position,last.parcel_sequence];
              if (next.join(':')===cursor.join(':')) incomplete('nonadvancing_cursor');
              cursor=next;
            }
        }
        await page('legacy',SQL.legacy,[request.account_ids,'0',n],1,row => big(row.sale_id),row => retain('transactions',`legacy:${big(row.sale_id)}`,row));
      }
      await query('commit','COMMIT'); began=false;
    } catch (error) {
      if (began) { try { await client.query({ text:'ROLLBACK',query_timeout:limits.statement_ms+1000 }); }
        catch { releaseError=new Error('neighborhood_cache_rollback_failed'); } }
      if (INTERNAL_INVALID.has(error)) invalidFailure=error;
      else primaryFailure=failedCapture([INTERNAL_INCOMPLETE.get(error)||'source_query_unavailable']);
    } finally {
      // Each acquired client is released exactly once; a secondary cleanup error
      // must not expose driver details or replace an already classified failure.
      if (client && !releaseSafely(client,releaseError) && !primaryFailure && !invalidFailure && !missing.size) {
        primaryFailure=failedCapture(['connection_release_failed']);
      }
    }
    if (invalidFailure) throw invalidFailure;
    if (primaryFailure) return primaryFailure;
    if (missing.size) return failedCapture([...missing].sort(compare));
    // The database transaction is closed before hashing/chunking CPU work. These
    // exact retained bytes, not another mutable-cache query, feed publication.
    // Keep the large, verified identity closure private to authorization/drift
    // checking. Only its immutable digest and bounded counts belong in every
    // source envelope; never spread an authorized request into evidence metadata.
    const closure=authorized.transaction_closure;
    const closureManifest=freeze({ version:closure.version,source_revision:closure.source_revision,
      closure_sha256:closure.closure_sha256,transaction_count:closure.transactions.length,
      link_count:closure.links.length,legacy_sale_count:closure.legacy.length,
      account_count:closure.closure_account_ids.length,source_record_count:closure.source_record_ids.length });
    const compact={ reader_version:NEIGHBORHOOD_CACHE_READER_VERSION,mapping_version:CACHED_ROW_MAPPING_VERSION,
      scope:request.scope,effective_date:request.effective_date,observation_period:request.observation_period,
      knowledge_cutoff:request.knowledge_cutoff,capture_observed_at:capturedAtPrecise,
      authorization:{target:authorized.target,selection:authorized.selection,selection_sha256:authorized.selection_sha256,
        transaction_closure:closureManifest,market_decision:authorized.market_decision},
      semantics:'current_mutable_query_capture_not_historical_replay',
      selection_method:'exact_selected_accounts_all_source_links_no_event_filter',
      provider_coverage:'unknown',limits,capabilities };
    const compactJson=canonicalAssessmentJson(compact);
    const manifest=createHash('sha256').update(compactJson);
    // Stream potentially large membership rather than putting 50k IDs into the
    // per-chunk contract envelope. The members themselves remain captured below.
    for (const id of request.account_ids) manifest.update(canonicalAssessmentJson(id)).update('\n');
    const selection_sha256=manifest.digest('hex');
    // Retain the exact original preimage before compact gains per-capture
    // fields. Do not reconstruct it from a later result or reread the cache.
    const queryEvidence=buildCohortLocalQueryEvidenceV1(compactJson,JSON.stringify(request.account_ids),selection_sha256);
    if (queryEvidence.status!=='syntax_valid') return failedCapture([
      queryEvidence.status==='limit_exceeded'?'query_evidence_limit':'query_evidence_invalid']);
    const selectionRecords=request.account_ids.map(account_id => ({ record_id:`selected:${account_id}`,data:{ account_id } }));
    const captures=[];
    Object.assign(compact,{ selection_sha256,selected_account_count:request.account_ids.length });
    for (const [key,records] of Object.entries({ selection:selectionRecords,...groups })) {
      const hash=createHash('sha256').update(canonicalAssessmentJson(compact));
      for (const record of records.toSorted((a,b) => compare(a.record_id,b.record_id))) hash.update(canonicalAssessmentJson(record)).update('\n');
      const digest=hash.digest('hex');
      captures.push({ upstream:{ id:`local-cache:${key}`,key,state:records.length?'populated':'present_empty',
        complete:true,revision:`${NEIGHBORHOOD_CACHE_READER_VERSION}:${digest}`,content_sha256:digest,
        captured_at:capturedAt,visibility:'assignment_private',scope:request.scope,row_count:records.length },
        metadata:{ id:`local-cache-${key}`,provider:'HomeNode local database projection',revision:NEIGHBORHOOD_CACHE_READER_VERSION,
          valid_from:null,valid_to:null,observed_at:capturedAt,historical_availability:'unknown' },
        projection:{ id:`cache-${key}`,revision:NEIGHBORHOOD_CACHE_READER_VERSION,
          definition:{ ...compact,role:key,source_gaps:[...missing].sort(compare) },
          input_row_count:records.length,output_record_count:records.length,complete:true },records });
    }
    try {
      const source_capture=buildCachedSourceCaptures({ scope:request.scope,captures });
      return freeze({ status:missing.size?'incomplete':'captured',query_complete:missing.size===0,
        scope:request.scope,reader_version:NEIGHBORHOOD_CACHE_READER_VERSION,captured_at:capturedAt,
        source_capture,selection_sha256,query_evidence:queryEvidence.evidence,capabilities,incomplete_reasons:[...missing].sort(compare),counts,
        unsupported_capabilities:['historical_knowledge_replay','historical_characteristics','verified_market_eligibility',
          'real_transaction_membership','cross_source_transaction_equivalence','price_allocation','provider_coverage'] });
    } catch (error) {
      if (error.code!=='NEIGHBORHOOD_CAPTURE_LIMIT') throw error;
      return freeze({ status:'incomplete',query_complete:false,scope:request.scope,reader_version:NEIGHBORHOOD_CACHE_READER_VERSION,
        captured_at:capturedAt,source_capture:null,capabilities,incomplete_reasons:['capture_budget_limit'],counts });
    }
  } };
}
