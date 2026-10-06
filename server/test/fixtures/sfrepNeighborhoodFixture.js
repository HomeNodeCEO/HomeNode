// Deliberately synthetic. No client files, vendor dictionary contents or real
// address/account data are needed to test these report field mappings.
export function sfrepNeighborhoodFixture() {
  const ref = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
  const binding = { context_ref: ref, selection_revision: 4, selection_sha256: 'b'.repeat(64) };
  const identity = JSON.stringify([ref.context_id, ref.context_revision, ref.context_sha256, 4, binding.selection_sha256]);
  const categories = ['one_unit', 'two_to_four_unit', 'multifamily', 'commercial', 'other_vacant'].map((key, index) => ({ key, percent: [60, 0, 0, 20, 20][index], parcel_count: [3, 0, 0, 1, 1][index] }));
  return { accountId: 'synthetic-account', assignmentFileId: 7, assignmentRevision: 2, documents: [],
    assignmentDetails: { neighborhood_location_type: 'suburban', subject_neighborhood_summary: 'Synthetic neighborhood & competing areas.' },
    subject: { revision: 0, value: {} }, evidence: { revision: 0, value: {} },
    workspace: { revision: 5, value: { active: { context_ref: ref, selection: { revision: 4, included_recorded_group_ids: ['fixture'] } }, pending_capture: null } },
    market: { revision: 3, value: {
      response: { exploration_binding: binding, analyses: [
        { market: { key: 'zip' }, recent_periods: [{ months: 12, median_days_on_market: 50 }] },
        { market: { key: 'exploration' }, recent_periods: [{ months: 12, median_days_on_market: 70 }] },
        { market: { key: 'radius_2' }, recent_periods: [{ months: 12, median_days_on_market: 200 }] },
      ] }, reconciliation: { reliedUponAreaKeys: ['zip', 'exploration'], trendConclusion: 'stable', explanation: 'Selected ZIP & Exploration Map Area indicate stable conditions.' },
      neighborhoodForm: { explorationIdentity: identity, builtUp: '', growth: 'stable', demandSupply: 'in_balance', boundaries: 'Selected parcels & edge-sharing neighbors.',
        priceLow: '200', priceHigh: '450', pricePredominant: '300', ageLow: '5', ageHigh: '75', agePredominant: '60' },
      landUse: { explorationIdentity: identity, methodology_version: 'selected-parcels-edge-neighbors-v1', analyzed_at: '2026-10-06T00:00:00Z', source_updated_at: '2026-10-01',
        selected_parcel_count: 3, neighbor_parcel_count: 2, parcel_count: 5, missing_selected_accounts: 0, review_required_count: 0,
        area_acres: 10, built_up_percent: 80, built_up_band: 'over_75', unknown_percent: 0, categories,
        denominator_note: 'Dissolved synthetic parcels only.', warnings: ['Current land use is not verified historical land use.'] },
    } },
  };
}
