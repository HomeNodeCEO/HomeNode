import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createNeighborhoodCachedSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { CACHED_SOURCE_CAPTURE_LIMITS } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';

// This is a query-boundary fake, not a PostgreSQL compatibility test. The catalog
// fixture tracks the reader's literal capabilities while missing-column tests
// independently prove that unavailable sources cannot become complete captures.
const source = readFileSync(new URL('../src/services/neighborhoodAssessment/cachedSourceReader.js', import.meta.url), 'utf8');
const tableDeclaration = source.slice(source.indexOf('const TABLES'), source.indexOf('const SQL'));
const CATALOG = [...tableDeclaration.matchAll(/\['([a-z_]+\.[a-z_]+)', '([^']+)'\]/g)]
  .flatMap(([, relation, columns]) => columns.split(' ').map(column => ({ relation, column })));
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
  const baseline=createTestCachedReadAccess(request(),{transactionClosure:fixtureClosure(data,[SUBJECT])});
  createNeighborhoodCachedSourceReader(pool,{limits:options.limits||{},access:baseline.access});
  return { data, pool, calls, releases, get connects() { return connects; }, get poolQueries() { return poolQueries; },
    reader:{async capture(input) {
      const granted=createTestCachedReadAccess(input,{transactionClosure:fixtureClosure(data,input.account_ids)});
      const prepared=await granted.prepare();
      return createNeighborhoodCachedSourceReader(pool,{limits:options.limits||{},access:granted.access})
        .capture({...prepared.request,auth:granted.auth,selection_grant:prepared.selection_grant,market_grant:prepared.market_grant});
    }} };
}
const records = (result, role) => result.source_capture.sources
  .filter(source => source.payload.projection.definition.role === role).flatMap(source => source.payload.records);
const captureHashes = result => result.source_capture.source_snapshots.map(row => row.content_sha256);

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
