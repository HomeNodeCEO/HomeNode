import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { prepareNeighborhoodCoveredCadCacheHeaderV2 as prepare } from '../src/services/neighborhoodAssessment/neighborhoodCoveredCadCacheHeaderV2.js';
const profile=getNeighborhoodFrozenTypedCadImprovementV1Profile(),source={generation_id:'DATA-only',source_snapshot:'1:2:',row_count:'5',
  layer_counts:{primary:{row_count:'2'},secondary:{row_count:'3'}}},binding=assessmentEvidenceDigest({source,profile});
const raw=()=>({binding_sha256:binding,source_metadata:source,definition_json:profile.definition_blob.canonical_json,
  progress:{format:'shared_frozen_typed_CAD_progress_v1',binding_sha256:binding,kind_index:0,after:'',layer_rows:0,typed_rows:'0',typed_utf8_bytes:'0'},
  status:'building',completed_at:null});

test('covered CAD header DATA admits coherent building and complete global scans without certifying job coverage',()=>{
  const initial=prepare(raw(),source);assert.equal(initial.status,'building');assert.ok(Object.isFrozen(initial.progress));
  const middle=raw();Object.assign(middle.progress,{kind_index:1,typed_rows:'2',typed_utf8_bytes:'1000'});
  assert.equal(prepare(middle,source).progress.kind_index,1);
  const complete=raw();Object.assign(complete,{status:'complete',completed_at:'2026-10-16T10:00:00.000000Z'});
  Object.assign(complete.progress,{kind_index:2,typed_rows:'5',typed_utf8_bytes:'2000'});
  assert.equal(prepare(complete,source).status,'complete');
});

test('covered CAD header refuses mismatched source/profile and malformed or dishonest global progress',()=>{
  for(const patch of [{binding_sha256:'a'.repeat(64)},{definition_json:raw().definition_json+' '},
    {source_metadata:{...source,source_snapshot:'2:3:'}},{status:'complete'},{completed_at:'2026-10-16T10:00:00.000000Z'}])
    assert.throws(()=>prepare({...raw(),...patch},source),/cache_unavailable/);
  for(const patch of [{format:'other'},{binding_sha256:'b'.repeat(64)},{kind_index:-1},{kind_index:3},
    {after:'A'},{after:'\0'},{layer_rows:1},{typed_rows:'1'},{typed_utf8_bytes:null},
    {typed_utf8_bytes:'1'},{typed_utf8_bytes:'8000000001'},{typed_utf8_bytes:'-1'},{kind_index:1,typed_rows:'3'},{kind_index:2,typed_rows:'5'}])
    assert.throws(()=>prepare({...raw(),progress:{...raw().progress,...patch}},source),/cache_unavailable/);
  assert.throws(()=>prepare({...raw(),get status(){assert.fail('getter');}},source),/cache_unavailable/);
  assert.throws(()=>prepare({...raw(),progress:new Proxy({},{getPrototypeOf(){assert.fail('proxy');}})},source),/cache_unavailable/);
});
