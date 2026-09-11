import { getUadNeighborhoodMaterialCatalogV1 } from './neighborhoodMaterialInputCatalog.js';
import { decodeNeighborhoodOriginalValue } from '../../services/neighborhoodAssessment/originalValueDecoding.js';
import { scanOriginalJsonText, classifyOriginalJsonTokenFailure } from '../../services/neighborhoodAssessment/originalJsonTokens.js';
import { canonicalAssessmentJson } from '../../services/neighborhoodAssessment/contract.js';
import { assertNeighborhoodJsonbStorage } from '../../services/neighborhoodAssessment/jsonbStorage.js';

// Pure stored representation. This does not establish original capture, profile
// applicability, field authority, supported equality, or permission to use it.
const FAILURES = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCES = ['homenode', 'public_record', 'mls', 'document', 'measurement', 'calculated', 'appraiser', 'imported'];
const STATUSES = ['draft', 'validating', 'ready', 'signed', 'exported', 'submitted', 'revised', 'cancelled'];
const TYPES = ['string', 'text', 'enum', 'boolean', 'integer', 'measurement', 'year', 'state', 'postal_code'];
const GRAMMAR = ['invalid_json', 'invalid_unicode', 'duplicate_json_key'];
const NUMBERS = ['negative_zero', 'nonfinite_numeric', 'numeric_underflow', 'inexact_numeric'];
const SCAN_LIMITS = ['input_bytes', 'decoded_nodes', 'decoded_depth', 'numeric_token_limit', 'numeric_exponent_limit'];
const DECODE_LIMITS = [...SCAN_LIMITS, 'output_limit'];
const GUARD_LIMITS = ['invalid_neighborhood_assessment:json_limit', 'invalid_neighborhood_assessment:json_bytes',
  'neighborhood_jsonb_storage_limit:bytes', 'neighborhood_jsonb_storage_limit:nodes', 'neighborhood_jsonb_storage_limit:depth'];
const FIELD_KEYS = ['id', 'workfile_id', 'entity_id', 'uad_uid', 'field_context', 'report_field_id', 'value',
  'source_type', 'source_reference', 'source_observed_at', 'confidence', 'is_appraiser_confirmed', 'is_override',
  'override_reason', 'updated_by_user_id', 'created_at', 'updated_at'];
const ENTITY_KEYS = ['id', 'workfile_id', 'parent_entity_id', 'entity_type', 'entity_identifier', 'ordinal',
  'label', 'data', 'created_at', 'updated_at'];
const compare = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
const tupleCompare = (a, b) => {
  for (let i = 0; i < a.length; i++) { const difference = compare(a[i], b[i]); if (difference) return difference; }
  return 0;
};
// JSON tuple encoding is injective for these admitted string/null primitives.
const slotKey = (context, uid) => JSON.stringify([context, uid]);
const fieldKey = row => JSON.stringify([row.field_context, row.uad_uid, row.entity_id]);
const fieldOrder = row => [row.field_context, row.uad_uid, row.entity_id, row.id];

