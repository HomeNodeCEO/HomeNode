import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as navigation from '../src/lib/customAssignmentNavigation.ts';
import { selectAssignmentFile } from '../src/lib/assignmentFileSelection.ts';
import { reportDestination } from '../src/lib/reportDestinations.ts';

const { parseCustomAssignmentFileId: parse, customAssignmentHref: href,
  customAssignmentFileMatches: matches, selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR } = navigation;
const ACCOUNT = 'ACCOUNT A';
const older = Object.freeze({ id: 8, account_id: ACCOUNT, file_number: 'QA-8', workfile: { status: 'draft' } });
const newer = Object.freeze({ id: 9, account_id: ACCOUNT, file_number: 'QA-9', workfile: { status: 'draft' } });
const response = () => ({ account_id: ACCOUNT, files: [older, newer], latest_file: newer });
const paths = ['/report', '/ComparableSalesAnalysis', '/AppraisalReport', '/CostApproach', '/IncomeApproach', '/FinalReconciliation'];
const expectedHref = (path, id) => path === '/report' ? `/report/ACCOUNT%20A?assignmentFileId=${id}`
  : `${path}?propertyId=ACCOUNT%20A&assignmentFileId=${id}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

for (const [search, expected] of [
  ['', undefined], ['?propertyId=ACCOUNT', undefined], ['?assignmentFileId=8', 8],
  ['?x=1&assignmentFileId=9&y=2', 9], ['?assignmentFileId=9007199254740991', Number.MAX_SAFE_INTEGER],
  ['?assignmentFileId', null], ['?assignmentFileId=', null], ['?assignmentFileId=0', null],
  ['?assignmentFileId=-8', null], ['?assignmentFileId=08', null], ['?assignmentFileId=8.0', null],
  ['?assignmentFileId=8e0', null], ['?assignmentFileId=0x8', null], ['?assignmentFileId=%2B8', null],
  ['?assignmentFileId=+8', null], ['?assignmentFileId=8%20', null], ['?assignmentFileId=NaN', null],
  ['?assignmentFileId=Infinity', null], ['?assignmentFileId=9007199254740992', null],
  ['?assignmentFileId=8&assignmentFileId=8', null], ['?assignmentFileId=8&assignmentFileId=9', null],
  ['?assignmentFileId=&assignmentFileId=8', null], ['?assignmentFileId=８', null],
]) test(`canonical explicit assignment parsing: ${JSON.stringify(search)}`, () => assert.equal(parse(search), expected));

test('explicit older selection never falls back to a newer or missing assignment', () => {
  assert.equal(selectAssignmentFile([older, newer], newer, 8), older);
  assert.equal(selectAssignmentFile([older, newer], newer, undefined), newer);
  for (const invalid of [null, 77, 0, -1, 8.5, '8', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(selectAssignmentFile([older, newer], newer, invalid), null);
  }
  assert.equal(selectAssignmentFile([], null, undefined), null);
});

test('resolved file matching requires a positive safe ID and exact trimmed case-folded account', () => {
  assert.equal(matches(older, ACCOUNT), true);
  assert.equal(matches({ ...older, account_id: ' account a ' }, ' Account A '), true);
  for (const file of [null, undefined, {}, { ...older, account_id: 'OTHER' }, { ...older, account_id: null },
    { ...older, id: 0 }, { ...older, id: -8 }, { ...older, id: 8.5 }, { ...older, id: '8' },
    { ...older, id: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(matches(file, ACCOUNT), false);
  assert.equal(matches(older, ''), false); assert.equal(matches(older, ' '), false);
});

test('shared Custom selector validates list and row identity before returning exact explicit or absent-latest selection', () => {
  assert.equal(selectCustomAssignmentFile(response(), ACCOUNT, 8), older);
  assert.equal(selectCustomAssignmentFile(response(), ' account a ', undefined), newer);
  assert.equal(selectCustomAssignmentFile({ account_id: ACCOUNT, files: [], latest_file: null }, ACCOUNT, undefined), null);
  for (const requested of [null, 77]) assert.throws(() => selectCustomAssignmentFile(response(), ACCOUNT, requested),
    { message: CUSTOM_ASSIGNMENT_REQUEST_ERROR });
  for (const bad of [{ ...response(), account_id: 'OTHER' },
    { ...response(), files: [{ ...older, account_id: 'OTHER' }, newer] }]) {
    assert.throws(() => selectCustomAssignmentFile(bad, ACCOUNT, 8), { message: CUSTOM_ASSIGNMENT_REQUEST_ERROR });
  }
});

for (const path of paths) test(`${path} preserves explicit file 8 during loading and newer-file drift; absent requests need a resolved exact file`, () => {
  for (const resolved of [null, undefined, older, newer, { ...newer, account_id: 'OTHER' }]) {
    assert.equal(href(path, ` ${ACCOUNT} `, 8, resolved), expectedHref(path, 8));
    assert.equal(href(path, ACCOUNT, null, resolved), undefined);
  }
  assert.equal(href(path, ACCOUNT, undefined, older), expectedHref(path, 8));
  assert.equal(href(path, ACCOUNT, undefined, newer), expectedHref(path, 9));
  for (const resolved of [null, undefined, { ...newer, account_id: 'OTHER' }, { ...newer, id: 0 }]) {
    assert.equal(href(path, ACCOUNT, undefined, resolved), undefined);
  }
  for (const invalid of [0, -8, 8.5, '8', NaN, Infinity]) assert.equal(href(path, ACCOUNT, invalid, newer), undefined);
  assert.equal(href(path, '', 8, older), undefined);
});

const sources = new Map();
function source(name) {
  if (!sources.has(name)) {
    const text = readFileSync(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8');
    sources.set(name, { text, ast: ts.createSourceFile(`${name}.tsx`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) });
  }
  return sources.get(name);
}
function find(name, predicate) {
  const { ast } = source(name), found = [];
  const visit = node => { const selected = predicate(node, ast); if (selected) found.push(selected); ts.forEachChild(node, visit); };
  visit(ast); return found;
}
function execute(name, node, env) {
  const { ast } = source(name);
  const compiled = ts.transpileModule(`return (${node.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), compiled)(...Object.values(env));
}
function actualExpression(name, predicate, env) {
  const nodes = find(name, predicate); assert.equal(nodes.length, 1, `one actual expression in ${name}`);
  return execute(name, nodes[0], env);
}
const variable = (name, key, env) => actualExpression(name, (node, ast) =>
  ts.isVariableDeclaration(node) && node.name.getText(ast) === key ? node.initializer : null, env);
