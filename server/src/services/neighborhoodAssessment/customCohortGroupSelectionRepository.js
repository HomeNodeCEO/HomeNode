import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from './contract.js';
import { prepareCustomCohortContextScope, prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { createNeighborhoodCohortBlobRepository,
  prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { createCohortPagedGroupSelectionV1Store } from './cohortPagedGroupSelectionV1Store.js';
import { COHORT_PAGED_GROUP_SELECTION_V1_LIMITS as L,
  prepareCohortPagedGroupSelectionV1Metadata } from './cohortPagedGroupSelectionV1.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
function fail(reason) { throw new TypeError(`custom_cohort_group_selection_${reason}`); }
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('invalid_input');
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('invalid_input');
  }
}
function ref(value) {
  closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  const result = blobRef(value.content_sha256, value.canonical_utf8_bytes);
  if (Number(result.canonical_utf8_bytes) > L.manifest_bytes) fail('invalid_reference');
  return result;
}
/** Bounded navigation identity, not a source permission or statistical result. */
export function prepareCustomCohortGroupSelectionReference(value) {
  closed(value, ['selection_version', 'selection_revision', 'selection_sha256', 'manifest_ref']);
  if (value.selection_version !== 1 || !Number.isInteger(value.selection_revision)
    || value.selection_revision < 1 || value.selection_revision > 2147483647
    || typeof value.selection_sha256 !== 'string' || !SHA.test(value.selection_sha256)) fail('invalid_reference');
  return Object.freeze({ selection_version: 1, selection_revision: value.selection_revision,
    selection_sha256: value.selection_sha256, manifest_ref: ref(value.manifest_ref) });
}
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 || !result.rows[0]) fail('storage_conflict');
  return result.rows[0];
}
function empty(result) { return result?.rowCount === 0 && Array.isArray(result.rows) && result.rows.length === 0; }
function referenceFromRow(row) {
  if (typeof row.selection_revision !== 'string' || !/^[1-9]\d*$/.test(row.selection_revision)) fail('storage_conflict');
  return prepareCustomCohortGroupSelectionReference({ selection_version: 1,
    selection_revision: Number(row.selection_revision), selection_sha256: row.selection_sha256,
    manifest_ref: { content_sha256: row.manifest_content_sha256, canonical_utf8_bytes: row.manifest_canonical_utf8_bytes } });
}
const same = (a, b) => json(a) === json(b);

/** Transaction-bound selection revision/head storage, NOT the live selection
 * owner. The future owner must recheck current actor, assignment, original
 * catalog and source rights before each read/write and before committing. It
 * derives metadata from that catalog, never from browser-supplied memberships.
 * This helper verifies all staged originals, binds the exact retained context,
 * serializes head changes on that context, and rejects stale/lost-ACK conflicts.
 * It does not BEGIN/COMMIT, stage replacement sources, edit workspace/report
 * sections, apply statistics, or activate an HTTP endpoint. Roll back on failure.
 */
