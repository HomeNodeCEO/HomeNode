import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { CUSTOM_COHORT_OPERATION_LIMITS } from '../src/services/neighborhoodAssessment/customCohortOperationLimits.js';

const input = () => ({ auth: { userId: '80000000-0000-4000-8000-000000000001', organizations: [] },
  accountId: '00026355500170360000', assignmentFileId: '9007199254740993',
  operationId: '70000000-0000-4000-8000-000000000001',
  observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } });
function setup(connect = () => { throw new Error('must not connect'); }) {
  return createCustomCohortContextCapture({ pool: { connect }, authorizeMarketData: () => assert.fail('must not authorize') });
}

test('checked-out connection errors fail safely and release once instead of crashing the process', async () => {
  for (const failureAt of ['BEGIN', 'SET LOCAL', '/* custom-cohort-capture:assignment */']) {
    const client = new EventEmitter(), error = new Error('synthetic connection ended'), calls = [], releases = [];
    client.query = async ({ text }) => {
      calls.push(text);
      if (text.startsWith(failureAt)) client.emit('error', error);
      return { rowCount: 0, rows: [] };
    };
    client.release = reason => releases.push(reason);
    await assert.rejects(setup(async () => client).capture(input()), error);
    assert.deepEqual(releases, [error]); assert.equal(client.listenerCount('error'), 0);
    assert.equal(calls.at(-1).startsWith(failureAt), true);
    assert.ok(!calls.includes('COMMIT'));
  }
});

test('Custom capture requires an explicit server market policy, without default grant', () => {
  assert.throws(() => createCustomCohortContextCapture({ pool: { connect() {} } }), /dependencies_required/);
});

test('new frozen-stock owner requires a detached exact job claim and refuses unsupported inputs before any connection',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup().prepareFrozenCaptureJobStock(base),/invalid_input/);
  await assert.rejects(setup().prepareFrozenCaptureJobStock(base,{captureJobClaim:{...claim,operation_id:'44444444-4444-4444-8444-444444444444'}}),/operation_conflict/);
  await assert.rejects(setup().prepareFrozenCaptureJobStock(input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
  await assert.rejects(setup().prepareFrozenCaptureJobStock({...base,account_ids:['untrusted']},{captureJobClaim:claim}),/invalid_input/);
});

