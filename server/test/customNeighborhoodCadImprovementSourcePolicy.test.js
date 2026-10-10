import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { getNeighborhoodFrozenCadImprovementProfile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';
import { createCustomNeighborhoodCadImprovementSourcePolicy as create,
  describeNeighborhoodCadImprovementPurpose as describe, CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as KEY,
  CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_PURPOSE as SCOPE, CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_DATASET as DATASET }
  from '../src/security/customNeighborhoodCadImprovementSourcePolicy.js';
import { createCustomNeighborhoodSourcePolicy as legacy, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY as OLD_KEY }
  from '../src/security/customNeighborhoodSourcePolicy.js';
import { createCustomNeighborhoodWitness2SourcePolicy as witness, CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY as WITNESS_KEY }
  from '../src/security/customNeighborhoodWitness2SourcePolicy.js';
import { describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodCombinedEvidenceMarketDataPurpose }
  from '../src/services/neighborhoodAssessment/cachedReadAccess.js';

const ORG='70000000-0000-4000-8000-000000000001',GEN='71000000-0000-4000-8000-000000000001';
const AUTH={userId:'synthetic-fixture-only'},CONTEXT={scope:{organization_id:ORG},target:{workflow_type:'custom_appraisal'},effective_date:'2026-10-08'};
const NOW='2026-10-08T12:00:00.123456Z',PROFILE={datasetRevision:'fixture-CAD-1',providerRevisions:[{provider_id:'fixture',revision:'terms-1'}]};
const REQUEST={retention:true,exposure:'none'},INPUT={selection_sha256:'a'.repeat(64),generation_id:GEN},PURPOSE=describe(INPUT);
const copy=structuredClone;
/** Create synthetic rights DATA only; this is never an independently approved source grant. */
function config(){return {policy_version:1,organization_id:ORG,grant_id:'fixture-CAD-owner',purpose_version:1,purpose_scope:copy(SCOPE),
  dataset:{id:DATASET,revision:PROFILE.datasetRevision,coverage:'entire_integrated_source_mix_including_prior_merged_values',provider_revisions:copy(PROFILE.providerRevisions)},
  rights_basis:{owner_id:'fixture',basis_reference:'synthetic-only-NOT-a-production-grant',approved_by:'fixture',approved_at:'2026-10-01T00:00:00.000000Z'},
  valid_from:'2026-10-01T00:00:00.000000Z',expires_at:'2026-11-01T00:00:00.000000Z',revoked_at:null,
  retention:'immutable_originals_without_automated_deletion',exposures:{none:true,report_observation_summary:false,report_observation_members:false,report_observation_catalog:false}};}
/** Model the fixed namespace read and mutable fault inputs without a database or source authority. */
function fixture(){const calls=[],metadata={[KEY]:config()},state={organization_id:ORG,active:true,checked_at:NOW};
  const client={async query(sql,params){calls.push({sql,params});return {rows:[{...state,source_rights:metadata[params[1]]??null}]};}};
  const policy=create(copy(PROFILE));return {calls,metadata,state,client,policy,
    check:(purpose=PURPOSE,request=REQUEST)=>policy(client,AUTH,CONTEXT,purpose,request)};}

test('fixed separate purpose binds the exact companion fields/profile and pinned stock, not a grant or historical assertion',()=>{
  const original=getNeighborhoodFrozenCadImprovementProfile();
  assert.deepEqual(PURPOSE,{...SCOPE,...INPUT});assert.deepEqual(SCOPE.source_projection,{...original.profile_ref,fields:JSON.parse(original.definition_blob.canonical_json).fields});
  assert.notEqual(KEY,OLD_KEY);assert.notEqual(KEY,WITNESS_KEY);
  for(const v of [SCOPE,SCOPE.source_classes,SCOPE.source_classification,SCOPE.source_projection,SCOPE.source_projection.fields,
    SCOPE.source_projection.fields.primary,SCOPE.source_projection.fields.secondary,PURPOSE])assert.ok(Object.isFrozen(v));
  assert.match(SCOPE.temporal_basis,/not_retrospective_or_at_sale/);
  for(const extra of [{table:'core.accounts'},{purpose:SCOPE},{namespace:OLD_KEY},{mappingVersion:5}])assert.throws(()=>create({...PROFILE,...extra}),/profile_required/);
  for(const input of [null,{}, {...INPUT,generation_id:'current'}, {...INPUT,selection_sha256:'bad'}, {...INPUT,fields:['pool']}, {...INPUT,effective_date:'2000-01-01'}])assert.throws(()=>describe(input),/purpose_required/);
});
test('one fixed bounded read gives a config-hash decision without metadata writes or provider/core reads',async()=>{
  const f=fixture(),before=copy(f.metadata),d=await f.check();assert.equal(d.allowed,true);assert.ok(Object.isFrozen(d));
  const hash=createHash('sha256').update(canonical(f.metadata[KEY]),'utf8').digest('hex');
  assert.deepEqual(d,{allowed:true,decision_id:`${ORG}:fixture-CAD-owner`,policy_revision:`custom-neighborhood-cad-improvement-source-rights-v1:sha256:${hash}`});
  assert.deepEqual(f.metadata,before);assert.deepEqual(f.calls[0].params,[ORG,KEY,16384]);
  assert.match(f.calls[0].sql,/clock_timestamp\(\)/);assert.match(f.calls[0].sql,/CASE WHEN octet_length/);
  assert.doesNotMatch(f.calls[0].sql,/\b(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT|DELETE|core\.|now\(\))\b/i);
  assert.deepEqual(await f.check(describe({...INPUT,selection_sha256:'b'.repeat(64)})),d);
});
test('legacy/witness grants cannot authorize CAD or read its namespace, and CAD cannot authorize those purposes',async()=>{
  const f=fixture(),args={effective_date:CONTEXT.effective_date,selection_sha256:INPUT.selection_sha256,
    observation_period:{start_date:'2026-01-01',end_date:CONTEXT.effective_date},knowledge_cutoff:null};
  for(const old of [describeNeighborhoodCachedMarketDataPurpose(args),describeNeighborhoodCombinedEvidenceMarketDataPurpose(args)])assert.deepEqual(await f.check(old),{allowed:false});
  for(const old of [legacy(PROFILE),witness(PROFILE)])assert.deepEqual(await old(f.client,AUTH,CONTEXT,PURPOSE,REQUEST),{allowed:false});
  assert.equal(f.calls.length,0);delete f.metadata[KEY];f.metadata[OLD_KEY]=config();f.metadata[WITNESS_KEY]=config();
  assert.deepEqual(await f.check(),{allowed:false});assert.equal(f.calls.length,1);assert.equal(f.calls[0].params[1],KEY);
});
test('altered projection, field order, scope, geometry clip, dates and caller authority fail before SQL',async()=>{
  const f=fixture();const changes=[p=>{p.source_projection.fields.primary.pop();},p=>{p.source_projection.fields.secondary.reverse();},
    p=>{p.source_projection.content_sha256='b'.repeat(64);},p=>{p.source_projection.revision='2';},p=>{p.source_projection.fields.primary.push('owner_name');},
    p=>{p.source_classes.reverse();},p=>{p.source_classification['core.primary_improvements']='public';},p=>{p.additional_cadastral_accounts=true;},
    p=>{p.private_assignment_overlays=true;},p=>{p.associated_row_scope='inside_geometry_only';},p=>{p.acquisition_scope='current_core';},
    p=>{p.temporal_basis='historical';},p=>{p.generation_id='bad';},p=>{p.selection_sha256='bad';},p=>{p.knowledge_cutoff=NOW;},p=>{p.authority='granted';}];
  for(const mutate of changes){const p=copy(PURPOSE);mutate(p);assert.deepEqual(await f.check(p),{allowed:false});}assert.equal(f.calls.length,0);
});
for(const [name,mutate] of [
  ['revoked',c=>{c.revoked_at=NOW;}],['expired',c=>{c.expires_at=NOW;}],['future approval',c=>{c.rights_basis.approved_at='2026-10-08T12:00:00.123457Z';}],
  ['invalid date',c=>{c.expires_at='2026-02-30T00:00:00.000000Z';}],['partial mix',c=>{c.dataset.coverage='latest_import_only';}],
  ['provider mismatch',c=>{c.dataset.provider_revisions[0].revision='other';}],['provider omitted',c=>{c.dataset.provider_revisions=[];}],
  ['wrong dataset',c=>{c.dataset.id='integrated_cached_market_dataset';}],['projection mismatch',c=>{c.purpose_scope.source_projection.fields.primary.pop();}],
  ['no basis',c=>{c.rights_basis.basis_reference='';}],['foreign organization',c=>{c.organization_id=GEN;}],['no retention',c=>{c.retention=false;}],
  ['truthy exposure',c=>{c.exposures.none='true';}],['unknown property',c=>{c.waiver=true;}],['unsupported version',c=>{c.policy_version=2;}],
])test(`CAD policy independently denies ${name}`,async()=>{const f=fixture();mutate(f.metadata[KEY]);assert.deepEqual(await f.check(),{allowed:false});assert.equal(f.calls.length,1);});
test('wall time, active organization, config and exposures re-read each call; grant success is not cached',async()=>{
  const f=fixture(),allowed=await f.check();f.state.checked_at='2026-11-01T00:00:00.000000Z';assert.deepEqual(await f.check(),{allowed:false});
  f.state.checked_at=NOW;f.state.active=false;assert.deepEqual(await f.check(),{allowed:false});f.state.active=true;
  f.metadata[KEY].rights_basis.basis_reference+='-revised';assert.notEqual((await f.check()).policy_revision,allowed.policy_revision);
  for(const exposure of ['report_observation_summary','report_observation_members','report_observation_catalog'])assert.deepEqual(await f.check(PURPOSE,{retention:true,exposure}),{allowed:false});
  const request={retention:true,exposure:'report_observation_members'};let finish;
  const pending=f.policy({query:()=>new Promise(resolve=>{finish=resolve;})},AUTH,CONTEXT,PURPOSE,request);request.exposure='none';
  finish({rows:[{...f.state,source_rights:f.metadata[KEY]}]});assert.deepEqual(await pending,{allowed:false});
});
test('bad context/request/profile and result shapes deny; construction copies trusted provider options',async()=>{
  const f=fixture();
  for(const context of [{...CONTEXT,effective_date:'2026-02-30'},{...CONTEXT,scope:{organization_id:'bad'}},{...CONTEXT,target:{workflow_type:'uad_3_6'}}])
    assert.deepEqual(await f.policy(f.client,AUTH,context,PURPOSE,REQUEST),{allowed:false});
  for(const request of [null,{}, {...REQUEST,retention:false},{...REQUEST,exposure:'bulk_export'},{...REQUEST,waiver:true}])assert.deepEqual(await f.check(PURPOSE,request),{allowed:false});
  for(const auth of [{},{userId:''},{userId:'bad\nactor'}])assert.deepEqual(await f.policy(f.client,auth,CONTEXT,PURPOSE,REQUEST),{allowed:false});
  assert.equal(f.calls.length,0);
  for(const options of [null,{}, {...PROFILE,providerRevisions:[]},{...PROFILE,providerRevisions:Array(1)},
    {...PROFILE,providerRevisions:[...PROFILE.providerRevisions,...PROFILE.providerRevisions]}])assert.throws(()=>create(options),/profile_required/);
  for(const rows of [[],[null],Array(1),[{...f.state,source_rights:config(),extra:true}],Array(2).fill({...f.state,source_rights:config()})])
    assert.deepEqual(await f.policy({query:async()=>({rows})},AUTH,CONTEXT,PURPOSE,REQUEST),{allowed:false});
  const options=copy(PROFILE),policy=create(options);options.datasetRevision='changed';options.providerRevisions[0].revision='changed';
  assert.equal((await policy(f.client,AUTH,CONTEXT,PURPOSE,REQUEST)).allowed,true);
});
test('hostile data shapes, accessors and revoked proxies do not execute; oversized metadata and driver errors sanitize',async()=>{
  const f=fixture();let executions=0;const getter={enumerable:true,get(){executions++;throw new Error('must not execute');}};
  for(const target of ['purpose','projection','fields','array']){const p=copy(PURPOSE);const [o,k]=target==='purpose'?[p,'source_projection']:target==='projection'?[p.source_projection,'fields']:
    target==='fields'?[p.source_projection.fields,'primary']:[p.source_projection.fields.primary,'0'];Object.defineProperty(o,k,getter);assert.deepEqual(await f.check(p),{allowed:false});}
  const handler={get(){executions++;throw new Error('trap');},ownKeys(){executions++;throw new Error('trap');}};
  const revoked=Proxy.revocable({},handler);revoked.revoke();
  for(const proxy of [new Proxy({},handler),revoked.proxy]){assert.throws(()=>describe(proxy),/purpose_required/);assert.throws(()=>create(proxy),/profile_required/);
    assert.deepEqual(await f.check(proxy),{allowed:false});f.metadata[KEY]=proxy;assert.deepEqual(await f.check(),{allowed:false});}
  f.metadata[KEY]=config();Object.defineProperty(f.metadata[KEY].rights_basis,'approved_by',getter);assert.deepEqual(await f.check(),{allowed:false});assert.equal(executions,0);
  f.metadata[KEY]=null;assert.deepEqual(await f.check(),{allowed:false});
  const huge=copy(PROFILE);huge.providerRevisions=Array.from({length:32},(_,i)=>({provider_id:String(i).padEnd(200,'x'),revision:'r'.repeat(200)}));
  f.metadata[KEY]=config();f.metadata[KEY].dataset.provider_revisions=copy(huge.providerRevisions);
  Object.assign(f.metadata[KEY].rights_basis,{owner_id:'o'.repeat(200),approved_by:'a'.repeat(200),basis_reference:'b'.repeat(1000)});
  assert.ok(Buffer.byteLength(canonical(f.metadata[KEY]))>16384);assert.deepEqual(await create(huge)(f.client,AUTH,CONTEXT,PURPOSE,REQUEST),{allowed:false});
  await assert.rejects(f.policy({query:async()=>{throw Object.assign(new Error('postgres://secret'),{secret:true});}},AUTH,CONTEXT,PURPOSE,REQUEST),
    e=>e.message==='custom_neighborhood_cad_improvement_source_policy_unavailable'&&e.code==='CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_POLICY_UNAVAILABLE'&&!e.cause&&!e.secret);
});