function stop(status, reason) {
  const token = Object.freeze({});
  FAILURES.set(token, { status, reason });
  throw token;
}
const invalid = () => stop('invalid_input', 'invalid_raw_workflow');
const integrity = () => stop('unsupported', 'scope_or_integrity');
const failed = () => stop('failed', 'representation_failed');
const unsupportedValue = () => stop('unsupported', 'unsupported_stored_value');
const limit = reason => stop('limit_exceeded', reason);
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const isUuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const isPositiveInt32 = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const nullableText = value => value === null || typeof value === 'string';
const nullableUuid = value => value === null || isUuid(value);
function exact(object, keys, refusal = invalid) {
  if (!plain(object) || Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) refusal();
}
function frozen(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

// Only used around the real fixed helper calls on owned data, never as a
// classifier for arbitrary errors at the public catch boundary.
function helperMessage(error) {
  if (!(error instanceof TypeError)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : null;
}
function catalog() {
  let result;
  try { result = getUadNeighborhoodMaterialCatalogV1(); }
  catch (error) {
    if (['release_mismatch', 'catalog_mismatch', 'definition_not_json', 'limit_exceeded']
      .some(reason => helperMessage(error) === `uad_neighborhood_material_catalog:${reason}`)) {
      stop('unsupported', 'unsupported_catalog');
    }
    failed();
  }
  if (result.field_templates.some(template => !TYPES.includes(template.catalog_definition.dataType))) {
    stop('unsupported', 'unsupported_catalog');
  }
  return result;
}

function decodingFailure(result, stage) {
  const { status, reason } = result;
  if (status === 'limit_exceeded' && DECODE_LIMITS.includes(reason)) {
    limit(stage === 'outer' ? (reason === 'input_bytes' ? 'input_limit' : 'raw_limit')
      : stage === 'capture' ? 'raw_limit' : 'decoded_limit');
  }
  if (status === 'invalid_input' && reason === 'storage_state_mismatch') {
    if (stage === 'cell') stop('invalid_input', 'storage_state_mismatch');
    if (stage === 'outer' || stage === 'capture') invalid();
  }
  if (status === 'unsupported') {
    if ((stage === 'outer' || stage === 'cell') && GRAMMAR.includes(reason)) invalid();
    if (NUMBERS.includes(reason)) {
      if (stage === 'outer') invalid();
      if (stage === 'cell') unsupportedValue();
    }
    if (['invalid_timestamp_text', 'invalid_unicode'].includes(reason)) {
      if (stage === 'capture') invalid();
      if (stage === 'observed') stop('unsupported', 'unsupported_provenance');
    }
  }
  failed();
}
function decode(kind, state, text, stage) {
  const result = decodeNeighborhoodOriginalValue(kind, state, text);
  if (result.decoder_version !== 1 || result.interpretation !== 'representation_only'
    || result.kind !== kind || result.storage_state !== state) failed();
  if (result.status !== 'decoded') decodingFailure(result, stage);
  if (result.reason !== null || !plain(result.usage)) failed();
  return result;
}
function admit(value, reason) {
  let nodes = 0;
  let depth = 0;
  function visit(item, level) {
    if (++nodes > 100000 || level > 35) limit(reason);
    depth = Math.max(depth, level);
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child, level + 1);
    }
  }
  visit(value, 0);
  let canonical;
  try {
    canonical = canonicalAssessmentJson(value);
    assertNeighborhoodJsonbStorage(value);
  } catch (error) {
    if (GUARD_LIMITS.includes(helperMessage(error))) limit(reason);
    failed();
  }
  return { bytes: Buffer.byteLength(canonical, 'utf8'), nodes, depth };
}
function cellShape(cell, nullable) {
  const mismatch = () => stop('invalid_input', 'storage_state_mismatch');
  exact(cell, ['state', 'pg_text'], mismatch);
  if (cell.state === 'sql_null') { if (!nullable || cell.pg_text !== null) mismatch(); }
  else if (cell.state === 'json_null') { if (cell.pg_text !== 'null') mismatch(); }
  else if (cell.state !== 'present' || typeof cell.pg_text !== 'string') mismatch();
}

