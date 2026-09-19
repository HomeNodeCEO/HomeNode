import test from 'node:test';
import assert from 'node:assert/strict';
import { withCustomCohortRetentionTiming as timed } from '../src/services/neighborhoodAssessment/customCohortRetentionTiming.js';
test('retention diagnostics preserve query arguments/results/errors and contain fixed counters only',async()=>{
  const output=[],result={marker:'private result'},error=new Error('private database error');let seen;
  const client={query:async(...args)=>{seen=args;if(args[0]==='fail')throw error;return result;},release(){assert.fail('timing never releases');}};
  const config={text:'/* neighborhood-cohort-blob:insert-batch */ private SQL',values:['private account']};
  assert.equal(await timed(client,async observed=>observed.query(config),event=>output.push(event)),result);assert.deepEqual(seen,[config]);
  await assert.rejects(timed(client,observed=>observed.query('fail'),event=>output.push(event)),actual=>actual===error);
  assert.equal(output.length,2);assert.equal(output[0].outcome,'completed');assert.equal(output[1].outcome,'failed');
  assert.equal(output[0].queries['neighborhood-cohort-blob:insert-batch'].count,1);assert.equal(output[1].queries.other.count,1);
  assert.ok(output.every(e=>e.query_count===1&&e.query_ms>=0&&e.non_query_wall_ms>=0&&Object.isFrozen(e)));
  assert.doesNotMatch(JSON.stringify(output),/private|account|SQL|error/);assert.ok(Buffer.byteLength(JSON.stringify(output))<4000);
});
test('throwing or rejecting diagnostics cannot change storage success or failure',async()=>{
  const client={query:async()=>42,release(){}};
  for(const report of [()=>{throw Error('logger');},async()=>{throw Error('logger');}]){
    assert.equal(await timed(client,c=>c.query('select'),report),42);
    const failure=new Error('original');await assert.rejects(timed(client,async()=>{throw failure;},report),e=>e===failure);
  }
});

test('unrecognized, late and arbitrary tags cannot become diagnostic dimensions or reveal query details', async () => {
  const output = [], calls = [], released = [];
  const client = {
    query(...args) { assert.equal(this, client); calls.push(args); return Promise.resolve(calls.length); },
    release(...args) { assert.equal(this, client); released.push(args); },
  };
  const inputs = [
    ['/* private-client:private-subject */ select sensitive_field', ['private ID']],
    ['x'.repeat(128) + '/* neighborhood-cohort-blob:read */'],
    ['select 1 /* neighborhood-cohort-blob:read */'],
    [{ text: '/* neighborhood-cohort-blob:read-batch */ query', values: ['private values'] }],
  ];
  await timed(client, async observed => {
    for (const [index, args] of inputs.entries()) assert.equal(await observed.query(...args), index + 1);
    observed.release('explicit-owner-release');
  }, event => output.push(event));
  assert.deepEqual(calls, inputs);
  assert.deepEqual(released, [['explicit-owner-release']], 'release is only forwarded at the explicit caller request');
  assert.equal(output.length, 1);
  assert.equal(output[0].query_count, 4);
  assert.equal(output[0].queries.other.count, 3);
  assert.equal(output[0].queries['neighborhood-cohort-blob:read-batch'].count, 1);
  assert.equal(Object.keys(output[0].queries).length, 8);
  assert.doesNotMatch(JSON.stringify(output), /private|sensitive|select 1|explicit-owner/);
});
