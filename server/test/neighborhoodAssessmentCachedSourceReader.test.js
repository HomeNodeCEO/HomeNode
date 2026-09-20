import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { consumeNeighborhoodCachedAcquisition, createNeighborhoodCachedSourceReader,
  createNeighborhoodSaleWitnessSourceReader, createNeighborhoodCadEvidenceSourceReader,
  createNeighborhoodDenseCadEvidenceSourceReader, NEIGHBORHOOD_CACHE_READER_VERSION } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodSaleWitnessReadAccess, createNeighborhoodCadEvidenceReadAccess } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { CACHED_CAD_EVIDENCE_FIELDS } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { DENSE_CAD_CACHE_READER_LIMITS, DENSE_CAD_SQL_PAGE_BYTES } from '../src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { CACHED_SALE_WITNESS_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { CACHED_SOURCE_CAPTURE_LIMITS, DENSE_CAD_SOURCE_CAPTURE_LIMITS } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCohortLocalQueryEvidenceV1 } from '../src/services/neighborhoodAssessment/cohortEvidenceContract.js';
import { cohortFixtureQueryHash, makeCohortLocalQueryMetadata } from './fixtures/neighborhoodCohortLocalQueryEvidenceFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';

// This is a query-boundary fake, not a PostgreSQL compatibility test. The catalog
// fixture tracks the reader's literal capabilities while missing-column tests
// independently prove that unavailable sources cannot become complete captures.
const source = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const tableDeclaration = source.slice(source.indexOf('const TABLES'), source.indexOf('const SQL'));
const CATALOG = [...tableDeclaration.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));

