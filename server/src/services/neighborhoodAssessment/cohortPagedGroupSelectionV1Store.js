import { isProxy } from 'node:util/types';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { stageCohortPagedGroupSelectionV1, verifyCohortPagedGroupSelectionV1,
  COHORT_PAGED_GROUP_SELECTION_V1_LIMITS as L } from './cohortPagedGroupSelectionV1.js';

function fail(reason) { throw new TypeError(`cohort_paged_group_selection_v1_store_${reason}`); }
function matches(actual, expected) {
  return actual?.content_sha256 === expected.content_sha256
    && actual?.canonical_utf8_bytes === expected.canonical_utf8_bytes;
}
function data(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('storage_conflict');
  return d.value;
}

/** Bind an immutable organization-scoped repository in the owner's transaction.
 * No source reads, authorization, BEGIN/COMMIT or mutable selection-head update.
 * On any failure the caller rolls back; staged pages are not a saved selection.
 * The owner must admit current context/assignment/source rights and compare the
 * complete ORIGINAL catalog before calling either method. Never expose this as
 * a generic authenticated blob read/write endpoint.
 */
export function createCohortPagedGroupSelectionV1Store(repository) {
  if (typeof repository?.put !== 'function' || typeof repository?.get !== 'function') fail('repository_required');
  // Capture the trusted transaction-bound port; replacing a public method
  // during an await cannot install a different reader. Individual reads stay
  // the default for old repositories and single-page selections.
  const batch = typeof repository.getPreparedBatch === 'function' ? repository.getPreparedBatch.bind(repository) : null;
  const readPages = batch ? async refs => {
    const values = await batch(Object.freeze(refs.map(ref => Object.freeze({
      content_sha256: ref.content_sha256, canonical_utf8_bytes: ref.canonical_utf8_bytes,
    }))));
    if (isProxy(values) || !Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype
      || values.length !== refs.length || Reflect.ownKeys(values).length !== values.length + 1) fail('storage_conflict');
    const texts = [];
    for (let i = 0; i < refs.length; i++) {
      const value = data(values, String(i));
      if (value === null) { texts.push(null); continue; }
      if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Reflect.ownKeys(value).length !== 2) fail('storage_conflict');
      const text = data(value, 'canonicalJson'), ref = data(value, 'reference');
      if (!ref || isProxy(ref) || Object.getPrototypeOf(ref) !== Object.prototype
        || Reflect.ownKeys(ref).length !== 2) fail('storage_conflict');
      if (data(ref, 'content_sha256') !== refs[i].content_sha256
        || data(ref, 'canonical_utf8_bytes') !== refs[i].canonical_utf8_bytes
        || typeof text !== 'string') fail('storage_conflict');
      texts.push(text);
    }
    return Object.freeze(texts);
  } : undefined;
  return Object.freeze({
    async stage(input) {
      const options = { ...input };
      const put = async (text, expected) => {
        const actual = await repository.put(text);
        if (!matches(actual, expected)) fail('storage_conflict');
      };
      const result = await stageCohortPagedGroupSelectionV1({ ...options,
        onMembershipPage: value => put(value.page_json, value.ref),
        onAccountPage: value => put(value.page_json, value.ref) });
      if (options.signal?.aborted) fail('cancelled'); options.checkBudget?.();
      await put(options.metadataJson, blob(options.metadataJson));
      if (options.signal?.aborted) fail('cancelled'); options.checkBudget?.();
      await put(result.manifest_json, result.manifest_ref);
      if (options.signal?.aborted) fail('cancelled'); options.checkBudget?.();
      return result;
    },
    async verify({ manifestRef, ...input }) {
      let expected;
      try {
        if (!manifestRef || Object.getPrototypeOf(manifestRef) !== Object.prototype
          || Reflect.ownKeys(manifestRef).length !== 2) fail('invalid_reference');
        for (const key of ['content_sha256', 'canonical_utf8_bytes']) {
          const d = Object.getOwnPropertyDescriptor(manifestRef, key);
          if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('invalid_reference');
        }
        expected = blobRef(manifestRef.content_sha256, manifestRef.canonical_utf8_bytes);
        if (Number(expected.canonical_utf8_bytes) > L.manifest_bytes) fail('invalid_reference');
      } catch { fail('invalid_reference'); }
      if (input.checkBudget !== undefined && typeof input.checkBudget !== 'function') fail('invalid_input');
      if (input.signal?.aborted) fail('cancelled'); input.checkBudget?.();
      const text = await repository.get(expected.content_sha256, expected.canonical_utf8_bytes);
      if (text === null) fail('missing_manifest');
      let actual; try { actual = blob(text); } catch { fail('storage_conflict'); }
      if (!matches(actual, expected)) fail('storage_conflict');
      return verifyCohortPagedGroupSelectionV1({ ...input, manifestJson: text,
        readPage: ({ content_sha256, canonical_utf8_bytes }) => repository.get(content_sha256, canonical_utf8_bytes), readPages });
    },
  });
}