function hrefExpression(name, label, env) {
  return actualExpression(name, (node, ast) => {
    if (!ts.isJsxElement(node) || node.openingElement.tagName.getText(ast) !== 'a') return null;
    const attributes = node.openingElement.attributes.properties;
    const aria = attributes.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'aria-label');
    const text = node.children.map(child => child.getText(ast)).join(' ').trim();
    if (aria?.initializer?.text !== label && !text.includes(label)) return null;
    const attr = attributes.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === 'href');
    return attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
  }, env);
}

const hookOutput = ts.transpileModule(readFileSync(new URL('../src/hooks/useAssignmentFiles.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function hookHarness(optionsAtStart = {}) {
  const { load = async () => response(), selected } = optionsAtStart;
  const requested = Object.hasOwn(optionsAtStart, 'requested') ? optionsAtStart.requested : 8;
  const cells = [], normal = [], layout = [], requests = [], selectedCalls = [];
  let cursor = 0, dirty = false, current;
  const same = (a, b) => a?.length === b?.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (queue, fn, deps) => { const index = cursor++, old = cells[index]; if (!old || !same(old.deps, deps)) {
    const cell = { deps, cleanup: old?.cleanup }; cells[index] = cell;
    queue.push(() => { cell.cleanup?.(); cell.cleanup = fn(); });
  } };
  const react = {
    useState(initial) { const index = cursor++; cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[index].value, update => { const value = typeof update === 'function' ? update(cells[index].value) : update;
        if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true; } }]; },
    useRef(initial) { const index = cursor++; cells[index] ??= { current: initial }; return cells[index]; },
    useEffect: (fn, deps) => effect(normal, fn, deps), useLayoutEffect: (fn, deps) => effect(layout, fn, deps),
  };
  const imports = { react, '@/lib/assignmentFileSelection': { selectAssignmentFile },
    '@/lib/customAssignmentNavigation': navigation,
    '@/lib/appraisalFileRequests': { loadAssignmentFiles: async (...args) => { requests.push(args); return load(...args); } } };
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${hookOutput}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected hook dependency ${key}`); return imports[key];
  }, module, module.exports);
  let options = { accountId: ACCOUNT, enabled: true, requestedAssignmentFileId: requested,
    onSelectedFile: async (file, isCancelled) => { selectedCalls.push({ file, isCancelled }); return selected?.(file, isCancelled); } };
  function render(patch = {}, runEffects = true) {
    options = { ...options, ...patch }; cursor = 0; dirty = false;
    current = module.exports.useAssignmentFiles(options);
    layout.splice(0).forEach(fn => fn()); if (runEffects) normal.splice(0).forEach(fn => fn());
    return current;
  }
  function flush() { let count = 0; while (dirty) { assert.ok(++count < 20); render(); } }
  render(); flush();
  return { requests, selectedCalls, render, get view() { return current; },
    async settle() { for (let i = 0; i < 20; i++) { await Promise.resolve(); flush(); } },
    cleanup() { cells.forEach(cell => cell?.cleanup?.()); } };
}

for (const [label, requested, id] of [['explicit older', 8, 8], ['absent latest', undefined, 9]]) test(`actual assignment hook hydrates ${label} only`, async () => {
  const h = hookHarness({ requested }); await h.settle();
  assert.deepEqual(h.requests, [[ACCOUNT]]); assert.deepEqual(h.selectedCalls.map(call => call.file.id), [id]);
  assert.equal(h.view.activeAssignmentFile.id, id); assert.equal(h.view.assignmentFilesLoaded, true); h.cleanup();
});

for (const requested of [null, 77]) test(`actual assignment hook refuses invalid/missing explicit request ${requested}`, async () => {
  const h = hookHarness({ requested }); await h.settle();
  assert.equal(h.requests.length, requested === null ? 0 : 1); assert.deepEqual(h.selectedCalls, []);
  assert.equal(h.view.activeAssignmentFile, null); assert.equal(h.view.assignmentFilesError, CUSTOM_ASSIGNMENT_REQUEST_ERROR); h.cleanup();
});

for (const field of ['response account', 'file account', 'file id']) test(`actual assignment hook refuses wrong ${field} without hydration`, async () => {
  const bad = structuredClone(response());
  if (field === 'response account') bad.account_id = 'OTHER';
  if (field === 'file account') bad.files[0].account_id = 'OTHER';
  if (field === 'file id') bad.files[0].id = 8.5;
  const h = hookHarness({ load: async () => bad }); await h.settle();
  assert.deepEqual(h.selectedCalls, []); assert.equal(h.view.activeAssignmentFile, null);
  assert.deepEqual(h.view.assignmentFiles, [], 'unmatched responses cannot populate the assignment log');
  assert.ok(h.view.assignmentFilesError); h.cleanup();
});

for (const change of ['account', 'file', 'cleanup']) test(`actual late assignment-list response after ${change} cannot select or hydrate`, async () => {
  const wait = deferred(), h = hookHarness({ load: () => wait.promise });
  if (change === 'account') h.render({ accountId: 'OTHER' }, false);
  if (change === 'file') h.render({ requestedAssignmentFileId: 9 }, false);
  if (change === 'cleanup') h.cleanup();
  wait.resolve(response()); await settle();
  assert.deepEqual(h.selectedCalls, []); assert.equal(h.view.activeAssignmentFile, null); h.cleanup();
});

test('actual selection callback cancellation includes generation changes before passive-effect cleanup', async () => {
  const wait = deferred(), h = hookHarness({ selected: () => wait.promise }); await h.settle();
  assert.equal(h.selectedCalls.length, 1); assert.equal(h.selectedCalls[0].isCancelled(), false);
  h.render({ requestedAssignmentFileId: 9 }, false);
  assert.equal(h.selectedCalls[0].isCancelled(), true); wait.resolve(); await settle(); h.cleanup();
});

for (const [label, patch] of [['file 9', { requestedAssignmentFileId: 9 }],
  ['invalid request', { requestedAssignmentFileId: null }], ['other account', { accountId: 'OTHER' }]]) {
  test(`actual resolved file 8 clears synchronously when selecting ${label}, before passive effects`, async () => {
    const h = hookHarness(); await h.settle(); assert.equal(h.view.activeAssignmentFile.id, 8);
    const count = h.requests.length;
    const transition = h.render(patch, false);
    assert.equal(transition.activeAssignmentFile, null, 'the first render does not expose the old resolved file');
    assert.equal(transition.assignmentFileNumber, '');
    // React immediately rerenders state updates scheduled in the layout phase,
    // before allowing the old identity to be painted or passive effects to run.
    h.render({}, false);
    assert.equal(h.view.activeAssignmentFile, null); assert.equal(h.view.assignmentFileNumber, '');
    assert.equal(h.requests.length, count); assert.equal(h.selectedCalls[0].isCancelled(), true); h.cleanup();
  });
}

test('actual chooser existing-file link and new-assignment callback retain exact Custom target IDs', async () => {
  const name = 'components/ReportTypeChooser', subject = { accountId: ACCOUNT }, option = { type: 'custom-appraisal', workflow: 'custom_appraisal' };
  for (const id of ['8', '9']) {
    const actual = actualExpression(name, (node, ast) => ts.isJsxAttribute(node) && node.name.getText(ast) === 'href'
      && node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : null,
    { subject, option, file: { target_id: id }, reportDestination });
    assert.equal(actual, expectedHref('/report', id));
  }
  const calls = [], destinations = [], creating = [], errors = [];
  const env = { subject, option, organizationId: 'synthetic-org', creating: false, effectiveDate: '2026-09-13',
    creationIntent: { current: null }, crypto: { randomUUID: () => 'synthetic-intent' },
    setCreating: value => creating.push(value), setError: value => errors.push(value), reportDestination,
    createCanonicalReportFile: async (...args) => { calls.push(args); return { report_file: { target_id: '10' } }; },
    window: { location: { assign: value => destinations.push(value) } } };
  const start = actualExpression(name, node => ts.isFunctionDeclaration(node) && node.name?.text === 'startNewAssignment' ? node : null, env);
  await start();
  assert.deepEqual(calls, [[ACCOUNT, { workflow_type: 'custom_appraisal', organization_id: 'synthetic-org',
    client_request_id: 'synthetic-intent', effective_date: '2026-09-13' }]]);
  assert.deepEqual(destinations, [expectedHref('/report', 10)]); assert.deepEqual(creating, [true]); assert.deepEqual(errors, ['']);
});

for (const page of ['PropertyReport', 'AppraisalReport', 'ComparableSalesAnalysis']) test(`actual ${page} parser preserves absent versus invalid versus explicit assignment intent`, () => {
  for (const search of ['', '?assignmentFileId=8', '?assignmentFileId=', '?assignmentFileId=8&assignmentFileId=9']) {
    assert.equal(variable(`pages/${page}`, 'requestedAssignmentFileId', {
      useMemo: fn => fn(), parseCustomAssignmentFileId: parse, location: { search },
    }), parse(search));
  }
});

const pageLinks = [
  ['AppraisalReport', 'Property Report', '/report'],
  ['AppraisalReport', 'Sales Comparison', '/ComparableSalesAnalysis'],
  ['ComparableSalesAnalysis', 'Generate Full Appraisal PDF', '/AppraisalReport'],
  ['ComparableSalesAnalysis', 'Close Report', '/report'],
  ['ComparableSalesAnalysis', 'Review Market Analysis', '/report'],
  ['PropertyReport', 'Sales Comparison Approach', '/ComparableSalesAnalysis'],
  ['PropertyReport', 'Cost Approach', '/CostApproach'],
  ['PropertyReport', 'Income Approach', '/IncomeApproach'],
  ['PropertyReport', 'Final Reconciliation', '/FinalReconciliation'],
  ['PropertyReport', 'Full Appraisal PDF', '/AppraisalReport'],
];
for (const [page, label, path] of pageLinks) test(`actual ${page} ${label} link preserves explicit older file across loading/reload and refuses invalid intent`, () => {
  const evaluate = (requested, file) => hrefExpression(`pages/${page}`, label, {
    customAssignmentHref: href, accountId: ACCOUNT, propertyId: ACCOUNT, requestedAssignmentFileId: requested,
    activeAssignmentFile: file, assignmentFile: file, appraisalReportAssignmentFile: file,
  });
  for (const file of [null, older, newer]) {
    assert.equal(evaluate(8, file), expectedHref(path, 8));
    assert.equal(evaluate(null, file), undefined);
  }
  assert.equal(evaluate(undefined, null), undefined);
  assert.equal(evaluate(undefined, newer), expectedHref(path, 9));
  assert.equal(evaluate(undefined, { ...newer, account_id: 'OTHER' }), undefined);
});

test('actual per-file View File action targets its row rather than the currently selected assignment', () => {
  for (const file of [older, newer]) {
    assert.equal(hrefExpression('pages/PropertyReport', 'View File', { accountId: ACCOUNT, file,
      requestedAssignmentFileId: 8, activeAssignmentFile: older }), expectedHref('/AppraisalReport', file.id));
  }
});

function pageLoadHarness(page, options = {}) {
  const requested = Object.hasOwn(options, 'requested') ? options.requested : 8;
  const calls = [], files = [], drafts = [], messages = [], generation = { current: 1 };
  const workfile = id => ({ account_id: ACCOUNT, workfile: { assignment_file_id: id, status: 'draft',
    canonical_file_name: `qa-${id}.json`, sections: {
      sales_comparison: { revision: 2, value: { assignmentFileId: id, marker: 'saved-sales' } },
      market_conditions: { value: { assignmentFileId: id, marker: 'saved-market' } },
    } } });
  const rememberDraft = value => { if (value !== null) drafts.push(value); };
  const rememberFile = value => files.push(value);
  const env = { propertyId: ACCOUNT, requestedAssignmentFileId: requested, applicationSession: { synthetic: true },
    assignmentSelectionGenerationRef: generation, workfileSelectionGenerationRef: generation,
    selectCustomAssignmentFile, CUSTOM_ASSIGNMENT_REQUEST_ERROR,
    loadAssignmentFiles: async (...args) => { calls.push(['list', ...args]); return options.list ? options.list() : response(); },
    loadCustomAppraisalWorkfile: async (...args) => { calls.push(['workfile', ...args]); return options.workfile ? options.workfile() : workfile(args[1]); },
    loadCustomNeighborhoodAccepted: async (...args) => { calls.push(['accepted', ...args]); return { status: 'legacy', accountId: args[0], assignmentFileId: args[1] }; },
    readAppraisalReportDraft: (...args) => { calls.push(['browser-sales', ...args]); return null; },
    readMarketConditionsDraft: (...args) => { calls.push(['browser-market', ...args]); return null; },
    setAssignmentFile: rememberFile, setActiveAssignmentFile: rememberFile,
    setDraft: rememberDraft, setMarketDraft: rememberDraft, setMarketConditionsDraft: rememberDraft,
    setWorkfileDraftToRestore: rememberDraft,
    setPrintBlocker: value => messages.push(value), setWorkfileSaveStatus: value => messages.push(value),
    setAcceptedNeighborhood() {}, setAssignmentLoading() {}, setCostDraft() {}, setIncomeDraft() {}, setFinalDraft() {},
    setWorkfileReady() {}, setWorkfileCanonicalName() {}, setWorkfileLocked() {}, workfileSectionRevisionRef: { current: 0 },
  };
  const effect = actualExpression(`pages/${page}`, (node, ast) => ts.isCallExpression(node)
    && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('loadCustomAppraisalWorkfile(propertyId,') ? node.arguments[0] : null, env);
  return { calls, files, drafts, messages, generation, workfile, cleanup: effect() };
}

for (const page of ['AppraisalReport', 'ComparableSalesAnalysis']) {
  for (const [requested, expectedId] of [[8, 8], [undefined, 9]]) test(`actual ${page} workfile hydration retains ${requested === undefined ? 'unscoped latest' : 'explicit older'} assignment`, async () => {
    const h = pageLoadHarness(page, { requested }); await settle();
    assert.deepEqual(h.calls.filter(call => call[0] === 'workfile'), [['workfile', ACCOUNT, expectedId]]);
    assert.deepEqual(h.files.filter(Boolean).map(file => file.id), [expectedId]);
    assert.equal(h.drafts.length, 2); assert.ok(h.drafts.every(draft => draft.assignmentFileId === expectedId));
    assert.equal(h.calls.some(call => call[0].startsWith('browser-')), false); h.cleanup();
  });

  for (const search of ['?assignmentFileId=', '?assignmentFileId=oops', '?assignmentFileId=8&assignmentFileId=9', '?assignmentFileId=77']) {
    test(`actual ${page} invalid or missing explicit ${search} never hydrates latest file 9`, async () => {
      const requested = parse(search), h = pageLoadHarness(page, { requested }); await settle();
      assert.equal(h.calls.filter(call => call[0] === 'list').length, requested === null ? 0 : 1);
      assert.equal(h.calls.some(call => call[0] === 'workfile' || call[0].startsWith('browser-')), false);
      assert.deepEqual(h.files.filter(Boolean), []); assert.deepEqual(h.drafts, []);
      assert.ok(h.messages.some(message => message.includes(CUSTOM_ASSIGNMENT_REQUEST_ERROR))); h.cleanup();
    });
  }

  for (const kind of ['list account', 'selected account', 'workfile account', 'workfile id']) test(`actual ${page} refuses wrong ${kind} before hydrating saved sections`, async () => {
    const list = structuredClone(response());
    const badWorkfile = { account_id: ACCOUNT, workfile: { assignment_file_id: 8, status: 'draft', sections: {} } };
    if (kind === 'list account') list.account_id = 'OTHER';
    if (kind === 'selected account') list.files[0].account_id = 'OTHER';
    if (kind === 'workfile account') badWorkfile.account_id = 'OTHER';
    if (kind === 'workfile id') badWorkfile.workfile.assignment_file_id = 9;
    const h = pageLoadHarness(page, { list: async () => list, workfile: async () => badWorkfile }); await settle();
    assert.deepEqual(h.files.filter(Boolean), []); assert.deepEqual(h.drafts, []);
    assert.equal(h.calls.some(call => call[0] === 'workfile'), kind.startsWith('workfile'));
    h.cleanup();
  });

  for (const stage of ['list', 'workfile']) for (const change of ['generation', 'cleanup']) {
    test(`actual ${page} late ${stage} after ${change} cannot select or hydrate the prior file`, async () => {
      const wait = deferred(), h = pageLoadHarness(page, { [stage]: () => wait.promise }); await settle();
      if (change === 'generation') h.generation.current++;
      else h.cleanup();
      wait.resolve(stage === 'list' ? response() : h.workfile(8)); await settle();
      assert.deepEqual(h.files.filter(Boolean), []); assert.deepEqual(h.drafts, []);
      if (stage === 'list') assert.equal(h.calls.some(call => call[0] === 'workfile'), false);
      h.cleanup();
    });
  }
}

const contextOutput = ts.transpileModule(readFileSync(new URL('../src/hooks/useAppraisalFileContext.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function contextHarness(options = {}) {
  const calls = [], imports = {
    react: { useMemo: fn => fn() },
    'react-router-dom': { useLocation: () => ({ search: options.search ?? '?propertyId=ACCOUNT%20A&assignmentFileId=8' }) },
    '@/lib/customAssignmentNavigation': navigation,
    '@/lib/api': { getAccount: async (...args) => {
      calls.push(['account', ...args]); return options.property ?? { account: { account_id: ACCOUNT }, marker: 'saved-property' };
    } },
    '@/lib/appraisalFileRequests': {
      loadAssignmentFiles: async (...args) => { calls.push(['list', ...args]); return options.list ?? response(); },
      loadCustomAppraisalWorkfile: async (...args) => { calls.push(['workfile', ...args]); return options.workfile ?? {
        account_id: ACCOUNT, workfile: { assignment_file_id: args[1], status: 'draft', sections: {}, marker: 'saved-workfile' },
      }; },
    },
  };
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${contextOutput}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected shared context dependency ${key}`); return imports[key];
  }, module, module.exports);
  return { calls, request: module.exports.useAppraisalFileRequest,
    load: requested => module.exports.loadAppraisalFileContext(ACCOUNT, requested) };
}