test('projected-row execution accepts only closed query plans, never runtime SQL text', () => {
  assert.match(source,/const ROW_PROJECTIONS=Object\.freeze\(/);
  assert.match(source,/if \(!Object\.values\(rowPlans\)\.includes\(plan\)\) invalid\('query_plan'\)/);
  assert.doesNotMatch(source,/const rows=async\s*\([^)]*\bsql\b/);
  assert.doesNotMatch(source,/WITH projected AS MATERIALIZED \(\$\{sql\}\)/);
});
const RUN = '60000000-0000-4000-8000-000000000001';
const NOW = '2026-09-05T12:00:00.000Z';
const NOW_PRECISE = '2026-09-05T12:00:00.000000Z';
const SUBJECT = ASSESSMENT_SCOPE.account_id;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (a, b) => compare(BigInt(a), BigInt(b));
const request = (changes = {}) => ({ scope: { ...ASSESSMENT_SCOPE }, effective_date: '2024-06-30',
  observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' }, account_ids: [SUBJECT], ...changes });
const parcel = (object_id = '1', account_id = SUBJECT) => ({ object_id, account_id,
  residential_year_built: 2004, residential_area_sqft: '2000', current_market_value: '300000',
  parcel_area_sqft: '8000', land_use_category: 'one_unit', classification_confidence: 'high',
  source_record_hash: 'a'.repeat(64), sync_run_id: RUN, synced_at: NOW,
  source_updated_at: null, stored_geometry_ewkb: '010203' });
const transaction = (id = '10', changes = {}) => ({ source_record_id: id, sale_id: `1${id}`,
  primary_account_id: SUBJECT, sale_account_id: SUBJECT, source_name: 'Synthetic MLS',
  source_record_hash: 'b'.repeat(64), source_sha256: 'c'.repeat(64), record_type: 'closed_sale',
  source_close_date: '2024-03-01', sale_closing_date: '2024-03-01', sale_price: '300000',
  source_loaded_at: NOW, source_current_price: '300000', match_status: 'exact', ...changes });
const link = (id = '100', changes = {}) => ({ parcel_link_id: id, source_record_id: '10',
  source_position: 1, parcel_sequence: 1, parcel_role: 'primary', account_id: SUBJECT,
  is_resolved: true, match_method: 'exact', link_loaded_at: NOW, ...changes });
const transactionIdentity = row => Object.fromEntries(['source_record_id','sale_id','primary_account_id',
  'sale_account_id','source_record_hash'].map(key => [key,row[key]??null]));
const linkIdentity = row => Object.fromEntries(['parcel_link_id','source_record_id','source_position',
  'parcel_sequence','account_id','is_resolved'].map(key => [key,row[key]??null]));
const legacyIdentity = row => ({sale_id:row.sale_id,sale_account_id:row.sale_account_id});
function fixtureClosure(data, selected) {
  const ids=new Set(data.transactions.filter(row => selected.includes(row.primary_account_id)
    || selected.includes(row.sale_account_id)).map(row => row.source_record_id));
  for (const row of data.links) if (selected.includes(row.account_id)) ids.add(row.source_record_id);
  return {source_revision:'synthetic-transaction-identity-v1',
    transactions:data.transactions.filter(row => ids.has(row.source_record_id)).map(transactionIdentity),
    links:data.links.filter(row => ids.has(row.source_record_id)).map(linkIdentity),
    legacy:data.legacy.filter(row => selected.includes(row.sale_account_id)).map(legacyIdentity)};
}

function fake(options = {}) {
  const data = { catalog: CATALOG.map(row => ({ ...row })), parcels: [parcel()],
    accounts: [{ account_id: SUBJECT, subdivision: 'Synthetic Plat' }], transactions: [], links: [], legacy: [],
    sync: [{ source_key: 'dcad_parcels', status: 'current', row_count: String(options.data?.parcels?.length ?? 1), last_run_id: RUN, last_success_at: NOW }],
    runs: [{ id: RUN, source_key: 'dcad_parcels', status: 'complete', started_at: '2026-09-05T11:00:00.000Z', completed_at: NOW, mode: 'full' }],
    scope: [{ case_date: '2024-06-30', snapshot_date: '2024-06-30', effective_date: '2024-06-30', captured_at: NOW, captured_at_precise: NOW_PRECISE }],
    ...options.data };
  const calls = [], releases = [];
  let connects = 0, poolQueries = 0;
  const client = { release(error) { releases.push(error); options.release?.(error); }, async query(config) {
    const text = typeof config === 'string' ? config : config.text;
    const values = typeof config === 'string' ? [] : config.values || [];
    const tag = text.match(/neighborhood-cache:([\w-]+)/)?.[1] || text.trim().toLowerCase();
    calls.push({ tag, text, values: structuredClone(values), query_timeout: config.query_timeout });
    if (options.intercept) {
      const intercepted = await options.intercept({ tag, text, values, data });
      if (intercepted !== undefined) return intercepted;
    }
    if (['begin', 'settings', 'commit', 'rollback'].includes(tag)) return { rows: [] };
    if (tag === 'scope') return { rows: structuredClone(data.scope) };
    if (tag === 'capabilities') return { rows: structuredClone(data.catalog) };
    let result;
    if (tag === 'parcels') result = data.parcels.filter(row => values[0].includes(row.account_id)
      && BigInt(row.object_id) > BigInt(values[1])).sort((a, b) => numeric(a.object_id, b.object_id)).slice(0, values[2]);
    else if (tag === 'accounts') result = data.accounts.filter(row => values[0].includes(row.account_id)
      && row.account_id > values[1]).sort((a, b) => compare(a.account_id, b.account_id)).slice(0, values[2]);
    else if (tag === 'sync-state') result = data.sync.slice(0, 2);
    else if (tag === 'sync-runs') result = data.runs.filter(row => values[0].includes(row.id)).slice(0, values[1]);
    else if (tag === 'source-ids') {
      const ids = new Set(data.transactions.filter(row => values[0].includes(row.primary_account_id)
        || values[0].includes(row.sale_account_id)).map(row => row.source_record_id));
      for (const row of data.links) if (values[0].includes(row.account_id)) ids.add(row.source_record_id);
      result = [...ids].filter(id => BigInt(id) > BigInt(values[1])).sort(numeric).slice(0, values[2])
        .map(source_record_id => ({ source_record_id }));
    } else if (tag === 'transactions' || tag === 'transaction-identities') {
      result = data.transactions.filter(row => values[0].includes(row.source_record_id)).slice(0, values[1]);
      if (tag === 'transaction-identities') result=result.map(transactionIdentity);
    } else if (tag === 'sale-links' || tag === 'link-identities') {
      result = data.links.filter(row => values[0].includes(row.source_record_id)
      && (BigInt(row.source_record_id) > BigInt(values[1])
        || (row.source_record_id === values[1] && (row.source_position > values[2]
          || (row.source_position === values[2] && row.parcel_sequence > values[3])))))
      .sort((a, b) => numeric(a.source_record_id, b.source_record_id)
        || a.source_position - b.source_position || a.parcel_sequence - b.parcel_sequence).slice(0, values[4]);
      if (tag === 'link-identities') result=result.map(linkIdentity);
    } else if (tag === 'legacy' || tag === 'legacy-identities') {
      result = data.legacy.filter(row => values[0].includes(row.sale_account_id)
        && BigInt(row.sale_id) > BigInt(values[1])).sort((a, b) => numeric(a.sale_id, b.sale_id)).slice(0, values[2]);
      if (tag === 'legacy-identities') result=result.map(legacyIdentity);
    }
    else assert.fail(`Unexpected SQL tag: ${tag}`);
    return { rows: structuredClone(result).map(payload => ({ payload, row_bytes: Buffer.byteLength(JSON.stringify(payload)) })) };
  } };
  const pool = { async connect() { connects++; if (options.connect) return options.connect(client); return client; },
    async query() { poolQueries++; assert.fail('Reader must not query the pool outside its checked-out transaction'); } };
  // Query fixtures represent independently authorized synthetic selections.
  // The adversarial tests below call the raw reader with altered issued tokens.
  const accessOptions={accessFactory:options.accessFactory,authorizeMarketData:options.authorizeMarketData};
  const readerFactory=options.readerFactory ?? createNeighborhoodCachedSourceReader;
  const baseline=createTestCachedReadAccess(request(),{...accessOptions,transactionClosure:fixtureClosure(data,[SUBJECT])});
  readerFactory(pool,{limits:options.limits||{},access:baseline.access});
  return { data, pool, calls, releases, get connects() { return connects; }, get poolQueries() { return poolQueries; },
    reader:{async capture(input) {
      const granted=createTestCachedReadAccess(input,{...accessOptions,transactionClosure:fixtureClosure(data,input.account_ids)});
      const prepared=await granted.prepare();
      return readerFactory(pool,{limits:options.limits||{},access:granted.access})
        .capture({...prepared.request,auth:granted.auth,selection_grant:prepared.selection_grant,market_grant:prepared.market_grant});
    }} };
}
const records = (result, role) => result.source_capture.sources
  .filter(source => source.payload.projection.definition.role === role).flatMap(source => source.payload.records);
const captureHashes = result => result.source_capture.source_snapshots.map(row => row.content_sha256);

// Exact EWKB of a closed, non-self-intersecting circle-shaped MultiPolygon.
// No simplification or repeated padding bytes stand in for a real large ring.
function largeParcelGeometry(vertices=2800) {
  const bytes=Buffer.alloc(26+16*(vertices+1)); let at=0;
  const byte=value => { bytes.writeUInt8(value,at); at++; };
  const uint=value => { bytes.writeUInt32LE(value,at); at+=4; };
  const double=value => { bytes.writeDoubleLE(value,at); at+=8; };
  byte(1); uint(0x20000006); uint(4326); uint(1);
  byte(1); uint(3); uint(1); uint(vertices+1);
  for (let index=0;index<=vertices;index++) {
    const angle=(index===vertices?0:index)*Math.PI*2/vertices;
    double(-96.8+0.002*Math.cos(angle)); double(32.8+0.002*Math.sin(angle));
  }
  assert.equal(at,bytes.length); return bytes.toString('hex');
}
const cadParcel = (objectId='1', accountId=SUBJECT, changes={}) => ({...parcel(objectId,accountId),
  class_code:'A1',class_description:'Single family',use_description:'Residential',structure_type:null,built_up:true,...changes});
const denseCad = (options={}) => fake({ readerFactory:createNeighborhoodDenseCadEvidenceSourceReader,
  accessFactory:createNeighborhoodCadEvidenceReadAccess,...options,data:{
    catalog:[...CATALOG,...CACHED_CAD_EVIDENCE_FIELDS.map(column => ({relation:'gis.dcad_parcels',column}))],
    parcels:[cadParcel()],...options.data } });

test('dense parcel headroom preserves complete exact EWKB and records the actual installed budget', async () => {
  const geometry=largeParcelGeometry(), data={parcels:[cadParcel('1',SUBJECT,{stored_geometry_ewkb:geometry})]};
  assert.ok(Buffer.byteLength(geometry)>64000);
  const dense=denseCad({data}), result=await dense.reader.capture(request());
  assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
  assert.equal(records(result,'parcels').length,1);
  const retained=records(result,'parcels')[0].data.raw_projection.stored_geometry_ewkb;
  assert.equal(retained,geometry); assert.deepEqual(Buffer.from(retained,'hex'),Buffer.from(geometry,'hex'));
  for (const entry of result.source_capture.sources) assert.equal(entry.payload.projection.definition.limits.row_bytes,DENSE_CAD_CACHE_READER_LIMITS.row_bytes);
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(result.query_evidence)).status,'syntax_valid');
  const sql=dense.calls.find(call=>call.tag==='parcels').text;
  assert.ok(sql.includes(`row_bytes<=${DENSE_CAD_CACHE_READER_LIMITS.row_bytes}`));
  assert.ok(sql.includes(`sum(row_bytes) OVER ()<=${DENSE_CAD_SQL_PAGE_BYTES}`));
  assert.match(sql,/encode\(ST_AsEWKB\(geom\),'hex'\)/); assert.doesNotMatch(sql,/ST_Simplify|ST_Snap|ST_Reduce|substring|substr/i);
  assert.equal(dense.calls.filter(call=>call.tag==='parcels').length,1);
  const legacy=fake({data:{...dense.data},readerFactory:createNeighborhoodCadEvidenceSourceReader,
    accessFactory:createNeighborhoodCadEvidenceReadAccess});
  const refused=await legacy.reader.capture(request());
  assert.equal(refused.status,'incomplete'); assert.deepEqual(refused.incomplete_reasons,['row_bytes_limit']);
  assert.equal(refused.source_capture,null); assert.doesNotMatch(legacy.calls.find(call=>call.tag==='parcels').text,/ OVER /);
});

test('only dense parcels materialize encoding and size; every fixed projection and nonparcel SQL remains unchanged',async () => {
  const data={transactions:[transaction()],links:[link()]};
  const dense=denseCad({data,limits:{page_size:250}});
  const legacy=fake({data:{...dense.data},readerFactory:createNeighborhoodCadEvidenceSourceReader,
    accessFactory:createNeighborhoodCadEvidenceReadAccess});
  const current=await dense.reader.capture(request()), original=await legacy.reader.capture(request());
  assert.equal(current.status,'captured'); assert.equal(original.status,'captured');
  const sql=dense.calls.find(call=>call.tag==='parcels').text;
  const old=legacy.calls.find(call=>call.tag==='parcels').text;
  assert.equal(sql.split('), encoded AS MATERIALIZED (')[0],old.split('), encoded AS (')[0]);
  assert.equal((sql.match(/to_jsonb\(projected\)/g)??[]).length,1);
  assert.equal((sql.match(/octet_length\(payload::text\)/g)??[]).length,1);
  assert.match(sql, /encoded AS MATERIALIZED \([\s\S]*measured AS MATERIALIZED \(/);
  assert.match(sql, /SELECT payload,octet_length\(payload::text\) AS row_bytes FROM encoded/);
  assert.match(sql, /FROM measured ORDER BY \(payload->>'object_id'\)::bigint$/);
  assert.doesNotMatch(sql,/selected_ids|page_ids|JOIN page|ST_Simplify/);
  for(const call of legacy.calls.filter(call=>!['parcels','settings'].includes(call.tag))) {
    const actual=dense.calls.find(value=>value.tag===call.tag);
    assert.ok(actual,call.tag);
    assert.equal(actual.text.replace(` AND sum(octet_length(payload::text)) OVER ()<=${DENSE_CAD_SQL_PAGE_BYTES}`,''),call.text,call.tag);
    assert.deepEqual(actual.values,call.values,call.tag);
  }
  for(const role of ['selection','parcels','accounts','transactions','sale_links','gis_sync'])
    assert.deepEqual(records(current,role),records(original,role));
});

for(const size of [128000,128001]) test(`dense parcel measured row boundary ${size} keeps fail-closed retention`,async () => {
  const db=denseCad({intercept:({tag})=>tag==='parcels'
    ?{rows:[{payload:size===128000?cadParcel():null,row_bytes:size}]}:undefined});
  const result=await db.reader.capture(request());
  assert.equal(result.status,size===128000?'captured':'incomplete');
  if(size===128001) {
    assert.equal(result.source_capture,null); assert.deepEqual(result.incomplete_reasons,['row_bytes_limit']);
    assert.equal(result.counts.records,1);
  }
  assert.equal(db.calls.filter(call=>call.tag==='parcels').length,1);
});

test('retained legacy dense limits and every small-row evidence record stay unchanged', async () => {
  const old=denseCad({limits:{row_bytes:64000,bytes:128000000,page_size:250}}), current=denseCad();
  const before=await old.reader.capture(request()), after=await current.reader.capture(request());
  assert.equal(before.status,'captured'); assert.equal(after.status,'captured');
  const originalBytes=JSON.stringify(before.query_evidence), originalHashes=captureHashes(before);
  for (const role of ['selection','parcels','accounts','transactions','sale_links','gis_sync']) assert.deepEqual(records(after,role),records(before,role));
  assert.equal(before.counts.bytes,after.counts.bytes); assert.equal(before.counts.records,after.counts.records);
  assert.equal(prepareCohortLocalQueryEvidenceV1(originalBytes).status,'syntax_valid');
  assert.equal(JSON.stringify(before.query_evidence),originalBytes); assert.deepEqual(captureHashes(before),originalHashes);
  for (const entry of before.source_capture.sources) {
    assert.equal(entry.payload.projection.definition.limits.row_bytes,64000);
    assert.equal(entry.payload.projection.definition.limits.bytes,128000000);
    assert.equal(entry.payload.projection.definition.limits.page_size,250);
  }
  assert.notEqual(before.selection_sha256,after.selection_sha256,'new captures honestly hash their changed budget instead of relabeling old evidence');
});

test('dense byte admission accepts the exact metered boundary and refuses one byte less without partial evidence',async () => {
  const data={transactions:[transaction()],links:[link()]};
  const baseline=await denseCad({data}).reader.capture(request());
  assert.equal(baseline.status,'captured');
  const retainedBytes=['selection','parcels','accounts','transactions','sale_links','gis_sync']
    .flatMap(role=>records(baseline,role)).reduce((sum,row)=>sum+Buffer.byteLength(canonicalAssessmentJson(row)),0);
  assert.ok(baseline.counts.bytes>retainedBytes,'the aggregate meter also covers independent closure identities');
  const exact=await denseCad({data,limits:{bytes:baseline.counts.bytes}}).reader.capture(request());
  assert.equal(exact.status,'captured'); assert.equal(exact.counts.bytes,baseline.counts.bytes);
  for (const entry of exact.source_capture.sources) assert.equal(entry.payload.projection.definition.limits.bytes,baseline.counts.bytes);
  const refused=await denseCad({data,limits:{bytes:baseline.counts.bytes-1}}).reader.capture(request());
  assert.equal(refused.status,'incomplete'); assert.equal(refused.source_capture,null);
  assert.deepEqual(refused.incomplete_reasons,['byte_limit']);
  assert.equal(DENSE_CAD_CACHE_READER_LIMITS.bytes,140000000);
});

test('dense reader record meter leaves bounded envelope and chunk headroom without enlarging downstream limits',()=>{
  // Conservative simultaneous width maxima, not a valid source-authority claim.
  // These are the closed successful-reader fields: missing capabilities/gaps
  // fail before finalization, and arbitrary source text remains metered records.
  const compact=makeCohortLocalQueryMetadata({workflowType:'uad_3_6',subjectId:'\uffff'.repeat(64)});
  compact.mapping_version=5;
  compact.authorization.selection.id='\uffff'.repeat(200);
  compact.authorization.selection.revision=2147483647;
  compact.authorization.market_decision.decision_id='\uffff'.repeat(200);
  compact.authorization.market_decision.policy_revision='\uffff'.repeat(200);
  compact.authorization.transaction_closure.source_revision='\uffff'.repeat(200);
  for(const key of ['transaction_count','link_count','legacy_sale_count','account_count','source_record_count'])
    compact.authorization.transaction_closure[key]=200000;
  compact.limits={...DENSE_CAD_CACHE_READER_LIMITS};compact.selection_sha256='f'.repeat(64);compact.selected_account_count=50000;
  const scope=compact.scope,role='transactions',digest='f'.repeat(64),at='9999-12-31T23:59:59.999Z',version=NEIGHBORHOOD_CACHE_READER_VERSION;
  const envelope={schema_version:1,scope,
    upstream:{id:`local-cache:${role}`,key:role,state:'present_empty',complete:true,revision:`${version}:${digest}`,
      upstream_content_sha256:digest,captured_at:at,visibility:'assignment_private',scope,row_count:200000},
    projection:{id:`cache-${role}`,revision:version,definition:{...compact,role,source_gaps:[]},
      input_row_count:200000,output_record_count:200000,complete:true},
    metadata:{id:`local-cache-${role}`,provider:'HomeNode local database projection',revision:version,
      valid_from:null,valid_to:null,observed_at:at,historical_availability:'unknown'},
    partition:{index:999,count:1000,record_count:200000},records:[]};
  const bytes=Buffer.byteLength(canonicalAssessmentJson(envelope));
  assert.ok(bytes<=6605,'closed reader metadata must stay within this independently measured envelope bound');
  assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS.input_bytes,144000000);
  assert.equal(DENSE_CAD_SOURCE_CAPTURE_LIMITS.output_bytes,160000000);
  assert.ok(DENSE_CAD_CACHE_READER_LIMITS.bytes+6*bytes<DENSE_CAD_SOURCE_CAPTURE_LIMITS.input_bytes);
  assert.ok(DENSE_CAD_CACHE_READER_LIMITS.bytes+CACHED_SOURCE_CAPTURE_LIMITS.output_captures*bytes
    +DENSE_CAD_CACHE_READER_LIMITS.records<DENSE_CAD_SOURCE_CAPTURE_LIMITS.output_bytes,
  'same records plus every possible chunk envelope and record separator fit the existing output budget');
});

test('new parcel row ceiling still refuses the whole capture without clipping geometry or retrying', async () => {
  const geometry=largeParcelGeometry(Math.ceil(DENSE_CAD_CACHE_READER_LIMITS.row_bytes/32)+1);
  const db=denseCad({data:{parcels:[cadParcel('1',SUBJECT,{stored_geometry_ewkb:geometry})]}});
  const result=await db.reader.capture(request());
  assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
  assert.deepEqual(result.incomplete_reasons,['row_bytes_limit']);
  assert.equal(db.calls.filter(call=>call.tag==='parcels').length,1); assert.equal(db.calls.at(-1).tag,'rollback');
  assert.equal(db.releases.length,1);
});

for (const sentinel of [true,false]) test(`dense page guard refuses the entire page including lookahead (SQL sentinel=${sentinel})`, async () => {
  const rows=Math.floor(DENSE_CAD_SQL_PAGE_BYTES/DENSE_CAD_CACHE_READER_LIMITS.row_bytes)+1;
  assert.ok(rows<=251);
  const db=denseCad({limits:{page_size:250},intercept:({tag})=>tag==='parcels'?{rows:Array.from({length:rows},(_,index)=>({
    payload:sentinel?null:cadParcel(String(index+1)),row_bytes:DENSE_CAD_CACHE_READER_LIMITS.row_bytes}))}:undefined});
  const result=await db.reader.capture(request());
  assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
  assert.deepEqual(result.incomplete_reasons,['page_bytes_limit']);
  assert.equal(result.counts.records,1,'only the account selection was charged; no prefix of the rejected parcel page was retained');
  assert.equal(db.calls.filter(call=>call.tag==='parcels').length,1); assert.equal(db.calls.at(-1).tag,'rollback');
  assert.equal(db.releases.length,1);
});

test('dense account and sale projections keep the original 64KB row ceiling', async () => {
  for (const tag of ['accounts','transactions']) {
    const db=denseCad({data:tag==='transactions'?{transactions:[transaction()]}:{},intercept:({tag:actual,text})=> {
      if (actual!==tag) return undefined;
      assert.match(text,/octet_length\(payload::text\)<=64000/);
      return {rows:[{payload:{},row_bytes:64001}]};
    }});
    const result=await db.reader.capture(request());
    assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
    assert.deepEqual(result.incomplete_reasons,['row_bytes_limit']); assert.equal(db.calls.at(-1).tag,'rollback');
  }
});

test('dense 500-row stock pages preserve every record while identity and sale pages remain bounded at 250', async () => {
  const ids=[SUBJECT,...Array.from({length:1000},(_,index)=>`PAGE-${String(index).padStart(4,'0')}`)].sort();
  const data={parcels:ids.map((id,index)=>cadParcel(String(index+1),id)),
    accounts:ids.map(account_id=>({account_id,subdivision:'Synthetic Plat'})),
    transactions:Array.from({length:501},(_,index)=>transaction(String(index+1)))};
  const old=denseCad({limits:{page_size:250},data}), fast=denseCad({data});
  const before=await old.reader.capture(request({account_ids:ids})), after=await fast.reader.capture(request({account_ids:ids}));
  assert.equal(before.status,'captured'); assert.equal(after.status,'captured');
  for (const role of ['selection','parcels','accounts','transactions','sale_links','gis_sync']) assert.deepEqual(records(after,role),records(before,role));
  assert.equal(after.counts.bytes,before.counts.bytes); assert.equal(after.counts.records,before.counts.records);
  for (const tag of ['parcels','accounts']) {
    assert.equal(old.calls.filter(call=>call.tag===tag).length,5);
    assert.equal(fast.calls.filter(call=>call.tag===tag).length,3);
    assert.ok(fast.calls.filter(call=>call.tag===tag).every(call=>call.values.at(-1)===501));
  }
  for (const tag of ['source-ids','transaction-identities','link-identities','transactions','sale-links','legacy-identities','legacy']) {
    assert.deepEqual(fast.calls.filter(call=>call.tag===tag).map(call=>call.values),old.calls.filter(call=>call.tag===tag).map(call=>call.values));
  }
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(before.query_evidence)).status,'syntax_valid');
  assert.equal(prepareCohortLocalQueryEvidenceV1(JSON.stringify(after.query_evidence)).status,'syntax_valid');
  assert.ok(before.source_capture.sources.every(source=>source.payload.projection.definition.limits.page_size===250));
  assert.ok(after.source_capture.sources.every(source=>source.payload.projection.definition.limits.page_size===500));
});