function rawShape(raw, descriptor) {
  exact(raw, ['raw_workflow_version', 'source_basis', 'extractor_ref', 'setup_operation_id', 'captured_at',
    'target', 'workfile_state', 'field_rows', 'entity_rows']);
  if (raw.raw_workflow_version !== 1 || !isUuid(raw.setup_operation_id) || typeof raw.captured_at !== 'string') invalid();
  exact(raw.source_basis, ['repository', 'commit', 'tree']);
  if (raw.source_basis.repository !== 'HomeNodeCEO/HomeNode' || ['commit', 'tree'].some(key =>
    typeof raw.source_basis[key] !== 'string' || raw.source_basis[key].length !== 40 || !/^[0-9a-f]+$/.test(raw.source_basis[key]))) invalid();
  exact(raw.extractor_ref, ['id', 'revision', 'content_sha256']);
  if (['id', 'revision'].some(key => typeof raw.extractor_ref[key] !== 'string' || !raw.extractor_ref[key].length
    || Buffer.byteLength(raw.extractor_ref[key], 'utf8') > 200)
    || typeof raw.extractor_ref.content_sha256 !== 'string' || raw.extractor_ref.content_sha256.length !== 64
    || !/^[0-9a-f]+$/.test(raw.extractor_ref.content_sha256)) invalid();
  exact(raw.target, ['organization_id', 'report_file_id', 'workflow_type', 'workfile_id', 'account_id',
    'appraisal_case_id', 'subject_snapshot_id', 'snapshot_version']);
  if (['organization_id', 'report_file_id', 'workfile_id', 'appraisal_case_id', 'subject_snapshot_id']
    .some(key => !isUuid(raw.target[key])) || raw.target.workflow_type !== 'uad_3_6' || !isPositiveInt32(raw.target.snapshot_version)) invalid();
  const account = raw.target.account_id;
  if (typeof account !== 'string' || !account.length || account.length > 100 || account !== account.trim()
    || /[\u0000-\u001f\u007f]/.test(account)) invalid();
  exact(raw.workfile_state, ['specification_release_key', 'current_revision', 'status']);
  if (typeof raw.workfile_state.specification_release_key !== 'string'
    || !isPositiveInt32(raw.workfile_state.current_revision) || !STATUSES.includes(raw.workfile_state.status)) invalid();
  if (raw.workfile_state.specification_release_key !== descriptor.specification_release_key) stop('unsupported', 'unsupported_catalog');
  if (!Array.isArray(raw.field_rows) || !Array.isArray(raw.entity_rows)) invalid();
  if (raw.field_rows.length > 2048 || raw.entity_rows.length > 128) limit('raw_limit');
  if (decode('utc6', 'present', raw.captured_at, 'capture').value !== raw.captured_at) invalid();
  for (const row of raw.field_rows) {
    exact(row, FIELD_KEYS);
    if (!isUuid(row.id) || !isUuid(row.workfile_id) || !nullableUuid(row.entity_id)
      || !nullableUuid(row.updated_by_user_id) || !SOURCES.includes(row.source_type)
      || typeof row.is_appraiser_confirmed !== 'boolean' || typeof row.is_override !== 'boolean'
      || ['uad_uid', 'field_context', 'created_at', 'updated_at'].some(key => typeof row[key] !== 'string')
      || ['report_field_id', 'source_reference', 'source_observed_at', 'confidence', 'override_reason'].some(key => !nullableText(row[key]))
      || (row.is_override && row.override_reason === null)) invalid();
    cellShape(row.value, true);
  }
  for (const row of raw.entity_rows) {
    exact(row, ENTITY_KEYS);
    if (!isUuid(row.id) || !isUuid(row.workfile_id) || !nullableUuid(row.parent_entity_id) || !isPositiveInt32(row.ordinal)
      || !nullableText(row.label) || ['entity_type', 'entity_identifier', 'created_at', 'updated_at'].some(key => typeof row[key] !== 'string')) invalid();
    cellShape(row.data, false);
  }
}

function rowGraph(raw, descriptor) {
  const entities = new Map();
  const identifiers = new Set();
  let previous = null;
  for (const entity of raw.entity_rows) {
    const order = [entity.entity_type, entity.id];
    const identifier = JSON.stringify([entity.entity_type, entity.entity_identifier]);
    if (entity.workfile_id !== raw.target.workfile_id || entities.has(entity.id) || identifiers.has(identifier)
      || (previous && tupleCompare(previous, order) >= 0)) integrity();
    entities.set(entity.id, entity); identifiers.add(identifier); previous = order;
  }
  const finished = new Set();
  for (const entity of raw.entity_rows) {
    const active = new Set();
    let cursor = entity;
    while (cursor && !finished.has(cursor.id)) {
      if (active.has(cursor.id)) integrity();
      active.add(cursor.id);
      if (cursor.parent_entity_id === null) break;
      cursor = entities.get(cursor.parent_entity_id);
      if (!cursor) integrity();
    }
    for (const id of active) finished.add(id);
    const parent = entity.parent_entity_id === null ? null : entities.get(entity.parent_entity_id);
    if ((entity.entity_type === 'property' && parent !== null)
      || (['dwelling', 'site_parcel'].includes(entity.entity_type) && parent !== null && parent.entity_type !== 'property')
      || (entity.entity_type === 'unit' && (!parent || !['dwelling', 'outbuilding'].includes(parent.entity_type)))
      || (entity.entity_type === 'unit_area_data_source' && (!parent || parent.entity_type !== 'unit'))) integrity();
  }
  const templates = new Map(descriptor.field_templates.map(template => [slotKey(template.context_key, template.uid), template]));
  const rows = new Map();
  const ids = new Set();
  previous = null;
  for (const row of raw.field_rows) {
    const order = fieldOrder(row);
    const key = fieldKey(row);
    if (row.workfile_id !== raw.target.workfile_id || ids.has(row.id) || rows.has(key)
      || (row.entity_id !== null && !entities.has(row.entity_id)) || (previous && tupleCompare(previous, order) >= 0)) integrity();
    const template = templates.get(slotKey(row.field_context, row.uad_uid));
    if (template && (template.entity_type === null ? row.entity_id !== null
      : row.entity_id === null || entities.get(row.entity_id).entity_type !== template.entity_type)) integrity();
    rows.set(key, row); ids.add(row.id); previous = order;
  }
  return { templates, rows };
}

