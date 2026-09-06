import { assessmentDate, canonicalAssessmentJson } from "./contract.js";
import { assertNeighborhoodJsonbStorage } from "./jsonbStorage.js";

export const COHORT_DECISION_COMMAND_VERSION = 1;
export const COHORT_DECISION_COMMAND_LIMITS = Object.freeze({
  input_bytes: 64_000,
  input_nodes: 10_000,
  input_depth: 16,
  evidence_references: 64,
  decision_references: 64,
  list_items: 64,
  rationale_bytes: 2_000,
  output_bytes: 65_536,
  output_nodes: 10_032,
  output_depth: 17,
  opaque_bytes: 200,
  decimal_bytes: 200,
  timestamp_fraction_digits: 9,
});

const LIMITS = COHORT_DECISION_COMMAND_LIMITS;
// Matches the existing private core UUID primitive without importing a runtime
// report/workfile module or adopting its coercing, versions-1-to-5 helper.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const BIGINT_MAX = "9223372036854775807";
const UNKNOWN_REASONS = new Set([
  "missing_evidence", "conflicting_evidence", "unsupported_source_meaning",
  "incomplete_membership", "unresolved_equivalence", "unsupported_temporal_basis",
  "unreviewed_material_condition", "unsupported_mapping",
]);
const VALUE_KEYS = Object.freeze({
  sale_completion: ["completed", "event_evidence_refs"],
  closing_date: ["date", "event_evidence_refs"],
  recorded_consideration: ["currency", "amount_decimal", "meaning", "interest_scope_refs"],
  economic_property_membership: ["economic_property_key", "interest_members", "completeness_evidence_refs"],
  transaction_equivalence: ["canonical_event_key", "candidate_keys", "equivalence_evidence_refs"],
  housing_at_date: ["evaluated_on", "housing_code", "housing_catalog_id", "housing_catalog_revision", "temporal_support"],
  completed_home_at_closing: ["closing_date", "completed_home", "temporal_support"],
  material_condition: ["condition_code", "present", "condition_evidence_refs"],
  study_fitness_review: ["conclusion", "required_fact_refs", "condition_review_refs"],
});
const COMMAND_KEYS = [
  "version", "operation_id", "target_ref", "expected_context", "study_ref",
  "expected_generation", "expected_predecessor", "subject_ref", "claim",
  "evidence_refs", "rationale",
];
const EVIDENCE_KEYS = [
  "capture_id", "capture_revision", "manifest_sha256", "chunk_id",
  "chunk_sha256", "record_key", "record_content_sha256",
];
const privateFailures = new WeakMap();

function stop(reason, status = "invalid") {
  const error = new Error("cohort_command_admission_failed");
  privateFailures.set(error, Object.freeze({ status, reason }));
  throw error;
}

function limit(reason) { stop(reason, "limit_exceeded"); }
function own(value, key) { return Object.hasOwn(value, key); }

function record(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) stop("invalid_shape");
}

function closed(value, keys) {
  record(value);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(key => own(value, key))) stop("invalid_shape");
}

function unicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0) stop("invalid_unicode");
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) stop("invalid_unicode");
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) stop("invalid_unicode");
  }
}

// Only traverses fresh JSON.parse output, never a caller-owned object. This
// admission runs before any stringify/canonicalizer can recurse over the tree.
function walk(value, maxNodes, maxDepth, output = false) {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > maxNodes) limit(output ? "output_limit" : "input_nodes");
    if (item.depth > maxDepth) limit(output ? "output_limit" : "input_depth");
    const current = item.value;
    if (typeof current === "string") unicode(current);
    else if (typeof current === "number") {
      if (!Number.isFinite(current)) stop("invalid_value");
    } else if (current !== null && typeof current === "object") {
      const keys = Object.keys(current);
      for (const key of keys) unicode(key);
      // All siblings will count as value nodes. Refuse before growing a stack
      // beyond the admitted work budget, even for a very wide invalid object.
      if (nodes + pending.length + keys.length > maxNodes) limit(output ? "output_limit" : "input_nodes");
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        pending.push({ value: current[keys[i]], depth: item.depth + 1 });
      }
    }
  }
}

function string(value) {
  if (typeof value !== "string") stop("invalid_value");
}

function opaque(value) {
  string(value);
  if (!value.length || Buffer.byteLength(value, "utf8") > LIMITS.opaque_bytes) stop("invalid_value");
}

function digest(value) {
  string(value);
  if (!SHA256.test(value)) stop("invalid_value");
}

