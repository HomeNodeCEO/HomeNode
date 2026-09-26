import { createHash } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';

const LIMIT = 4_000_000;
const compress = promisify(gzip), decompress = promisify(gunzip);
const hash = value => createHash('sha256').update(value).digest('hex');
const emptySelectionHash = revision => hash(JSON.stringify({ pockets: [], revision }));
function fail(reason) { throw new TypeError(`custom_cohort_prepared_catalog_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
const same = (left, right) => canonicalAssessmentJson(left) === canonicalAssessmentJson(right);

/** This repository stores only already authorized, public, selection-neutral
 * catalog output. The owner must separately recheck the original context,
 * assignment, subject and current source policy on every read. */
export function createCustomCohortPreparedCatalogRepository(client, scopeJson, contextRef) {
  check(typeof client?.query === 'function', 'client_required');
  const scope = prepareCustomCohortContextScope(scopeJson);
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(contextRef));
  const key = [scope.organization_id, context.context_id, context.context_sha256];
  const query = client.query.bind(client);
  const validate = payload => {
    check(payload && Object.getPrototypeOf(payload) === Object.prototype
      && payload.catalog?.catalog_version === 3 && payload.catalog?.catalog_complete === true
      && payload.catalog?.authority === 'not_established' && payload.catalog?.apply?.status === 'blocked'
      && same(payload.catalog.binding?.context_ref, context)
      && Number.isSafeInteger(payload.catalog.binding?.selection_revision)
      && payload.catalog.binding.selection_revision > 0
      && payload.catalog.binding.selection_sha256 === emptySelectionHash(payload.catalog.binding.selection_revision),
    'invalid_payload');
    check(!Object.hasOwn(payload, 'initial_preview') && !Object.hasOwn(payload, 'private_sales')
      && (!payload.recommendation || (payload.recommendation.authority === 'not_established'
        && payload.recommendation.apply?.status === 'blocked'
        && same(payload.recommendation.binding, payload.catalog.binding))), 'invalid_payload');
  };
  const normalized = payload => {
    validate(payload);
    const binding = { ...payload.catalog.binding, selection_revision: 1, selection_sha256: emptySelectionHash(1) };
    return { ...payload, catalog: { ...payload.catalog, binding },
      ...(payload.recommendation ? { recommendation: { ...payload.recommendation, binding } } : {}) };
  };
  const read = async () => {
    const found = await query(`/* custom-cohort-prepared-catalog:read */
      SELECT payload_sha256, payload_utf8_bytes, compressed_payload
      FROM app.neighborhood_custom_cohort_prepared_catalogs
      WHERE organization_id=$1::uuid AND context_id=$2::uuid AND context_sha256=$3
        AND format_version=1 AND catalog_version=3`, key);
    if (found?.rowCount === 0) return null;
    check(found?.rowCount === 1 && Array.isArray(found.rows) && found.rows.length === 1, 'storage_conflict');
    const row = found.rows[0];
    check(typeof row.payload_sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.payload_sha256)
      && Number.isSafeInteger(row.payload_utf8_bytes) && row.payload_utf8_bytes > 0 && row.payload_utf8_bytes <= LIMIT
      && Buffer.isBuffer(row.compressed_payload) && row.compressed_payload.length > 0
      && row.compressed_payload.length <= LIMIT, 'storage_conflict');
    let data;
    try { data = await decompress(row.compressed_payload, { maxOutputLength: LIMIT }); }
    catch { fail('storage_conflict'); }
    check(data.length === row.payload_utf8_bytes && hash(data) === row.payload_sha256, 'storage_conflict');
    let payload;
    try { payload = JSON.parse(data.toString('utf8')); }
    catch { fail('storage_conflict'); }
    validate(payload);
    check(payload.catalog.binding.selection_revision === 1, 'storage_conflict');
    return payload;
  };
  return Object.freeze({
    async exists() {
      const found = await query(`/* custom-cohort-prepared-catalog:exists */
        SELECT 1 FROM app.neighborhood_custom_cohort_prepared_catalogs
        WHERE organization_id=$1::uuid AND context_id=$2::uuid AND context_sha256=$3
          AND format_version=1 AND catalog_version=3`, key);
      check(found && [0, 1].includes(found.rowCount) && Array.isArray(found.rows)
        && found.rows.length === found.rowCount, 'storage_conflict');
      return found.rowCount === 1;
    },
    read,
    async put(payload) {
      const stored = Buffer.from(JSON.stringify(normalized(payload)), 'utf8');
      check(stored.length > 0 && stored.length <= LIMIT, 'capacity_exceeded');
      const packed = await compress(stored, { level: 1 });
      check(packed.length > 0 && packed.length <= LIMIT, 'capacity_exceeded');
      const digest = hash(stored);
      const result = await query(`/* custom-cohort-prepared-catalog:insert */
        INSERT INTO app.neighborhood_custom_cohort_prepared_catalogs
          (organization_id, context_id, context_sha256, format_version, catalog_version,
           payload_sha256, payload_utf8_bytes, compressed_payload)
        VALUES ($1::uuid,$2::uuid,$3,1,3,$4,$5,$6)
        ON CONFLICT (organization_id, context_id, format_version, catalog_version) DO NOTHING
        RETURNING payload_sha256`, [...key, digest, stored.length, packed]);
      check(result && [0, 1].includes(result.rowCount) && Array.isArray(result.rows)
        && result.rows.length === result.rowCount, 'storage_conflict');
      if (result.rowCount === 1) check(result.rows[0].payload_sha256 === digest, 'storage_conflict');
      // Existing immutable snapshots can legitimately differ when optional
      // nightly display support was refreshed. Keep the first checked result.
      return { status: result.rowCount === 1 ? 'prepared' : 'reused', payload_sha256: digest };
    },
  });
}

export function rebindCustomCohortPreparedCatalog(payload, revision) {
  check(Number.isSafeInteger(revision) && revision > 0, 'invalid_revision');
  check(payload?.catalog?.binding?.selection_revision === 1
    && payload.catalog.binding.selection_sha256 === emptySelectionHash(1), 'invalid_payload');
  const binding = { ...payload.catalog.binding, selection_revision: revision,
    selection_sha256: emptySelectionHash(revision) };
  return { ...payload, catalog: { ...payload.catalog, binding },
    ...(payload.recommendation ? { recommendation: { ...payload.recommendation, binding } } : {}) };
}
