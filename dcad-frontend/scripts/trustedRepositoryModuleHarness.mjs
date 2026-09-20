import { mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const requireFromHarness = createRequire(import.meta.url);
const factories = new Map();
const trustedSourceFiles = new WeakSet();
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FACTORIES = 256;
const SOURCE_ROOT = realpathSync(fileURLToPath(new URL('../src/', import.meta.url)));

function invalid(reason) {
  throw new TypeError(`invalid_trusted_repository_module:${reason}`);
}

function sourceText(value) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) invalid('source');
  return value;
}

function trustedPath(url) {
  if (!(url instanceof URL) || url.protocol !== 'file:') invalid('source_url');
  const path = realpathSync(fileURLToPath(url));
  const withinRoot = relative(SOURCE_ROOT, path);
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)
    || withinRoot.includes(`${sep}..${sep}`) || !['.ts', '.tsx'].includes(extname(path).toLowerCase())) {
    invalid('source_path');
  }
  return { path, withinRoot };
}

export function readTrustedRepositoryTypeScript(url) {
  const { path, withinRoot } = trustedPath(url);
  const text = sourceText(readFileSync(path, 'utf8'));
  const kind = extname(path).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const ast = ts.createSourceFile(withinRoot, text, ts.ScriptTarget.Latest, true, kind);
  trustedSourceFiles.add(ast);
  return Object.freeze({ text, ast });
}

function environmentKeys(environment) {
  if (!environment || Object.getPrototypeOf(environment) !== Object.prototype) invalid('environment');
  const descriptors = Object.getOwnPropertyDescriptors(environment);
  const keys = Object.keys(descriptors);
  if (keys.length > 128 || keys.some(key => !IDENTIFIER.test(key)
    || !Object.hasOwn(descriptors[key], 'value'))) invalid('environment');
  return keys;
}

function loadFactory(javascript) {
  const cached = factories.get(javascript);
  if (cached) return cached;
  if (factories.size >= MAX_FACTORIES) invalid('capacity');
  const directory = mkdtempSync(join(tmpdir(), 'homenode-test-module-'));
  const file = join(directory, 'trusted.cjs');
  try {
    writeFileSync(file, javascript, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const resolved = requireFromHarness.resolve(file);
    const factory = requireFromHarness(resolved);
    delete requireFromHarness.cache[resolved];
    if (typeof factory !== 'function') invalid('factory');
    factories.set(javascript, factory);
    return factory;
  } finally {
    rmSync(file, { force: true });
    rmdirSync(directory);
  }
}

/**
 * Executes a TypeScript AST node taken from a verified, checked-in source file.
 * The node is compiled into a temporary CommonJS module and loaded through
 * Node's ordinary, file-backed module loader.
 */
export function executeTrustedRepositoryExpression(node, environment) {
  const ast = node?.getSourceFile?.();
  if (!ast || !trustedSourceFiles.has(ast)) invalid('expression_source');
  const trustedExpression = sourceText(node.getText(ast));
  const keys = environmentKeys(environment);
  const wrapped = `'use strict';\nmodule.exports = function execute(environment) {\n`
    + `  const { ${keys.join(', ')} } = environment;\n  return (${trustedExpression});\n};\n`;
  const compiled = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) invalid('syntax');
  return loadFactory(compiled.outputText)(environment);
}

/**
 * Loads already-transpiled CommonJS originating from a fixed repository file
 * with an explicit dependency resolver. This preserves the existing isolated,
 * file-backed hook harness.
 */
export function loadTrustedRepositoryCommonJs(url, dependencyResolver) {
  const { path } = trustedPath(url);
  const trustedCode = sourceText(readFileSync(path, 'utf8'));
  if (typeof dependencyResolver !== 'function') invalid('dependency_resolver');
  const compiled = ts.transpileModule(trustedCode, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) invalid('syntax');
  const wrapped = `'use strict';\nmodule.exports = function load(injectedRequire) {\n`
    + `  const target = { exports: {} };\n`
    + `  (function(require, module, exports) {\n${compiled.outputText}\n  })(injectedRequire, target, target.exports);\n`
    + `  return target.exports;\n};\n`;
  return loadFactory(wrapped)(dependencyResolver);
}
