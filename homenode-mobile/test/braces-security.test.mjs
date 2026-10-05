import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const expoMetroRequire = createRequire(cliRequire.resolve('@expo/metro/package.json'));
const metroRequire = createRequire(expoMetroRequire.resolve('metro/package.json'));
const depthError = { name: 'SyntaxError', message: 'Nesting depth exceeds maximum of 100' };
const treeError = { name: 'SyntaxError', message: 'AST nodes must form a tree' };
const valueError = { name: 'TypeError', message: 'AST node values must be primitive' };
const nested = (depth, open = '{', close = '}') => open.repeat(depth) + 'x' + close.repeat(depth);

// Build independently of parse() and do not trust the caller's depth field.
function makeAst(depth) {
  const root = { type: 'root', nodes: [] };
  let parent = root;
  for (let i = 0; i < depth; i++) {
    const brace = {
      type: 'brace', open: true, close: true, commas: 0, ranges: 0, depth: 0,
      nodes: [{ type: 'open', value: '{' }], parent,
    };
    parent.nodes.push(brace);
    parent = brace;
  }
  parent.nodes.push({ type: 'text', value: 'x' });
  while (parent !== root) {
    parent.nodes.push({ type: 'close', value: '}' });
    parent = parent.parent;
  }
  return root;
}

// This function runs only in a killable subprocess, so a regression cannot
// block the test runner's event loop. It uses real installed dependency code.
function probe(bracesPath) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const braces = require(bracesPath);
  const depthError = { name: 'SyntaxError', message: 'Nesting depth exceeds maximum of 100' };
  const treeError = { name: 'SyntaxError', message: 'AST nodes must form a tree' };
  const valueError = { name: 'TypeError', message: 'AST node values must be primitive' };
  let deepArray = 'x';
  let deepObject = { toString() { return 'x'; } };
  for (let i = 0; i < 5_000; i++) {
    deepArray = [deepArray];
    deepObject = { child: deepObject, toString() { return String(this.child); } };
  }
  const functionValue = () => 'x';
  functionValue.toString = () => String(deepArray);
  const cyclicArray = [];
  cyclicArray.push(cyclicArray);
  const patterns = [
    '{'.repeat(4_500) + 'x' + '}'.repeat(4_500),
    '('.repeat(4_500) + 'x' + ')'.repeat(4_500),
    '{('.repeat(1_500) + 'x' + ')}'.repeat(1_500),
    '{'.repeat(5_000),
    '('.repeat(5_000),
  ];
  for (const input of patterns) {
    assert.ok(input.length <= 10_000);
    for (const method of ['parse', 'compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](input), depthError);
    }
    assert.throws(() => braces(input), depthError);
    assert.throws(() => braces([input]), depthError);
    assert.throws(() => braces.create(input, { expand: true }), depthError);
  }
  for (const method of ['compile', 'expand', 'stringify']) {
    const walk = require(path.join(path.dirname(bracesPath), 'lib', method));
    for (const run of [braces[method], walk]) {
      assert.throws(() => run(makeAst(5_000)), depthError);
      const dollarAst = makeAst(5_000);
      dollarAst.nodes[0].dollar = true;
      assert.throws(() => run(dollarAst), depthError);
      const cyclic = { type: 'root', nodes: [] };
      cyclic.nodes.push(cyclic);
      assert.throws(() => run(cyclic), treeError);
      // A shared-child DAG has shallow depth but exponentially many paths.
      let dag = { type: 'paren', nodes: [{ type: 'text', value: 'x' }] };
      for (let i = 0; i < 40; i++) dag = { type: 'paren', nodes: [dag, dag] };
      assert.throws(() => run({ type: 'root', nodes: [dag] }), treeError);
      for (const value of [deepArray, deepObject, functionValue, cyclicArray]) {
        // Check the leaf fast path and coercion/append under a shallow root.
        assert.throws(() => run({ type: 'text', value }), valueError);
        assert.throws(() => run({ type: 'root', nodes: [{ type: 'text', value }] }), valueError);
      }
    }
  }
  // Parent links are not recursive children, but expand follows them in loops.
  for (const run of [braces.expand, require(path.join(path.dirname(bracesPath), 'lib', 'expand'))]) {
    const cyclicParent = { type: 'paren', nodes: [] };
    cyclicParent.parent = cyclicParent;
    assert.throws(() => run({ type: 'root', nodes: [cyclicParent] }), depthError);
    let ancestor = { type: 'root', nodes: [], queue: [] };
    for (let i = 0; i < 101; i++) ancestor = { type: 'paren', parent: ancestor };
    assert.throws(() => run({ type: 'paren', nodes: [], parent: ancestor }), depthError);
  }
  process.stdout.write('bounded probes passed');
}

