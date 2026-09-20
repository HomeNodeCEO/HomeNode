import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { executeTrustedRepositoryExpression, executeTrustedRepositoryStatements,
  loadTrustedRepositoryCommonJs,
  readTrustedRepositoryTypeScript } from './trustedRepositoryModuleHarness.mjs';

const { ast } = readTrustedRepositoryTypeScript(
  new URL('../src/lib/customAssignmentNavigation.ts', import.meta.url));
const initializers = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'CUSTOM_ASSIGNMENT_REQUEST_ERROR') {
    initializers.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(initializers.length, 1);
const trustedInitializer = initializers[0];
const hookSource = new URL('../src/hooks/useAssignmentConflictKeys.ts', import.meta.url);
const { ast: hookAst } = readTrustedRepositoryTypeScript(hookSource);
const hookFunctions = [];
function findHook(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'useAssignmentConflictKeys') hookFunctions.push(node);
  ts.forEachChild(node, findHook);
}
findHook(hookAst);
assert.equal(hookFunctions.length, 1);
const hookStatements = [...hookFunctions[0].body.statements].slice(0, -1);

test('trusted expression execution requires a node from a verified repository source', () => {
  assert.equal(executeTrustedRepositoryExpression(trustedInitializer, {}),
    'This appraisal file is unavailable or its link is invalid. Choose an existing file or start a new assignment.');
  const counterfeit = ts.createSourceFile('counterfeit.ts', `'counterfeit'`, ts.ScriptTarget.Latest, true);
  assert.throws(() => executeTrustedRepositoryExpression(counterfeit.statements[0].expression, {}),
    /invalid_trusted_repository_module:expression_source/);
  const forged = { getSourceFile: () => ast, getText: () => `'forged'` };
  assert.throws(() => executeTrustedRepositoryExpression(forged, {}),
    /invalid_trusted_repository_module:expression_source/);
});

test('trusted expression execution rejects inherited and accessor environments', () => {
  assert.throws(() => executeTrustedRepositoryExpression(trustedInitializer, Object.create(null)),
    /invalid_trusted_repository_module:environment/);
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'untrusted' });
  assert.throws(() => executeTrustedRepositoryExpression(trustedInitializer, accessor),
    /invalid_trusted_repository_module:environment/);
});

test('trusted statement execution accepts only registered ordered statements and named results', () => {
  const result = executeTrustedRepositoryStatements(hookStatements, {
    useState: initial => [initial, () => {}],
    useRef: current => ({ current }),
    useCallback: callback => callback,
  }, ['keys', 'setKeys', 'keysRef']);
  assert.deepEqual(result.keys, []);
  assert.equal(typeof result.setKeys, 'function');
  assert.deepEqual(result.keysRef, { current: [] });
  assert.throws(() => executeTrustedRepositoryStatements([...hookStatements].reverse(), {}, []),
    /invalid_trusted_repository_module:statement_order/);
  const counterfeit = ts.createSourceFile('counterfeit.ts', 'const injected = true;', ts.ScriptTarget.Latest, true);
  assert.throws(() => executeTrustedRepositoryStatements([counterfeit.statements[0]], {}, ['injected']),
    /invalid_trusted_repository_module:statement_source/);
  assert.throws(() => executeTrustedRepositoryStatements(hookStatements, {}, ['value; process.exit()']),
    /invalid_trusted_repository_module:result_names/);
});

test('trusted module loading rejects injected options and unexpected base URL replacement', () => {
  const react = { useState: initial => [initial, () => {}], useRef: current => ({ current }), useCallback: value => value };
  assert.equal(typeof loadTrustedRepositoryCommonJs(hookSource, name => {
    assert.equal(name, 'react');
    return react;
  }).useAssignmentConflictKeys, 'function');
  const accessor = {};
  Object.defineProperty(accessor, 'environment', { enumerable: true, get: () => ({}) });
  assert.throws(() => loadTrustedRepositoryCommonJs(hookSource, () => react, accessor),
    /invalid_trusted_repository_module:options/);
  assert.throws(() => loadTrustedRepositoryCommonJs(hookSource, () => react, { baseUrl: '/base/' }),
    /invalid_trusted_repository_module:base_url_marker/);
});

test('trusted source loading refuses files outside the frontend source root', () => {
  assert.throws(() => readTrustedRepositoryTypeScript(import.meta.url),
    /invalid_trusted_repository_module:source_url/);
  assert.throws(() => readTrustedRepositoryTypeScript(new URL(import.meta.url)),
    /invalid_trusted_repository_module:source_path/);
});
