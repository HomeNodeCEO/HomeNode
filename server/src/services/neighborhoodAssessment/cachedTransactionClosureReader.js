import { performance } from 'node:perf_hooks';
import { normalizePublicCadastralAccountId } from '../../security/publicCadastralCatalog.js';
import { canonicalAssessmentJson } from './contract.js';
import { validateCachedTransactionClosure } from './cachedTransactionClosure.js';

// Shared verbatim with the source reader's independent drift check. Do not add
// date/resolution filters or discover a second hop from newly linked accounts.
export const CACHED_TRANSACTION_IDENTITY_SQL = Object.freeze({
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
});
export const CACHED_TRANSACTION_IDENTITY_ORDER = Object.freeze({
  'source-ids':"(payload->>'source_record_id')::bigint",
  'transaction-identities':"(payload->>'source_record_id')::bigint,(payload->>'sale_id')::bigint",
  'link-identities':"(payload->>'source_record_id')::bigint,(payload->>'source_position')::smallint,(payload->>'parcel_sequence')::smallint",
  'legacy-identities':"(payload->>'sale_id')::bigint",
});
export const CACHED_TRANSACTION_SNAPSHOT_SQL = `SELECT current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only, current_setting('TimeZone') AS timezone,
  transaction_timestamp() < statement_timestamp() AS explicit_transaction,
  pg_backend_pid() AS backend_pid, pg_current_snapshot()::text AS snapshot,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_started_at,
  (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement_ms,
  (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock_ms,
  (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle_ms`;

export const NEIGHBORHOOD_TRANSACTION_CLOSURE_READER_LIMITS = Object.freeze({
  accounts: 50_000, identity_records: 100_000, bytes: 8_000_000,
  page_size: 250, row_bytes: 2048, queries: 10_000, duration_ms: 30_000, statement_ms: 5000,
});
class IncompleteClosureRead extends Error {}
function incomplete(reason) { throw new IncompleteClosureRead(reason); }
function invalid(field) { throw new TypeError('invalid_neighborhood_closure_reader:'+field); }
function plain(value, allowed, field) {
  if (!value || Object.getPrototypeOf(value)!==Object.prototype) invalid(field);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key!=='string' || !allowed.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')) invalid(field);
  }
  return value;
}
function freeze(value) {
  if (value && typeof value==='object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function positiveId(value) {
  if (typeof value!=='string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value)>9223372036854775807n) {
    incomplete('invalid_source_identity');
  }
  return value;
}
const compareId=(a,b)=>a.length-b.length || (a<b?-1:a>b?1:0);
function position(value) {
  if (!Number.isSafeInteger(value) || value<1 || value>32767) incomplete('invalid_link_position');
  return value;
}
function linkCursor(row) {
  return [positiveId(row.source_record_id),position(row.source_position),position(row.parcel_sequence)];
}
const compareCursor=(a,b)=>compareId(a[0],b[0]) || a[1]-b[1] || a[2]-b[2];
function snapshotOf(rows,limits) {
  const row=Array.isArray(rows) && rows.length===1 ? rows[0] : null;
  const timestamp=row?.transaction_started_at;
  const milliseconds=typeof timestamp==='string'?timestamp.slice(0,23)+'Z':'';
  if (!row || row.isolation!=='repeatable read' || row.read_only!=='on' || row.explicit_transaction!==true
    || !Number.isSafeInteger(row.backend_pid) || row.backend_pid<1
    || typeof row.snapshot!=='string' || row.snapshot.length>limits.row_bytes
    || !/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(row.snapshot)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp??'')
    || !Number.isFinite(Date.parse(milliseconds)) || new Date(milliseconds).toISOString()!==milliseconds) {
    incomplete('caller_snapshot_transaction_required');
  }
  if (row.timezone!=='UTC' || !Number.isSafeInteger(row.statement_ms) || row.statement_ms<1 || row.statement_ms>limits.statement_ms
    || !Number.isSafeInteger(row.lock_ms) || row.lock_ms<1 || row.lock_ms>1000
    || !Number.isSafeInteger(row.idle_ms) || row.idle_ms<1 || row.idle_ms>10000) incomplete('caller_snapshot_settings_required');
  return {backend_pid:row.backend_pid,snapshot:row.snapshot,transaction_started_at:timestamp};
}