function intText(value, positive = false) {
  string(value);
  if (value.length > BIGINT_MAX.length || !/^(?:0|[1-9][0-9]*)$/.test(value)
      || (value.length === BIGINT_MAX.length && value > BIGINT_MAX)
      || (positive && value === "0")) stop("invalid_value");
}

function date(value) {
  try { assessmentDate(value); } catch { stop("invalid_value"); }
}

function instant(value) {
  string(value);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.([0-9]{1,9}))?Z$/.exec(value);
  if (!match) stop("invalid_value");
  date(match[1]);
  if (match[2] > "23" || match[3] > "59" || match[4] > "59") stop("invalid_value");
  // Fractional digits are never converted to Date/Number or rounded.
}

function boolean(value) { if (typeof value !== "boolean") stop("invalid_value"); }
function choice(value, allowed) { if (!allowed.includes(value)) stop("invalid_value"); }

function list(value, minimum = 0) {
  if (!Array.isArray(value)) stop("invalid_shape");
  if (value.length > LIMITS.list_items) limit("list_limit");
  if (value.length < minimum) stop("invalid_value");
  return value;
}

function validateCommand(command) {
  const uuidSlots = [];
  const allEvidence = [];
  const allDecisions = [];
  const evidenceLists = [];
  const decisionLists = [];
  const nestedDecisions = [];
  const interestLists = [];

  const uuidAt = (object, key) => {
    const value = object[key];
    if (typeof value !== "string" || !UUID.test(value)) stop("invalid_value");
    uuidSlots.push([object, key]);
  };
  const evidence = value => {
    // Charge every representation, including a repeated supporting source.
    if (allEvidence.length >= LIMITS.evidence_references) limit("reference_limit");
    allEvidence.push(value);
    closed(value, EVIDENCE_KEYS);
    opaque(value.capture_id); opaque(value.capture_revision); digest(value.manifest_sha256);
    opaque(value.chunk_id); digest(value.chunk_sha256); opaque(value.record_key);
    digest(value.record_content_sha256);
  };
  const evidenceList = values => {
    list(values);
    if (allEvidence.length + values.length > LIMITS.evidence_references) limit("reference_limit");
    evidenceLists.push(values);
    for (const value of values) evidence(value);
  };
  const decision = value => {
    if (allDecisions.length >= LIMITS.decision_references) limit("reference_limit");
    allDecisions.push(value);
    closed(value, ["decision_id", "decision_sha256"]);
    uuidAt(value, "decision_id"); digest(value.decision_sha256);
  };
  const decisionList = (values, nested = false) => {
    list(values);
    if (allDecisions.length + values.length > LIMITS.decision_references) limit("reference_limit");
    decisionLists.push(values);
    for (const value of values) {
      decision(value);
      if (nested) nestedDecisions.push(value);
    }
  };
  const interests = (values, membership) => {
    list(values, 1);
    interestLists.push(values);
    for (const item of values) {
      closed(item, membership ? ["interest_key", "source_ref", "cad_link"] : ["interest_key", "source_ref"]);
      opaque(item.interest_key); evidence(item.source_ref);
      if (membership && item.cad_link !== null) {
        closed(item.cad_link, ["provider_key", "jurisdiction_key", "account_id", "mapping_evidence_ref"]);
        opaque(item.cad_link.provider_key); opaque(item.cad_link.jurisdiction_key);
        opaque(item.cad_link.account_id); evidence(item.cad_link.mapping_evidence_ref);
      }
    }
  };
  const temporal = value => {
    closed(value, ["basis", "valid_from", "valid_through", "observed_at", "captured_at", "available_at", "evidence_refs"]);
    choice(value.basis, ["contemporaneous", "reconstructed", "current_only"]);
    if (value.valid_from !== null) date(value.valid_from);
    if (value.valid_through !== null) date(value.valid_through);
    if (value.valid_from !== null && value.valid_through !== null && value.valid_from > value.valid_through) stop("invalid_value");
    for (const key of ["observed_at", "captured_at", "available_at"]) {
      if (value[key] !== null) instant(value[key]);
    }
    evidenceList(value.evidence_refs);
  };

  closed(command, COMMAND_KEYS);
  uuidAt(command, "operation_id");
  closed(command.target_ref, ["report_file_id", "workflow_type", "workflow_target_id"]);
  uuidAt(command.target_ref, "report_file_id");
  choice(command.target_ref.workflow_type, ["custom_appraisal", "uad_3_6"]);
  if (command.target_ref.workflow_type === "custom_appraisal") intText(command.target_ref.workflow_target_id, true);
  else uuidAt(command.target_ref, "workflow_target_id");
  closed(command.expected_context, ["context_id", "context_revision", "context_sha256"]);
  uuidAt(command.expected_context, "context_id");
  intText(command.expected_context.context_revision, true); digest(command.expected_context.context_sha256);
  closed(command.study_ref, ["study_id", "definition_revision", "definition_sha256"]);
  uuidAt(command.study_ref, "study_id");
  intText(command.study_ref.definition_revision, true); digest(command.study_ref.definition_sha256);
  intText(command.expected_generation);
  if (command.expected_predecessor !== null) decision(command.expected_predecessor);
  closed(command.subject_ref, ["kind", "key"]);
  choice(command.subject_ref.kind, ["capture_candidate", "stock_member"]); opaque(command.subject_ref.key);
  string(command.rationale);
  if (Buffer.byteLength(command.rationale, "utf8") > LIMITS.rationale_bytes) limit("rationale_limit");
  if (!command.rationale.trim()) stop("invalid_value");
  evidenceList(command.evidence_refs);

  const claim = command.claim;
  closed(claim, ["kind", "qualifier", "state", "value", "unknown_reason", "decision_refs"]);
  if (typeof claim.kind !== "string" || !own(VALUE_KEYS, claim.kind)) stop("invalid_value");
  choice(claim.state, ["known", "unknown"]);
  decisionList(claim.decision_refs);
  const qualifier = claim.qualifier;
  if (claim.kind === "housing_at_date") {
    closed(qualifier, ["basis", "evaluated_on"]);
    choice(qualifier.basis, ["evaluated_date"]); date(qualifier.evaluated_on);
  } else if (claim.kind === "material_condition") {
    closed(qualifier, ["basis", "condition_code"]);
    choice(qualifier.basis, ["condition"]); opaque(qualifier.condition_code);
  } else {
    closed(qualifier, ["basis"]);
    const basis = claim.kind === "completed_home_at_closing" ? "closing_event"
      : claim.kind === "study_fitness_review" ? "named_study" : "event";
    choice(qualifier.basis, [basis]);
  }
  if (claim.state === "unknown") {
    if (claim.value !== null || !UNKNOWN_REASONS.has(claim.unknown_reason)) stop("invalid_value");
  } else {
    if (claim.unknown_reason !== null) stop("invalid_value");
    const value = claim.value;
    closed(value, VALUE_KEYS[claim.kind]);
    switch (claim.kind) {
      case "sale_completion":
        boolean(value.completed); evidenceList(value.event_evidence_refs); break;
      case "closing_date":
        date(value.date); evidenceList(value.event_evidence_refs); break;
      case "recorded_consideration":
        if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) stop("invalid_value");
        string(value.amount_decimal);
        if (Buffer.byteLength(value.amount_decimal, "utf8") > LIMITS.decimal_bytes
            || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.amount_decimal)
            || !/[1-9]/.test(value.amount_decimal)) stop("invalid_value");
        choice(value.meaning, ["recorded_total_sale_price"]);
        interests(value.interest_scope_refs, false); break;
      case "economic_property_membership":
        opaque(value.economic_property_key); interests(value.interest_members, true);
        evidenceList(value.completeness_evidence_refs); break;
      case "transaction_equivalence":
        opaque(value.canonical_event_key); list(value.candidate_keys, 1);
        for (const key of value.candidate_keys) opaque(key);
        evidenceList(value.equivalence_evidence_refs); break;
      case "housing_at_date":
        date(value.evaluated_on); opaque(value.housing_code); opaque(value.housing_catalog_id);
        opaque(value.housing_catalog_revision); temporal(value.temporal_support); break;
      case "completed_home_at_closing":
        date(value.closing_date); boolean(value.completed_home); temporal(value.temporal_support); break;
      case "material_condition":
        opaque(value.condition_code); boolean(value.present); evidenceList(value.condition_evidence_refs); break;
      case "study_fitness_review":
        choice(value.conclusion, ["compatible", "incompatible"]);
        decisionList(value.required_fact_refs, true); decisionList(value.condition_review_refs, true); break;
      default: stop("invalid_value");
    }
  }

  // All raw occurrences and primitive types have been admitted. Only UUIDs
  // normalize; source keys, decimal scale, timestamp precision and order do not.
  for (const [object, key] of uuidSlots) object[key] = object[key].toLowerCase();
  const tuple = parts => JSON.stringify(parts);
  const evidenceKey = ref => tuple(EVIDENCE_KEYS.map(key => ref[key]));
  const decisionKey = ref => tuple([ref.decision_id, ref.decision_sha256]);
  const address = ref => [ref.capture_id, ref.capture_revision, ref.chunk_id, ref.record_key];
  const manifests = new Map(), chunks = new Map(), records = new Map(), decisions = new Map();
  const consistent = (map, key, value) => {
    if (map.has(key) && map.get(key) !== value) stop("reference_conflict");
    map.set(key, value);
  };
  for (const ref of allEvidence) {
    consistent(manifests, tuple([ref.capture_id, ref.capture_revision]), ref.manifest_sha256);
    consistent(chunks, tuple([ref.capture_id, ref.capture_revision, ref.chunk_id]), ref.chunk_sha256);
    consistent(records, tuple(address(ref)), ref.record_content_sha256);
  }
  for (const ref of allDecisions) consistent(decisions, ref.decision_id, ref.decision_sha256);
  const unique = (values, keyOf) => {
    const seen = new Set();
    for (const value of values) {
      const key = keyOf(value);
      if (seen.has(key)) stop("duplicate_reference");
      seen.add(key);
    }
  };
  for (const values of evidenceLists) unique(values, evidenceKey);
  for (const values of decisionLists) unique(values, decisionKey);
  for (const values of interestLists) unique(values, value => tuple([...address(value.source_ref), value.interest_key]));
  const rootEvidence = new Set(command.evidence_refs.map(evidenceKey));
  if (allEvidence.some(ref => !rootEvidence.has(evidenceKey(ref)))) stop("unclosed_reference");
  const rootDecisions = new Set(claim.decision_refs.map(decisionKey));
  if (nestedDecisions.some(ref => !rootDecisions.has(decisionKey(ref)))) stop("unclosed_reference");

  const expectedSubject = claim.kind === "housing_at_date" ? "stock_member" : "capture_candidate";
  if (command.subject_ref.kind !== expectedSubject) stop("subject_claim_mismatch");
  if (claim.state === "known") {
    if (claim.kind === "housing_at_date" && claim.value.evaluated_on !== qualifier.evaluated_on) stop("qualifier_value_mismatch");
    if (claim.kind === "material_condition" && claim.value.condition_code !== qualifier.condition_code) stop("qualifier_value_mismatch");
    if (claim.kind === "transaction_equivalence") {
      unique(claim.value.candidate_keys, key => key);
      if (!claim.value.candidate_keys.includes(command.subject_ref.key)) stop("subject_claim_mismatch");
    }
  }
  return command;
}

