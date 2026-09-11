import { createHash } from "node:crypto";
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { assessmentDate, canonicalAssessmentJson } from "./contract.js";

export const CACHED_SOURCE_CAPTURE_LIMITS = Object.freeze({
  input_captures: 32,
  input_records: 100_000,
  input_bytes: 32_000_000,
  output_captures: 1000,
  output_bytes: 64_000_000,
  payload_bytes: 1_500_000,
  payload_nodes: 100_000,
  envelope_bytes: 64_000,
  envelope_nodes: 10_000,
  records_per_chunk: 1000,
});

// Explicit dense-CAD construction only. Defaults and all per-row/chunk limits
// stay unchanged. This is not authorization or proof of a safe deployed capacity.
export const DENSE_CAD_SOURCE_CAPTURE_LIMITS = Object.freeze({
  ...CACHED_SOURCE_CAPTURE_LIMITS, input_records: 200_000,
  input_bytes: 144_000_000, output_bytes: 160_000_000,
});

const SCOPE_KEYS = ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const invalid = field => { throw new TypeError(`invalid_neighborhood_cached_source_capture:${field}`); };
const limit = field => {
  const error = new RangeError(`neighborhood_cached_source_capture_limit:${field}`);
  Object.assign(error, { code: "NEIGHBORHOOD_CAPTURE_LIMIT", state: "incomplete" });
  throw error;
};

function object(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid(field);
  return value;
}

function text(value, field, maximum = 200) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum
      || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field);
  return value;
}

function scoped(value, field) {
  object(value, field);
  return Object.fromEntries(SCOPE_KEYS.map(key => {
    const entry = text(value[key], `${field}.${key}`, key === "account_id" ? 100 : 36);
    if (key !== "account_id" && !UUID.test(entry)) invalid(`${field}.${key}`);
    return [key, key === "account_id" ? entry : entry.toLowerCase()];
  }));
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Preflight before canonicalization, including large individual strings and
// aggregate string work. This bounds cloning/encoding as well as final bytes.
function inspectJson(value, maximumNodes = CACHED_SOURCE_CAPTURE_LIMITS.payload_nodes,
  maximumBytes = CACHED_SOURCE_CAPTURE_LIMITS.payload_bytes) {
  let nodes = 0;
  let rawBytes = 0;
  const stringBytes = value => {
    if (value.length > maximumBytes) limit("json_string_bytes");
    rawBytes += Buffer.byteLength(value, "utf8");
    if (rawBytes > maximumBytes) limit("json_string_bytes");
  };
  const visit = (item, depth) => {
    if (++nodes > maximumNodes || depth > 35) limit("json_nodes_or_depth");
    if (typeof item === "string") { stringBytes(item); return; }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) invalid("nonfinite_number"); return; }
    if (Array.isArray(item)) {
      if (item.length > maximumNodes) limit("json_array_nodes");
      for (const child of item) visit(child, depth + 1);
      return;
    }
    object(item, "json_object");
    const keys = Object.keys(item);
    if (keys.length > maximumNodes) limit("json_object_nodes");
    for (const key of keys) { stringBytes(key); visit(item[key], depth + 1); }
  };
  visit(value, 0);
  return nodes;
}

function encoded(value, maximumNodes, maximumBytes) {
  const nodes = inspectJson(value, maximumNodes, maximumBytes);
  let json;
  try { json = canonicalAssessmentJson(value); }
  catch (error) {
    if (/invalid_neighborhood_assessment:json_(limit|bytes)$/.test(error.message)) limit("canonical_json");
    throw error;
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maximumBytes) limit("json_bytes");
  return { json, bytes, nodes };
}

