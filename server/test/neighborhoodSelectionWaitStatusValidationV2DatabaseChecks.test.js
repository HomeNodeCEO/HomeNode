import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runNeighborhoodSelectionWaitStatusValidationV2DatabaseChecks as check }
  from './helpers/neighborhoodSelectionWaitStatusValidationV2DatabaseChecks.js';

// Protocol doubles verify that the regression cannot silently return to an
// already validated fixture. Actual first-scan/lock behavior requires cloud PG.
function fixture({prevalidated=false,exclusive=false,identity='neighborhood_'+'a'.repeat(32)+'_test',lostCommit=false}={}){
  const calls=[];let validated=true,connections=0;
  const clients=['writer','validator'].map(role=>({
    release(){calls.push({role,sql:'RELEASE'});},
    async query(sql){
      calls.push({role,sql});
      if(sql.startsWith('SELECT current_database()'))return {rows:[{database_name:identity}]};
      if(sql.startsWith('ALTER TABLE')){assert.equal(role,'writer');validated=false;return {rows:[]};}
      if(sql.includes('SELECT convalidated'))return {rows:[{convalidated:role==='validator'&&prevalidated?true:validated}]};
      if(sql.includes('VALIDATE CONSTRAINT')){assert.equal(role,'validator');validated=true;return {rows:[]};}
      if(sql.includes('FROM pg_locks'))return {rows:[{mode:'ShareUpdateExclusiveLock'},...(exclusive?[{mode:'AccessExclusiveLock'}]:[])]};
      if(sql==='COMMIT'&&role==='validator'&&lostCommit)throw Error('lost_validation_commit_ack');
      if(['BEGIN','COMMIT','ROLLBACK',"SET LOCAL lock_timeout='1s'",
        'LOCK TABLE app.neighborhood_custom_cohort_capture_jobs IN ROW EXCLUSIVE MODE'].includes(sql))return {rows:[]};
      assert.fail(`unexpected ${role} SQL`);
    },
  }));
  return {calls,pool:{async connect(){return clients[connections++];}}};
}

test('first validation uses exact installation DDL committed before the independent writer and false-to-true scan',async t=>{
  t.mock.method(console,'info',()=>{});
  const f=fixture();await check(f.pool);
  const installation=await readFile(new URL('../migrations/20261123_custom_cohort_selection_wait_v2.sql',import.meta.url),'utf8'),
    validation=await readFile(new URL('../migrations/20261123_custom_cohort_selection_wait_validate_status_v2.sql',import.meta.url),'utf8');
  const ddl=f.calls.find(c=>c.sql.startsWith('ALTER TABLE'));
  assert.ok(installation.includes(ddl.sql));
  assert.equal(f.calls.filter(c=>c.sql===validation).length,1);
  const commit=f.calls.findIndex(c=>c.role==='writer'&&c.sql==='COMMIT'),
    lock=f.calls.findIndex(c=>c.sql.includes('IN ROW EXCLUSIVE MODE')),
    scan=f.calls.findIndex(c=>c.sql===validation);
  assert.ok(commit>0&&lock>commit&&scan>lock);
  assert.match(f.calls[scan-1].sql,/SELECT convalidated/);
  assert.equal(f.calls.filter(c=>c.role==='validator'&&c.sql==='COMMIT').length,1);
  assert.equal(f.calls.filter(c=>c.sql==='RELEASE').length,2);
});

test('already validated state refuses before validation SQL and still releases both connections',async()=>{
  const f=fixture({prevalidated:true});await assert.rejects(check(f.pool),/deep-equal/);
  assert.ok(!f.calls.some(c=>c.sql.includes('VALIDATE CONSTRAINT')));
  assert.equal(f.calls.filter(c=>c.sql==='RELEASE').length,2);
});

test('unexpected database refuses before fixture DDL and ordinary capture-job locks',async()=>{
  const f=fixture({identity:'production'});await assert.rejects(check(f.pool),/disposable CI database/);
  assert.ok(!f.calls.some(c=>c.sql.startsWith('ALTER TABLE')||c.sql.includes('ROW EXCLUSIVE')));
  assert.equal(f.calls.filter(c=>c.sql==='RELEASE').length,1);
});

test('exclusive validation locks and lost commit acknowledgements cannot report a successful probe',async()=>{
  const exclusive=fixture({exclusive:true});await assert.rejects(check(exclusive.pool));
  assert.ok(!exclusive.calls.some(c=>c.role==='validator'&&c.sql==='COMMIT'));
  const lost=fixture({lostCommit:true});await assert.rejects(check(lost.pool),/lost_validation_commit_ack/);
  for(const f of [exclusive,lost])assert.equal(f.calls.filter(c=>c.sql==='RELEASE').length,2);
});