test('indexed original source owner requires explicit combined composition and exact internal claim, never browser membership',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup().prepareFrozenCaptureJobSourcePage(base,{captureJobClaim:claim}),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(service.prepareFrozenCaptureJobSourcePage(base),/invalid_input/);
  await assert.rejects(service.prepareFrozenCaptureJobSourcePage({...base,source_rows:[]},{captureJobClaim:claim}),/invalid_input/);
  await assert.rejects(service.prepareFrozenCaptureJobSourcePage({...base,operationId:'44444444-4444-4444-8444-444444444444'},
    {captureJobClaim:claim}),/operation_conflict/);
  await assert.rejects(service.prepareFrozenCaptureJobSourcePage(input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
});

test('original graph verifier admits no caller root, progress, source rows, permission grant or alternate profile',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup().verifyFrozenCaptureJobSourcePage(base,{captureJobClaim:claim}),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(service.verifyFrozenCaptureJobSourcePage(base),/invalid_input/);
  for(const field of ['root','progress','source_rows','market_decision','source_acquisition'])
    await assert.rejects(service.verifyFrozenCaptureJobSourcePage({...base,[field]:{}},{captureJobClaim:claim}),/invalid_input/);
  await assert.rejects(service.verifyFrozenCaptureJobSourcePage({...base,operationId:claim.claim_token},{captureJobClaim:claim}),/operation_conflict/);
  await assert.rejects(service.verifyFrozenCaptureJobSourcePage(input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
});

for(const method of ['prepareFrozenCaptureJobSourceReferencesV2Page','verifyFrozenCaptureJobSourceReferencesV2Page',
  'verifyFrozenCaptureJobStockOriginalReferencesV2','verifyFrozenCaptureJobSourceIdentityReferencesV2'])
test(`${method} accepts no caller codec, plan, originals, root, progress or authority`,async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup()[method](base,{captureJobClaim:claim}),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(service[method](base),/invalid_input/);
  for(const field of ['stage','sourceRepresentation','generation_id','root','progress','source_rows','market_decision','source_acquisition'])
    await assert.rejects(service[method]({...base,[field]:{}},{captureJobClaim:claim}),/invalid_input/);
  for(const field of ['stage','sourceRepresentation','readOriginal','plan','root','progress','row_limit','stockMetricPage','issued_receipt','issued_reference'])
    await assert.rejects(service[method](base,{captureJobClaim:claim,[field]:()=>assert.fail('untrusted callback')}),/invalid_options/);
  for(const options of [new Proxy({captureJobClaim:claim},{getPrototypeOf(){assert.fail('proxy executed');}}),
    {get captureJobClaim(){assert.fail('getter executed');}},
    {captureJobClaim:claim,[Symbol('readOriginal')]:()=>assert.fail('symbol callback')},
    Object.defineProperty({captureJobClaim:claim},'readOriginal',{value:()=>assert.fail('hidden callback')})])
    await assert.rejects(service[method](base,options),/invalid_options/);
  await assert.rejects(service[method]({...base,operationId:claim.claim_token},{captureJobClaim:claim}),/operation_conflict/);
  await assert.rejects(service[method](input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(service[method](base,{captureJobClaim:claim,signal:aborted.signal}),/cancelled/);
});

test('geographic original owner accepts no caller continuation, geometry roster, grant or acquisition receipt',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup().verifyFrozenCaptureJobStockOriginals(base,{captureJobClaim:claim}),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(service.verifyFrozenCaptureJobStockOriginals(base),/invalid_input/);
  for(const field of ['root','progress','geometries','source_rows','market_decision','source_acquisition'])
    await assert.rejects(service.verifyFrozenCaptureJobStockOriginals({...base,[field]:{}},{captureJobClaim:claim}),/invalid_input/);
  await assert.rejects(service.verifyFrozenCaptureJobStockOriginals({...base,operationId:claim.claim_token},{captureJobClaim:claim}),/operation_conflict/);
  await assert.rejects(service.verifyFrozenCaptureJobStockOriginals(input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
});

test('source identity owner admits no caller graph, numerical observations, continuation or permission grant',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  await assert.rejects(setup().verifyFrozenCaptureJobSourceIdentityClosure(base,{captureJobClaim:claim}),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(service.verifyFrozenCaptureJobSourceIdentityClosure(base),/invalid_input/);
  for(const field of ['root','layer_counts','progress','observations','source_rows','market_decision','source_acquisition'])
    await assert.rejects(service.verifyFrozenCaptureJobSourceIdentityClosure({...base,[field]:{}},{captureJobClaim:claim}),/invalid_input/);
  await assert.rejects(service.verifyFrozenCaptureJobSourceIdentityClosure({...base,operationId:claim.claim_token},{captureJobClaim:claim}),/operation_conflict/);
  await assert.rejects(service.verifyFrozenCaptureJobSourceIdentityClosure(input(),{captureJobClaim:claim}),/frozen_discovery_unsupported/);
});

test('stock metric owner requires an exact bounded page and cannot accept caller observations or an alternate source profile',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  const opts={captureJobClaim:claim,stockMetricPage:{cursor:'',rowLimit:250}};
  await assert.rejects(setup().readFrozenCaptureJobStockMetrics(base,opts),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  for(const page of [undefined,{cursor:'',rowLimit:251},{cursor:'',rowLimit:1,observations:[]}])
    await assert.rejects(service.readFrozenCaptureJobStockMetrics(base,{...opts,stockMetricPage:page}),/invalid_input|invalid_page/);
  for(const field of ['root','layer_counts','progress','observations','source_rows','market_decision','source_acquisition'])
    await assert.rejects(service.readFrozenCaptureJobStockMetrics({...base,[field]:{}},opts),/invalid_input/);
  await assert.rejects(service.prepareFrozenCaptureJobTypedOriginals(base,opts),/invalid_options/);
});

test('shared metric owner accepts only the current job and bounded page, not a caller cache/reference/profile or source grant',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  const opts={captureJobClaim:claim,stockMetricPage:{cursor:'',rowLimit:250}};
  await assert.rejects(setup().readSharedFrozenCaptureJobStockMetrics(base,opts),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  for(const page of [undefined,{cursor:'',rowLimit:251},{cursor:'',rowLimit:1,observations:[]}])
    await assert.rejects(service.readSharedFrozenCaptureJobStockMetrics(base,{...opts,stockMetricPage:page}),/invalid_input|invalid_page/);
  for(const field of ['generation_id','profile','effective_date','shared_typed_generation_reference','root','observations','market_decision','source_acquisition'])
    await assert.rejects(service.readSharedFrozenCaptureJobStockMetrics({...base,[field]:{}},opts),/invalid_input/);
  await assert.rejects(service.readSharedFrozenCaptureJobStockMetrics({...base,operationId:claim.claim_token},opts),/operation_conflict/);
});

test('frozen-stock owner ignores stale roles and reloads the current DB actor before assignment, draft or retained source reads',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const organization='11111111-1111-4111-8111-111111111111';
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  for(const currentRoles of [null,['read_only']]){
    const calls=[];const service=setup(async()=>({release(){},async query({text}){
      calls.push(text);
      if(text.includes('job-organization'))return {rowCount:1,rows:[{organization_id:organization}]};
      if(text.includes('current-actor'))return currentRoles===null?{rowCount:0,rows:[]}:{rowCount:1,rows:[{user_id:base.auth.userId,organization_id:organization,roles:currentRoles}]};
      if(text.includes('custom-cohort-capture:assignment'))return {rowCount:1,rows:[{assignment_file_id:base.assignmentFileId,account_id:base.accountId,organization_id:organization,
        assigned_appraiser_user_id:base.auth.userId,supervisory_appraiser_user_id:null}]};
      return {rowCount:0,rows:[]};}}));
    await assert.rejects(service.prepareFrozenCaptureJobStock({...base,auth:{...base.auth,organizations:[{organizationId:organization,roles:['appraiser']}]}},{captureJobClaim:claim}),
      currentRoles===null?/job_actor_access_revoked/:/assignment_access_denied/);
    assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.includes('COMMIT'));
    assert.ok(!calls.some(sql=>/private-workfile|frozen-job-stock|neighborhood-cohort-blob|checkpoint-read|generation-pin/.test(sql)));
    if(currentRoles!==null)assert.ok(calls.findIndex(sql=>sql.includes('current-actor'))<calls.findIndex(sql=>sql.includes('custom-cohort-capture:assignment')));
  }
});

test('V2 shared stock owner is explicit, admits only claim/page/budget, and never accepts a caller date or issued head',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  const opts={captureJobClaim:claim,stockMetricPage:{cursor:'',rowLimit:250}},method='readSharedFrozenCaptureJobStockMetricsReferencesV2';
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:()=>assert.fail('must not authorize')});
  for(const page of [undefined,{cursor:'',rowLimit:251},{cursor:'',rowLimit:1,observations:[]},
    new Proxy({cursor:'',rowLimit:1},{}),{get cursor(){assert.fail('getter');},rowLimit:1}])
    await assert.rejects(service[method](base,{...opts,stockMetricPage:page}),/invalid_input|invalid_page/);
  for(const field of ['generationId','effectiveDate','profile','identity_reference','progress','permissions','sourceRepresentation'])
    await assert.rejects(service[method](base,{...opts,[field]:{}}),/invalid_options/);
  for(const field of ['effective_date','observations','source_acquisition','root','identity_verification_reference'])
    await assert.rejects(service[method]({...base,[field]:{}},opts),/invalid_input/);
  await assert.rejects(service[method](base,new Proxy(opts,{})),/invalid_options/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get stockMetricPage(){assert.fail('getter');}}),/invalid_options/);
  await assert.rejects(service[method]({...base,operationId:claim.claim_token},opts),/operation_conflict/);
});
test('V2 CAD owner has no default extra-field grant and admits only an exact bounded syntax page/current job',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
  const claim={operation_id:base.operationId,claim_token:'33333333-3333-4333-8333-333333333333',attempts:1};
  const opts={captureJobClaim:claim,cadImprovementPage:{kind:'primary',cursor:{account_id:'',row_key:''},rowLimit:250}};
  const method='readSharedFrozenCaptureJobCadImprovementsReferencesV2';
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  const dependencies={pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData:()=>assert.fail('must not authorize')};
  await assert.rejects(createCustomCohortContextCapture(dependencies)[method](base,opts),/CAD_source_policy_required/);
  assert.throws(()=>createCustomCohortContextCapture({...dependencies,authorizeCadImprovementData:{allowed:true}}),/dependencies_required/);
  const service=createCustomCohortContextCapture({...dependencies,authorizeCadImprovementData:()=>assert.fail('must not authorize')});
  for(const page of [undefined,{...opts.cadImprovementPage,rowLimit:251},{...opts.cadImprovementPage,kind:'parcels'},
    new Proxy(opts.cadImprovementPage,{}),{...opts.cadImprovementPage,get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,cadImprovementPage:page}),/invalid_data|invalid_page/);
  for(const key of ['stockMetricPage','generation_id','root','sourceRepresentation','profile','purpose','market_decision','exposure','progress','effectiveDate'])
    await assert.rejects(service[method](base,{...opts,[key]:{}}),/invalid_options/);
  for(const key of ['root','source_acquisition','CAD_source_authorization','effective_date','account_ids'])
    await assert.rejects(service[method]({...base,[key]:{}},opts),/invalid_input/);
  await assert.rejects(service[method](base,new Proxy(opts,{})),/invalid_options/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get cadImprovementPage(){assert.fail('getter');}}),/invalid_options/);
  await assert.rejects(service[method]({...base,operationId:claim.claim_token},opts),/operation_conflict/);
  await assert.rejects(service[method](input(),opts),/frozen_discovery_unsupported/);
});