export function createCustomCohortGroupSelectionRepository(client, scopeJson, contextJson,
  { signal, checkBudget = () => {} } = {}) {
  if (typeof client?.query !== 'function' || typeof client.release !== 'function') fail('caller_client_required');
  if (typeof checkBudget !== 'function') fail('invalid_input');
  const scope = prepareCustomCohortContextScope(scopeJson), context = prepareCustomCohortContextReference(contextJson);
  const values = [scope.organization_id, context.context_id, scope.report_file_id, scope.assignment_file_id,
    scope.account_id, context.context_revision, context.context_sha256];
  const originalQuery = client.query;
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget(); };
  const query = async (...args) => { check(); const result = await Reflect.apply(originalQuery, client, args); check(); return result; };
  const blobs = createNeighborhoodCohortBlobRepository({ query, release() {} }, scope.organization_id);
  const store = createCohortPagedGroupSelectionV1Store(blobs);
  const transaction = async () => {
    const id = one(await query('/* custom-cohort-group-selection:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if (typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  const target = async write => {
    const row = one(await query(`/* custom-cohort-group-selection:target */
      SELECT context_id::text,context_revision::text,context_sha256
      FROM app.neighborhood_custom_cohort_contexts
      WHERE organization_id=$1 AND context_id=$2 AND report_file_id=$3 AND assignment_file_id=$4::bigint
        AND account_id=$5 AND context_revision=$6::smallint AND context_sha256=$7
      -- Serialize head writers/readers without blocking child FK key-share
      -- checks: this parent context and its key are immutable.
      FOR ${write ? 'NO KEY UPDATE' : 'SHARE'} NOWAIT`, values));
    if (row.context_id !== context.context_id || row.context_revision !== context.context_revision
      || row.context_sha256 !== context.context_sha256) fail('target_mismatch');
  };
  const columns = 's.selection_revision::text,s.selection_sha256,s.manifest_content_sha256,s.manifest_canonical_utf8_bytes::text,s.operation_id::text,s.request_sha256';
  const where = 's.organization_id=$1 AND s.context_id=$2 AND s.report_file_id=$3 AND s.assignment_file_id=$4::bigint AND s.account_id=$5 AND s.context_revision=$6::smallint AND s.context_sha256=$7';
  const readHead = () => query(`/* custom-cohort-group-selection:head */ SELECT ${columns}
    FROM app.neighborhood_custom_cohort_group_selection_heads h
    JOIN app.neighborhood_custom_cohort_group_selections s ON s.organization_id=h.organization_id
      AND s.context_id=h.context_id AND s.selection_revision=h.selection_revision WHERE ${where}`, values);
  const headReference = result => empty(result) ? null : referenceFromRow(one(result));
  const checkedMetadata = text => {
    let value;
    try { value = prepareCohortPagedGroupSelectionV1Metadata(text); } catch { fail('invalid_metadata'); }
    if (!same(value.scope, scope) || !same(value.context_ref, context)
      || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 2147483647) fail('target_mismatch');
    // Read the actual catalog original as well as the metadata/pages. The owner
    // separately proves its group semantics and CURRENT source authorization.
    closed(value.catalog_ref, ['content_sha256', 'canonical_utf8_bytes']);
    blobRef(value.catalog_ref.content_sha256, value.catalog_ref.canonical_utf8_bytes);
    return value;
  };
  const verify = async (metadataJson, manifestRef, onAccountPage) => {
    const m = checkedMetadata(metadataJson); check();
    if (await blobs.get(m.catalog_ref.content_sha256, m.catalog_ref.canonical_utf8_bytes) === null) fail('missing_catalog');
    return store.verify({ metadataJson, manifestRef, signal, checkBudget, onAccountPage });
  };
  return Object.freeze({
    /** Read only the scoped head identity. No original evidence/facts are issued. */
    async peekCurrent() {
      const started = await transaction(); await target(false);
      const selection_ref = headReference(await readHead());
      if (await transaction() !== started) fail('caller_transaction_required');
      return Object.freeze({ authority: 'not_established', selection_ref });
    },
    /** Reopen every original, and require that this is still the current head.
     * The optional visitor is owner-local provisional work, never public data
     * delivery; a later original, transaction or final rights fence can fail.
     */
    async getCurrent(input, { onAccountPage } = {}) {
      closed(input, ['metadataJson', 'selectionRef']);
      if (onAccountPage !== undefined && typeof onAccountPage !== 'function') fail('invalid_input');
      const metadataJson = input.metadataJson, expected = prepareCustomCohortGroupSelectionReference(input.selectionRef);
      const m = checkedMetadata(metadataJson);
      if (m.revision !== expected.selection_revision) fail('invalid_reference');
      const started = await transaction(); await target(false);
      if (!same(headReference(await readHead()), expected)) fail('selection_changed');
      const original = await verify(metadataJson, expected.manifest_ref, onAccountPage);
      if (original.selection_sha256 !== expected.selection_sha256) fail('storage_conflict');
      if (await transaction() !== started) fail('caller_transaction_required');
      return Object.freeze({ authority: 'not_established', selection_ref: expected, original });
    },
    /** Register one complete staged selection and advance its head atomically.
     * Exact lost-ACK retries reuse the existing operation only while it is still
     * current; replay never rewinds a newer selection or invents broad defaults.
     */
    async put(input) {
      closed(input, ['operationId', 'expectedSelectionRef', 'metadataJson', 'manifestRef']);
      const operationId = input.operationId, metadataJson = input.metadataJson, manifestRef = ref(input.manifestRef);
      if (typeof operationId !== 'string' || !UUID.test(operationId)) fail('invalid_operation');
      const expected = input.expectedSelectionRef === null ? null : prepareCustomCohortGroupSelectionReference(input.expectedSelectionRef);
      const m = checkedMetadata(metadataJson);
      if (m.revision !== (expected?.selection_revision ?? 0) + 1) fail('invalid_revision');
      const request_sha256 = digest({ scope, context, operationId, expected, metadataJson, manifestRef });
      const started = await transaction(); await target(true);
      const head = headReference(await readHead());
      const prior = await query(`/* custom-cohort-group-selection:operation */ SELECT ${columns}
        FROM app.neighborhood_custom_cohort_group_selections s WHERE s.organization_id=$1 AND s.operation_id=$2`,
      [scope.organization_id, operationId]);
      if (!empty(prior)) {
        const row = one(prior), existing = referenceFromRow(row);
        if (row.request_sha256 !== request_sha256) fail('operation_conflict');
        if (existing.selection_revision !== m.revision || !same(existing.manifest_ref, manifestRef)
          || row.operation_id !== operationId) fail('storage_conflict');
        if (!same(head, existing)) fail('selection_changed');
        const original = await verify(metadataJson, existing.manifest_ref);
        if (original.selection_sha256 !== existing.selection_sha256 || row.operation_id !== operationId) fail('storage_conflict');
        if (await transaction() !== started) fail('caller_transaction_required');
        return Object.freeze({ status: 'reused', authority: 'not_established', operation_id: operationId, selection_ref: existing });
      }
      if (!same(head, expected)) fail('selection_changed');
      const original = await verify(metadataJson, manifestRef);
      if (await transaction() !== started) fail('caller_transaction_required');
      const selection_ref = prepareCustomCohortGroupSelectionReference({ selection_version: 1,
        selection_revision: m.revision, selection_sha256: original.selection_sha256, manifest_ref: manifestRef });
      const inserted = one(await query(`/* custom-cohort-group-selection:insert */
        INSERT INTO app.neighborhood_custom_cohort_group_selections
          (organization_id,context_id,report_file_id,assignment_file_id,account_id,context_revision,context_sha256,
            selection_revision,operation_id,request_sha256,selection_sha256,manifest_content_sha256,manifest_canonical_utf8_bytes)
        VALUES ($1,$2,$3,$4::bigint,$5,$6::smallint,$7,$8::integer,$9,$10,$11,$12,$13::integer)
        ON CONFLICT DO NOTHING RETURNING selection_revision::text,selection_sha256,manifest_content_sha256,
          manifest_canonical_utf8_bytes::text,operation_id::text,request_sha256`,
      [...values, m.revision, operationId, request_sha256, original.selection_sha256,
        manifestRef.content_sha256, manifestRef.canonical_utf8_bytes]));
      if (!same(referenceFromRow(inserted), selection_ref) || inserted.operation_id !== operationId
        || inserted.request_sha256 !== request_sha256) fail('storage_conflict');
      const changed = expected === null
        ? await query(`/* custom-cohort-group-selection:head-insert */
          INSERT INTO app.neighborhood_custom_cohort_group_selection_heads (organization_id,context_id,selection_revision)
          VALUES ($1,$2,$3::integer) ON CONFLICT DO NOTHING RETURNING selection_revision::text`,
        [scope.organization_id, context.context_id, m.revision])
        : await query(`/* custom-cohort-group-selection:head-update */
          UPDATE app.neighborhood_custom_cohort_group_selection_heads SET selection_revision=$3::integer
          WHERE organization_id=$1 AND context_id=$2 AND selection_revision=$4::integer RETURNING selection_revision::text`,
        [scope.organization_id, context.context_id, m.revision, expected.selection_revision]);
      if (one(changed).selection_revision !== String(m.revision) || !same(headReference(await readHead()), selection_ref)) fail('storage_conflict');
      if (await transaction() !== started) fail('caller_transaction_required');
      return Object.freeze({ status: 'stored', authority: 'not_established', operation_id: operationId, selection_ref });
    },
  });
}
