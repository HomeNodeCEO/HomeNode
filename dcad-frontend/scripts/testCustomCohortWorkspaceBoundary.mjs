import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
function component(name) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/components/${name}.tsx`, import.meta.url));
  const source = readFileSync(file, 'utf8'), code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  // Only the public keyed wrapper executes. Child effects/transport are not run.
  new Script(`(function(require,module,exports){${code}\n})`, { filename: file }).runInThisContext()(id =>
    id === 'react/jsx-runtime' ? requireRuntime(id) : {}, module, module.exports);
  return { Component: module.exports.default, source };
}
const contextRef = { context_id: 'same-context', context_revision: '1', context_sha256: 'same-hash' };
const props = () => ({ enabled: true, sessionKey: 'session', accountId: 'A', assignmentFileId: '17', contextRef,
  pocketId: 'alpha', input: { accountId: 'A', assignmentFileId: '17', contextRef } });
for (const name of ['CustomCohortWorkspace', 'CustomCohortPocketInspector']) {
  const { Component, source } = component(name);
  test(`${name} retains its session and selections for equivalent context objects`, () => {
    const p = props(), reordered = { context_sha256: contextRef.context_sha256,
      context_revision: contextRef.context_revision, context_id: contextRef.context_id };
    const q = { ...p, contextRef: reordered, input: { ...p.input, contextRef: reordered } };
    assert.equal(Component(p).key, Component(q).key);
  });
  test(`${name} clears identity for changed account, file, or context scalars`, () => {
    const p = props();
    for (const [field, changed] of [['accountId', 'B'], ['assignmentFileId', '18']]) {
      assert.notEqual(Component(p).key, Component({ ...p, [field]: changed, input: { ...p.input, [field]: changed } }).key);
    }
    for (const field of ['context_id', 'context_revision', 'context_sha256']) {
      const nextRef = { ...contextRef, [field]: 'changed' };
      assert.notEqual(Component(p).key, Component({ ...p, contextRef: nextRef, input: { ...p.input, contextRef: nextRef } }).key);
    }
    const field = name === 'CustomCohortWorkspace' ? 'sessionKey' : 'pocketId';
    assert.notEqual(Component(p).key, Component({ ...p, [field]: 'different' }).key);
  });
  test(`${name} structurally hides its complete observation surface for print`, () => {
    const rootSection = source.match(/return <section\b[^>]+>/)?.[0];
    assert.match(rootSection, /className="[^"]*print:hidden/);
  });
}
test('disabled exploration does not mount request ownership', () => {
  const { Component } = component('CustomCohortWorkspace'); assert.equal(Component({ ...props(), enabled: false }), null);
});