for (const tag of ['parcels','accounts']) test(`dense ${tag} page fallback retains no refused prefix and reuses the exact cursor/snapshot`,async () => {
  const ids=[SUBJECT,...Array.from({length:599},(_,index)=>`FALLBACK-${String(index).padStart(4,'0')}`)].sort();
  const data={parcels:ids.map((id,index)=>cadParcel(String(index+1),id)),
    accounts:ids.map(account_id=>({account_id,subdivision:'Synthetic Plat'}))};
  const expected=denseCad({limits:{page_size:250},data});
  const candidate=denseCad({data,intercept:({tag:actual,values,data:all})=> {
    if (actual!==tag) return undefined;
    const page=all[tag].filter(row=>values[0].includes(row.account_id)
      && (tag==='parcels'?BigInt(row.object_id)>BigInt(values[1]):row.account_id>values[1]))
      .sort((a,b)=>tag==='parcels'?numeric(a.object_id,b.object_id):compare(a.account_id,b.account_id)).slice(0,values[2]);
    const bytes=32065;
    return {rows:page.map(payload=>({payload:page.length*bytes>DENSE_CAD_SQL_PAGE_BYTES?null:structuredClone(payload),row_bytes:bytes}))};
  }});
  const before=await expected.reader.capture(request({account_ids:ids})), after=await candidate.reader.capture(request({account_ids:ids}));
  assert.equal(before.status,'captured'); assert.equal(after.status,'captured',JSON.stringify(after.incomplete_reasons));
  for (const role of ['selection','parcels','accounts','transactions','sale_links','gis_sync']) assert.deepEqual(records(after,role),records(before,role));
  assert.equal(after.counts.bytes,before.counts.bytes); assert.equal(after.counts.records,before.counts.records);
  const calls=candidate.calls.filter(call=>call.tag===tag);
  assert.deepEqual(calls.map(call=>call.values.at(-1)),[501,251,251,251]);
  assert.deepEqual(calls[0].values.slice(0,-1),calls[1].values.slice(0,-1),'the refused page cannot advance its account batch or cursor');
  assert.equal(candidate.connects,1); assert.equal(candidate.calls.filter(call=>call.tag==='begin').length,1);
  assert.equal(candidate.calls.filter(call=>call.tag==='commit').length,1); assert.equal(candidate.releases.length,1);
});

test('dense stock fallback is bounded once and cannot conceal an oversized individual lookahead row',async () => {
  for (const reason of ['row','page']) {
    const db=denseCad({intercept:({tag,values})=> {
      if (tag!=='parcels') return undefined;
      if (reason==='row') return {rows:Array.from({length:501},(_,index)=>({payload:index===500?null:cadParcel(String(index+1)),
        row_bytes:index===500?128001:100}))};
      return {rows:Array.from({length:values[2]},(_,index)=>({payload:null,row_bytes:128000}))};
    }});
    const result=await db.reader.capture(request());
    assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
    assert.deepEqual(result.incomplete_reasons,[reason==='row'?'row_bytes_limit':'page_bytes_limit']);
    assert.equal(db.calls.filter(call=>call.tag==='parcels').length,reason==='row'?1:2);
    assert.equal(result.counts.records,1,'no prefix of either refused page is retained');
    assert.equal(db.calls.at(-1).tag,'rollback'); assert.equal(db.releases.length,1);
  }
});

