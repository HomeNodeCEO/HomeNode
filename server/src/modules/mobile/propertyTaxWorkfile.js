import { canonicalJson } from "./sync.js";

const MAX_WORKFILE_BYTES = 256 * 1024;
const MAX_COMPARABLE_ROWS = 40;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function invalid() {
  throw new Error("invalid_property_tax_protest_workfile");
}

function exactObject(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some((key) => UNSAFE_KEYS.has(key) || !allowed.has(key))) {
    invalid();
  }
}

function text(maximum, { required = false } = {}) {
  return (value) => {
    if (typeof value !== "string") invalid();
    const normalized = value.trim();
    if ((required && !normalized) || normalized.length > maximum) invalid();
    return normalized;
  };
}

function enumeration(values) {
  const allowed = new Set(values);
  return (value) => {
    if (!allowed.has(value)) invalid();
    return value;
  };
}

function number({ integer = false, minimum = null, maximum = null, nullable = false } = {}) {
  return (value) => {
    if (nullable && value === null) return null;
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || (integer && !Number.isInteger(normalized))) invalid();
    if ((minimum !== null && normalized < minimum) || (maximum !== null && normalized > maximum)) invalid();
    return Object.is(normalized, -0) ? 0 : normalized;
  };
}

function boolean(value) {
  if (value !== true && value !== false) invalid();
  return value;
}

function dateOnly(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) invalid();
  return value;
}

const FIELD_POLICIES = Object.freeze({
  protest_case: Object.freeze({
    district_code: enumeration(["tx-dallas-cad"]),
    property_use: enumeration(["single_family_residential"]),
    notice_date: dateOnly,
    protest_deadline: dateOnly,
    market_value_ground: enumeration(["yes", "no"]),
    unequal_appraisal_ground: enumeration(["yes", "no"]),
    protest_status: enumeration(["not_started", "prepared", "filed", "scheduled", "settled", "complete"]),
    filing_method: enumeration(["ufile", "mail", "dropbox", "in_person"]),
    protest_filed_at: dateOnly,
    filing_receipt_reference: text(1_000),
    hearing_date: dateOnly,
    evidence_request_status: enumeration(["not_started", "prepared", "sent", "received"]),
    evidence_request_sent_at: dateOnly,
    evidence_request_method: enumeration(["mail", "portal", "in_person", "other_documented"]),
    evidence_request_proof_reference: text(1_000),
    district_evidence_received_at: dateOnly,
  }),
  subject: Object.freeze({
    condition_rating: enumeration(["C1", "C2-C1", "C2", "C3-C2", "C3", "C4-C3", "C4", "C5-C4", "C5", "C6-C5", "C6"]),
    quality_rating: enumeration(["Q1", "Q2-Q1", "Q2", "Q3-Q2", "Q3", "Q4-Q3", "Q4", "Q5-Q4", "Q5", "Q6-Q5", "Q6"]),
    district_neighborhood_code: text(200),
    district_building_class: text(200),
    historic_district_name: text(500),
    living_area_sqft: number({ integer: true, minimum: 0, maximum: 1_000_000 }),
    site_size_sqft: number({ minimum: 0, maximum: 1_000_000_000 }),
    age_years: number({ integer: true, minimum: 0, maximum: 500 }),
    bedroom_count: number({ integer: true, minimum: 0, maximum: 100 }),
    bath_count: number({ minimum: 0, maximum: 100 }),
    garage_spaces: number({ minimum: 0, maximum: 100 }),
    pool: enumeration(["yes", "no"]),
    solar_panels: enumeration(["yes", "no"]),
    condition_notes: text(5_000),
  }),
  condition: Object.freeze({
    defects_deferred_maintenance: text(5_000),
    repair_cost_to_cure: number({ minimum: 0, maximum: 1_000_000_000 }),
    repair_cost_to_cure_notes: text(5_000),
  }),
  valuation: Object.freeze({
    tax_year: number({ integer: true, minimum: 2000, maximum: 2200 }),
    district_appraised_value: number({ minimum: 0, maximum: 10_000_000_000 }),
    requested_market_value: number({ minimum: 0, maximum: 10_000_000_000 }),
    appraiser_opinion_of_value: number({ minimum: 0, maximum: 10_000_000_000 }),
  }),
  analysis: Object.freeze({
    sales_comparison_notes: text(5_000),
    adjustment_notes: text(5_000),
    district_evidence_summary: text(5_000),
    protest_rationale: text(5_000),
    comparable_grid: normalizeComparableGrid,
  }),
  inspection: Object.freeze({
    appraiser_comments: text(5_000),
  }),
});

