import { types as nodeTypes } from "node:util";

import { canonicalAssessmentJson } from "../../services/neighborhoodAssessment/contract.js";
import { validateCompleteSection } from "./editor.js";
import { getUadField, validateUadSectionValues } from "./fieldCatalog.js";
import { UAD_MARKET_FIELD_KEYS } from "./marketCatalog.js";
import { prepareUadNeighborhoodApply } from "./neighborhoodReview.js";

// Dormant, pure SERVER-RESOLVED input seam. Completeness/provenance declarations
// cannot prove a database load, authorization, producer authority, or a commit.
// Do not wire browser input directly here or use autosave to persist this plan.
const INPUT_KEYS = ["assessment", "target", "market_context", "existing_values", "request", "accepted_receipt", "canonical_state"];
const STATE_KEYS = ["state_version", "workfile_id", "editor_revision", "complete", "rows", "entities", "assets"];
const REQUEST_KEYS = ["confirmed", "preserve_existing", "expected_candidate_digest_sha256",
  "expected_binding_digest_sha256", "expected_revision", "selected_suggestion_ids"];
const TARGET_KEYS = Object.freeze([
  "market:3000.0008", "market:3000.0010", "market:3000.0009",
  UAD_MARKET_FIELD_KEYS.salesCount, UAD_MARKET_FIELD_KEYS.salesLowestPrice,
  UAD_MARKET_FIELD_KEYS.salesMedianPrice, UAD_MARKET_FIELD_KEYS.salesHighestPrice,
]);
const TARGET_SET = new Set(TARGET_KEYS);
// New-seam computation guards, not limits on existing public saves or UAD rules.
const CANONICAL_LIMITS = Object.freeze({ nodes: 500_000, depth: 40, bytes: 32 * 1024 * 1024 });
const EVIDENCE_LIMITS = Object.freeze({ nodes: 100_000, depth: 40, bytes: 1_500_000 });
const OUTPUT_LIMITS = Object.freeze({ nodes: 1_000_000, depth: 50, bytes: 64 * 1024 * 1024 });

class InputConflict extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireThat = (condition, code = "invalid_neighborhood_validation_input") => {
  if (!condition) throw new InputConflict(code);
};
const budgetFor = limits => ({ ...limits, visited: 0, usedBytes: 0 });

function chargeText(budget, string) {
  budget.usedBytes += Buffer.byteLength(string, "utf8");
  requireThat(budget.usedBytes <= budget.bytes, "neighborhood_validation_input_limit");
}

function charge(budget, depth, string = null) {
  requireThat(++budget.visited <= budget.nodes && depth <= budget.depth, "neighborhood_validation_input_limit");
  if (string !== null) chargeText(budget, string);
}

// Inspect descriptors, never values through caller getters/iterators/toJSON.
// Proxies (including revoked proxies) must be detected before ANY reflection.
function inspect(value, maximumKeys = 500_001) {
  requireThat(value !== null && typeof value === "object" && !nodeTypes.isProxy(value));
  const array = Array.isArray(value);
  requireThat(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype));
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    requireThat(Number.isSafeInteger(length) && length < maximumKeys, "neighborhood_validation_input_limit");
  }
  const keys = Reflect.ownKeys(value);
  requireThat(keys.length <= maximumKeys, "neighborhood_validation_input_limit");
  const properties = new Map();
  for (const key of keys) {
    requireThat(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(descriptor && Object.hasOwn(descriptor, "value") &&
      (descriptor.enumerable || (array && key === "length")) &&
      typeof descriptor.value !== "function" && typeof descriptor.value !== "symbol");
    properties.set(key, descriptor.value);
  }
  return { array, properties };
}

function exactRecord(value, keys) {
  const { array, properties } = inspect(value, keys.length);
  requireThat(!array && properties.size === keys.length && keys.every(key => properties.has(key)));
  return properties;
}

