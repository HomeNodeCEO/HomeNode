import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortRecordedCatalogSource, createCustomCohortRecordedCatalogPageStore }
  from './customCohortRecordedCatalogPages.js';
import { prepareCustomCohortRecordedGroupSelection } from './customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store } from './cohortPagedGroupSelectionV1Store.js';
import { prepareNeighborhoodCohortBlob as blob } from './cohortEvidenceBlobRepository.js';

const sources = new WeakMap();
const LIMITS = Object.freeze({ operations: 512, io_bytes: 128_000_000 });
function fail(reason) { throw new TypeError(`custom_cohort_catalog_membership_witness_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
const sameRef = (a, b) => a?.content_sha256 === b.content_sha256
  && a?.canonical_utf8_bytes === b.canonical_utf8_bytes;
function options({ signal, checkBudget = () => {} } = {}) {
  check(typeof checkBudget === 'function' && (signal === undefined || signal instanceof AbortSignal), 'options');
  const live = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); check(!signal?.aborted, 'cancelled'); };
  return { signal, checkBudget: live, live };
}
function input(value) {
  const keys = ['scopeJson', 'contextJson', 'catalogJson', 'rosterJson'];
  check(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length, 'input');
  const copy = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(d?.enumerable && Object.hasOwn(d, 'value') && typeof d.value === 'string', 'input'); copy[key] = d.value;
  }
  return copy;
}

/** Preparation-only bridge: retain the COMPLETE original v3 partition as real
 * (account,group) pages alongside the small display graph. Counts/digests in a
 * display catalog alone cannot prove that a particular map parcel is a member.
 * Existing producers verify every group and the independent complete roster.
 * This whole-population artifact is NOT the appraiser's selected area/head.
 * No legal-label inference, source/assignment authority or capture-cap change.
 * Inputs must be freshly authorized original server read models, not browser
 * JSON. The future executable owner still needs both current-rights fences and
 * coherent registration/retention; no live reader or route is added here. */
export async function prepareCustomCohortCatalogMembershipWitness(value, operationOptions = {}) {
  const v = input(value), op = options(operationOptions); op.live();
  const display = await prepareCustomCohortRecordedCatalogSource(v, op); op.live();
  // The display compiler has admitted the entire original partition, including
  // all unassigned accounts; select every actual group only for this artifact.
  const catalog = JSON.parse(v.catalogJson), ids = catalog.pockets.map(p => p.id);
  if (catalog.unassigned.member_count) ids.push('discovery:unassigned');
  const membership = await prepareCustomCohortRecordedGroupSelection({ ...v,
    includedGroupIds: ids, revision: 1, catalogIdentityVersion: 2, signal: op.signal, checkBudget: op.checkBudget });
  op.live();
  const receipt = Object.freeze({ witness_version: 1, authority: 'not_established',
    account_count: display.account_count, group_count: display.group_count });
  sources.set(receipt, { display, membership }); return receipt;
}

/** Stage and fully verify BOTH graphs in the caller's same transaction before
 * returning a supplementary registration root. Roll back ALL writes on any
 * error. Aggregate finite I/O is shared across both stores and every call; no
 * cache, SQL/pool/commit, mutable head, report Apply or generic blob API. The
 * issued source is transient compiler input, never a permanent access grant. */
export function createCustomCohortCatalogMembershipWitnessStore(repository, operationOptions = {}) {
  check(repository && !isProxy(repository), 'repository');
  const put = Object.getOwnPropertyDescriptor(repository, 'put'), get = Object.getOwnPropertyDescriptor(repository, 'get');
  check(typeof put?.value === 'function' && typeof get?.value === 'function', 'repository');
  const write = put.value.bind(repository), read = get.value.bind(repository), op = options(operationOptions);
  let busy = false, operations = 0, bytes = 0;
  const charge = size => {
    op.live(); check(Number.isSafeInteger(size) && size > 0 && size <= 1_500_000, 'io_size');
    check(++operations <= LIMITS.operations, 'operations_limit'); bytes += size; check(bytes <= LIMITS.io_bytes, 'io_bytes_limit');
  };
  const bounded = Object.freeze({
    async put(text) { charge(Buffer.byteLength(text)); const result = await write(text); op.live(); return result; },
    async get(hash, length) { charge(Number(length)); const result = await read(hash, length); op.live(); return result; },
  });
  const displayStore = createCustomCohortRecordedCatalogPageStore(bounded, op);
  const memberStore = createCohortPagedGroupSelectionV1Store(bounded);
  return Object.freeze({
    async stage(receipt) {
      const source = sources.get(receipt); check(source, 'issued_source_required'); op.live(); check(!busy, 'operation_in_progress'); busy = true;
      try {
        const display = await displayStore.stage(source.display);
        const complete = await displayStore.reopen(source.display, display.manifest_ref), m = complete.metadata;
        check(sameRef(m.original_catalog_ref, source.membership.catalog_ref), 'catalog_binding');
        const args = { metadataJson: source.membership.metadata_json, signal: op.signal, checkBudget: op.checkBudget };
        const members = await memberStore.stage({ ...args, membershipPages: source.membership.membershipPages() }); op.live();
        const verified = await memberStore.verify({ ...args, manifestRef: members.manifest_ref }); op.live();
        check(verified.manifest_json === members.manifest_json && members.account_count === m.account_count
          && members.membership_count === m.account_count, 'complete_partition');
        await displayStore.reopen(source.display, display.manifest_ref); op.live();
        check(await bounded.get(members.manifest_ref.content_sha256, members.manifest_ref.canonical_utf8_bytes)
          === members.manifest_json, 'ending_original');
        const memberMetadataRef = blob(source.membership.metadata_json);
        check(await bounded.get(memberMetadataRef.content_sha256, memberMetadataRef.canonical_utf8_bytes)
          === source.membership.metadata_json, 'ending_original'); op.live();
        const metadata = JSON.parse(source.membership.metadata_json);
        check(metadata.groups.length === m.group_count, 'complete_partition');
        const witness_json = json({ witness_version: 1, usage: 'complete_recorded_catalog_membership_only',
          authority: 'not_established', scope: m.scope, context_ref: m.context_ref,
          original_catalog_ref: m.original_catalog_ref, source_read_model_sha256: m.original_read_model_sha256,
          roster_account_ids_sha256: m.roster_account_ids_sha256, account_count: m.account_count, group_count: m.group_count,
          display_manifest_ref: display.manifest_ref, membership_metadata_ref: memberMetadataRef,
          membership_manifest_ref: members.manifest_ref });
        const witness_ref = blob(witness_json), root = JSON.parse(members.manifest_json);
        const refs = [...display.retention_refs, memberMetadataRef, members.manifest_ref,
          ...root.membership_pages.map(p => p.page), ...root.account_pages.map(p => p.page), witness_ref];
        check(sameRef(await bounded.put(witness_json), witness_ref), 'storage_ack');
        check(await bounded.get(witness_ref.content_sha256, witness_ref.canonical_utf8_bytes) === witness_json, 'ending_original'); op.live();
        return Object.freeze({ witness_version: 1, authority: 'not_established', witness_ref, witness_json,
          retention_refs: Object.freeze([...new Map(refs.map(ref => [ref.content_sha256, ref])).values()]) });
      } finally { busy = false; }
    },
  });
}