test('dense CAD account batches preserve the complete mapping4 record sets and scope', async () => {
  const ids = [SUBJECT, ...Array.from({ length: 2100 }, (_, n) => `CAD-${String(n).padStart(5, '0')}`)].sort();
  const data = { catalog: [...CATALOG, ...CACHED_CAD_EVIDENCE_FIELDS.map(column => ({relation:'gis.dcad_parcels',column}))],
    parcels: ids.map((account_id, n) => ({ ...parcel(String(ids.length-n),account_id),
      class_code: 'A1', class_description: 'Single family', use_description: 'Residential', structure_type: null, built_up: true })),
    accounts: ids.map(account_id => ({ account_id, county: 'Dallas', subdivision: 'Synthetic subdivision' })) };
  const base = fake({ readerFactory:createNeighborhoodCadEvidenceSourceReader, accessFactory:createNeighborhoodCadEvidenceReadAccess, data });
  const dense = fake({ readerFactory:createNeighborhoodDenseCadEvidenceSourceReader, accessFactory:createNeighborhoodCadEvidenceReadAccess, data });
  const original = await base.reader.capture(request({account_ids:ids}));
  const result = await dense.reader.capture(request({account_ids:ids}));
  assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
  assert.equal(original.status,'captured',JSON.stringify(original.incomplete_reasons));
  for (const role of ['selection','parcels','accounts','transactions','sale_links','gis_sync']) assert.deepEqual(records(result,role),records(original,role));
  for (const call of dense.calls.filter(call => ['parcels','accounts'].includes(call.tag))) assert.ok(call.values[0].length<=1000);
  assert.equal(result.counts.records,original.counts.records);
  assert.equal(result.counts.bytes,original.counts.bytes);
  assert.equal(dense.releases.length,1);
});

const emptyWitness=() => ({witness_version:1,root_state:'object',root_json_type:'object',
  fields:Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key,{state:'absent',json_type:null,value_text:null,utf8_bytes:null}]))});
function witnessFixture(changes={}) {
  const row=transaction('10',{source_mls_status:'Closed',source_row_number:1,source_raw_witness:emptyWitness(),...changes});
  return fake({readerFactory:createNeighborhoodSaleWitnessSourceReader,accessFactory:createNeighborhoodSaleWitnessReadAccess,
    authorizeMarketData:async(_auth,_context,purpose) => {
      assert.equal(purpose.source_projection.id,'cached-sale-scalar-witness-v1');
      assert.deepEqual(purpose.source_projection.fields,CACHED_SALE_WITNESS_FIELDS);
      return {allowed:true,decision_id:'synthetic-witness-only',policy_revision:'synthetic-witness-v1'};
    },data:{transactions:[row],links:[link()],catalog:[...CATALOG,
      ...['mls_status','source_row_number','raw_payload'].map(column=>({relation:'core.sales_source_records',column}))]}});
}

test('installed witness reader retains mapping3 under its explicit projection purpose and keeps default mapping2',async()=>{
  const f=witnessFixture(), result=await f.reader.capture(request());
  assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
  for(const role of ['parcels','accounts','transactions','sale_links'])for(const row of records(result,role))
    assert.equal(row.data.data.cached_mapping_version,3);
  const row=records(result,'transactions')[0].data;
  assert.equal(row.raw_projection.source_mls_status,'Closed');
  assert.deepEqual(row.raw_projection.source_raw_witness,emptyWitness());
  assert.equal(row.data.market_eligible,null); assert.equal(row.data.gla_sqft_at_sale,null);
  assert.match(f.calls.find(call=>call.tag==='transactions').text,/jsonb_object_agg/);
  assert.doesNotMatch(f.calls.find(call=>call.tag==='transactions').text,/src\.raw_payload\s+AS\s+raw_payload/);
  const normal=fake({data:{transactions:[transaction()],links:[link()]}});
  const baseline=await normal.reader.capture(request());
  assert.equal(baseline.status,'captured');
  assert.equal(records(baseline,'transactions')[0].data.data.cached_mapping_version,2);
  assert.equal(Object.hasOwn(records(baseline,'transactions')[0].data.raw_projection,'source_raw_witness'),false);
  assert.doesNotMatch(normal.calls.find(call=>call.tag==='transactions').text,/raw_payload|source_mls_status/);
});

test('witness columns unavailable refuse capture without source reads or fallback to mapping2',async()=>{
  for(const column of ['mls_status','source_row_number','raw_payload']){
    const f=witnessFixture(); f.data.catalog=f.data.catalog.filter(row=>row.column!==column);
    const result=await f.reader.capture(request());
    assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
    assert.equal(f.calls.some(call=>call.tag==='transactions'),false);
  }
});

test('malformed or whole-overflow witness refuses the complete capture; no shortened success',async()=>{
  for(const source_raw_witness of [null,{}, {...emptyWitness(),witness_version:2}]){
    const result=await witnessFixture({source_raw_witness}).reader.capture(request());
    assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
  }
});

test('witness value/type/presence changes affect retained source hashes while normal observations remain unknown',async()=>{
  const before=await witnessFixture().reader.capture(request());
  const w=emptyWitness(); w.fields.ClosePrice={state:'scalar',json_type:'string',value_text:'282500.00',utf8_bytes:9};
  const after=await witnessFixture({source_raw_witness:w}).reader.capture(request());
  assert.equal(after.status,'captured'); assert.notDeepEqual(captureHashes(before),captureHashes(after));
  assert.equal(records(after,'transactions')[0].data.data.market_eligible,null);
});

// Retain the actual reader; fake().reader deliberately creates a new one per call.
function originalCaptureFixture(options = {}, input = request()) {
  const db = fake(options);
  const access = createTestCachedReadAccess(input, { transactionClosure: fixtureClosure(db.data, input.account_ids) });
  const reader = createNeighborhoodCachedSourceReader(db.pool, { access: access.access, limits: options.limits || {} });
  return { db, reader, async prepareCapture() {
    const prepared = await access.prepare();
    const expectedRequest = structuredClone(prepared.request);
    const captureRequest = { ...structuredClone(prepared.request), auth: access.auth,
      selection_grant: prepared.selection_grant, market_grant: prepared.market_grant };
    return { expectedRequest, request: captureRequest, capture: () => reader.capture(captureRequest) };
  } };
}
const originalCaptureRequired = { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' };
function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertRecursivelyFrozen(child);
}

test('original cached acquisition retains full consumed closure and exact pre-hash metadata once', async () => {
  const fixture = originalCaptureFixture({ data: { transactions: [transaction()], links: [link(),
    link('101', { parcel_sequence: 2, parcel_role: 'additional', account_id: 'SECONDARY' })] } });
  const prepared = await fixture.prepareCapture();
  const result = await prepared.capture();
  assert.equal(result.status, 'captured');
  const publicJson = JSON.stringify(result), hashes = captureHashes(result);
  const publicKeys = Reflect.ownKeys(result);
  const calls = fixture.db.calls.length, releases = fixture.db.releases.length;
  const handoff = consumeNeighborhoodCachedAcquisition(fixture.reader, result);
  assert.deepEqual(Object.keys(handoff).sort(), ['authority', 'capture_result', 'captured_query_request',
    'compact_metadata_json', 'provenance', 'version']);
  assert.equal(handoff.version, 1);
  assert.equal(handoff.provenance, 'original_cached_reader_invocation');
  assert.equal(handoff.authority, 'not_established');
  assert.strictEqual(handoff.capture_result, result);
  assert.deepEqual(handoff.captured_query_request, prepared.expectedRequest);
  assert.notStrictEqual(handoff.captured_query_request, prepared.request);
  assert.deepEqual(handoff.captured_query_request.transaction_closure, prepared.expectedRequest.transaction_closure);
  assert.match(JSON.stringify(handoff.captured_query_request.transaction_closure), /SECONDARY/);
  assertRecursivelyFrozen(handoff);
  for (const key of ['auth', 'selection_grant', 'market_grant']) {
    assert.equal(Object.hasOwn(handoff.captured_query_request, key), false);
  }
  const blobs = new Map(result.query_evidence.blobs.map(item => [item.ref.content_sha256, item.canonical_json]));
  const preimage = JSON.parse(blobs.get(result.query_evidence.query_preimage.content_sha256));
  assert.equal(handoff.compact_metadata_json, blobs.get(preimage.compact_metadata.content_sha256));
  const metadata = JSON.parse(handoff.compact_metadata_json);
  assert.equal(canonicalAssessmentJson(metadata), handoff.compact_metadata_json);
  assert.equal(Object.hasOwn(metadata, 'selection_sha256'), false);
  assert.equal(Object.hasOwn(metadata, 'selected_account_count'), false);
  assert.equal(cohortFixtureQueryHash(metadata, handoff.captured_query_request.account_ids), result.selection_sha256);
  assert.ok(result.unsupported_capabilities.includes('provider_coverage'));
  assert.deepEqual(publicKeys.sort(), ['capabilities', 'captured_at', 'counts', 'incomplete_reasons',
    'query_complete', 'query_evidence', 'reader_version', 'scope', 'selection_sha256', 'source_capture',
    'status', 'unsupported_capabilities']);
  assert.deepEqual(Reflect.ownKeys(result).sort(), publicKeys);
  assert.equal(JSON.stringify(result), publicJson);
  assert.deepEqual(captureHashes(result), hashes);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, result), originalCaptureRequired);
  assert.equal(fixture.db.calls.length, calls);
  assert.equal(fixture.db.releases.length, releases);
});

test('wrong readers and copied successful results cannot consume an original acquisition', async () => {
  const fixture = originalCaptureFixture(), other = originalCaptureFixture();
  const result = await (await fixture.prepareCapture()).capture();
  assert.equal(result.status, 'captured');
  for (const wrongReader of [other.reader, { ...fixture.reader }, null]) {
    assert.throws(() => consumeNeighborhoodCachedAcquisition(wrongReader, result), originalCaptureRequired);
  }
  for (const copy of [{ ...result }, JSON.parse(JSON.stringify(result)), structuredClone(result),
    Object.create(result), { status: 'captured', query_complete: true }, null, undefined]) {
    assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, copy), originalCaptureRequired);
  }
  assert.strictEqual(consumeNeighborhoodCachedAcquisition(fixture.reader, result).capture_result, result);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, result), originalCaptureRequired);
});