for (const [search, requestedFileId] of [['?propertyId=%20ACCOUNT%20A%20', undefined],
  ['?propertyId=ACCOUNT%20A&assignmentFileId=8', 8], ['?propertyId=ACCOUNT%20A&assignmentFileId=', null],
  ['?propertyId=ACCOUNT%20A&assignmentFileId=08', null], ['?propertyId=ACCOUNT%20A&assignmentFileId=8&assignmentFileId=9', null]]) {
  test(`actual shared approach request parser retains assignment intent: ${search}`, () => {
    const h = contextHarness({ search }); assert.deepEqual(h.request(), { propertyId: ACCOUNT, requestedFileId });
    assert.deepEqual(h.calls, []);
  });
}

test('actual shared approach loader refuses invalid intent before any request and missing explicit ID before account/workfile reads', async () => {
  const invalid = contextHarness(); await assert.rejects(invalid.load(null)); assert.deepEqual(invalid.calls, []);
  const missing = contextHarness(); await assert.rejects(missing.load(77)); assert.deepEqual(missing.calls, [['list', ACCOUNT]]);
});

for (const [requested, id] of [[8, 8], [undefined, 9]]) test(`actual shared approach loader returns exact ${requested === undefined ? 'latest' : 'older'} assignment and paired account/workfile`, async () => {
  const h = contextHarness(), result = await h.load(requested);
  assert.equal(result.assignmentFile.id, id); assert.equal(result.workfile.assignment_file_id, id);
  assert.equal(result.property.account.account_id, ACCOUNT);
  assert.deepEqual(h.calls, [['list', ACCOUNT], ['account', ACCOUNT, { assignmentFileId: id }], ['workfile', ACCOUNT, id]]);
});