function storedValue(value, field) {
  const bounds = number => Number.isFinite(number)
    && (field.minimum == null || number >= field.minimum)
    && (field.minimumExclusive == null || number > field.minimumExclusive)
    && (field.maximum == null || number <= field.maximum);
  if (field.dataType === 'boolean') { if (typeof value !== 'boolean') unsupportedValue(); }
  else if (field.dataType === 'integer') { if (!Number.isInteger(value) || !bounds(value)) unsupportedValue(); }
  else if (field.dataType === 'measurement') {
    exact(value, ['amount', 'unit'], unsupportedValue);
    if (typeof value.amount !== 'number' || !bounds(value.amount) || typeof value.unit !== 'string' || !field.units.includes(value.unit)) unsupportedValue();
  } else {
    if (typeof value !== 'string' || (field.maxLength != null && value.length > field.maxLength)) unsupportedValue();
    if (field.dataType === 'enum' && !field.options.includes(value)) unsupportedValue();
    if (field.dataType === 'year' && (value.length !== 4 || !/^[0-9]{4}$/.test(value))) unsupportedValue();
    if (field.dataType === 'state' && (value.length !== 2 || !/^[A-Z]{2}$/.test(value))) unsupportedValue();
    if (field.dataType === 'postal_code' && (![5, 10].includes(value.length) || !/^[0-9]{5}(?:-[0-9]{4})?$/.test(value))) unsupportedValue();
  }
  return value;
}
function embedded(cell, selected, usage) {
  if (cell.state === 'sql_null') { if (selected) unsupportedValue(); return null; }
  if (selected && Buffer.byteLength(cell.pg_text, 'utf8') > 32000) limit('projection_limit');
  let result;
  if (selected) result = decode('jsonb', cell.state, cell.pg_text, 'cell');
  else {
    try { result = scanOriginalJsonText(cell.pg_text, 'validate_only'); }
    catch (error) {
      const known = classifyOriginalJsonTokenFailure(error);
      if (known?.status === 'unsupported' && GRAMMAR.includes(known.reason)) invalid();
      if (known?.status === 'limit_exceeded' && SCAN_LIMITS.includes(known.reason)) limit('decoded_limit');
      failed();
    }
    if (cell.state === 'present' && cell.pg_text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') === 'null') {
      stop('invalid_input', 'storage_state_mismatch');
    }
  }
  const scanned = result.usage;
  usage.embedded_jsonb_cells++;
  usage.embedded_jsonb_utf8_bytes += scanned.input_utf8_bytes;
  usage.embedded_decoded_nodes += scanned.decoded_nodes;
  usage.embedded_decoded_depth = Math.max(usage.embedded_decoded_depth, scanned.decoded_depth);
  usage.embedded_numeric_tokens += scanned.numeric_tokens;
  usage.embedded_numeric_token_utf8_bytes += scanned.numeric_token_utf8_bytes;
  if (selected) usage.consumed_value_cells++;
  aggregate(usage);
  return selected ? result.value : null;
}
function aggregate(usage) {
  if (usage.raw_nodes + usage.embedded_decoded_nodes + usage.consumed_timestamp_cells + 1 > 100000
    || Math.max(usage.raw_depth, usage.embedded_jsonb_cells ? 4 + usage.embedded_decoded_depth : 0) > 35) limit('decoded_limit');
}

/** Complete supplied raw workflow -> selective stored representation only.
 * Keep original evidence on every outcome. Never use this result alone as a
 * supported-applicability check, original capture proof or equality API. */
