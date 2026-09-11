import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';
import { scanOriginalJsonText, classifyOriginalJsonTokenFailure } from './originalJsonTokens.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
// Representation-validation receipt only; never source provenance or access.
// Weak identity keeps no encoded copy of a dense study's already checked bytes.
const validatedReferences = new WeakSet();
export const NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS = Object.freeze({ records: 8, bytes: 2_000_000 });
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
  const reference = Object.freeze({
    content_sha256: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
    canonical_utf8_bytes: String(bytes),
  });
  validatedReferences.add(reference);
  return reference;
}

export function prepareNeighborhoodCohortBlobReference(hash, bytes) {
  if (typeof hash !== 'string' || hash.length !== 64 || !HASH.test(hash) || typeof bytes !== 'string' ||
      !/^[1-9][0-9]{0,6}$/.test(bytes) || String(Number(bytes)) !== bytes || Number(bytes) > 1_500_000) fail('invalid_reference');
  return Object.freeze({ content_sha256: hash, canonical_utf8_bytes: bytes });
}

/** Reuse only an actual in-process representation receipt for identical bytes.
 * This is neither a stored-read receipt nor permission to disclose evidence. */
export function recheckNeighborhoodCohortBlob(canonicalJson, reference) {
  if (!validatedReferences.has(reference) || typeof canonicalJson !== 'string'
    || String(Buffer.byteLength(canonicalJson, 'utf8')) !== reference.canonical_utf8_bytes
    || createHash('sha256').update(canonicalJson, 'utf8').digest('hex') !== reference.content_sha256) fail('invalid_representation_receipt');
  return reference;
}

