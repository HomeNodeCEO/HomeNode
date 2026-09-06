import { createHash } from 'node:crypto';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';

// Dormant local-capture-v3 byte-consistency profile. These are admission limits,
// not measured memory/time guarantees or a source/authorization capability.
export const NEIGHBORHOOD_COHORT_LOCAL_QUERY_CONTRACT_VERSION = 1;
export const NEIGHBORHOOD_COHORT_LOCAL_QUERY_EVIDENCE_LIMITS = Object.freeze({
  input_bytes: 8_000_000, input_nodes: 10_000, input_depth: 16,
  blobs: 1_003, blob_bytes: 1_500_000, blob_nodes: 100_000, blob_depth: 35,
  metadata_bytes: 64_000, metadata_nodes: 10_000,
  preimage_bytes: 128_000, preimage_nodes: 25_000, preimage_depth: 16,
  pages: 1_000, page_accounts: 1_000, accounts: 50_000,
  work_bytes: 16_000_000, work_nodes: 500_000,
  output_bytes: 8_010_000, output_nodes: 10_032, output_depth: 17,
});
const LIMIT = NEIGHBORHOOD_COHORT_LOCAL_QUERY_EVIDENCE_LIMITS;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BIGINT = /^(?:0|[1-9][0-9]{0,18})$/;
const BIGINT_MAX = '9223372036854775807';
const CONTROL = /[\u0000-\u001f\u007f]/;
const READER_LIMITS = Object.freeze({ records: 100_000, bytes: 30_000_000,
  row_bytes: 64_000, page_size: 250, selected_accounts: 50_000,
  duration_ms: 30_000, statement_ms: 5_000, connect_ms: 3_000 });
const RELATIONS = Object.freeze({ parcels: 'gis.dcad_parcels', accounts: 'core.accounts',
  source_records: 'core.sales_source_records', sales: 'core.sales', sale_links: 'core.sale_parcels',
  sync_state: 'gis.source_sync_state', sync_runs: 'gis.source_sync_runs' });

class AdmissionFailure extends Error {
  constructor(status, reason) { super(reason); this.result = Object.freeze({ status, reason }); }
}
const invalid = reason => { throw new AdmissionFailure('invalid', reason); };
const limited = reason => { throw new AdmissionFailure('limit_exceeded', reason); };
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');

function unicode(text) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) invalid('invalid_unicode');
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('invalid_unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid('invalid_unicode');
  }
}

// Only call on detached JSON.parse results or internally synthesized plain JSON.
// One frame per depth avoids allocating a work stack for every supplied child.
function admitTree(value, maxNodes, maxDepth, nodeReason, depthReason) {
  const stack = [{ value, depth: 0, entered: false }];
  let nodes = 0;
  let deepest = 0;
  while (stack.length) {
    const frame = stack.at(-1);
    if (!frame.entered) {
      if (++nodes > maxNodes) limited(nodeReason);
      if (frame.depth > maxDepth) limited(depthReason);
      deepest = Math.max(deepest, frame.depth);
      const item = frame.value;
      if (typeof item === 'string') unicode(item);
      else if (typeof item === 'number' && !Number.isFinite(item)) invalid('invalid_value');
      if (item === null || typeof item !== 'object') { stack.pop(); continue; }
      frame.array = Array.isArray(item);
      frame.keys = frame.array ? null : Object.keys(item);
      frame.length = frame.array ? item.length : frame.keys.length;
      if (frame.length > maxNodes - nodes) limited(nodeReason);
      frame.index = 0;
      frame.entered = true;
    }
    if (frame.index === frame.length) { stack.pop(); continue; }
    const key = frame.array ? frame.index : frame.keys[frame.index];
    if (!frame.array) unicode(key);
    frame.index++;
    stack.push({ value: frame.value[key], depth: frame.depth + 1, entered: false });
  }
  return { nodes, depth: deepest };
}

