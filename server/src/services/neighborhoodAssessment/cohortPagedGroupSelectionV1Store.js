import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { stageCohortPagedGroupSelectionV1, verifyCohortPagedGroupSelectionV1 } from './cohortPagedGroupSelectionV1.js';

function fail(reason) { throw new TypeError(`cohort_paged_group_selection_v1_store_${reason}`); }
function matches(actual, expected) {
  return actual?.content_sha256 === expected.content_sha256
    && actual?.canonical_utf8_bytes === expected.canonical_utf8_bytes;
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
        if (!manifestRef || Reflect.ownKeys(manifestRef).length !== 2) fail('invalid_reference');
        expected = blobRef(manifestRef.content_sha256, manifestRef.canonical_utf8_bytes);
      } catch { fail('invalid_reference'); }
      if (input.signal?.aborted) fail('cancelled'); input.checkBudget?.();
      const text = await repository.get(expected.content_sha256, expected.canonical_utf8_bytes);
      if (text === null) fail('missing_manifest');
      let actual; try { actual = blob(text); } catch { fail('storage_conflict'); }
      if (!matches(actual, expected)) fail('storage_conflict');
      return verifyCohortPagedGroupSelectionV1({ ...input, manifestJson: text,
        readPage: ({ content_sha256, canonical_utf8_bytes }) => repository.get(content_sha256, canonical_utf8_bytes) });
    },
  });
}
