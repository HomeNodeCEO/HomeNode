import { customCohortMetricRunFixture } from './customCohortMetricRunFixture.js';
import { customCohortCatalogPageFixture } from './customCohortCatalogPageFixture.js';

/** Synthetic data through actual source chunking, indexed-preview builder and
 * complete partition compiler. No mock compiler receipt or live source grant. */
export function customCohortPreparedCatalogRegistryFixture({ count = 501, groupCount = 237, organization,
  scope: suppliedScope, context: suppliedContext } = {}) {
  const metric = customCohortMetricRunFixture({ count, organization, empty: true, selectionRevision: 1,
    targetOverride: suppliedScope ?? {}, contextRef: suppliedContext });
  const { input, preview } = metric, target = input.retained_inputs.subject.target;
  const scope = Object.fromEntries(['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'].map(k => [k, target[k]]));
  const context = input.context_ref;
  const display = customCohortCatalogPageFixture({ count, groupCount, organization: scope.organization_id });
  const remap = new Map(display.accounts.map((id, i) => [id, preview.all.account_ids[i]]));
  const catalog = structuredClone(display.catalog);
  catalog.binding.context_ref = context; catalog.subject_membership.account_id = scope.account_id;
  for (const p of catalog.pockets) p.account_ids = p.account_ids.map(id => remap.get(id));
  catalog.unassigned.account_ids = catalog.unassigned.account_ids.map(id => remap.get(id));
  const subject = catalog.pockets.find(p => p.account_ids.includes(scope.account_id));
  Object.assign(catalog.subject_membership, { assigned_pocket_id: subject?.id ?? null,
    status: subject ? 'recorded_label_matched' : preview.all.account_ids.includes(scope.account_id) ? 'unassigned' : 'not_in_discovery' });
  return { scope, context, catalog, preview, payload: { catalog } };
}
