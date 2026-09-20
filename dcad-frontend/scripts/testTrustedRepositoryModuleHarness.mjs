import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { executeTrustedRepositoryExpression,
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

test('trusted expression execution requires a node from a verified repository source', () => {
  assert.equal(executeTrustedRepositoryExpression(trustedInitializer, {}),
    'This appraisal file is unavailable or its link is invalid. Choose an existing file or start a new assignment.');
  const counterfeit = ts.createSourceFile('counterfeit.ts', `'counterfeit'`, ts.ScriptTarget.Latest, true);
  assert.throws(() => executeTrustedRepositoryExpression(counterfeit.statements[0].expression, {}),
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

test('trusted source loading refuses files outside the frontend source root', () => {
  assert.throws(() => readTrustedRepositoryTypeScript(import.meta.url),
    /invalid_trusted_repository_module:source_url/);
  assert.throws(() => readTrustedRepositoryTypeScript(new URL(import.meta.url)),
    /invalid_trusted_repository_module:source_path/);
});