test('identical captures have independent original one-use handoffs on the same reader', async () => {
  const fixture = originalCaptureFixture();
  const first = await (await fixture.prepareCapture()).capture();
  const second = await (await fixture.prepareCapture()).capture();
  assert.equal(first.status, 'captured'); assert.equal(second.status, 'captured');
  assert.notStrictEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const secondHandoff = consumeNeighborhoodCachedAcquisition(fixture.reader, second);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, second), originalCaptureRequired);
  const firstHandoff = consumeNeighborhoodCachedAcquisition(fixture.reader, first);
  assert.strictEqual(firstHandoff.capture_result, first);
  assert.strictEqual(secondHandoff.capture_result, second);
  assert.notStrictEqual(firstHandoff, secondHandoff);
  assert.equal(firstHandoff.compact_metadata_json, secondHandoff.compact_metadata_json);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, first), originalCaptureRequired);
});

test('SQL, release, selected-account coverage and capability failures have no original handoff', async t => {
  const cases = [
    ['SQL', { intercept({ tag }) { if (tag === 'parcels') throw new Error('PRIVATE ORIGINAL QUERY'); } }],
    ['release', { release() { throw new Error('PRIVATE ORIGINAL RELEASE'); } }],
    ['coverage', { data: { parcels: [] } }],
    ['capability', { data: { catalog: CATALOG.filter(row => row.column !== 'object_id') } }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => {
    const fixture = originalCaptureFixture(options);
    const result = await (await fixture.prepareCapture()).capture();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.query_complete, false);
    const publicJson = JSON.stringify(result), calls = fixture.db.calls.length;
    assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, result), originalCaptureRequired);
    assert.throws(() => consumeNeighborhoodCachedAcquisition(fixture.reader, structuredClone(result)), originalCaptureRequired);
    assert.equal(JSON.stringify(result), publicJson);
    assert.doesNotMatch(publicJson, /PRIVATE ORIGINAL/);
    assert.equal(fixture.db.calls.length, calls);
  });
});

test('source request mutation during SQL cannot rewrite the consumed original request or closure', async () => {
  let mutableRequest, mutated = false;
  const fixture = originalCaptureFixture({ data: { transactions: [transaction()], links: [link()] },
    intercept({ tag }) {
      if (tag !== 'begin') return;
      mutableRequest.account_ids[0] = 'MUTATED';
      mutableRequest.scope.account_id = 'MUTATED';
      mutableRequest.target.workflow_target_id = '999';
      mutableRequest.observation_period.start_date = '2000-01-01';
      mutableRequest.transaction_closure.source_revision = 'mutated-revision';
      mutableRequest.transaction_closure.transactions = [];
      mutated = true;
    } });
  const prepared = await fixture.prepareCapture();
  mutableRequest = prepared.request;
  const result = await prepared.capture();
  assert.ok(mutated);
  assert.equal(result.status, 'captured');
  const publicJson = JSON.stringify(result);
  const handoff = consumeNeighborhoodCachedAcquisition(fixture.reader, result);
  assert.deepEqual(handoff.captured_query_request, prepared.expectedRequest);
  assertRecursivelyFrozen(handoff.captured_query_request);
  assert.throws(() => { handoff.captured_query_request.account_ids[0] = 'ALTERED'; }, TypeError);
  assert.throws(() => { handoff.captured_query_request.transaction_closure.source_revision = 'ALTERED'; }, TypeError);
  assert.doesNotMatch(JSON.stringify(handoff.captured_query_request), /MUTATED|mutated-revision/);
  assert.equal(JSON.stringify(result), publicJson);
});

for (const linkCount of [400, 2000]) test(`a verified ${linkCount}-link closure stays out of bounded capture envelopes`, async () => {
  const db = fake({ data: { transactions: [transaction()], links: Array.from({ length: linkCount }, (_, index) =>
    link(String(100 + index), { parcel_sequence: index + 1 })) } });
  const prepare = async () => {
    const fixture = createTestCachedReadAccess(request(), { transactionClosure: fixtureClosure(db.data, [SUBJECT]) });
    const prepared = await fixture.prepare();
    return { closure: prepared.request.transaction_closure, capture: () =>
      createNeighborhoodCachedSourceReader(db.pool, { access: fixture.access }).capture({ ...prepared.request,
        auth: fixture.auth, selection_grant: prepared.selection_grant, market_grant: prepared.market_grant }) };
  };
  const approved = await prepare();
  const closureBytes = Buffer.byteLength(JSON.stringify(approved.closure));
  const envelopeLimit = CACHED_SOURCE_CAPTURE_LIMITS.envelope_bytes;
  assert.equal(envelopeLimit, 64_000, 'The regression must not raise the capture envelope ceiling');
  if (linkCount === 400) assert.ok(closureBytes > envelopeLimit * 0.85 && closureBytes < envelopeLimit);
  else assert.ok(closureBytes > envelopeLimit * 4, 'The full valid closure must be much larger than an envelope');
  const first = await approved.capture();
  assert.equal(first.status, 'captured'); assert.equal(first.query_complete, true);
  assert.equal(records(first, 'sale_links').length, linkCount);
  assert.ok(db.calls.some(call => call.tag === 'link-identities'));
  assert.equal(db.calls.at(-1).tag, 'commit');
  for (const { payload } of first.source_capture.sources) {
    const definition = payload.projection.definition;
    const authorization = definition.authorization;
    assert.deepEqual(authorization.transaction_closure, { version: 1,
      source_revision: approved.closure.source_revision, closure_sha256: approved.closure.closure_sha256,
      transaction_count: 1, link_count: linkCount, legacy_sale_count: 0, account_count: 1, source_record_count: 1 });
    assert.ok(Object.isFrozen(authorization.transaction_closure));
    assert.equal(definition.reader_version, 'local-capture-v3');
    assert.equal(Object.hasOwn(definition, 'account_ids'), false);
    assert.doesNotMatch(JSON.stringify(definition), /"(?:transactions|links|legacy|closure_account_ids|source_record_ids|legacy_sale_ids)"\s*:/);
    assert.ok(Buffer.byteLength(canonicalAssessmentJson({ ...payload, records: [] })) < envelopeLimit);
  }
  const changed = await prepare();
  db.data.links.at(-1).is_resolved = false;
  const beforeDrift = db.calls.length;
  const stale = await changed.capture();
  assert.equal(stale.status, 'incomplete'); assert.equal(stale.source_capture, null);
  assert.deepEqual(stale.incomplete_reasons, ['transaction_association_drift']);
  assert.ok(!db.calls.slice(beforeDrift).some(call => ['transactions', 'sale-links', 'legacy'].includes(call.tag)));
  // A fresh trusted closure may capture the changed identity; even unchanged
  // parcel bytes must have a different source hash because the closure is bound.
  const refreshed = await prepare();
  assert.notEqual(refreshed.closure.closure_sha256, approved.closure.closure_sha256);
  const second = await refreshed.capture();
  assert.equal(second.status, 'captured');
  assert.deepEqual(records(first, 'parcels'), records(second, 'parcels'));
  const parcelHash = result => result.source_capture.sources.find(row => row.payload.projection.definition.role === 'parcels').id;
  assert.notEqual(parcelHash(first), parcelHash(second));
});

test('missing, forged, altered and cross-organization capabilities cannot connect to the cache',async () => {
  const db=fake();
  assert.throws(() => createNeighborhoodCachedSourceReader(db.pool),/authority_required/);
  for (const mutate of [
    value => { delete value.selection_grant; },
    value => { value.market_grant={}; },
    value => { value.selection_grant={...value.selection_grant}; },
    value => { value.account_ids=[...value.account_ids,'ARBITRARY-NEIGHBOR']; },
    value => { value.scope={...value.scope,organization_id:'10000000-0000-4000-8000-000000000099'}; },
    value => { value.auth={...value.auth,userId:'another-user'}; },
    value => { value.auth={...value.auth,organizations:[]}; },
  ]) {
    const fixture=createTestCachedReadAccess(request());
    const prepared=await fixture.prepare();
    const reader=createNeighborhoodCachedSourceReader(db.pool,{access:fixture.access});
    const transport={...prepared.request,auth:fixture.auth,
      selection_grant:prepared.selection_grant,market_grant:prepared.market_grant};
    mutate(transport);
    await assert.rejects(reader.capture(transport),/neighborhood_cached_read_access_denied/);
    assert.equal(db.connects,0); assert.equal(db.calls.length,0);
  }
});

test('a catalog/assignment-readable actor without licensed market approval never reads cached sales',async () => {
  const db=fake();
  const fixture=createTestCachedReadAccess(request(),{authorizeMarketData:async () => ({allowed:false})});
  await assert.rejects(fixture.prepare(),/market_data_access_denied/);
  assert.equal(db.connects,0); assert.equal(db.calls.length,0);
});

test('changed one-hop associations fail before any full market projection is read or returned',async () => {
  for (const change of [
    data => {data.links[0].account_id='UNAPPROVED-CLOSURE-ACCOUNT';},
    data => {data.transactions.push(transaction('20'));},
    data => {data.transactions=[]; data.links=[];},
    data => {data.legacy.push({sale_id:'44',sale_account_id:SUBJECT});},
  ]) {
  const db=fake({data:{transactions:[transaction()],links:[link()]}});
  const fixture=createTestCachedReadAccess(request(),{transactionClosure:fixtureClosure(db.data,[SUBJECT])});
  const prepared=await fixture.prepare();
  change(db.data);
  const result=await createNeighborhoodCachedSourceReader(db.pool,{access:fixture.access}).capture({
    ...prepared.request,auth:fixture.auth,selection_grant:prepared.selection_grant,market_grant:prepared.market_grant});
  assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
  assert.deepEqual(result.incomplete_reasons,['transaction_association_drift']);
  assert.ok(!db.calls.some(call => ['transactions','sale-links','legacy'].includes(call.tag)));
  assert.ok(db.calls.some(call => call.tag==='rollback'));
  }
});

test('closure-only accounts do not seed second-hop transactions or enter the statistical selection',async () => {
  const db=fake({data:{transactions:[transaction('10',{primary_account_id:'OUTSIDE',sale_account_id:'OUTSIDE'}),
    transaction('99',{primary_account_id:'OUTSIDE',sale_account_id:'OUTSIDE'})],
    links:[link('100',{account_id:'OUTSIDE'}),link('101',{account_id:SUBJECT,source_position:2}),
      link('990',{source_record_id:'99',account_id:'OUTSIDE'})]}});
  const result=await db.reader.capture(request());
  assert.equal(result.status,'captured');
  assert.deepEqual(records(result,'transactions').map(row => row.data.raw_projection.source_record_id),['10']);
  assert.deepEqual(records(result,'selection').map(row => row.data.account_id),[SUBJECT]);
  assert.deepEqual(records(result,'parcels').map(row => row.data.raw_projection.account_id),[SUBJECT]);
  assert.ok(db.calls.filter(call => call.tag==='source-ids').every(call => call.values[0].length===1 && call.values[0][0]===SUBJECT));
});

