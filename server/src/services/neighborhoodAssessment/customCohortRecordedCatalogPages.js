import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortRecordedGroupSelection } from './customCohortRecordedGroupSelection.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef }
  from './cohortEvidenceBlobRepository.js';

// Representation only: none of these ceilings changes installed capture,
// analytical, selection, source or publication limits.
export const CUSTOM_COHORT_RECORDED_CATALOG_PAGE_LIMITS = Object.freeze({
  groups_per_page: 100, page_bytes: 200_000, metadata_bytes: 32_000,
  manifest_bytes: 16_000, operations: 256, io_bytes: 32_000_000,
});
const L = CUSTOM_COHORT_RECORDED_CATALOG_PAGE_LIMITS;
const issued = new WeakMap();
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(reason) { throw new TypeError(`custom_cohort_recorded_catalog_pages_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
function closed(value, keys) {
  check(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length, 'shape');
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(d?.enumerable && Object.hasOwn(d, 'value'), 'shape'); result[key] = d.value;
  }
  return result;
}
function text(value, maximum = 512) {
  check(typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    && value.isWellFormed(), 'text'); return value;
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function bounded(value, maximum) {
  const encoded = json(value); check(Buffer.byteLength(encoded) <= maximum, 'representation_limit');
  return { text: encoded, ref: blob(encoded) };
}
function options({ signal, checkBudget = () => {} } = {}) {
  check(typeof checkBudget === 'function' && (signal === undefined || signal instanceof AbortSignal), 'options');
  const live = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); check(!signal?.aborted, 'cancelled'); };
  return { signal, checkBudget: live, live };
}
function sourceOf(receipt) { const source = issued.get(receipt); check(source, 'issued_source_required'); return source; }
function reference(value, limit = 1_500_000) {
  const ref = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  const checked = blobRef(ref.content_sha256, ref.canonical_utf8_bytes);
  check(Number(checked.canonical_utf8_bytes) <= limit, 'reference'); return checked;
}
const equal = (a, b) => a.content_sha256 === b.content_sha256 && a.canonical_utf8_bytes === b.canonical_utf8_bytes;

/** Compile display-only pages from the owner's freshly authorized COMPLETE v3
 * catalog and independently retained roster. The existing producer checks all
 * original group memberships (including unselected ones), roster partition and
 * counts. No browser member list, viewport, label inference or clipped prefix.
 *
 * The issued receipt keeps only small original digests/display pages, not the
 * input member arrays. It is not current source/assignment/Apply authority. On
 * every read the caller must separately reopen exact originals/current rights
 * and compile a fresh receipt; old local receipts cannot stand in for those
 * fences. No live coordinator, consumer, schema, cap or flag switches here.
 */
export async function prepareCustomCohortRecordedCatalogSource(input, operationOptions = {}) {
  const v = closed(input, ['scopeJson', 'contextJson', 'catalogJson', 'rosterJson']);
  const op = options(operationOptions); op.live();
  const original = await prepareCustomCohortRecordedGroupSelection({ ...v,
    includedGroupIds: [], revision: 1, catalogIdentityVersion: 2,
    signal: op.signal, checkBudget: op.checkBudget });
  op.live();
  const identity = JSON.parse(original.catalog_original_json), catalog = JSON.parse(v.catalogJson);
  const subject = closed(catalog.subject_membership,
    ['account_id', 'assigned_pocket_id', 'recorded_label_match_only', 'status']);
  check(subject.account_id === identity.scope.account_id && subject.recorded_label_match_only === true, 'subject');
  const all = new Set(JSON.parse(v.rosterJson).account_ids), present = all.has(subject.account_id);
  const assigned = catalog.pockets.find(p => p.account_ids.includes(subject.account_id));
  if (assigned) check(subject.assigned_pocket_id === assigned.id && subject.status === 'recorded_label_matched', 'subject');
  else check(subject.assigned_pocket_id === null && (present
    ? ['unassigned', 'conflicting_evidence', 'invalid_evidence'].includes(subject.status)
    : subject.status === 'not_in_discovery'), 'subject');
  const reasons = catalog.unassigned.reason_counts;
  check(Array.isArray(reasons) && reasons.length <= 64, 'reasons');
  const seenReasons = new Set();
  const reasonCounts = reasons.map(raw => {
    const r = closed(raw, ['reason', 'member_count']); text(r.reason, 200);
    check(!seenReasons.has(r.reason) && Number.isSafeInteger(r.member_count) && r.member_count > 0
      && r.member_count <= catalog.unassigned.member_count, 'reasons'); seenReasons.add(r.reason); return r;
  }).sort((a, b) => a.reason < b.reason ? -1 : 1);
  check(Array.isArray(catalog.limitations) && catalog.limitations.length <= 64, 'limitations');
  const limitations = catalog.limitations.map(value => text(value, 200));
  check(new Set(limitations).size === limitations.length, 'limitations');
  const labels = new Map(catalog.pockets.map(p => [p.id, { label: text(p.label), county: text(p.county) }]));
  const metadata = bounded({ recorded_catalog_version: 1, usage: 'retained_recorded_group_display_only',
    scope: identity.scope, context_ref: identity.context_ref, catalog_version: 3,
    original_catalog_ref: original.catalog_ref, original_read_model_sha256: hash(v.catalogJson),
    roster_account_ids_sha256: identity.roster_account_ids_sha256,
    group_count: identity.groups.length, account_count: all.size,
    assigned_account_count: catalog.coverage.assigned_account_count,
    unassigned_account_count: catalog.unassigned.member_count,
    subject_membership: subject, limitations, unassigned_reason_counts: reasonCounts }, L.metadata_bytes);
  const groups = identity.groups.map(g => ({ ...g, ...(g.id === 'discovery:unassigned'
    ? { label: 'Unresolved recorded groups', county: null } : labels.get(g.id)) }));
  const pages = [];
  for (let start = 0; start < groups.length; start += L.groups_per_page) {
    op.live(); pages.push(bounded({ recorded_catalog_version: 1, kind: 'recorded_group_display',
      metadata_ref: metadata.ref, page_index: String(pages.length),
      groups: groups.slice(start, start + L.groups_per_page) }, L.page_bytes));
  }
  const manifest = bounded({ recorded_catalog_version: 1, kind: 'recorded_group_display', metadata_ref: metadata.ref,
    group_count: String(groups.length), account_count: String(all.size), pages: pages.map((p, i) => ({
      page_index: String(i), group_count: String(Math.min(L.groups_per_page, groups.length - i * L.groups_per_page)),
      page_ref: p.ref })) }, L.manifest_bytes);
  const receipt = Object.freeze({ recorded_catalog_version: 1, authority: 'not_established',
    manifest_ref: manifest.ref, group_count: groups.length, account_count: all.size, page_count: pages.length });
  issued.set(receipt, { original: { text: original.catalog_original_json, ref: original.catalog_ref },
    metadata, pages, manifest });
  op.live(); return receipt;
}

/** Internal transaction-bound immutable store. The owner registers ALL roots
 * with its versioned original graph, rechecks current rights/subject and commits
 * coherently, or rolls back. No pool, SQL transaction, head, report or blob HTTP
 * endpoint is owned here. Shared finite I/O accounting is not reset per call;
 * no concurrent use until actual I/O has settled, even after cancellation.
 */
export function createCustomCohortRecordedCatalogPageStore(repository, operationOptions = {}) {
  check(repository && !isProxy(repository), 'repository');
  const put = Object.getOwnPropertyDescriptor(repository, 'put'), get = Object.getOwnPropertyDescriptor(repository, 'get');
  check(typeof put?.value === 'function' && typeof get?.value === 'function', 'repository');
  const write = put.value.bind(repository), read = get.value.bind(repository), op = options(operationOptions);
  let busy = false, operations = 0, ioBytes = 0;
  const charge = entry => {
    op.live(); check(++operations <= L.operations, 'operations_limit');
    ioBytes += Number(entry.ref.canonical_utf8_bytes); check(ioBytes <= L.io_bytes, 'io_bytes_limit');
  };
  const load = async entry => {
    charge(entry); const value = await read(entry.ref.content_sha256, entry.ref.canonical_utf8_bytes); op.live();
    check(value === entry.text, 'missing_or_changed_original'); return value;
  };
  const retain = async entry => {
    charge(entry); const ack = reference(await write(entry.text)); op.live();
    check(equal(ack, entry.ref), 'storage_ack');
  };
  const run = async (receipt, task) => {
    const source = sourceOf(receipt); op.live(); check(!busy, 'operation_in_progress'); busy = true;
    try { return await task(source); } finally { busy = false; }
  };
  const roots = source => Object.freeze([source.original.ref, source.metadata.ref,
    ...source.pages.map(p => p.ref), source.manifest.ref]);
  const pinned = (source, value) => {
    const ref = reference(value, L.manifest_bytes); check(equal(ref, source.manifest.ref), 'binding');
  };
  const begin = async source => {
    await load(source.manifest); await load(source.original); await load(source.metadata);
  };
  const end = async source => {
    await load(source.original); await load(source.metadata); await load(source.manifest); op.live();
  };
  return Object.freeze({
    async open(receipt, manifestRef) {
      const source = sourceOf(receipt); pinned(source, manifestRef);
      return run(receipt, async s => {
        await begin(s); await end(s);
        // Navigation only: this header names the complete directory, but no
        // stored display page has been read. It is not a completed catalog.
        return Object.freeze({ authority: 'not_established', status: 'display_directory',
          manifest_ref: s.manifest.ref, manifest_json: s.manifest.text, metadata_json: s.metadata.text });
      });
    },
    async stage(receipt) {
      return run(receipt, async source => {
        for (const entry of [source.original, source.metadata, ...source.pages, source.manifest]) await retain(entry);
        op.live(); return Object.freeze({ authority: 'not_established', manifest_ref: source.manifest.ref,
          retention_refs: roots(source) });
      });
    },
    async reopen(receipt, manifestRef) {
      // Detach syntax before the first await; never let caller mutation rebind
      // a request in a held SQL lane.
      const source = sourceOf(receipt); pinned(source, manifestRef);
      return run(receipt, async s => {
        await begin(s); const groups = [];
        for (const page of s.pages) groups.push(...JSON.parse(await load(page)).groups);
        await end(s);
        return freeze({ authority: 'not_established', status: 'complete_display_catalog',
          manifest_ref: s.manifest.ref, metadata: JSON.parse(s.metadata.text), groups, retention_refs: roots(s) });
      });
    },
    async readPage(receipt, manifestRef, pageIndex) {
      const source = sourceOf(receipt); pinned(source, manifestRef);
      check(Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < source.pages.length, 'page_index');
      return run(receipt, async s => {
        await begin(s); const page = JSON.parse(await load(s.pages[pageIndex])); await end(s);
        // This is exactly ONE display page. It is never a complete population,
        // a replacement roster, a selected union, statistics or Apply authority.
        return freeze({ authority: 'not_established', status: 'display_page', manifest_ref: s.manifest.ref,
          page_count: s.pages.length, group_count: receipt.group_count, account_count: receipt.account_count,
          page_ref: s.pages[pageIndex].ref, page });
      });
    },
  });
}