function upstreamSource(value, captureScope, maximumRecords = CACHED_SOURCE_CAPTURE_LIMITS.input_records) {
  object(value, "upstream");
  if (!["absent", "present_empty", "populated", "truncated"].includes(value.state)) invalid("upstream.state");
  if (![true, false, null].includes(value.complete)) invalid("upstream.complete");
  const rowCount = count(value.row_count, "upstream.row_count");
  if (rowCount > maximumRecords) limit("upstream.row_count");
  if ((["absent", "present_empty"].includes(value.state) && rowCount !== 0)
      || (value.state === "populated" && rowCount === 0)
      || (["absent", "truncated"].includes(value.state) && value.complete === true)) invalid("upstream.state_count");
  if (!["public", "assignment_private"].includes(value.visibility)) invalid("upstream.visibility");
  let owner = null;
  if (value.visibility === "public") {
    if (value.scope !== null) invalid("upstream.public_scope");
  } else {
    owner = scoped(value.scope, "upstream.scope");
    if (SCOPE_KEYS.some(key => owner[key] !== captureScope[key])) invalid("upstream.scope_mismatch");
  }
  if (value.state === "absent") {
    if (value.revision !== null || value.content_sha256 !== null) invalid("upstream.absent_version");
  } else {
    text(value.revision, "upstream.revision", 1024);
    if (typeof value.content_sha256 !== "string" || !SHA256.test(value.content_sha256)) invalid("upstream.content_sha256");
  }
  return {
    id: text(value.id, "upstream.id", 1024), key: text(value.key, "upstream.key", 100),
    state: value.state, complete: value.complete, revision: value.revision,
    upstream_content_sha256: value.content_sha256,
    captured_at: timestamp(value.captured_at, "upstream.captured_at"),
    visibility: value.visibility, scope: owner, row_count: rowCount,
  };
}

function captureMetadata(value) {
  object(value, "metadata");
  const from = value.valid_from === null ? null : assessmentDate(value.valid_from, "metadata.valid_from");
  const to = value.valid_to === null ? null : assessmentDate(value.valid_to, "metadata.valid_to");
  if (from !== null && to !== null && from > to) invalid("metadata.valid_interval");
  if (!["contemporaneous", "reconstructed", "unknown"].includes(value.historical_availability)) invalid("metadata.historical_availability");
  return {
    id: text(value.id, "metadata.id", 120), provider: text(value.provider, "metadata.provider"),
    revision: text(value.revision, "metadata.revision"), valid_from: from, valid_to: to,
    observed_at: timestamp(value.observed_at, "metadata.observed_at"),
    historical_availability: value.historical_availability,
  };
}

function projection(value, upstream, suppliedRecords) {
  object(value, "projection");
  object(value.definition, "projection.definition");
  if (!Object.keys(value.definition).length) invalid("projection.definition_empty");
  if (![true, false, null].includes(value.complete)) invalid("projection.complete");
  const inputCount = count(value.input_row_count, "projection.input_row_count");
  const outputCount = count(value.output_record_count, "projection.output_record_count");
  if (inputCount !== upstream.row_count || outputCount !== suppliedRecords) invalid("projection.count_mismatch");
  if (["absent", "present_empty"].includes(upstream.state) && suppliedRecords !== 0) invalid("projection.empty_source_records");
  if (upstream.state === "absent" && value.complete === true) invalid("projection.absent_complete");
  const definition = encoded(value.definition, CACHED_SOURCE_CAPTURE_LIMITS.envelope_nodes,
    CACHED_SOURCE_CAPTURE_LIMITS.envelope_bytes);
  return {
    id: text(value.id, "projection.id"), revision: text(value.revision, "projection.revision"),
    definition: JSON.parse(definition.json), input_row_count: inputCount,
    output_record_count: outputCount, complete: value.complete,
  };
}

/**
 * Captures caller-selected, normalized evidence; it does not choose membership,
 * query caches, verify raw-source hashes, or establish historical truth. Both
 * upstream and projection completeness must be explicitly declared true. An
 * empty normalized projection of a populated source requires its explicit
 * selection definition and counts, not an inferred "no properties" result.
 *
 * Every emitted projection is assignment-private even if its raw origin was
 * public: scope, selection, and appraiser work must not enter a public cache.
 * Prepare these sources BEFORE enqueueing so their identities bind the job.
 * metadata.observed_at is the normalized capture observation, not an original
 * fact date, and cannot precede acquisition of its upstream envelope. Earlier
 * fact periods require explicit reconstructed support. A ready result means
 * capture completeness only, not historical or statistical eligibility.
 */
