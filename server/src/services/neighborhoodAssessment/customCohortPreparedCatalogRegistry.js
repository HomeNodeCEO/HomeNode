import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify, types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { createNeighborhoodCohortBlobRepository } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortRecordedCatalogSource, createCustomCohortRecordedCatalogPageStore } from './customCohortRecordedCatalogPages.js';
import { restoreCustomCohortIndexedObservationPreview } from './customCohortObservationPreview.js';
import { createCustomCohortRetainedCatalogReader } from './customCohortRetainedCatalogReader.js';
import { prepareCustomCohortCatalogMembershipWitness, createCustomCohortCatalogMembershipWitnessStore }
  from './customCohortCatalogMembershipWitness.js';
import { createCustomCohortRetainedMembershipReader } from './customCohortRetainedMembershipReader.js';

const unpack = promisify(gunzip), hash = value => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const PINS = ['source_catalog_format_version', 'catalog_sha256', 'catalog_utf8_bytes', 'compressed_catalog_sha256',
  'preview_sha256', 'preview_utf8_bytes', 'compressed_preview_sha256'];
const ROOT = ['manifest_sha256', 'manifest_utf8_bytes', 'original_catalog_sha256', 'original_catalog_utf8_bytes',
  'source_read_model_sha256', 'roster_account_ids_sha256'];
function fail(reason) { throw new TypeError(`custom_cohort_prepared_catalog_registry_${reason}`); }
function check(ok, reason = 'storage_conflict') { if (!ok) fail(reason); }
const same = (a, b) => json(a) === json(b);
function one(result, missing = false) {
  check(result && [0, 1].includes(result.rowCount) && Array.isArray(result.rows) && result.rows.length === result.rowCount);
  if (!result.rowCount) { check(missing); return null; } return result.rows[0];
}
function pins(row) {
  check(row && [1, 2].includes(row.source_catalog_format_version));
  const result = Object.fromEntries(PINS.map(key => [key, row[key]]));
  for (const key of PINS.filter(k => k.endsWith('sha256'))) check(typeof result[key] === 'string' && SHA.test(result[key]));
  for (const [key, maximum] of [['catalog_utf8_bytes', 4_000_000], ['preview_utf8_bytes', 64_000_000]])
    check(Number.isSafeInteger(result[key]) && result[key] > 0 && result[key] <= maximum);
  return Object.freeze(result);
}
function registered(row) {
  const source = pins(row);
  for (const key of ROOT.filter(k => k.endsWith('sha256'))) check(typeof row[key] === 'string' && SHA.test(row[key]));
  for (const [key, maximum] of [['manifest_utf8_bytes', 16_000], ['original_catalog_utf8_bytes', 750_000]])
    check(Number.isSafeInteger(row[key]) && row[key] > 0 && row[key] <= maximum);
  return Object.freeze({ ...source, ...Object.fromEntries(ROOT.map(key => [key, row[key]])) });
}
const lineage = `FROM app.neighborhood_custom_cohort_contexts o
  JOIN LATERAL (SELECT candidate.* FROM app.neighborhood_custom_cohort_prepared_catalogs candidate
    WHERE candidate.organization_id=o.organization_id AND candidate.context_id=o.context_id
      AND candidate.context_sha256=o.context_sha256 AND candidate.format_version IN (1,2) AND candidate.catalog_version=3
    ORDER BY candidate.format_version DESC LIMIT 1) c ON true
  JOIN app.neighborhood_custom_cohort_prepared_previews p
    ON p.organization_id=o.organization_id AND p.context_id=o.context_id AND p.context_sha256=o.context_sha256 AND p.format_version=1
  WHERE o.organization_id=$1::uuid AND o.context_id=$2::uuid AND o.context_sha256=$3
    AND o.report_file_id=$4::uuid AND o.assignment_file_id=$5::bigint AND o.account_id=$6 AND o.context_revision=1`;
