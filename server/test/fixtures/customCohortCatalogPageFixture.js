import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';

const sha = value => createHash('sha256').update(value).digest('hex');
export function customCohortCatalogPageFixture({ count = 501, groupCount = 237,
  organization = '10000000-0000-4000-8000-000000000001', labelSuffix = '' } = {}) {
  const account = i => `synthetic-account-${String(i).padStart(7, '0')}`;
  const scope = { organization_id: organization, report_file_id: '10000000-0000-4000-8000-000000000002',
    assignment_file_id: '1', account_id: account(0) };
  const context = { context_id: '10000000-0000-4000-8000-000000000003',
    context_revision: '1', context_sha256: 'c'.repeat(64) };
  const pockets = Array.from({ length: groupCount }, (_, i) => ({
    id: `recorded-cad:${sha(`Synthetic catalog group ${i}`)}`, label: `Synthetic Group ${i}${labelSuffix}`,
    county: 'Dallas', account_ids: [] }));
  const unassigned = [], accounts = [];
  for (let i = 0; i < count; i++) {
    const id = account(i); accounts.push(id);
    if (!groupCount || i === count - 1) unassigned.push(id); else pockets[i % groupCount].account_ids.push(id);
  }
  pockets.forEach(p => { p.member_count = p.account_ids.length; });
  const catalog = { catalog_version: 3, status: 'review_only', catalog_complete: true, authority: 'not_established',
    apply: { status: 'blocked' }, binding: { context_ref: context, selection_revision: 1,
      selection_sha256: sha('{"pockets":[],"revision":1}') }, presentation: { membership_complete: true },
    discovered_group_count: pockets.length, pockets, unassigned: { account_ids: unassigned, member_count: unassigned.length,
      reason_counts: unassigned.length ? [{ reason: 'recorded_subdivision_label_unavailable', member_count: unassigned.length }] : [] },
    subject_membership: { account_id: account(0), assigned_pocket_id: pockets[0]?.account_ids.includes(account(0)) ? pockets[0].id : null,
      recorded_label_match_only: true, status: count ? groupCount && count > 1 ? 'recorded_label_matched' : 'unassigned' : 'not_in_discovery' },
    limitations: ['recorded_label_match_only_not_legal_subdivision_identity', 'current_cad_observations_not_historical_membership'],
    unresolved_membership: null, coverage: { discovery_member_count: accounts.length, stock_member_count: accounts.length,
      unassigned_account_count: unassigned.length, assigned_account_count: accounts.length - unassigned.length } };
  return { scope, context, catalog, accounts, input: { scopeJson: json(scope), contextJson: json(context),
    catalogJson: JSON.stringify(catalog), rosterJson: JSON.stringify({ account_ids: accounts }) } };
}