test('CAD account owner obtains its date from retained context and accepts no caller facts, cache, date or grant',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  const opts={captureJobClaim:claim,cadAccountPage:{cursor:'',rowLimit:250}},method='readSharedFrozenCaptureJobCadAccountsReferencesV2';
  let connections=0;const dependencies={pool:{async connect(){connections++;throw Error('unreachable');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:async()=>({allowed:false})};
  await assert.rejects(createCustomCohortContextCapture(dependencies)[method](base,opts),/CAD_source_policy_required/);
  const service=createCustomCohortContextCapture({...dependencies,authorizeCadImprovementData:async()=>({allowed:false})});
  for(const key of ['effectiveDate','effective_date','typed','generationId','issuedHead','sourceGrant','cadImprovementPage','stockMetricPage'])
    await assert.rejects(service[method](base,{...opts,[key]:{}}),/invalid_options/);
  for(const page of [undefined,{...opts.cadAccountPage,rowLimit:251},{...opts.cadAccountPage,kind:'primary'},
    new Proxy(opts.cadAccountPage,{}),{...opts.cadAccountPage,get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,cadAccountPage:page}),/invalid_data|invalid_page/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get cadAccountPage(){assert.fail('getter');}}),/invalid_options/);
  assert.equal(connections,0);
});

