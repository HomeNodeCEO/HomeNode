import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDcf, calculateDirect, dcfCsv, defaultDcf } from '../src/features/academy/model.ts';
import { emptyProgress, markModuleRead, parseProgress, progressStats, recordAnswer, recordExam } from '../src/features/academy/progress.ts';
import { foundations } from '../src/features/academy/foundations.ts';
import { leaseModules } from '../src/features/academy/leases.ts';
import { capitalizationModules } from '../src/features/academy/capitalization.ts';
import { marketModelingModules } from '../src/features/academy/marketModeling.ts';
import { sources } from '../src/features/academy/reference.ts';
import { readingFoundations } from '../src/features/academy/readingFoundations.ts';
import { readingLeases } from '../src/features/academy/readingLeases.ts';
import { readingCapitalization } from '../src/features/academy/readingCapitalization.ts';
import { readingMarketModeling } from '../src/features/academy/readingMarketModeling.ts';

const questions=[...foundations,...leaseModules,...capitalizationModules,...marketModelingModules].flatMap(m=>m.questions);
const modules=[...foundations,...leaseModules,...capitalizationModules,...marketModelingModules];
const readings=[...readingFoundations,...readingLeases,...readingCapitalization,...readingMarketModeling];
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.01,`${actual} != ${expected}`);

test('Cedar Court income bridge and direct capitalization agree with independently calculated case',()=>{
  const r=calculateDirect(80,1500,48000,5,12000,8000,60000,560000,6.25);
  assert.deepEqual(r,{gross:1440000,vacancyLoss:72000,egi:1360000,noi:800000,value:12800000});
  near(calculateDirect(80,1500,48000,5,12000,8000,60000,560000,6.75).value,11851851.85185);
});
test('office DCF includes Year 5 operating cash and one forward-income reversion',()=>{
  const r=calculateDcf(defaultDcf);
  near(r.sale,11060000); near(r.operatingPv,2384257.12326728); near(r.salePv,7188241.132459699); near(r.value,9572498.255726978);
  assert.deepEqual(r.rows.map(row=>row.cash),[450000,600000,660000,690000,720000]);
  assert.equal(r.rows[4].total,11780000);
  assert.equal(r.rows.filter(row=>row.reversion!==0).length,1);
  near(calculateDcf({...defaultDcf,discount:0}).value,14180000);
});
test('DCF sensitivities move in the expected direction and capital is discounted at its own date',()=>{
  const base=calculateDcf(defaultDcf).value;
  assert.ok(calculateDcf({...defaultDcf,discount:10}).value<base);
  assert.ok(calculateDcf({...defaultDcf,exitCap:7.5}).value<base);
  near(base-calculateDcf({...defaultDcf,capital:[150000,150000,40000,40000,40000]}).value,100000/(1.09**2));
});
test('invalid inputs never leak Infinity or NaN into value',()=>{
  for(const patch of [{exitCap:0},{discount:-1},{selling:101},{nextNoi:NaN},{noi:[1]}]) assert.throws(()=>calculateDcf({...defaultDcf,...patch}));
  assert.throws(()=>calculateDirect(80,1500,0,101,0,0,0,100,6));
  assert.throws(()=>calculateDirect(80,1500,0,5,0,0,0,100,0));
  assert.throws(()=>calculateDcf({...defaultDcf,nextNoi:1e308}));
  assert.throws(()=>calculateDirect(1e308,1500,0,5,0,0,0,100,6));
});
test('formula CSV aligns input references, terminal year and NPV cross-check',()=>{
  const lines=dcfCsv(defaultDcf).split('\r\n');
  assert.match(lines[1],/0.09/);assert.match(lines[2],/0.07/);
  assert.match(lines[10],/\$B\$5\/\$B\$3\*\(1-\$B\$4\)/);
  assert.match(lines[10],/=F11\/\(1\+\$B\$2\)\^A11/);
  assert.match(lines[11],/=SUM\(G7:G11\)/);
  assert.match(lines[14],/=NPV\(B2,F7:F11\)/);
  assert.throws(()=>dcfCsv({...defaultDcf,nextNoi:Infinity}));
});
test('50 exam questions include complete answer feedback and valid primary references',()=>{
  assert.equal(questions.length,50);assert.equal(new Set(questions.map(q=>q.id)).size,50);
  for(const q of questions){assert.equal(q.options.length,4,q.id);assert.equal(q.explanations.length,4,q.id);assert.ok(q.answer>=0&&q.answer<4,q.id);assert.ok(q.lesson.length>=2,q.id);assert.ok(q.sources.length,q.id);for(const id of q.sources)assert.ok(sources[id],`${q.id}: ${id}`);}
  assert.ok(questions.filter(q=>q.essential).length>=20);
});

