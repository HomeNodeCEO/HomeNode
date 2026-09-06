import { scanOriginalJsonText, measureOriginalUnicodeBytes, classifyOriginalJsonTokenFailure } from './originalJsonTokens.js';
import { decodeNeighborhoodOriginalValue } from './originalValueDecoding.js';
import { canonicalAssessmentJson } from './contract.js';
import { assertNeighborhoodJsonbStorage } from './jsonbStorage.js';

export const CUSTOM_MATERIAL_PROJECTOR_VERSION = 1;
export const CUSTOM_MATERIAL_PROJECTOR_LIMITS = Object.freeze({
  target_bytes: 4096, target_nodes: 128, target_depth: 4,
  section_reads_bytes: 1500000, snapshot_row_bytes: 1500000,
  outer_nodes: 100000, outer_depth: 35, total_input_bytes: 3004096,
  nested_text_bytes: 1500000, nested_nodes: 100000, nested_depth: 35,
  cumulative_bytes: 8000000, cumulative_nodes: 500000,
  cumulative_index_nodes: 300000, cumulative_index_edges: 299997, cumulative_index_key_bytes: 1500000,
  selected_token_bytes: 1500000, text_cell_bytes: 8192, legal_payload_bytes: 32000,
  array_entries: 128, array_occurrences: 512,
  material_bytes: 128000, material_nodes: 25000, material_depth: 16,
  output_bytes: 128000, output_nodes: 25000, output_depth: 16,
  output_jsonb_bytes: 2000000, failure_bytes: 512,
});
const L = CUSTOM_MATERIAL_PROJECTOR_LIMITS;
const PRIVATE = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const SECTION_KEYS = ['report.land_details', 'report.property_characteristics', 'report.subject_identification'];
const TARGET_KEYS = ['organization_id', 'report_file_id', 'workflow_type', 'assignment_file_id',
  'account_id', 'appraisal_case_id', 'subject_snapshot_id', 'snapshot_version'];
const ROW_KEYS = ['assignment_file_id', 'section_key', 'section_value', 'revision',
  'last_applied_session_id', 'last_applied_by_user_id', 'created_at', 'updated_at'];
const SNAPSHOT_KEYS = ['id', 'appraisal_case_id', 'snapshot_version', 'parent_snapshot_id',
  'source_report_file_id', 'verification_status', 'effective_date', 'inspection_date',
  'subject_data', 'source_manifest', 'checksum_sha256', 'created_by_user_id', 'created_at'];
const TEXT = ['string'], NUMBER_TEXT = ['number', 'string'], BOOLEAN_TEXT = ['boolean', 'string'];
const LOCATION = { address: TEXT, city: TEXT, state: TEXT, postal_code: TEXT, county: TEXT };
const MAIN = { year_built: NUMBER_TEXT, living_area_sqft: NUMBER_TEXT, total_living_area: NUMBER_TEXT,
  total_area_sqft: NUMBER_TEXT, number_units: NUMBER_TEXT, percent_complete: NUMBER_TEXT, basement: BOOLEAN_TEXT };
const HOUSING = { structural_style: TEXT, housing_type: TEXT, attachment_type: TEXT,
  architectural_style: TEXT, profile_source: TEXT, source_name: TEXT, source_url: TEXT,
  source_record_reference: TEXT, observed_at: TEXT, confidence: NUMBER_TEXT };
const ADDITIONAL = { number: NUMBER_TEXT, improvement_type: TEXT, area_sqft: NUMBER_TEXT, year_built: NUMBER_TEXT };
const LAND = { number: NUMBER_TEXT, line_number: NUMBER_TEXT, state_code: TEXT, area_sqft: NUMBER_TEXT };
const ACCOUNT = { account_id: TEXT, ...LOCATION, legal_description: TEXT };

