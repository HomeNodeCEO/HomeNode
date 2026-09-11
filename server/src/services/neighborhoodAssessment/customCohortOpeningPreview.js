import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';

// One bounded catalog (4MB) plus one bounded map/summary preview (27MB).
// The individual views retain their limits; only the explicit opening response
// may carry both. Nothing is cached across requests or authorization decisions.
export const CUSTOM_COHORT_OPENING_RESPONSE_BYTES = 31_000_000;
export const CUSTOM_COHORT_OPENING_PREVIEW_BYTES = 27_000_000;

export function prepareCustomCohortOpeningGroups(value) {
  try { return prepareCustomNeighborhoodRecordedGroupIds(value); }
  catch { throw Object.assign(new TypeError('custom_cohort_invalid_input'), { reason: 'invalid_input' }); }
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