test('original CAD account package owner admits only a cursor and separate current CAD policy before any connection',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  const opts={captureJobClaim:claim,cadAccountPackagePage:{cursor:''}},method='readOriginalFrozenCaptureJobCadAccountPackagesReferencesV2';
  let connections=0;const dependencies={pool:{async connect(){connections++;throw Error('unreachable');}},
    sourceMode:'combined-witness2-v1',authorizeMarketData:async()=>({allowed:false})};
  await assert.rejects(createCustomCohortContextCapture(dependencies)[method](base,opts),/CAD_source_policy_required/);
  const service=createCustomCohortContextCapture({...dependencies,authorizeCadImprovementData:async()=>({allowed:false})});
  for(const key of ['effectiveDate','rows','originalReader','counts','sourceGrant','cadAccountPage','cadImprovementPage','stockMetricPage','issuedHead'])
    await assert.rejects(service[method](base,{...opts,[key]:{}}),/invalid_options/);
  for(const page of [undefined,{...opts.cadAccountPackagePage,rowLimit:250},{...opts.cadAccountPackagePage,kind:'primary'},
    new Proxy(opts.cadAccountPackagePage,{}),{...opts.cadAccountPackagePage,get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,cadAccountPackagePage:page}),/invalid_/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get cadAccountPackagePage(){assert.fail('getter');}}),/invalid_options/);
  assert.equal(connections,0);
});

for(const method of ['readSharedFrozenCaptureJobTransactionsReferencesV2','readSharedFrozenCaptureJobTransactionTemporalReferencesV2'])
test(`${method} accepts no caller period, profile, source facts, selection or issued head`,async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  const opts={captureJobClaim:claim,transactionPage:{kind:'source_records',cursor:'',rowLimit:250}};
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  for(const key of ['effective_date','observationPeriod','profile','sourceGrant','rows','selectedAccounts','issuedHead','cadAccountPage','stockMetricPage'])
    await assert.rejects(service[method](base,{...opts,[key]:{}}),/invalid_options/);
  for(const page of [undefined,{...opts.transactionPage,kind:'parcels'},{...opts.transactionPage,rowLimit:251},new Proxy(opts.transactionPage,{}),
    {...opts.transactionPage,get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,transactionPage:page}),/invalid_input|invalid_page/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get transactionPage(){assert.fail('getter');}}),/invalid_options/);
});

test('native transaction package owner admits only the closed cursor, never caller completeness, dates or source facts', async () => {
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  for(const method of ['readSharedFrozenCaptureJobTransactionPackagesReferencesV2','readOriginalFrozenCaptureJobTransactionPackagesReferencesV2']){
  const opts={captureJobClaim:claim,
    transactionPackagePage:{kind:'source_record',cursor:''}};
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  for(const key of ['effective_date','observationPeriod','profile','sourceGrant','rows','selectedAccounts','issuedHead','complete','transactionPage'])
    await assert.rejects(service[method](base,{...opts,[key]:{}}),/invalid_options/);
  for(const page of [undefined,{kind:'source_record',cursor:'',rowLimit:1},{kind:'source_records',cursor:''},new Proxy(opts.transactionPackagePage,{}),
    {kind:'source_record',get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,transactionPackagePage:page}),/invalid_/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get transactionPackagePage(){assert.fail('getter');}}),/invalid_options/);
  }
});

test('stock original cells owner accepts no caller originals, dates, selection, counts, callbacks or issued head',async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  const method='readSharedFrozenCaptureJobStockOriginalCellsReferencesV2',opts={captureJobClaim:claim,
    stockOriginalCellPage:{kind:'parcels',cursor:'',rowLimit:250}};
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  for(const key of ['effective_date','observationPeriod','profile','sourceGrant','originals','count','selectedAccounts','issuedHead','readOriginal','stockMetricPage'])
    await assert.rejects(service[method](base,{...opts,[key]:()=>assert.fail('caller callback')}),/invalid_options/);
  for(const page of [undefined,{kind:'sales',cursor:'',rowLimit:1},{kind:'parcels',cursor:'',rowLimit:251},
    {...opts.stockOriginalCellPage,observations:[]},new Proxy(opts.stockOriginalCellPage,{}),
    {kind:'parcels',get cursor(){assert.fail('getter');},rowLimit:1}])
    await assert.rejects(service[method](base,{...opts,stockOriginalCellPage:page}),/invalid_/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get stockOriginalCellPage(){assert.fail('getter');}}),/invalid_options/);
  await assert.rejects(service[method]({...base,operationId:claim.claim_token},opts),/operation_conflict/);
});

