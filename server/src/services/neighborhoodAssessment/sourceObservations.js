import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from "./contract.js";
import { finiteNumberOrNull } from "./statistics.js";

/** Cached evidence only: no ingestion, entity resolution, fetch, DB or report writes.
 * Registry paths are explicit local mappings, not asserted provider definitions.
 * The original payload is hashed but only allowlisted mapped values are retained.
 */
export const SOURCE_OBSERVATION_VERSION = 1;
export const SOURCE_OBSERVATION_LIMITS = Object.freeze({ fields: 128, claims: 64, paths: 512, path_depth: 12 });
const ROLES = Object.freeze(["developer", "builder", "contractor", "seller", "owner", "HOA", "manager"]);
const TYPES = Object.freeze({
  role_name: "text", candidate_entity_id: "text", jurisdiction: "text", registered_agent: "text",
  property_id: "text", phase_id: "text", product_id: "text", community_name: "text",
  subdivision_id: "text", plat_id: "text", collection: "text", model: "text", specification: "text",
  new_construction: "boolean", construction_status: "text", permit_number: "text", permit_type: "text",
  permit_applicant: "text", permit_issued_date: "date", completion_date: "date", occupancy_date: "date",
  predecessor_parcel_id: "text", successor_parcel_id: "text", association_id: "text", association_name: "text",
  hoa_membership: "boolean", hoa_mandatory: "boolean", fee_amount: "number", fee_currency: "text",
  fee_frequency: "text", charge_type: "text", included_services: "text_list",
  special_assessment_start: "date", special_assessment_end: "date", amenity_name: "text",
  amenity_access: "boolean", amenity_status: "text", entrance_ref: "text",
  access_start: "date", access_end: "date", operational_date: "date", valid_from: "date", valid_to: "date",
});
export const SOURCE_RESEARCH_CONCEPTS = TYPES;
const SORT = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

