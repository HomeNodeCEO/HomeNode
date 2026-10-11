import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCustomCohortSelectedNumericRankCandidatesV2Repository as repository,
  CUSTOM_COHORT_SELECTED_NUMERIC_RANK_CANDIDATES_V2_SQL as SQL}
  from '../src/services/neighborhoodAssessment/customCohortSelectedNumericRankCandidatesV2Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  refs=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'],
  metrics=['reported_year_built','reported_residential_area','reported_site_area'],
  valueKeys=['low','q1_lower','q1_upper','median_lower','median_upper','q3_lower','q3_upper','high'];
function row(metric,observed='2',lower='0',upper='8000'){
  const n=Number(observed);return {metric,selected_count:'2',observed_count:observed,
    ...Object.fromEntries(valueKeys.map(k=>[k,n?k==='low'||k.endsWith('lower')?lower:upper:null])),
    q1_remainder:n?(n-1)%4:0,median_remainder:n?((n-1)*2)%4:0,q3_remainder:n?((n-1)*3)%4:0};
}
const rows=()=>[row(metrics[0],'0'),row(metrics[1],'2','9007199254740993.000000000001','9007199254740993.000000000001'),row(metrics[2])];
function setup({result=rows(),auto=false,endingTx=false}={}){
  const calls=[];let tx=90,txCalls=0;
  const options={client:{async query(text,values){calls.push({text,values});
    if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto||endingTx&&++txCalls===2?++tx:tx)}]};
    assert.equal(text,SQL);return {rowCount:result.length,rows:result};}},
    claim:{operation_id:id(1),claim_token:id(2),attempts:5},scope:{organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'A'},
    actorUserId:id(5),command_id:id(6),...Object.fromEntries(refs.map((k,i)=>[k,ref(i+1)]))};
  return {calls,options,owner:repository(options)};
}

test('native rank candidates return only three fixed rows, exact large decimals, zero and ties; never claim authority or statistics',async()=>{
  const {owner,calls,options}=setup(),result=await owner.read();
  assert.deepEqual(result.metrics,rows());assert.equal(result.metrics[2].low,'0');
  assert.equal(result.metrics[1].median_lower,'9007199254740993.000000000001');
  assert.equal(result.authority,'not_established');assert.equal(result.original_reconciliation,'not_established');
  assert.equal(result.statistics,'not_established');assert.match(result.later_semantic_owner,/reopen_complete_originals/);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.metrics)&&Object.isFrozen(result.metrics[0]));
  assert.equal(calls.length,3);assert.equal(calls[1].values.length,15);assert.equal(calls[1].values[8],options.command_id);
  refs.forEach((k,i)=>assert.deepEqual(JSON.parse(calls[1].values[i+9]),options[k]));
  const empty=metrics.map(m=>({...row(m,'0'),selected_count:'0'}));assert.deepEqual((await setup({result:empty}).owner.read()).metrics,empty);
  const one=metrics.map(m=>row(m,'1','0','0'));assert.deepEqual((await setup({result:one}).owner.read()).metrics,one);
});

test('closed rank storage refuses caller rank/ordinal/roster/count/value/callbacks, wrong arity and hostile options before SQL',async()=>{
  const {owner,calls,options}=setup();
  for(const args of [[1],[{rank:1}],[undefined],[()=>assert.fail('callback')]])await assert.rejects(owner.read(...args),/invalid_input/);
  assert.equal(calls.length,0);
  for(const key of ['rank','ordinal','cursor','metric','counts','done','values','selected_accounts','pages','readOriginal'])
    assert.throws(()=>repository({...options,[key]:true}),/invalid_input/);
  assert.throws(()=>repository({...options,get numeric_reference(){assert.fail('getter');}}),/invalid_input/);
  assert.throws(()=>repository(new Proxy(options,{get(){assert.fail('proxy');}})),/invalid_input/);
  assert.throws(()=>repository({...options,numeric_reference:{...ref(6),canonical_utf8_bytes:'4097'}}),/invalid_reference/);
  for(const patch of [{actorUserId:id(8).replace('700','A00')},{scope:{...options.scope,assignment_file_id:'0'}},
    {scope:{...options.scope,account_id:' A'}},{claim:{...options.claim,attempts:6}}])assert.throws(()=>repository({...options,...patch}));
});