const COMPARABLE_KEYS = new Set([
  "id", "source", "sourceLabel", "sourceReference", "documentId", "documentPage",
  "saleId", "accountId", "address", "saleDate", "salePrice", "districtAdjustedValue",
  "concessions", "adjustmentAmount", "propertyUse", "neighborhoodCode", "buildingClass",
  "livingAreaSqft", "siteSizeSqft", "yearBuilt", "bedroomCount", "bathCount",
  "garageSpaces", "pool", "reviewStatus", "armsLength",
]);
const COMPARABLE_MATERIAL_KEYS = Object.freeze([
  "source", "sourceLabel", "sourceReference", "documentId", "documentPage",
  "saleId", "accountId", "address", "saleDate", "salePrice", "districtAdjustedValue",
  "concessions", "adjustmentAmount", "propertyUse", "neighborhoodCode", "buildingClass",
  "livingAreaSqft", "siteSizeSqft", "yearBuilt", "bedroomCount", "bathCount",
  "garageSpaces", "pool",
]);

function optionalDate(value) {
  return value === "" ? "" : dateOnly(value);
}

function normalizeComparableRow(value) {
  exactObject(value, COMPARABLE_KEYS);
  const normalized = {
    id: text(300, { required: true })(value.id),
    source: enumeration(["recommended_sale", "district_evidence"])(value.source),
    sourceLabel: text(300, { required: true })(value.sourceLabel),
    sourceReference: text(1_000)(value.sourceReference),
    documentId: number({ integer: true, minimum: 1, nullable: true })(value.documentId),
    documentPage: number({ integer: true, minimum: 1, nullable: true })(value.documentPage),
    saleId: text(300, { required: true })(value.saleId),
    accountId: text(100)(value.accountId),
    address: text(500)(value.address),
    saleDate: optionalDate(value.saleDate),
    salePrice: number({ minimum: 0, maximum: 10_000_000_000, nullable: true })(value.salePrice),
    districtAdjustedValue: number({ minimum: 0, maximum: 10_000_000_000, nullable: true })(value.districtAdjustedValue),
    concessions: number({ minimum: 0, maximum: 10_000_000_000, nullable: true })(value.concessions),
    adjustmentAmount: number({ minimum: -10_000_000_000, maximum: 10_000_000_000 })(value.adjustmentAmount),
    propertyUse: text(200, { required: true })(value.propertyUse),
    neighborhoodCode: text(200)(value.neighborhoodCode),
    buildingClass: text(200)(value.buildingClass),
    livingAreaSqft: number({ minimum: 0, maximum: 1_000_000, nullable: true })(value.livingAreaSqft),
    siteSizeSqft: number({ minimum: 0, maximum: 1_000_000_000, nullable: true })(value.siteSizeSqft),
    yearBuilt: number({ integer: true, minimum: 1600, maximum: 2200, nullable: true })(value.yearBuilt),
    bedroomCount: number({ minimum: 0, maximum: 100, nullable: true })(value.bedroomCount),
    bathCount: number({ minimum: 0, maximum: 100, nullable: true })(value.bathCount),
    garageSpaces: number({ minimum: 0, maximum: 100, nullable: true })(value.garageSpaces),
    pool: value.pool === null ? null : boolean(value.pool),
    reviewStatus: enumeration(["verified", "needs_review"])(value.reviewStatus),
    armsLength: boolean(value.armsLength),
  };
  return normalized;
}

function normalizeComparableGrid(value) {
  exactObject(value, new Set(["version", "rows", "updated_at", "recommendation_policy"]));
  if (value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > MAX_COMPARABLE_ROWS) invalid();
  const rows = value.rows.map(normalizeComparableRow);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) invalid();
  let updatedAt = null;
  if (value.updated_at !== null) {
    if (typeof value.updated_at !== "string" || value.updated_at.length > 100) invalid();
    const parsed = new Date(value.updated_at);
    if (Number.isNaN(parsed.getTime())) invalid();
    updatedAt = parsed.toISOString();
  }
  return {
    version: 1,
    rows,
    updated_at: updatedAt,
    recommendation_policy: text(200)(value.recommendation_policy),
  };
}

