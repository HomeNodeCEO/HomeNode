import { checkCustomCohortMapManifest } from './customCohortMapManifest.ts';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortRecordedGroupSummary } from './customCohortRecordedGroupTransport';

function fail(): never { throw new TypeError('invalid_custom_cohort_group_map_opening'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

/** Pin complete checked catalog display identity before asynchronous I/O.
 * No selected subset or viewport establishes a new analytical population. */
export function prepareCustomCohortGroupMapOpeningExpectation(catalog: CheckedPocketCatalog,
  capturedAccounts: ReadonlySet<string>, subjectAccount: string) {
  if (catalog.catalog_version !== 3 || catalog.status !== 'review_only'
    || catalog.subject_membership.account_id !== subjectAccount) fail();
  const groups = new Map(catalog.pockets.map(p => [p.id, {
    label: p.label, county: p.county, accounts: new Set(p.account_ids),
  }]));
  if (groups.size !== catalog.pockets.length) fail();
  return { groups, capturedAccounts: new Set(capturedAccounts), subjectAccount };
}

/** Bounds/labels are display-only. The separately bound complete summary and
 * viewport keep the same exact selection; this cannot authorize Apply. */
export function checkCustomCohortGroupMapOpening(value: unknown, request: CustomCohortRecordedGroupSummary,
  expected: ReturnType<typeof prepareCustomCohortGroupMapOpeningExpectation>) {
  const map = closed(value, ['display_only', 'target', 'context_ref', 'selection_revision', 'selection_sha256', 'manifest']);
  const target = closed(map.target, ['account_id', 'assignment_file_id']);
  if (map.display_only !== true || target.account_id !== request.accountId || target.assignment_file_id !== request.assignmentFileId
    || map.selection_revision !== request.selectionRef.selection_revision || map.selection_sha256 !== request.selectionRef.selection_sha256
    || JSON.stringify(closed(map.context_ref, ['context_id', 'context_revision', 'context_sha256'])) !== JSON.stringify(request.contextRef)) fail();
  const manifest = checkCustomCohortMapManifest(map.manifest, request.contextRef, request.accountId);
  if (manifest.status === 'available') {
    if (manifest.counts.captured_accounts !== expected.capturedAccounts.size
      || manifest.counts.captured_parcels < expected.capturedAccounts.size) fail();
    const seen = new Set<string>();
    for (const label of manifest.labels.features) {
      const p = label.properties, group = expected.groups.get(p.pocket_id);
      if (!group || group.label !== p.label || group.county !== p.county || !group.accounts.has(p.account_id)
        || !/^gis\.dcad_parcels:[0-9]+$/.test(p.parcel_id) || seen.has(p.pocket_id)) fail();
      seen.add(p.pocket_id);
    }
    for (const id of manifest.unlabelled_group_ids) {
      if (!expected.groups.has(id) || seen.has(id)) fail(); seen.add(id);
    }
    if (seen.size !== expected.groups.size
      || (expected.capturedAccounts.has(expected.subjectAccount) && !manifest.subject_parcels.length)
      || manifest.subject_parcels.some(p => !/^gis\.dcad_parcels:[0-9]+$/.test(p.parcel_id)
        || !expected.capturedAccounts.has(p.account_id))) fail();
  }
  return frozen(manifest);
}