function freeze(value) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
  return value;
}

/**
 * Validates only the exact supplied primitive JSON string. Reserializing an
 * already parsed HTTP body cannot establish integrity of its original bytes.
 * A valid structure grants no catalog/source/issuer/current-use authority.
 */
export function prepareCohortDecisionCommandV1(inputJson) {
  try {
    if (typeof inputJson !== "string") stop("invalid_input_type");
    if (Buffer.byteLength(inputJson, "utf8") > LIMITS.input_bytes) limit("input_bytes");
    let input;
    try { input = JSON.parse(inputJson); } catch { stop("invalid_json"); }
    walk(input, LIMITS.input_nodes, LIMITS.input_depth);
    if (JSON.stringify(input) !== inputJson) stop("noncanonical_json");
    record(input);
    if (!own(input, "version") || !Number.isSafeInteger(input.version) || input.version < 1) stop("invalid_shape");
    if (input.version !== COHORT_DECISION_COMMAND_VERSION) stop("unsupported_version", "unsupported");
    const admitted = validateCommand(input);
    // Both helpers operate on the detached, fully bounded JSON tree, not on a
    // hostile caller object. Storage bytes are not the canonical hash preimage.
    assertNeighborhoodJsonbStorage(admitted);
    const command = JSON.parse(canonicalAssessmentJson(admitted));
    const result = {
      status: "syntax_valid",
      grammar_version: COHORT_DECISION_COMMAND_VERSION,
      validation_scope: "structure_only",
      authority: "not_established",
      command,
    };
    walk(result, LIMITS.output_nodes, LIMITS.output_depth, true);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > LIMITS.output_bytes) limit("output_limit");
    return freeze(result);
  } catch (error) {
    return privateFailures.get(error) ?? Object.freeze({ status: "invalid", reason: "invalid_shape" });
  }
}