function comparableRows(workfile) {
  const analysis = plainObject(workfile?.analysis) ? workfile.analysis : {};
  const grid = plainObject(analysis.comparable_grid) ? analysis.comparable_grid : {};
  return Array.isArray(grid.rows) ? grid.rows.filter(plainObject) : [];
}

function carriesComparableAttestation(row) {
  return row.reviewStatus === "verified"
    || row.armsLength === true
    || Number(row.adjustmentAmount) !== 0;
}

function requireUnchangedComparableAttestations(stored, proposed) {
  const storedRows = comparableRows(stored);
  const proposedRows = comparableRows(proposed);
  const storedById = new Map(storedRows.map((row) => [row.id, row]));
  const proposedById = new Map(proposedRows.map((row) => [row.id, row]));
  for (const row of storedRows) {
    if (carriesComparableAttestation(row) && !sameJson(row, proposedById.get(row.id))) {
      throw new Error("property_tax_comparable_attestation_required");
    }
  }
  for (const row of proposedRows) {
    if (carriesComparableAttestation(row) && !sameJson(row, storedById.get(row.id))) {
      throw new Error("property_tax_comparable_attestation_required");
    }
  }
}

function comparableMaterialFacts(row) {
  return Object.fromEntries(COMPARABLE_MATERIAL_KEYS.map((key) => [key, row?.[key]]));
}

function requireComparableReverification(stored, proposed) {
  const storedRows = comparableRows(stored);
  const proposedById = new Map(comparableRows(proposed).map((row) => [row.id, row]));
  for (const storedRow of storedRows) {
    if (!carriesComparableAttestation(storedRow)) continue;
    const proposedRow = proposedById.get(storedRow.id);
    if (!proposedRow) continue;
    const materialChanged = !sameJson(
      comparableMaterialFacts(storedRow),
      comparableMaterialFacts(proposedRow),
    );
    if (
      materialChanged
      && (proposedRow.reviewStatus !== "needs_review" || proposedRow.armsLength !== false)
    ) {
      throw new Error("property_tax_comparable_reverification_required");
    }
  }
}

function sameJson(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function assertUnknownFieldsUnchanged(stored, submitted) {
  for (const [group, submittedValue] of Object.entries(submitted)) {
    if (UNSAFE_KEYS.has(group)) invalid();
    const policies = FIELD_POLICIES[group];
    if (!policies) {
      if (!Object.hasOwn(stored, group) || !sameJson(stored[group], submittedValue)) invalid();
      continue;
    }
    if (!plainObject(submittedValue)) invalid();
    const storedGroup = plainObject(stored[group]) ? stored[group] : {};
    for (const [key, value] of Object.entries(submittedValue)) {
      if (UNSAFE_KEYS.has(key)) invalid();
      if (!Object.hasOwn(policies, key)
        && (!Object.hasOwn(storedGroup, key) || !sameJson(storedGroup[key], value))) invalid();
    }
  }
}

/**
 * Replace only the reviewed Property Tax fields. Unknown legacy values already
 * stored remain byte-for-byte canonical, while clients cannot create, modify,
 * or remove future server-owned fields through this generic JSON endpoint.
 */
export function mergePropertyTaxWorkfileUpdate(
  storedValue,
  submittedValue,
  { canAttestComparables = true } = {},
) {
  if (!plainObject(storedValue) || !plainObject(submittedValue)) invalid();
  assertUnknownFieldsUnchanged(storedValue, submittedValue);
  const merged = clone(storedValue);

  for (const [group, policies] of Object.entries(FIELD_POLICIES)) {
    const submittedGroup = plainObject(submittedValue[group]) ? submittedValue[group] : {};
    const mergedGroup = plainObject(merged[group]) ? merged[group] : {};
    for (const [key, normalize] of Object.entries(policies)) {
      if (Object.hasOwn(submittedGroup, key)) mergedGroup[key] = normalize(submittedGroup[key]);
      else delete mergedGroup[key];
    }
    if (Object.keys(mergedGroup).length) merged[group] = mergedGroup;
    else delete merged[group];
  }

  if (!canAttestComparables) requireUnchangedComparableAttestations(storedValue, merged);
  requireComparableReverification(storedValue, merged);

  const serialized = canonicalJson(merged);
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKFILE_BYTES) invalid();
  return JSON.parse(serialized);
}

export const PROPERTY_TAX_WORKFILE_GROUPS = Object.freeze(Object.keys(FIELD_POLICIES));
