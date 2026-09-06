import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';
import { NEIGHBORHOOD_COHORT_LOCAL_QUERY_EVIDENCE_LIMITS as LIMITS,
  prepareCohortLocalQueryEvidenceV1 } from './cohortEvidenceContract.js';

class AssemblyFailure extends Error {
  constructor(status, reason) { super(reason); this.result = Object.freeze({ status, reason }); }
}
const invalid = reason => { throw new AssemblyFailure('invalid', reason); };
const limited = reason => { throw new AssemblyFailure('limit_exceeded', reason); };
const bytes = text => Buffer.byteLength(text, 'utf8');

function parse(text, maximum) {
  if (text.length > maximum || bytes(text) > maximum) limited('input_bytes');
  try { return JSON.parse(text); } catch { invalid('invalid_json'); }
}

function canonical(value) {
  try { return canonicalAssessmentJson(value); }
  catch (error) {
    if (error instanceof TypeError) {
      if (error.message === 'invalid_neighborhood_assessment:json_limit') limited('input_limit');
      if (error.message === 'invalid_neighborhood_assessment:json_bytes') limited('input_bytes');
      if (error.message === 'invalid_neighborhood_assessment:nonfinite_number') invalid('invalid_value');
    }
    throw error;
  }
}

function blob(text) {
  return { ref: { content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    canonical_utf8_bytes: String(bytes(text)) }, canonical_json: text };
}

/** Assemble the existing retained-byte contract from the original reader inputs.
 * The caller supplies the original query digest; this never recalculates a
 * replacement selection or mints authorization, acquisition or eligibility.
 * No sorting, deduplication or truncation of the account population is allowed.
 */
export function buildCohortLocalQueryEvidenceV1(compactMetadataJson, orderedAccountIdsJson, capturedQuerySelectionSha256) {
  try {
    if (arguments.length !== 3 || [compactMetadataJson, orderedAccountIdsJson, capturedQuerySelectionSha256]
      .some(value => typeof value !== 'string')) invalid('invalid_input_type');
    if (capturedQuerySelectionSha256.length !== 64 || !/^[0-9a-f]{64}$/.test(capturedQuerySelectionSha256)) invalid('invalid_value');
    const metadata = parse(compactMetadataJson, LIMITS.metadata_bytes);
    // The existing authorization preimage has a 1.5 MB whole-document ceiling.
    // An account array exceeding it cannot fit that unchanged contract either.
    const accounts = parse(orderedAccountIdsJson, LIMITS.blob_bytes);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(accounts)) invalid('invalid_shape');
    if (accounts.length > LIMITS.accounts) limited('account_limit');
    if (!accounts.length) invalid('directory_mismatch');
    let previous = null;
    for (const account of accounts) {
      if (typeof account !== 'string' || !account || account.length > 64 || account.trim() !== account ||
        /[\u0000-\u001f\u007f]/.test(account)) invalid('invalid_value');
      if (previous !== null && account <= previous) invalid('directory_mismatch');
      previous = account;
    }
    if (canonical(metadata) !== compactMetadataJson || JSON.stringify(accounts) !== orderedAccountIdsJson) invalid('noncanonical_json');

    const metadataBlob = blob(compactMetadataJson);
    const pageBlobs = [];
    const pages = [];
    for (let start = 0; start < accounts.length; start += LIMITS.page_accounts) {
      const entries = accounts.slice(start, start + LIMITS.page_accounts).map(account_id => ({ account_id }));
      const page_index = String(pages.length);
      const page = blob(canonical({ directory_version: 1, kind: 'authorized_accounts', page_index, entries }));
      pageBlobs.push(page);
      pages.push({ page_index, entry_count: String(entries.length), page: page.ref });
    }
    const entry_count = String(accounts.length);
    const directory = blob(canonical({ directory_version: 1, kind: 'authorized_accounts', entry_count, pages }));
    const preimage = blob(canonical({ query_preimage_version: 1, compact_metadata: metadataBlob.ref,
      ordered_account_roster: { manifest: directory.ref, entry_count } }));
    const bundle = { version: 1, producer_profile: 'local-capture-v3', query_preimage: preimage.ref,
      captured_query_selection_sha256: capturedQuerySelectionSha256,
      blobs: [metadataBlob, directory, preimage, ...pageBlobs]
        .sort((a, b) => a.ref.content_sha256 < b.ref.content_sha256 ? -1 : a.ref.content_sha256 > b.ref.content_sha256 ? 1 : 0) };
    // Final admission verifies every blob, both hashes, complete membership,
    // scope, metadata, storage and all existing resource bounds in one place.
    return prepareCohortLocalQueryEvidenceV1(JSON.stringify(bundle));
  } catch (error) {
    if (error instanceof AssemblyFailure) return error.result;
    throw error;
  }
}