function shape(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid_shape');
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) invalid('invalid_shape');
}
function exact(value, expected) { if (value !== expected) invalid('invalid_value'); }
function hash(value) {
  if (typeof value !== 'string' || value.length !== 64 || !SHA.test(value)) invalid('invalid_value');
}
function uuid(value) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) invalid('invalid_value');
}
function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('invalid_value');
}
function intText(value, positive = false) {
  if (typeof value !== 'string' || !BIGINT.test(value) ||
      (value.length === 19 && value > BIGINT_MAX) || (positive && value === '0')) invalid('invalid_value');
}
function boundedCount(value, maximum, reason, positive = false) {
  intText(value, positive);
  const ceiling = String(maximum);
  if (value.length > ceiling.length || (value.length === ceiling.length && value > ceiling)) limited(reason);
  return Number(value);
}
function sourceText(value, maximum, trim) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      (trim && value !== value.trim()) || CONTROL.test(value)) invalid('invalid_value');
}
function date(value) {
  // No supplied objects reach this helper; only its fixed calendar failure is mapped.
  try { assessmentDate(value); }
  catch (error) {
    if (error instanceof TypeError && error.message === 'invalid_neighborhood_assessment:effective_date') invalid('invalid_value');
    throw error;
  }
}
function instant(value) {
  if (typeof value !== 'string' || value.length !== 27 ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.test(value)) invalid('invalid_value');
  date(value.slice(0, 10));
}
function canonical(value, nodeReason, byteReason) {
  try { return canonicalAssessmentJson(value); }
  catch (error) {
    if (error instanceof TypeError && error.message === 'invalid_neighborhood_assessment:json_limit') limited(nodeReason);
    if (error instanceof TypeError && error.message === 'invalid_neighborhood_assessment:json_bytes') limited(byteReason);
    throw error;
  }
}
function storage(value) {
  try { assertNeighborhoodJsonbStorage(value); }
  catch (error) {
    if (error instanceof TypeError && ['bytes', 'nodes', 'depth'].some(reason =>
      error.message === `neighborhood_jsonb_storage_limit:${reason}`)) limited('storage_limit');
    // Unicode and finite JSON were already admitted; other failures are bugs,
    // not caller-controlled error.code values that can impersonate a safe result.
    throw error;
  }
}
function blobRef(ref) {
  shape(ref, ['content_sha256', 'canonical_utf8_bytes']);
  hash(ref.content_sha256);
  return boundedCount(ref.canonical_utf8_bytes, LIMIT.blob_bytes, 'blob_bytes', true);
}
function directoryRef(ref) {
  shape(ref, ['manifest', 'entry_count']);
  blobRef(ref.manifest);
  return boundedCount(ref.entry_count, LIMIT.accounts, 'account_limit');
}