test('each chapter has complete reading, worked examples, unique anchors and ungraded checks',()=>{
  assert.equal(readings.length,modules.length);
  assert.equal(new Set(readings.map(r=>r.moduleId)).size,modules.length);
  let checks=0;
  for(const module of modules){
    const reading=readings.find(r=>r.moduleId===module.id);
    assert.ok(reading,module.id);assert.equal(module.questions.length,5);
    assert.equal(reading.sections.length,4);assert.equal(new Set(reading.sections.map(s=>s.id)).size,4);
    assert.ok(reading.objectives.length>=3);assert.ok(reading.summary.length>=3);
    assert.ok(reading.sections.some(s=>s.example),module.id);
    const wordCount=reading.sections.flatMap(s=>s.paragraphs).join(' ').split(/\s+/).length;
    assert.ok(wordCount>=500,`${module.id}: substantive reading missing (${wordCount} words)`);
    for(const section of reading.sections){
      assert.ok(section.paragraphs.length>=2);
      if(section.example){assert.ok(section.example.rows.length);for(const row of section.example.rows)assert.equal(row.length,section.example.columns.length);}
      if(section.check){const c=section.check;checks++;assert.ok(c.answer>=0&&c.answer<c.options.length);assert.ok(c.explanation.length>40);}
    }
  }
  assert.equal(checks,20);
});

test('section exam submission is atomic and retakes retain original first attempts',()=>{
  const exam=modules[0].questions;
  const initial=emptyProgress();
  const complete=Object.fromEntries(exam.map(q=>[q.id,q.answer]));
  const incomplete={...complete};delete incomplete[exam[4].id];
  assert.strictEqual(recordExam(initial,exam,incomplete),initial);
  assert.strictEqual(recordExam(initial,exam,{...complete,[exam[0].id]:99}),initial);
  const wrong=(exam[0].answer+1)%4;
  const first=recordExam(initial,exam,{...complete,[exam[0].id]:wrong});
  assert.equal(progressStats(first,exam).firstCorrect,4);
  const retry=recordExam(first,exam,complete);
  assert.equal(progressStats(retry,exam).correct,5);
  assert.equal(progressStats(retry,exam).firstCorrect,4);
  assert.equal(retry.answers[exam[0].id].attempts,2);
  assert.equal(progressStats(retry,questions).answered,5);
});

test('reading progress is separate from exam answers and old saved answers migrate without loss',()=>{
  const q=questions[0];const old=recordAnswer(emptyProgress(),q,q.answer);old.bookmarks=[q.id];
  const ids=modules.map(m=>m.id);
  const loaded=parseProgress(JSON.stringify(old),questions,ids);
  assert.deepEqual(loaded,old);
  const read=markModuleRead(markModuleRead(loaded,ids[0]),ids[0]);
  assert.deepEqual(read.readModules,[ids[0]]);assert.deepEqual(read.answers,old.answers);
  const cleaned=parseProgress(JSON.stringify({...read,readModules:[ids[0],ids[0],'deleted'],lastModuleId:'deleted'}),questions,ids);
  assert.deepEqual(cleaned.readModules,[ids[0]]);assert.equal(cleaned.lastModuleId,undefined);
  const resumed=parseProgress(JSON.stringify({...read,lastModuleId:ids[1]}),questions,ids);
  assert.equal(resumed.lastModuleId,ids[1]);assert.deepEqual(resumed.bookmarks,[q.id]);
});
test('retry preserves first attempt while resolving the missed question',()=>{
  const q=questions[0];const wrong=(q.answer+1)%4;
  let p=recordAnswer(emptyProgress(),q,wrong);
  assert.deepEqual(progressStats(p,questions).missed,[q.id]);
  p=recordAnswer(p,q,q.answer);
  assert.equal(p.answers[q.id].first,wrong);assert.equal(p.answers[q.id].attempts,2);
  assert.equal(progressStats(p,questions).firstCorrect,0);assert.equal(progressStats(p,questions).correct,1);assert.equal(progressStats(p,questions).missed.length,0);
});
test('storage corruption and obsolete question IDs are safely discarded',()=>{
  assert.deepEqual(parseProgress('{broken',questions),emptyProgress());
  assert.deepEqual(parseProgress('{"version":2}',questions),emptyProgress());
  const q=questions[0];const p=recordAnswer(emptyProgress(),q,q.answer);p.bookmarks=[q.id,'deleted'];p.lastId='deleted';
  const loaded=parseProgress(JSON.stringify(p),questions);
  assert.deepEqual(loaded.bookmarks,[q.id]);assert.equal(loaded.lastId,undefined);assert.deepEqual(loaded.answers,p.answers);
  assert.deepEqual(parseProgress(JSON.stringify({...p,answers:{[q.id]:{selected:90,first:0,attempts:1}}}),questions).answers,{});
});
