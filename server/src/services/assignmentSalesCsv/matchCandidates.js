import { types } from 'node:util';
import { ASSIGNMENT_SALES_MATCH_PROPOSAL_LIMITS as LIMITS } from './matchProposals.js';
import { countyFromNativeAccountId, normalizedCountyAccountKey, validateSalesReconciliationAccountId } from '../salesReconciliation.js';
import { normalizePropertyAddress, normalizePropertyCity, normalizeSearchText } from '../../util/propertySearch.js';

const fail = reason => { throw Object.assign(new Error(`assignment_sales_match_${reason}`),
  { code: 'ASSIGNMENT_SALES_MATCH_CANDIDATES_UNAVAILABLE', reason }); };
const check = (condition, reason = 'invalid_candidate_input') => { if (!condition) fail(reason); };
const fields = ['request_id', 'kind', 'identifier', 'address_key', 'city_key', 'county_key', 'postal_code5'];
const text = (value, limit, nullable = false) => nullable && value === null || typeof value === 'string'
  && value.length <= limit && value.isWellFormed() && !/\p{Cc}/u.test(value);
function plain(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => descriptors[key]?.enumerable
    && Object.hasOwn(descriptors[key], 'value')));
}
const countyKey = value => normalizeSearchText(value).replace(/\s+COUNTY$/, '').trim();
function requestsOf(value) {
  plain(value, ['requests']);
  const input = value.requests;
  check(Array.isArray(input) && !types.isProxy(input) && Object.getPrototypeOf(input) === Array.prototype
    && input.length <= LIMITS.lookup_requests && Reflect.ownKeys(input).length === input.length + 1);
  const ids = new Set(), requests = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    const request = descriptor.value; plain(request, fields);
    check(typeof request.request_id === 'string' && /^lookup:[1-9]\d{0,2}$/.test(request.request_id)
      && Number(request.request_id.slice(7)) <= LIMITS.lookup_requests && !ids.has(request.request_id));
    check(text(request.county_key, 100, true) && (request.county_key === null
      || request.county_key.length > 0 && countyKey(request.county_key) === request.county_key));
    let collinKey = null;
    if (request.kind === 'identifier') {
      check(text(request.identifier, 100) && request.identifier.trim() === request.identifier
        && ['address_key', 'city_key', 'postal_code5'].every(key => request[key] === null));
      try { validateSalesReconciliationAccountId(request.identifier, request.county_key); }
      catch { fail('invalid_candidate_input'); }
      if (request.county_key === 'COLLIN' || countyFromNativeAccountId(request.identifier) === 'COLLIN') {
        collinKey = normalizedCountyAccountKey(request.identifier, 'COLLIN');
      }
    } else {
      check(request.kind === 'address' && request.identifier === null
        && text(request.address_key, 500) && request.address_key.length > 0
        && normalizePropertyAddress(request.address_key) === request.address_key
        && text(request.city_key, 200) && request.city_key.length > 0
        && normalizePropertyCity(request.city_key) === request.city_key
        && (request.postal_code5 === null || typeof request.postal_code5 === 'string' && /^\d{5}$/.test(request.postal_code5)));
    }
    ids.add(request.request_id); requests.push({ ...request, collin_key: collinKey });
  }
  return requests;
}

