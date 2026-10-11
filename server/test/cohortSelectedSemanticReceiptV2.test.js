import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeCohortSelectedSemanticSummaryV2 as initialize,advanceCohortSelectedSemanticSummaryV2 as advance,
  prepareCohortSelectedSemanticSummaryV2 as prepare,finalizeCohortSelectedSemanticSummaryV2 as finalize,
  prepareCohortSelectedSemanticReceiptV2 as receipt} from '../src/services/neighborhoodAssessment/cohortSelectedSemanticReceiptV2.js';
import {emptyCohortSelectedStatisticsCountsV2 as emptyCounts,advanceCohortSelectedStatisticsCountsV2 as count}
  from '../src/services/neighborhoodAssessment/cohortSelectedStatisticsReceiptV2.js';
import {parseExactDecimalPagedObservationV1 as decimal} from '../src/services/neighborhoodAssessment/exactDecimalPagedDistributionV1.js';

const metrics=['reported_year_built','reported_residential_area','reported_site_area'],ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'}),
  id='70000000-0000-4000-8000-000000000001';
const cell=(value,unit)=>({reported_value_state:value===null?'missing':'observed',complete_observed_parts:value!==null,
  recorded_comparison_eligible:value!==null,contribution_exact_value:value,contribution_unit:value===null?null:unit,
  exclusion_reasons:value===null?['recorded_value_missing','missing_parts']:[],source_part_count:1,
  part_counts:{observed:value===null?0:1,missing:value===null?1:0,invalid:0,unsupported:0}});
const cells=(site,residential=site==='0'?'1':site)=>({reported_year_built:cell('2000','year'),
  reported_residential_area:cell(residential,'reported_sqft'),reported_site_area:cell(site,'reported_sqft'),
  reported_market_value:{reported_value_state:'unsupported',complete_observed_parts:false,recorded_comparison_eligible:false,
    contribution_exact_value:null,contribution_unit:null,exclusion_reasons:['recorded_value_unsupported','unsupported_parts','currency_not_established'],
    source_part_count:1,part_counts:{observed:0,missing:0,invalid:0,unsupported:1}}});
function rank(key,values){
  const sorted=values.filter(v=>v!==null).sort((a,b)=>decimal(a)<decimal(b)?-1:decimal(a)>decimal(b)?1:0),n=sorted.length,
    r={metric:key,selected_count:String(values.length),observed_count:String(n),low:sorted[0]??null,high:sorted.at(-1)??null};
  for(const [q,k] of [['q1',1],['median',2],['q3',3]]){
    const base=n?Math.floor((n-1)*k/4):0,remainder=n?((n-1)*k)%4:0;
    Object.assign(r,{[q+'_lower']:sorted[base]??null,[q+'_upper']:sorted[base+Number(remainder!==0)]??null,[q+'_remainder']:remainder});
  }
  return r;
}
function fixture(values){
  const contributions=values.map(v=>cells(v)),ranks=metrics.map(k=>rank(k,contributions.map(c=>c[k].contribution_exact_value))),
    initial=initialize(ranks,values.length);let summary=initial,counts=emptyCounts();
  for(const [i,c] of contributions.entries()){summary=advance(summary,i,values.length,c);counts=count(counts,i,c);}
  return {initial,summary,counts,ranks,contributions,result:()=>finalize(summary,values.length,counts)};
}

test('bounded semantic DATA derives exact type7 quartiles, rational means and COD without population arrays or float coercion',()=>{
  const f=fixture(['0','8000']),r=f.result().reported_site_area;
  assert.equal(r.low,'0');assert.equal(r.q1,'2000');assert.equal(r.median,'4000');assert.equal(r.q3,'6000');assert.equal(r.high,'8000');
  assert.deepEqual(r.mean,{numerator:'4000',denominator:'1'});assert.deepEqual(r.cod_percent,{numerator:'100',denominator:'1'});
  assert.equal(r.selected_count,2);assert.equal(r.observed_count,2);assert.equal(r.cod_reason,null);
  assert.equal(f.summary.totals.reported_site_area.sum_scaled14,'800000000000000000');
  assert.ok(Object.isFrozen(f.summary.totals.reported_site_area));assert.ok(Buffer.byteLength(JSON.stringify(f.summary))<16000);
  assert.equal(Object.hasOwn(f.summary,'values'),false);assert.equal(Object.hasOwn(f.summary,'accounts'),false);
});

test('twelve-fraction originals retain fourteen-fraction interpolated quartiles above binary safe integers',()=>{
  const r=fixture(['9007199254740993.000000000001','9007199254740993.000000000002']).result().reported_site_area;
  assert.equal(r.q1,'9007199254740993.00000000000125');assert.equal(r.median,'9007199254740993.0000000000015');
  assert.equal(r.q3,'9007199254740993.00000000000175');
  assert.deepEqual(r.mean,{numerator:'18014398509481986000000000003',denominator:'2000000000000'});
  assert.deepEqual(r.cod_percent,{numerator:'100',denominator:'18014398509481986000000000003'});
});

test('all remainder cases, odd populations, duplicates and missing observations use eligible account denominators',()=>{
  const r=fixture(['1','2','5','10','10',null]).result().reported_site_area;
  assert.equal(r.selected_count,6);assert.equal(r.observed_count,5);assert.equal(r.q1,'2');assert.equal(r.median,'5');assert.equal(r.q3,'10');
  assert.deepEqual(r.mean,{numerator:'28',denominator:'5'});assert.deepEqual(r.cod_percent,{numerator:'68',denominator:'1'});
  const even=fixture(['1','2','5','10']).result().reported_site_area;
  assert.equal(even.q1,'1.75');assert.equal(even.median,'3.5');assert.equal(even.q3,'6.25');
});

