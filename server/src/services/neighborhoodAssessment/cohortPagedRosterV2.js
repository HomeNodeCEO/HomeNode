import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';

// This is a page-oriented evidence primitive, not an authorization grant or a
// complete capture. The caller must keep onPage writes in an uncommitted job
// transaction until this function returns and source closure is verified.
export const COHORT_PAGED_ROSTER_V2_LIMITS = Object.freeze({
  accounts: 1_000_000, page_accounts: 1_000, pages: 1_000,
  account_characters: 64, page_bytes: 256_000, metadata_bytes: 64_000,
});
const SHA = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
function fail(reason) { throw new TypeError(`cohort_paged_roster_v2_${reason}`); }
function check(condition, reason) { if (!condition) fail(reason); }

function validAccount(value) {
  if (typeof value !== 'string' || !value || value.length > COHORT_PAGED_ROSTER_V2_LIMITS.account_characters
    || value !== value.trim() || CONTROL.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Verify a complete ordered roster as pages are staged. Neither the roster
 * nor its authorization preimage is assembled into one large JSON string. */
export async function stageCohortPagedRosterV2({ compactMetadataJson, pages, declaredAccountCount,
  expectedSelectionSha256, expectedQuerySha256, onPage, signal } = {}) {
  check(typeof compactMetadataJson === 'string'
    && Buffer.byteLength(compactMetadataJson, 'utf8') <= COHORT_PAGED_ROSTER_V2_LIMITS.metadata_bytes,
  'metadata_limit');
  check(Number.isSafeInteger(declaredAccountCount) && declaredAccountCount > 0
    && declaredAccountCount <= COHORT_PAGED_ROSTER_V2_LIMITS.accounts, 'account_limit');
  check(SHA.test(expectedSelectionSha256) && SHA.test(expectedQuerySha256), 'invalid_digest');
  check(pages && typeof pages[Symbol.asyncIterator] === 'function' && typeof onPage === 'function',
    'invalid_input');
  let metadata;
  try { metadata = JSON.parse(compactMetadataJson); } catch { fail('invalid_metadata'); }
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && metadata.authorization?.selection_sha256 === expectedSelectionSha256
    && validAccount(metadata.scope?.account_id)
    && typeof metadata.effective_date === 'string'
    && metadata.authorization.selection && typeof metadata.authorization.selection === 'object'
    && !Array.isArray(metadata.authorization.selection), 'invalid_metadata');
  try { check(canonicalAssessmentJson(metadata) === compactMetadataJson, 'noncanonical_metadata'); }
  catch (error) {
    if (error instanceof TypeError && error.message.startsWith('invalid_neighborhood_assessment:'))
      fail('invalid_metadata');
    throw error;
  }
  // canonicalAssessmentJson sorts these four top-level keys. Stream the same
  // byte representation as v1 without its 1.5 MB whole-array ceiling.
  const selection = createHash('sha256').update('{"account_ids":[', 'utf8');
  const query = createHash('sha256').update(compactMetadataJson, 'utf8');
  const directoryPages = [];
  let count = 0, previous = null, subjectPresent = false;
  for await (const accounts of pages) {
    check(!signal?.aborted, 'cancelled');
    check(Array.isArray(accounts) && accounts.length > 0
      && accounts.length <= COHORT_PAGED_ROSTER_V2_LIMITS.page_accounts, 'invalid_page');
    check(directoryPages.length < COHORT_PAGED_ROSTER_V2_LIMITS.pages, 'page_limit');
    check(count + accounts.length <= declaredAccountCount, 'count_mismatch');
    const entries = [];
    for (const account_id of accounts) {
      check(validAccount(account_id) && (previous === null || previous < account_id), 'account_order');
      previous = account_id;
      subjectPresent ||= account_id === metadata.scope.account_id;
      const encoded = JSON.stringify(account_id);
      selection.update(count++ === 0 ? encoded : `,${encoded}`, 'utf8');
      query.update(encoded, 'utf8').update('\n', 'utf8');
      entries.push({ account_id });
    }
    const page_index = String(directoryPages.length);
    const page_json = canonicalAssessmentJson({ directory_version: 2,
      kind: 'authorized_accounts', page_index, entries });
    const pageBytes = Buffer.byteLength(page_json, 'utf8');
    check(pageBytes <= COHORT_PAGED_ROSTER_V2_LIMITS.page_bytes, 'page_limit');
    const page_sha256 = hash(page_json);
    await onPage(Object.freeze({ page_index: directoryPages.length,
      entry_count: entries.length, page_sha256, page_bytes: pageBytes, page_json }));
    directoryPages.push(Object.freeze({ page_index, entry_count: String(entries.length),
      page: Object.freeze({ content_sha256: page_sha256, canonical_utf8_bytes: String(pageBytes) }) }));
  }
  check(!signal?.aborted, 'cancelled');
  check(count === declaredAccountCount && subjectPresent, 'count_mismatch');
  selection.update('],"effective_date":', 'utf8')
    .update(canonicalAssessmentJson(metadata.effective_date), 'utf8')
    .update(',"scope":', 'utf8')
    .update(canonicalAssessmentJson(metadata.scope), 'utf8')
    .update(',"selection":', 'utf8')
    .update(canonicalAssessmentJson(metadata.authorization.selection), 'utf8')
    .update('}', 'utf8');
  check(selection.digest('hex') === expectedSelectionSha256, 'selection_mismatch');
  check(query.digest('hex') === expectedQuerySha256, 'query_mismatch');
  const manifest_json = canonicalAssessmentJson({ directory_version: 2,
    kind: 'authorized_accounts', entry_count: String(count), pages: directoryPages });
  return Object.freeze({ directory_version: 2, entry_count: count,
    page_count: directoryPages.length, manifest_json,
    manifest_sha256: hash(manifest_json), manifest_bytes: Buffer.byteLength(manifest_json, 'utf8') });
}

/** Re-verify immutable page bytes and the complete manifest on reload. The
 * reader supplies one original page at a time; a missing or changed page is
 * never accepted as a shorter complete roster. */
export async function verifyCohortPagedRosterV2({ manifestJson, compactMetadataJson,
  expectedSelectionSha256, expectedQuerySha256, readPage, signal } = {}) {
  check(typeof manifestJson === 'string' && Buffer.byteLength(manifestJson, 'utf8') <= 512_000
    && typeof readPage === 'function', 'invalid_manifest');
  let manifest;
  try { manifest = JSON.parse(manifestJson); } catch { fail('invalid_manifest'); }
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && Object.keys(manifest).sort().join(',') === 'directory_version,entry_count,kind,pages'
    && manifest.directory_version === 2 && manifest.kind === 'authorized_accounts'
    && Array.isArray(manifest.pages) && manifest.pages.length > 0
    && manifest.pages.length <= COHORT_PAGED_ROSTER_V2_LIMITS.pages
    && typeof manifest.entry_count === 'string' && /^(?:0|[1-9]\d*)$/.test(manifest.entry_count),
  'invalid_manifest');
  const declaredAccountCount = Number(manifest.entry_count);
  check(Number.isSafeInteger(declaredAccountCount) && declaredAccountCount > 0
    && declaredAccountCount <= COHORT_PAGED_ROSTER_V2_LIMITS.accounts, 'invalid_manifest');
  try { check(canonicalAssessmentJson(manifest) === manifestJson, 'invalid_manifest'); }
  catch (error) {
    if (error instanceof TypeError && error.message.startsWith('invalid_neighborhood_assessment:'))
      fail('invalid_manifest');
    throw error;
  }
  async function* retainedPages() {
    for (let index = 0; index < manifest.pages.length; index++) {
      check(!signal?.aborted, 'cancelled');
      const reference = manifest.pages[index];
      check(reference && typeof reference === 'object' && !Array.isArray(reference)
        && Object.keys(reference).sort().join(',') === 'entry_count,page,page_index'
        && reference.page_index === String(index)
        && typeof reference.entry_count === 'string'
        && /^(?:0|[1-9]\d*)$/.test(reference.entry_count)
        && reference.page && typeof reference.page === 'object'
        && Object.keys(reference.page).sort().join(',') === 'canonical_utf8_bytes,content_sha256'
        && SHA.test(reference.page.content_sha256), 'invalid_manifest');
      const text = await readPage({ page_index: index, ...reference.page });
      check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= COHORT_PAGED_ROSTER_V2_LIMITS.page_bytes
        && String(Buffer.byteLength(text, 'utf8')) === reference.page.canonical_utf8_bytes
        && hash(text) === reference.page.content_sha256, 'page_conflict');
      let page;
      try { page = JSON.parse(text); } catch { fail('page_conflict'); }
      check(page && typeof page === 'object' && !Array.isArray(page)
        && Object.keys(page).sort().join(',') === 'directory_version,entries,kind,page_index'
        && page.directory_version === 2 && page.kind === 'authorized_accounts'
        && page.page_index === String(index) && Array.isArray(page.entries)
        && page.entries.length === Number(reference.entry_count)
        && page.entries.every(entry => entry && typeof entry === 'object'
          && !Array.isArray(entry) && Object.keys(entry).join(',') === 'account_id'), 'page_conflict');
      let canonical;
      try { canonical = canonicalAssessmentJson(page); } catch { fail('page_conflict'); }
      check(canonical === text, 'page_conflict');
      yield page.entries.map(entry => entry.account_id);
    }
  }
  const result = await stageCohortPagedRosterV2({ compactMetadataJson,
    pages: retainedPages(), declaredAccountCount, expectedSelectionSha256,
    expectedQuerySha256, onPage: async () => {}, signal });
  check(result.manifest_json === manifestJson, 'manifest_conflict');
  return result;
}
