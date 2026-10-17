import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import * as reference from '../src/features/academy/reference.ts';
import { foundations } from '../src/features/academy/foundations.ts';
import { readingFoundations } from '../src/features/academy/readingFoundations.ts';
import { readingLeases } from '../src/features/academy/readingLeases.ts';
import { readingCapitalization } from '../src/features/academy/readingCapitalization.ts';
import { readingMarketModeling } from '../src/features/academy/readingMarketModeling.ts';
import { leaseModules } from '../src/features/academy/leases.ts';
import { capitalizationModules } from '../src/features/academy/capitalization.ts';
import { marketModelingModules } from '../src/features/academy/marketModeling.ts';
import { emptyProgress } from '../src/features/academy/progress.ts';

const runtime=createRequire(import.meta.url);
const load=(name,extra={},environment={})=>loadTrustedRepositoryCommonJs(new URL(`../src/features/academy/${name}`,import.meta.url),id=>{
  if(Object.hasOwn(extra,id))return extra[id];
  if(id==='./reference')return reference;
  assert.ok(['react','react/jsx-runtime','lucide-react'].includes(id),id);
  return runtime(id);
},{environment});
const readingView=load('CourseReading.tsx');
const modules=[...foundations,...leaseModules,...capitalizationModules,...marketModelingModules];
const readings=[...readingFoundations,...readingLeases,...readingCapitalization,...readingMarketModeling];

test('all chapter views render the full reading, worked tables and checks before the exam entry',()=>{
  for(const [position,module] of modules.entries()){
    const reading=readings.find(r=>r.moduleId===module.id);
    const html=renderToStaticMarkup(React.createElement(readingView.default,{module,reading,position,isRead:false,onRead(){},onExam(){}}));
    assert.equal((html.match(/aria-label="Check your knowledge"/g)||[]).length,2);
    for(const section of reading.sections)assert.ok(html.includes(`id="${module.id}-${section.id}"`));
    assert.ok(html.indexOf(`id="${module.id}-${reading.sections[3].id}"`)<html.indexOf(`id="${module.id}-exam"`));
    assert.match(html,/Start section exam/);assert.match(html,/<table/);assert.doesNotMatch(html,/Submit section exam/);
    assert.doesNotMatch(html,/Correct answer:/);
  }
});

const children=n=>(Array.isArray(n?.props?.children)?n.props.children:[n?.props?.children]).flat(Infinity);
const walk=n=>n&&typeof n==='object'?[n,...children(n).flatMap(walk)]:[];
const text=n=>typeof n==='string'||typeof n==='number'?String(n):n&&typeof n==='object'?children(n).map(text).join(''):'';

test('exam interaction requires a complete draft, reveals feedback once, and supports retake and continuation',()=>{
  // A deterministic component-state harness, not a browser or layout test.
  const cells=[];let cursor=0,tree;const submissions=[];let finished=0;
  const react={useState(initial){const i=cursor++;if(!(i in cells))cells[i]=initial;return[cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;}];}};
  const Exam=load('SectionExam.tsx',{'react':react,'./CourseReading':readingView},{window:{scrollTo(){}}}).default;
  const questions=foundations[0].questions;
  const props={title:'Frame the valuation',questions,progress:emptyProgress(),onSubmit:value=>submissions.push(value),onBookmark(){},onReading(){},onFinish(){finished++;},finishLabel:'Next chapter'};
  const render=()=>{cursor=0;tree=Exam(props);};
  const button=label=>walk(tree).find(n=>n.type==='button'&&text(n).trim()===label);
  const submit=()=>{walk(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});render();};
  const select=(q,value)=>{walk(tree).filter(n=>n.type==='input'&&n.props.name===q.id)[value].props.onChange();render();};
  render();assert.equal(button('Submit section exam').props.disabled,true);
  submit();assert.equal(submissions.length,0);
  for(const [i,q] of questions.entries())select(q,i===0?(q.answer+1)%4:q.answer);
  assert.equal(button('Submit section exam').props.disabled,false);assert.equal(submissions.length,0);
  assert.doesNotMatch(renderToStaticMarkup(tree),/Correct answer:/);
  submit();assert.equal(submissions.length,1);assert.match(text(tree),/4 \/ 5 correct/);
  assert.match(renderToStaticMarkup(tree),/Correct answer:/);
  assert.equal(walk(tree).filter(n=>n.type==='fieldset'&&n.props.disabled).length,5);
  button('Next chapter').props.onClick();assert.equal(finished,1);
  button('Retake this set').props.onClick();render();assert.equal(button('Submit section exam').props.disabled,true);
  assert.doesNotMatch(text(tree),/THIS ATTEMPT/);
  for(const q of questions)select(q,q.answer);
  submit();assert.equal(submissions.length,2);assert.match(text(tree),/5 \/ 5 correct/);
});
