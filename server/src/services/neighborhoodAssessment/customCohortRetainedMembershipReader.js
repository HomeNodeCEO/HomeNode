import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef }
  from './cohortEvidenceBlobRepository.js';
import { createCustomCohortRetainedCatalogReader } from './customCohortRetainedCatalogReader.js';
import { prepareCohortPagedGroupSelectionV1Metadata } from './cohortPagedGroupSelectionV1.js';
import { createCohortPagedGroupSelectionV1Store } from './cohortPagedGroupSelectionV1Store.js';

function fail(reason) { throw new TypeError(`custom_cohort_retained_membership_${reason}`); }
function check(ok, reason = 'binding') { if (!ok) fail(reason); }
const same = (a, b) => json(a) === json(b);
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
function reference(value, maximum) {
  const r = closed(value, ['content_sha256','canonical_utf8_bytes']);
  const result = blobRef(r.content_sha256, r.canonical_utf8_bytes);
  check(Number(result.canonical_utf8_bytes) <= maximum, 'reference'); return result;
}

/** Internal whole-original reader. All binding pins MUST be supplied by the
 * actual source-checked transactional registry, never a browser/root request.
 * A complete display count alone is not an individual member witness. Verify
 * every original membership/union page and the original independent roster's
 * complete partition descriptors before returning. This is NOT a selected
 * head, source grant, map-page projection, numeric result or report authority.
 * The caller still fences current assignment/source/subject rights both ends.
 */
export function createCustomCohortRetainedMembershipReader(repository, binding, { signal, checkBudget = () => {} } = {}) {
  check(repository && !isProxy(repository), 'repository');
  const get = Object.getOwnPropertyDescriptor(repository, 'get'); check(typeof get?.value === 'function', 'repository');
  const read = get.value.bind(repository), b = closed(binding, ['scopeJson','contextJson','manifestRef',
    'originalCatalogRef','sourceReadModelSha256','rosterAccountIdsSha256','witnessRef']);
  const witnessRef = reference(b.witnessRef, 4_000), displayBinding = { ...b }; delete displayBinding.witnessRef;
  check((signal === undefined || signal instanceof AbortSignal) && typeof checkBudget === 'function', 'options');
  const live = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); check(!signal?.aborted, 'cancelled'); };
  let busy = false, operations = 0, bytes = 0;
  const bounded = Object.freeze({ async get(hash, length) {
    live(); const size = Number(length); check(Number.isSafeInteger(size) && size > 0 && size <= 750_000, 'reference');
    check(++operations <= 512, 'operations_limit'); bytes += size; check(bytes <= 128_000_000, 'io_bytes_limit');
    const result = await read(hash, length); live(); return result;
  }, async put() { fail('read_only'); } });
  const op = { signal, checkBudget: live }, display = createCustomCohortRetainedCatalogReader(bounded, displayBinding, op);
  async function load(ref) {
    const text = await bounded.get(ref.content_sha256, ref.canonical_utf8_bytes);
    check(typeof text === 'string' && Buffer.byteLength(text) === Number(ref.canonical_utf8_bytes), 'missing_original');
    let actual; try { actual = blob(text); } catch { fail('changed_original'); }
    check(same(actual, ref), 'changed_original'); live(); return text;
  }
  return Object.freeze({ async reopen() {
    live(); check(!busy, 'operation_in_progress'); busy = true;
    try {
      const text = await load(witnessRef), w = closed(JSON.parse(text), ['witness_version','usage','authority','scope','context_ref',
        'original_catalog_ref','source_read_model_sha256','roster_account_ids_sha256','account_count','group_count',
        'display_manifest_ref','membership_metadata_ref','membership_manifest_ref']);
      const complete = await display.reopen(), m = complete.metadata;
      check(w.witness_version === 1 && w.usage === 'complete_recorded_catalog_membership_only' && w.authority === 'not_established'
        && same(w.scope,m.scope) && same(w.context_ref,m.context_ref) && same(w.original_catalog_ref,m.original_catalog_ref)
        && w.source_read_model_sha256 === m.original_read_model_sha256 && w.roster_account_ids_sha256 === m.roster_account_ids_sha256
        && w.account_count === m.account_count && w.group_count === m.group_count && same(w.display_manifest_ref,complete.manifest_ref));
      const metadataRef = reference(w.membership_metadata_ref,750_000), manifestRef = reference(w.membership_manifest_ref,750_000);
      const metadataJson = await load(metadataRef), metadata = prepareCohortPagedGroupSelectionV1Metadata(metadataJson);
      check(metadata.revision === 1 && same(metadata.scope,m.scope) && same(metadata.context_ref,m.context_ref)
        && same(metadata.catalog_ref,m.original_catalog_ref) && same(metadata.groups,complete.groups.map(g =>
          ({ id:g.id,member_count:g.member_count,account_ids_sha256:g.account_ids_sha256 }))));
      const manifestJson = await load(manifestRef), verified = await createCohortPagedGroupSelectionV1Store(bounded)
        .verify({ metadataJson,manifestRef,...op });
      check(verified.account_count === m.account_count && verified.membership_count === m.account_count
        && verified.manifest_json === manifestJson, 'complete_partition');
      // Fresh originals and directory fences after full provisional page work.
      const ending = await display.open(); check(same(ending.manifest_ref,complete.manifest_ref));
      check(await load(metadataRef) === metadataJson && await load(manifestRef) === manifestJson
        && await load(witnessRef) === text, 'ending_original'); live();
      const manifest = JSON.parse(manifestJson);
      const refs = [...complete.retention_refs,metadataRef,manifestRef,
        ...manifest.membership_pages.map(p => p.page),...manifest.account_pages.map(p => p.page),witnessRef];
      return Object.freeze({ authority:'not_established',status:'complete_catalog_membership',witness_ref:witnessRef,
        account_count:m.account_count,group_count:m.group_count,metadata_json:metadataJson,manifest_json:manifestJson,
        retention_refs:Object.freeze([...new Map(refs.map(r => [r.content_sha256,Object.freeze(r)])).values()]) });
    } finally { busy = false; }
  } });
}