for(const method of ['readSharedFrozenCaptureJobStockAccountPackagesReferencesV2','readOriginalFrozenCaptureJobAccountHousingReferencesV2'])
test(`${method} admits only a cursor, never caller account/value/date/count/housing authority`,async()=>{
  const base={...input(),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}},
    claim={operation_id:base.operationId,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
  const opts={captureJobClaim:claim,stockAccountPackagePage:{cursor:''}};
  const service=createCustomCohortContextCapture({pool:{connect(){assert.fail('must not connect');}},sourceMode:'combined-witness2-v1',
    authorizeMarketData:()=>assert.fail('must not authorize')});
  await assert.rejects(setup()[method](base,opts),/frozen_source_profile_unsupported/);
  for(const key of ['effective_date','profile','housingProfile','housingInterpretation','county','category','sourceGrant','originals','count','selectedAccounts','issuedHead','readOriginal','stockOriginalCellPage'])
    await assert.rejects(service[method](base,{...opts,[key]:()=>assert.fail('caller callback')}),/invalid_options/);
  for(const page of [undefined,{cursor:' A'},{cursor:'',account_id:'A'},{cursor:'',rowLimit:1},new Proxy({cursor:''},{}),
    {get cursor(){assert.fail('getter');}}])
    await assert.rejects(service[method](base,{...opts,stockAccountPackagePage:page}),/invalid_/);
  await assert.rejects(service[method](base,{captureJobClaim:claim,get stockAccountPackagePage(){assert.fail('getter');}}),/invalid_options/);
  await assert.rejects(service[method]({...base,operationId:claim.claim_token},opts),/operation_conflict/);
});

test('recorded-group selection refreshes current roles before retained facts or head reads/writes', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const read = { auth: { ...base.auth, organizations: [{ organizationId: organization, roles: ['appraiser'] }] },
    accountId: base.accountId, assignmentFileId: base.assignmentFileId,
    contextRef: { context_id: base.operationId, context_revision: '1', context_sha256: 'c'.repeat(64) } };
  const checkpoint = { workspace_version: 7, active: null, pending_capture: null };
  const pendingCapture = { operation_id: base.operationId, observation_period: base.observationPeriod };
  for (const method of ['readRecordedGroupSelection', 'selectRecordedGroups', 'selectAndSaveRecordedGroups',
    'previewRecordedGroupSelection', 'openRecordedGroupSelectionMap', 'startRecordedGroupCapture', 'cancelRecordedGroupCapture', 'completeRecordedGroupCapture']) {
    const writing = !['readRecordedGroupSelection', 'previewRecordedGroupSelection', 'openRecordedGroupSelectionMap'].includes(method);
    const transition = ['startRecordedGroupCapture', 'cancelRecordedGroupCapture'].includes(method);
    const value = transition ? { auth: read.auth, accountId: read.accountId, assignmentFileId: read.assignmentFileId,
      expectedWorkspaceRevision: 1, expectedWorkspaceCheckpoint: { ...checkpoint,
        pending_capture: method === 'cancelRecordedGroupCapture' ? pendingCapture : null },
      ...(method === 'startRecordedGroupCapture' ? { pendingCapture } : {}) } : writing ? { ...read,
      operationId: report, expectedSelectionRef: null, includedRecordedGroupIds: [],
      ...(['selectAndSaveRecordedGroups', 'completeRecordedGroupCapture'].includes(method) ? { expectedWorkspaceRevision: 1 } : {}),
      ...(method === 'completeRecordedGroupCapture' ? { expectedWorkspaceCheckpoint: { ...checkpoint, pending_capture: pendingCapture } } : {}) }
      : ['previewRecordedGroupSelection', 'openRecordedGroupSelectionMap'].includes(method) ? { ...read, selectionRef: { selection_version: 1,
        selection_revision: 1, selection_sha256: 'a'.repeat(64),
        manifest_ref: { content_sha256: 'b'.repeat(64), canonical_utf8_bytes: '100' } } } : read;
    for (const currentRoles of [null, ...(writing ? [['read_only']] : [])]) {
      const queries = [];
      const service = setup(async () => ({ release() {}, async query({ text }) {
        queries.push(text);
        if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
          assignment_file_id: base.assignmentFileId, account_id: base.accountId, organization_id: organization,
          assigned_appraiser_user_id: base.auth.userId, supervisory_appraiser_user_id: null }] };
        if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
          report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
        if (text.includes('custom-cohort-job:current-actor')) return currentRoles === null ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ user_id: base.auth.userId, organization_id: organization, roles: currentRoles }] };
        return { rowCount: 0, rows: [] };
      } }));
      await assert.rejects(service[method](value), currentRoles === null ? /job_actor_access_revoked/ : /assignment_access_denied/);
      assert.ok(queries.includes('ROLLBACK')); assert.ok(!queries.includes('COMMIT'));
      assert.ok(!queries.some(sql => sql.includes('blob:') || sql.includes('group-selection:') || sql.includes('private-workfile')));
    }
  }
});

