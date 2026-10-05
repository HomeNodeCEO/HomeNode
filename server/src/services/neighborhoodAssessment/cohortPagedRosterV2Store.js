import { stageCohortPagedRosterV2, verifyCohortPagedRosterV2 } from './cohortPagedRosterV2.js';

function fail(reason) {
  throw new TypeError(`cohort_paged_roster_v2_store_${reason}`);
}

/** Bind to an organization-scoped immutable blob repository inside a caller-
 * owned transaction. Staged pages are not authority or a complete capture.
 * The caller must roll back on any failure, recheck the full source closure and
 * assignment rights, then register the context in the same final transaction.
 */
export function createCohortPagedRosterV2Store(blobRepository) {
  if (typeof blobRepository?.put !== 'function' || typeof blobRepository?.get !== 'function')
    fail('repository_required');
  return Object.freeze({
    async stage(input) {
      const retained = [];
      const result = await stageCohortPagedRosterV2({ ...input, onPage: async page => {
        const reference = await blobRepository.put(page.page_json);
        if (reference?.content_sha256 !== page.page_sha256
          || reference?.canonical_utf8_bytes !== String(page.page_bytes)) fail('storage_conflict');
        retained.push(reference);
      } });
      const manifest = await blobRepository.put(result.manifest_json);
      if (manifest?.content_sha256 !== result.manifest_sha256
        || manifest?.canonical_utf8_bytes !== String(result.manifest_bytes)) fail('storage_conflict');
      return Object.freeze({ ...result, manifest: Object.freeze(manifest),
        pages: Object.freeze(retained) });
    },
    async verify({ manifest, ...input }) {
      if (!manifest || typeof manifest.content_sha256 !== 'string'
        || typeof manifest.canonical_utf8_bytes !== 'string') fail('invalid_manifest');
      const manifestJson = await blobRepository.get(manifest.content_sha256,
        manifest.canonical_utf8_bytes);
      if (manifestJson === null) fail('missing_manifest');
      return verifyCohortPagedRosterV2({ ...input, manifestJson,
        readPage: async ({ content_sha256, canonical_utf8_bytes }) =>
          blobRepository.get(content_sha256, canonical_utf8_bytes) });
    },
  });
}
