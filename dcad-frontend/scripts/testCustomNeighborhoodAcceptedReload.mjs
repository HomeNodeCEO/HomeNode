import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url), ts = require('typescript');
const path = new URL('../src/features/neighborhood/useCustomNeighborhoodAcceptedReload.ts', import.meta.url);
const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function harness({ workfile, accepted } = {}) {
  const cells = [], calls = [], results = [], cleanup = [];
  let cursor = 0;
  const imports = {
    react: { useCallback: value => value, useRef: initial => { const i = cursor++; cells[i] ??= { current: initial }; return cells[i]; },
      useEffect: setup => { const i = cursor++; if (!cells[i]) { cells[i] = {}; cleanup.push(setup()); } } },
    '@/lib/appraisalFileRequests': { loadCustomAppraisalWorkfile: async (...args) => {
      calls.push(['workfile', ...args]); return workfile ? workfile() : { ok: true, workfile: { sections: { neighborhood_assessment: { revision: 1 } } } };
    } },
    './loadCustomNeighborhoodAccepted': { loadCustomNeighborhoodAccepted: async (...args) => {
      calls.push(['accepted', ...args]); return accepted ? accepted() : { status: 'accepted', accountId: args[0], assignmentFileId: args[1] };
    } },
  };
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${output}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), key); return imports[key];
  }, module, module.exports);
  const file = { current: { id: 41 } }, generation = { current: 1 }, readGeneration = { current: 0 };
  return { file, generation, readGeneration, calls, results,
    render(account = 'SUBJECT') { cursor = 0; return module.exports.useCustomNeighborhoodAcceptedReload(account, file, generation, value => results.push(value), readGeneration); },
    unmount() { cleanup.forEach(fn => fn?.()); },
  };
}

test('accepted refetch reads the saved section then matches the complete server group without rehydrating other drafts', async () => {
  const h = harness(), reload = h.render(); assert.equal(h.calls.length, 0);
  assert.equal(await reload(), true); assert.deepEqual(h.results.map(value => value.status), ['loading', 'accepted']);
  assert.deepEqual(h.calls, [['workfile', 'SUBJECT', 41], ['accepted', 'SUBJECT', 41, { revision: 1 }]]); h.unmount();
});
for (const change of ['file', 'generation', 'account', 'unmount']) {
  test(`${change} during workfile refetch never loads/applies the previous accepted group`, async () => {
    const wait = deferred(), h = harness({ workfile: () => wait.promise }), reload = h.render(), pending = reload();
    if (change === 'file') h.file.current = { id: 42 };
    if (change === 'generation') h.generation.current++;
    if (change === 'account') h.render('OTHER');
    if (change === 'unmount') h.unmount();
    wait.resolve({ ok: true, workfile: { sections: {} } });
    assert.equal(await pending, false); assert.equal(h.calls.length, 1);
    assert.deepEqual(h.results.map(value => value.status), ['loading']); h.unmount();
  });
}
test('switch during accepted response cannot update the newly selected file', async () => {
  const wait = deferred(), h = harness({ accepted: () => wait.promise }), pending = h.render()();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(h.calls.length, 2); h.file.current = { id: 42 };
  wait.resolve({ status: 'accepted' }); assert.equal(await pending, false);
  assert.deepEqual(h.results.map(value => value.status), ['loading']); h.unmount();
});
for (const status of ['unavailable', 'loading', 'legacy', 'signed']) {
  test(`${status} response cannot leave a stale report or enable legacy fallback after acknowledged Apply`, async () => {
    const h = harness({ accepted: async () => ({ status }) }); assert.equal(await h.render()(), false);
    assert.deepEqual(h.results.map(value => value.status), ['loading', 'unavailable']);
    assert.ok(h.results.every(value => value.assessment === null)); h.unmount();
  });
}
test('missing target and transport failure do not report a successful refresh', async () => {
  const h = harness({ workfile: async () => { throw new Error('synthetic'); } });
  assert.equal(await h.render()(), false); h.file.current = null; assert.equal(await h.render()(), false);
  assert.deepEqual(h.results.map(value => value.status), ['loading', 'unavailable']);
  assert.equal(h.calls.length, 1); h.unmount();
});

test('fresh accepted reload invalidates an older initial same-file accepted read', async () => {
  const h = harness(), initialRead = ++h.readGeneration.current;
  assert.equal(await h.render()(), true);
  assert.notEqual(h.readGeneration.current, initialRead);
  const report = readFileSync(new URL('../src/pages/PropertyReport.tsx', import.meta.url), 'utf8');
  assert.match(report, /const acceptedRead = \+\+acceptedReadGeneration.current/);
  assert.match(report, /if \(!isCancelled\(\) && acceptedReadGeneration.current === acceptedRead\) setAcceptedNeighborhood\(restored\)/);
  assert.match(report, /setAcceptedNeighborhood, acceptedReadGeneration\)/);
  h.unmount();
});

test('a newer accepted reload wins even when the older same-file response arrives last', async () => {
  const first = deferred(); let read = 0;
  const h = harness({ accepted: () => ++read === 1 ? first.promise : { status: 'accepted', marker: 'newer' } });
  const reload = h.render(), older = reload();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(await reload(), true);
  first.resolve({ status: 'accepted', marker: 'older' });
  assert.equal(await older, false);
  assert.deepEqual(h.results.map(value => value.status), ['loading', 'loading', 'accepted']);
  assert.equal(h.results.at(-1).marker, 'newer'); h.unmount();
});

test('a newer initial read invalidates an in-flight reload without clearing the newer report', async () => {
  const wait = deferred(), h = harness({ workfile: () => wait.promise }), pending = h.render()();
  h.readGeneration.current++;
  wait.resolve({ ok: true, workfile: { sections: {} } });
  assert.equal(await pending, false);
  assert.deepEqual(h.results.map(value => value.status), ['loading']);
  assert.equal(h.calls.length, 1); h.unmount();
});
