import test from 'node:test';
import assert from 'node:assert/strict';
import { withCustomCohortRetentionTiming as timed,
  withCustomCohortLoadTiming as timedLoad } from '../src/services/neighborhoodAssessment/customCohortRetentionTiming.js';

test('load diagnostics preserve the original query receiver, result and failure with fixed counters only', async () => {
  const output = [], calls = [], result = Object.freeze({ original: true }), failure = new Error('private failure');
  const query = { text: '/* neighborhood-cohort-blob:read-batch */ private SQL', values: ['private hash'] };
  const client = {
    async query(...args) { assert.equal(this, client); calls.push(args); if (args[0] === 'fail') throw failure; return result; },
    release() { assert.fail('the load timer does not release the caller transaction'); },
  };
  assert.equal(await timedLoad(client, observed => observed.query(query), event => output.push(event)), result);
  await assert.rejects(timedLoad(client, observed => observed.query('fail'), event => output.push(event)), error => error === failure);
  assert.deepEqual(calls, [[query], ['fail']]);
  assert.deepEqual(output.map(event => [event.phase, event.outcome]), [['load', 'completed'], ['load', 'failed']]);
  assert.equal(output[0].queries['neighborhood-cohort-blob:read-batch'].count, 1);
  assert.equal(output[1].queries.other.count, 1);
  assert.ok(output.every(event => Object.isFrozen(event) && Object.isFrozen(event.queries)
    && event.query_count === 1 && event.query_ms >= 0 && event.non_query_wall_ms >= 0
    && Object.keys(event.queries).length === 8));
  assert.doesNotMatch(JSON.stringify(output), /private|SQL|hash|original|failure/);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 4000);
});

test('load logger failures cannot replace successful originals or the original refusal', async () => {
  const client = { query: async () => 42, release() {} }, failure = new Error('original refusal');
  for (const report of [() => { throw Error('logger'); }, async () => { throw Error('logger'); }]) {
    assert.equal(await timedLoad(client, observed => observed.query('select'), report), 42);
    await assert.rejects(timedLoad(client, async () => { throw failure; }, report), error => error === failure);
  }
});
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