const sourceColumns = `c.format_version AS source_catalog_format_version, c.payload_sha256 AS catalog_sha256,
  c.payload_utf8_bytes AS catalog_utf8_bytes,
  pg_catalog.encode(pg_catalog.sha256(c.compressed_payload),'hex') AS compressed_catalog_sha256,
  p.preview_sha256, p.preview_utf8_bytes,
  pg_catalog.encode(pg_catalog.sha256(p.compressed_preview),'hex') AS compressed_preview_sha256`;

/** Internal caller-transaction derivative registry, NOT authentication, source
 * admission, analytical membership or report adoption. The current owner must
 * reopen the original context and check current actor/assignment/subject/source
 * rights before AND after each operation. No browser-supplied roots or digests.
 * prepare() alone decodes the checked COMPLETE original catalog + independent
 * indexed preview, issues the actual compiler receipt, retains every original
 * page and atomically registers it. Reads use small SQL pins and stored pages;
 * they never decode a source catalog/preview or reconstruct member arrays.
 * No pool, BEGIN/COMMIT, retry, cache, cron, feature flag or live route is owned.
 */
export function createCustomCohortPreparedCatalogRegistry(client, scopeJson, contextJson, operationOptions = {}) {
  check(client && !types.isProxy(client) && typeof client.query === 'function' && typeof client.release === 'function', 'caller_client_required');
  const scope = prepareCustomCohortContextScope(scopeJson), context = prepareCustomCohortContextReference(contextJson);
  const key = [scope.organization_id, context.context_id, context.context_sha256,
    scope.report_file_id, scope.assignment_file_id, scope.account_id];
  const query = client.query.bind(client), { signal, checkBudget = () => {} } = operationOptions;
  check((signal === undefined || signal instanceof AbortSignal) && typeof checkBudget === 'function', 'options');
  const live = () => { check(!signal?.aborted, 'cancelled'); checkBudget(); check(!signal?.aborted, 'cancelled'); };
  let busy = false, operations = 0, bytes = 0;
  const charge = (size = 0) => {
    live(); check(++operations <= 512, 'operations_limit'); bytes += size; check(bytes <= 128_000_000, 'io_bytes_limit');
  };
  const sql = async (text, values = key) => { charge(); const result = await query(text, values); live(); return result; };
  const transaction = async () => {
    const row = one(await sql('/* prepared-catalog-registry:transaction */ SELECT txid_current()::text AS transaction_id', []));
    check(typeof row.transaction_id === 'string' && /^[1-9][0-9]{0,19}$/.test(row.transaction_id), 'caller_transaction_required');
    return row.transaction_id;
  };
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const boundedBlobs = {
    async get(digest, length) { charge(Number(length)); const result = await blobs.get(digest, length); live(); return result; },
    async put(text) { charge(Buffer.byteLength(text)); const result = await blobs.put(text); live(); return result; },
  };
  const op = { signal, checkBudget: live };
  const sourcePins = async () => {
    const row = one(await sql(`/* prepared-catalog-registry:pins */ SELECT ${sourceColumns} ${lineage}`), true);
    return row ? pins(row) : null;
  };
  const registration = async () => {
    // LEFT joins make disappearance/corruption of a registered source fail,
    // rather than look like an ordinary unprepared context. A newer catalog
    // format without its own derivative is an explicit cache miss, never an
    // older root relabelled as current.
    const row = one(await sql(`/* prepared-catalog-registry:read */ SELECT m.*,
      c.format_version AS current_catalog_format_version,
      c.payload_sha256 AS current_catalog_sha256, c.payload_utf8_bytes AS current_catalog_utf8_bytes,
      pg_catalog.encode(pg_catalog.sha256(c.compressed_payload),'hex') AS current_compressed_catalog_sha256,
      p.preview_sha256 AS current_preview_sha256, p.preview_utf8_bytes AS current_preview_utf8_bytes,
      pg_catalog.encode(pg_catalog.sha256(p.compressed_preview),'hex') AS current_compressed_preview_sha256
      FROM app.neighborhood_custom_cohort_prepared_catalog_roots m
      JOIN app.neighborhood_custom_cohort_contexts o ON o.organization_id=m.organization_id AND o.context_id=m.context_id
      LEFT JOIN LATERAL (SELECT candidate.* FROM app.neighborhood_custom_cohort_prepared_catalogs candidate
        WHERE candidate.organization_id=o.organization_id AND candidate.context_id=o.context_id
          AND candidate.context_sha256=o.context_sha256 AND candidate.format_version IN (1,2) AND candidate.catalog_version=3
        ORDER BY candidate.format_version DESC LIMIT 1) c ON true
      LEFT JOIN app.neighborhood_custom_cohort_prepared_previews p
        ON p.organization_id=o.organization_id AND p.context_id=o.context_id AND p.context_sha256=o.context_sha256 AND p.format_version=1
      WHERE m.organization_id=$1::uuid AND m.context_id=$2::uuid AND m.context_sha256=$3 AND m.format_version=1
        AND o.context_sha256=$3 AND o.report_file_id=$4::uuid AND o.assignment_file_id=$5::bigint AND o.account_id=$6 AND o.context_revision=1
      ORDER BY m.source_catalog_format_version DESC LIMIT 1`), true);
    if (!row) return null;
    const root = registered(row);
    check([1, 2].includes(row.current_catalog_format_version));
    if (row.current_catalog_format_version > root.source_catalog_format_version) return null;
    check(row.current_catalog_format_version === root.source_catalog_format_version);
    for (const field of PINS.slice(1)) check(row[`current_${field}`] === root[field]);
    return root;
  };
  const binding = root => ({ scopeJson: json(scope), contextJson: json(context),
    manifestRef: { content_sha256: root.manifest_sha256, canonical_utf8_bytes: String(root.manifest_utf8_bytes) },
    originalCatalogRef: { content_sha256: root.original_catalog_sha256, canonical_utf8_bytes: String(root.original_catalog_utf8_bytes) },
    sourceReadModelSha256: root.source_read_model_sha256, rosterAccountIdsSha256: root.roster_account_ids_sha256 });
  async function read(method, index) {
    const started = await transaction(), root = await registration();
    if (!root) { check(await transaction() === started, 'caller_transaction_required'); return null; }
    const reader = createCustomCohortRetainedCatalogReader(boundedBlobs, binding(root), op);
    const result = await reader[method](index);
    check(same(await registration(), root), 'ending_source');
    check(await transaction() === started, 'caller_transaction_required'); live(); return result;
  }
  async function decode(row, kind, maximum, compressedMaximum) {
    const packed = row[`compressed_${kind}`];
    check(Buffer.isBuffer(packed) && packed.length > 0 && packed.length <= compressedMaximum
      && hash(packed) === row[`compressed_${kind}_sha256`]); charge(packed.length);
    let data; try { data = await unpack(packed, { maxOutputLength: maximum }); } catch { fail('storage_conflict'); }
    charge(data.length); check(data.length === row[`${kind}_utf8_bytes`] && hash(data) === row[`${kind}_sha256`]);
    const text = data.toString('utf8'); check(Buffer.from(text).equals(data));
    let value; try { value = JSON.parse(text); } catch { fail('storage_conflict'); } live(); return value;
  }
  const memberRoot = async root => {
    const row = one(await sql(`/* prepared-catalog-membership:read */ SELECT witness_sha256,witness_utf8_bytes,
      display_manifest_sha256,display_manifest_utf8_bytes FROM app.neighborhood_custom_cohort_catalog_membership_roots
      WHERE organization_id=$1::uuid AND context_id=$2::uuid AND context_sha256=$3 AND format_version=1
        AND source_catalog_format_version=$4`, [key[0],key[1],key[2],root.source_catalog_format_version]), true);
    if (!row) return null;
    check(row.display_manifest_sha256 === root.manifest_sha256 && row.display_manifest_utf8_bytes === root.manifest_utf8_bytes);
    check(typeof row.witness_sha256 === 'string' && SHA.test(row.witness_sha256)
      && Number.isSafeInteger(row.witness_utf8_bytes) && row.witness_utf8_bytes > 0 && row.witness_utf8_bytes <= 4_000);
    return Object.freeze({ content_sha256: row.witness_sha256, canonical_utf8_bytes: String(row.witness_utf8_bytes) });
  };
  async function membership() {
    const started = await transaction(), root = await registration();
    const reference = root ? await memberRoot(root) : null;
    if (!reference) { check(await transaction() === started, 'caller_transaction_required'); return null; }
    const result = await createCustomCohortRetainedMembershipReader(boundedBlobs,
      { ...binding(root), witnessRef: reference }, op).reopen();
    check(same(await registration(), root) && same(await memberRoot(root), reference), 'ending_source');
    check(await transaction() === started, 'caller_transaction_required'); live(); return result;
  }
  async function prepare(withMembership = false) {
    const started = await transaction(), originalPins = await sourcePins();
    if (!originalPins) { check(await transaction() === started, 'caller_transaction_required'); return null; }
    const source = one(await sql(`/* prepared-catalog-registry:originals */ SELECT ${sourceColumns},
      c.compressed_payload AS compressed_catalog, p.compressed_preview ${lineage}`));
    check(same(pins(source), originalPins), 'source_changed');
    const payload = await decode(source, 'catalog', 4_000_000, 4_000_000);
    const rawPreview = await decode(source, 'preview', 64_000_000, 12_000_000);
    check(payload?.catalog?.binding?.selection_revision === 1
      && payload.catalog.binding.selection_sha256 === hash('{"pockets":[],"revision":1}')
      && !Object.hasOwn(payload, 'initial_preview') && !Object.hasOwn(payload, 'private_sales'));
    check(same(rawPreview?.context_ref, context) && rawPreview.selection_revision === 1
      && ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'].every(k => rawPreview.target?.[k] === scope[k])
      && rawPreview.selected?.account_ids?.length === 0 && rawPreview.pockets?.length === 0);
    const preview = restoreCustomCohortIndexedObservationPreview(rawPreview);
    check(preview.all.account_ids.length === preview.member_tables.stock.length);
    const input = { scopeJson: json(scope), contextJson: json(context), catalogJson: JSON.stringify(payload.catalog),
      rosterJson: JSON.stringify({ account_ids: preview.all.account_ids }) };
    const receipt = withMembership ? await prepareCustomCohortCatalogMembershipWitness(input, op)
      : await prepareCustomCohortRecordedCatalogSource(input, op);
    // Refuse autocommit/moved client ownership before the FIRST blob write,
    // not only before root publication. Caller owns rollback after any error.
    check(await transaction() === started, 'caller_transaction_required');
    let staged, complete, retained;
    if (withMembership) {
      retained = await createCustomCohortCatalogMembershipWitnessStore(boundedBlobs, op).stage(receipt);
      const witness = JSON.parse(retained.witness_json);
      staged = { manifest_ref: witness.display_manifest_ref };
      complete = await createCustomCohortRetainedCatalogReader(boundedBlobs, {
        scopeJson: json(scope), contextJson: json(context), manifestRef: witness.display_manifest_ref,
        originalCatalogRef: witness.original_catalog_ref, sourceReadModelSha256: witness.source_read_model_sha256,
        rosterAccountIdsSha256: witness.roster_account_ids_sha256 }, op).reopen();
    } else {
      const store = createCustomCohortRecordedCatalogPageStore(boundedBlobs, op); staged = await store.stage(receipt);
      complete = await store.reopen(receipt, staged.manifest_ref);
    }
    const m = complete.metadata;
    const root = registered({ ...originalPins, manifest_sha256: staged.manifest_ref.content_sha256,
      manifest_utf8_bytes: Number(staged.manifest_ref.canonical_utf8_bytes), original_catalog_sha256: m.original_catalog_ref.content_sha256,
      original_catalog_utf8_bytes: Number(m.original_catalog_ref.canonical_utf8_bytes),
      source_read_model_sha256: m.original_read_model_sha256, roster_account_ids_sha256: m.roster_account_ids_sha256 });
    check(same(await sourcePins(), originalPins), 'ending_source');
    check(await transaction() === started, 'caller_transaction_required');
    const inserted = one(await sql(`/* prepared-catalog-registry:insert */ INSERT INTO app.neighborhood_custom_cohort_prepared_catalog_roots
      (organization_id,context_id,context_sha256,format_version,catalog_version,source_catalog_format_version,
        catalog_sha256,catalog_utf8_bytes,compressed_catalog_sha256,preview_sha256,preview_utf8_bytes,compressed_preview_sha256,
        manifest_sha256,manifest_utf8_bytes,original_catalog_sha256,original_catalog_utf8_bytes,source_read_model_sha256,roster_account_ids_sha256)
      VALUES ($1::uuid,$2::uuid,$3,1,3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (organization_id,context_id,format_version,source_catalog_format_version) DO NOTHING
      RETURNING manifest_sha256`, [key[0], key[1], key[2], ...PINS.map(k => root[k]), ...ROOT.map(k => root[k])]), true);
    if (inserted) check(inserted.manifest_sha256 === root.manifest_sha256);
    check(same(await registration(), root), 'publication_conflict');
    if (withMembership) {
      const ref = retained.witness_ref;
      const added = one(await sql(`/* prepared-catalog-membership:insert */ INSERT INTO app.neighborhood_custom_cohort_catalog_membership_roots
        (organization_id,context_id,context_sha256,format_version,display_format_version,source_catalog_format_version,
          display_manifest_sha256,display_manifest_utf8_bytes,witness_sha256,witness_utf8_bytes)
        VALUES ($1::uuid,$2::uuid,$3,1,1,$4,$5,$6,$7,$8)
        ON CONFLICT (organization_id,context_id,format_version,source_catalog_format_version) DO NOTHING RETURNING witness_sha256`,
      [key[0],key[1],key[2],root.source_catalog_format_version,root.manifest_sha256,root.manifest_utf8_bytes,
        ref.content_sha256,Number(ref.canonical_utf8_bytes)]), true);
      if (added) check(added.witness_sha256 === ref.content_sha256);
      check(same(await memberRoot(root), ref), 'publication_conflict');
      // stage() already verified every original member and union page. Do not
      // repeat that whole work at publication; freshly recheck its exact root
      // and registered source/display pins. A later read verifies the full graph.
      check(await boundedBlobs.get(ref.content_sha256, ref.canonical_utf8_bytes) === retained.witness_json, 'ending_source');
      check(same(await registration(), root) && same(await memberRoot(root), ref), 'ending_source');
      check(await transaction() === started, 'caller_transaction_required'); live();
      return Object.freeze({ authority: 'not_established', status: added ? 'prepared' : 'reused',
        witness_ref: ref, retention_refs: retained.retention_refs });
    }
    check(await transaction() === started, 'caller_transaction_required'); live();
    return Object.freeze({ authority: 'not_established', status: inserted ? 'prepared' : 'reused', manifest_ref: staged.manifest_ref });
  }
  async function run(work) {
    live(); check(!busy, 'operation_in_progress'); busy = true;
    try { return await work(); } finally { busy = false; }
  }
  return Object.freeze({ prepare: () => run(prepare), open: () => run(() => read('open')),
    // Internal preparation/read only. Current-owner rights remain mandatory;
    // these whole-catalog artifacts are never the appraiser's selected head.
    prepareMembership: () => run(() => prepare(true)), reopenMembership: () => run(membership),
    async page(index) { check(Number.isSafeInteger(index) && index >= 0 && index < 21, 'page_index'); return run(() => read('page', index)); },
    reopen: () => run(() => read('reopen')) });
}
