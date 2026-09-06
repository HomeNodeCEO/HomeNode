import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { scanOriginalJsonText, classifyOriginalJsonTokenFailure } from './originalJsonTokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function fail(reason) {
  throw Object.assign(new Error(`neighborhood_cohort_blob_${reason}`), { code: `neighborhood_cohort_blob_${reason}` });
}

/** Representation only, not proof of an original read, permissions, or facts.
 * Admit primitive canonical JSON through the existing bounded scanner before
 * JSON.parse. Never round identifiers, rewrite decimals, or hash jsonb::text.
 */
export function prepareNeighborhoodCohortBlob(canonicalJson) {
  let bytes;
  try {
    bytes = scanOriginalJsonText(canonicalJson, 'full_value').usage.input_utf8_bytes;
    const value = JSON.parse(canonicalJson);
    if (canonicalAssessmentJson(value) !== canonicalJson) fail('noncanonical');
    assertNeighborhoodJsonbStorage(value);
  } catch (error) {
    const tokenFailure = classifyOriginalJsonTokenFailure(error);
    if (tokenFailure?.status === 'limit_exceeded' || error?.code === 'neighborhood_jsonb_storage_limit') fail('limit_exceeded');
    if (error?.code === 'neighborhood_cohort_blob_noncanonical') throw error;
    fail('invalid_payload');
  }
  return Object.freeze({
    content_sha256: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    canonical_utf8_bytes: String(bytes),
  });
}

export function prepareNeighborhoodCohortBlobReference(hash, bytes) {
  if (typeof hash !== 'string' || hash.length !== 64 || !HASH.test(hash) || typeof bytes !== 'string' ||
      !/^[1-9][0-9]{0,6}$/.test(bytes) || String(Number(bytes)) !== bytes || Number(bytes) > 1_500_000) fail('invalid_reference');
  return Object.freeze({ content_sha256: hash, canonical_utf8_bytes: bytes });
}

function checkedRow(result, expected, expectedText) {
  if (!result || result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !result.rows[0] || typeof result.rows[0] !== 'object') fail('storage_conflict');
  const row = result.rows[0];
  if (row.content_sha256 !== expected.content_sha256 || row.canonical_utf8_bytes !== expected.canonical_utf8_bytes ||
      (expectedText !== undefined && row.canonical_utf8 !== expectedText)) fail('storage_conflict');
  let actual;
  try { actual = prepareNeighborhoodCohortBlob(row.canonical_utf8); }
  catch { fail('storage_conflict'); }
  if (actual.content_sha256 !== expected.content_sha256 || actual.canonical_utf8_bytes !== expected.canonical_utf8_bytes) fail('storage_conflict');
  return row.canonical_utf8;
}

/** Caller owns the transaction, lifetime/deadline, and fresh workflow access.
 * No pool acquisition, BEGIN/COMMIT, schema creation, current-head mutation, or
 * authority minting occurs here. Bind one organization for this repository's
 * lifetime; callers must not expose it as a generic authenticated blob API.
 */
export function createNeighborhoodCohortBlobRepository(client, organizationId) {
  if (!client || typeof client.query !== 'function' || typeof organizationId !== 'string' ||
      organizationId.length !== 36 || !UUID.test(organizationId)) fail('invalid_scope');
  const organization = organizationId.toLowerCase();
  const query = client.query.bind(client);
  const find = expected => query(`/* neighborhood-cohort-blob:read */
    SELECT content_sha256, canonical_utf8_bytes::text, canonical_utf8
      FROM app.neighborhood_cohort_evidence_blobs
     WHERE organization_id = $1 AND content_sha256 = $2`, [organization, expected.content_sha256]);
  return Object.freeze({
    async put(canonicalJson) {
      const expected = prepareNeighborhoodCohortBlob(canonicalJson);
      const inserted = await query(`/* neighborhood-cohort-blob:insert */
        INSERT INTO app.neighborhood_cohort_evidence_blobs
          (organization_id, content_sha256, canonical_utf8_bytes, canonical_utf8)
        VALUES ($1, $2, $3::integer, $4)
        ON CONFLICT (organization_id, content_sha256) DO NOTHING
        RETURNING content_sha256, canonical_utf8_bytes::text, canonical_utf8`,
      [organization, expected.content_sha256, expected.canonical_utf8_bytes, canonicalJson]);
      if (inserted?.rowCount === 0 && Array.isArray(inserted.rows) && inserted.rows.length === 0) checkedRow(await find(expected), expected, canonicalJson);
      else checkedRow(inserted, expected, canonicalJson);
      return expected;
    },
    async get(contentSha256, canonicalUtf8Bytes) {
      const expected = prepareNeighborhoodCohortBlobReference(contentSha256, canonicalUtf8Bytes);
      const found = await find(expected);
      if (found?.rowCount === 0 && Array.isArray(found.rows) && found.rows.length === 0) return null;
      return checkedRow(found, expected);
    },
  });
}