test('candidate parser rejects malformed counts, metric substitution, noncanonical decimals and impossible fixed rank geometry',async()=>{
  for(const patch of [{metric:'caller_metric'},{selected_count:'2000001'},{observed_count:'3'},{observed_count:2},
    {observed_count:'02'},{low:0},{low:'0.0'},{low:'1e3'},{low:'-1'},
    {low:'1.0000000000001'},{low:'9'.repeat(31)},{median_remainder:0},
    {q1_lower:'9000'},{q1_upper:'9000'},{median_lower:'9000'},{median_upper:'9000'},
    {q3_lower:'9000'},{q3_upper:'9000'},{high:null},{extra:true}]){
    const altered=rows();altered[2]={...altered[2],...patch};await assert.rejects(setup({result:altered}).owner.read());
  }
  const wrongTotal=rows();wrongTotal[1].selected_count='1';await assert.rejects(setup({result:wrongTotal}).owner.read(),/corrupt/);
  const nonemptyUnknown=rows();nonemptyUnknown[0].low='0';await assert.rejects(setup({result:nonemptyUnknown}).owner.read(),/corrupt/);
  const single=rows();single[2]=row(metrics[2],'1','0','1');await assert.rejects(setup({result:single}).owner.read(),/corrupt/);
  const getter=rows();Object.defineProperty(getter[2],'low',{enumerable:true,get(){assert.fail('native row getter');}});
  await assert.rejects(setup({result:getter}).owner.read(),/invalid_input/);
  for(const result of [[],rows().slice(0,2),[...rows(),row('extra')],rows().reverse()])await assert.rejects(setup({result}).owner.read());
  await assert.rejects(setup({auto:true}).owner.read(),/caller_transaction_required/);
  await assert.rejects(setup({endingTx:true}).owner.read(),/caller_transaction_required/);
});

test('native candidate SQL binds complete exact15/current consumed claim/real ninth DONE and all native member references without arrays or writes',()=>{
  for(const text of ['neighborhood_selected_numeric_v2_checkpoint_matches','h.receipt_reference=$15::jsonb',
    "numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'","eighth_body.canonical_utf8::jsonb->'after'->>'done'='true'",
    'c.progress_reference=h.receipt_reference','c.consumed_claim_token=job.claim_token','job.claim_token<>c.issued_claim_token',
    'm.metric_row_reference=n.metric_row_reference','m.row_reference=n.contribution_row_reference','i.contribution_row_reference=n.contribution_row_reference',
    "a.ninth->'after'->>'selected_ordinal'","a.eighth->'after_counts'->'reported_site_area'->>'eligible_count'",
    'row_number() OVER(ORDER BY m.reported_site_area,m.ordinal)','m.reported_site_area IS NOT NULL',
    'names.observed_count-1)*2/4','ORDER BY names.metric_order'])assert.ok(SQL.includes(text),text);
  assert.doesNotMatch(SQL,/array_agg|jsonb_agg|OFFSET |percentile_|::float|::real|numeric\s*\(|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bGRANT\b|\bBEGIN\b|\bCOMMIT\b/i);
  assert.equal((SQL.match(/row_number\(\)/g)??[]).length,3);
  const source=readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortSelectedNumericRankCandidatesV2Repository.js',import.meta.url),'utf8');
  assert.ok(source.includes('A later bounded semantic owner MUST reopen COMPLETE originals'));
  assert.doesNotMatch(source,/Number\(r\[(?:k|key)\]\)|parseFloat|Math\.round/);
});

test('authored native rank probes run after real ninth EMPTY on all existing independent graphs and retain explicit non-authority',()=>{
  const s=readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js',import.meta.url),'utf8');
  for(const text of ['rank candidates require actual ninth fresh EMPTY, never a prefix/count/DONE shortcut',
    'rankResult=await rankCandidateRead(rankHead)','rankResult.original_reconciliation',"rankResult.statistics,'not_established'",
    'await numericUnchanged(rankBefore)',"assert.equal(site.median_lower,'0')","assert.equal(site.median_upper,'8000')",
    '[native-selected-numeric-rank-candidates-v2]','semantic_statistics_owner_integrated:false',
    'original_semantic_owner_reopen_AGAIN_required:true','licensed_acquisition:false'])assert.ok(s.includes(text),text);
});
