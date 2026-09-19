import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as cache from '../src/lib/timedRequestCache.ts';
import * as navigation from '../src/lib/customAssignmentNavigation.ts';
import * as mapping from '../src/lib/legacyDcadDetail.ts';

const runtime = createRequire(new URL('../package.json', import.meta.url)), ts = runtime('typescript');
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
function compile(path, imports, replacementSource) {
  const file = fileURLToPath(new URL(`../src/${path}`, import.meta.url));
  const code = ts.transpileModule(replacementSource ?? source(path), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, module = { exports: {} };
  new Script(`(function(require,module,exports){${code}\n})`, { filename: file }).runInThisContext()(id => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id}`); return imports[id];
  }, module, module.exports);
  return module.exports;
}
const apiSource = source('lib/api.ts');
const apiTree = ts.createSourceFile('api.ts', apiSource, ts.ScriptTarget.Latest, true);
const getAccountSource = apiTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getAccount').getText(apiTree);
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };
const body = (name = 'Recorded owner') => ({ account: { account_id: '00000792229000000', county: 'Dallas' },
  owner_summary: { owner_name: name, mailing_address: 'PO BOX 123' },
  owner_parties: [{ owner_name: name, ownership_pct: 100 }] });

function harness() {
  const cells = [], effects = [], calls = [], photos = [], errors = [];
  let cursor = 0, dirty = false, props, output;
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (!old || !same(old.deps, deps)) {
      cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); });
    } },
  };
  // Execute the actual getAccount body and its actual query-field mapping. Only
  // URL assembly and HTTP transport are controlled; there is no network access.
  const api = compile('lib/api.ts', { transport: {
    makeUrl(path, params) { const url = new URL(path, 'https://synthetic.invalid');
      for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
      return url.href; },
    fetchJSON(url) { const wait = deferred(); calls.push({ url, ...wait }); return wait.promise; },
  } }, `import { makeUrl, fetchJSON } from 'transport';\n${getAccountSource}`);
  const dcad = compile('lib/dcad.ts', { './api': api, './legacyDcadDetail': mapping, './customAssignmentNavigation': navigation });
  const hook = compile('hooks/usePropertyReportDetail.ts', {
    react, '@/lib/dcad': dcad, '@/lib/timedRequestCache': cache,
    '@/lib/api': { getAccountPhotos(account) { const wait = deferred(); photos.push({ account, ...wait }); return wait.promise; } },
  }).usePropertyReportDetail;
  function render(next = props, commit = true) {
    props = next; cursor = 0; dirty = false; output = hook(props);
    if (commit) effects.splice(0).forEach(fn => fn()); return output;
  }
  function flush() { let count = 0; while (dirty) { assert.ok(++count < 20, 'No render loop'); render(); } }
  return { calls, photos, errors, dcad,
    initial(overrides = {}) { return { accountId: '00000792229000000', assignmentFileId: 11,
      sessionKey: 'user-1:org-1', enabled: true, onError: error => errors.push(error), ...overrides }; },
    render(next, commit = true) { const first = render(next, commit); if (commit) flush(); return first; },
    get current() { return output; }, get props() { return props; },
    async drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); flush(); },
    async complete(index, value = body()) { calls[index].resolve(value); await this.drain(); },
    async fail(index, error = new Error('assignment_file_access_denied')) { calls[index].reject(error); await this.drain(); },
    commit() { effects.splice(0).forEach(fn => fn()); flush(); },
    unmount() { cells.forEach(cell => cell?.cleanup?.()); },
  };
}

test('report forwards the parsed exact file and auth ownership into the detail loader', () => {
  const report = source('pages/PropertyReport.tsx').slice(source('pages/PropertyReport.tsx').indexOf('export default function PropertyReport()'));
  assert.match(report, /parseCustomAssignmentFileId\(location\.search\)/);
  assert.match(report, /assignmentFileId: requestedAssignmentFileId/);
  assert.match(report, /sessionKey: detailSessionKey/);
  assert.match(report, /applicationAuth\.session\?\.user_id/);
  assert.match(report, /applicationAuth\.session\?\.organizations/);
  assert.match(report, /enabled: applicationAuth\.ready && !applicationAuth\.bootstrapError/);
  assert.match(report, /!applicationAuth\.required \|\| Boolean\(applicationAuth\.session\)/);
});

test('exact assignment11 reaches the authorized API and renders recorded owner, parties and mailing address', async () => {
  const h = harness(); h.render(h.initial());
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://synthetic.invalid/api/accounts/00000792229000000?assignment_file_id=11');
  await h.complete(0);
  assert.equal(h.current.detail.owner.owner_name, 'Recorded owner');
  assert.equal(h.current.detail.owner.mailing_address, 'PO BOX 123');
  assert.deepEqual(h.current.detail.owner.parties, [{ owner_name: 'Recorded owner', ownership_pct: 100 }]);
  assert.equal(h.photos.length, 1); assert.equal(h.errors.length, 0);
});

for (const [label, value] of [['invalid parsed link', null], ['zero', 0], ['negative', -1], ['fraction', 1.5],
  ['unsafe number', Number.MAX_SAFE_INTEGER + 1], ['numeric string', '11']]) {
  test(`${label} never becomes an unscoped request or starts media loading`, async () => {
    const h = harness(); h.render(h.initial({ assignmentFileId: value })); await h.drain();
    assert.equal(h.calls.length, 0); assert.equal(h.photos.length, 0); assert.equal(h.current.detail, null);
    assert.equal(h.errors.length, 1); assert.equal(h.errors[0].message, navigation.CUSTOM_ASSIGNMENT_REQUEST_ERROR);
  });
}

test('no explicit file retains public-only legacy loading and missing ownership stays unknown', async () => {
  const h = harness(); h.render(h.initial({ assignmentFileId: undefined }));
  assert.equal(new URL(h.calls[0].url).search, '');
  await h.complete(0, { account: body().account, owner_summary: null, owner_parties: [] });
  assert.equal(h.current.detail.owner, undefined);
  h.render(h.initial()); assert.equal(h.current.detail, null);
  assert.equal(new URL(h.calls[1].url).searchParams.get('assignment_file_id'), '11');
});

test('scoped request denial clears the previous detail and never retries as public or another assignment', async () => {
  const h = harness(); h.render(h.initial()); await h.complete(0);
  const reload = h.current.reloadDetail(); await h.fail(1); await reload;
  assert.equal(h.current.detail, null); assert.equal(h.errors.length, 1); assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => new URL(call.url).searchParams.get('assignment_file_id') === '11'));
  assert.equal(h.photos.length, 1);
});

for (const [label, changes] of [['file', { assignmentFileId: 12 }], ['account', { accountId: '00000792229000001' }],
  ['session', { sessionKey: 'user-2:org-2' }], ['organization', { sessionKey: 'user-1:org-2' }]]) {
  test(`${label} changes synchronously hide old detail and cannot reuse its cached response`, async () => {
    const h = harness(); h.render(h.initial()); await h.complete(0, body('First owner'));
    const oldReload = h.current.reloadDetail;
    const immediate = h.render(h.initial(changes), false);
    assert.equal(immediate.detail, null, 'no previous-owner data before effects run');
    await oldReload(); assert.equal(h.calls.length, 1, 'old callback cannot issue work for discarded owner');
    h.commit(); assert.equal(h.calls.length, 2);
    const nextRequest = new URL(h.calls[1].url);
    assert.equal(nextRequest.pathname, `/api/accounts/${changes.accountId ?? h.initial().accountId}`);
    assert.equal(nextRequest.searchParams.get('assignment_file_id'), String(changes.assignmentFileId ?? 11));
    await h.complete(1, body('Second owner'));
    h.photos[0].resolve({ photos: [{ media_url: 'https://synthetic.invalid/old.jpg' }] }); await h.drain();
    assert.equal(h.current.detail.owner.owner_name, 'Second owner'); assert.deepEqual(h.current.detail.photos, []);
    h.render(h.initial()); assert.equal(h.calls.length, 3, 'returning cannot reuse a discarded private cache');
    assert.equal(h.current.detail, null);
  });
}

test('late responses and failures from a previous file cannot overwrite the current file or surface an old error', async () => {
  const h = harness(); h.render(h.initial()); h.render(h.initial({ assignmentFileId: 12 }));
  await h.complete(1, body('Current owner')); await h.complete(0, body('Stale owner'));
  assert.equal(h.current.detail.owner.owner_name, 'Current owner'); assert.equal(h.photos.length, 1);
  const pending = h.current.reloadDetail(); h.render(h.initial({ assignmentFileId: 13 }));
  await h.complete(3, body('Third owner')); await h.fail(2); await pending;
  assert.equal(h.current.detail.owner.owner_name, 'Third owner'); assert.equal(h.errors.length, 0);
});

test('disabled/bootstrap/signed-out owner starts no requests and discards private data immediately', async () => {
  const h = harness(); h.render(h.initial({ enabled: false })); assert.equal(h.calls.length, 0);
  h.render(h.initial()); await h.complete(0);
  assert.equal(h.render(h.initial({ enabled: false, sessionKey: 'signed-out' }), false).detail, null);
  h.commit(); assert.equal(h.calls.length, 1);
  h.render(h.initial()); assert.equal(h.calls.length, 2); assert.equal(h.current.detail, null);
});

test('same-owner rerenders do not request again; unmounted late response starts no media read', async () => {
  const h = harness(); h.render(h.initial()); h.render({ ...h.props }); assert.equal(h.calls.length, 1);
  h.unmount(); await h.complete(0); assert.equal(h.photos.length, 0); assert.equal(h.errors.length, 0);
});

test('checked mapping keeps absent fields unknown rather than manufacturing owner or mailing details', async () => {
  for (const response of [null, {}, { account: body().account, owner_summary: {}, owner_parties: [] }]) {
    const h = harness(); h.render(h.initial()); await h.complete(0, response);
    assert.equal(h.current.detail.owner?.owner_name, undefined);
    assert.equal(h.current.detail.owner?.mailing_address, undefined);
  }
});