for (const fileMap of ['@expo/metro-file-map', 'metro-file-map']) {
  const owner = fileMap === 'metro-file-map' ? metroRequire : cliRequire;
  const fileMapRequire = createRequire(owner.resolve(`${fileMap}/package.json`));
  const micromatchRequire = createRequire(fileMapRequire.resolve('micromatch/package.json'));
  const bracesPath = micromatchRequire.resolve('braces');
  const braces = micromatchRequire('braces');
  const micromatch = fileMapRequire('micromatch');

  test(`${fileMap} keeps the real braces version and normal glob semantics`, () => {
    assert.equal(micromatchRequire('braces/package.json').version, '3.0.3');
    const cases = [
      ['src/{a,b}/file.{js,ts}', 'src/(a|b)/file.(js|ts)',
        ['src/a/file.js', 'src/a/file.ts', 'src/b/file.js', 'src/b/file.ts']],
      ['{a,{b,c}}', '(a|(b|c))', ['a', 'b', 'c']],
      ['{1..5..2}', '(1|3|5)', ['1', '3', '5']],
      ['file{01..03}.txt', 'file(0[1-3]).txt', ['file01.txt', 'file02.txt', 'file03.txt']],
      ['{a..c}', '([a-c])', ['a', 'b', 'c']],
      ['(a|b)/{x,y}', '(a|b)/(x|y)', ['(a|b)/x', '(a|b)/y']],
      ['{a,b', '{a,b', ['{a,b']],
      ['${a,b}', '${a,b}', ['${a,b}']],
    ];
    for (const [input, compiled, expanded] of cases) {
      assert.equal(braces.compile(input), compiled);
      assert.equal(braces.stringify(input), input);
      assert.deepEqual(braces.expand(input), expanded);
      assert.equal(braces.compile(braces.parse(input)), compiled);
      assert.equal(braces.stringify(braces.parse(input)), input);
      assert.deepEqual(braces.expand(braces.parse(input)), expanded);
    }
    assert.deepEqual(braces('{a,,a}', { expand: true, nodupes: true, noempty: true }), ['a']);
    assert.deepEqual(micromatch(['src/a.ts', 'src/b.js', 'src/c.css'], ['src/*.{js,ts}']),
      ['src/a.ts', 'src/b.js']);
    assert.equal(micromatch.some(['src/a.ts'], ['src/{a,b}.{js,ts}']), true);
    assert.equal(micromatch.some(['src/c.css'], ['src/{a,b}.{js,ts}']), false);
    assert.throws(() => braces.expand('{1..1001}'), /range limit/);
    assert.equal(braces.expand('{1..1001}', { rangeLimit: false }).length, 1_001);
    assert.throws(() => braces.parse('x'.repeat(10_001)), /max characters/);
  });

  test(`${fileMap} accepts depth 100 and rejects depth 101 for all input paths`, () => {
    for (const [open, close, atLimit, overLimit] of [
      ['{', '}', 100, 101], ['(', ')', 100, 101], ['{(', ')}', 50, 51],
    ]) {
      const valid = nested(atLimit, open, close);
      const invalid = nested(overLimit, open, close);
      assert.doesNotThrow(() => braces.parse(valid));
      assert.equal(braces.compile(valid), valid);
      assert.equal(braces.stringify(valid), valid);
      assert.deepEqual(braces.expand(valid), [valid]);
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](invalid), depthError);
      }
    }
    assert.equal(braces.compile(makeAst(100)), nested(100));
    assert.equal(braces.stringify(makeAst(100)), nested(100));
    assert.deepEqual(braces.expand(makeAst(100)), [nested(100)]);
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](makeAst(101)), depthError);
    }
    // Closing a group releases nesting budget; this is not a token-count cap.
    const siblings = '{x}'.repeat(150);
    assert.equal(braces.compile(siblings), siblings);
    assert.deepEqual(braces.expand(siblings), [siblings]);
  });

  test(`${fileMap} does not count escaped, quoted, or bracketed delimiters`, () => {
    const literal = nested(150, '{(', ')}');
    const escaped = String.raw`\{\(\)\}`.repeat(150);
    const cases = [[escaped, '{()}'.repeat(150)], [`[${literal}]`, `[${literal}]`]];
    for (const quote of ['"', "'", '`']) cases.push([quote + literal + quote, literal]);
    for (const [input, expected] of cases) {
      assert.equal(braces.compile(input), expected);
      assert.equal(braces.stringify(input), expected);
      assert.deepEqual(braces.expand(input), [expected]);
    }
    assert.equal(braces.compile(escaped, { keepEscaping: true }), escaped);
    const quoted = '"' + literal + '"';
    assert.equal(braces.stringify(quoted, { keepQuotes: true }), quoted);
    // An escaped backslash must not hide the following real opening brace.
    assert.throws(() => braces.parse(String.raw`\\` + nested(101)), depthError);
  });

  test(`${fileMap} caller options cannot disable the depth limit`, () => {
    for (const maxDepth of [false, Infinity, NaN, 1_000_000, -1, undefined]) {
      const options = { maxDepth, maxLength: Infinity, rangeLimit: false };
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](nested(101), options), depthError);
      }
      for (const method of ['compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](makeAst(101), options), depthError);
      }
    }
  });

  test(`${fileMap} rejects reused containers but allows shared text leaves`, () => {
    for (const method of ['compile', 'expand', 'stringify']) {
      const container = { type: 'paren', nodes: [{ type: 'text', value: 'x' }] };
      assert.throws(() => braces[method]({ type: 'root', nodes: [container, container] }), treeError);
      const leaf = { type: 'text', value: 'x' };
      const output = braces[method]({ type: 'root', nodes: [leaf, leaf] });
      assert.deepEqual(output, method === 'expand' ? ['xx'] : 'xx');
    }
  });

  test(`${fileMap} preserves primitive AST values and existing coercion behavior`, () => {
    const cases = [
      ['text', 'text'], ['', ''], [17, '17'], [0, ''], [true, 'true'], [false, ''],
      [null, ''], [undefined, ''], [NaN, ''], [Infinity, 'Infinity'], [1n, '1'], [0n, ''],
    ];
    for (const [value, expected] of cases) {
      const ast = () => ({ type: 'root', nodes: [{ type: 'text', value }] });
      assert.equal(braces.compile(ast()), expected);
      assert.equal(braces.stringify(ast()), expected);
      assert.deepEqual(braces.expand(ast()), expected === '' ? [] : [expected]);
      // Standalone compile/stringify leaves return truthy primitives directly.
      for (const method of ['compile', 'stringify']) {
        assert.equal(braces[method]({ type: 'text', value }), value || '');
      }
    }
    const symbol = Symbol('text');
    for (const method of ['compile', 'stringify']) {
      assert.equal(braces[method]({ type: 'text', value: symbol }), symbol);
    }
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method]({ type: 'root', nodes: [{ type: 'text', value: symbol }] }),
        { name: 'TypeError', message: 'Cannot convert a Symbol value to a string' });
    }
  });

  test(`${fileMap} rejects object and function values before coercion, including leaves`, () => {
    let coercions = 0;
    const customValue = {
      toString() { coercions++; return 'text'; },
      valueOf() { coercions++; return 'text'; },
      [Symbol.toPrimitive]() { coercions++; return 'text'; },
    };
    const functionValue = () => 'text';
    functionValue.toString = () => { coercions++; return 'text'; };
    for (const method of ['compile', 'expand', 'stringify']) {
      for (const value of [[], ['text'], {}, Object.create(null), new String('text'), customValue, functionValue]) {
        const inputs = [
          { type: 'text', value },
          { type: 'root', value, nodes: [] },
          { type: 'root', nodes: [{ type: 'text', value }] },
        ];
        for (const input of inputs) assert.throws(() => braces[method](input), valueError);
      }
    }
    assert.equal(coercions, 0);
  });

  test(`${fileMap} malicious inputs terminate within a bounded subprocess`, () => {
    const source = `const makeAst = ${makeAst.toString()}; (${probe.toString()})(${JSON.stringify(bracesPath)});`;
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', source], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined, `subprocess failed or timed out: ${result.error}`);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'bounded probes passed');
  });
}
