import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import * as market from '../src/features/neighborhood/customCohortGroupMarketTransport.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { selectionMapOpeningFixture } from '../../server/test/fixtures/customCohortSelectionMapOpeningFixture.js';
import { selectionSummaryTransportFixture } from '../../server/test/fixtures/customCohortSelectionSummaryTransportFixture.js';
import { completeCalendarMonthWindow } from '../../server/src/services/marketConditions.js';

const load = (name, dependencies) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(dependencies, key), `unexpected market-view import ${key}`); return dependencies[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
const displayModule = load('customCohortGroupDisplay', { './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection });
const { createCustomCohortGroupMarketReader: create } = load('customCohortGroupMarketView', {
  './customCohortGroupDisplay.ts': displayModule, './customCohortGroupMarketTransport.ts': market });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60000 });
const window = () => ({ asOf: '2026-10-31', periodMonths: 12, contextOverride: null });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(options = {}) {
  const f = await selectionMapOpeningFixture({ assignmentFileId: '37', ...options });
  const summary = await selectionSummaryTransportFixture({ accountId: f.accountId, assignmentFileId: '37', ...options });
  const raw = { status: 'catalog', subject_freshness: 'matched', target: { account_id: f.accountId, assignment_file_id: f.request.assignment_file_id },
    context_ref: f.request.context_ref, selection_revision: f.request.selection_ref.selection_revision, apply: { status: 'blocked' },
    catalog: { ...f.catalog, binding: { ...f.catalog.binding, selection_revision: f.request.selection_ref.selection_revision },
      pockets: f.catalog.pockets.map(p => ({ ...p, disposition: 'needs_review' })), unassigned: { ...f.catalog.unassigned, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 3, unassigned_account_count: 0 }, limitations: [] } };
  const catalog = catalogHelpers.checkCustomCohortPocketCatalog(raw, { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selection: { revision: f.request.selection_ref.selection_revision, pockets: [] } });
  const ports = selection.createCustomCohortRecordedGroupTransport({ urlFor: p => p, request: async url => {
    assert.ok(url.endsWith('/selection-preview') || url.endsWith('/selection-map-opening'));
    return json(url.endsWith('/selection-preview') ? summary.result : f.result);
  } });
  const display = await displayModule.createCustomCohortGroupDisplayReader(ports)({
    target: { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id, sessionKey: 'synthetic-session' }, workspaceRevision: 5,
    checkpoint: { workspace_version: 7, pending_capture: null, active: { context_ref: f.request.context_ref,
      selection_ref: f.request.selection_ref, observation_period: summary.result.summary.observation_period } }, catalog, selected: f.saved }, io());
  return { f, display };
}
function response(input) {
  const p = completeCalendarMonthWindow(input.asOf, input.periodMonths);
  return { subject: { account_id: input.accountId }, analyses: [{ market: { key: 'exploration', scope: 'exploration' },
    period: { start: p.start, end: p.end }, population: { eligible_sale_count: 0, mapped_sale_count: 0 },
    filters: { record_type: 'closed_sale', period_months: p.periodMonths, analysis_as_of: p.analysisAsOf,
      complete_calendar_months: true, partial_as_of_month_excluded: p.partialMonthExcluded } }],
    recommendation: { conclusion: 'insufficient' }, unavailable_areas: [], independence_notice: 'Independent study.',
    exploration_binding: { context_ref: input.contextRef, selection_revision: input.selectionRef.selection_revision,
      selection_sha256: input.selectionRef.selection_sha256 }, exploration_selection_ref: input.selectionRef };
}

test('actual composed display feeds exactly one checked original reference and independent study window to the actual market transport', async () => {
  const { display } = await fixture(), calls = [], options = io();
  const reader = create(market.createCustomCohortGroupMarketTransport({ urlFor: p => p, request: async (url, init) => {
    calls.push({ url, init }); const r = JSON.parse(init.body);
    return json(response({ accountId: display.target.accountId, contextRef: r.context_ref, selectionRef: r.selection_ref,
      asOf: r.as_of, periodMonths: r.period_months }));
  } }));
  const out = await reader(display, window(), options);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/selection-market-analysis'));
  assert.equal(calls[0].init.signal, options.signal); assert.deepEqual(out.exploration_selection_ref, display.active.selection_ref);
  assert.equal(out.analyses[0].filters.analysis_as_of, '2026-10-31');
  assert.doesNotMatch(calls[0].init.body, /account_ids|pockets|viewport|geometry|sessionKey|workspace_revision/);
  assert.notEqual(out.analyses[0].period.end, display.active.observation_period.end_date);
});

test('clone/raw/legacy displays, malformed windows and expired/aborted callers cannot invoke a port', async () => {
  const { display } = await fixture(); let calls = 0;
  const reader = create(async input => { calls++; return response(input); });
  for (const value of [structuredClone(display), { ...display }, { binding: display.observations.binding }, null])
    await assert.rejects(reader(value, window(), io()), /invalid_custom_cohort_group_display/);
  await assert.rejects(reader(display, { ...window(), asOf: '' }, io()));
  await assert.rejects(reader(display, window(), { ...io(), deadline: 0 }), /custom_workspace_deadline/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(reader(display, window(), { ...io(), signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('late settlement retains detached window/reference and refuses cancellation, deadline and altered-port replies', async () => {
  const { display } = await fixture();
  for (const ending of ['window_mutated', 'cancelled', 'deadline', 'foreign_reference']) {
    let release, admitted; const pending = new Promise(resolve => { release = resolve; });
    const reader = create(async input => { admitted = input; return pending; });
    const controller = new AbortController(), options = { ...io(), signal: controller.signal }, study = window();
    study.contextOverride = { source: 'manual', city: 'Garland' };
    const running = reader(display, study, options);
    study.asOf = '2020-01-01'; study.contextOverride.city = 'Changed';
    assert.equal(admitted.asOf, '2026-10-31'); assert.equal(admitted.contextOverride.city, 'Garland');
    assert.ok(Object.isFrozen(admitted) && Object.isFrozen(admitted.contextOverride));
    const out = response(admitted);
    if (ending === 'cancelled') controller.abort();
    if (ending === 'deadline') options.deadline = 0;
    if (ending === 'foreign_reference') out.exploration_selection_ref = { ...out.exploration_selection_ref, selection_sha256: 'd'.repeat(64) };
    release(out);
    if (ending === 'window_mutated') assert.equal((await running).analyses[0].filters.analysis_as_of, '2026-10-31');
    else await assert.rejects(running);
  }
});

test('deliberate empty display preserves its same reference and does not invent an all-groups or recommended fallback', async () => {
  const { display } = await fixture({ empty: true }); const calls = [];
  const reader = create(async input => { calls.push(input); return response(input); });
  const out = await reader(display, window(), io());
  assert.equal(display.observations.summary.selected.account_count, 0); assert.deepEqual(display.selected.included_recorded_group_ids, []);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].selectionRef, display.active.selection_ref);
  assert.equal(out.recommendation.conclusion, 'insufficient');
});
