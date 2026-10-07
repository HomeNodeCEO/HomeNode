import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortPreparedStatisticsReader as reader, requireCustomCohortPreparedStatisticsDisplay as requireDisplay }
  from '../src/features/neighborhood/customCohortPreparedStatisticsDisplay.ts';
import { createCustomCohortPreparedCatalogClient as catalog, createCustomCohortPreparedCatalogRecheck as currentCatalog }
  from '../src/features/neighborhood/customCohortPreparedCatalogClient.ts';
import { createCustomCohortRecordedGroupTransport as selectedTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { customCohortPreparedCatalogSqlFixture as fixture } from '../../server/test/fixtures/customCohortPreparedCatalogSqlFixture.js';
import { customCohortPreparedCatalogRegistryFixture as originals } from '../../server/test/fixtures/customCohortPreparedCatalogRegistryFixture.js';
import { prepareCustomCohortPreparedCatalogRequest as prepare, presentCustomCohortPreparedCatalogResponse as present }
  from '../../server/src/services/neighborhoodAssessment/customCohortPreparedCatalogTransport.js';
import { prepareCustomCohortRecordedGroupSelection as compile } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store as store } from '../../server/src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { prepareNeighborhoodCohortBlob as blob } from '../../server/src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as canonical } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { reselectCustomCohortIndexedObservationPreview as reselect } from '../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { presentCustomCohortPreview as summary } from '../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 30_000 });
async function harness({ mode = 'some', hook } = {}) {
  const h = fixture(originals({ count: 501, groupCount: 7 })); await h.make().prepare();
  const choices = mode === 'empty' ? [] : mode === 'unresolved' ? ['discovery:unassigned']
    : mode === 'all' ? [...h.f.catalog.pockets.map(p => p.id), 'discovery:unassigned'].sort()
      : h.f.catalog.pockets.slice(0, 2).map(p => p.id).sort();
  const source = await compile({ scopeJson: canonical(h.f.scope), contextJson: canonical(h.f.context),
    catalogJson: JSON.stringify(h.f.catalog), rosterJson: JSON.stringify({ account_ids: h.f.preview.all.account_ids }),
    includedGroupIds: choices, revision: 2, catalogIdentityVersion: 2 });
  const savedOriginals = new Map(), repository = { async put(text) { const r = blob(text); savedOriginals.set(r.content_sha256, text); return r; },
    async get(hash) { return savedOriginals.get(hash) ?? null; } };
  const staged = await store(repository).stage({ metadataJson: source.metadata_json, membershipPages: source.membershipPages() });
  assert.deepEqual(await store(repository).verify({ metadataJson: source.metadata_json, manifestRef: staged.manifest_ref }), staged);
  const rows = []; for await (const page of source.membershipPages()) rows.push(...page);
  const accounts = [...new Set(rows.map(r => r.account_id))].sort();
  const preview = reselect(h.f.preview, { revision: 2, pockets: accounts.length
    ? [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts }] : [] });
  const numeric = summary({ preview, expected: { context_ref: h.f.context, selection_revision: 2 } });
  assert.equal(numeric.binding.selection_sha256, staged.selection_sha256);
  const selectionRef = { selection_version: 1, selection_revision: 2, selection_sha256: staged.selection_sha256, manifest_ref: staged.manifest_ref };
  const receipt = { status: 'selected', authority: 'not_established', context_ref: h.f.context,
    selection_ref: selectionRef, included_recorded_group_ids: choices };
  const value = { target: { accountId: h.f.scope.account_id, assignmentFileId: h.f.scope.assignment_file_id, sessionKey: 'test-session' },
    workspaceRevision: 5, contextRef: h.f.context, selectionRef, observationPeriod: numeric.observation_period };
  const numerical = { status: 'preview', authority: 'not_established', target: { account_id: value.target.accountId,
    assignment_file_id: value.target.assignmentFileId }, context_ref: h.f.context, selection_ref: selectionRef,
    selection_revision: 2, subject_freshness: 'matched', summary: numeric,
    parcel_map: { status: 'omitted', reason: 'geometry_not_requested' }, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
  const calls = [], options = { urlFor: p => `https://example.invalid${p}`, request: async (url, init) => {
    const action = url.slice(url.lastIndexOf('/') + 1), body = JSON.parse(init.body), call = { action, body, init }; calls.push(call);
    let out;
    if (action === 'group-selection') out = receipt;
    else if (action === 'selection-preview') out = numerical;
    else {
      assert.ok(['prepared-catalog', 'prepared-catalog-page'].includes(action));
      const paged = action.endsWith('-page');
      out = present({ status: 'available', authority: 'not_established', target: numerical.target, context_ref: h.f.context,
        catalog: paged ? await h.make().page(body.page_index) : await h.make().open(), ...(paged ? { page_index: body.page_index } : {}) },
      prepare(body, paged), value.target.accountId, paged);
    }
    return hook ? hook({ out: structuredClone(out), call, calls, h }) : json(out);
  } };
  const selected = selectedTransport(options), ports = { catalog: catalog(options), currentCatalog: currentCatalog(options),
    read: selected.read, preview: selected.preview };
  return { h, value, ports, run: reader(ports), calls, numerical, receipt, accounts };
}

