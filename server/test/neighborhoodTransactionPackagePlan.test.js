import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBoundedTransactionPackageCountPlan as verify }
  from './helpers/neighborhoodTransactionPackageDatabaseChecks.js';

/** Synthetic EXPLAIN DATA only; native PostgreSQL execution remains cloud-only. */
function plan(initializerFirst=true,inputRows=251,memberRows=0) {
  const counter=()=>{const initializer={'Parent Relationship':'InitPlan','Actual Rows':1};
    const input={'Parent Relationship':'Outer','Actual Rows':inputRows};
    return {'Node Type':'Limit','Actual Rows':251,Plans:initializerFirst?[initializer,input]:[input,initializer]};};
  return {Plans:[counter(),counter(),{'Subplan Name':'CTE members','Actual Rows':memberRows}]};
}

test('native count-plan inspector distinguishes main input from one-row InitPlan in either order',()=>{
  assert.doesNotThrow(()=>verify(plan(true)));assert.doesNotThrow(()=>verify(plan(false)));
});
test('native count-plan inspector refuses a full oversized input or payload materialization',()=>{
  assert.throws(()=>verify(plan(true,1000)),/counter main input/);
  assert.throws(()=>verify(plan(false,251,1)),/materializes no payload/);
});
test('native count-plan inspector requires both bounded counters and an unambiguous main input',()=>{
  const missing=plan();missing.Plans.shift();assert.throws(()=>verify(missing),/sale and link counters/);
  const noInput=plan();noInput.Plans[0].Plans.shift();noInput.Plans[0].Plans[0]['Parent Relationship']='InitPlan';
  assert.throws(()=>verify(noInput),/exactly one main input/);
  const duplicate=plan();duplicate.Plans[0].Plans.push({'Parent Relationship':'Outer','Actual Rows':251});
  assert.throws(()=>verify(duplicate),/exactly one main input/);
});
