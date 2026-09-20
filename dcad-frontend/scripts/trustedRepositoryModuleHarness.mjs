import { mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const requireFromHarness = createRequire(import.meta.url);
const factories = new Map();
const trustedNodes = new WeakMap();
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_FACTORIES = 256;
const MAX_STATEMENTS = 512;
const MAX_RESULTS = 128;
const SOURCE_ROOT = realpathSync(fileURLToPath(new URL('../src/', import.meta.url)));
const COMMONJS_GLOBALS = new Set(['require', 'module', 'exports', '__filename', '__dirname']);

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
  if (!withinRoot || isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)
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
  function register(node) {
    trustedNodes.set(node, Object.freeze({ source: text, start: node.getStart(ast), end: node.end }));
    ts.forEachChild(node, register);
  }
  register(ast);
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
  const trusted = node && typeof node === 'object' ? trustedNodes.get(node) : undefined;
  if (!trusted) invalid('expression_source');
  const trustedExpression = sourceText(trusted.source.slice(trusted.start, trusted.end));
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
 * Executes an ordered set of statement nodes from one verified repository
 * source file and returns only explicitly named local values. Callers cannot
 * contribute executable text; both statements and returned names are checked.
 */
export function executeTrustedRepositoryStatements(nodes, environment, resultNames) {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_STATEMENTS) invalid('statements');
  const trusted = nodes.map(node => node && typeof node === 'object' ? trustedNodes.get(node) : undefined);
  if (trusted.some(record => !record) || trusted.some(record => record.source !== trusted[0].source)) {
    invalid('statement_source');
  }
  for (let index = 1; index < trusted.length; index += 1) {
    if (trusted[index - 1].end > trusted[index].start) invalid('statement_order');
  }
  if (!Array.isArray(resultNames) || resultNames.length > MAX_RESULTS
    || new Set(resultNames).size !== resultNames.length
    || resultNames.some(name => typeof name !== 'string' || !IDENTIFIER.test(name))) {
    invalid('result_names');
  }
  const keys = environmentKeys(environment);
  const statements = trusted.map(record => record.source.slice(record.start, record.end)).join('\n');
  sourceText(statements);
  const wrapped = `'use strict';\nmodule.exports = function execute(environment) {\n`
    + `  const { ${keys.join(', ')} } = environment;\n${statements}\n`
    + `  return { ${resultNames.join(', ')} };\n};\n`;
  const compiled = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) invalid('syntax');
  return loadFactory(compiled.outputText)(environment);
}

/**
 * Loads one named function declaration from a verified repository source file.
 * Export modifiers are removed by the TypeScript AST printer; callers can only
 * inject plain, explicitly named dependency values into the function closure.
 */
export function executeTrustedRepositoryFunctionDeclaration(node, environment) {
  const trusted = node && typeof node === 'object' ? trustedNodes.get(node) : undefined;
  if (!trusted || !ts.isFunctionDeclaration(node)) invalid('function_source');
  const registeredText = sourceText(trusted.source.slice(trusted.start, trusted.end));
  const parsed = ts.createSourceFile(
    'trusted-function.ts',
    registeredText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const registered = parsed.statements.length === 1 ? parsed.statements[0] : undefined;
  if (parsed.parseDiagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)
    || !registered || !ts.isFunctionDeclaration(registered) || !registered.name || !registered.body
    || registered.modifiers?.some(modifier => ![
      ts.SyntaxKind.ExportKeyword,
      ts.SyntaxKind.AsyncKeyword,
    ].includes(modifier.kind))) {
    invalid('function_source');
  }
  let commonJsReference = false;
  function inspect(current) {
    if (ts.isIdentifier(current) && COMMONJS_GLOBALS.has(current.text)) commonJsReference = true;
    ts.forEachChild(current, inspect);
  }
  inspect(registered);
  if (commonJsReference) invalid('commonjs_global');
  const name = registered.name.text;
  if (!IDENTIFIER.test(name)) invalid('function_name');
  const declaration = ts.factory.updateFunctionDeclaration(
    registered,
    registered.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
    registered.asteriskToken,
    registered.name,
    registered.typeParameters,
    registered.parameters,
    registered.type,
    registered.body,
  );
  const text = sourceText(ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, parsed));
  const keys = environmentKeys(environment);
  if (keys.some(key => COMMONJS_GLOBALS.has(key) || key === 'environment' || key === name)) {
    invalid('environment');
  }
  const wrapped = `'use strict';\nmodule.exports = function execute(environment) {\n`
    + `  const { ${keys.join(', ')} } = environment;\n${text}\n  return ${name};\n};\n`;
  const compiled = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) invalid('syntax');
  const result = loadFactory(compiled.outputText)(environment);
  if (typeof result !== 'function') invalid('function_result');
  return result;
}

/**
 * Loads already-transpiled CommonJS originating from a fixed repository file
 * with an explicit dependency resolver. This preserves the existing isolated,
 * file-backed hook harness.
 */
export function loadTrustedRepositoryCommonJs(url, dependencyResolver, options = {}) {
  const { path } = trustedPath(url);
  let trustedCode = sourceText(readFileSync(path, 'utf8'));
  if (typeof dependencyResolver !== 'function') invalid('dependency_resolver');
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) invalid('options');
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  if (Object.values(optionDescriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))
    || Object.keys(optionDescriptors).some(key => !['environment', 'baseUrl'].includes(key))) invalid('options');
  const environment = options.environment ?? {};
  const keys = environmentKeys(environment);
  if (options.baseUrl !== undefined) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0 || options.baseUrl.length > 256
      || !options.baseUrl.startsWith('/') || options.baseUrl.includes('\\')) invalid('base_url');
    const marker = 'import.meta.env.BASE_URL';
    if (!trustedCode.includes(marker)) invalid('base_url_marker');
    trustedCode = trustedCode.split(marker).join(JSON.stringify(options.baseUrl));
  }
  const compiled = ts.transpileModule(trustedCode, {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  });
  if (compiled.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) invalid('syntax');
  const wrapped = `'use strict';\nmodule.exports = function load(injectedRequire, environment) {\n`
    + `  const { ${keys.join(', ')} } = environment;\n`
    + `  const target = { exports: {} };\n`
    + `  (function(require, module, exports) {\n${compiled.outputText}\n  })(injectedRequire, target, target.exports);\n`
    + `  return target.exports;\n};\n`;
  return loadFactory(wrapped)(dependencyResolver, environment);
}
