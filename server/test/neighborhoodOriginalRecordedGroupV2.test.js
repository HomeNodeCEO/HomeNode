import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { projectNeighborhoodOriginalRecordedGroupLabelsV2 as project,resolveNeighborhoodOriginalRecordedGroupV2 as resolve,
  getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';

/** Bounded DATA-only rows. Neither this builder nor helper issues native authority. */
function row(kind,key,fields={}){const original={...(kind==='accounts'?{account_id:'A',county:'Dallas',subdivision:'Oak Grove'}
  :{object_id:key,account_id:'A',subdivision_name:'Oak Grove'}),...fields};
  return {kind,row_key:key,account_id:'A',original_recorded_labels:project({kind,row_key:key,account_id:'A',payload_text:JSON.stringify(original)})};}
const input=(account={},a={},b={})=>[row('accounts','A',account),row('parcels','1',a),row('parcels','2',b)];
const read=rows=>resolve(rows,()=>{});

test('exact county/name grouping preserves the legacy ID encoding, all variants and outside-part conflicts',()=>{
  const g=read(input({county:' Dallas ',subdivision:' OAK  Grove '},{subdivision_name:'Oak\tGrove'},{subdivision_name:'oak grove'}));
  const id=`recorded-cad:${createHash('sha256').update(JSON.stringify({county:'dallas',label:'oak grove'})).digest('hex')}`;
  assert.equal(g.assigned_group_id,id);assert.equal(g.state,'assigned');assert.deepEqual(g.reasons,[]);
  assert.deepEqual(g.candidate_groups,[{id,normalized_county:'dallas',normalized_label:'oak grove',
    raw_label_variants:[' OAK  Grove ','Oak\tGrove','oak grove'],raw_county_variants:[' Dallas ']}]);
  assert.equal(g.parcel_source_row_count,'2');assert.equal(g.partially_observed,false);
  const conflict=read(input({}, {},{subdivision_name:'Other Grove'}));
  assert.equal(conflict.state,'unassigned');assert.equal(conflict.assigned_group_id,null);
  assert.deepEqual(conflict.reasons,['conflicting_recorded_subdivision_labels']);assert.equal(conflict.candidate_groups.length,2);
  assert.equal(conflict.authority,'not_established');assert.equal(conflict.selected_union,'not_established');
  assert.equal(conflict.report_update,'none');assert.ok(Object.isFrozen(conflict.candidate_groups[0]));
});

test('missing/placeholder/invalid county or labels preserve unassigned denominators and partial known evidence without fabrication',()=>{
  for(const county of [undefined,null,'','unknown','n/a']){
    const g=read(input({county}));assert.equal(g.state,'unassigned');assert.equal(g.assigned_group_id,null);
    assert.deepEqual(g.reasons,['county_unavailable']);assert.deepEqual(g.candidate_groups,[]);
  }
  for(const county of [123,{},true,'Dallas\u0001']){
    const g=read(input({county}));assert.deepEqual(g.reasons,['county_unavailable','invalid_recorded_county']);assert.deepEqual(g.candidate_groups,[]);
  }
  const noAccount=read([row('parcels','1')]);assert.equal(noAccount.account_original_state,'absent');
  assert.deepEqual(noAccount.reasons,['county_unavailable']);assert.equal(noAccount.parcel_source_row_count,'1');
  for(const label of [null,'','UNKNOWN','Unassigned','n/a','none','not available']){
    const g=read(input({}, {subdivision_name:label}));assert.equal(g.state,'assigned');assert.equal(g.partially_observed,true);
    assert.equal(g.candidate_groups[0].normalized_label,'oak grove');
  }
  const all=read(input({subdivision:null},{subdivision_name:'none'},{subdivision_name:''}));
  assert.deepEqual(all.reasons,['recorded_subdivision_label_unavailable']);assert.deepEqual(all.candidate_groups,[]);
  for(const value of [123,{},true,'Oak\u0001']){
    const g=read(input({}, {},{subdivision_name:value}));assert.equal(g.state,'unassigned');
    assert.deepEqual(g.reasons,['invalid_recorded_subdivision_label']);assert.equal(g.candidate_groups.length,1);
  }
  const nonDallas=read(input({county:'Tarrant'}));assert.equal(nonDallas.candidate_groups[0].normalized_county,'tarrant');
});

test('original labels through512 UTF8bytes survive the128-byte cache boundary, while oversize refuses the WHOLE packet',()=>{
  for(const label of ['a'.repeat(129),'a'.repeat(512),'é'.repeat(256),'😀'.repeat(128)]){
    const g=read(input({subdivision:label},{subdivision_name:label},{subdivision_name:label}));
    assert.equal(g.state,'assigned');assert.equal(g.candidate_groups[0].normalized_label,label);assert.deepEqual(g.raw_label_variants,[label]);
  }
  for(const label of ['a'.repeat(513),'é'.repeat(257),'😀'.repeat(129)])
    assert.throws(()=>input({}, {},{subdivision_name:label}),/recorded_label_text_limit/);
  assert.equal(JSON.parse(getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.canonical_json).limits.label_utf8_bytes,512);
  const p=getNeighborhoodOriginalRecordedGroupV2Profile();assert.equal(p.profile_ref.content_sha256,p.definition_blob.ref.content_sha256);
});

test('closed bounded original projection and detached resolution reject hostile DATA, duplicate keys, foreign identities and incomplete packages',()=>{
  const good={kind:'accounts',row_key:'A',account_id:'A',payload_text:'{"account_id":"A"}'};
  for(const bad of [{...good,readOriginal(){}},{...good,get payload_text(){assert.fail('getter');}},new Proxy(good,{}),
    {...good,payload_text:'{"account_id":"A","account_id":"A"}'},{...good,payload_text:'[]'},
    {...good,payload_text:'{"account_id":"B"}'},{...good,payload_text:JSON.stringify({account_id:'A',county:'\ud800'})},
    {...good,payload_text:JSON.stringify({account_id:'A',county:'Dallas\u0000'})},
    {...good,kind:'source_records'},{...good,payload_text:' '.repeat(1000001)}])
    assert.throws(()=>project(bad),/invalid_|identity_mismatch/);
  const getters=[{get kind(){assert.fail('getter');}}],holes=new Array(1),extra=input();extra.x=true;
  for(const bad of [new Proxy([],{}),holes,extra,getters,[],[row('accounts','A')],[row('parcels','1'),row('parcels','1')],
    [row('parcels','1'),row('accounts','A')],[{...row('parcels','1'),account_id:'B'},row('parcels','2')]])
    assert.throws(()=>read(bad),/invalid_input|incomplete_account/);
  const forged=input();forged[0]=structuredClone(forged[0]);forged[0].original_recorded_labels.subdivision.key='forged';
  assert.throws(()=>read(forged),/invalid_input/);
  const rows=input(),g=read(rows);rows[0]=row('accounts','A',{subdivision:'Different'});assert.equal(g.state,'assigned');
  assert.throws(()=>resolve(input(),()=>{throw new Error('owner_budget');}),/owner_budget/);
});