function checkedRow(result, expected, expectedText, preparedRead = false) {
  if (!result || result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      !result.rows[0] || typeof result.rows[0] !== 'object') fail('storage_conflict');
  const row = result.rows[0];
  if (row.content_sha256 !== expected.content_sha256 || row.canonical_utf8_bytes !== expected.canonical_utf8_bytes ||
      (expectedText !== undefined && row.canonical_utf8 !== expectedText)) fail('storage_conflict');
  // INSERT/replay has already validated the exact primitive string. Matching
  // returned bytes need no second parse/scan; independent reads still do.
  if (expectedText !== undefined) return row.canonical_utf8;
  let actual;
  try { actual = prepareNeighborhoodCohortBlob(row.canonical_utf8); }
  catch { fail('storage_conflict'); }
  if (actual.content_sha256 !== expected.content_sha256 || actual.canonical_utf8_bytes !== expected.canonical_utf8_bytes) fail('storage_conflict');
  if (preparedRead) return Object.freeze({ canonicalJson: row.canonical_utf8, reference: actual });
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
    /** Internal retention of original validation receipts. Recheck hash/length
     * against immutable text, then use bounded parameterized multi-row INSERT.
     * Copied/forged references are not receipts. Caller still owns rollback and
     * final authorization; no report/context can be published by this method. */
    async putPreparedBatch(entries) {
      if (!Array.isArray(entries) || !entries.length || entries.length > NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.records) fail('invalid_prepared_batch');
      for (let i = 0; i < entries.length; i++) if (!Object.hasOwn(entries, i)) fail('invalid_prepared_batch');
      let bytes = 0;
      const expected = new Map();
      const captured = entries.map(entry => {
        const ref = entry?.reference, text = entry?.canonicalJson;
        if (!validatedReferences.has(ref) || typeof text !== 'string'
          || String(Buffer.byteLength(text, 'utf8')) !== ref.canonical_utf8_bytes
          || createHash('sha256').update(text, 'utf8').digest('hex') !== ref.content_sha256) fail('invalid_prepared_batch');
        bytes += Number(ref.canonical_utf8_bytes);
        if (bytes > NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.bytes || expected.has(ref.content_sha256)) fail('invalid_prepared_batch');
        const value = { ref, text }; expected.set(ref.content_sha256, value); return value;
      });
      const accept = result => {
        if (!result || !Array.isArray(result.rows) || result.rowCount !== result.rows.length) fail('storage_conflict');
        for (const row of result.rows) {
          const entry = expected.get(row?.content_sha256);
          if (!entry) fail('storage_conflict');
          checkedRow({ rows: [row], rowCount: 1 }, entry.ref, entry.text);
          expected.delete(entry.ref.content_sha256);
        }
      };
      accept(await query(`/* neighborhood-cohort-blob:insert-batch */
        INSERT INTO app.neighborhood_cohort_evidence_blobs
          (organization_id, content_sha256, canonical_utf8_bytes, canonical_utf8)
        SELECT $1, input.hash, input.bytes, input.text
          FROM unnest($2::text[], $3::integer[], $4::text[]) AS input(hash, bytes, text)
        ON CONFLICT (organization_id, content_sha256) DO NOTHING
        RETURNING content_sha256, canonical_utf8_bytes::text, canonical_utf8`,
      [organization, captured.map(entry => entry.ref.content_sha256), captured.map(entry => Number(entry.ref.canonical_utf8_bytes)),
        captured.map(entry => entry.text)]));
      if (expected.size) accept(await query(`/* neighborhood-cohort-blob:read-batch */
        SELECT content_sha256, canonical_utf8_bytes::text, canonical_utf8
          FROM app.neighborhood_cohort_evidence_blobs
         WHERE organization_id=$1 AND content_sha256=ANY($2::text[])`, [organization, [...expected.keys()]]));
      if (expected.size) fail('storage_conflict');
      return captured.map(entry => entry.ref);
    },
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
    /** Fresh scoped read with full original validation. The optional receipt
     * lets the same operation recheck reconstructed bytes without scanning the
     * identical representation again; independent reads always validate fully. */
    async getPrepared(contentSha256, canonicalUtf8Bytes) {
      const expected = prepareNeighborhoodCohortBlobReference(contentSha256, canonicalUtf8Bytes);
      const found = await find(expected);
      if (found?.rowCount === 0 && Array.isArray(found.rows) && found.rows.length === 0) return null;
      return checkedRow(found, expected, undefined, true);
    },
    /** Bounded fresh reads, not a cache. Return caller order, including explicit
     * missing entries; every returned original gets the same full validation. */
    async getPreparedBatch(references) {
      if (!Array.isArray(references) || !references.length
        || references.length > NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.records) fail('invalid_read_batch');
      const captured = [], expected = new Map(); let bytes = 0;
      for (let i = 0; i < references.length; i++) {
        if (!Object.hasOwn(references, i)) fail('invalid_read_batch');
        const ref = prepareNeighborhoodCohortBlobReference(references[i]?.content_sha256, references[i]?.canonical_utf8_bytes);
        bytes += Number(ref.canonical_utf8_bytes);
        if (bytes > NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS.bytes || expected.has(ref.content_sha256)) fail('invalid_read_batch');
        captured.push(ref); expected.set(ref.content_sha256, ref);
      }
      // Bound transferred bytes by the validated request even if stored metadata
      // or text was corrupted. A mismatch becomes a conflict, not a partial read.
      const found = await query(`/* neighborhood-cohort-blob:read-batch */
        SELECT b.content_sha256, b.canonical_utf8_bytes::text,
          CASE WHEN b.canonical_utf8_bytes=input.bytes AND octet_length(b.canonical_utf8)=input.bytes
            THEN b.canonical_utf8 ELSE NULL END AS canonical_utf8
        FROM unnest($2::text[], $3::integer[]) AS input(hash, bytes)
        JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=$1 AND b.content_sha256=input.hash`,
      [organization, captured.map(ref => ref.content_sha256), captured.map(ref => Number(ref.canonical_utf8_bytes))]);
      if (!found || !Array.isArray(found.rows) || found.rowCount !== found.rows.length) fail('storage_conflict');
      const values = new Map();
      for (const row of found.rows) {
        const ref = expected.get(row?.content_sha256);
        if (!ref || values.has(ref.content_sha256)) fail('storage_conflict');
        values.set(ref.content_sha256, checkedRow({ rows: [row], rowCount: 1 }, ref, undefined, true));
      }
      return Object.freeze(captured.map(ref => values.get(ref.content_sha256) ?? null));
    },
  });
}
