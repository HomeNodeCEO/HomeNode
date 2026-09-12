import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript'), jsx = require('react/jsx-runtime');
const source = readFileSync(new URL('../src/components/ReportTypeChooser.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const children = n => [n?.props?.children].flat(Infinity);
const walk = n => n && typeof n === 'object' ? [n, ...children(n).flatMap(walk)] : [];
const text = n => typeof n === 'string' ? n : children(n).map(v => v && typeof v === 'object' ? text(v) : v ?? '').join('');
const same = (a,b) => a?.length === b.length && b.every((v,i) => Object.is(v,a[i]));

// Deterministic hook/element harness, not a replacement for live browser QA.
function harness() {
  const cells = [], calls = [], effects = [], destinations = [];
  let cursor = 0, tree, rejectCreate = false;
  const state = initial => {
    const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next; }];
  };
  const react = { useState: state, useRef(value) { const i=cursor++; return cells[i] ??= {current:value}; },
    useMemo(make,deps) { const i=cursor++; if (!cells[i] || !same(cells[i].deps,deps)) cells[i]={deps,value:make()}; return cells[i].value; },
    useEffect(setup,deps) { const i=cursor++; if (!cells[i] || !same(cells[i].deps,deps)) {
      const old=cells[i]; cells[i]={deps}; effects.push(()=>{old?.cleanup?.(); cells[i].cleanup=setup();});
    } } };
  const auth = { session: { organizations: [{ organization_id:'synthetic-org', display_name:'Synthetic',
    permissions:{custom_appraisal:{write:true},uad_3_6:{write:true},property_tax_protest:{write:true}} }] } };
  const imports = {react, 'react/jsx-runtime':jsx,
    '@/features/auth/ApplicationAuth':{useApplicationAuth:()=>auth},
    '@/lib/api':{getCanonicalReportFiles:async()=>({files:[]}), createCanonicalReportFile:async(account,input)=>{
      calls.push({account,input}); if(rejectCreate) throw Error('synthetic uncertain response');
      return {report_file:{target_id:'test-target'}};
    }}, '@/lib/reportDestinations':{reportDestination:()=>'/synthetic-report'}};
  const module={exports:{}};
  new Script(`(function(require,module,exports,window,crypto){${compiled}\n})`).runInThisContext()(key=>{
    assert.ok(Object.hasOwn(imports,key),key); return imports[key];
  },module,module.exports,{addEventListener(){},removeEventListener(){},location:{assign:v=>destinations.push(v)}},{randomUUID});
  const props={subject:{accountId:'SYNTHETIC',address:'100 Test St'},onClose(){}};
  const render=()=>{cursor=0;tree=module.exports.default(props); for(const effect of effects.splice(0)) effect();};
  const flush=async()=>{for(let i=0;i<8;i++){render();await Promise.resolve();}};
  const button=label=>walk(tree).find(n=>n.type==='button' && text(n)===label);
  const choose=async label=>{await flush(); const b=walk(tree).find(n=>n.type==='button' && text(n).startsWith(label)); b.props.onClick();await flush();};
  return {calls,destinations,flush,choose,button,
    get date(){return walk(tree).find(n=>n.type==='input'&&n.props.type==='date');},
    fail(value){rejectCreate=value;}};
}

test('Custom chooser requires an explicit effective date and sends it without assuming today',async()=>{
  const h=harness();await h.choose('Custom Appraisal');
  assert.equal(h.date.props.value,'');assert.equal(h.button('Start New Assignment').props.disabled,true);
  h.date.props.onChange({target:{value:'2024-02-29'}});await h.flush();
  assert.equal(h.button('Start New Assignment').props.disabled,false);
  h.button('Start New Assignment').props.onClick();await h.flush();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].input.effective_date,'2024-02-29');
  assert.deepEqual(h.destinations,['/synthetic-report']);
});

test('an uncertain creation retry retains its ID; changed date is a different intent',async()=>{
  const h=harness();await h.choose('Custom Appraisal');h.fail(true);
  h.date.props.onChange({target:{value:'2026-09-12'}});await h.flush();
  for(let i=0;i<2;i++){h.button('Start New Assignment').props.onClick();await h.flush();}
  assert.equal(h.calls[0].input.client_request_id,h.calls[1].input.client_request_id);
  h.date.props.onChange({target:{value:'2026-09-11'}});await h.flush();
  h.button('Start New Assignment').props.onClick();await h.flush();
  assert.notEqual(h.calls[2].input.client_request_id,h.calls[0].input.client_request_id);
});

test('UAD and Property Tax creation do not acquire Custom date requirements',async()=>{
  for(const label of ['UAD 3.6','Property Tax Protest']){
    const h=harness();await h.choose(label);assert.equal(h.date,undefined);
    assert.equal(h.button('Start New Assignment').props.disabled,false);
    h.button('Start New Assignment').props.onClick();await h.flush();
    assert.equal(Object.hasOwn(h.calls[0].input,'effective_date'),false);
  }
});