for (const label of ['list account', 'assignment account', 'property account', 'workfile account', 'workfile id']) {
  test(`actual shared approach loader rejects mismatched ${label} without returning usable context`, async () => {
    const options = { list: structuredClone(response()), property: { account: { account_id: ACCOUNT } },
      workfile: { account_id: ACCOUNT, workfile: { assignment_file_id: 8, status: 'draft', sections: {} } } };
    if (label === 'list account') options.list.account_id = 'OTHER';
    if (label === 'assignment account') options.list.files[0].account_id = 'OTHER';
    if (label === 'property account') options.property.account.account_id = 'OTHER';
    if (label === 'workfile account') options.workfile.account_id = 'OTHER';
    if (label === 'workfile id') options.workfile.workfile.assignment_file_id = 9;
    const h = contextHarness(options); await assert.rejects(h.load(8));
    if (label === 'list account' || label === 'assignment account') assert.deepEqual(h.calls, [['list', ACCOUNT]]);
  });
}

const approachPages = ['CostApproach', 'IncomeApproach', 'FinalReconciliation'];
for (const page of approachPages) {
  for (const [label, path] of [['Property Report', '/report'], ['Full Report', '/AppraisalReport']]) {
    test(`actual ${page} ${label} return link retains file 8 and refuses invalid/unresolved context`, () => {
      const evaluate = (requestedFileId, assignmentFile) => hrefExpression(`pages/${page}`, label,
        { propertyId: ACCOUNT, requestedFileId, assignmentFile, customAssignmentHref: href });
      for (const file of [null, older, newer]) {
        assert.equal(evaluate(8, file), expectedHref(path, 8)); assert.equal(evaluate(null, file), undefined);
      }
      assert.equal(evaluate(undefined, null), undefined); assert.equal(evaluate(undefined, newer), expectedHref(path, 9));
    });
  }

  test(`actual ${page} workspace key remounts for account, explicit file, absent and invalid changes`, () => {
    const name = `pages/${page}`;
    const requests = [{ propertyId: ACCOUNT, requestedFileId: 8 }, { propertyId: ACCOUNT, requestedFileId: 9 },
      { propertyId: ACCOUNT, requestedFileId: undefined }, { propertyId: ACCOUNT, requestedFileId: null },
      { propertyId: 'OTHER', requestedFileId: 8 }];
    const keys = requests.map(request => actualExpression(name, (node, ast) => {
      if (!ts.isJsxSelfClosingElement(node) || node.tagName.getText(ast) !== `${page}Workspace`) return null;
      const key = node.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'key');
      return key?.initializer && ts.isJsxExpression(key.initializer) ? key.initializer.expression : null;
    }, { request }));
    assert.equal(new Set(keys).size, requests.length);
    for (const request of requests) {
      assert.equal(variable(name, 'request', { useAppraisalFileRequest: () => request }), request);
      const spread = actualExpression(name, (node, ast) => ts.isJsxSelfClosingElement(node)
        && node.tagName.getText(ast) === `${page}Workspace`
        ? node.attributes.properties.find(ts.isJsxSpreadAttribute)?.expression : null, { request });
      assert.equal(spread, request, 'the keyed workspace receives exactly the parsed request');
    }
  });

  test(`actual ${page} old load success cannot hydrate the workspace after remount cleanup`, async () => {
    const wait = deferred(), writes = [], name = `pages/${page}`;
    const effect = actualExpression(name, (node, ast) => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0]?.getText(ast).includes('loadAppraisalFileContext(propertyId, requestedFileId)') ? node.arguments[0] : null,
    { propertyId: ACCOUNT, requestedFileId: 8, loadAppraisalFileContext: () => wait.promise,
      setDetail: value => writes.push(value), setAssignmentFile: value => writes.push(value),
      setMessage: value => writes.push(value), setLoading: value => writes.push(value) });
    const cleanup = effect(); cleanup();
    wait.resolve({ property: { account: { account_id: ACCOUNT } }, assignmentFile: older, workfile: { sections: {} } });
    await settle(); assert.deepEqual(writes, []);
  });
}