/** Internal identity discovery, invoked ONLY after the owner has authorized the
 * exact assignment, trusted selection and all-date licensed association access.
 * This cannot require the later read grants: it supplies the closure while the
 * trusted cachedReadAccess callback is preparing those grants.
 *
 * Caller exclusively owns an explicit RR/RO client with bounded server settings.
 * Never connect, change settings, BEGIN/COMMIT/ROLLBACK or release. On any failed
 * result, the owner must discard it and handle rollback/release (especially after
 * SQL errors/timeouts). No source/provider completeness or authorization is minted.
 *
 * Only original selected IDs seed sources; all their event dates and one-hop
 * links remain, including unresolved links. No newly linked account is reseeded.
 * Global account text identity is preserved (including county-specific prefixes);
 * this query does not establish county identity or read linked CAD/property facts.
 *
 * A trusted resolveTransactionClosure callback must check status/snapshot and
 * return result.transaction_closure, the exact five-field validator input, NOT
 * this wrapper or the validator's expanded output. source_revision/digest and
 * snapshot are comparison metadata, never original-authority or COMMIT receipts.
 */
export async function resolveNeighborhoodCachedTransactionClosure(client,input,options={}) {
  const started=performance.now();
  if (typeof client?.query!=='function' || typeof client.release!=='function') invalid('caller_client');
  plain(input,['selected_account_ids','source_revision'],'input');
  plain(options,['limits','signal','deadline'],'options');
  if (options.signal!==undefined && !(options.signal instanceof AbortSignal)) invalid('signal');
  if (options.deadline!==undefined && (typeof options.deadline!=='number' || !Number.isFinite(options.deadline))) invalid('deadline');
  const overrides=plain(options.limits===undefined?{}:options.limits,Object.keys(NEIGHBORHOOD_TRANSACTION_CLOSURE_READER_LIMITS),'limits');
  const limits={...NEIGHBORHOOD_TRANSACTION_CLOSURE_READER_LIMITS,...overrides};
  for (const [key,value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value<1 || value>NEIGHBORHOOD_TRANSACTION_CLOSURE_READER_LIMITS[key]) invalid('limits');
  }
  const closureLimits={accounts:limits.accounts,identity_records:limits.identity_records,bytes:limits.bytes};
  const selected=validateCachedTransactionClosure({selected_account_ids:input.selected_account_ids,
    source_revision:input.source_revision,transactions:[],links:[],legacy:[]},{limits:closureLimits});
  if (!selected.selected_account_ids.length) invalid('selected_account_ids');
  const deadline=Math.min(started+limits.duration_ms,options.deadline??Infinity);
  const signal=options.signal;
  const counts={queries:0,source_records:0,identity_records:0,accounts:selected.selected_account_ids.length,bytes:1024};
  const rowsByRole={transactions:[],links:[],legacy:[]}, accounts=new Set(selected.selected_account_ids);
  let snapshot=null;
  const check=()=>{
    if (signal?.aborted) incomplete('capture_cancelled');
    if (performance.now()>=deadline) incomplete('duration_limit');
  };
  const charge=bytes=>{counts.bytes+=bytes;if(counts.bytes>limits.bytes)incomplete('byte_limit');};
  const query=async(tag,sql,values=[])=>{
    check();
    if (counts.queries>=limits.queries) incomplete('query_limit');
    counts.queries++;
    const result=await client.query({text:'/* neighborhood-closure:'+tag+' */ '+sql,values,
      query_timeout:Math.max(1,Math.min(limits.statement_ms+1000,Math.ceil(deadline-performance.now())))});
    check();
    if (!Array.isArray(result?.rows)) incomplete('database_result_invalid');
    return result.rows;
  };
  const verifySnapshot=async()=>{
    const current=snapshotOf(await query('snapshot',CACHED_TRANSACTION_SNAPSHOT_SQL),limits);
    if (snapshot && canonicalAssessmentJson(current)!==canonicalAssessmentJson(snapshot)) incomplete('caller_snapshot_changed');
    snapshot=current;
  };
  const rows=async(tag,sql,values)=>{
    // SQL limits projected row bytes before transfer. No arbitrary MLS fields,
    // price, date, characteristics, raw payload, geometry or remarks are read.
    const result=await query(tag,'WITH projected AS MATERIALIZED ('+sql+'), encoded AS ('
      +'SELECT to_jsonb(projected) AS payload FROM projected) SELECT CASE WHEN octet_length(payload::text)<='
      +limits.row_bytes+' THEN payload ELSE NULL END AS payload,octet_length(payload::text) AS row_bytes'
      +' FROM encoded ORDER BY '+CACHED_TRANSACTION_IDENTITY_ORDER[tag],values);
    if (result.length>values.at(-1)) incomplete('database_page_invalid');
    return result.map(row=>{
      if (!row.payload || !Number.isSafeInteger(row.row_bytes) || row.row_bytes<1 || row.row_bytes>limits.row_bytes) incomplete('row_bytes_limit');
      charge(row.row_bytes); return row.payload;
    });
  };
  const includeAccount=value=>{
    if (value===null) return;
    // The existing closure validator accepts surrounding-space aliases only.
    // Guard types BEFORE catalog normalization; never stringify numeric IDs.
    if (typeof value!=='string' || value.length>256 || /[\u0000-\u001f\u007f]/.test(value)) incomplete('invalid_account_identity');
    let id;
    try {id=normalizePublicCadastralAccountId(value);} catch {incomplete('invalid_account_identity');}
    if (!accounts.has(id)) {
      if (accounts.size>=limits.accounts) incomplete('account_limit');
      accounts.add(id);counts.accounts=accounts.size;
    }
  };
  const retain=(role,row)=>{
    check();
    if (++counts.identity_records>limits.identity_records) incomplete('identity_limit');
    for (const key of role==='transactions'?['primary_account_id','sale_account_id']:role==='links'?['account_id']:['sale_account_id']) {
      includeAccount(row[key]);
    }
    rowsByRole[role].push(row);
  };
  try {
    charge(Buffer.byteLength(canonicalAssessmentJson(selected.source_revision))+1);
    for (const id of selected.selected_account_ids) {check();charge(Buffer.byteLength(canonicalAssessmentJson(id))+1);}
    // Two separate probes reject autocommit even with RR/RO session defaults.
    await verifySnapshot();await verifySnapshot();
    const n=limits.page_size+1;
    let after='0';
    while (true) {
      const found=await rows('source-ids',CACHED_TRANSACTION_IDENTITY_SQL.source_ids,[selected.selected_account_ids,after,n]);
      let previous=after;
      for (const row of found) {
        const id=positiveId(row.source_record_id);
        if (compareId(id,previous)<=0) incomplete('nonadvancing_source_cursor');
        previous=id;
      }
      const ids=found.slice(0,limits.page_size).map(row=>row.source_record_id);
      if (ids.length) {
        counts.source_records+=ids.length;
        if (counts.source_records>limits.identity_records) incomplete('identity_limit');
        const identities=await rows('transaction-identities',CACHED_TRANSACTION_IDENTITY_SQL.transaction_identities,[ids,ids.length+1]);
        // Preserve the reader's canonical one-sale-per-source gate. The general
        // closure validator's broader syntax is not permission to truncate here.
        const foundIds=new Set(identities.map(row=>row.source_record_id));
        if (identities.length>ids.length || foundIds.size!==identities.length) incomplete('duplicate_source_identity');
        if (identities.length<ids.length || ids.some(id=>!foundIds.has(id))) incomplete('source_identity_missing');
        for (const row of identities) retain('transactions',row);
        let cursor=['0',0,0];
        while (true) {
          const links=await rows('link-identities',CACHED_TRANSACTION_IDENTITY_SQL.link_identities,[ids,...cursor,n]);
          let previousCursor=cursor;
          for (const row of links) {
            const next=linkCursor(row);
            if (!foundIds.has(next[0])) incomplete('unrequested_source_identity');
            if (compareCursor(next,previousCursor)<=0) incomplete('nonadvancing_link_cursor');
            previousCursor=next;
          }
          for (const row of links.slice(0,limits.page_size)) retain('links',row);
          if (links.length<=limits.page_size) break;
          cursor=linkCursor(links[limits.page_size-1]);
        }
      }
      if (found.length<=limits.page_size) break;
      after=ids.at(-1);
    }
    after='0';
    while (true) {
      const legacy=await rows('legacy-identities',CACHED_TRANSACTION_IDENTITY_SQL.legacy_identities,[selected.selected_account_ids,after,n]);
      let previous=after;
      for (const row of legacy) {
        const id=positiveId(row.sale_id);
        if (compareId(id,previous)<=0) incomplete('nonadvancing_legacy_cursor');
        previous=id;
      }
      for (const row of legacy.slice(0,limits.page_size)) retain('legacy',row);
      if (legacy.length<=limits.page_size) break;
      after=legacy[limits.page_size-1].sale_id;
    }
    await verifySnapshot();check();
    let validated;
    try {validated=validateCachedTransactionClosure({selected_account_ids:selected.selected_account_ids,
      source_revision:selected.source_revision,...rowsByRole},{limits:closureLimits});}
    catch {incomplete('identity_closure_invalid');}
    check();
    const transaction_closure={selected_account_ids:validated.selected_account_ids,source_revision:validated.source_revision,
      transactions:validated.transactions,links:validated.links,legacy:validated.legacy};
    const result=freeze({status:'captured',query_complete:true,authority:'not_established',
      transaction_closure,closure_sha256:validated.closure_sha256,snapshot,counts});
    check();return result;
  } catch (error) {
    return freeze({status:'incomplete',query_complete:false,authority:'not_established',
      transaction_closure:null,closure_sha256:null,snapshot:null,
      reason:error instanceof IncompleteClosureRead?error.message:'source_query_unavailable',counts});
  }
}
