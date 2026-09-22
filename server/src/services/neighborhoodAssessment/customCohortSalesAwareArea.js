import { customCohortObservationMembers, isCustomCohortObservationPreview } from './customCohortObservationPreview.js';

/** A review heuristic, not a reliability probability or market-eligibility test.
 * Only one-account, priced, in-period canonical transactions with an observed
 * current CAD living area count toward the requested sales/GLA targets. The
 * current CAD area is not a verified at-sale measurement. No price adjustment,
 * source reread, report write, or subset of the captured roster occurs here.
 */
export const CUSTOM_COHORT_AREA_POLICY = Object.freeze({ version: 1, minimum_transactions: 50,
  quarterly_median_gla_tolerance_percent: 5, maximum_selected_accounts: 3000, maximum_selected_groups: 30 });
const POLICY = CUSTOM_COHORT_AREA_POLICY;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const quarter = date => `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
function expectedQuarters(period) {
  const start = Number(period.start_date.slice(0, 4)) * 4 + Math.floor((Number(period.start_date.slice(5, 7)) - 1) / 3);
  const end = Number(period.end_date.slice(0, 4)) * 4 + Math.floor((Number(period.end_date.slice(5, 7)) - 1) / 3);
  if (end < start || end - start >= 100) return null;
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const value = start + index;
    return `${Math.floor(value / 4)}-Q${value % 4 + 1}`;
  });
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(events, subjectGla, periods) {
  const quarters = new Map();
  for (const event of events) {
    const key = quarter(event.date);
    if (!quarters.has(key)) quarters.set(key, []);
    quarters.get(key).push(event.gla);
  }
  const rows = periods.map(period => {
    const values = quarters.get(period) ?? [];
    const middle = values.length ? median(values) : null;
    const deviation = middle === null ? null : 100 * Math.abs(middle / subjectGla - 1);
    return { quarter: period, transaction_count: values.length, median_current_cad_gla_sqft: middle,
      deviation_percent: deviation === null ? null : Math.round(deviation * 100) / 100,
      within_tolerance: deviation !== null && deviation <= POLICY.quarterly_median_gla_tolerance_percent + 1e-10 };
  });
  return { count: events.length, quarters: rows, within: rows.every(row => row.within_tolerance),
    worst: rows.length ? Math.max(...rows.map(row => row.deviation_percent ?? 100)) : 100 };
}

/** Input is the already owner-admitted internal recommendation and its exact
 * retained preview. The public result contains only recorded group IDs and
 * aggregate counts. An unknown subject or incomplete catalog never produces
 * a replacement selection. Previously saved selections are not inputs here.
 */
export function buildCustomCohortSalesAwareArea({ recommendation, observation_preview: preview, catalog } = {}) {
  if (!isCustomCohortObservationPreview(preview) || !recommendation || !catalog) return null;
  const subjectGla = recommendation.subject?.observations?.gla?.value;
  const subjectId = recommendation.subject?.recorded_group_review_ids?.[0];
  const base = { area_version: 1, basis: 'single_account_recorded_transactions_and_current_cad_gla',
    policy: { ...POLICY }, subject_gla_sqft: finite(subjectGla) ? subjectGla : null,
    selected_recorded_group_ids: [], selected_account_count: 0, recorded_transaction_count: 0,
    available_qualifying_transaction_count: 0, quarterly_gla: [],
    limitations: ['not_verified_market_eligible_sales', 'current_cad_gla_not_verified_at_sale',
      'similarity_is_a_review_heuristic_not_empirical_reliability'] };
  if (!catalog.catalog_complete || !finite(subjectGla) || !subjectId || !recommendation.subject.in_discovery) {
    return { ...base, status: 'unavailable' };
  }
  const groups = new Map(recommendation.pockets.map(group => [group.id, group]));
  if (!groups.has(subjectId)) return { ...base, status: 'unavailable' };
  if (groups.get(subjectId).account_ids.length > POLICY.maximum_selected_accounts ||
    !preview.observation_period || !expectedQuarters(preview.observation_period)) {
    return { ...base, status: 'unavailable' };
  }
  const byAccount = new Map(recommendation.properties.map(row => [row.account_id, row.recorded_group_id]));
  const stock = new Map(customCohortObservationMembers(preview, preview.all, 'stock').map(row => [row.account_id, row]));
  const eventsByGroup = new Map([...groups.keys()].map(id => [id, []]));
  let available = 0;
  for (const event of customCohortObservationMembers(preview, preview.all, 'transactions')) {
    if (event.disposition !== 'in_period' || event.multiple_parcel_evidence || event.unresolved_link_count !== 0
      || event.associated_account_ids.length !== 1 || event.recorded_total_price?.state !== 'observed'
      || !finite(event.recorded_total_price.value)) continue;
    const account = event.associated_account_ids[0], groupId = byAccount.get(account);
    const gla = stock.get(account)?.observations?.gla_sqft;
    if (!eventsByGroup.has(groupId) || gla?.state !== 'observed' || !finite(gla.value)) continue;
    eventsByGroup.get(groupId).push({ date: event.sale_date, gla: gla.value });
    available++;
  }
  const selected = new Set([subjectId]);
  const periods = expectedQuarters(preview.observation_period);
  const subjectGroup = groups.get(subjectId);
  let accounts = subjectGroup.account_ids.length;
  let events = [...eventsByGroup.get(subjectId)];
  const eligible = [...groups.values()].filter(group => group.id !== subjectId && group.id !== 'discovery:unassigned'
    && group.meets_review_policy && eventsByGroup.get(group.id)?.length);
  // Complete deterministic greedy review set: maximize useful observed sales
  // per additional account while favoring stronger physical-similarity bounds.
  // Never enlarge solely to improve a score or to include data-free groups.
  while (events.length < POLICY.minimum_transactions || !summarize(events, subjectGla, periods).within) {
    if (selected.size >= POLICY.maximum_selected_groups) break;
    const current = summarize(events, subjectGla, periods);
    const candidates = eligible.filter(group => !selected.has(group.id)
      && accounts + group.account_ids.length <= POLICY.maximum_selected_accounts).map(group => {
      const extra = eventsByGroup.get(group.id), next = summarize([...events, ...extra], subjectGla, periods);
      const groupSummary = summarize(extra, subjectGla, periods);
      const groupFit = groupSummary.quarters.every(row => !row.transaction_count || row.within_tolerance);
      const groupNear = groupSummary.quarters.every(row => !row.transaction_count
        || row.deviation_percent <= 15);
      return { group, extra, next, groupFit, groupNear,
        utility: (group.result.similarity.lower ?? 0) * extra.length / Math.max(1, group.account_ids.length) };
    }).filter(candidate => candidate.groupNear && (current.within || candidate.next.worst <= current.worst + 1e-10));
    if (!candidates.length) break;
    candidates.sort((a, b) => Number(b.next.within) - Number(a.next.within)
      || Number(b.groupFit) - Number(a.groupFit)
      || b.next.quarters.filter(row => row.within_tolerance).length - a.next.quarters.filter(row => row.within_tolerance).length
      || a.next.worst - b.next.worst || b.utility - a.utility
      || (b.group.result.similarity.lower ?? 0) - (a.group.result.similarity.lower ?? 0)
      || a.group.account_ids.length - b.group.account_ids.length || compare(a.group.id, b.group.id));
    const next = candidates[0];
    selected.add(next.group.id); accounts += next.group.account_ids.length; events.push(...next.extra);
  }
  const result = summarize(events, subjectGla, periods);
  return { ...base, status: result.count >= POLICY.minimum_transactions
    ? result.within ? 'meets_targets' : 'quarterly_gla_mismatch' : 'insufficient_recorded_sales',
  selected_recorded_group_ids: [...selected], selected_account_count: accounts,
  recorded_transaction_count: result.count, available_qualifying_transaction_count: available,
  quarterly_gla: result.quarters };
}
