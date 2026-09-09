import type { CustomCohortContextRef, CustomCohortPreviewInput } from './customCohortPreviewController';
import { checkCustomCohortPocketRecommendation } from './customCohortPocketRecommendation.ts';
import type { CheckedPocketRecommendation } from './customCohortPocketRecommendation';

export interface CheckedRecordedPocket {
  readonly id: string; readonly label: string; readonly county: string;
  readonly account_ids: readonly string[]; readonly member_count: number;
}
export interface CheckedPocketCatalog {
  readonly status: 'review_only' | 'incomplete';
  readonly binding: { readonly context_ref: CustomCohortContextRef; readonly selection_revision: number };
  readonly pockets: readonly CheckedRecordedPocket[];
  readonly unassigned: { readonly account_ids: readonly string[]; readonly member_count: number;
    readonly reason_counts: readonly { readonly reason: string; readonly member_count: number }[] };
  readonly coverage: { readonly discovery_member_count: number; readonly assigned_account_count: number;
    readonly unassigned_account_count: number };
  readonly subject_membership: { readonly account_id: string; readonly assigned_pocket_id: string | null;
    readonly status: string; readonly recorded_label_match_only: true };
  readonly limitations: readonly string[];
  readonly recommendation?: CheckedPocketRecommendation | null;
}
const UNASSIGNED = 'discovery:unassigned';
export const CUSTOM_COHORT_UNASSIGNED_GROUP = UNASSIGNED;
const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('Invalid recorded pocket catalog'); };
const object = (value: unknown): Record<string, unknown> => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 512): string => {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum);
  for (let i = 0; i < value.length; i++) ensure(value.charCodeAt(i) >= 32 && value.charCodeAt(i) !== 127);
  return value;
};
const count = (value: unknown): number => { ensure(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000); return Number(value); };
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}
function sameContext(value: unknown, expected: CustomCohortContextRef) {
  const ref = object(value);
  ensure(ref.context_id === expected.context_id && ref.context_revision === expected.context_revision
    && ref.context_sha256 === expected.context_sha256);
}

/** Admit only fields rendered by the workspace. The transport has already
 * bounded/parses JSON. No server claims are promoted to eligibility or Apply. */
export function checkCustomCohortPocketCatalog(value: unknown, expected: CustomCohortPreviewInput): CheckedPocketCatalog {
  const response = object(value), target = object(response.target), catalog = object(response.catalog);
  ensure(response.status === 'catalog' && response.subject_freshness === 'matched'
    && target.account_id === expected.accountId && target.assignment_file_id === expected.assignmentFileId
    && response.selection_revision === expected.selection.revision && object(response.apply).status === 'blocked');
  sameContext(response.context_ref, expected.contextRef);
  const binding = object(catalog.binding); sameContext(binding.context_ref, expected.contextRef);
  ensure(binding.selection_revision === expected.selection.revision && catalog.catalog_version === 1
    && ['review_only', 'incomplete'].includes(String(catalog.status)) && object(catalog.apply).status === 'blocked');
  ensure(Array.isArray(catalog.pockets) && catalog.pockets.length <= 128);
  const ids = new Set<string>(), accounts = new Set<string>();
  const members = (value: unknown): readonly string[] => {
    ensure(Array.isArray(value) && value.length <= 50_000);
    return value.map(raw => {
      const id = text(raw, 100); ensure(id.trim() === id && !accounts.has(id) && accounts.size < 50_000);
      accounts.add(id); return id;
    });
  };
  const pockets = catalog.pockets.map(raw => {
    const p = object(raw), id = text(p.id, 200);
    ensure(id.startsWith('recorded-cad:') && !ids.has(id) && p.disposition === 'needs_review'); ids.add(id);
    const account_ids = members(p.account_ids), member_count = count(p.member_count);
    ensure(member_count === account_ids.length);
    return { id, label: text(p.label), county: text(p.county), account_ids, member_count };
  });
  const unassigned = object(catalog.unassigned), unassignedAccounts = members(unassigned.account_ids);
  ensure(count(unassigned.member_count) === unassignedAccounts.length && Array.isArray(unassigned.reason_counts)
    && unassigned.reason_counts.length <= 64);
  const reason_counts = unassigned.reason_counts.map(raw => {
    const r = object(raw); return { reason: text(r.reason, 200), member_count: count(r.member_count) };
  });
  const coverage = object(catalog.coverage), assigned = pockets.reduce((sum, p) => sum + p.member_count, 0);
  ensure(count(coverage.discovery_member_count) === accounts.size && count(coverage.assigned_account_count) === assigned
    && count(coverage.unassigned_account_count) === unassignedAccounts.length);
  ensure(catalog.status !== 'incomplete' || pockets.length === 0);
  const subject = object(catalog.subject_membership), subjectAccount = text(subject.account_id, 100);
  ensure(subjectAccount === expected.accountId && subject.recorded_label_match_only === true
    && (subject.assigned_pocket_id === null || typeof subject.assigned_pocket_id === 'string'));
  const assignedId = subject.assigned_pocket_id as string | null;
  if (assignedId !== null) ensure(pockets.find(p => p.id === assignedId)?.account_ids.includes(subjectAccount));
  ensure(Array.isArray(catalog.limitations) && catalog.limitations.length <= 64);
  const checked = { status: catalog.status as CheckedPocketCatalog['status'],
    binding: { context_ref: { ...expected.contextRef }, selection_revision: expected.selection.revision }, pockets,
    unassigned: { account_ids: unassignedAccounts, member_count: unassignedAccounts.length, reason_counts },
    coverage: { discovery_member_count: accounts.size, assigned_account_count: assigned, unassigned_account_count: unassignedAccounts.length },
    subject_membership: { account_id: subjectAccount, assigned_pocket_id: assignedId,
      status: text(subject.status, 200), recorded_label_match_only: true as const },
    limitations: catalog.limitations.map(v => text(v, 200)) };
  const recommendation = Object.hasOwn(response, 'recommendation')
    ? checkCustomCohortPocketRecommendation(response.recommendation, checked, binding.selection_sha256) : null;
  return frozen({ ...checked, recommendation });
}

export function customCohortCatalogGroupIds(catalog: CheckedPocketCatalog): readonly string[] {
  return [...catalog.pockets.map(p => p.id), ...(catalog.unassigned.member_count ? [UNASSIGNED] : [])];
}

/** One exact selected union avoids truncating a 128-group catalog plus unresolved
 * observations. Individual group inspection is a separate, explicit request. */
export function selectionFromRecordedGroups(catalog: CheckedPocketCatalog, included: readonly string[], revision: number) {
  ensure(Number.isSafeInteger(revision) && revision > 0 && new Set(included).size === included.length);
  const groups = new Map(catalog.pockets.map(p => [p.id, p.account_ids]));
  if (catalog.unassigned.member_count) groups.set(UNASSIGNED, catalog.unassigned.account_ids);
  const selected: string[] = [];
  for (const id of included) { ensure(groups.has(id)); selected.push(...groups.get(id)!); }
  selected.sort();
  return frozen({ revision, pockets: selected.length ? [{ id: 'discovery:selected', label: 'Selected observations', account_ids: selected }] : [] });
}