function stop(status, reason) {
  const token = Object.freeze({});
  PRIVATE.set(token, Object.freeze({ status, reason }));
  throw token;
}
const invalid = reason => stop('invalid_input', reason);
const unsupported = reason => stop('unsupported', reason);
const limit = reason => stop('limit_exceeded', reason);
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function closed(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) invalid('invalid_shape');
}
function uuid(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) invalid('invalid_identifier');
  return value.toLowerCase();
}
function bigint(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 19 ||
      (value.length === 19 && value > '9223372036854775807')) invalid('invalid_identifier');
  return value;
}
function positiveInt(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) invalid('invalid_identifier');
  return value;
}
function rawText(value, nullable = false) {
  if (!(nullable && value === null) && typeof value !== 'string') invalid('invalid_shape');
}
function pgCell(value) {
  closed(value, ['state', 'pg_text']);
  if (value.state === 'sql_null') {
    if (value.pg_text !== null) invalid('storage_state_mismatch');
  } else if (value.state === 'json_null') {
    if (value.pg_text !== 'null') invalid('storage_state_mismatch');
  } else if (value.state === 'present') {
    if (typeof value.pg_text !== 'string') invalid('storage_state_mismatch');
  } else invalid('storage_state_mismatch');
}
function targetOf(raw) {
  closed(raw, TARGET_KEYS);
  if (raw.workflow_type !== 'custom_appraisal') invalid('invalid_shape');
  if (typeof raw.account_id !== 'string' || !raw.account_id || raw.account_id.length > 100 ||
      raw.account_id.trim() !== raw.account_id || /[\u0000-\u001f\u007f]/.test(raw.account_id)) invalid('invalid_identifier');
  return { organization_id: uuid(raw.organization_id), report_file_id: uuid(raw.report_file_id),
    workflow_type: 'custom_appraisal', assignment_file_id: bigint(raw.assignment_file_id), account_id: raw.account_id,
    appraisal_case_id: uuid(raw.appraisal_case_id), subject_snapshot_id: uuid(raw.subject_snapshot_id),
    snapshot_version: positiveInt(raw.snapshot_version) };
}
function sectionsOf(raw, target) {
  if (!Array.isArray(raw) || raw.length !== 3) invalid('invalid_section_roster');
  for (let i = 0; i < 3; i++) {
    const read = raw[i];
    closed(read, ['section_key', 'row_state', 'row']);
    if (read.section_key !== SECTION_KEYS[i]) invalid('invalid_section_roster');
    if (read.row_state === 'absent') {
      if (read.row !== null) invalid('invalid_shape');
      continue;
    }
    if (read.row_state !== 'present') invalid('invalid_section_roster');
    closed(read.row, ROW_KEYS);
    const row = read.row;
    if (row.section_key !== read.section_key || bigint(row.assignment_file_id) !== target.assignment_file_id) invalid('target_mismatch');
    positiveInt(row.revision);
    uuid(row.last_applied_session_id, true); uuid(row.last_applied_by_user_id, true);
    rawText(row.created_at); rawText(row.updated_at); pgCell(row.section_value);
  }
  return raw;
}
function snapshotOf(raw, target) {
  closed(raw, SNAPSHOT_KEYS);
  if (uuid(raw.id) !== target.subject_snapshot_id || uuid(raw.appraisal_case_id) !== target.appraisal_case_id ||
      positiveInt(raw.snapshot_version) !== target.snapshot_version) invalid('target_mismatch');
  const ids = { parent_snapshot_id: uuid(raw.parent_snapshot_id, true),
    source_report_file_id: uuid(raw.source_report_file_id, true) };
  uuid(raw.created_by_user_id, true); rawText(raw.created_at);
  if (!['captured', 'unverified', 'confirmed', 'superseded'].includes(raw.verification_status)) invalid('invalid_shape');
  if (raw.checksum_sha256 !== null && (typeof raw.checksum_sha256 !== 'string' || !SHA.test(raw.checksum_sha256))) invalid('invalid_identifier');
  rawText(raw.effective_date, true); rawText(raw.inspection_date, true);
  pgCell(raw.subject_data); pgCell(raw.source_manifest);
  return { raw, ids };
}