export function projectUadNeighborhoodMaterialInputsV1(rawWorkflowText) {
  const base = { projector_version: 1, interpretation: 'stored_representation_only',
    status: 'representation_projected', reason: null, material_input: null, usage: null };
  try {
    if (arguments.length !== 1 || typeof rawWorkflowText !== 'string') stop('invalid_input', 'invalid_argument');
    const descriptor = catalog();
    const decoded = decode('jsonb', 'present', rawWorkflowText, 'outer');
    const raw = decoded.value;
    rawShape(raw, descriptor);
    const rawSize = admit(raw, 'raw_limit');
    const graph = rowGraph(raw, descriptor);
    const byType = new Map(descriptor.roster_templates.map(template => [template.entity_type,
      raw.entity_rows.filter(entity => entity.entity_type === template.entity_type)]));
    const observations = descriptor.field_templates.reduce((count, template) => count
      + (template.entity_type === null ? 1 : byType.get(template.entity_type).length), 0);
    const members = [...byType.values()].reduce((count, rows) => count + rows.length, 0);
    if (observations > 2048 || members > 128) limit('projection_limit');
    const usage = { raw_input_utf8_bytes: decoded.usage.input_utf8_bytes, raw_canonical_utf8_bytes: rawSize.bytes,
      raw_nodes: rawSize.nodes, raw_depth: rawSize.depth, embedded_jsonb_cells: 0, embedded_jsonb_utf8_bytes: 0,
      embedded_decoded_nodes: 0, embedded_decoded_depth: 0, embedded_numeric_tokens: 0,
      embedded_numeric_token_utf8_bytes: 0, consumed_value_cells: 0, consumed_timestamp_cells: 0,
      material_canonical_utf8_bytes: 0, material_nodes: 0, material_depth: 0 };
    aggregate(usage);
    const values = new Map();
    for (const row of raw.field_rows) {
      const template = graph.templates.get(slotKey(row.field_context, row.uad_uid));
      const value = embedded(row.value, !!template, usage);
      if (template) values.set(fieldKey(row), row.value.state === 'json_null' ? null : storedValue(value, template.catalog_definition));
    }
    for (const entity of raw.entity_rows) embedded(entity.data, false, usage);
    const provenance = new Map();
    for (const row of raw.field_rows) {
      if (!graph.templates.has(slotKey(row.field_context, row.uad_uid))) continue;
      if (row.source_reference !== null && Buffer.byteLength(row.source_reference, 'utf8') > 8192) limit('projection_limit');
      let observed = null;
      if (row.source_observed_at !== null) {
        observed = decode('timestamptz', 'present', row.source_observed_at, 'observed').value;
        usage.consumed_timestamp_cells++;
        aggregate(usage);
      }
      provenance.set(fieldKey(row), { source_type: row.source_type, source_reference: row.source_reference,
        source_observed_at: observed, is_appraiser_confirmed: row.is_appraiser_confirmed });
    }
    const fields = [];
    for (const template of descriptor.field_templates) {
      const entityIds = template.entity_type === null ? [null] : byType.get(template.entity_type).map(entity => entity.id);
      for (const entity_id of entityIds) {
        const key = JSON.stringify([template.context_key, template.uid, entity_id]);
        const row = graph.rows.get(key);
        fields.push({ field_ref: { entity_id, context_key: template.context_key, uid: template.uid },
          state: row ? row.value.state : 'absent', value: row ? values.get(key) : null,
          provenance: row ? provenance.get(key) : null });
      }
    }
    const material = { material_input_version: 1, workflow_type: 'uad_3_6', report_file_id: raw.target.report_file_id,
      workfile_id: raw.target.workfile_id, account_id: raw.target.account_id,
      specification_release_key: descriptor.specification_release_key,
      profile_id: descriptor.profile_id, profile_revision: descriptor.profile_revision,
      field_observations: fields, entity_rosters: descriptor.roster_templates.map(template => ({
        entity_type: template.entity_type, members: byType.get(template.entity_type).map(entity => ({
          entity_id: entity.id, parent_entity_id: entity.parent_entity_id, data_projection: {},
        })),
      })), accepted_evidence: [] };
    const materialSize = admit(material, 'projection_limit');
    usage.material_canonical_utf8_bytes = materialSize.bytes;
    usage.material_nodes = materialSize.nodes;
    usage.material_depth = materialSize.depth;
    const result = { ...base, material_input: material, usage };
    admit(result, 'projection_limit');
    return frozen(result);
  } catch (error) {
    const known = error !== null && (typeof error === 'object' || typeof error === 'function') ? FAILURES.get(error) : null;
    return frozen({ ...base, status: known?.status || 'failed', reason: known?.reason || 'representation_failed' });
  }
}
