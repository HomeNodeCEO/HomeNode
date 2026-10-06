import { selectionSummaryTransportFixture } from './customCohortSelectionSummaryTransportFixture.js';
import { buildCustomCohortMapManifest } from '../../src/services/neighborhoodAssessment/customCohortMapManifest.js';
import { presentCustomCohortGroupMapOpening } from '../../src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';
import { canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';

export async function selectionMapOpeningFixture(options = {}) {
  const accountId = options.accountId ?? '10000000000000000';
  const f = await selectionSummaryTransportFixture({ ...options, accountId });
  const accounts = ['10000000000000000', '10000000000000001', '10000000000000002'];
  const ids = ['a', 'b'].map(letter => `recorded-cad:${letter.repeat(64)}`);
  const catalog = { catalog_version: 3, status: 'review_only', catalog_complete: true, authority: 'not_established',
    apply: { status: 'blocked' }, binding: { context_ref: f.request.context_ref, selection_revision: 1 },
    subject_membership: { account_id: accountId, assigned_pocket_id: ids[0], recorded_label_match_only: true, status: 'recorded' },
    pockets: [{ id: ids[0], label: 'One', county: 'Dallas', member_count: 2, account_ids: accounts.slice(0, 2) },
      { id: ids[1], label: 'Two', county: 'Dallas', member_count: 1, account_ids: accounts.slice(2) }],
    unassigned: { account_ids: [], member_count: 0 } };
  const features = [-97, -96.9, -96.98].map((x, i) => ({ type: 'Feature', id: `gis.dcad_parcels:${i + 1}`,
    properties: { object_id: String(i + 1), account_id: accounts[i], selected: false },
    geometry: { type: 'Polygon', coordinates: [[[x, 32], [x + .001, 32], [x + .001, 32.001], [x, 32.001], [x, 32]]] } }));
  const manifest = buildCustomCohortMapManifest(catalog, { status: 'available',
    geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
    geojson: { type: 'FeatureCollection', features }, counts: { accounts: 3, parcels: 3 } });
  const scope = { organization_id: '70000000-0000-4000-8000-000000000004',
    report_file_id: '70000000-0000-4000-8000-000000000005', assignment_file_id: f.request.assignment_file_id, account_id: accountId };
  const projection = { scopeJson: canonicalAssessmentJson(scope), contextRef: f.request.context_ref,
    selectionRef: f.request.selection_ref, catalog, manifest };
  const map_opening = presentCustomCohortGroupMapOpening(projection);
  const saved = { status: 'selected', authority: 'not_established', context_ref: f.request.context_ref,
    selection_ref: f.request.selection_ref, included_recorded_group_ids: options.empty ? [] : [ids[0]] };
  return { request: f.request, summary: f.result.summary, accountId, catalog, projection, saved,
    result: { status: 'opening', authority: 'not_established', selection_ref: f.request.selection_ref, map_opening } };
}