// Only walks bounded parser-owned or newly constructed values. Account for
// pending children before appending them; this is not an arbitrary-input API.
function nodeCount(value, maxNodes, maxDepth, reason) {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++visited > maxNodes || item.depth > maxDepth) limit(reason);
    if (item.value === null || typeof item.value !== 'object') {
      if (!['string', 'boolean', 'number'].includes(typeof item.value) && item.value !== null) throw new TypeError('owned_value');
      if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new TypeError('owned_number');
      continue;
    }
    const values = Object.values(item.value);
    if (visited + pending.length + values.length > maxNodes) limit(reason);
    for (let i = values.length - 1; i >= 0; i--) pending.push({ value: values[i], depth: item.depth + 1 });
  }
  return visited;
}
function encodedMetrics(value, maxBytes, maxNodes, maxDepth, reason, storage = false) {
  const nodes = nodeCount(value, maxNodes, maxDepth, reason);
  let encoded;
  try { encoded = canonicalAssessmentJson(value); }
  catch (error) {
    if (error instanceof TypeError && ['invalid_neighborhood_assessment:json_limit',
      'invalid_neighborhood_assessment:json_bytes'].includes(error.message)) limit(reason);
    throw error;
  }
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > maxBytes) limit(reason);
  if (storage) {
    try { assertNeighborhoodJsonbStorage(value); }
    catch (error) {
      if (error instanceof TypeError && ['neighborhood_jsonb_storage_limit:bytes',
        'neighborhood_jsonb_storage_limit:nodes', 'neighborhood_jsonb_storage_limit:depth'].includes(error.message)) limit(reason);
      throw error;
    }
  }
  return { bytes, nodes };
}
function failureOf(error) {
  const own = error !== null && (typeof error === 'object' || typeof error === 'function') ? PRIVATE.get(error) : null;
  if (own) return own;
  const shared = classifyOriginalJsonTokenFailure(error);
  if (!shared) return { status: 'failed', reason: 'projector_failed' };
  const mapped = { decoded_nodes: 'input_nodes', decoded_depth: 'input_depth',
    index_nodes: 'index_limit', index_edges: 'index_limit', index_key_bytes: 'index_limit' }[shared.reason];
  return { status: shared.status, reason: mapped || shared.reason };
}

/** Full Custom representation only. The caller retains original wrappers and
 * proves their source/selection/capture/history under its own parent fence. */