// Only metadata for these three allowlisted relations is read. Equivalent
// valid B-tree indexes are accepted; no initializer, seed, or index creation.
export const SALES_MATCH_CANDIDATE_SCHEMA_SQL = `/* assignment-sales-match:schema */
WITH required(slot,schema_name,table_name,column_names,boolean_column) AS (VALUES
 ('accounts','core','accounts',ARRAY['account_id','canonical_account_id','address','city','county','postal_code']::text[],NULL::text),
 ('county','app','county_account_identifiers',ARRAY['county','normalized_account_id','native_account_id','account_id']::text[],NULL::text),
 ('address','app','account_address_aliases',ARRAY['account_id','address_key','city_key','county_key','postal_code5','is_current']::text[],'is_current')
), sources AS (
 SELECT r.*,c.oid,c.relrowsecurity,c.relkind,n.oid AS namespace_id
 FROM required r LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=r.schema_name
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=r.table_name
), indexes AS (
 SELECT i.indrelid,i.indisunique,i.indnkeyatts,pg_catalog.pg_get_expr(i.indpred,i.indrelid) AS predicate,
   ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,ordinal)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
     WHERE k.ordinal<=i.indnkeyatts ORDER BY k.ordinal) AS keys
 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
 JOIN pg_catalog.pg_am am ON am.oid=c.relam
 WHERE i.indrelid IN (SELECT oid FROM sources) AND i.indisvalid AND i.indisready AND i.indislive
   AND i.indexprs IS NULL AND am.amname='btree'
)
SELECT s.slot,COALESCE(s.relkind IN ('r','p') AND NOT s.relrowsecurity
 AND pg_catalog.has_schema_privilege(s.namespace_id,'USAGE') AND pg_catalog.has_table_privilege(s.oid,'SELECT')
 AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(s.column_names) name
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=s.oid AND a.attname=name
     AND a.attnum>0 AND NOT a.attisdropped
     AND ((name=s.boolean_column AND a.atttypid='pg_catalog.bool'::pg_catalog.regtype)
       OR (name IS DISTINCT FROM s.boolean_column AND a.atttypid IN ('pg_catalog.text'::pg_catalog.regtype,'pg_catalog.varchar'::pg_catalog.regtype)))))
 AND EXISTS (SELECT 1 FROM indexes i WHERE i.indrelid=s.oid AND CASE s.slot
   WHEN 'accounts' THEN i.indisunique AND i.indnkeyatts=1 AND i.keys=ARRAY['account_id']::text[] AND i.predicate IS NULL
   WHEN 'county' THEN i.indisunique AND i.indnkeyatts=2 AND i.keys=ARRAY['county','normalized_account_id']::text[] AND i.predicate IS NULL
   ELSE i.keys[1:2]=ARRAY['address_key','city_key']::text[]
     AND (i.predicate IS NULL OR i.predicate IN ('(is_current = true)','is_current','(is_current IS TRUE)')) END),false) AS ready,
 pg_catalog.to_char(pg_catalog.statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
FROM sources s ORDER BY s.slot`;

const exactProbe = `SELECT a.account_id FROM core.accounts a WHERE r.kind='identifier' AND a.account_id=r.identifier LIMIT 6`;
const countyProbe = `SELECT a.account_id FROM app.county_account_identifiers a
 WHERE r.kind='identifier' AND r.collin_key IS NOT NULL AND a.county='COLLIN' AND a.normalized_account_id=r.collin_key LIMIT 6`;
const addressProbe = `SELECT a.account_id FROM app.account_address_aliases a
 WHERE r.kind='address' AND a.is_current=true AND a.address_key=r.address_key AND a.city_key=r.city_key
 AND (r.county_key IS NULL OR a.county_key=r.county_key)
 AND (r.postal_code5 IS NULL OR a.postal_code5=r.postal_code5) LIMIT 6`;

