import assert from 'node:assert/strict';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import * as viewportLoader from '../src/features/neighborhood/customCohortViewportLoader.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { selectionMemberFixture } from '../../server/test/fixtures/customCohortSelectionMemberFixture.js';
import { presentCustomCohortGroupMapOpening } from '../../server/src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';
import { canonicalAssessmentJson } from '../../server/src/services/neighborhoodAssessment/contract.js';

const load = (name, modules) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(modules, key), `unexpected member view import ${key}`); return modules[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
export const displayModule = load('customCohortGroupDisplay', { './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection });
export const mapView = load('customCohortGroupMapView', { './customCohortGroupDisplay.ts': displayModule,
  './customCohortViewportLoader.ts': viewportLoader });
export const memberView = load('customCohortGroupMemberView', { './customCohortGroupDisplay.ts': displayModule,
  './customCohortMemberPage.ts': await import('../src/features/neighborhood/customCohortMemberPage.ts') });
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 65_000 });

/** Actual retained mapping/numeric/member/opening producers through checked
 * browser transport and composition. Not PostgreSQL/current-source proof. */
export async function groupMemberViewFixture(options = {}) {
  const accountId = '10000000000000000';
  const f = await selectionMemberFixture({ accountId, assignmentFileId: '37', ...options });
  const ref = f.request.selection_ref, A = `recorded-cad:${'a'.repeat(64)}`, included = options.empty ? [] : [A];
  const rawCatalog = { status: 'catalog', subject_freshness: 'matched', target: { account_id: accountId, assignment_file_id: f.request.assignment_file_id },
    context_ref: f.request.context_ref, selection_revision: ref.selection_revision, apply: { status: 'blocked' },
    catalog: { catalog_version: 3, status: 'review_only', catalog_complete: true, authority: 'not_established', apply: { status: 'blocked' },
      binding: { context_ref: f.request.context_ref, selection_revision: ref.selection_revision },
      subject_membership: { account_id: accountId, assigned_pocket_id: A, recorded_label_match_only: true, status: 'recorded' },
      pockets: [{ id: A, label: 'Synthetic recorded group', county: 'Dallas', member_count: f.accounts.length - 1,
        account_ids: f.accounts.slice(0, -1), disposition: 'needs_review' }],
      unassigned: { account_ids: f.accounts.slice(-1), member_count: 1, reason_counts: [] },
      coverage: { discovery_member_count: f.accounts.length, assigned_account_count: f.accounts.length - 1, unassigned_account_count: 1 }, limitations: [] } };
  const catalog = catalogHelpers.checkCustomCohortPocketCatalog(rawCatalog, { accountId, assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selection: { revision: ref.selection_revision, pockets: [] } });
  const scope = { organization_id: '70000000-0000-4000-8000-000000000004',
    report_file_id: '70000000-0000-4000-8000-000000000005', assignment_file_id: f.request.assignment_file_id, account_id: accountId };
  const manifest = { status: 'unavailable', context_ref: f.request.context_ref,
    geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary', reason: 'geometry_missing' };
  const opening = { status: 'opening', authority: 'not_established', selection_ref: ref,
    map_opening: presentCustomCohortGroupMapOpening({ scopeJson: canonicalAssessmentJson(scope), contextRef: f.request.context_ref,
      selectionRef: ref, catalog: rawCatalog.catalog, manifest }) };
  const numeric = { status: 'preview', authority: 'not_established', target: f.result.target, context_ref: f.request.context_ref,
    selection_ref: ref, selection_revision: ref.selection_revision, subject_freshness: 'matched', summary: f.summary,
    parcel_map: { status: 'omitted', reason: 'geometry_not_requested' }, apply: f.result.apply,
    ...(f.result.private_sales ? { private_sales: f.result.private_sales } : {}) };
  const calls = [];
  const ports = selection.createCustomCohortRecordedGroupTransport({ urlFor: path => `https://example.invalid${path}`,
    request: async (url, init) => { const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push({ action, body, signal: init.signal });
      if (action === 'selection-preview') return json(numeric);
      if (action === 'selection-map-opening') return json(opening);
      assert.equal(action, 'selection-members'); return options.respond ? options.respond(f, body, init) : json(f.resultFor(body.population, body.page));
    } });
  const saved = { status: 'selected', authority: 'not_established', context_ref: f.request.context_ref, selection_ref: ref,
    included_recorded_group_ids: included };
  const value = { target: { accountId, assignmentFileId: f.request.assignment_file_id, sessionKey: 'member-view-session' },
    workspaceRevision: 5, checkpoint: { workspace_version: 7, active: { context_ref: f.request.context_ref, selection_ref: ref,
      observation_period: f.summary.observation_period }, pending_capture: null }, catalog, selected: saved };
  const display = await displayModule.createCustomCohortGroupDisplayReader(ports)(value, io());
  return { ...f, value, display, calls, reader: memberView.createCustomCohortGroupMemberReader(ports),
    readerFrom(request) { return memberView.createCustomCohortGroupMemberReader(selection.createCustomCohortRecordedGroupTransport({
      urlFor: path => `https://example.invalid${path}`, request })); } };
}