test('a worker claim must bind the capture operation and is detached before any database wait', async () => {
  const base = input(), claim = { operation_id: base.operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  await assert.rejects(setup().capture(base, { captureJobClaim: { ...claim,
    operation_id: '44444444-4444-4444-8444-444444444444' } }), /operation_conflict/);
  for (const bad of [{ ...claim, auth: {} }, { ...claim, attempts: 0 },
    { ...claim, claim_token: 'bad' }, {}]) {
    await assert.rejects(setup().capture(base, { captureJobClaim: bad }), /invalid_/);
  }
  const queries = [], organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const original = structuredClone(claim);
  const service = setup(async () => {
    claim.operation_id = report; claim.claim_token = organization; claim.attempts = 5;
    return { release() {}, async query({ text, values }) {
      queries.push(text);
      if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
        assignment_file_id: base.assignmentFileId, account_id: base.accountId,
        organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
        supervisory_appraiser_user_id: null }] };
      if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
        report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
      if (text.includes('custom-cohort-job:current-actor')) return { rowCount: 1, rows: [{
        user_id: base.auth.userId, organization_id: organization, roles: ['appraiser'] }] };
      if (text.includes('checkpoint-read')) {
        assert.deepEqual(values.slice(0, 3), Object.values(original));
        throw new Error('synthetic checkpoint read reached');
      }
      return { rowCount: 0, rows: [] };
    } };
  });
  await assert.rejects(service.capture({ ...base, auth: { ...base.auth,
    organizations: [{ organizationId: organization, roles: ['appraiser'] }] } },
  { captureJobClaim: claim }), /synthetic checkpoint read reached/);
  assert.ok(!queries.some(text => text.includes('subject:transaction') || text.includes('existing-context')));
});

test('worker capture refreshes current roles before subject evidence or replay lookup', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const authorized = { ...base, auth: { ...base.auth, organizations: [{ organizationId: organization,
    roles: ['appraiser'] }] } };
  const captureJobClaim = { operation_id: base.operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  for (const currentRoles of [null, ['read_only']]) {
    const queries = [], releases = [];
    const service = setup(async () => ({ async query({ text, values }) {
      queries.push(text);
      if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
        assignment_file_id: base.assignmentFileId, account_id: base.accountId,
        organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
        supervisory_appraiser_user_id: null }] };
      if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
        report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
      if (text.includes('custom-cohort-job:current-actor')) {
        assert.deepEqual(values, [base.auth.userId, organization]);
        return currentRoles === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{
          user_id: base.auth.userId, organization_id: organization, roles: currentRoles }] };
      }
      return { rowCount: 0, rows: [] };
    }, release(error) { releases.push(error); } }));
    await assert.rejects(service.capture(authorized, { captureJobClaim }),
      currentRoles === null ? /job_actor_access_revoked/ : /assignment_access_denied/);
    assert.ok(queries.some(text => text.includes('custom-cohort-job:current-actor')));
    assert.ok(queries.includes('ROLLBACK'));
    assert.ok(!queries.includes('COMMIT'));
    assert.ok(!queries.some(text => text.includes('existing-context') || text.includes('subject:capture')));
    assert.equal(releases.length, 1);
  }
});

test('job status and cancellation recheck exact current assignment access', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const queries = [];
  let queued;
  const service = setup(async () => ({ async query({ text, values }) {
    queries.push({ text, values });
    if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
      assignment_file_id: base.assignmentFileId, account_id: base.accountId,
      organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
      supervisory_appraiser_user_id: null }] };
    if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
      report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
    if (text.includes('custom-cohort-job:enqueue */')) {
      queued = { actor_user_id: values[5], request_sha256: values[6],
        request_payload: JSON.parse(values[7]) };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('custom-cohort-job:enqueue-readback')) return { rowCount: 1, rows: [{
      operation_id: base.operationId, ...queued, status: 'queued' }] };
    if (text.includes('custom-cohort-job:status')) return { rowCount: 1, rows: [{
      status: 'queued', attempts: 0, cancellation_requested: false, context_sha256: null }] };
    if (text.includes('custom-cohort-job:cancel')) return { rowCount: 1, rows: [{ status: 'cancelled' }] };
    return { rowCount: 0, rows: [] };
  }, release() {} }));
  const authorized = { auth: { ...base.auth, organizations: [{ organizationId: organization,
    roles: ['appraiser'] }] }, accountId: base.accountId,
  assignmentFileId: base.assignmentFileId, operationId: base.operationId };
  assert.equal((await service.queueCaptureJob({ ...authorized,
    observationPeriod: base.observationPeriod })).status, 'queued');
  assert.deepEqual(queued.request_payload, { operation_id: base.operationId,
    observation_period: base.observationPeriod });
  assert.deepEqual(await service.captureJobStatus(authorized), {
    operation_id: base.operationId, status: 'queued', attempts: 0,
    cancellation_requested: false });
  assert.deepEqual(await service.cancelCaptureJob(authorized), { status: 'cancelled' });
  assert.ok(queries.some(query => query.text.includes('custom-cohort-job:status')
    && query.values[1] === organization && query.values[2] === report));
  assert.ok(queries.some(query => query.text.includes('custom-cohort-job:cancel')
    && query.values[1] === organization && query.values[2] === report));
  const before = queries.length;
  await assert.rejects(service.captureJobStatus({ ...authorized, auth: base.auth }), /assignment_access_denied/);
  assert.equal(queries.length, before + 4, 'denied lookup reads no job status or cancellation');
});

