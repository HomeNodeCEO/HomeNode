import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomWorkspaceRequestLane } from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
const tick = async () => { for(let n=0;n<20;n++) await Promise.resolve(); };
const deferred = () => { let resolve,reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const signal = () => new AbortController().signal;
function harness() { const timers=new Map();let id=0;return { timers, lane:createCustomWorkspaceRequestLane({
  timer:{set:fn=>{timers.set(++id,fn);return id;},clear:key=>timers.delete(key)}}),expire(){for(const fn of [...timers.values()])fn();} }; }

test('catalog, checkpoint saves and previews share one ordered request lane', async () => {
  const h=harness(), first=deferred(), events=[];
  const a=h.lane.run(async()=>{events.push('save');return first.promise;},{signal:signal()});
  const b=h.lane.run(async()=>{events.push('preview');return 2;},{signal:signal()});
  await tick();assert.deepEqual(events,['save']);assert.equal(h.lane.isIdle(),false);
  first.resolve(1);assert.equal(await a,1);assert.equal(await b,2);await h.lane.flush();
  assert.deepEqual(events,['save','preview']);assert.equal(h.lane.isIdle(),true);assert.equal(h.timers.size,0);
});
test('cancelling a subscriber does not pretend the active HTTP call finished', async () => {
  const h=harness(), call=deferred(), cancelled=new AbortController();let ownedSignal,second=0;
  const a=h.lane.run(async options=>{ownedSignal=options.signal;return call.promise;},{signal:cancelled.signal});
  await tick();cancelled.abort();await assert.rejects(a,{name:'AbortError'});
  const b=h.lane.run(async()=>++second,{signal:signal()});await tick();
  assert.equal(ownedSignal.aborted,false);assert.equal(second,0);call.resolve('ignored');
  assert.equal(await b,1);await h.lane.flush();
});
test('cancelled queued work is removed without performing a stale write', async () => {
  const h=harness(), call=deferred(), cancelled=new AbortController();let writes=0;
  const a=h.lane.run(()=>call.promise,{signal:signal()});
  const b=h.lane.run(async()=>++writes,{signal:cancelled.signal});cancelled.abort();
  await assert.rejects(b,{name:'AbortError'});call.resolve(1);await a;await h.lane.flush();assert.equal(writes,0);
});
test('deadline quarantines the lane; late settlement cannot silently drain queued requests', async () => {
  const h=harness(), call=deferred();let queued=0;
  const a=h.lane.run(()=>call.promise,{signal:signal()}), b=h.lane.run(async()=>++queued,{signal:signal()});
  const draining=h.lane.flush();await tick();h.expire();await assert.rejects(a,/deadline/);await assert.rejects(b,/recovery_required/);
  await assert.rejects(draining,/recovery_required/);
  assert.throws(()=>h.lane.recover(),/busy/);assert.equal(h.lane.isIdle(),false);
  call.resolve('late');await tick();assert.equal(h.lane.isIdle(),true);assert.equal(queued,0);
  await assert.rejects(h.lane.flush(),/recovery_required/);
  await assert.rejects(h.lane.run(async()=>++queued,{signal:signal()}),/recovery_required/);
  h.lane.recover();assert.equal(await h.lane.run(async()=>++queued,{signal:signal()}),1);await h.lane.flush();
});
test('ordinary errors are not retried and do not block a later explicit read', async () => {
  const h=harness();let writes=0;
  await assert.rejects(h.lane.run(async()=>{writes++;throw new Error('conflict');},{signal:signal()}),/conflict/);
  assert.equal(await h.lane.run(async()=>42,{signal:signal()}),42);await h.lane.flush();assert.equal(writes,1);
});
test('dispose stops this owner without delivering late results or invoking queued work', async () => {
  const h=harness(), call=deferred();let childSignal, queued=0;
  const a=h.lane.run(async({signal})=>{childSignal=signal;return call.promise;},{signal:signal()});
  const b=h.lane.run(async()=>++queued,{signal:signal()});const drained=h.lane.flush();await tick();h.lane.dispose();
  await assert.rejects(a,{name:'AbortError'});await assert.rejects(b,{name:'AbortError'});await assert.rejects(drained,/disposed/);
  assert.equal(childSignal.aborted,true);call.resolve(1);await tick();assert.equal(queued,0);
  await assert.rejects(h.lane.run(async()=>1,{signal:signal()}),/disposed/);assert.equal(h.timers.size,0);
});
test('queue is bounded and already cancelled work never reaches transport', async () => {
  const h=harness(), call=deferred(), stopped=new AbortController();stopped.abort();let sent=0;
  await assert.rejects(h.lane.run(async()=>++sent,{signal:stopped.signal}),{name:'AbortError'});
  const a=h.lane.run(()=>call.promise,{signal:signal()});const rest=Array.from({length:8},()=>h.lane.run(async()=>++sent,{signal:signal()}));
  await assert.rejects(h.lane.run(async()=>++sent,{signal:signal()}),/queue_full/);
  call.resolve(1);await a;await Promise.all(rest);await h.lane.flush();assert.equal(sent,8);
});
