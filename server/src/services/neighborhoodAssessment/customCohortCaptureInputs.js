import { createHash } from 'node:crypto';
import { mapWitnessParcelRow, mapWitnessAccountRow, mapWitnessSaleRow, mapWitnessSaleLinkRow } from './cachedRowMappingsV3.js';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from './contract.js';
import { prepareNeighborhoodCohortBlob as blob, prepareNeighborhoodCohortBlobReference as blobRef,
  createNeighborhoodCohortBlobRepository } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { createCustomCohortSelectionRepository } from './customCohortSelectionRepository.js';
import { prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { representCustomCohortSubjectPoint } from './customCohortSubjectPoint.js';
import { getCustomNeighborhoodMaterialProfile } from './customMaterialProfile.js';
import { prepareNeighborhoodSelectorInputV1, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 } from './selectorInputProfile.js';
import { buildCohortLocalQueryEvidenceV1 } from './cohortQueryEvidence.js';
import { validateCachedTransactionClosure } from './cachedTransactionClosure.js';
import { decodeNeighborhoodOriginalValue } from './originalValueDecoding.js';

export const CUSTOM_COHORT_CAPTURE_INPUT_LIMITS = Object.freeze({
  blobs: 4000, references: 12000, logical_utf8_bytes: 192_000_000, page_entries: 250,
  page_utf8_bytes: 1_300_000, spatial_parcels: 100_000, accounts: 50_000,
  source_chunks: 1000, source_records: 100_000, closure_records: 100_000,
});
const L = CUSTOM_COHORT_CAPTURE_INPUT_LIMITS;
const preparedPlans = new WeakMap();
const WITNESS_MAPPERS = Object.freeze({ parcels: mapWitnessParcelRow, accounts: mapWitnessAccountRow,
  transactions: mapWitnessSaleRow, sale_links: mapWitnessSaleLinkRow });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const SUBJECT_KEYS = ['subject_input_version', 'usage', 'target', 'effective_date', 'case_effective_date',
  'original_snapshot_row', 'original_section_reads', 'snapshot_evidence', 'material_input'];
const CLOSURE_ARRAYS = ['selected_account_ids', 'transactions', 'links', 'legacy', 'closure_account_ids', 'source_record_ids', 'legacy_sale_ids'];
const REFS = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
// Whole captures/closures/directories can exceed the per-blob JSON ceiling.
// Compare bounded original JSON values without constructing a giant document
// or changing the canonicalizer's existing limits.
function same(a, b) {
  const stack = [[a, b, 0]]; let visited = 0;
  while (stack.length) {
    const [left, right, depth] = stack.pop();
    check(++visited <= 2_000_000 && depth <= 40, 'input_limit');
    if (Object.is(left, right)) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
      || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left), other = Object.keys(right);
    check(keys.length + stack.length + visited <= 2_000_000, 'input_limit');
    if (keys.length !== other.length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(right, key)) return false;
      stack.push([left[key], right[key], depth + 1]);
    }
  }
  return true;
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function fail(reason) { throw Object.assign(new Error(`custom_cohort_capture_inputs_${reason}`), { code: `custom_cohort_capture_inputs_${reason}` }); }
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key))) fail('invalid_shape');
}
function check(condition, reason = 'binding_mismatch') { if (!condition) fail(reason); }
function array(value, max) { check(Array.isArray(value) && value.length <= max, 'input_limit'); return value; }
function reference(value) {
  closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  return blobRef(value.content_sha256, value.canonical_utf8_bytes);
}
function timestamp(value) {
  const result = decodeNeighborhoodOriginalValue('utc6', 'present', value);
  check(result.status === 'decoded' && result.value === value, 'invalid_timestamp');
  return value;
}
function scopeOf(target) {
  return prepareCustomCohortContextScope(json(pick(target, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'])));
}
function meter() {
  const counts = { blobs: 0, references: 0, logical_utf8_bytes: 0 };
  const bytes = value => { counts.logical_utf8_bytes += value; check(counts.logical_utf8_bytes <= L.logical_utf8_bytes, 'input_limit'); };
  const ref = value => {
    reference(value); check(++counts.references <= L.references, 'input_limit');
    // Charge every logical occurrence, including duplicate hashes and cache hits.
    bytes(Number(value.canonical_utf8_bytes));
  };
  return { counts, bytes, ref };
}
function referenceEdges(value, charge) {
  if (!value || typeof value !== 'object') return;
  if (Object.hasOwn(value, 'content_sha256') && Object.hasOwn(value, 'canonical_utf8_bytes')) charge(value);
  else for (const child of Object.values(value)) referenceEdges(child, charge);
}
function planBuilder() {
  const budget = meter(), pending = new Map(), existing = new Map();
  const text = (canonical, alreadyStored = false, hasReferenceEdges = true) => {
    const ref = blob(canonical);
    budget.bytes(Buffer.byteLength(canonical));
    if (hasReferenceEdges) referenceEdges(JSON.parse(canonical), budget.ref);
    const previous = pending.get(ref.content_sha256);
    check(!previous || previous.text === canonical, 'digest_conflict');
    if (!previous) {
      check(++budget.counts.blobs <= L.blobs, 'input_limit');
      pending.set(ref.content_sha256, { ref, text: canonical });
    }
    if (alreadyStored) existing.set(ref.content_sha256, { ref, text: canonical });
    return ref;
  };
  const add = (value, alreadyStored = false, hasReferenceEdges = true) => text(json(value), alreadyStored, hasReferenceEdges);
  const pages = (kind, entries, maximum) => {
    array(entries, maximum);
    const refs = []; let batch = [], size = 200;
    const flush = () => {
      refs.push({ page_index: String(refs.length), entry_count: String(batch.length),
        page: add({ collection_version: 1, kind, page_index: String(refs.length), entries: batch }) });
      batch = []; size = 200;
    };
    for (const entry of entries) {
      const n = Buffer.byteLength(json(entry)) + 1;
      check(n <= L.page_utf8_bytes - 200, 'input_limit');
      if (batch.length && (batch.length === L.page_entries || size + n > L.page_utf8_bytes)) flush();
      batch.push(entry); size += n;
    }
    if (batch.length) flush();
    return add({ collection_version: 1, kind, entry_count: String(entries.length), pages: refs });
  };
  return { ...budget, pending, existing, text, add, pages };
}
function validateSpatial(spatial, point) {
  check(spatial.status === 'captured' && spatial.query_complete === true && spatial.authority === 'not_established'
    && spatial.source_coverage === 'not_established' && spatial.radius_metres === '4828.032');
  check(same(spatial.geometry_input, point.geometry_input)
    && spatial.geometry_input_sha256 === assessmentEvidenceDigest(point.geometry_input));
  const digest = createHash('sha256').update('homenode-cached-spatial-membership-v1\n')
    .update(json({ geometry_input: point.geometry_input, radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1' })).update('\n');
  const ids = new Set(); let cursor = null, bytes = 0;
  for (const row of array(spatial.parcels, L.spatial_parcels)) {
    closed(row, ['object_id', 'account_id', 'source_record_hash', 'sync_run_id', 'synced_at', 'source_updated_at', 'geometry_sha256']);
    check(typeof row.object_id === 'string' && /^-?(?:0|[1-9]\d*)$/.test(row.object_id)
      && BigInt(row.object_id) >= -9223372036854775808n && BigInt(row.object_id) <= 9223372036854775807n
      && (cursor === null || BigInt(row.object_id) > cursor));
    check(typeof row.account_id === 'string' && row.account_id.length > 0 && row.account_id.length <= 64
      && row.account_id.trim() === row.account_id && !/[\u0000-\u001f\u007f]/.test(row.account_id));
    check(HASH.test(row.source_record_hash) && HASH.test(row.geometry_sha256) && typeof row.sync_run_id === 'string' && row.sync_run_id.length > 0);
    timestamp(row.synced_at); if (row.source_updated_at !== null) timestamp(row.source_updated_at);
    const encoded = json(row); digest.update(encoded).update('\n'); bytes += Buffer.byteLength(encoded);
    ids.add(row.account_id); cursor = BigInt(row.object_id);
  }
  check(same([...ids].sort(), array(spatial.account_ids, L.accounts)) && spatial.counts.parcels === spatial.parcels.length
    && spatial.counts.accounts === ids.size && spatial.counts.bytes === bytes
    && spatial.account_ids_sha256 === assessmentEvidenceDigest({ account_ids: spatial.account_ids })
    && spatial.membership_sha256 === digest.digest('hex'));
}
function validateSources(capture, request, compact) {
  check(capture.status === 'ready' && same(capture.scope, request.scope));
  array(capture.sources, L.source_chunks); array(capture.source_snapshots, L.source_chunks);
  check(capture.sources.length === capture.source_snapshots.length);
  const snapshots = new Map(capture.source_snapshots.map(s => [s.id, s]));
  check(snapshots.size === capture.sources.length);
  const groups = new Map(), ids = new Set(); let records = 0;
  for (const source of capture.sources) {
    closed(source, ['id', 'payload']);
    const p = source.payload;
    closed(p, ['schema_version', 'scope', 'upstream', 'projection', 'metadata', 'partition', 'records']);
    check(p.schema_version === 1 && same(p.scope, request.scope));
    const ref = blob(json(p)), { id: captureId, ...metadata } = p.metadata;
    check(source.id === `${captureId}:${ref.content_sha256}` && !ids.has(source.id)); ids.add(source.id);
    check(same(snapshots.get(source.id), { id: source.id, ...metadata, content_sha256: ref.content_sha256,
      visibility: 'assignment', scope: request.scope }));
    const role = p.projection.definition.role;
    check(['selection', 'parcels', 'accounts', 'transactions', 'sale_links', 'gis_sync'].includes(role));
    check(same(p.projection.definition, { ...compact, selection_sha256: request.query_hash,
      selected_account_count: request.account_ids.length, role, source_gaps: [] }));
    closed(p.partition, ['index', 'count', 'record_count']);
    check(Number.isSafeInteger(p.partition.index) && p.partition.index >= 0 && Number.isSafeInteger(p.partition.count)
      && p.partition.count >= 1 && p.partition.count <= L.source_chunks && p.partition.index < p.partition.count);
    array(p.records, 1000); check(p.partition.record_count === p.records.length);
    records += p.records.length; check(records <= L.source_records, 'input_limit');
    if (!groups.has(captureId)) groups.set(captureId, []);
    groups.get(captureId).push(p);
  }
  check(groups.size === 6);
  const actualRouting = [], actualDiagnostics = [];
  for (const [captureId, chunks] of groups) {
    chunks.sort((a, b) => a.partition.index - b.partition.index);
    const first = chunks[0], header = omit(first, ['partition', 'records']), recordIds = new Set();
    const all = [], sourceRefs = [], recordSources = [];
    check(chunks.length === first.partition.count);
    for (const [index, p] of chunks.entries()) {
      check(p.partition.index === index && p.partition.count === chunks.length && same(omit(p, ['partition', 'records']), header));
      const sourceId = `${captureId}:${blob(json(p)).content_sha256}`; sourceRefs.push(sourceId);
      for (const row of p.records) {
        closed(row, ['record_id', 'data']);
        if (compact.mapping_version === 3) {
          const mapper = WITNESS_MAPPERS[p.projection.definition.role];
          if (mapper) check(row.data?.data?.cached_mapping_version === 3
            && same(row.data, mapper(row.data.raw_projection)), 'witness_mapping_mismatch');
        }
        check(typeof row.record_id === 'string' && !recordIds.has(row.record_id)
          && (!all.length || all.at(-1).record_id < row.record_id));
        recordIds.add(row.record_id); all.push(row); recordSources.push({ record_id: row.record_id, source_ref: sourceId });
      }
    }
    const digest = createHash('sha256').update(json({ ...compact, selection_sha256: request.query_hash, selected_account_count: request.account_ids.length }));
    for (const row of all) digest.update(json(row)).update('\n');
    check(first.upstream.upstream_content_sha256 === digest.digest('hex') && first.upstream.row_count === all.length
      && first.projection.input_row_count === all.length && first.projection.output_record_count === all.length
      && first.upstream.complete === true && first.projection.complete === true);
    if (first.projection.definition.role === 'selection') check(same(all.map(row => row.data.account_id).sort(), request.account_ids));
    actualRouting.push({ capture_id: captureId, upstream_source_id: first.upstream.id, source_refs: sourceRefs, record_sources: recordSources });
    actualDiagnostics.push({ capture_id: captureId, upstream_source_id: first.upstream.id,
      upstream_state: first.upstream.state, upstream_complete: true, upstream_row_count: all.length,
      projection_complete: true, normalized_record_count: all.length, historical_availability: first.metadata.historical_availability,
      status: 'captured', reasons: [], source_refs: sourceRefs });
  }
  check(same(capture.references, actualRouting) && same(capture.capability_diagnostics, actualDiagnostics));
}

/** Internal concrete acquisition retention. The owner supplies the ALREADY
 * consumed original handoff and holds fresh authority/freshness fences. These
 * checks preserve and bind bytes; they cannot manufacture original provenance,
 * source eligibility, permission or a current context from caller hashes. */
export function prepareCustomCohortCaptureInputs(input) {
  closed(input, ['acquisition', 'spatial', 'subject', 'subject_reference', 'selector', 'study', 'acquisition_intent', 'started_at', 'completed_at']);
  const { acquisition, spatial, subject, subject_reference: subjectRef, selector, study, acquisition_intent: intent } = input;
  closed(acquisition, ['version', 'provenance', 'authority', 'captured_query_request', 'compact_metadata_json', 'capture_result']);
  check(acquisition.version === 1 && acquisition.provenance === 'original_cached_reader_invocation' && acquisition.authority === 'not_established');
  const result = acquisition.capture_result, request = acquisition.captured_query_request;
  check(result.status === 'captured' && result.query_complete === true && result.reader_version === 'local-capture-v3'
    && result.incomplete_reasons.length === 0 && same(result.snapshot, spatial.snapshot), 'complete_original_capture_required');
  const scope = scopeOf(subject.target), b = planBuilder();
  check(same(b.add(pick(subject, SUBJECT_KEYS), true), reference(subjectRef)));
  for (const [key, value] of [['original_snapshot_row', subject.original_snapshot], ['original_section_reads', subject.original_sections],
    ['snapshot_evidence', subject.snapshot], ['material_input', subject.material]]) check(same(b.add(value, true), subject[key]));
  const point = representCustomCohortSubjectPoint(subject); check(point.status === 'represented', 'recorded_point_required');
  validateSpatial(spatial, point);
  const expectedScope = pick(subject.target, ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']);
  const target = { report_file_id: scope.report_file_id, workflow_type: 'custom_appraisal', workflow_target_id: scope.assignment_file_id };
  check(same(request.target, target) && same(request.scope, expectedScope) && same(result.scope, expectedScope)
    && request.effective_date === subject.effective_date && same(request.account_ids, spatial.account_ids));
  const definition = selector.query_input.definition;
  const rebuilt = prepareNeighborhoodSelectorInputV1({ profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, target,
    scope: expectedScope, effective_date: subject.effective_date, selection: { id: request.selection.id,
      revision: request.selection.revision, source_sha256: spatial.membership_sha256 }, geometry_input: point.geometry_input,
    discovery: definition.discovery, roster: { complete: true, account_count: spatial.account_ids.length, account_ids: spatial.account_ids } });
  check(rebuilt.status === 'prepared' && same(selector, rebuilt) && same(selector.selection, request.selection));
  closed(study, ['profile_id', 'observation_period', 'knowledge_cutoff']);
  check(study.profile_id === NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 && study.knowledge_cutoff === null
    && request.knowledge_cutoff === null && same(study.observation_period, request.observation_period));
  closed(intent, ['reference', 'body']);
  closed(intent.body, ['intent_version', 'operation_id', 'actor_user_id', 'subject_inputs', 'target', 'effective_date', 'study', 'created_at']);
  check(intent.body.intent_version === 1 && UUID.test(intent.body.operation_id) && typeof intent.body.actor_user_id === 'string'
    && intent.body.actor_user_id.trim().length > 0 && intent.body.actor_user_id.length <= 200
    && same(intent.body.subject_inputs, subjectRef) && same(intent.body.target, subject.target)
    && intent.body.effective_date === subject.effective_date && same(intent.body.study, study));
  check(same(b.add(intent.body, true), reference(intent.reference)));
  check(timestamp(intent.body.created_at) <= timestamp(input.started_at) && input.started_at <= timestamp(input.completed_at), 'chronology_mismatch');
  const compact = JSON.parse(acquisition.compact_metadata_json);
  check(input.started_at <= timestamp(compact.capture_observed_at) && compact.capture_observed_at <= input.completed_at
    && timestamp(spatial.snapshot.transaction_started_at) <= input.started_at, 'chronology_mismatch');
  const query = buildCohortLocalQueryEvidenceV1(acquisition.compact_metadata_json, JSON.stringify(request.account_ids), result.selection_sha256);
  check(query.status === 'syntax_valid' && same(query.evidence, result.query_evidence), 'query_evidence_mismatch');
  check(same(compact.scope, request.scope) && compact.effective_date === request.effective_date
    && same(compact.observation_period, study.observation_period) && compact.knowledge_cutoff === null
    && same(compact.authorization.target, target) && same(compact.authorization.selection, request.selection)
    && compact.authorization.selection_sha256 === request.selection_sha256
    && same(compact.authorization.market_decision, request.market_decision));
  const closure = request.transaction_closure;
  const checkedClosure = validateCachedTransactionClosure(pick(closure, ['selected_account_ids', 'source_revision', 'transactions', 'links', 'legacy']));
  check(same(closure, checkedClosure) && same(closure.selected_account_ids, request.account_ids));
  check(same(compact.authorization.transaction_closure, { version: closure.version, source_revision: closure.source_revision,
    closure_sha256: closure.closure_sha256, transaction_count: closure.transactions.length, link_count: closure.links.length,
    legacy_sale_count: closure.legacy.length, account_count: closure.closure_account_ids.length, source_record_count: closure.source_record_ids.length }));
  validateSources(result.source_capture, { ...request, query_hash: result.selection_sha256 }, compact);
  // Mirror the existing retained-query index exactly; persist still calls its
  // actual repository. This preflight prevents late index/wrapper overflow.
  const evidence = query.evidence;
  for (const entry of evidence.blobs) check(same(b.text(entry.canonical_json), entry.ref));
  const queryRef = b.add({ selection_input_version: 1, usage: 'retained_selection_inputs_only', subject_inputs: subjectRef,
    query_bundle: { version: evidence.version, producer_profile: evidence.producer_profile, query_preimage: evidence.query_preimage,
      captured_query_selection_sha256: evidence.captured_query_selection_sha256, blob_refs: evidence.blobs.map(entry => entry.ref) } });
  const profile = getCustomNeighborhoodMaterialProfile();
  check(same(b.text(profile.definition_blob.canonical_json), profile.definition_blob.ref));
  const subjectDependencies = b.add({ subject_dependencies_version: 1, usage: 'retained_custom_subject_dependencies',
    subject_inputs: subjectRef, material_input: subject.material_input,
    material_profile: { profile_ref: profile.profile_ref, definition_blob: profile.definition_blob.ref }, recorded_point: b.add(point) });
  const studyInput = b.add({ study_input_version: 1, usage: 'retained_custom_study_settings', target: subject.target,
    effective_date: subject.effective_date, settings: study, source_semantics: compact.semantics, eligibility: 'not_established' });
  const capture = result.source_capture;
  const selectionInput = b.add({ selection_input_version: 1, usage: 'retained_original_custom_capture_inputs',
    subject_inputs: subjectRef, acquisition_intent: intent.reference, started_at: input.started_at, completed_at: input.completed_at,
    query_inputs: queryRef, compact_metadata: b.text(acquisition.compact_metadata_json),
    acquisition_metadata: b.add(omit(acquisition, ['captured_query_request', 'compact_metadata_json', 'capture_result'])),
    capture_metadata: b.add(omit(result, ['source_capture', 'query_evidence'])),
    request: { metadata: b.add(omit(request, ['account_ids', 'transaction_closure'])),
      account_ids: b.pages('request_accounts', request.account_ids, L.accounts),
      closure: { metadata: b.add(omit(closure, CLOSURE_ARRAYS)), collections: Object.fromEntries(CLOSURE_ARRAYS.map(key =>
        [key, b.pages(`closure_${key}`, closure[key], ['transactions', 'links', 'legacy'].includes(key) ? L.closure_records : L.accounts * 2)])) } },
    selector: { metadata: b.add(omit(selector, ['account_roster', 'query_input'])), query_input: b.add(selector.query_input),
      roster_metadata: b.add(omit(selector.account_roster, ['account_ids'])), account_ids: b.pages('selector_accounts', selector.account_roster.account_ids, L.accounts) },
    spatial: { metadata: b.add(omit(spatial, ['parcels', 'account_ids'])), parcels: b.pages('spatial_parcels', spatial.parcels, L.spatial_parcels),
      account_ids: b.pages('spatial_accounts', spatial.account_ids, L.accounts) },
    sources: { metadata: b.add(omit(capture, ['sources', 'source_snapshots', 'references'])),
      // Original source values are DATA, not this storage graph's reference
      // language. A quality flag with ref-shaped keys must survive literally.
      payloads: b.pages('source_payloads', capture.sources.map(source => ({ id: source.id, payload: b.add(source.payload, false, false) })), L.source_chunks),
      snapshots: b.pages('source_snapshots', capture.source_snapshots, L.source_chunks),
      routing: b.pages('source_routing', capture.references.map(route => ({ ...omit(route, ['record_sources']),
        record_sources: b.pages(`routing_${route.capture_id}`, route.record_sources, L.source_records) })), 32) } });
  const refs = { snapshot_evidence: subject.snapshot_evidence, subject_dependencies: subjectDependencies,
    selection_input: selectionInput, study_input: studyInput };
  for (const ref of Object.values(refs)) b.ref(ref);
  const prepared = freeze({ status: 'prepared', authority: 'not_established', refs,
    summary: { radius_metres: '4828.032', parcel_count: spatial.parcels.length, account_count: spatial.account_ids.length,
      source_chunk_count: capture.sources.length, source_record_count: capture.sources.reduce((n, s) => n + s.payload.records.length, 0),
      source_query_complete: true, provider_coverage: 'not_established' }, counts: { ...b.counts } });
  preparedPlans.set(prepared, { scope, subjectRef, queryRef, queryJson: JSON.stringify(evidence), pending: b.pending, existing: b.existing });
  return prepared;
}

async function transaction(client) {
  check(typeof client?.query === 'function' && typeof client.release === 'function', 'caller_client_required');
  const result = await client.query('/* custom-cohort-capture:transaction */ SELECT txid_current()::text AS transaction_id');
  const id = result?.rows?.[0]?.transaction_id;
  check(result?.rowCount === 1 && result.rows.length === 1 && typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id), 'caller_transaction_required');
  return id;
}
/** No connection or transaction lifecycle, context/head/report writes, or grant
 * minting. Owner must roll back any failure and COMMIT before durable success. */
export async function persistCustomCohortCaptureInputs(client, scopeJson, prepared) {
  const p = preparedPlans.get(prepared); check(p, 'original_preparation_required');
  check(same(prepareCustomCohortContextScope(scopeJson), p.scope), 'scope_mismatch');
  const started = await transaction(client), store = createNeighborhoodCohortBlobRepository(client, p.scope.organization_id);
  for (const entry of p.existing.values()) check(await store.get(entry.ref.content_sha256, entry.ref.canonical_utf8_bytes) === entry.text, 'missing_original_input');
  // Reuse the repository's actual subject/dependency verification before INSERT.
  await createCustomCohortSubjectRepository(client, scopeJson).load(p.subjectRef);
  check(await transaction(client) === started, 'caller_transaction_required');
  const retained = await createCustomCohortSelectionRepository(client, scopeJson).retain(p.subjectRef, p.queryJson);
  check(same(retained, p.queryRef));
  for (const entry of p.pending.values()) if (!p.existing.has(entry.ref.content_sha256)) {
    check(same(await store.put(entry.text), entry.ref));
  }
  check(await transaction(client) === started, 'caller_transaction_required');
  return prepared.refs;
}

/** Reopen complete immutable originals, not a replacement acquisition handle.
 * Current permission/freshness and uncertain-COMMIT intent matching stay with
 * the coordinator. Every reference traversal is bounded, even duplicate refs. */
export async function loadCustomCohortCaptureInputs(client, scopeJson, refs) {
  closed(refs, REFS); const scope = prepareCustomCohortContextScope(scopeJson), started = await transaction(client);
  const store = createNeighborhoodCohortBlobRepository(client, scope.organization_id), budget = meter(), cache = new Map();
  const text = async ref => {
    budget.ref(ref);
    if (!cache.has(ref.content_sha256)) {
      check(cache.size < L.blobs, 'input_limit');
      const value = await store.get(ref.content_sha256, ref.canonical_utf8_bytes); check(value !== null, 'missing_evidence');
      cache.set(ref.content_sha256, value);
    }
    const value = cache.get(ref.content_sha256); check(same(blob(value), ref)); return value;
  };
  const read = async ref => JSON.parse(await text(ref));
  const pages = async (ref, kind, maximum) => {
    const manifest = await read(ref); closed(manifest, ['collection_version', 'kind', 'entry_count', 'pages']);
    check(manifest.collection_version === 1 && manifest.kind === kind && /^(?:0|[1-9]\d*)$/.test(manifest.entry_count)
      && Number(manifest.entry_count) <= maximum, 'invalid_directory');
    array(manifest.pages, Math.min(maximum, L.blobs)); const entries = [];
    for (const [index, item] of manifest.pages.entries()) {
      closed(item, ['page_index', 'entry_count', 'page']);
      check(item.page_index === String(index) && /^[1-9]\d*$/.test(item.entry_count)
        && Number(item.entry_count) <= L.page_entries, 'invalid_directory');
      const page = await read(item.page); closed(page, ['collection_version', 'kind', 'page_index', 'entries']);
      check(page.collection_version === 1 && page.kind === kind && page.page_index === String(index)
        && array(page.entries, L.page_entries).length === Number(item.entry_count), 'invalid_directory');
      entries.push(...page.entries); check(entries.length <= maximum, 'input_limit');
    }
    check(entries.length === Number(manifest.entry_count), 'invalid_directory'); return entries;
  };
  const selection = await read(refs.selection_input), studyBlob = await read(refs.study_input);
  check(selection.selection_input_version === 1 && selection.usage === 'retained_original_custom_capture_inputs');
  await read(refs.snapshot_evidence);
  const dependencies = await read(refs.subject_dependencies);
  closed(dependencies, ['subject_dependencies_version', 'usage', 'subject_inputs', 'material_input', 'material_profile', 'recorded_point']);
  closed(dependencies.material_profile, ['profile_ref', 'definition_blob']);
  await read(dependencies.subject_inputs); await read(dependencies.material_input);
  await read(dependencies.material_profile.definition_blob); await read(dependencies.recorded_point);
  budget.ref(selection.subject_inputs);
  const subject = await createCustomCohortSubjectRepository(client, scopeJson).load(selection.subject_inputs);
  for (const key of ['original_snapshot_row', 'original_section_reads', 'snapshot_evidence', 'material_input']) budget.ref(subject[key]);
  budget.ref(selection.query_inputs);
  const retainedQuery = await createCustomCohortSelectionRepository(client, scopeJson).load(selection.query_inputs);
  // Account for the existing repositories' bounded internal graph traversals,
  // too; duplicate references never become free merely because another reader
  // already verified them. Query blobs have the closed query-evidence grammar.
  budget.ref(retainedQuery.subject_inputs);
  budget.ref(retainedQuery.query.evidence.query_preimage);
  for (const entry of retainedQuery.query.evidence.blobs) {
    budget.ref(entry.ref); referenceEdges(JSON.parse(entry.canonical_json), budget.ref);
  }
  const c = selection.request.closure, closure = await read(c.metadata);
  closed(c.collections, CLOSURE_ARRAYS);
  for (const key of CLOSURE_ARRAYS) closure[key] = await pages(c.collections[key], `closure_${key}`,
    ['transactions', 'links', 'legacy'].includes(key) ? L.closure_records : L.accounts * 2);
  const source = await read(selection.sources.metadata);
  source.sources = [];
  for (const entry of await pages(selection.sources.payloads, 'source_payloads', L.source_chunks)) {
    closed(entry, ['id', 'payload']); source.sources.push({ id: entry.id, payload: await read(entry.payload) });
  }
  source.source_snapshots = await pages(selection.sources.snapshots, 'source_snapshots', L.source_chunks);
  source.references = [];
  for (const route of await pages(selection.sources.routing, 'source_routing', 32)) source.references.push({ ...route,
    record_sources: await pages(route.record_sources, `routing_${route.capture_id}`, L.source_records) });
  const acquisition = { ...await read(selection.acquisition_metadata),
    captured_query_request: { ...await read(selection.request.metadata),
      account_ids: await pages(selection.request.account_ids, 'request_accounts', L.accounts), transaction_closure: closure },
    compact_metadata_json: await text(selection.compact_metadata), capture_result: { ...await read(selection.capture_metadata),
      source_capture: source, query_evidence: retainedQuery.query.evidence } };
  const input = { acquisition, subject, subject_reference: selection.subject_inputs,
    spatial: { ...await read(selection.spatial.metadata), parcels: await pages(selection.spatial.parcels, 'spatial_parcels', L.spatial_parcels),
      account_ids: await pages(selection.spatial.account_ids, 'spatial_accounts', L.accounts) },
    selector: { ...await read(selection.selector.metadata), query_input: await read(selection.selector.query_input),
      account_roster: { ...await read(selection.selector.roster_metadata), account_ids: await pages(selection.selector.account_ids, 'selector_accounts', L.accounts) } },
    study: studyBlob.settings, acquisition_intent: { reference: selection.acquisition_intent, body: await read(selection.acquisition_intent) },
    started_at: selection.started_at, completed_at: selection.completed_at };
  const checked = prepareCustomCohortCaptureInputs(input);
  check(same(checked.refs, refs), 'stored_graph_mismatch');
  check(await transaction(client) === started, 'caller_transaction_required');
  return freeze({ status: 'retained', authority: 'not_established', refs: checked.refs,
    acquisition_intent: input.acquisition_intent, study: input.study, subject_reference: input.subject_reference,
    summary: checked.summary, retained_inputs: input });
}