export function buildCachedSourceCaptures(input) {
  const iterator = captureChunks(input, CACHED_SOURCE_CAPTURE_LIMITS, false);
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

// Frozen original reader data can be shared safely by source chunks instead of
// retaining another full parsed copy of the CAD wrappers. Reject mutable graphs,
// accessors and non-JSON prototypes before yielding to other requests.
function requireFrozenGraph(value) {
  const seen = new WeakSet(); let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 20_000_000 || depth > 35) limit('frozen_graph');
    if (!item || typeof item !== 'object') return;
    if (seen.has(item)) return;
    if (!Object.isFrozen(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) invalid('frozen_input_required');
    seen.add(item);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid('frozen_input_required');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

/** Internal opt-in construction for immutable CAD acquisitions. Work yields
 * between bounded batches; cancellation/deadlines are checked before and after
 * every yield. Nothing usable is returned until the complete capture succeeds.
 * It does not query, persist, authorize, apply, or change default reader limits. */
export async function buildFrozenCadSourceCaptures(input, { check = () => {} } = {}) {
  check(); requireFrozenGraph(input); check();
  const iterator = captureChunks(input, DENSE_CAD_SOURCE_CAPTURE_LIMITS, true);
  try {
    while (true) {
      check(); const step = iterator.next(); check();
      if (step.done) return step.value;
      await yieldToRequests(); check();
    }
  } finally { iterator.return(); }
}

function* captureChunks({ scope, captures }, limits, reuseFrozen) {
  const captureScope = scoped(scope, "scope");
  if (!Array.isArray(captures) || !captures.length) invalid("captures");
  if (captures.length > limits.input_captures) limit("input_captures");
  const sourceSnapshots = [];
  const sources = [];
  const references = [];
  const capabilities = [];
  const captureIds = new Set();
  let totalRecords = 0;
  let inputBytes = 0;
  let outputBytes = 0;

  // Sort only small capture descriptors. Row payloads are serialized once and
  // sorted by caller-supplied stable identity, never by locale or arrival order.
  const ordered = captures.map(capture => {
    object(capture, "capture");
    const metadata = captureMetadata(capture.metadata);
    if (captureIds.has(metadata.id)) invalid("duplicate_capture_id");
    captureIds.add(metadata.id);
    return { capture, metadata };
  }).sort((a, b) => compare(a.metadata.id, b.metadata.id));

  for (const { capture, metadata } of ordered) {
    const upstream = upstreamSource(capture.upstream, captureScope, limits.input_records);
    if (metadata.observed_at < upstream.captured_at) invalid("metadata.observed_before_upstream_capture");
    if (!Array.isArray(capture.records)) invalid("records");
    totalRecords += capture.records.length;
    if (totalRecords > limits.input_records) limit("input_records");
    const selected = projection(capture.projection, upstream, capture.records.length);
    const reasons = [];
    if (upstream.state === "absent") reasons.push("source_absent");
    if (upstream.state === "truncated") reasons.push("source_truncated");
    if (upstream.complete !== true) reasons.push(upstream.complete === null ? "source_coverage_unknown" : "source_coverage_incomplete");
    if (selected.complete !== true) reasons.push(selected.complete === null ? "projection_coverage_unknown" : "projection_coverage_incomplete");
    const usable = reasons.length === 0;
    const routing = { capture_id: metadata.id, upstream_source_id: upstream.id, source_refs: [], record_sources: [] };
    const capability = {
      capture_id: metadata.id, upstream_source_id: upstream.id,
      upstream_state: upstream.state, upstream_complete: upstream.complete,
      upstream_row_count: upstream.row_count, projection_complete: selected.complete,
      normalized_record_count: selected.output_record_count,
      historical_availability: metadata.historical_availability,
      status: usable ? "captured" : "unavailable", reasons, source_refs: routing.source_refs,
    };
    capabilities.push(capability);
    references.push(routing);

    const envelope = { schema_version: 1, scope: captureScope, upstream, projection: selected, metadata,
      partition: { index: 999, count: 1000, record_count: limits.input_records }, records: [] };
    const envelopeSize = encoded(envelope, CACHED_SOURCE_CAPTURE_LIMITS.envelope_nodes,
      CACHED_SOURCE_CAPTURE_LIMITS.envelope_bytes);
    inputBytes += envelopeSize.bytes;
    if (inputBytes > limits.input_bytes) limit("input_bytes");
    const recordIds = new Set();
    // Sort references, not a second complete JSON encoding of every source row.
    // Keep only the current bounded chunk's serialized work. The default path
    // detaches records; the opt-in path reuses only verified immutable data.
    const records = [];
    for (const row of capture.records) {
      object(row, "record");
      const recordId = text(row.record_id, "record.record_id");
      object(row.data, "record.data");
      if (recordIds.has(recordId)) invalid("duplicate_record_id");
      recordIds.add(recordId);
      records.push({ record_id: recordId, data: row.data });
    }
    records.sort((a, b) => compare(a.record_id, b.record_id));
    const chunks = [];
    let chunk = [];
    let bytes = envelopeSize.bytes;
    let nodes = envelopeSize.nodes;
    let batchRecords = 0;
    for (const record of records) {
      const value = encoded(record,
        CACHED_SOURCE_CAPTURE_LIMITS.payload_nodes - envelopeSize.nodes,
        CACHED_SOURCE_CAPTURE_LIMITS.payload_bytes - envelopeSize.bytes);
      inputBytes += value.bytes;
      if (inputBytes > limits.input_bytes) limit("input_bytes");
      if (++batchRecords % 125 === 0) yield;
      if (!usable) continue;
      if (chunk.length && (chunk.length >= CACHED_SOURCE_CAPTURE_LIMITS.records_per_chunk
          || bytes + value.bytes + 1 > CACHED_SOURCE_CAPTURE_LIMITS.payload_bytes
          || nodes + value.nodes > CACHED_SOURCE_CAPTURE_LIMITS.payload_nodes)) {
        chunks.push(chunk); chunk = []; bytes = envelopeSize.bytes; nodes = envelopeSize.nodes;
      }
      bytes += value.bytes + (chunk.length ? 1 : 0);
      nodes += value.nodes;
      chunk.push(reuseFrozen ? Object.freeze(record) : JSON.parse(value.json));
    }
    if (!usable) continue;
    if (chunk.length || !chunks.length) chunks.push(chunk);
    if (sources.length + chunks.length > CACHED_SOURCE_CAPTURE_LIMITS.output_captures) limit("output_captures");

    for (const [index, members] of chunks.entries()) {
      const payload = { ...envelope, partition: { index, count: chunks.length, record_count: members.length },
        records: members };
      const canonical = canonicalAssessmentJson(payload);
      outputBytes += Buffer.byteLength(canonical, "utf8");
      if (outputBytes > limits.output_bytes) limit("output_bytes");
      const digest = createHash("sha256").update(canonical).digest("hex");
      const sourceId = `${metadata.id}:${digest}`;
      const { id: _captureId, ...snapshotMetadata } = metadata;
      sourceSnapshots.push({ id: sourceId, ...snapshotMetadata, content_sha256: digest,
        visibility: "assignment", scope: captureScope });
      sources.push({ id: sourceId, payload });
      routing.source_refs.push(sourceId);
      for (const member of members) routing.record_sources.push({ record_id: member.record_id, source_ref: sourceId });
      yield;
    }
  }
  return deepFreeze({
    status: capabilities.every(item => item.status === "captured") ? "ready" : "incomplete",
    scope: captureScope, source_snapshots: sourceSnapshots, sources, references,
    capability_diagnostics: capabilities,
    capture_policy: "explicit_normalized_projection_assignment_private_no_inferred_completeness_or_history",
  });
}
