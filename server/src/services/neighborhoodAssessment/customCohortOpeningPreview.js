import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';

// One bounded catalog (4MB) plus one bounded dense map/summary preview (35MB).
// The individual views retain their limits; only the explicit opening response
// may carry both. Nothing is cached across requests or authorization decisions.
export const CUSTOM_COHORT_OPENING_RESPONSE_BYTES = 39_000_000;
export const CUSTOM_COHORT_OPENING_PREVIEW_BYTES = 35_000_000;

export function prepareCustomCohortOpeningMode(value) {
  if (value !== 'all_catalog_groups') {
    throw Object.assign(new TypeError('custom_cohort_invalid_input'), { reason: 'invalid_input' });
  }
  return value;
}

export function prepareCustomCohortOpeningGroups(value) {
  try { return prepareCustomNeighborhoodRecordedGroupIds(value); }
  catch { throw Object.assign(new TypeError('custom_cohort_invalid_input'), { reason: 'invalid_input' }); }
}

export function customCohortOpeningGroupIds(catalog) {
  return [...catalog.pockets.map(pocket => pocket.id),
    ...(catalog.unassigned.member_count ? ['discovery:unassigned'] : [])];
}

export function customCohortOpeningSelection(catalog, groups, revision) {
  const members = new Map(catalog.pockets.map(pocket => [pocket.id, pocket.account_ids]));
  if (catalog.unassigned.member_count) members.set('discovery:unassigned', catalog.unassigned.account_ids);
  const accounts = [];
  for (const id of groups) {
    if (!members.has(id)) throw Object.assign(new TypeError('custom_cohort_invalid_selection'), { reason: 'invalid_selection' });
    accounts.push(...members.get(id));
  }
  accounts.sort();
  return { revision, pockets: accounts.length
    ? [{ id: 'discovery:selected', label: 'Selected observations', account_ids: accounts }] : [] };
}