function fail(field) { throw new TypeError(`invalid_source_observation:${field}`); }
function object(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(field);
  return value;
}
function text(value, field, maximum = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value; // Original names and identities are never uppercased, trimmed or merged.
}
function choice(value, choices, field) { if (!choices.includes(value)) fail(field); return value; }
function array(value, maximum, field) { if (!Array.isArray(value) || value.length > maximum) fail(field); return value; }
function digest(value, field) { if (typeof value !== "string" || !HASH.test(value)) fail(field); return value; }
function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field);
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function clone(value) { return JSON.parse(canonicalAssessmentJson(value)); }
function exactKeys(value, allowed, field) {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${field}.unknown_key`);
}
function path(value) {
  const result = array(value, SOURCE_OBSERVATION_LIMITS.path_depth, "field.path").map(part => text(part, "field.path", 128));
  if (!result.length || result.some(part => BAD_KEYS.has(part))) fail("field.path");
  return result;
}
function unique(values, field) { if (new Set(values).size !== values.length) fail(`${field}.duplicate`); return values; }
function interval(value, field) {
  exactKeys(value, ["from", "to"], field);
  const from = value.from === null ? null : assessmentDate(value.from, `${field}.from`);
  const to = value.to === null ? null : assessmentDate(value.to, `${field}.to`);
  if (from !== null && to !== null && from > to) fail(`${field}.reversed`);
  return { from, to };
}
function scope(value, visibility) {
  if (visibility === "public") { if (value !== null) fail("scope.public"); return null; }
  const keys = visibility === "organization" ? ["organization_id"]
    : ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
  exactKeys(value, keys, "scope");
  return Object.fromEntries(keys.map(key => {
    const item = text(value[key], `scope.${key}`);
    if (key !== "account_id" && !UUID.test(item)) fail(`scope.${key}`);
    return [key, key === "account_id" ? item : item.toLowerCase()];
  }));
}
function mappedValue(raw, type) {
  if (type === "text") return typeof raw === "string" && raw.trim() && raw.length <= 4096 ? raw : null;
  if (type === "number") return finiteNumberOrNull(raw);
  if (type === "boolean") return typeof raw === "boolean" ? raw : null;
  if (type === "text_list") return Array.isArray(raw) && raw.length <= 64 && raw.every(item =>
    typeof item === "string" && item.trim() && item.length <= 4096) ? raw : null;
  try { return assessmentDate(raw); } catch { return null; }
}
function registryDefinition(value) {
  exactKeys(value, ["id", "version", "provider", "schema_version", "extractor_version", "fields", "claims"], "registry");
  const fields = array(value.fields, SOURCE_OBSERVATION_LIMITS.fields, "registry.fields").map(field => {
    exactKeys(field, ["id", "path", "concept", "value_map"], "registry.field");
    const concept = choice(field.concept, Object.keys(TYPES), "registry.field.concept");
    const valueMap = field.value_map === undefined ? [] : array(field.value_map, 64, "field.value_map").map(entry => {
      exactKeys(entry, ["raw", "value"], "field.value_map.entry");
      if (!["string", "number", "boolean"].includes(typeof entry.raw) || mappedValue(entry.value, TYPES[concept]) === null) fail("field.value_map.type");
      return { raw: clone(entry.raw), value: clone(entry.value) };
    });
    unique(valueMap.map(entry => canonicalAssessmentJson(entry.raw)), "field.value_map");
    valueMap.sort((a, b) => SORT(canonicalAssessmentJson(a.raw), canonicalAssessmentJson(b.raw)));
    return { id: text(field.id, "field.id"), path: path(field.path), concept, value_type: TYPES[concept], value_map: valueMap };
  }).sort((a, b) => SORT(a.id, b.id));
  unique(fields.map(field => field.id), "registry.fields");
  const byId = new Map(fields.map(field => [field.id, field]));
  const claims = array(value.claims, SOURCE_OBSERVATION_LIMITS.claims, "registry.claims").map(claim => {
    exactKeys(claim, ["id", "kind", "role", "attribution", "field_ids", "required_field_ids", "valid_from_field_id", "valid_to_field_id"], "registry.claim");
    const kind = choice(claim.kind, ["role", "development", "construction", "parcel_lineage", "hoa", "charge", "amenity"], "claim.kind");
    const ids = unique(array(claim.field_ids, SOURCE_OBSERVATION_LIMITS.fields, "claim.field_ids").map(id => text(id, "claim.field_ids")), "claim.field_ids").sort(SORT);
    const required = unique(array(claim.required_field_ids, SOURCE_OBSERVATION_LIMITS.fields, "claim.required_field_ids").map(id => text(id, "claim.required_field_ids")), "claim.required_field_ids").sort(SORT);
    if (!required.length || ids.some(id => !byId.has(id)) || required.some(id => !ids.includes(id))) fail("claim.field_references");
    unique(ids.map(id => byId.get(id).concept), "claim.concepts");
    const concepts = new Set(required.map(id => byId.get(id).concept));
    const mandatory = kind === "role" ? ["role_name"] : kind === "parcel_lineage" ? ["predecessor_parcel_id", "successor_parcel_id"]
      : kind === "charge" ? ["fee_amount", "fee_currency", "fee_frequency", "charge_type"] : kind === "amenity" ? ["amenity_name"] : [];
    if (mandatory.some(concept => !concepts.has(concept))) fail("claim.required_concepts");
    if (kind !== "role" && claim.role !== undefined && claim.role !== null) fail("claim.inappropriate_role");
    const validityField = (id, concept) => {
      if (id === undefined || id === null) return null;
      if (!ids.includes(id) || byId.get(id).concept !== concept) fail("claim.validity_field");
      return id;
    };
    return { id: text(claim.id, "claim.id"), kind, role: kind === "role" ? choice(claim.role, ROLES, "claim.role") : null,
      attribution: choice(claim.attribution, ["source_reported", "independently_supported"], "claim.attribution"),
      field_ids: ids, required_field_ids: required,
      valid_from_field_id: validityField(claim.valid_from_field_id, "valid_from"),
      valid_to_field_id: validityField(claim.valid_to_field_id, "valid_to") };
  }).sort((a, b) => SORT(a.id, b.id));
  unique(claims.map(claim => claim.id), "registry.claims");
  return { id: text(value.id, "registry.id"), version: text(value.version, "registry.version"),
    provider: text(value.provider, "registry.provider"), schema_version: text(value.schema_version, "registry.schema_version"),
    extractor_version: text(value.extractor_version, "registry.extractor_version"), fields, claims };
}
function extractField(payload, definition, retention, originPaths) {
  let current = payload, exists = true;
  for (const part of definition.path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) { exists = false; break; }
    current = current[part];
  }
  const inOrigin = originPaths?.has(canonicalAssessmentJson(definition.path));
  if (exists && retention.original_paths !== null && !inOrigin) fail("retention.present_path_unlisted");
  const presence = !exists ? inOrigin || (retention.mode === "projected" && retention.original_paths === null) ? "not_retained" : "absent"
    : current === null || (typeof current === "string" && !current.trim()) ? "blank" : "present";
  const raw = exists ? clone(current) : null;
  if (Buffer.byteLength(canonicalAssessmentJson(raw), "utf8") > 32_768) fail("field.raw_limit");
  const mapEntry = definition.value_map.find(entry => canonicalAssessmentJson(entry.raw) === canonicalAssessmentJson(raw));
  let normalized = presence === "present" ? mappedValue(mapEntry ? mapEntry.value : raw, definition.value_type) : null;
  if (definition.concept === "fee_amount" && normalized !== null && normalized < 0) normalized = null;
  return { id: definition.id, path: definition.path, concept: definition.concept, value_type: definition.value_type,
    presence, raw_value: raw, value: normalized, normalization_status: presence !== "present" ? "missing" : normalized === null ? "invalid" : "supported" };
}

/** A fresh immutable observation; it never rich-merges or modifies older evidence.
 * Correction references must be scope/identity-authorized by the repository caller.
 * Digests identify canonical cached JSON, not unavailable original export bytes.
 */
export function buildSourceObservation(input, mappingRegistry) {
  exactKeys(input, ["source_identity", "provider_version", "schema_version", "extractor_version", "payload", "content_sha256", "original_bytes_sha256",
    "retention", "visibility", "scope", "source_locator", "source_modified_at", "retrieved_at", "fact_validity", "historical_availability", "correction", "contradiction_refs"], "input");
  const registry = registryDefinition(mappingRegistry);
  exactKeys(input.source_identity, ["provider", "source_record_id", "original_record_id"], "source_identity");
  const sourceIdentity = Object.fromEntries(["provider", "source_record_id", "original_record_id"].map(key => [key, text(input.source_identity[key], `source_identity.${key}`, 512)]));
  if (sourceIdentity.provider !== registry.provider || input.schema_version !== registry.schema_version || input.extractor_version !== registry.extractor_version) fail("registry.source_version_mismatch");
  const payload = clone(object(input.payload, "payload"));
  const contentDigest = assessmentEvidenceDigest(payload);
  if (input.content_sha256 !== undefined && digest(input.content_sha256, "content_sha256") !== contentDigest) fail("content_sha256.mismatch");
  exactKeys(input.retention, ["mode", "original_paths"], "retention");
  const retention = { mode: choice(input.retention.mode, ["full", "projected"], "retention.mode"),
    original_paths: input.retention.original_paths === null ? null : array(input.retention.original_paths, SOURCE_OBSERVATION_LIMITS.paths, "retention.original_paths").map(path) };
  if (retention.original_paths) {
    unique(retention.original_paths.map(canonicalAssessmentJson), "retention.original_paths");
    retention.original_paths.sort((a, b) => SORT(canonicalAssessmentJson(a), canonicalAssessmentJson(b)));
  }
  const visibility = choice(input.visibility, ["public", "organization", "assignment"], "visibility");
  const ownerScope = scope(input.scope, visibility);
  const facts = interval(input.fact_validity, "fact_validity");
  const originPaths = retention.original_paths === null ? null : new Set(retention.original_paths.map(canonicalAssessmentJson));
  const fields = registry.fields.map(field => extractField(payload, field, retention, originPaths));
  const byId = new Map(fields.map(field => [field.id, field]));
  const claims = registry.claims.map(definition => {
    const from = definition.valid_from_field_id ? byId.get(definition.valid_from_field_id).value : facts.from;
    const to = definition.valid_to_field_id ? byId.get(definition.valid_to_field_id).value : facts.to;
    const invalidInterval = from !== null && to !== null && from > to;
    const applicableFields = new Set([...definition.required_field_ids, definition.valid_from_field_id, definition.valid_to_field_id].filter(Boolean));
    const missing = [...applicableFields].filter(id => byId.get(id).normalization_status !== "supported").sort(SORT);
    return { id: definition.id, kind: definition.kind, role: definition.role, attribution: definition.attribution,
      entity_resolution: "unresolved", field_ids: definition.field_ids, required_field_ids: definition.required_field_ids,
      fact_validity: { from, to }, status: missing.length || invalidInterval ? "incomplete" : "extracted",
      reasons: [...missing.map(id => `unsupported_field:${id}`), ...(invalidInterval ? ["reversed_fact_interval"] : [])],
      confidence: { status: "not_estimated" }, review_status: "unreviewed" };
  });
  const correction = input.correction === null ? null : (() => {
    exactKeys(input.correction, ["supersedes_observation_sha256", "reason"], "correction");
    return { supersedes_observation_sha256: digest(input.correction.supersedes_observation_sha256, "correction.digest"), reason: text(input.correction.reason, "correction.reason", 4096) };
  })();
  const contradictions = unique(array(input.contradiction_refs, 128, "contradiction_refs").map(item => text(item, "contradiction_refs", 512)), "contradiction_refs").sort(SORT);
  const result = { observation_version: SOURCE_OBSERVATION_VERSION, source_identity: sourceIdentity,
    source_identity_sha256: assessmentEvidenceDigest(sourceIdentity), provider_version: text(input.provider_version, "provider_version"),
    schema_version: registry.schema_version, extractor_version: registry.extractor_version, registry_id: registry.id, registry_version: registry.version,
    registry_sha256: assessmentEvidenceDigest(registry), content_sha256: contentDigest,
    original_bytes_sha256: input.original_bytes_sha256 === undefined || input.original_bytes_sha256 === null ? null : digest(input.original_bytes_sha256, "original_bytes_sha256"),
    retention, visibility, scope: ownerScope, source_locator: text(input.source_locator, "source_locator", 4096),
    source_modified_at: input.source_modified_at === null ? null : timestamp(input.source_modified_at, "source_modified_at"),
    retrieved_at: timestamp(input.retrieved_at, "retrieved_at"), fact_validity: facts,
    historical_availability: choice(input.historical_availability, ["contemporaneous", "reconstructed", "unknown"], "historical_availability"),
    correction, contradiction_refs: contradictions, fields, claims };
  if (result.source_modified_at !== null && result.source_modified_at > result.retrieved_at) fail("source_modified_at.after_retrieval");
  // Re-extracting the same cached content is deduplicable without rewriting its
  // first retrieval evidence. Scope and every interpretation/version remain bound.
  const { retrieved_at: _retrievedAt, ...extractionIdentity } = result;
  result.extraction_key_sha256 = assessmentEvidenceDigest(extractionIdentity);
  const sha = assessmentEvidenceDigest(result);
  return freeze({ ...result, id: sha, observation_sha256: sha });
}

/** Applicability is evidence availability, not HOA membership or appraiser approval.
 * Later retrieval of reconstructed historical facts is permitted and disclosed.
 */
export function evaluateSourceObservationAtDate(observation, effectiveDate) {
  const date = assessmentDate(effectiveDate);
  const { id, observation_sha256: sha, ...evidence } = observation;
  if (id !== sha || digest(sha, "observation_sha256") !== assessmentEvidenceDigest(evidence)) fail("observation.digest_mismatch");
  const results = observation.claims.map(claim => {
    const validity = claim.fact_validity;
    const state = claim.status !== "extracted" || validity.from === null || observation.historical_availability === "unknown" ? "unknown"
      : date < validity.from || (validity.to !== null && date > validity.to) ? "not_applicable"
      : observation.historical_availability === "contemporaneous" && observation.retrieved_at.slice(0, 10) > date ? "unknown" : "applicable";
    return { claim_id: claim.id, state, review_status: claim.review_status, later_retrieved: observation.retrieved_at.slice(0, 10) > date };
  });
  return freeze({ observation_sha256: sha, effective_date: date, claims: results });
}