test('one read-only repeatable snapshot binds exact authorized case, snapshot, subject and dates', async () => {
  assert.equal(new Set(CATALOG.map(row => row.relation)).size, 7);
  const db = fake();
  const input = request(), before = structuredClone(input);
  const result = await db.reader.capture(input);
  assert.equal(result.status, 'captured');
  assert.equal(result.query_complete, true);
  assert.deepEqual(input, before);
  assert.equal(db.connects, 1); assert.equal(db.poolQueries, 0); assert.equal(db.releases.length, 1);
  assert.match(db.calls[0].text, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.equal(db.calls.at(-1).tag, 'commit');
  const scope = db.calls.find(row => row.tag === 'scope');
  assert.deepEqual(scope.values, Object.values(ASSESSMENT_SCOPE));
  assert.match(scope.text, /s\.appraisal_case_id\s*=\s*c\.id/);
  assert.match(scope.text, /c\.organization_id\s*=\s*\$1/);
  assert.match(scope.text, /c\.account_id\s*=\s*\$4/);
  assert.match(scope.text, /clock_timestamp\(\)/);
  assert.doesNotMatch(scope.text, /transaction_timestamp\(\)/);
  for (const { payload } of result.source_capture.sources) {
    assert.deepEqual(payload.scope, ASSESSMENT_SCOPE);
    assert.equal(payload.projection.definition.effective_date, input.effective_date);
    assert.deepEqual(payload.projection.definition.observation_period, input.observation_period);
    assert.equal(payload.metadata.observed_at, NOW);
    assert.equal(payload.projection.definition.capture_observed_at, NOW_PRECISE);
  }
  assert.ok(result.source_capture.source_snapshots.every(row => row.visibility === 'assignment'
    && row.historical_availability === 'unknown' && row.valid_from === null && row.valid_to === null));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.source_capture.sources[0].payload.records));
});