test('job status and cancellation reject injected scope before database access', async () => {
  const base = input();
  for (const action of ['captureJobStatus', 'cancelCaptureJob']) {
    await assert.rejects(setup()[action]({ auth: base.auth, accountId: base.accountId,
      assignmentFileId: base.assignmentFileId, operationId: base.operationId,
      organization_id: 'browser-chosen' }), /invalid_input/);
    await assert.rejects(setup()[action]({ auth: base.auth, accountId: base.accountId,
      assignmentFileId: base.assignmentFileId, operationId: 'not-a-uuid' }), /invalid_operation/);
  }
  await assert.rejects(setup().queueCaptureJob({ ...base,
    account_ids: ['untrusted'] }), /invalid_input/);
});

test('driver rejection at aggregate deadline reports interruption and discards once', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const releases = [], calls = [], driverError = new Error('PRIVATE driver timeout');
  const service = setup(async () => ({ async query(config) {
    calls.push(config.text);
    if (config.text.startsWith('SET LOCAL')) { now += CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms; throw driverError; }
    return { rowCount: 0, rows: [] };
  }, release(error) { releases.push(error); } }));
  await assert.rejects(service.capture(input()), error => error.reason === 'deadline_exceeded'
    && error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && !error.message.includes('PRIVATE'));
  assert.deepEqual(releases, [driverError]); assert.ok(!calls.includes('COMMIT'));
});
test('Custom capture rejects browser source/target fields before any connection', async () => {
  for (const key of ['account_ids', 'geometry_input', 'organization_id', 'report_file_id', 'market_decision', 'profile_id']) {
    await assert.rejects(setup().capture({ ...input(), [key]: 'untrusted' }), /invalid_input/);
  }
});
test('Custom capture preserves exact assignment/account identity and rejects numeric rounding', async () => {
  for (const assignmentFileId of [1, 9007199254740992, '01', '-1', '9223372036854775808']) {
    await assert.rejects(setup().capture({ ...input(), assignmentFileId }), /invalid_assignment/);
  }
  for (const accountId of [123, ' trim', '', 'bad\naccount']) {
    await assert.rejects(setup().capture({ ...input(), accountId }), /invalid_account/);
  }
});
test('Custom capture rejects absent authentication, invalid UUIDs and periods before connection', async () => {
  await assert.rejects(setup().capture({ ...input(), auth: {} }), /authentication_required/);
  await assert.rejects(setup().capture({ ...input(), operationId: 'not-a-uuid' }), /invalid_operation/);
  await assert.rejects(setup().capture({ ...input(), observationPeriod: { start_date: '2024-07-01', end_date: '2024-06-30' } }), /invalid_period/);
});

test('private capture selection is exact and reviewed, with no implicit latest or browser payload', async () => {
  const base = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 1 };
  for (const privateSalesImport of [null, {}, { ...base, expected_review_revision: 0 },
    { ...base, expected_review_revision: '1' }, { ...base, latest: true }, { ...base, rows: [] }]) {
    await assert.rejects(setup().capture({ ...input(), privateSalesImport }), /invalid_private_sales_import/);
  }
});
test('Custom capture honors pre-abort and expired aggregate deadline before connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().capture(input(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().capture(input(), { deadline: performance.now() }), /deadline_exceeded/);
});

