import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextScope, prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { prepareNeighborhoodCohortBlob as blob } from './cohortEvidenceBlobRepository.js';
import { COHORT_PAGED_GROUP_SELECTION_V1_LIMITS as L,
  prepareCohortPagedGroupSelectionV1Metadata } from './cohortPagedGroupSelectionV1.js';

const INPUT_BYTES = 4_000_000;
const COMMAND_BYTES = 262_144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

/** Recorded server-owned reviewer intent, never a current authorization grant.
 * The executable owner must supply the freshly authenticated actor, not a
 * browser actor claim. Its immutable receipt shares the selection transaction.
 */
export function prepareCustomCohortGroupSelectionCommandOriginal(text) {
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= COMMAND_BYTES, 'invalid_command');
  let value;
  try { value = JSON.parse(text); check(json(value) === text, 'invalid_command'); } catch { fail('invalid_command'); }
  const keys = ['command_version', 'actor_user_id', 'operation_id', 'expected_selection_ref',
    'included_recorded_group_ids', 'selection_revision', ...(value?.command_version === 2 ? ['expected_workspace_revision'] : [])];
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k))
    && [1, 2].includes(value.command_version) && typeof value.actor_user_id === 'string' && UUID.test(value.actor_user_id)
    && typeof value.operation_id === 'string' && UUID.test(value.operation_id), 'invalid_command');
  if (value.command_version === 2) check(Number.isInteger(value.expected_workspace_revision)
    && value.expected_workspace_revision >= 1 && value.expected_workspace_revision < 2147483647, 'invalid_command');
  let expected;
  try { expected = value.expected_selection_ref === null ? null
    : prepareCustomCohortGroupSelectionReference(value.expected_selection_ref); } catch { fail('invalid_command'); }
  let ids;
  try { ids = prepareCustomNeighborhoodRecordedGroupIds(value.included_recorded_group_ids, 3); } catch { fail('invalid_command'); }
  check(ids.every((id, i) => i === 0 || ids[i - 1] < id) && Number.isInteger(value.selection_revision)
    && value.selection_revision > 0 && value.selection_revision <= 2147483647
    && value.selection_revision === (expected?.selection_revision ?? 0) + 1, 'invalid_command');
  return Object.freeze({ ...value, expected_selection_ref: expected, included_recorded_group_ids: ids });
}

/** Derive complete memberships from the owner's already authorized ORIGINAL
 * JSON-encoded catalog and independently retained roster. Neither string may come from a
 * browser. This pure bridge grants no source access, updates no head, and does
 * not certify legal subdivision identity or statistical reliability. Its
 * bounded digest original avoids storing a multi-megabyte catalog in one blob;
 * complete selected memberships are separately retained by the paged store.
 */
export async function prepareCustomCohortRecordedGroupSelection({ scopeJson, contextJson,
  catalogJson, rosterJson, includedGroupIds, revision, commandJson = null,
  catalogIdentityVersion = 1, signal, checkBudget = () => {} } = {}) {
  check(typeof checkBudget === 'function' && (signal === undefined || signal instanceof AbortSignal), 'invalid_options');
  check(catalogIdentityVersion === 1 || catalogIdentityVersion === 2, 'invalid_catalog_identity_version');
  const cancelled = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); };
  cancelled();
  // Strings are immutable; detach the sole caller-owned array before suspension.
  const selectedIds = [...prepareCustomNeighborhoodRecordedGroupIds(includedGroupIds, 3)].sort(compare);
  const scope = prepareCustomCohortContextScope(scopeJson), context_ref = prepareCustomCohortContextReference(contextJson);
  const catalog = original(catalogJson, 'invalid_catalog'), roster = original(rosterJson, 'invalid_roster');
  check(Number.isInteger(revision) && revision > 0 && revision <= 2147483647, 'invalid_revision');
  const command = commandJson === null ? null : prepareCustomCohortGroupSelectionCommandOriginal(commandJson);
  if (command) check(command.selection_revision === revision
    && json(command.included_recorded_group_ids) === json(selectedIds), 'command_mismatch');
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
  // Preserve v1 byte identity for retained originals. New owner-produced v2
  // receipts bind the COMPLETE independently retained roster and every group's
  // membership, not labels/reasons/rendering or read-model property order.
  // Hash incrementally: this roster can exceed the legacy blob/node limits.
  let identity;
  if (catalogIdentityVersion === 1) identity = { original_catalog_sha256: hash(catalogJson),
    original_roster_sha256: hash(rosterJson) };
  else {
    const ordered = [...expected].sort(compare), digest = createHash('sha256').update('{"account_ids":[', 'utf8');
    for (let i = 0; i < ordered.length; i++) {
      digest.update(i === 0 ? JSON.stringify(ordered[i]) : `,${JSON.stringify(ordered[i])}`, 'utf8');
      if (++work % 125 === 0) { cancelled(); await yieldToRequests(); cancelled(); }
    }
    identity = { roster_account_ids_sha256: digest.update(']}', 'utf8').digest('hex') };
  }
  const catalog_original_json = json({ selection_catalog_version: catalogIdentityVersion,
    usage: 'retained_recorded_group_membership_digests', scope, context_ref, catalog_version: 3,
    ...identity, groups: descriptors,
    ...(command ? { selection_command: command } : {}) });
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