test('secondary membership discovers sales and preserves every outside-area and unresolved link across pages', async () => {
  const db = fake({ limits: { page_size: 2 }, data: {
    transactions: [transaction('10', { primary_account_id: 'OUTSIDE', sale_account_id: 'OUTSIDE' })],
    links: [link('100', { account_id: 'OUTSIDE' }), link('101', { account_id: SUBJECT, source_position: 2 }),
      link('102', { account_id: null, source_position: 2, parcel_sequence: 2, is_resolved: false, match_method: 'unmatched' }),
      link('103', { account_id: 'OUTSIDE-2', source_position: 2, parcel_sequence: 3 })] } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'captured');
  assert.equal(records(result, 'transactions').length, 1);
  assert.deepEqual(records(result, 'sale_links').map(row => row.data.raw_projection.account_id), ['OUTSIDE', SUBJECT, null, 'OUTSIDE-2']);
  const discovery = db.calls.find(row => row.tag === 'source-ids');
  assert.match(discovery.text, /FROM core\.sale_parcels WHERE account_id=ANY\(\$1::text\[\]\)/);
  assert.match(discovery.text, /FROM core\.sales WHERE account_id=ANY\(\$1::text\[\]\)/);
  for (const call of db.calls.filter(row => row.tag === 'sale-links')) {
    assert.deepEqual(call.values[0], ['10']);
    assert.doesNotMatch(call.text, /WHERE account_id/);
  }
  assert.equal(db.calls.filter(row => row.tag === 'sale-links').length, 2);
});

test('source-only, legacy, repeated and future rows stay distinct evidence without invented canonical IDs or price eligibility', async () => {
  const db = fake({ data: { transactions: [transaction(), transaction('11', { sale_id: null, sale_account_id: null }),
    transaction('12', { sale_closing_date: '2027-01-01', source_close_date: '2027-01-01' })],
    legacy: [{ sale_id: '44', sale_account_id: SUBJECT, source_record_id: null, sale_price: '300000', sale_closing_date: '2024-03-01' }] } });
  const result = await db.reader.capture(request());
  const captured = records(result, 'transactions');
  assert.equal(captured.length, 4);
  assert.equal(captured.find(row => row.record_id === 'source:11').data.data.canonical_transaction_id, null);
  assert.equal(captured.find(row => row.record_id === 'legacy:44').data.data.source_record_id, null);
  assert.equal(captured.find(row => row.record_id === 'source:12').data.raw_projection.sale_closing_date, '2027-01-01');
  assert.ok(captured.every(row => row.data.data.market_eligible === null));
  assert.ok(result.unsupported_capabilities.includes('verified_market_eligibility'));
  assert.equal(result.source_capture.sources[0].payload.projection.definition.selection_method,
    'exact_selected_accounts_all_source_links_no_event_filter');
});

test('content hashes bind actual mutable facts even when the upstream hash token never changes', async () => {
  const first = await fake().reader.capture(request());
  const same = await fake().reader.capture(request());
  assert.deepEqual(captureHashes(first), captureHashes(same));
  const changed = fake(); changed.data.parcels[0].residential_area_sqft = '2200';
  const next = await changed.reader.capture(request());
  const hash = result => result.source_capture.sources.find(row => row.payload.projection.definition.role === 'parcels').id;
  assert.notEqual(hash(first), hash(next));
  assert.equal(records(first, 'parcels')[0].data.raw_projection.source_record_hash,
    records(next, 'parcels')[0].data.raw_projection.source_record_hash);
});

test('scope, dates and sorted exact selection bind the capture signature', async () => {
  const setup = () => fake({ data: { parcels: [parcel(), parcel('2', 'P2')], accounts: [] } });
  const a = await setup().reader.capture(request({ account_ids: [SUBJECT, 'P2'] }));
  const b = await setup().reader.capture(request({ account_ids: ['P2', SUBJECT] }));
  assert.equal(a.selection_sha256, b.selection_sha256);
  const c = await setup().reader.capture(request({ observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' }, account_ids: [SUBJECT, 'P2'] }));
  assert.notEqual(a.selection_sha256, c.selection_sha256);
  const d = await setup().reader.capture(request({ scope: { ...ASSESSMENT_SCOPE, organization_id: '10000000-0000-4000-8000-000000000099' }, account_ids: [SUBJECT, 'P2'] }));
  assert.notEqual(a.selection_sha256, d.selection_sha256);
});

test('known-empty sales differ from absent or unsupported schema and never fabricate usable captures', async () => {
  const empty = await fake().reader.capture(request());
  assert.equal(empty.status, 'captured');
  assert.equal(records(empty, 'transactions').length, 0);
  assert.equal(empty.source_capture.sources.find(row => row.payload.projection.definition.role === 'transactions').payload.upstream.state, 'present_empty');
  for (const remove of [row => row.relation === 'core.sale_parcels', row => row.relation === 'core.sales_source_records' && row.column === 'source_modified_at']) {
    const db = fake({ data: { catalog: CATALOG.filter(row => !remove(row)) } });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.query_complete, false);
    assert.equal(result.source_capture, null);
    assert.ok(result.incomplete_reasons.some(reason => /absent|unsupported_schema/.test(reason)));
    assert.equal(db.calls.some(row => row.tag === 'source-ids'), false);
  }
});

test('running, failed, missing and inconsistent GIS source runs cannot certify a complete capture', async () => {
  for (const edit of [db => { db.data.sync[0].status = 'running'; }, db => { db.data.sync[0].status = 'failed'; },
    db => { db.data.runs[0].status = 'running'; }, db => { db.data.runs = []; }, db => { db.data.sync = []; },
    db => { db.data.parcels[0].sync_run_id = null; }]) {
    const db = fake(); edit(db);
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.ok(result.incomplete_reasons.some(reason => reason.startsWith('parcels:')));
  }
});

test('older completed incremental origin runs remain valid capture provenance without pretending one county vintage', async () => {
  const older = '60000000-0000-4000-8000-000000000002';
  const db = fake(); db.data.parcels[0].sync_run_id = older;
  db.data.runs.push({ id: older, source_key: 'dcad_parcels', mode: 'incremental', status: 'complete',
    started_at: '2026-08-31T23:00:00.000Z', completed_at: '2026-09-01T00:00:00.000Z' });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'captured');
  assert.equal(records(result, 'gis_sync').filter(row => row.record_id.startsWith('run:')).length, 2);
  assert.ok(result.unsupported_capabilities.includes('provider_coverage'));
});

test('contradictory, missing and malformed source completion evidence never certifies a capture', async () => {
  for (const change of [
    data => { data.runs[0].completed_at = '2027-01-01T00:00:00.000Z'; },
    data => { data.runs[0].started_at = '2026-09-05T12:00:00.000001Z'; },
    data => { data.runs[0].started_at = null; },
    data => { data.runs[0].completed_at = '2026-02-31T12:00:00.000Z'; },
    data => { data.runs[0].completed_at = '2026-09-05 12:00:00.000001+00'; },
    data => { data.sync[0].last_success_at = null; },
    data => { data.sync[0].last_success_at = '2027-01-01T00:00:00.000Z'; },
    data => { data.sync[0].last_success_at = '2026-09-05T11:59:59.999999Z'; },
    data => { data.sync[0].last_success_at = 'yesterday'; },
    ...['0', '-1', '0.9', '1e3', '01', '9223372036854775808', null, 1].map(value => data => { data.sync[0].row_count = value; }),
  ]) {
    const db = fake(); change(db.data);
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.ok(result.incomplete_reasons.some(reason => /^parcels:(origin_run_not_complete|sync_success_unverifiable|sync_count_contradiction)$/.test(reason)));
    assert.equal(db.releases.length, 1);
  }
});

test('UTC microsecond source times and large exact counts are retained without truncating evidence', async () => {
  const db = fake();
  db.data.scope[0].captured_at_precise = '2026-09-05T12:00:00.000999Z';
  db.data.runs[0].started_at = '2026-09-05 11:59:59.999998+00';
  db.data.runs[0].completed_at = '2026-09-05 12:00:00.000123+00';
  db.data.sync[0].last_success_at = '2026-09-05 12:00:00.000124+00:00';
  db.data.sync[0].row_count = '9007199254740993';
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'captured');
  assert.equal(records(result, 'gis_sync').find(row => row.record_id.startsWith('state:')).data.row_count, '9007199254740993');
  assert.equal(records(result, 'gis_sync').find(row => row.record_id.startsWith('run:')).data.completed_at,
    '2026-09-05 12:00:00.000123+00');
  assert.ok(result.unsupported_capabilities.includes('provider_coverage'));
});

test('missing selected parcels fail completeness rather than silently reducing stock coverage', async () => {
  const db = fake();
  const result = await db.reader.capture(request({ account_ids: [SUBJECT, 'MISSING'] }));
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.ok(result.incomplete_reasons.includes('parcels:selected_accounts_not_covered'));
});

test('scope rejection and conflicting effective dates happen before any source data is queried', async () => {
  for (const scope of [[], [{ effective_date: '2023-06-30', captured_at: NOW }],
    [{ effective_date: '2024-06-30', case_date: '2023-06-30', snapshot_date: '2024-06-30', captured_at: NOW }]]) {
    const db = fake({ data: { scope } });
    await assert.rejects(db.reader.capture(request()), /invalid_neighborhood_cache_reader:(scope_mismatch|effective_date_conflict)/);
    assert.equal(db.calls.some(row => row.tag === 'capabilities'), false);
    assert.equal(db.calls.at(-1).tag, 'rollback'); assert.equal(db.releases.length, 1);
  }
});

test('invalid Gregorian capture time returns a controlled incomplete state', async () => {
  const db = fake(); db.data.scope[0].captured_at = '2026-02-31T12:00:00.000Z';
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.ok(result.incomplete_reasons.includes('capture_time_unavailable'));
});

test('historical knowledge cutoff is unsupported instead of replaying latest rows as past knowledge', async () => {
  const db = fake();
  const result = await db.reader.capture(request({ knowledge_cutoff: '2024-06-30T23:59:59.999Z' }));
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.deepEqual(result.incomplete_reasons, ['historical_knowledge_capture_required']);
  assert.equal(db.calls.some(row => row.tag === 'capabilities'), false);
});

test('record and byte limits return no truncated usable source and include selection records in the work budget', async () => {
  for (const limits of [{ records: 4 }, { bytes: 100 }, { row_bytes: 50 }]) {
    const db = fake({ limits });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.ok(result.incomplete_reasons.some(reason => ['record_limit', 'byte_limit', 'row_bytes_limit'].includes(reason)));
    assert.equal(db.calls.at(-1).tag, 'rollback');
  }
});

test('database oversized-row sentinel and duplicate identities are controlled failures', async () => {
  for (const intercept of [({ tag }) => tag === 'parcels' ? { rows: [{ payload: null, row_bytes: 64001 }] } : undefined,
    ({ tag }) => tag === 'parcels' ? { rows: [parcel(), parcel()].map(payload => ({ payload, row_bytes: 100 })) } : undefined]) {
    const db = fake({ intercept });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.match(result.incomplete_reasons[0], /row_bytes_limit|duplicate_source_identity/);
  }
});

test('database failures and statement timeout never leak query/error detail or leave a transaction open', async () => {
  for (const code of ['57014', '42P01', 'private-error']) {
    const db = fake({ intercept({ tag }) { if (tag === 'parcels') throw Object.assign(new Error('PRIVATE TOKEN AND SQL'), { code }); } });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.deepEqual(result.incomplete_reasons, ['source_query_unavailable']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TOKEN|SQL/);
    assert.equal(db.calls.at(-1).tag, 'rollback'); assert.equal(db.releases.length, 1);
  }
});

test('untrusted database errors cannot forge internal reasons or invalid-input exceptions', async () => {
  for (const injected of [
    Object.assign(new Error('PRIVATE DRIVER DETAIL'), { code: 'NEIGHBORHOOD_CACHE_INCOMPLETE', reason: 'PRIVATE REASON' }),
    new TypeError('invalid_neighborhood_cache_reader:PRIVATE TYPEERROR'),
    Object.defineProperty({}, 'reason', { get() { assert.fail('Untrusted reason getter must not be evaluated'); } }),
    null,
  ]) {
    const db = fake({ intercept({ tag }) { if (tag === 'parcels') throw injected; } });
    const result = await db.reader.capture(request());
    assert.deepEqual(result.incomplete_reasons, ['source_query_unavailable']);
    assert.equal(result.source_capture, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TYPEERROR|DRIVER/);
    assert.equal(db.calls.at(-1).tag, 'rollback'); assert.equal(db.releases.length, 1);
  }
});

test('release is attempted once and sanitized without replacing an existing safe failure', async () => {
  const release = () => { throw new Error('PRIVATE RELEASE DETAIL'); };
  const successful = fake({ release });
  const unavailable = await successful.reader.capture(request());
  assert.equal(unavailable.status, 'incomplete'); assert.equal(unavailable.source_capture, null);
  assert.deepEqual(unavailable.incomplete_reasons, ['connection_release_failed']);
  assert.equal(successful.calls.at(-1).tag, 'commit'); assert.equal(successful.releases.length, 1);
  for (const options of [
    { intercept({ tag }) { if (tag === 'parcels') throw new Error('PRIVATE QUERY DETAIL'); } },
    { limits: { row_bytes: 50 } },
    { data: { sync: [] } },
  ]) {
    const db = fake({ ...options, release });
    const result = await db.reader.capture(request());
    assert.ok(result.incomplete_reasons.some(reason => ['source_query_unavailable', 'row_bytes_limit', 'parcels:sync_state_unknown'].includes(reason)));
    assert.ok(!result.incomplete_reasons.includes('connection_release_failed'));
    assert.equal(db.releases.length, 1); assert.equal(result.source_capture, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|DETAIL/);
  }
  const invalid = fake({ release, data: { scope: [] } });
  await assert.rejects(invalid.reader.capture(request()), /^TypeError: invalid_neighborhood_cache_reader:scope_mismatch$/);
  assert.equal(invalid.releases.length, 1);
});

test('rollback failure destroys the checked-out connection rather than returning an open transaction to the pool', async () => {
  const db = fake({ intercept({ tag }) { if (tag === 'parcels' || tag === 'rollback') throw new Error('failure'); } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete');
  assert.equal(db.releases.length, 1); assert.ok(db.releases[0] instanceof Error);
});

test('successful but slow BEGIN is rolled back even when the elapsed-time guard rejects its response', async () => {
  const db = fake({ limits: { duration_ms: 10 }, async intercept({ tag }) {
    if (tag === 'begin') { await new Promise(resolve => setTimeout(resolve, 20)); return { rows: [] }; }
  } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.incomplete_reasons, ['duration_limit']);
  assert.equal(db.calls.at(-1).tag, 'rollback');
  assert.equal(db.releases.length, 1);
});

test('an uncertain BEGIN response cannot return a potentially open transaction to the pool', async () => {
  const db = fake({ intercept({ tag }) {
    if (tag === 'begin') throw Object.assign(new Error('query response timed out'), { code: '57014' });
  } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete');
  assert.equal(db.calls.at(-1).tag, 'rollback');
  assert.equal(db.releases.length, 1);
});

test('elapsed read budget stops a delayed source query without preserving a partial capture', async () => {
  const db = fake({ limits: { duration_ms: 10 }, async intercept({ tag }) {
    if (tag === 'parcels') { await new Promise(resolve => setTimeout(resolve, 20)); return { rows: [] }; }
  } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.deepEqual(result.incomplete_reasons, ['duration_limit']);
  assert.equal(db.calls.at(-1).tag, 'rollback');
});

test('pagination preserves all selected properties and source records, including exact bigint IDs beyond safe Number range', async () => {
  const bigId = '9007199254740993';
  const db = fake({ limits: { page_size: 2 }, data: {
    parcels: [parcel('1'), parcel('2', 'P2'), parcel(bigId, 'P3')],
    accounts: [{ account_id: SUBJECT }, { account_id: 'P2' }, { account_id: 'P3' }],
    transactions: [transaction('9'), transaction('10'), transaction(bigId, { sale_id: '9223372036854775807' })],
    legacy: [{ sale_id: bigId, sale_account_id: SUBJECT, source_record_id: null }],
  } });
  const result = await db.reader.capture(request({ account_ids: ['P3', SUBJECT, 'P2'] }));
  assert.equal(result.status, 'captured');
  assert.equal(records(result, 'parcels').length, 3);
  assert.equal(records(result, 'accounts').length, 3);
  assert.equal(records(result, 'transactions').length, 4);
  assert.equal(records(result, 'transactions').find(row => row.record_id === `source:${bigId}`).data.data.canonical_transaction_id,
    '9223372036854775807');
  assert.equal(db.calls.filter(row => row.tag === 'parcels').length, 2);
  assert.equal(db.calls.filter(row => row.tag === 'accounts').length, 2);
  assert.equal(db.calls.filter(row => row.tag === 'source-ids').length, 2);
  assert.ok(db.calls.filter(row => row.tag === 'parcels').every(row => /FROM encoded ORDER BY/.test(row.text)),
    'The outer row-size wrapper must preserve keyset order, not just its inner CTE');
});

test('keyset SQL orders numeric table columns before LIMIT, never their text-projected aliases', async () => {
  const db = fake({ data: { transactions: [transaction()], links: [link()] } });
  await db.reader.capture(request());
  const parcelSql = db.calls.find(row => row.tag === 'parcels').text;
  assert.match(parcelSql, /FROM gis\.dcad_parcels parcel\b/);
  assert.match(parcelSql, /parcel\.object_id>\$2::bigint\s+ORDER BY parcel\.object_id LIMIT \$3/);
  assert.doesNotMatch(parcelSql, /ORDER BY object_id LIMIT/);
  const linkSql = db.calls.find(row => row.tag === 'sale-links').text;
  assert.match(linkSql, /FROM core\.sale_parcels sp\b/);
  assert.match(linkSql, /ORDER BY sp\.source_record_id,sp\.source_position,sp\.parcel_sequence LIMIT \$5/);
  assert.doesNotMatch(linkSql, /ORDER BY source_record_id,/);
  assert.match(parcelSql, /FROM encoded ORDER BY \(payload->>'object_id'\)::bigint/);
  assert.match(linkSql, /FROM encoded ORDER BY \(payload->>'source_record_id'\)::bigint/);
});

test('detail and sync-run SQL have row-count sentinels independent of assumed schema uniqueness', async () => {
  const db = fake({ data: { transactions: [transaction(), transaction('11')] } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'captured');
  for (const tag of ['transactions', 'sync-runs']) {
    const call = db.calls.find(row => row.tag === tag);
    assert.equal(call.values[1], call.values[0].length + 1);
    assert.match(call.text, /LIMIT \$2\)/);
  }
  assert.match(db.calls.find(row => row.tag === 'scope').text, /LIMIT 2\s*$/);
  assert.match(db.calls.find(row => row.tag === 'sync-state').text, /LIMIT 2\)/);
});

test('duplicate transaction join fan-out or sync-run identities fail closed at the bounded sentinel', async () => {
  for (const kind of ['transactions', 'runs']) {
    const db = fake({ data: { transactions: [transaction()] } });
    if (kind === 'transactions') db.data.transactions.push(transaction('10', { sale_id: '999' }));
    else db.data.runs.push({ ...db.data.runs[0] });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.deepEqual(result.incomplete_reasons, ['duplicate_source_identity']);
    assert.equal(db.calls.at(-1).tag, 'rollback');
    const call = db.calls.find(row => row.tag === (kind === 'transactions' ? 'transaction-identities' : 'sync-runs'));
    assert.equal(call.values[1], 2, 'Only one expected row plus its overflow sentinel is fetched');
  }
});

test('the reader does not impose a 30-sale analytical cap', async () => {
  const db = fake({ data: { transactions: Array.from({ length: 41 }, (_, i) => transaction(String(10 + i))) } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'captured');
  assert.equal(records(result, 'transactions').length, 41);
});

test('a discovered source ID missing from its detail query is incomplete, not a dropped sale', async () => {
  const db = fake({ data: { transactions: [transaction()] }, intercept({ tag }) {
    if (tag === 'transactions') return { rows: [] };
  } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.deepEqual(result.incomplete_reasons, ['source_identity_missing']);
});

test('out-of-range bigint source identifiers fail safely without rounding or inventing identities', async () => {
  for (const source_record_id of ['9223372036854775808', '1e3', '0010', null]) {
    const db = fake({ intercept({ tag }) {
      if (tag === 'source-ids') return { rows: [{ payload: { source_record_id }, row_bytes: 50 }] };
    } });
    const result = await db.reader.capture(request());
    assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
    assert.deepEqual(result.incomplete_reasons, ['invalid_source_identity']);
  }
});

test('bounded connect times out and releases a late connection without issuing source queries', async () => {
  let resolveConnect;
  const db = fake({ limits: { connect_ms: 5 }, connect: client => new Promise(resolve => { resolveConnect = () => resolve(client); }) });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete'); assert.deepEqual(result.incomplete_reasons, ['connection_timeout']);
  resolveConnect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.calls.length, 0); assert.equal(db.releases.length, 1);
});

test('late acquisition release failures cannot leak or cause a second disposal attempt', async () => {
  let resolveConnect;
  const db = fake({ limits: { connect_ms: 5 },
    connect: client => new Promise(resolve => { resolveConnect = () => resolve(client); }),
    release() { throw new Error('PRIVATE LATE RELEASE'); } });
  const result = await db.reader.capture(request());
  assert.deepEqual(result.incomplete_reasons, ['connection_timeout']);
  resolveConnect(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.calls.length, 0); assert.equal(db.releases.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|RELEASE/);
});

test('SQL-shaped account identifiers remain bound values and cannot change query text', async () => {
  const hostile = "acct');DROP TABLE core.sales;--";
  const setup = accountId => fake({ data: {
    parcels: [parcel('1', accountId)],
    accounts: [{ account_id: accountId, subdivision: 'Synthetic Plat' }],
  } });
  const capture = async accountId => {
    const db = setup(accountId);
    const input = request({ scope: { ...ASSESSMENT_SCOPE, account_id: accountId }, account_ids: [accountId] });
    const result = await db.reader.capture(input);
    assert.equal(result.status, 'captured');
    assert.equal(result.query_complete, true);
    return db;
  };
  const hostileDb = await capture(hostile);
  const benignDb = await capture('BENIGN-ACCOUNT');
  const hostileCalls = hostileDb.calls.filter(call => call.values.flat(Infinity).includes(hostile));
  assert.ok(hostileCalls.some(call => call.tag === 'scope'));
  assert.ok(hostileCalls.some(call => call.tag === 'parcels'));
  assert.ok(hostileCalls.some(call => call.tag === 'accounts'));
  assert.ok(hostileCalls.some(call => call.tag === 'source-ids'));
  assert.ok(hostileDb.calls.every(call => !call.text.includes(hostile)));
  assert.deepEqual(hostileDb.calls.map(call => [call.tag, call.text]),
    benignDb.calls.map(call => [call.tag, call.text]));
  assert.equal(hostileDb.poolQueries, 0);
  assert.equal(benignDb.poolQueries, 0);
});

test('invalid requests and increased resource ceilings are rejected before a connection is obtained', async () => {
  const db = fake();
  for (const input of [request({ account_ids: [] }), request({ account_ids: [SUBJECT, SUBJECT] }),
    request({ account_ids: ['OTHER'] }), request({ effective_date: '2024-02-31' }),
    request({ observation_period: { start_date: '2024-01-01', end_date: '2025-01-01' } }),
    request({ knowledge_cutoff: '2024-02-31T00:00:00.000Z' })]) {
    await assert.rejects(db.reader.capture(input), error => error instanceof TypeError
      || error.code==='NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED');
  }
  assert.equal(db.connects, 0);
  assert.throws(() => fake({ limits: { records: 100001 } }), /invalid_neighborhood_cache_reader:limits/);
});

test('SQL-shaped numeric limit overrides reject before connection or query', () => {
  for (const limits of [
    { row_bytes: '64000);DROP TABLE core.sales;--' },
    { statement_ms: "5000';SELECT pg_sleep(9);--" },
  ]) {
    let connects = 0;
    let poolQueries = 0;
    const granted = createTestCachedReadAccess(request());
    const pool = {
      async connect() { connects += 1; assert.fail('invalid limits must reject before connection'); },
      async query() { poolQueries += 1; assert.fail('invalid limits must reject before pool query'); },
    };
    assert.throws(() => createNeighborhoodCachedSourceReader(pool, { access: granted.access, limits }),
      /^TypeError: invalid_neighborhood_cache_reader:limits$/);
    assert.equal(connects, 0);
    assert.equal(poolQueries, 0);
  }
});

test('parameterized source projections avoid DDL, jobs, provider fallbacks, raw documents and relative dates', async () => {
  const db = fake({ data: { transactions: [transaction()], links: [link()] } });
  await db.reader.capture(request());
  const allSql = db.calls.map(row => row.text).join('\n');
  assert.doesNotMatch(allSql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|CURRENT_DATE|FOR SHARE|FOR UPDATE)\b/i);
  assert.doesNotMatch(allSql, /raw_payload|assignment_documents|neighborhood_assessment_jobs|v_sales_enriched/i);
  assert.match(allSql, /SET LOCAL statement_timeout/);
  assert.match(allSql, /SET LOCAL idle_in_transaction_session_timeout/);
  assert.match(allSql, /octet_length\(payload::text\)/);
  assert.ok(db.calls.every(row => row.query_timeout > 0));
  assert.equal(db.poolQueries, 0);
});

test('original capture retains its exact query preimage and all accounts across evidence pages', async () => {
  const accountIds = [SUBJECT, ...Array.from({ length: 1000 }, (_, i) => `Z${String(i).padStart(5, '0')}`)].sort(compare);
  const db = fake({ data: { parcels: accountIds.map((id, i) => parcel(String(i + 1), id)),
    accounts: accountIds.map(account_id => ({ account_id, subdivision: 'Synthetic Plat' })) } });
  const result = await db.reader.capture(request({ account_ids: [...accountIds].reverse() }));
  assert.equal(result.status, 'captured');
  const checked = prepareCohortLocalQueryEvidenceV1(JSON.stringify(result.query_evidence));
  assert.equal(checked.status, 'syntax_valid');
  assert.equal(checked.authority, 'not_established');
  assert.equal(result.query_evidence.captured_query_selection_sha256, result.selection_sha256);
  const documents = new Map(result.query_evidence.blobs.map(item => [item.ref.content_sha256, JSON.parse(item.canonical_json)]));
  const preimage = documents.get(result.query_evidence.query_preimage.content_sha256);
  const metadata = documents.get(preimage.compact_metadata.content_sha256);
  const directory = documents.get(preimage.ordered_account_roster.manifest.content_sha256);
  const retained = directory.pages.flatMap(page => documents.get(page.page.content_sha256).entries.map(row => row.account_id));
  assert.deepEqual(retained, accountIds);
  assert.deepEqual(directory.pages.map(page => page.entry_count), ['1000', '1']);
  assert.deepEqual(records(result, 'selection').map(row => row.data.account_id), accountIds);
  assert.equal(cohortFixtureQueryHash(metadata, retained), result.selection_sha256);
  assert.equal(Object.hasOwn(metadata, 'selection_sha256'), false);
  assert.equal(Object.hasOwn(metadata, 'selected_account_count'), false);
  for (const source of result.source_capture.sources) {
    const { role, source_gaps, selection_sha256, selected_account_count, ...original } = source.payload.projection.definition;
    assert.deepEqual(original, metadata);
    assert.equal(selection_sha256, result.selection_sha256);
    assert.equal(selected_account_count, 1001);
    assert.deepEqual(source_gaps, []);
    assert.ok(['selection', 'parcels', 'accounts', 'transactions', 'sale_links', 'gis_sync'].includes(role));
  }
  assert.ok(Object.isFrozen(result.query_evidence.blobs));
  assert.equal(db.connects, 1);
  assert.equal(db.calls.at(-1).tag, 'commit');
  assert.equal(db.releases.length, 1);
});

test('incomplete source reads expose neither partial records nor partial query evidence', async () => {
  const db = fake({ data: { parcels: [] } });
  const result = await db.reader.capture(request());
  assert.equal(result.status, 'incomplete');
  assert.equal(result.source_capture, null);
  assert.equal(Object.hasOwn(result, 'query_evidence'), false);
});
