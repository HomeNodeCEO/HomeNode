import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as controller from '../src/features/neighborhood/customCohortPreviewController.ts';
import * as members from '../src/features/neighborhood/customCohortMemberPage.ts';
import { buildCustomCohortObservationPreview } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview, inspectCustomCohortPreviewMembers } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCachedSourceCaptures } from '../../server/src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow } from '../../server/src/services/neighborhoodAssessment/cachedRowMappings.js';
import { contextFixture } from '../../server/test/fixtures/customCohortContextFixture.js';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
const file = fileURLToPath(new URL('../src/features/neighborhood/components/CustomCohortMemberBrowser.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

// Real row mapping, retained capture builder, numeric preview and public page
// formatter; no synthetic browser DTOs or new source-authority assumptions.
function fixture({ accountCount = 2, saleCount = 3, empty = false, revision = 7, assignmentFileId = '17', hash = 'a' } = {}) {
  const accountIds = Array.from({ length: accountCount }, (_, i) => `A${String(i).padStart(3, '0')}`);
  const target = { ...contextFixture().target, account_id: accountIds[0], assignment_file_id: assignmentFileId };
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const parcels = accountIds.map((account_id, i) => ({ object_id: String(i + 1), account_id, residential_year_built: 2001,
    residential_area_sqft: i === 1 ? null : '1800.1234', parcel_area_sqft: '6000', current_market_value: '330000' }));
  const sales = Array.from({ length: saleCount + 3 }, (_, i) => ({ source_record_id: String(8000000 + i), sale_id: String(9000000 + i),
    primary_account_id: accountIds[0], sale_account_id: accountIds[0], record_type: 'closed_sale',
    sale_closing_date: i < saleCount ? '2024-03-01' : i === saleCount ? '2022-03-01' : i === saleCount + 1 ? null : '2024-03-01',
    source_close_date: i < saleCount ? '2024-03-01' : i === saleCount ? '2022-03-01' : i === saleCount + 1 ? null : '2024-04-01',
    sale_price: '330000.125', source_current_price: '335000', source_living_area: '1800.1234', source_days_on_market: 0, source_name: 'PRIVATE_PROVIDER_NAME' }));
  const wrap = (rows, mapper, role) => rows.map((row, i) => ({ record_id: `${role}:${i}`, data: mapper(row) }));
  const roles = { selection: accountIds.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'), accounts: wrap(accountIds.map(account_id => ({ account_id })), mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: [], gis_sync: [] };
  const captured_at = '2026-09-09T12:00:00.123Z';
  const source_capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `test:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'b'.repeat(64), captured_at, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `test-${role}`, provider: 'Synthetic mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: captured_at, historical_availability: 'unknown' },
    projection: { id: `test-${role}`, revision: 'fixture-v2', definition: { role }, complete: true, input_row_count: records.length, output_record_count: records.length }, records })) });
  const contextRef = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: hash.repeat(64) };
  const selection = { revision, pockets: empty ? [] : [{ id: 'inspected', label: 'Inspected recorded group', account_ids: accountIds }] };
  const preview = buildCustomCohortObservationPreview({ context_ref: contextRef, selection,
    retained_inputs: { subject: { target, effective_date: '2024-06-30' }, study: { observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } },
      spatial: { query_complete: true, account_ids: accountIds, parcels: parcels.map(p => ({ object_id: p.object_id, account_id: p.account_id })) },
      acquisition: { captured_query_request: { scope, account_ids: accountIds }, capture_result: { query_complete: true, captured_at, source_capture } } } });
  const expected = { context_ref: contextRef, selection_revision: revision };
  const summary = presentCustomCohortPreview({ preview, expected }), input = { accountId: accountIds[0], assignmentFileId, contextRef, selection };
  const envelope = { status: 'preview', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: contextRef, selection_revision: revision, subject_freshness: 'matched', summary,
    parcel_map: { status: 'omitted', reason: 'geometry_not_requested' }, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
  return { input, group: controller.checkCustomCohortSummaryResponse(envelope, input, summary.binding.selection_sha256), preview,
    response(population, page) { return { status: 'members', target: envelope.target, context_ref: contextRef, selection_revision: revision,
      subject_freshness: 'matched', page: inspectCustomCohortPreviewMembers({ preview, expected, population, page }), apply: envelope.apply }; } };
}

const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const expand = node => node && typeof node === 'object' ? typeof node.type === 'function' ? expand(node.type(node.props))
  : { ...node, props: { ...node.props, children: children(node).map(expand) } } : node;
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
function harness(f = fixture()) {
  let cells = [], effects = [], cursor = 0, dirty = false, props, tree, key, serial = 0;
  const calls = [], digests = new Set(), waiters = new Map(), timers = new Map();
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (!old || !equalDeps(old.deps, deps)) {
      cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); });
    } },
  };
  const transport = (input, population, page, io) => new Promise((resolve, reject) => {
    const call = { input, population, page, ...io, resolve, reject }, index = calls.length;
    calls.push(call); waiters.get(index)?.forEach(fn => fn(call)); waiters.delete(index);
  });
  const module = { exports: {} };
  new Script(`(function(require,module,exports,setTimeout,clearTimeout){${compiled}\n})`, { filename: file }).runInThisContext()(name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return requireRuntime(name);
    if (name === '../customCohortMemberPage') return members;
    assert.equal(name, '../customCohortPreviewController'); return { ...controller, fingerprintCustomCohortSelection(value) {
      const digest = controller.fingerprintCustomCohortSelection(value); digests.add(digest);
      void digest.then(() => digests.delete(digest), () => digests.delete(digest)); return digest;
    } };
  }, module, module.exports, (fn, delay) => { timers.set(++serial, { fn, delay }); return serial; }, id => timers.delete(id));
  function unmount() { cells.forEach(cell => cell?.cleanup?.()); cells = []; effects = []; key = undefined; }
  function render(next = props) {
    props = next; const owner = module.exports.default(props);
    if (key !== owner.key) { unmount(); key = owner.key; }
    cursor = 0; dirty = false; tree = expand(typeof owner.type === 'function' ? owner.type(owner.props) : owner);
    effects.splice(0).forEach(fn => fn());
  }
  function flush() { let n = 0; while (dirty) { assert.ok(++n < 20, 'No render loop'); render(); } }
  const h = { calls, timers, transport, fixture: f,
    props: () => ({ input: f.input, group: f.group, memberTransport: transport }),
    get propsNow() { return props; }, get tree() { return tree; }, nodes: () => walk(tree), text: () => text(tree),
    render(value) { render(value); flush(); },
    button(label) { const found = walk(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(found, `Button ${label}`); return found; },
    click(label, bypassDisabled = false) { const b = this.button(label); if (!b.props.disabled || bypassDisabled) b.props.onClick(); flush(); },
    population(kind) { const b = walk(tree).find(node => node.type === 'button' && text(node).startsWith({ stock: 'Current CAD accounts (',
      transactions: 'In-period transaction observations (', source_reported: 'Source-reported records (', omitted_transactions: 'Omitted transaction observations (' }[kind]));
      assert.ok(b); if (!b.props.disabled) b.props.onClick(); flush(); },
    async drain() { for (let i = 0; i < 16; i++) await Promise.resolve(); flush(); },
    async settle() { await Promise.allSettled([...digests]); await this.drain(); },
    async wait(index = calls.length) { if (!calls[index]) await new Promise(resolve => {
      const list = waiters.get(index) ?? []; list.push(resolve); waiters.set(index, list);
    }); await this.drain(); return calls[index]; },
    async complete(index = calls.length - 1, transform = value => value, source = f) {
      const call = calls[index]; call.resolve(transform(source.response(call.population, call.page))); await this.drain();
    },
    async fail(index = calls.length - 1) { calls[index].reject(new Error('PRIVATE_DATABASE_ERROR')); await this.drain(); },
    async timeout() { const entries = [...timers.entries()]; entries.forEach(([id, timer]) => { timers.delete(id); timer.fn(); }); await this.drain(); },
    unmount,
  };
  h.render(h.props()); return h;
}

test('mount is lazy, explicit opening uses exact selected count and equivalent props do not reload', async () => {
  const h = harness(); await h.settle(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 0);
  h.render({ ...h.props(), input: structuredClone(h.fixture.input), group: structuredClone(h.fixture.group) });
  h.click('Show records'); await h.wait(0);
  assert.deepEqual(h.calls[0].population, { group: 'selected', kind: 'stock' });
  assert.deepEqual(h.calls[0].page, { limit: 50, after_member_id: null });
  await h.complete(); assert.match(h.text(), /CAD account A000/); assert.match(h.text(), /records 1–2 of 2/);
  h.render({ ...h.props(), memberTransport: (...args) => h.transport(...args) }); await h.settle(); assert.equal(h.calls.length, 1);
  h.click('Hide records'); assert.doesNotMatch(h.text(), /CAD account A000/); h.click('Show records'); await h.settle();
  assert.equal(h.calls.length, 1); assert.match(h.text(), /CAD account A000/); h.unmount();
});

test('an explicit empty selection stays empty without querying all accounts or another population', async () => {
  const h = harness(fixture({ empty: true })); h.click('Show records'); await h.settle();
  assert.equal(h.calls.length, 0); assert.match(h.text(), /No records in this population/);
  h.population('transactions'); h.population('source_reported'); await h.settle(); assert.equal(h.calls.length, 0); h.unmount();
});

test('all 103 CAD accounts remain reachable with only 50 rows rendered and compact back navigation', async () => {
  const h = harness(fixture({ accountCount: 103 })); h.click('Show records'); await h.wait(0); await h.complete();
  const records = () => h.nodes().filter(node => node.type === 'ol' && node.props['aria-label'] === 'Captured records')[0].props.children.length;
  assert.equal(records(), 50); assert.equal(h.button('Previous page').props.disabled, true);
  h.click('Next page'); await h.wait(1); assert.notEqual(h.calls[1].page.after_member_id, null); await h.complete();
  assert.equal(records(), 50); assert.match(h.text(), /records 51–100 of 103/); assert.doesNotMatch(h.text(), /CAD account A000/);
  h.click('Previous page'); await h.wait(2); assert.equal(h.calls[2].page.after_member_id, null); await h.complete();
  assert.match(h.text(), /records 1–50 of 103/); h.click('Next page'); await h.wait(3); await h.complete();
  h.click('Next page'); await h.wait(4); await h.complete(); assert.equal(records(), 3);
  assert.match(h.text(), /records 101–103 of 103/); assert.equal(h.button('Next page').props.disabled, true);
  h.click('Previous page'); await h.wait(5); assert.equal(h.calls[5].page.after_member_id, h.calls[1].page.after_member_id); await h.complete();
  assert.match(h.text(), /records 51–100 of 103/); assert.equal(records(), 50); h.unmount();
});

test('population switching uses independent original counts and preserves zero, unknown units and safe identities', async () => {
  const h = harness(); h.click('Show records'); await h.wait(0); await h.complete();
  assert.match(h.text(), /missing/); assert.match(h.text(), /1,800\.12/);
  h.population('transactions'); await h.wait(1); assert.deepEqual(h.calls[1].page, { limit: 50, after_member_id: null }); await h.complete();
  assert.match(h.text(), /Transaction observation 1/); assert.match(h.text(), /in period/); assert.match(h.text(), /330,000\.13/);
  assert.doesNotMatch(h.text(), /CAD account A000|PRIVATE_|8000000|9000000/);
  h.population('source_reported'); await h.wait(2); await h.complete();
  assert.match(h.text(), /Source record 1/); assert.match(h.text(), /0 observed|observed/); assert.match(h.text(), /Unit not established/);
  const dayRow = h.nodes().find(node => node.type === 'tr' && text(node).includes('Source-reported days on market'));
  assert.ok(dayRow); assert.match(text(dayRow), /0observed/);
  assert.doesNotMatch(h.text(), /PRIVATE_|\$|USD|verified comparable/);
  h.population('omitted_transactions'); await h.wait(3); await h.complete();
  assert.match(h.text(), /outside period/); assert.match(h.text(), /missing date/);
  assert.match(h.text(), /records 1–2 of 2/); h.unmount();
});

test('pause aborts an admitted request and never retries automatically on release', async () => {
  const h = harness(); h.click('Show records'); await h.wait(0); h.render({ ...h.props(), paused: true });
  assert.equal(h.calls[0].signal.aborted, true); assert.match(h.text(), /inspection is paused/);
  await h.complete(0); assert.doesNotMatch(h.text(), /CAD account A000/);
  h.click('Retry records', true); await h.settle(); assert.equal(h.calls.length, 1);
  h.render(h.props()); await h.settle(); assert.equal(h.calls.length, 1);
  h.click('Retry records'); await h.wait(1); await h.complete(); assert.match(h.text(), /CAD account A000/); h.unmount();
});

test('paused completed pages remain visible; every new read action is disabled until release', async () => {
  const h = harness(fixture({ accountCount: 51 })); h.click('Show records'); await h.wait(0); await h.complete();
  h.render({ ...h.props(), paused: true }); assert.match(h.text(), /CAD account A000/);
  h.click('Next page', true); h.population('transactions'); await h.settle(); assert.equal(h.calls.length, 1);
  h.click('Hide records'); h.click('Show records', true); assert.equal(h.button('Show records').props.disabled, true);
  h.render(h.props()); h.click('Show records'); await h.settle(); assert.equal(h.calls.length, 1); h.unmount();
});

test('hidden and superseded population requests cannot publish late responses', async () => {
  const h = harness(); h.click('Show records'); await h.wait(0); h.click('Hide records'); assert.equal(h.calls[0].signal.aborted, true);
  await h.complete(0); h.click('Show records'); await h.wait(1);
  h.population('source_reported'); await h.wait(2); assert.equal(h.calls[1].signal.aborted, true);
  await h.complete(1); assert.doesNotMatch(h.text(), /CAD account A000/); await h.complete(2); assert.match(h.text(), /Source record 1/); h.unmount();
});

for (const [label, changed] of [['file', { assignmentFileId: '18' }], ['context', { hash: 'b' }], ['revision', { revision: 8 }], ['empty', { empty: true }]]) {
  test(`a changed ${label} remounts closed, clears rows and ignores the prior request`, async () => {
    const h = harness(); h.click('Show records'); await h.wait(0);
    const f = fixture(changed); h.render({ input: f.input, group: f.group, memberTransport: h.transport });
    assert.equal(h.calls[0].signal.aborted, true); assert.equal(h.button('Show records').props['aria-expanded'], false);
    await h.complete(0); await h.settle(); assert.equal(h.calls.length, 1); assert.doesNotMatch(h.text(), /CAD account A000/); h.unmount();
  });
}

test('changed account membership at reused revision invalidates the old page; mismatched fingerprint never reaches transport', async () => {
  const h = harness(); h.click('Show records'); await h.wait(0); await h.complete();
  const input = structuredClone(h.fixture.input); input.selection.pockets[0].account_ids = ['A000'];
  h.render({ ...h.props(), input }); assert.doesNotMatch(h.text(), /CAD account A000/);
  h.click('Show records'); await h.settle(); assert.equal(h.calls.length, 1); assert.match(h.text(), /could not be verified/); h.unmount();
});

test('genuine failures do not loop or expose errors; retry is one explicit request', async () => {
  const h = harness(); h.click('Show records'); await h.wait(0); await h.fail();
  assert.match(h.text(), /could not be verified or loaded/); assert.doesNotMatch(h.text(), /PRIVATE_DATABASE/);
  h.render({ ...h.props() }); await h.settle(); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
  h.click('Retry records'); await h.wait(1); await h.complete(); assert.match(h.text(), /CAD account A000/); h.unmount();
});

test('deadline is finite and a response arriving after timeout cannot replace the checked prior page', async () => {
  const h = harness(fixture({ accountCount: 51 })); h.click('Show records'); await h.wait(0); await h.complete();
  h.click('Next page'); await h.wait(1); await h.timeout(); assert.equal(h.calls[1].signal.aborted, true);
  assert.match(h.text(), /records 1–50 of 51/); await h.complete(1); assert.match(h.text(), /records 1–50 of 51/);
  assert.doesNotMatch(h.text(), /records 51–51/); h.click('Retry records'); await h.wait(2); await h.complete();
  assert.match(h.text(), /records 51–51 of 51/); h.unmount();
});

for (const [label, change] of [
  ['count', value => { value.page.total_count++; }],
  ['capture date', value => { value.page.captured_at = '2026-09-08T12:00:00.123Z'; }],
  ['effective date', value => { value.page.effective_date = '2024-06-29'; }],
  ['private identity', value => { value.page.members[0].source_record_id = 'PRIVATE_EXTRA'; }],
  ['geometry', value => { value.parcel_map = {}; }],
]) test(`a response with changed ${label} cannot replace the summary-bound record list`, async () => {
  const h = harness(); h.click('Show records'); await h.wait(0);
  await h.complete(0, raw => { const value = structuredClone(raw); change(value); return value; });
  assert.match(h.text(), /could not be verified/); assert.doesNotMatch(h.text(), /CAD account A000|PRIVATE_EXTRA/); h.unmount();
});

test('returning to page one still rejects an inconsistent population identity', async () => {
  const h = harness(fixture({ accountCount: 51 })); h.click('Show records'); await h.wait(0); await h.complete();
  h.click('Next page'); await h.wait(1); await h.complete(); h.click('Previous page'); await h.wait(2);
  await h.complete(2, raw => { const value = structuredClone(raw); value.page.population_id = `population:${'c'.repeat(64)}`; return value; });
  assert.match(h.text(), /could not be verified/); assert.match(h.text(), /records 51–51 of 51/); h.unmount();
});

test('malformed inspection descriptors never default to all or zero and unmount aborts the last caller', async () => {
  const h = harness(), group = structuredClone(h.fixture.group); group.summary.selected.stock.inspection.population.group = 'all';
  h.render({ ...h.props(), group }); assert.match(h.text(), /unavailable for this summary/); await h.settle(); assert.equal(h.calls.length, 0);
  h.render(h.props()); h.click('Show records'); await h.wait(0); h.unmount(); assert.equal(h.calls[0].signal.aborted, true);
  await h.complete(0); assert.equal(h.timers.size, 0);
});
