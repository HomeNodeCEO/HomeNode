import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreNeighborhoodSecondarySimilarity } from '../src/services/neighborhoodAssessment/neighborhoodSecondarySimilarity.js';

const property = { bedroom_count: 3, bath_count: 2, garage_area_sqft: 400,
  pool: false, outbuilding_area_sqft: 200 };

test('supporting characteristics contribute at most ten percent and preserve the core score when unknown',()=>{
  assert.equal(scoreNeighborhoodSecondarySimilarity({ baseScore: 80 }).score,80);
  const identical=scoreNeighborhoodSecondarySimilarity({ baseScore: 80,subject:property,candidate:property });
  assert.equal(identical.available_weight_percent,10);
  assert.equal(identical.score,82);
  assert.equal(identical.factors.pool.score,100);
});

test('missing CAD fields never become zero beds, no garage, or no pool',()=>{
  const result=scoreNeighborhoodSecondarySimilarity({ baseScore: 80,subject:property,
    candidate: { bedroom_count:null,bath_count:'',garage_area_sqft:null,pool:null,outbuilding_area_sqft:0 } });
  assert.equal(result.score,80);
  assert.equal(result.available_weight_percent,0);
  assert.ok(Object.values(result.factors).every(factor=>!factor.observed));
});

test('large outbuilding differences remain a low-weight support signal',()=>{
  const result=scoreNeighborhoodSecondarySimilarity({ baseScore: 80,subject:property,
    candidate:{ ...property,outbuilding_area_sqft:12000 } });
  assert.ok(result.score>=80 && result.score<=82);
  assert.equal(result.factors.outbuilding.score,0);
  assert.equal(result.factors.outbuilding.weight_percent,2);
  // No secondary-improvement row is not proof that the subject has none.
  const unknownSubject=scoreNeighborhoodSecondarySimilarity({baseScore:80,
    subject:{outbuilding_area_sqft:null},candidate:{outbuilding_area_sqft:12000}});
  assert.equal(unknownSubject.score,80);
  assert.equal(unknownSubject.factors.outbuilding.observed,false);
});

test('explicit pool mismatch is counted only when both values are boolean',()=>{
  const mismatch=scoreNeighborhoodSecondarySimilarity({ baseScore:80,subject:{ pool:true },candidate:{ pool:false } });
  assert.equal(mismatch.available_weight_percent,1);
  assert.equal(mismatch.score,79.2);
  assert.equal(scoreNeighborhoodSecondarySimilarity({ baseScore:80,subject:{ pool:true },candidate:{ pool:'false' } }).score,80);
});

test('invalid scores and implausible source values fail closed',()=>{
  assert.throws(()=>scoreNeighborhoodSecondarySimilarity({ baseScore:NaN }),/base_score_required/);
  const result=scoreNeighborhoodSecondarySimilarity({ baseScore:80,
    subject:{ bedroom_count:40,garage_area_sqft:100001 },
    candidate:{ bedroom_count:3,garage_area_sqft:400 } });
  assert.equal(result.score,80);
});
