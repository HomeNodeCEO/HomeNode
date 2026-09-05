import { createNeighborhoodCachedReadAccess } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';

const copy = value => JSON.parse(JSON.stringify(value));

/** Synthetic server-owned selection fixture only; never fakes catalog grants or
 * permission assertions. Mutating an issued request is an adversarial test, not
 * a reason to replace these resolvers with a caller-controlled account list.
 */
export function createTestCachedReadAccess(trustedRequest, options = {}) {
  const trusted = copy(trustedRequest);
  const target = copy(options.target ?? trusted.target ?? {
    report_file_id: '70000000-0000-4000-8000-000000000001',
    workflow_type: 'custom_appraisal', workflow_target_id: '1',
  });
  const selection = copy(trusted.selection ?? {
    id: 'synthetic-server-owned-selection', revision: 1,
    definition_sha256: assessmentEvidenceDigest({ synthetic_definition: 1 }),
    source_sha256: assessmentEvidenceDigest({ synthetic_source: 1 }),
  });
  const auth = options.auth ?? {
    userId: '80000000-0000-4000-8000-000000000001',
    organizations: [{ organizationId: trusted.scope.organization_id, roles: ['appraiser'] }],
  };
  const retainedClosure = options.transactionClosure ?? trusted.transaction_closure;
  const selectedIds = trusted.account_ids.map(value => typeof value === 'string' ? value.trim() : value).sort();
  const closure = retainedClosure ? {
    ...Object.fromEntries(['source_revision', 'transactions', 'links', 'legacy'].map(key => [key, copy(retainedClosure[key])])),
    selected_account_ids: retainedClosure.selected_account_ids === undefined ? selectedIds : copy(retainedClosure.selected_account_ids),
  } : {
    selected_account_ids: selectedIds,
    source_revision: 'synthetic-cache-revision-1', transactions: [], links: [], legacy: [],
  };
  const access = createNeighborhoodCachedReadAccess({
    resolveAuthorizedAssignment: async () => ({ target: copy(target), scope: copy(trusted.scope), effective_date: trusted.effective_date }),
    resolveTrustedSelection: async () => ({ ...copy(selection), account_ids: copy(trusted.account_ids) }),
    authorizeMarketData: options.authorizeMarketData ?? (async () => ({
      allowed: true, decision_id: 'fixture-license', policy_revision: 'fixture-license-v1',
    })),
    resolveTransactionClosure: options.resolveTransactionClosure ?? (async () => copy(closure)),
    ...(options.ttl_ms === undefined ? {} : { ttl_ms: options.ttl_ms }),
  });
  const prepareInput = {
    target, selection_reference: { id: selection.id, revision: selection.revision },
    observation_period: copy(trusted.observation_period), knowledge_cutoff: trusted.knowledge_cutoff ?? null,
  };
  return { access, auth, prepareInput, prepare: () => access.prepare(auth, copy(prepareInput)) };
}