test('prepared statistics compose actual complete partition, retained selection and unchanged whole-population numeric projection', async () => {
  const h = await harness(), options = io(), result = await h.run(h.value, options), d = requireDisplay(result.display);
  assert.equal(result.status, 'available'); assert.equal(d.catalog.account_count, 501);
  // The established JSON wire encodes -0 as 0. Compare the actual entire wire
  // value; this display must not change any serialized numeric observations.
  assert.equal(JSON.stringify(d.observations.summary), JSON.stringify(h.numerical.summary));
  assert.equal(d.observations.summary.selected.account_count, h.accounts.length);
  assert.deepEqual(d.selected, h.receipt); assert.equal(Object.hasOwn(d, 'manifest'), false);
  assert.equal(Object.hasOwn(d.catalog, 'pockets'), false); assert.equal(JSON.stringify(d).includes('"account_ids":'), false);
  assert.deepEqual(h.calls.map(c => c.action), ['prepared-catalog', 'prepared-catalog', 'prepared-catalog-page',
    'prepared-catalog', 'group-selection', 'selection-preview', 'prepared-catalog', 'group-selection']);
  assert.ok(h.calls.every(c => c.init.signal === options.signal && c.init.cache === 'no-store'));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(d.observation_period));
  assert.throws(() => requireDisplay(structuredClone(d)), /invalid_custom_cohort_prepared_statistics_display/);
});

test('empty, unresolved and whole-group choices preserve exact server medians/COD/missing/conflict values with no group-average math', async () => {
  for (const mode of ['empty', 'unresolved', 'all']) {
    const h = await harness({ mode }), result = await h.run(h.value, io());
    assert.equal(JSON.stringify(result.display.observations.summary), JSON.stringify(h.numerical.summary));
    assert.equal(result.display.observations.summary.selected.account_count, h.accounts.length);
    assert.equal(result.display.observations.summary.all.account_count, 501);
    assert.equal(result.display.selected.included_recorded_group_ids.length, h.receipt.included_recorded_group_ids.length);
  }
});

test('initial cache miss returns explicitly with no selection/numeric fallback; late loss publishes no earlier observations', async () => {
  for (const late of [false, true]) {
    const h = await harness({ hook: ({ out, calls, call }) => json(call.action === 'prepared-catalog'
      && (!late || calls.some(c => c.action === 'selection-preview')) ? { ...out, status: 'not_prepared', catalog: null } : out) });
    if (late) await assert.rejects(h.run(h.value, io()), /invalid_custom_cohort_prepared_statistics_display/);
    else { assert.deepEqual(await h.run(h.value, io()), { status: 'not_prepared' }); assert.equal(h.calls.length, 1); }
  }
});

test('current rights, immutable root/metadata and ending saved head/group changes discard the pending numeric result', async () => {
  for (const broken of ['rights', 'root', 'metadata', 'head', 'groups']) {
    const h = await harness({ hook: ({ out, calls, call }) => {
      const after = calls.some(c => c.action === 'selection-preview');
      if (after && call.action === 'prepared-catalog') {
        if (broken === 'rights') return json({ error: 'neighborhood_access_denied' }, 403);
        if (broken === 'root') out.catalog.manifest_ref.content_sha256 = 'f'.repeat(64);
        if (broken === 'metadata') out.catalog.metadata_json += ' ';
      }
      if (after && call.action === 'group-selection') {
        if (broken === 'head') out.selection_ref.selection_sha256 = 'f'.repeat(64);
        if (broken === 'groups') out.included_recorded_group_ids = [];
      }
      return json(out);
    } });
    await assert.rejects(h.run(h.value, io()));
    assert.equal(h.calls.filter(c => c.action === 'selection-preview').length, 1);
  }
});

