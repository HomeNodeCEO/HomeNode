import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextScope, prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { prepareNeighborhoodCohortBlob as blob } from './cohortEvidenceBlobRepository.js';
import { COHORT_PAGED_GROUP_SELECTION_V1_LIMITS as L,
  prepareCohortPagedGroupSelectionV1Metadata } from './cohortPagedGroupSelectionV1.js';

const INPUT_BYTES = 4_000_000;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(reason) { throw new TypeError(`custom_cohort_recorded_group_selection_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
function original(text, reason) {
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= INPUT_BYTES, reason);
  let value, rendered;
  // These are owner-verified, JSON-encoded READ MODELS, not raw source-row
  // evidence. Preserve their exact compact encoding/number round trip without
  // forcing a four-megabyte catalog through the legacy 1.5 MB/100k-node blob
  // canonicalizer. Only the small derived digest original uses that contract.
  try { value = JSON.parse(text); rendered = JSON.stringify(value); } catch { fail(reason); }
  check(rendered === text, reason);
  return value;
}
function account(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 64
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), 'invalid_account');
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      check(next >= 0xdc00 && next <= 0xdfff, 'invalid_account');
    } else check(c < 0xdc00 || c > 0xdfff, 'invalid_account');
  }
}

/** Derive complete memberships from the owner's already authorized ORIGINAL
 * JSON-encoded catalog and independently retained roster. Neither string may come from a
 * browser. This pure bridge grants no source access, updates no head, and does
 * not certify legal subdivision identity or statistical reliability. Its
 * bounded digest original avoids storing a multi-megabyte catalog in one blob;
 * complete selected memberships are separately retained by the paged store.
 */
export async function prepareCustomCohortRecordedGroupSelection({ scopeJson, contextJson,
  catalogJson, rosterJson, includedGroupIds, revision, signal, checkBudget = () => {} } = {}) {
  check(typeof checkBudget === 'function' && (signal === undefined || signal instanceof AbortSignal), 'invalid_options');
  const cancelled = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); };
  cancelled();
  // Strings are immutable; detach the sole caller-owned array before suspension.
  const selectedIds = [...prepareCustomNeighborhoodRecordedGroupIds(includedGroupIds, 3)].sort(compare);
  const scope = prepareCustomCohortContextScope(scopeJson), context_ref = prepareCustomCohortContextReference(contextJson);
  const catalog = original(catalogJson, 'invalid_catalog'), roster = original(rosterJson, 'invalid_roster');
  check(Number.isInteger(revision) && revision > 0 && revision <= 2147483647, 'invalid_revision');
  check(catalog?.catalog_version === 3 && catalog.status === 'review_only' && catalog.catalog_complete === true
    && catalog.authority === 'not_established' && catalog.apply?.status === 'blocked'
    && catalog.presentation?.membership_complete === true && catalog.unresolved_membership === null
    && json(catalog.binding?.context_ref) === json(context_ref)
    && catalog.binding?.selection_revision === 1
    && catalog.binding?.selection_sha256 === hash('{"pockets":[],"revision":1}')
    && Array.isArray(catalog.pockets) && catalog.pockets.length <= 2048
    && catalog.discovered_group_count === catalog.pockets.length, 'invalid_catalog');
  check(roster && Object.keys(roster).length === 1 && Array.isArray(roster.account_ids)
    && roster.account_ids.length <= L.accounts, 'invalid_roster');
  const expected = new Set(); let work = 0;
  for (const id of roster.account_ids) {
    account(id); check(!expected.has(id), 'duplicate_roster_account'); expected.add(id);
    if (++work % 125 === 0) { cancelled(); await yieldToRequests(); cancelled(); }
  }
  const seen = new Set(), groups = new Map(), descriptors = [];
  const add = async (id, members, count) => {
    check(!groups.has(id) && Array.isArray(members) && Number.isInteger(count)
      && count > 0 && count <= L.accounts && count === members.length, 'invalid_group');
    const digest = createHash('sha256').update('{"account_ids":[', 'utf8');
    for (let i = 0; i < members.length; i++) {
      const member = members[i]; account(member);
      check(i === 0 || members[i - 1] < member, 'membership_order');
      // Catalog v3 is a partition. Future overlap uses a new original catalog
      // contract; never silently reinterpret this existing producer's meaning.
      check(expected.has(member) && !seen.has(member), 'catalog_roster_mismatch'); seen.add(member);
      digest.update(i === 0 ? JSON.stringify(member) : `,${JSON.stringify(member)}`, 'utf8');
      if (++work % 125 === 0) { cancelled(); await yieldToRequests(); cancelled(); }
    }
    descriptors.push({ id, member_count: count, account_ids_sha256: digest.update(']}', 'utf8').digest('hex') });
    groups.set(id, members);
  };
  // Validate every group, even an unselected one. A partial catalog must never
  // be legitimized merely because the requested subset happens to be present.
  prepareCustomNeighborhoodRecordedGroupIds(catalog.pockets.map(p => p?.id), 3);
  for (const pocket of catalog.pockets) {
    check(pocket.id !== 'discovery:unassigned', 'invalid_group');
    await add(pocket.id, pocket.account_ids, pocket.member_count);
  }
  const unassigned = catalog.unassigned;
  check(unassigned && Array.isArray(unassigned.account_ids) && Number.isInteger(unassigned.member_count)
    && unassigned.member_count >= 0 && unassigned.member_count === unassigned.account_ids.length, 'invalid_group');
  if (unassigned.member_count) await add('discovery:unassigned', unassigned.account_ids, unassigned.member_count);
  check(seen.size === expected.size && catalog.coverage?.discovery_member_count === expected.size
    && catalog.coverage?.stock_member_count === expected.size
    && catalog.coverage?.unassigned_account_count === unassigned.member_count
    && catalog.coverage?.assigned_account_count === expected.size - unassigned.member_count, 'catalog_roster_mismatch');
  for (const id of selectedIds) check(groups.has(id), 'unknown_group');
  descriptors.sort((a, b) => compare(a.id, b.id));
  const catalog_original_json = json({ selection_catalog_version: 1, usage: 'retained_recorded_group_membership_digests',
    scope, context_ref, catalog_version: 3, original_catalog_sha256: hash(catalogJson),
    original_roster_sha256: hash(rosterJson), groups: descriptors });
  const catalog_ref = blob(catalog_original_json), selected = new Set(selectedIds);
  const metadata_json = json({ selection_version: 1, usage: 'retained_group_selection_only',
    scope, context_ref, catalog_ref, revision, groups: descriptors.filter(g => selected.has(g.id)) });
  prepareCohortPagedGroupSelectionV1Metadata(metadata_json);
  cancelled();

  /** Repeatable bounded merge of ordered ORIGINAL arrays. No giant flattened
   * (account,group) list or sort, no map viewport predicate, no target sale count.
   * Heap memory is proportional to selected group count, not parcel count.
   */
  async function* membershipPages() {
    cancelled();
    const heap = [], earlier = (a, b) => compare(a.members[a.index], b.members[b.index]) || compare(a.id, b.id);
    const push = item => {
      let i = heap.length; heap.push(item);
      while (i > 0) { const parent = (i - 1) >> 1; if (earlier(heap[parent], item) <= 0) break;
        heap[i] = heap[parent]; i = parent; } heap[i] = item;
    };
    const pop = () => {
      const first = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (2 * i + 1 < heap.length) {
          let child = 2 * i + 1;
          if (child + 1 < heap.length && earlier(heap[child + 1], heap[child]) < 0) child++;
          if (earlier(last, heap[child]) <= 0) break;
          heap[i] = heap[child]; i = child;
        } heap[i] = last;
      }
      return first;
    };
    for (const id of selectedIds) push({ id, members: groups.get(id), index: 0 });
    let page = [], emitted = 0;
    while (heap.length) {
      const next = pop(); page.push({ account_id: next.members[next.index], group_id: next.id });
      if (++next.index < next.members.length) push(next);
      if (++emitted % 125 === 0) { cancelled(); await yieldToRequests(); cancelled(); }
      if (page.length === L.page_entries) { cancelled(); yield page; page = []; cancelled(); }
    }
    if (page.length) { cancelled(); yield page; cancelled(); }
    cancelled();
  }
  return Object.freeze({ authority: 'not_established', catalog_original_json, catalog_ref, metadata_json,
    included_recorded_group_ids: Object.freeze(selectedIds), membershipPages });
}