function metadata(value) {
  shape(value, ['reader_version', 'mapping_version', 'scope', 'effective_date', 'observation_period',
    'knowledge_cutoff', 'capture_observed_at', 'authorization', 'semantics', 'selection_method',
    'provider_coverage', 'limits', 'capabilities']);
  exact(value.reader_version, 'local-capture-v3'); exact(value.mapping_version, 1);
  shape(value.scope, ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']);
  for (const key of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id']) uuid(value.scope[key]);
  sourceText(value.scope.account_id, 64, true);
  date(value.effective_date);
  shape(value.observation_period, ['start_date', 'end_date']);
  date(value.observation_period.start_date); date(value.observation_period.end_date);
  if (value.observation_period.start_date > value.observation_period.end_date ||
      value.observation_period.end_date > value.effective_date) invalid('invalid_value');
  exact(value.knowledge_cutoff, null); instant(value.capture_observed_at);
  exact(value.semantics, 'current_mutable_query_capture_not_historical_replay');
  exact(value.selection_method, 'exact_selected_accounts_all_source_links_no_event_filter');
  exact(value.provider_coverage, 'unknown');
  shape(value.limits, Object.keys(READER_LIMITS));
  for (const [key, maximum] of Object.entries(READER_LIMITS)) integer(value.limits[key], 1, maximum);
  shape(value.capabilities, Object.keys(RELATIONS));
  for (const [key, relation] of Object.entries(RELATIONS)) {
    const capability = value.capabilities[key];
    shape(capability, ['relation', 'state', 'missing_columns']);
    exact(capability.relation, relation); exact(capability.state, 'available');
    if (!Array.isArray(capability.missing_columns) || capability.missing_columns.length) invalid('invalid_value');
  }
  const auth = value.authorization;
  shape(auth, ['target', 'selection', 'selection_sha256', 'transaction_closure', 'market_decision']);
  shape(auth.target, ['report_file_id', 'workflow_type', 'workflow_target_id']);
  uuid(auth.target.report_file_id);
  if (auth.target.workflow_type === 'custom_appraisal') intText(auth.target.workflow_target_id, true);
  else if (auth.target.workflow_type === 'uad_3_6') uuid(auth.target.workflow_target_id);
  else invalid('invalid_value');
  shape(auth.selection, ['id', 'revision', 'definition_sha256', 'source_sha256']);
  sourceText(auth.selection.id, 200, false); integer(auth.selection.revision, 1, 2_147_483_647);
  hash(auth.selection.definition_sha256); hash(auth.selection.source_sha256); hash(auth.selection_sha256);
  shape(auth.market_decision, ['decision_id', 'policy_revision']);
  sourceText(auth.market_decision.decision_id, 200, false);
  sourceText(auth.market_decision.policy_revision, 200, false);
  const closure = auth.transaction_closure;
  shape(closure, ['version', 'source_revision', 'closure_sha256', 'transaction_count', 'link_count',
    'legacy_sale_count', 'account_count', 'source_record_count']);
  exact(closure.version, 1); sourceText(closure.source_revision, 200, true); hash(closure.closure_sha256);
  for (const key of ['transaction_count', 'link_count', 'legacy_sale_count', 'account_count', 'source_record_count']) {
    integer(closure[key], 0, Number.MAX_SAFE_INTEGER);
  }
  const { transaction_count: t, link_count: l, legacy_sale_count: g, account_count: a, source_record_count: s } = closure;
  const total = t + l + g;
  if (!Number.isSafeInteger(total) || total > 100_000 || a > 50_000 || s !== t ||
      (t === 0 && l !== 0) || ((a === 0) !== (t + g === 0)) || a > 2 * t + l + g) invalid('invalid_value');
  return total;
}

function parseBlobs(bundle, work) {
  if (!Array.isArray(bundle.blobs)) invalid('invalid_shape');
  if (bundle.blobs.length > LIMIT.blobs) limited('blob_limit');
  // Admit/charge all supplied representations before building a digest index.
  const admitted = [];
  for (const entry of bundle.blobs) {
    shape(entry, ['ref', 'canonical_json']);
    const declared = blobRef(entry.ref);
    const text = entry.canonical_json;
    if (typeof text !== 'string') invalid('invalid_shape');
    if (text.length > LIMIT.blob_bytes) limited('blob_bytes');
    const size = bytes(text);
    if (size > LIMIT.blob_bytes) limited('blob_bytes');
    work.bytes += size;
    if (work.bytes > LIMIT.work_bytes) limited('work_limit');
    let value;
    try { value = JSON.parse(text); } catch { invalid('invalid_json'); }
    const stats = admitTree(value, LIMIT.blob_nodes, LIMIT.blob_depth, 'blob_nodes', 'blob_depth');
    work.nodes += stats.nodes;
    if (work.nodes > LIMIT.work_nodes) limited('work_limit');
    if (size !== declared) invalid('blob_conflict');
    if (text !== canonical(value, 'blob_nodes', 'blob_bytes')) invalid('noncanonical_json');
    storage(value);
    if (digest(text) !== entry.ref.content_sha256) invalid('digest_mismatch');
    admitted.push({ ref: entry.ref, text, value, bytes: size, ...stats });
  }
  const index = new Map();
  let previous = null;
  for (const entry of admitted) {
    const key = entry.ref.content_sha256;
    if (index.has(key)) invalid('duplicate_blob');
    if (previous !== null && key < previous) invalid('invalid_value');
    index.set(key, entry); previous = key;
  }
  return index;
}

function verifyQuery(bundle, index) {
  const used = new Set();
  const resolve = ref => {
    blobRef(ref);
    const entry = index.get(ref.content_sha256);
    if (!entry) invalid('missing_blob');
    if (entry.ref.canonical_utf8_bytes !== ref.canonical_utf8_bytes) invalid('blob_conflict');
    if (used.has(ref.content_sha256)) invalid('blob_conflict'); // distinct semantic roles/pages
    used.add(ref.content_sha256);
    return entry;
  };
  const preimage = resolve(bundle.query_preimage);
  if (preimage.bytes > LIMIT.preimage_bytes) limited('blob_bytes');
  if (preimage.nodes > LIMIT.preimage_nodes) limited('blob_nodes');
  if (preimage.depth > LIMIT.preimage_depth) limited('blob_depth');
  shape(preimage.value, ['query_preimage_version', 'compact_metadata', 'ordered_account_roster']);
  exact(preimage.value.query_preimage_version, 1);
  const rosterRef = preimage.value.ordered_account_roster;
  const expected = directoryRef(rosterRef);
  const compact = resolve(preimage.value.compact_metadata);
  if (compact.bytes > LIMIT.metadata_bytes) limited('blob_bytes');
  if (compact.nodes > LIMIT.metadata_nodes) limited('blob_nodes');
  const identityRows = metadata(compact.value);
  const directory = resolve(rosterRef.manifest).value;
  shape(directory, ['directory_version', 'kind', 'entry_count', 'pages']);
  exact(directory.directory_version, 1); exact(directory.kind, 'authorized_accounts');
  const count = boundedCount(directory.entry_count, LIMIT.accounts, 'account_limit');
  if (count === 0 || count !== expected) invalid('directory_mismatch');
  if (!Array.isArray(directory.pages)) invalid('invalid_shape');
  if (directory.pages.length > LIMIT.pages) limited('blob_limit');
  if (directory.pages.length === 0) invalid('directory_mismatch');
  const accounts = [];
  let previous = null;
  let subjectPresent = false;
  for (let pageIndex = 0; pageIndex < directory.pages.length; pageIndex++) {
    const reference = directory.pages[pageIndex];
    shape(reference, ['page_index', 'entry_count', 'page']);
    const indexValue = boundedCount(reference.page_index, LIMIT.pages - 1, 'blob_limit');
    if (indexValue !== pageIndex) invalid('directory_mismatch');
    const pageCount = boundedCount(reference.entry_count, LIMIT.page_accounts, 'account_limit', true);
    if (accounts.length + pageCount > LIMIT.accounts) limited('account_limit');
    const page = resolve(reference.page).value;
    shape(page, ['directory_version', 'kind', 'page_index', 'entries']);
    exact(page.directory_version, 1); exact(page.kind, 'authorized_accounts');
    intText(page.page_index);
    if (page.page_index !== reference.page_index) invalid('directory_mismatch');
    if (!Array.isArray(page.entries)) invalid('invalid_shape');
    if (page.entries.length > LIMIT.page_accounts) limited('account_limit');
    if (page.entries.length !== pageCount) invalid('directory_mismatch');
    for (const entry of page.entries) {
      shape(entry, ['account_id']);
      sourceText(entry.account_id, 64, true);
      if (previous !== null && entry.account_id <= previous) invalid('directory_mismatch');
      previous = entry.account_id;
      if (entry.account_id === compact.value.scope.account_id) subjectPresent = true;
      accounts.push(entry.account_id);
    }
  }
  if (accounts.length !== count || !subjectPresent) invalid('directory_mismatch');
  if (index.size !== used.size) invalid('unused_blob');
  if (count > compact.value.limits.selected_accounts) limited('account_limit');
  if (count + 2 * identityRows > compact.value.limits.records) invalid('invalid_value');
  const authorizationPreimage = { scope: compact.value.scope, effective_date: compact.value.effective_date,
    selection: compact.value.authorization.selection, account_ids: accounts };
  const authorizationJson = canonical(authorizationPreimage, 'authorization_preimage_limit', 'authorization_preimage_limit');
  if (digest(authorizationJson) !== compact.value.authorization.selection_sha256) invalid('selection_mismatch');
  const query = createHash('sha256').update(compact.text, 'utf8');
  for (const account of accounts) query.update(canonicalAssessmentJson(account), 'utf8').update('\n');
  if (query.digest('hex') !== bundle.captured_query_selection_sha256) invalid('query_hash_mismatch');
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Retained-byte/hash consistency only; never proves an original source read. */
export function prepareCohortLocalQueryEvidenceV1(inputJson) {
  try {
    if (typeof inputJson !== 'string') invalid('invalid_input_type');
    if (inputJson.length > LIMIT.input_bytes) limited('input_bytes');
    const size = bytes(inputJson);
    if (size > LIMIT.input_bytes) limited('input_bytes');
    let bundle;
    try { bundle = JSON.parse(inputJson); } catch { invalid('invalid_json'); }
    const stats = admitTree(bundle, LIMIT.input_nodes, LIMIT.input_depth, 'input_nodes', 'input_depth');
    if (inputJson !== JSON.stringify(bundle)) invalid('noncanonical_json');
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) invalid('invalid_shape');
    integer(bundle.version, 1, Number.MAX_SAFE_INTEGER);
    if (bundle.version !== 1) return Object.freeze({ status: 'unsupported', reason: 'unsupported_version' });
    shape(bundle, ['version', 'producer_profile', 'query_preimage', 'captured_query_selection_sha256', 'blobs']);
    if (typeof bundle.producer_profile !== 'string' || !bundle.producer_profile.length ||
        bytes(bundle.producer_profile) > 64) invalid('invalid_value');
    if (bundle.producer_profile !== 'local-capture-v3') {
      return Object.freeze({ status: 'unsupported', reason: 'unsupported_producer_profile' });
    }
    blobRef(bundle.query_preimage); hash(bundle.captured_query_selection_sha256);
    const index = parseBlobs(bundle, { bytes: size, nodes: stats.nodes });
    verifyQuery(bundle, index);
    const result = { status: 'syntax_valid', contract_version: 1,
      validation_scope: 'retained_bytes_and_query_hashes_only', authority: 'not_established', evidence: bundle };
    admitTree(result, LIMIT.output_nodes, LIMIT.output_depth, 'output_limit', 'output_limit');
    if (bytes(JSON.stringify(result)) > LIMIT.output_bytes) limited('output_limit');
    return freezeJson(result);
  } catch (error) {
    if (error instanceof AdmissionFailure) return error.result;
    throw error;
  }
}
