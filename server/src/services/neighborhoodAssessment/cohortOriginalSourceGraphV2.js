import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS as KINDS,
  COHORT_ORIGINAL_SOURCE_REFERENCES_V2_LIMITS as LIMITS } from './cohortOriginalSourceReferencesV2.js';

const FORMAT = 'cohort_original_source_graph_receipt_v2';
const BINDING_KEYS = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id',
  'operation_id', 'generation_id', 'spatial_definition_sha256', 'source_original_sha256'];
const STATE_KEYS = ['kind_index', 'position', 'page_count', 'row_count', 'original_utf8_bytes'];
const RECEIPT_KEYS = ['format', 'binding', 'source_reference', 'root', 'sequence', 'previous',
  'kind', 'before', 'consumed_node', 'next_position', 'after'];
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
function fail(reason) { throw new TypeError(`cohort_original_source_graph_v2_${reason}`); }
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || !keys.every(key => names.includes(key)
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function ref(value) {
  const r = data(value, ['content_sha256', 'canonical_utf8_bytes']);
  return prepareNeighborhoodCohortBlobReference(r.content_sha256, r.canonical_utf8_bytes);
}
function bindingOf(raw) {
  const b = data(raw, BINDING_KEYS);
  if (!['organization_id', 'report_file_id', 'operation_id', 'generation_id'].every(k => typeof b[k] === 'string' && UUID.test(b[k]))
    || typeof b.assignment_file_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(b.assignment_file_id)
    || BigInt(b.assignment_file_id) > 9223372036854775807n || typeof b.account_id !== 'string'
    || !b.account_id || b.account_id.length > 64 || !b.account_id.isWellFormed() || b.account_id.trim() !== b.account_id
    || /[\u0000-\u001f\u007f]/.test(b.account_id)
    || !['spatial_definition_sha256', 'source_original_sha256'].every(k => typeof b[k] === 'string' && SHA.test(b[k]))) fail('invalid_binding');
  return Object.freeze(b);
}
function positionOf(raw) {
  if (raw === null) return null;
  const p = data(raw, ['node', 'index', 'next_cursor']);
  if (!integer(p.index, LIMITS.pages - 1) || typeof p.next_cursor !== 'string'
    || !p.next_cursor.isWellFormed() || Buffer.byteLength(p.next_cursor) > 256
    || p.next_cursor.includes('\0')) fail('invalid_receipt');
  return { ...p, node: ref(p.node) };
}
function stateOf(raw) {
  const p = data(raw, STATE_KEYS), position = positionOf(p.position);
  if (!integer(p.kind_index, KINDS.length) || !integer(p.page_count, LIMITS.pages)
    || !integer(p.row_count, LIMITS.layer_rows) || !integer(p.original_utf8_bytes, LIMITS.original_utf8_bytes)
    || position === null && (p.page_count !== 0 || p.row_count !== 0 || p.original_utf8_bytes !== 0)
    || position !== null && (p.kind_index === KINDS.length || p.page_count < 1 || p.original_utf8_bytes < 1))
    fail('invalid_receipt');
  return { ...p, position };
}
const start = kind_index => ({ kind_index, position: null, page_count: 0, row_count: 0, original_utf8_bytes: 0 });
function receiptOf(raw, binding, sourceReference, root) {
  const r = data(raw, RECEIPT_KEYS);
  if (r.format !== FORMAT || !same(bindingOf(r.binding), binding)
    || !same(ref(r.source_reference), sourceReference) || !same(ref(r.root), root)
    || !integer(r.sequence, LIMITS.pages) || r.sequence < 1) fail('invalid_receipt');
  const before = stateOf(r.before), after = stateOf(r.after), previous = r.previous === null ? null : ref(r.previous);
  if (r.kind !== KINDS[before.kind_index] || after.kind_index < before.kind_index
    || after.kind_index > before.kind_index + 1 || (r.sequence === 1) !== (previous === null)
    || r.sequence === 1 && !same(before, start(0))) fail('invalid_receipt');
  const next = positionOf(r.next_position);
  if (next === null ? !same(after, start(before.kind_index + 1))
    : after.kind_index !== before.kind_index || !same(after.position, next)
      || after.page_count !== before.page_count + 1 || after.row_count < before.row_count
      || after.original_utf8_bytes <= before.original_utf8_bytes) fail('invalid_receipt');
  return { ...r, binding, source_reference: sourceReference, root, previous,
    before, consumed_node: ref(r.consumed_node), next_position: next, after };
}
function checkState(state, layers) {
  if (state.kind_index === KINDS.length) return;
  const layer = layers[KINDS[state.kind_index]];
  if (state.position !== null && (state.page_count !== layer.page_count - 1 - state.position.index
    || state.row_count > layer.row_count || state.original_utf8_bytes >= layer.original_utf8_bytes)) fail('invalid_receipt');
}

/** One exact V2 graph transition, never free checkpoint progress. The actual
 * owner loads issued_receipt ONLY via its independent scoped monotonic anchor,
 * verifies its immutable blob, and commits the new receipt/anchor/checkpoint in
 * one current-authorized transaction. SHA alone is not issuance provenance.
 * Starting at each real root head and advancing only a previously issued edge
 * proves reachability inductively with constant metadata per step, not a scan
 * back to the head on every resume. V2 read reproduces the fixed original SQL
 * page and checks its exact digest/bytes; no provider payload is copied here.
 * This is representation verification only, not identity/geographic coverage,
 * a source grant, complete acquisition or permission to publish a report. */
export async function verifyCohortOriginalSourceGraphV2Step(raw) {
  const input = data(raw, ['chain', 'binding', 'source_reference', 'root', 'issued_receipt', 'issued_reference', 'checkBudget']);
  if (typeof input.chain?.describe !== 'function' || typeof input.chain?.read !== 'function'
    || typeof input.checkBudget !== 'function') fail('invalid_input');
  const binding = bindingOf(input.binding), sourceReference = ref(input.source_reference), root = ref(input.root);
  // Detach every data field before the first await; never invoke caller hooks.
  const previous = input.issued_receipt === null ? null : JSON.parse(canonicalAssessmentJson(
    receiptOf(input.issued_receipt, binding, sourceReference, root)));
  const previousReference = input.issued_reference === null ? null : ref(input.issued_reference);
  if ((previous === null) !== (previousReference === null)) fail('invalid_receipt');
  if (previous !== null && !same(prepareNeighborhoodCohortBlob(canonicalAssessmentJson(previous)), previousReference)) fail('invalid_receipt');
  const state = previous?.after ?? start(0), check = input.checkBudget, chain = input.chain;
  check(); const prefix = await chain.describe(root); check();
  if (!KINDS.every(kind => prefix.layers[kind].ended)) fail('unfinished_original_graph');
  checkState(state, prefix.layers);
  const output = (receipt, advanced) => Object.freeze({ status: 'original_graph_progress_v2', authority: 'not_established',
    coverage: 'representation_only', receipt, advanced, verified_layer_count: (receipt?.after ?? state).kind_index,
    all_layers_verified: (receipt?.after ?? state).kind_index === KINDS.length });
  if (state.kind_index === KINDS.length) return output(previous, false);
  const kind = KINDS[state.kind_index], layer = prefix.layers[kind];
  const consumedNode = state.position?.node ?? layer.head;
  const step = await chain.read({ root, kind, position: state.position }); check();
  if (step.index !== layer.page_count - 1 - state.page_count || !same(step.layer, layer)) fail('graph_changed');
  const original = JSON.parse(step.original_text).page;
  const counts = { page_count: state.page_count + 1, row_count: state.row_count + original.rows.length,
    original_utf8_bytes: state.original_utf8_bytes + Buffer.byteLength(step.original_text) };
  if (counts.page_count > layer.page_count || counts.row_count > layer.row_count
    || counts.original_utf8_bytes > layer.original_utf8_bytes) fail('graph_count_mismatch');
  let after;
  if (step.next_position === null) {
    if (!same(counts, { page_count: layer.page_count, row_count: layer.row_count,
      original_utf8_bytes: layer.original_utf8_bytes })) fail('graph_count_mismatch');
    after = start(state.kind_index + 1);
  } else after = { ...state, position: step.next_position, ...counts };
  if (!same((await chain.describe(root)).layers, prefix.layers)) fail('graph_changed');
  const receipt = receiptOf({ format: FORMAT, binding, source_reference: sourceReference, root,
    sequence: (previous?.sequence ?? 0) + 1, previous: previousReference, kind, before: state,
    consumed_node: consumedNode, next_position: step.next_position, after }, binding, sourceReference, root);
  check(); return output(Object.freeze(receipt), true);
}