test('genuine zero median and no eligible observations remain distinct, and EMPTY has no fabricated statistics',()=>{
  const zero=fixture(['0']).result().reported_site_area;assert.equal(zero.median,'0');assert.equal(zero.cod_percent,null);assert.equal(zero.cod_reason,'zero_median');
  for(const values of [[],[null,null]]){
    const f=fixture(values),r=f.result().reported_site_area;assert.equal(r.median,null);assert.equal(r.mean,null);assert.equal(r.cod_percent,null);
    assert.equal(r.cod_reason,'no_eligible_observations');assert.equal(r.observed_count,0);assert.equal(r.selected_count,values.length);
    assert.deepEqual(advance(f.summary,values.length,values.length,null),f.summary);
  }
});

test('finalization reconciles EVERY independent value-state, part, reason and eligible counter, not counts/hash alone',()=>{
  const f=fixture(['1',null]);assert.throws(()=>finalize(f.initial,2,f.counts));
  for(const mutate of [c=>{c.reported_site_area.source_part_counts.missing++;},
    c=>{c.reported_site_area.exclusion_reason_counts.missing_parts=0;},
    c=>{c.reported_market_value.exclusion_reason_counts.currency_not_established=1;},
    c=>{c.reported_site_area.value_states.missing=0;}]){
    const changed=structuredClone(f.counts);mutate(changed);assert.throws(()=>finalize(f.summary,2,changed));
  }
  const wrong=structuredClone(f.summary);wrong.totals.reported_site_area.observed_count=2;assert.throws(()=>prepare(wrong,2,2));
  assert.throws(()=>advance(f.summary,2,2,cells('2')));
});

test('closed summary, nested cells and fixed three rank rows reject getters, proxies, symbols, extra fields and coerced totals without evaluation',()=>{
  const f=fixture(['1','3']);let traps=0;const trap=()=>{traps++;throw Error('getter ran');};
  for(const mutate of [s=>Object.defineProperty(s,'ranks',{enumerable:true,get:trap}),
    s=>Object.defineProperty(s.ranks,'0',{enumerable:true,get:trap}),s=>{s.ranks=new Proxy(s.ranks,{get:trap});},
    s=>Object.defineProperty(s.totals.reported_site_area,'sum_scaled14',{enumerable:true,get:trap}),
    s=>{s.counts=new Proxy(s.counts,{get:trap});},s=>{s[Symbol('extra')]=1;},s=>{s.values=['1','3'];},
    s=>{s.totals.reported_site_area.sum_scaled14='04';},s=>{s.totals.reported_site_area.absolute_deviation_scaled14='-1';},
    s=>{s.ranks[2].median_remainder=0;}]){
    const changed=structuredClone(f.summary);mutate(changed);assert.throws(()=>prepare(changed,2,2));
  }
  const changed=cells('1');Object.defineProperty(changed.reported_site_area,'contribution_exact_value',{enumerable:true,get:trap});
  assert.throws(()=>advance(f.initial,0,2,changed));assert.equal(traps,0);
  for(const args of [[],[f.summary,2],[f.summary,2,2,true]])assert.throws(()=>prepare(...args));
});

const expected={...Object.fromEntries(['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'].map((k,i)=>[k,ref(i+1)])),
  command_id:id,selected_stock_count:1},transition=()=>({format:'cohort_selected_semantic_receipt_v2',...expected,
    sequence:1,previous:null,before:{selected_ordinal:0,done:false},after:{selected_ordinal:1,done:false},
    selected_entry:{account_id:'A',ordinal:1,partition_ordinal:2,entry_reference:ref(7)},contribution_row_reference:ref(8),
    before_summary_reference:null,after_summary_reference:ref(9)});

test('tenth receipt binds six immutable parents and bounded aggregate references, and requires a separate fresh EMPTY',()=>{
  const first=receipt(transition(),expected);assert.ok(Object.isFrozen(first.selected_entry));assert.ok(Buffer.byteLength(JSON.stringify(first))<4096);
  const last={...transition(),sequence:2,previous:ref(9),before:first.after,after:{selected_ordinal:1,done:true},
    selected_entry:null,contribution_row_reference:null,before_summary_reference:ref(9)};
  assert.equal(receipt(last,expected).after.done,true);
  for(const patch of [{numeric_reference:ref(9)},{values:['1']},{counts:{}},{sequence:2},{previous:ref(9)},
    {before_summary_reference:ref(9)},{after_summary_reference:null},{after:{selected_ordinal:0,done:true},selected_entry:null,contribution_row_reference:null},
    {selected_entry:{...transition().selected_entry,ordinal:2}},{before:{selected_ordinal:0,done:true}},
    {after_summary_reference:{...ref(9),canonical_utf8_bytes:'16001'}}])assert.throws(()=>receipt({...transition(),...patch},expected));
  let calls=0;const command={toString(){calls++;return id;}};assert.throws(()=>receipt({...transition(),command_id:command},{...expected,command_id:command}));assert.equal(calls,0);
  assert.throws(()=>receipt(transition(),new Proxy(expected,{})));assert.throws(()=>receipt({...transition(),get previous(){assert.fail('getter');}},expected));
});