function candidateSql(sources) {
  // Static fragments only. Unavailable relations are absent from the statement,
  // avoiding a known missing-table error that would abort the owner's txn.
  const probes = [exactProbe, ...(sources.county ? [countyProbe] : []), ...(sources.address ? [addressProbe] : [])];
  return `/* assignment-sales-match:candidates */
WITH requested AS MATERIALIZED (
 SELECT * FROM pg_catalog.jsonb_to_recordset($1::jsonb) r(request_id text,kind text,identifier text,
 address_key text,city_key text,county_key text,postal_code5 text,collin_key text)
), probed AS MATERIALIZED (
 SELECT r.request_id,p.account_id AS requested_account_id FROM requested r
 LEFT JOIN LATERAL (${probes.map(probe => `(${probe})`).join(' UNION ALL ')}) p ON true
), canonical AS MATERIALIZED (
 SELECT p.request_id,p.requested_account_id,c.account_id,c.canonical_account_id,c.address,c.city,c.county,c.postal_code
 FROM probed p LEFT JOIN core.accounts a ON a.account_id=p.requested_account_id
 LEFT JOIN core.accounts c ON c.account_id=COALESCE(NULLIF(pg_catalog.btrim(a.canonical_account_id),''),a.account_id)
), bounded AS MATERIALIZED (
 SELECT request_id,requested_account_id,
 CASE WHEN account_id IS NOT NULL AND pg_catalog.char_length(account_id) BETWEEN 1 AND 100
   AND (NULLIF(pg_catalog.btrim(canonical_account_id),'') IS NULL OR pg_catalog.btrim(canonical_account_id)=account_id)
   AND (address IS NULL OR pg_catalog.char_length(address)<=500)
   AND (city IS NULL OR pg_catalog.char_length(city)<=200)
   AND (county IS NULL OR pg_catalog.char_length(county)<=100)
   AND (postal_code IS NULL OR pg_catalog.char_length(postal_code)<=20)
 THEN pg_catalog.jsonb_build_object('account_id',account_id,'address',address,'city',city,'county',county,'postal_code',postal_code)
 ELSE NULL END AS candidate FROM canonical
), grouped AS MATERIALIZED (
 SELECT request_id,pg_catalog.count(requested_account_id)::integer AS probe_count,
   pg_catalog.count(*) FILTER (WHERE requested_account_id IS NOT NULL AND candidate IS NULL)::integer AS invalid_count,
   COALESCE(pg_catalog.jsonb_agg(DISTINCT candidate) FILTER (WHERE candidate IS NOT NULL),'[]'::jsonb) AS candidates
 FROM bounded GROUP BY request_id
), admitted AS MATERIALIZED (
 SELECT request_id,probe_count,invalid_count,
   CASE WHEN probe_count<=5 AND invalid_count=0 THEN candidates ELSE '[]'::jsonb END AS candidates FROM grouped
), metered AS (
 SELECT *,pg_catalog.sum(pg_catalog.octet_length(pg_catalog.convert_to(candidates::text,'UTF8'))) OVER () AS payload_bytes FROM admitted
)
SELECT request_id,probe_count,invalid_count,(payload_bytes>1572864) AS payload_overflow,
 CASE WHEN payload_bytes<=1572864 THEN candidates ELSE '[]'::jsonb END AS candidates
FROM metered ORDER BY request_id`;
}