function define(object, key, value) {
  // Assignment to __proto__ on {} would invoke the inherited setter.
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function copyJson(value, budget, depth = 0, ancestors = new Set()) {
  charge(budget, depth, typeof value === "string" ? value : null);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") { requireThat(Number.isFinite(value)); return value; }
  requireThat(value !== null && typeof value === "object" && !ancestors.has(value));
  const { array, properties } = inspect(value, budget.nodes - budget.visited + 2);
  ancestors.add(value);
  const output = array ? [] : {};
  if (array) {
    const length = properties.get("length");
    requireThat(properties.size === length + 1);
    for (let index = 0; index < length; index++) {
      requireThat(properties.has(String(index)));
      output.push(copyJson(properties.get(String(index)), budget, depth + 1, ancestors));
    }
  } else {
    for (const [key, child] of properties) {
      chargeText(budget, key);
      define(output, key, copyJson(child, budget, depth + 1, ancestors));
    }
  }
  ancestors.delete(value);
  return output;
}

function projectRecord(value, requiredKeys, optionalKeys, budget) {
  // Unused PG Date metadata is deliberately not recursively copied. Accessors
  // and executable properties in its record container are still rejected.
  const { array, properties } = inspect(value, 256);
  requireThat(!array && requiredKeys.every(key => properties.has(key)));
  charge(budget, 2);
  const output = {};
  for (const key of [...requiredKeys, ...optionalKeys]) {
    if (!properties.has(key)) continue;
    chargeText(budget, key);
    define(output, key, copyJson(properties.get(key), budget, 3));
  }
  return output;
}

function projectCollection(value, maximum, requiredKeys, optionalKeys, budget) {
  const { array, properties } = inspect(value, maximum + 1);
  requireThat(array);
  const length = properties.get("length");
  requireThat(properties.size === length + 1);
  charge(budget, 1);
  const output = [];
  for (let index = 0; index < length; index++) {
    requireThat(properties.has(String(index)));
    output.push(projectRecord(properties.get(String(index)), requiredKeys, optionalKeys, budget));
  }
  return output;
}

const nonemptyString = value => typeof value === "string" && value.length > 0 && value.trim() === value;

function canonicalState(input, target) {
  const state = exactRecord(input, STATE_KEYS);
  requireThat(state.get("state_version") === 1 && state.get("complete") === true &&
    nonemptyString(state.get("workfile_id")) && state.get("workfile_id") === target.uad_workfile_id &&
    Number.isSafeInteger(state.get("editor_revision")) && state.get("editor_revision") >= 0 &&
    state.get("editor_revision") === target.editor_revision, "incomplete_neighborhood_canonical_state");
  const budget = budgetFor(CANONICAL_LIMITS);
  const rows = projectCollection(state.get("rows"), 20_000,
    ["workfile_id", "entity_id", "field_context", "uad_uid", "value"], [], budget);
  const entities = projectCollection(state.get("entities"), 5_000,
    ["workfile_id", "id", "entity_type", "data"], [], budget);
  const assets = projectCollection(state.get("assets"), 10_000,
    ["section_number", "status", "caption_type", "content_type"], ["workfile_id", "id"], budget);
  for (const row of rows) {
    requireThat(row.workfile_id === target.uad_workfile_id && nonemptyString(row.field_context) &&
      nonemptyString(row.uad_uid) && (row.entity_id === null || nonemptyString(row.entity_id)),
    "invalid_neighborhood_canonical_row");
  }
  for (const entity of entities) {
    requireThat(entity.workfile_id === target.uad_workfile_id && nonemptyString(entity.id) &&
      nonemptyString(entity.entity_type), "invalid_neighborhood_canonical_entity");
  }
  for (const asset of assets) {
    requireThat((!Object.hasOwn(asset, "workfile_id") || asset.workfile_id === target.uad_workfile_id) &&
      (asset.section_number === null || Number.isInteger(asset.section_number)) &&
      typeof asset.status === "string" && (asset.caption_type === null || typeof asset.caption_type === "string") &&
      typeof asset.content_type === "string", "invalid_neighborhood_canonical_asset");
  }
  return { rows, entities, assets };
}

function validateOccupancy(rows, occupancy) {
  requireThat(Array.isArray(occupancy) && occupancy.length === TARGET_KEYS.length, "invalid_neighborhood_canonical_occupancy");
  const slots = new Map();
  for (const slot of occupancy) {
    requireThat(slot && TARGET_SET.has(slot.target_key) && !slots.has(slot.target_key) && slot.target_exists === true &&
      ((slot.populated === false && slot.value === null) ||
        (slot.populated === true && slot.value !== null && slot.value !== undefined)),
    "invalid_neighborhood_canonical_occupancy");
    slots.set(slot.target_key, slot);
  }
  const values = new Map();
  for (const row of rows) {
    const key = `${row.field_context}:${row.uad_uid}`;
    if (!TARGET_SET.has(key)) continue;
    requireThat(row.entity_id === null && !values.has(key), "invalid_neighborhood_canonical_occupancy");
    values.set(key, row.value);
  }
  for (const key of TARGET_KEYS) {
    const slot = slots.get(key);
    const value = values.has(key) ? values.get(key) : null;
    requireThat(slot.populated === (value !== null) && (value === null ||
      ((typeof value === "string" || typeof value === "number") && typeof slot.value === typeof value &&
        canonicalAssessmentJson(value) === canonicalAssessmentJson(slot.value))),
    "changed_neighborhood_canonical_occupancy");
  }
}

function freezeOwned(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

function conflict(conflicts) {
  return freezeOwned(copyJson({ validation_version: 1, status: "conflict", http_status: 409, conflicts,
    candidate_digest_sha256: null, acceptance_manifest: null, writes: [], normalized_writes: [],
    normalized_final_members: [], final_slots: [], section_findings: null }, budgetFor(OUTPUT_LIMITS)));
}

/** Pure preparation, not acceptance or persistence. All arguments except request
 * require trusted server resolution. The explicit complete snapshot declaration
 * is checked for consistency but cannot authenticate its own claimed authority.
 */
export function prepareUadNeighborhoodSectionValidation(input) {
  try {
    const properties = exactRecord(input, INPUT_KEYS);
    const preparedInput = {};
    for (const key of INPUT_KEYS.filter(key => key !== "canonical_state")) {
      define(preparedInput, key, copyJson(properties.get(key), budgetFor(EVIDENCE_LIMITS)));
    }
    exactRecord(preparedInput.request, REQUEST_KEYS);
    const state = canonicalState(properties.get("canonical_state"), preparedInput.target);
    validateOccupancy(state.rows, preparedInput.existing_values);
    // Do not rebuild a public prospective candidate on the saved-receipt path.
    const plan = prepareUadNeighborhoodApply(preparedInput);
    if (plan.status === "conflict") return conflict(plan.conflicts);
    requireThat(["ready", "already_applied"].includes(plan.status) && plan.conflicts.length === 0);
    const members = [...plan.acceptance_manifest.applied, ...plan.acceptance_manifest.reused];
    const submitted = members.map(member => {
      requireThat(TARGET_SET.has(member.target_key));
      const [context_key, uid] = member.target_key.split(":");
      return { context_key, uid, entity_id: null, value: member.value };
    });
    const checked = validateUadSectionValues("market", submitted, { allowIncomplete: false });
    requireThat(checked.errors.length === 0 && checked.normalized.length === members.length,
      "invalid_neighborhood_catalog_group");
    const normalized = checked.normalized.map((item, index) => {
      requireThat(item.entityId === null && item.field === getUadField(submitted[index].context_key, submitted[index].uid) &&
        item.field.key === members[index].target_key && Object.is(item.value, members[index].value),
      "changed_neighborhood_catalog_value");
      return { context_key: item.field.contextKey, uid: item.field.uid, entity_id: null, value: item.value };
    });
    const byTarget = new Map(normalized.map(item => [`${item.context_key}:${item.uid}`, item]));
    const normalizedWrites = plan.writes.map(write => {
      const member = members.find(item => item.id === write.id && item.target_key === write.target_key && Object.is(item.value, write.value));
      requireThat(member && byTarget.has(write.target_key), "invalid_neighborhood_write_subset");
      return byTarget.get(write.target_key);
    });
    requireThat(plan.status !== "already_applied" || normalizedWrites.length === 0, "invalid_neighborhood_replay_writes");
    const finalSlots = TARGET_KEYS.map(key => ({ target_key: key, populated: byTarget.has(key),
      value: byTarget.has(key) ? byTarget.get(key).value : null }));
    const findings = validateCompleteSection("market", state.rows, checked.normalized, state.entities, state.assets);
    // Copy before freezing: no caller row, prepared object or shared catalog
    // definition becomes frozen through a returned reference. No field objects
    // (and therefore no catalog predicates) escape in these data-only outputs.
    return freezeOwned(copyJson({ validation_version: 1, status: plan.status, http_status: plan.http_status ?? 200,
      conflicts: [], candidate_digest_sha256: plan.candidate_digest_sha256,
      acceptance_manifest: plan.acceptance_manifest, writes: plan.writes, normalized_writes: normalizedWrites,
      normalized_final_members: normalized, final_slots: finalSlots, section_findings: findings }, budgetFor(OUTPUT_LIMITS)));
  } catch (error) {
    return conflict([{ code: !nodeTypes.isProxy(error) && error instanceof InputConflict
      ? error.code : "invalid_neighborhood_validation_input" }]);
  }
}