export function projectCustomNeighborhoodMaterialInputs(targetJson, sectionReadsJson, originalSnapshotRowJson) {
  const base = { projection_version: 1, interpretation: 'representation_only', status: 'represented',
    reason: null, material_input: null, usage: null };
  try {
    if (arguments.length !== 3 || typeof targetJson !== 'string' || typeof sectionReadsJson !== 'string' ||
        typeof originalSnapshotRowJson !== 'string') invalid('invalid_argument');
    const texts = [targetJson, sectionReadsJson, originalSnapshotRowJson];
    const caps = [L.target_bytes, L.section_reads_bytes, L.snapshot_row_bytes];
    let originalBytes = 0;
    for (let i = 0; i < 3; i++) {
      const size = measureOriginalUnicodeBytes(texts[i]);
      if (size > caps[i] || (originalBytes += size) > L.total_input_bytes) limit('input_bytes');
    }
    const usage = { input_utf8_bytes: 0, input_value_nodes: 0, input_depth: 0,
      nested_utf8_bytes: 0, nested_value_nodes: 0, nested_depth: 0,
      numeric_tokens: 0, numeric_token_utf8_bytes: 0, index_nodes: 0, index_edges: 0,
      index_key_utf8_bytes: 0, selected_token_utf8_bytes: 0, selected_scalar_count: 0,
      processed_utf8_bytes: 0, processed_value_nodes: 0 };
    let legalBytes = 0, arrayCount = 0;
    function cumulative(extraBytes = 0, extraNodes = 0) {
      if (usage.processed_utf8_bytes + extraBytes > L.cumulative_bytes ||
          usage.processed_value_nodes + extraNodes > L.cumulative_nodes) limit('cumulative_limit');
    }
    function charge(metrics) {
      cumulative(metrics.bytes, metrics.nodes);
      usage.processed_utf8_bytes += metrics.bytes; usage.processed_value_nodes += metrics.nodes;
    }
    function admission(result, category) {
      charge({ bytes: result.input_utf8_bytes, nodes: result.decoded_nodes });
      usage.numeric_tokens += result.numeric_tokens;
      usage.numeric_token_utf8_bytes += result.numeric_token_utf8_bytes;
      if (category === 'selected') return;
      const prefix = category === 'input' ? 'input' : 'nested';
      usage[`${prefix}_utf8_bytes`] += result.input_utf8_bytes;
      usage[`${prefix}_value_nodes`] += result.decoded_nodes;
      usage[`${prefix}_depth`] = Math.max(usage[`${prefix}_depth`], result.decoded_depth);
    }
    function decoded(kind, state, text, category) {
      if (text !== null) cumulative(measureOriginalUnicodeBytes(text), category === 'selected' ? 1 : 0);
      const result = decodeNeighborhoodOriginalValue(kind, state, text);
      if (result.status !== 'decoded') {
        if (result.status === 'failed') stop('failed', 'projector_failed');
        const reason = result.reason === 'output_limit' && category === 'snapshot' ? 'snapshot_limit'
          : result.reason === 'decoded_nodes' ? 'input_nodes' : result.reason === 'decoded_depth' ? 'input_depth' : result.reason;
        stop(result.status, reason);
      }
      admission(result.usage, category);
      return result.value;
    }
    const outer = texts.map((text, i) => {
      const result = scanOriginalJsonText(text, 'full_value');
      if (result.usage.decoded_nodes > (i === 0 ? L.target_nodes : L.outer_nodes)) limit('input_nodes');
      if (result.usage.decoded_depth > (i === 0 ? L.target_depth : L.outer_depth)) limit('input_depth');
      admission(result.usage, 'input');
      return JSON.parse(text);
    });
    const target = targetOf(outer[0]);
    const reads = sectionsOf(outer[1], target);
    const snapshot = snapshotOf(outer[2], target);
    const manual = reads.map(read => {
      if (read.row_state === 'absent') return null;
      const cell = read.row.section_value;
      if (cell.state !== 'present') unsupported(`section_${cell.state}`);
      cumulative(measureOriginalUnicodeBytes(cell.pg_text));
      const scanned = scanOriginalJsonText(cell.pg_text, 'index');
      admission(scanned.usage, 'nested');
      const index = scanned.index;
      if (usage.index_nodes + index.nodes.length > L.cumulative_index_nodes ||
          usage.index_edges + index.index_edges > L.cumulative_index_edges ||
          usage.index_key_utf8_bytes + index.decoded_key_utf8_bytes > L.cumulative_index_key_bytes) limit('index_limit');
      usage.index_nodes += index.nodes.length; usage.index_edges += index.index_edges;
      usage.index_key_utf8_bytes += index.decoded_key_utf8_bytes;
      if (index.nodes[0].kind === 'null') invalid('storage_state_mismatch');
      if (index.nodes[0].kind !== 'object') unsupported('section_root_type');
      return { source: { text: cell.pg_text, index }, at: 0 };
    });
    function snapshotValue(cell) {
      if (cell.state !== 'present') unsupported(`snapshot_${cell.state}`);
      const value = decoded('jsonb', 'present', cell.pg_text, 'snapshot');
      if (!object(value)) unsupported('snapshot_root_type');
      return value;
    }
    const subject = snapshotValue(snapshot.raw.subject_data);
    const manifest = snapshotValue(snapshot.raw.source_manifest);
    const dates = {};
    for (const key of ['effective_date', 'inspection_date']) {
      dates[key] = snapshot.raw[key] === null ? null : decoded('date', 'present', snapshot.raw[key], 'nested');
    }
    const preimage = { snapshot_evidence_version: 1, snapshot_id: target.subject_snapshot_id,
      appraisal_case_id: target.appraisal_case_id, snapshot_version: target.snapshot_version,
      ...snapshot.ids, verification_status: snapshot.raw.verification_status, ...dates,
      subject_data: subject, source_manifest: manifest, legacy_checksum_sha256: snapshot.raw.checksum_sha256 };
    charge(encodedMetrics(preimage, 1500000, 100000, 35, 'snapshot_limit', true));
    if (!Object.hasOwn(subject, 'custom_property_snapshot')) unsupported('public_snapshot_missing');
    const supplied = subject.custom_property_snapshot;
    if (supplied === null) unsupported('public_snapshot_json_null');
    if (!object(supplied)) unsupported('public_snapshot_root_type');

    function kind(ref) {
      if (ref === undefined) return 'absent';
      if (ref.source) return ref.source.index.nodes[ref.at].kind;
      return ref.value === null ? 'null' : Array.isArray(ref.value) ? 'array' : typeof ref.value;
    }
    function child(ref, key) {
      if (ref.source) {
        const member = ref.source.index.nodes[ref.at].members.find(item => item.key === key);
        return member ? { source: ref.source, at: member.value } : undefined;
      }
      return Object.hasOwn(ref.value, key) ? { value: ref.value[key] } : undefined;
    }
    function scalarValue(ref) {
      if (!ref.source) return ref.value;
      const node = ref.source.index.nodes[ref.at];
      const token = ref.source.text.slice(node.start, node.end);
      const tokenBytes = measureOriginalUnicodeBytes(token);
      if (usage.selected_token_utf8_bytes + tokenBytes > L.selected_token_bytes) limit('selected_token_limit');
      usage.selected_token_utf8_bytes += tokenBytes; usage.selected_scalar_count++;
      return decoded(node.kind === 'number' ? 'numeric' : 'jsonb', node.kind === 'null' ? 'json_null' : 'present', token, 'selected');
    }
    function cell(ref, allowed, legal = false) {
      const type = kind(ref);
      if (type === 'absent') return { state: 'absent', value: null };
      if (type !== 'null' && !allowed.includes(type)) unsupported('selected_value_type');
      const value = scalarValue(ref);
      if (typeof value === 'string') {
        const size = measureOriginalUnicodeBytes(value);
        if (size > L.text_cell_bytes) limit('text_limit');
        if (legal && (legalBytes += size) > L.legal_payload_bytes) limit('legal_limit');
      }
      return { state: type === 'null' ? 'json_null' : 'present', value };
    }
    function fields(ref, definition, legalFields = []) {
      return Object.fromEntries(Object.entries(definition).map(([key, allowed]) =>
        [key, cell(child(ref, key), allowed, legalFields.includes(key))]));
    }
    function objectNode(ref, definition, legalFields = []) {
      const type = kind(ref);
      if (type === 'absent' || type === 'null') return { state: type === 'null' ? 'json_null' : 'absent', value: null };
      if (type !== 'object') unsupported('selected_value_type');
      return { state: 'present', value: fields(ref, definition, legalFields) };
    }
    function rows(ref, definition, legal = false) {
      const type = kind(ref);
      if (type === 'absent' || type === 'null') return { state: type === 'null' ? 'json_null' : 'absent', entries: [] };
      if (type !== 'array') unsupported('selected_value_type');
      const entries = ref.source ? ref.source.index.nodes[ref.at].elements : ref.value;
      if (entries.length > L.array_entries || arrayCount + entries.length > L.array_occurrences) limit('array_limit');
      arrayCount += entries.length;
      return { state: 'present', entries: entries.map((item, i) => {
        const itemRef = ref.source ? { source: ref.source, at: item } : { value: item };
        if (!legal && kind(itemRef) !== 'object') unsupported('selected_value_type');
        return { ordinal: String(i), fields: legal ? { text: cell(itemRef, TEXT, true) } : fields(itemRef, definition) };
      }) };
    }
    function legalNode(ref) {
      const type = kind(ref);
      if (type === 'absent' || type === 'null') return { state: type === 'null' ? 'json_null' : 'absent', text: null, object: null };
      if (type === 'string') return { state: 'text', text: cell(ref, TEXT, true).value, object: null };
      if (type !== 'object') unsupported('selected_value_type');
      return { state: 'object', text: null, object: { legal_description: cell(child(ref, 'legal_description'), TEXT, true),
        lines: rows(child(ref, 'lines'), null, true) } };
    }
    function section(ref, project) {
      return ref === null ? { storage_state: 'absent', projection: null }
        : { storage_state: 'object', projection: project(ref) };
    }
    const publicRoot = { value: supplied };
    const material = { material_input_version: 1, workflow_type: 'custom_appraisal',
      report_file_id: target.report_file_id, assignment_file_id: target.assignment_file_id, account_id: target.account_id,
      profile_id: 'custom-neighborhood-physical-stock-inputs-v1', profile_revision: '1',
      assignment_sections: {
        subject_identification: section(manual[2], ref => ({ property_location: objectNode(child(ref, 'property_location'), LOCATION),
          legal_description: legalNode(child(ref, 'legal_description')) })),
        property_characteristics: section(manual[1], ref => ({ main_improvement: objectNode(child(ref, 'main_improvement'), MAIN),
          housing_profile: objectNode(child(ref, 'housing_profile'), HOUSING),
          additional_improvements: rows(child(ref, 'additional_improvements'), ADDITIONAL) })),
        land_details: section(manual[0], ref => ({ land_detail: rows(child(ref, 'land_detail'), LAND) })),
      },
      retained_public: {
        account: objectNode(child(publicRoot, 'account'), ACCOUNT, ['legal_description']),
        legal: objectNode(child(publicRoot, 'legal'), { legal_description: TEXT }, ['legal_description']),
        improvement: objectNode(child(publicRoot, 'improvement'), MAIN),
        housing_profile: objectNode(child(publicRoot, 'housing_profile'), HOUSING),
        land: rows(child(publicRoot, 'land'), LAND),
        additional_improvements: rows(child(publicRoot, 'additional_improvements'), ADDITIONAL),
      }, accepted_evidence: [] };
    const publicAccount = material.retained_public.account;
    if (publicAccount.state === 'present' && publicAccount.value.account_id.state === 'present' &&
        publicAccount.value.account_id.value !== target.account_id) invalid('target_mismatch');
    charge(encodedMetrics(material, L.material_bytes, L.material_nodes, L.material_depth, 'material_limit'));
    const result = { ...base, material_input: material, usage };
    const priorBytes = usage.processed_utf8_bytes, priorNodes = usage.processed_value_nodes;
    const resultNodes = nodeCount(result, L.output_nodes, L.output_depth, 'output_limit');
    usage.processed_value_nodes = priorNodes + resultNodes;
    // Measure once with the correct node count and a one-digit byte placeholder.
    // Solve only its decimal width; do not repeat whole-result/storage walks.
    usage.processed_utf8_bytes = 0;
    const placeholder = encodedMetrics(result, L.output_bytes, L.output_nodes, L.output_depth, 'output_limit');
    let total = priorBytes + placeholder.bytes;
    let settled = false;
    for (let i = 0; i < 10; i++) {
      const next = priorBytes + placeholder.bytes + String(total).length - 1;
      if (total === next) { settled = true; break; }
      total = next;
    }
    if (!settled) throw new TypeError('counter_fixed_point');
    const predictedBytes = total - priorBytes;
    if (predictedBytes > L.output_bytes) limit('output_limit');
    usage.processed_utf8_bytes = total;
    cumulative();
    const finalMetrics = encodedMetrics(result, L.output_bytes, L.output_nodes, L.output_depth, 'output_limit', true);
    if (finalMetrics.bytes !== predictedBytes || finalMetrics.nodes !== resultNodes) throw new TypeError('counter_measurement');
    return freeze(result);
  } catch (error) {
    const failed = failureOf(error);
    return freeze({ ...base, status: failed.status, reason: failed.reason });
  }
}