function unavailable(requests, observedAt) {
  return freeze({ observed_at: observedAt, results: requests.map(request => ({ request_id: request.request_id,
    status: 'unavailable', candidates: [] })) });
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function queryRows(query, sql, params = []) {
  let result;
  try { result = await query(sql, params); }
  catch (error) {
    // Preserve only the owner's fixed retry/busy semantics. Never pass through
    // the driver object, message, detail, query, or cause to an HTTP consumer.
    if (['55P03', '57014', '40001', '40P01', 'assignment_sales_import_busy'].includes(error?.code)) {
      throw Object.assign(new Error('assignment_sales_import_busy'), { code: 'assignment_sales_import_busy' });
    }
    fail('candidate_source_unavailable');
  }
  check(result && Array.isArray(result.rows), 'invalid_candidate_result');
  return result.rows;
}

/** Internal, read-only adapter. The owner supplies an already authorized,
 * bounded, exclusive REPEATABLE READ READ ONLY transaction query function.
 * No pool, transaction control, fuzzy scan, source policy, or mutation here.
 * Complete means only the installed indexed lookup, not full alias coverage.
 * Any six-probe sentinel (including duplicate alias rows), invalid canonical
 * hop, missing dependency, or aggregate payload excess is unavailable, never
 * a clipped unique candidate. A runtime SQL failure requires owner rollback.
 */
export async function readAssignmentSalesMatchCandidates(query, input) {
  const requests = requestsOf(input); check(typeof query === 'function');
  const metadata = await queryRows(query, SALES_MATCH_CANDIDATE_SCHEMA_SQL);
  check(metadata.length === 3, 'invalid_candidate_result');
  const sources = {}, times = new Set();
  for (const row of metadata) {
    check(row && ['accounts', 'county', 'address'].includes(row.slot) && !Object.hasOwn(sources, row.slot)
      && typeof row.ready === 'boolean' && typeof row.observed_at === 'string'
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.observed_at)
      && Number.isFinite(Date.parse(row.observed_at)) && new Date(row.observed_at).toISOString() === row.observed_at,
    'invalid_candidate_result');
    sources[row.slot] = row.ready; times.add(row.observed_at);
  }
  check(times.size === 1, 'invalid_candidate_result'); const observedAt = [...times][0];
  if (!sources.accounts || requests.length === 0) return unavailable(requests, observedAt);
  const admitted = requests.filter(request => request.kind === 'address' ? sources.address : !request.collin_key || sources.county);
  if (!admitted.length) return unavailable(requests, observedAt);
  const rows = await queryRows(query, candidateSql(sources), [JSON.stringify(admitted)]);
  check(rows.length === admitted.length, 'invalid_candidate_result');
  const requested = new Map(admitted.map(request => [request.request_id, request])), results = new Map(), accounts = new Map();
  for (const row of rows) {
    const request = requested.get(row?.request_id);
    check(request && !results.has(row.request_id) && Number.isInteger(row.probe_count) && row.probe_count >= 0 && row.probe_count <= 6
      && Number.isInteger(row.invalid_count) && row.invalid_count >= 0 && row.invalid_count <= row.probe_count
      && typeof row.payload_overflow === 'boolean' && Array.isArray(row.candidates) && row.candidates.length <= 5,
    'invalid_candidate_result');
    let valid = row.probe_count <= 5 && row.invalid_count === 0 && !row.payload_overflow;
    if (!valid) check(row.candidates.length === 0, 'invalid_candidate_result');
    check(row.candidates.length <= row.probe_count && (!valid || (row.probe_count === 0) === (row.candidates.length === 0)), 'invalid_candidate_result');
    const candidates = [], ids = new Set();
    for (const raw of row.candidates) {
      plain(raw, ['account_id', 'address', 'city', 'county', 'postal_code']);
      check(text(raw.account_id, 100) && raw.account_id.length > 0 && raw.account_id.trim() === raw.account_id
        && !ids.has(raw.account_id), 'invalid_candidate_result');
      const candidate = { account_id: raw.account_id, address: raw.address, city: raw.city, county: raw.county, postal_code: raw.postal_code };
      if (![['address', 500], ['city', 200], ['county', 100], ['postal_code', 20]].every(([field, max]) => text(candidate[field], max, true))) valid = false;
      try {
        validateSalesReconciliationAccountId(candidate.account_id);
        if (request.kind === 'identifier') validateSalesReconciliationAccountId(request.identifier, candidate.county);
      } catch { valid = false; }
      const serialized = JSON.stringify(candidate);
      check(!accounts.has(candidate.account_id) || accounts.get(candidate.account_id) === serialized, 'candidate_evidence_conflict');
      accounts.set(candidate.account_id, serialized); ids.add(candidate.account_id); candidates.push(candidate);
    }
    candidates.sort((a, b) => a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0);
    results.set(row.request_id, { request_id: row.request_id, status: valid ? 'complete' : 'unavailable', candidates: valid ? candidates : [] });
  }
  const result = { observed_at: observedAt, results: requests.map(request => results.get(request.request_id)
    ?? { request_id: request.request_id, status: 'unavailable', candidates: [] }) };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.evidence_utf8_bytes) return unavailable(requests, observedAt);
  return freeze(result);
}