test('capture budget owns option validation after separating the internal worker claim', async () => {
  const captureJobClaim = { operation_id: input().operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  for (const options of [null, [], Object.create({ signal: undefined }),
    { captureJobClaim, extra: true }, { captureJobClaim, signal: {} },
    { captureJobClaim, deadline: NaN }]) {
    await assert.rejects(setup().capture(input(), options), /invalid_options/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().capture(input(), { captureJobClaim, signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().capture(input(), { captureJobClaim, deadline: performance.now() }), /deadline_exceeded/);
});

test('large capture has a bounded extended aggregate but respects earlier caller deadlines', async t => {
  let clock = 10_000;
  t.mock.method(performance, 'now', () => clock);
  for (const scenario of [
    { elapsed: 70_000, reason: 'target_unavailable' },
    { elapsed: CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms + 1, reason: 'deadline_exceeded' },
    { elapsed: 70_000, deadline: 70_000, reason: 'deadline_exceeded' },
    { elapsed: CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms + 1, deadline: 250_000, reason: 'deadline_exceeded' },
  ]) {
    clock = 10_000; const calls = [], releases = [];
    const capture = setup(async () => ({ async query(config) {
      calls.push(config);
      if (config.text.startsWith('BEGIN')) clock += scenario.elapsed;
      return { rows: [], rowCount: 0 };
    }, release(error) { releases.push(error); } }));
    await assert.rejects(capture.capture(input(), scenario.deadline ? { deadline: scenario.deadline } : {}),
      new RegExp(scenario.reason));
    assert.equal(releases.length, 1); assert.ok(!calls.some(call => call.text === 'COMMIT'));
    assert.ok(calls.every(call => call.query_timeout > 0 && call.query_timeout <= 6000));
  }
});

test('Custom capture admits only exact installed discovery choices before connection', async () => {
  const discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' };
  for (const value of [null, {}, { ...discovery, radius_metres: 8046.72 }, { ...discovery, radius_metres: '8046.720' },
    { ...discovery, radius_metres: '160934.4' }, { ...discovery, profile_id: 'city' },
    { ...discovery, account_ids: [] }, { ...discovery, geometry: {} }]) {
    await assert.rejects(setup().capture({ ...input(), discovery: value }), /invalid_discovery/);
  }
  for (const radius_metres of ['1609.344', '3218.688', '4828.032', '8046.72', '16093.44']) {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(setup().capture({ ...input(), discovery: { ...discovery, radius_metres } }, { signal: controller.signal }), /cancelled/);
  }
});
test('Custom capture releases a late checked-out client exactly once without starting a transaction', async () => {
  let finish, releases = 0, queries = 0;
  const capture = setup(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = capture.capture(input(), { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  finish({ release(error) { assert.ok(error); releases++; }, query() { queries++; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(releases, 1); assert.equal(queries, 0);
});
test('Custom capture rolls back a missing target and never begins source reads', async () => {
  const calls = [], releases = [];
  const capture = setup(async () => ({
    async query({ text }) { calls.push(text); return { rowCount: 0, rows: [] }; },
    release(error) { releases.push(error); },
  }));
  await assert.rejects(capture.capture(input()), /target_unavailable/);
  assert.ok(calls.some(text => text === 'ROLLBACK'));
  assert.ok(!calls.some(text => text.includes('neighborhood-membership:')));
  assert.deepEqual(releases, [undefined]);
});
test('Custom capture discards uncertain BEGIN and failed rollback connections exactly once', async () => {
  for (const failureAt of ['BEGIN', 'ROLLBACK']) {
    const error = new Error('synthetic driver failure'), calls = [], releases = [];
    const capture = setup(async () => ({
      async query({ text }) {
        calls.push(text);
        if (text.startsWith(failureAt)) throw error;
        return { rowCount: 0, rows: [] };
      },
      release(reason) { releases.push(reason); },
    }));
    await assert.rejects(capture.capture(input()));
    assert.deepEqual(releases, [error]);
    if (failureAt === 'BEGIN') assert.equal(calls.length, 1);
  }
});

const previewInput = () => {
  const { auth, accountId, assignmentFileId } = input();
  return { auth, accountId, assignmentFileId,
    contextRef: { context_id: input().operationId, context_revision: '1', context_sha256: 'a'.repeat(64) },
    selection: { revision: 1, pockets: [] } };
};

test('Custom observation preview rejects client authority, malformed context and selection before checkout', async () => {
  for (const key of ['organization_id', 'source_rows', 'subject_freshness', 'retained_inputs']) {
    await assert.rejects(setup().preview({ ...previewInput(), [key]: {} }), /invalid_input/);
  }
  await assert.rejects(setup().preview({ ...previewInput(), contextRef: { context_id: 'unknown' } }));
  for (const revision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(setup().preview({ ...previewInput(), selection: { revision, pockets: [] } }), /invalid_selection/);
  }
  await assert.rejects(setup().preview({ ...previewInput(), selection: { revision: 1, pockets: Array(129).fill({}) } }), /invalid_selection/);
});

test('Custom observation preview rejects missing principal and pre-cancelled work without reading evidence', async () => {
  await assert.rejects(setup().preview({ ...previewInput(), auth: null }), /authentication_required/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().preview(previewInput(), { signal: controller.signal }), /cancelled/);
});

test('Custom catalog uses the same exact principal, context, selection and aggregate budget guards', async () => {
  for (const key of ['account_ids', 'retained_inputs', 'source_grant', 'organization_id', 'catalog']) {
    await assert.rejects(setup().catalog({ ...previewInput(), [key]: {} }), /invalid_input/);
  }
  await assert.rejects(setup().catalog({ ...previewInput(), auth: null }), /authentication_required/);
  await assert.rejects(setup().catalog({ ...previewInput(), assignmentFileId: 1 }), /invalid_assignment/);
  await assert.rejects(setup().catalog({ ...previewInput(), contextRef: {} }));
  await assert.rejects(setup().catalog({ ...previewInput(), selection: { revision: 0, pockets: [] } }), /invalid_selection/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().catalog(previewInput(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().catalog(previewInput(), { deadline: performance.now() }), /deadline_exceeded/);
});

test('Custom catalog rolls back missing target without reading source or writing reports', async () => {
  const calls = [], releases = [];
  const capture = setup(async () => ({
    async query({ text }) { calls.push(text); return { rowCount: 0, rows: [] }; },
    release(error) { releases.push(error); },
  }));
  await assert.rejects(capture.catalog(previewInput()), /target_unavailable/);
  assert.ok(calls.includes('ROLLBACK')); assert.deepEqual(releases, [undefined]);
  assert.ok(!calls.some(sql => /neighborhood-(cache|membership|closure):|\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
});
