import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextScope, prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';

// A new internal representation only, not an installed capacity increase. The
// owner must derive these groups from the exact freshly authorized ORIGINAL
// catalog, own all staging transactions, and atomically register the selection
// revision with that context. A browser cannot supply catalog/group evidence.
export const COHORT_PAGED_GROUP_SELECTION_V1_LIMITS = Object.freeze({
  accounts: 1_000_000, memberships: 2_000_000, page_entries: 1_000,
  membership_pages: 2_000, account_pages: 1_000, page_bytes: 256_000,
  metadata_bytes: 750_000, manifest_bytes: 750_000,
});
const L = COHORT_PAGED_GROUP_SELECTION_V1_LIMITS;
const SHA = /^[a-f0-9]{64}$/;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fail(reason) { throw new TypeError(`cohort_paged_group_selection_v1_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
function closed(value, keys, reason) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), reason);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(d.enumerable && Object.hasOwn(d, 'value'), reason);
  }
}
function original(text, limit, reason) {
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= limit, reason);
  try { blob(text); return JSON.parse(text); } catch { fail(reason); }
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
function reference(value, reason) {
  closed(value, ['content_sha256', 'canonical_utf8_bytes'], reason);
  try { return blobRef(value.content_sha256, value.canonical_utf8_bytes); } catch { fail(reason); }
}
function metadata(text) {
  const value = original(text, L.metadata_bytes, 'invalid_metadata');
  closed(value, ['selection_version', 'usage', 'scope', 'context_ref', 'catalog_ref', 'revision', 'groups'], 'invalid_metadata');
  check(value.selection_version === 1 && value.usage === 'retained_group_selection_only'
    && Number.isSafeInteger(value.revision) && value.revision > 0, 'invalid_metadata');
  try {
    prepareCustomCohortContextScope(json(value.scope));
    prepareCustomCohortContextReference(json(value.context_ref));
  } catch { fail('invalid_metadata'); }
  reference(value.catalog_ref, 'invalid_metadata');
  check(Array.isArray(value.groups) && value.groups.length <= 2049, 'invalid_metadata');
  const ids = value.groups.map(group => {
    closed(group, ['id', 'member_count', 'account_ids_sha256'], 'invalid_metadata');
    check(Number.isSafeInteger(group.member_count) && group.member_count >= 0
      && group.member_count <= L.accounts && typeof group.account_ids_sha256 === 'string'
      && SHA.test(group.account_ids_sha256), 'invalid_metadata');
    return group.id;
  });
  try { prepareCustomNeighborhoodRecordedGroupIds(ids, 3); } catch { fail('invalid_metadata'); }
  check(ids.every((id, i) => i === 0 || ids[i - 1] < id), 'invalid_metadata');
  check(value.groups.reduce((sum, group) => sum + group.member_count, 0) <= L.memberships, 'membership_limit');
  return value;
}
function page(kind, index, entries) {
  const page_json = json({ selection_version: 1, kind, page_index: String(index), entries });
  check(Buffer.byteLength(page_json, 'utf8') <= L.page_bytes, 'page_limit');
  return { page_json, ref: blob(page_json), page_index: index, entry_count: entries.length };
}
function pageReference(value) {
  return Object.freeze({ page_index: String(value.page_index), entry_count: String(value.entry_count),
    page: value.ref });
}

/** Input pages are complete original (account, group) memberships, sorted by
 * account then group. Overlap is preserved as lineage but counted only once in
 * the union. Per-group original counts AND ordered digests detect a missing or
 * altered prefix; no guessed target number of accounts/sales is used.
 * Callbacks only stage uncommitted originals. On any error the owner rolls back
 * ALL writes; only a successful final result may be registered as a selection.
 */
export async function stageCohortPagedGroupSelectionV1({ metadataJson, membershipPages,
  onMembershipPage, onAccountPage, signal, checkBudget = () => {} } = {}) {
  const m = metadata(metadataJson), metadata_ref = blob(metadataJson);
  check(membershipPages && typeof membershipPages[Symbol.asyncIterator] === 'function'
    && typeof onMembershipPage === 'function' && typeof onAccountPage === 'function'
    && typeof checkBudget === 'function', 'invalid_input');
  const groupWork = new Map(m.groups.map(group => [group.id, {
    count: 0, hash: createHash('sha256').update('{"account_ids":[', 'utf8'), original: group,
  }]));
  const memberships = [], accounts = [], union = createHash('sha256');
  let membership_count = 0, account_count = 0, previous = null, accountBatch = [];
  const cancelled = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); };
  const flushAccounts = async () => {
    check(accounts.length < L.account_pages, 'account_limit');
    const value = page('selected_accounts', accounts.length, accountBatch);
    cancelled(); await onAccountPage(Object.freeze(value)); cancelled();
    accounts.push(pageReference(value)); accountBatch = [];
  };
  for await (const entries of membershipPages) {
    cancelled();
    check(Array.isArray(entries) && entries.length > 0 && entries.length <= L.page_entries
      && Object.getPrototypeOf(entries) === Array.prototype
      && Reflect.ownKeys(entries).length === entries.length + 1, 'invalid_page');
    check(memberships.length < L.membership_pages, 'membership_limit');
    // Encode/validate before suspending, then use only the independent original.
    const originalEntries = [];
    for (let i = 0; i < entries.length; i++) {
      const d = Object.getOwnPropertyDescriptor(entries, String(i));
      check(d?.enumerable && Object.hasOwn(d, 'value'), 'invalid_page');
      closed(d.value, ['account_id', 'group_id'], 'invalid_membership');
      account(d.value.account_id); check(groupWork.has(d.value.group_id), 'unknown_group');
      originalEntries.push({ account_id: d.value.account_id, group_id: d.value.group_id });
    }
    const value = page('recorded_group_memberships', memberships.length, originalEntries);
    for (const row of originalEntries) {
      closed(row, ['account_id', 'group_id'], 'invalid_membership'); account(row.account_id);
      const work = groupWork.get(row.group_id);
      check(work, 'unknown_group');
      check(!previous || previous.account_id < row.account_id
        || (previous.account_id === row.account_id && previous.group_id < row.group_id), 'membership_order');
      check(++membership_count <= L.memberships && ++work.count <= work.original.member_count, 'count_mismatch');
      const encoded = JSON.stringify(row.account_id);
      work.hash.update(work.count === 1 ? encoded : `,${encoded}`, 'utf8');
      if (!previous || previous.account_id !== row.account_id) {
        check(++account_count <= L.accounts, 'account_limit');
        union.update(account_count === 1 ? '{"pockets":[{"account_ids":[' : ',', 'utf8').update(encoded, 'utf8');
        accountBatch.push(row.account_id);
        if (accountBatch.length === L.page_entries) await flushAccounts();
      }
      previous = row;
      if (membership_count % 125 === 0) { cancelled(); await yieldToRequests(); cancelled(); }
    }
    cancelled(); await onMembershipPage(Object.freeze(value)); cancelled();
    memberships.push(pageReference(value));
  }
  cancelled();
  for (const work of groupWork.values()) {
    check(work.count === work.original.member_count, 'count_mismatch');
    check(work.hash.update(']}', 'utf8').digest('hex') === work.original.account_ids_sha256, 'group_digest_mismatch');
  }
  if (accountBatch.length) await flushAccounts();
  union.update(account_count ? `],"id":"discovery:selected","label":"Selected observations"}],"revision":${m.revision}}`
    : `{"pockets":[],"revision":${m.revision}}`, 'utf8');
  const selection_sha256 = union.digest('hex');
  const manifest_json = json({ selection_version: 1, usage: 'retained_group_selection_only', metadata_ref,
    membership_count: String(membership_count), account_count: String(account_count), selection_sha256,
    membership_pages: memberships, account_pages: accounts });
  check(Buffer.byteLength(manifest_json, 'utf8') <= L.manifest_bytes, 'manifest_limit');
  cancelled();
  return Object.freeze({ selection_version: 1, authority: 'not_established', account_count, membership_count,
    selection_sha256, manifest_json, manifest_ref: blob(manifest_json) });
}

/** Every original membership and union page is rechecked. Expected metadata
 * must come from the owner-validated context/catalog/selection revision, not a
 * client's replacement JSON. Integrity never substitutes for current rights.
 */
export async function verifyCohortPagedGroupSelectionV1({ metadataJson, manifestJson,
  readPage, signal, checkBudget } = {}) {
  metadata(metadataJson);
  const manifest = original(manifestJson, L.manifest_bytes, 'invalid_manifest');
  closed(manifest, ['selection_version', 'usage', 'metadata_ref', 'membership_count', 'account_count',
    'selection_sha256', 'membership_pages', 'account_pages'], 'invalid_manifest');
  check(manifest.selection_version === 1 && manifest.usage === 'retained_group_selection_only'
    && json(reference(manifest.metadata_ref, 'invalid_manifest')) === json(blob(metadataJson))
    && typeof readPage === 'function', 'invalid_manifest');
  for (const [name, maximum] of [['membership_count', L.memberships], ['account_count', L.accounts]]) {
    check(typeof manifest[name] === 'string' && /^(?:0|[1-9]\d*)$/.test(manifest[name])
      && Number(manifest[name]) <= maximum, 'invalid_manifest');
  }
  check(typeof manifest.selection_sha256 === 'string' && SHA.test(manifest.selection_sha256), 'invalid_manifest');
  for (const [name, maximum] of [['membership_pages', L.membership_pages], ['account_pages', L.account_pages]]) {
    check(Array.isArray(manifest[name]) && manifest[name].length <= maximum, 'invalid_manifest');
    for (const [index, ref] of manifest[name].entries()) {
      closed(ref, ['page_index', 'entry_count', 'page'], 'invalid_manifest');
      check(ref.page_index === String(index) && typeof ref.entry_count === 'string'
        && /^[1-9]\d*$/.test(ref.entry_count) && Number(ref.entry_count) <= L.page_entries, 'invalid_manifest');
      reference(ref.page, 'invalid_manifest');
    }
  }
  check(!signal?.aborted, 'cancelled'); checkBudget?.();
  const originalMetadata = await readPage({ kind: 'selection_metadata', page_index: null, ...manifest.metadata_ref });
  check(originalMetadata === metadataJson, 'metadata_conflict');
  const read = async (kind, index, refs) => {
    check(!signal?.aborted, 'cancelled');
    const ref = refs[index]; check(ref, 'page_conflict');
    const text = await readPage({ kind, page_index: index, ...ref.page });
    const value = original(text, L.page_bytes, 'page_conflict');
    check(json(blob(text)) === json(ref.page), 'page_conflict');
    closed(value, ['selection_version', 'kind', 'page_index', 'entries'], 'page_conflict');
    check(value.selection_version === 1 && value.kind === kind && value.page_index === String(index)
      && Array.isArray(value.entries) && value.entries.length === Number(ref.entry_count), 'page_conflict');
    return { text, entries: value.entries };
  };
  async function* pages() {
    for (let index = 0; index < manifest.membership_pages.length; index++) {
      yield (await read('recorded_group_memberships', index, manifest.membership_pages)).entries;
    }
  }
  let unionPages = 0;
  const result = await stageCohortPagedGroupSelectionV1({ metadataJson, membershipPages: pages(), signal, checkBudget,
    onMembershipPage: async () => {}, onAccountPage: async value => {
      const original = await read('selected_accounts', value.page_index, manifest.account_pages);
      check(original.text === value.page_json, 'union_conflict'); unionPages++;
    } });
  check(unionPages === manifest.account_pages.length && result.manifest_json === manifestJson, 'manifest_conflict');
  return result;
}