test('unknown groups, mismatched actual numeric counts and requested periods do not become a statistics display', async () => {
  for (const broken of ['group', 'count', 'period']) {
    const h = await harness({ hook: ({ out, call }) => {
      if (broken === 'group' && call.action === 'group-selection') out.included_recorded_group_ids = [`recorded-cad:${'f'.repeat(64)}`];
      if (broken === 'count' && call.action === 'selection-preview') out.summary.selected.account_count++;
      return json(out);
    } });
    const value = broken === 'period' ? { ...h.value, observationPeriod: { start_date: '2020-01-01', end_date: '2020-12-31' } } : h.value;
    await assert.rejects(h.run(value, io()));
    assert.equal(h.calls.filter(c => c.action === 'selection-preview').length, broken === 'group' ? 0 : 1);
    assert.equal(h.calls.filter(c => c.action === 'group-selection').length, 1);
  }
});

test('closed caller intent, dates, accessors and cloned catalog receipts refuse before unauthorized work', async () => {
  const h = await harness();
  for (const bad of [{ ...h.value, target: { ...h.value.target, sessionKey: '' } }, { ...h.value, workspaceRevision: 0 },
    { ...h.value, account_ids: [] }, { ...h.value, observationPeriod: { start_date: '2024-02-30', end_date: '2024-06-30' } }])
    await assert.rejects(h.run(bad, io()));
  let getters = 0; const bad = Object.defineProperty({ ...h.value }, 'target', { enumerable: true,
    get() { getters++; return h.value.target; } });
  await assert.rejects(h.run(bad, io())); assert.equal(getters, 0); assert.equal(h.calls.length, 0);
  const loaded = await h.ports.catalog({ accountId: h.value.target.accountId, assignmentFileId: h.value.target.assignmentFileId,
    contextRef: h.value.contextRef }, io()), before = h.calls.length;
  await assert.rejects(h.ports.currentCatalog(structuredClone(loaded.catalog), io()), /invalid_custom_cohort_paged_catalog/);
  assert.equal(h.calls.length, before);
});

test('missing, null, array and scalar numeric populations refuse with the intentional statistics error', async () => {
  for (const population of ['all', 'selected']) {
    for (const invalid of [undefined, null, [], 0, false, 'population']) {
      const h = await harness({ hook: ({ out, call }) => {
        if (call.action === 'selection-preview') {
          if (invalid === undefined) delete out.summary[population];
          else out.summary[population] = invalid;
        }
        return json(out);
      } });
      await assert.rejects(h.run(h.value, io()), {
        name: 'TypeError', message: 'invalid_custom_cohort_prepared_statistics_display',
      });
      assert.equal(h.calls.at(-1).action, 'selection-preview');
    }
  }
});

test('target/ref/period/deadline aliases are pinned before authentication while host/session authority remains external', async () => {
  let entered, release;
  const ready = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const h = await harness({ hook: async ({ out, calls }) => { if (calls.length === 1) { entered(); await held; } return json(out); } });
  const value = structuredClone(h.value), options = io(), pending = h.run(value, options);
  await ready; value.target.sessionKey = 'new-session'; value.target.accountId = 'foreign'; value.selectionRef.selection_sha256 = 'f'.repeat(64);
  value.observationPeriod.start_date = '2020-01-01'; options.deadline = 0; release();
  const d = (await pending).display; assert.deepEqual(d.target, h.value.target); assert.deepEqual(d.observation_period, h.value.observationPeriod);
  assert.ok(!Object.isFrozen(value.target));
});

test('caller cancellation/deadline at actual numeric settlement prevents subsequent fences and any display delivery', async () => {
  const h = await harness(); await assert.rejects(h.run(h.value, { ...io(), deadline: performance.now() - 1 }), /custom_workspace_deadline/);
  assert.equal(h.calls.length, 0);
  const abort = new AbortController(), cancelled = await harness({ hook: ({ out, call }) => {
    if (call.action === 'selection-preview') abort.abort(); return json(out);
  } });
  await assert.rejects(cancelled.run(cancelled.value, { signal: abort.signal, deadline: performance.now() + 30000 }), { name: 'AbortError' });
  assert.equal(cancelled.calls.at(-1).action, 'selection-preview');
  let now = performance.now(); const originalNow = performance.now;
  try {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    const late = await harness({ hook: ({ out, call }) => { if (call.action === 'selection-preview') now += 1000; return json(out); } });
    await assert.rejects(late.run(late.value, { signal: new AbortController().signal, deadline: now + 500 }), /custom_workspace_deadline/);
    assert.equal(late.calls.at(-1).action, 'selection-preview');
  } finally { delete performance.now; assert.equal(performance.now, originalNow); }
});
