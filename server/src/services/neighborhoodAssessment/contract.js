import { createHash } from "node:crypto";

export const NEIGHBORHOOD_ASSESSMENT_CONTRACT_VERSION = 1;
export const NEIGHBORHOOD_ASSESSMENT_METHOD_VERSION = "foundation-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const STATES = ["ready", "incomplete", "unsupported"];
const POPULATION_KINDS = ["geographic_stock", "competitive_stock", "transactions", "listings"];
const MAX_BYTES = 1_500_000;

const DISTRIBUTION_ESTIMATORS = ["exact_median", "exact_quantile", "arithmetic_mean", "unsupported"];
// Domain vocabulary only; no UAD IDs or format-specific conclusions live here.
export const NEIGHBORHOOD_MEASUREMENTS = Object.freeze(Object.fromEntries(Object.entries({
  property_count: ["properties", ["count", "unsupported"]],
  transaction_count: ["transactions", ["count", "unsupported"]],
  allocated_property_sale_count: ["property_sales", ["count", "unsupported"]],
  listing_count: ["listings", ["count", "unsupported"]],
  unique_property_count: ["properties", ["count", "unsupported"]],
  recorded_sale_price: ["USD", DISTRIBUTION_ESTIMATORS],
  allocated_sale_price: ["USD", DISTRIBUTION_ESTIMATORS],
  assessed_market_value: ["USD", DISTRIBUTION_ESTIMATORS],
  predominant_sale_price: ["USD", ["modal_interval", "unsupported"]],
  sale_price_per_square_foot: ["USD/ft2", DISTRIBUTION_ESTIMATORS],
  assessed_value_per_square_foot: ["USD/ft2", DISTRIBUTION_ESTIMATORS],
  gla: ["ft2", DISTRIBUTION_ESTIMATORS],
  site_area: ["ft2", DISTRIBUTION_ESTIMATORS],
  age_at_effective_date: ["years", DISTRIBUTION_ESTIMATORS],
  age_at_sale: ["years", DISTRIBUTION_ESTIMATORS],
  year_built: ["year", DISTRIBUTION_ESTIMATORS],
  days_on_market: ["days", DISTRIBUTION_ESTIMATORS],
  sale_coverage_percent: ["percent", ["ratio", "unsupported"]],
  data_coverage_percent: ["percent", ["ratio", "unsupported"]],
  cod_percent: ["percent", ["coefficient_of_dispersion", "unsupported"]],
  underlying_market_change_percent: ["percent", ["unsupported"]],
}).map(([measurement, [unit, estimators]]) => [measurement, Object.freeze({
  unit, estimators: Object.freeze([...estimators]),
})])));

function fail(field) {
  throw new TypeError(`invalid_neighborhood_assessment:${field}`);
}

function record(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(field);
  return value;
}

function string(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value;
}

function uuid(value, field) {
  if (!UUID.test(string(value, field, 36))) fail(field);
  return value.toLowerCase();
}

function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(field);
  return value;
}

function choice(value, allowed, field) {
  if (!allowed.includes(value)) fail(field);
  return value;
}

const byId = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

export function assessmentDate(value, field = "effective_date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(field);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(field);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail(field);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field);
  return value;
}

function list(value, field, limit = 1000) {
  if (!Array.isArray(value) || value.length > limit) fail(field);
  return value;
}

function strings(value, field, limit = 1000) {
  const result = list(value, field, limit).map(item => string(item, field));
  if (new Set(result).size !== result.length) fail(`${field}.duplicate`);
  return result.sort();
}

// This is an evidence identity, not the signed-report HMAC/canonicalization.
// Reject lossy JSON inputs rather than silently dropping undefined/non-finite data.
export function canonicalAssessmentJson(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100_000 || depth > 40) fail("json_limit");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("nonfinite_number");
      return item;
    }
    if (Array.isArray(item)) return Array.from(item, child => visit(child, depth + 1));
    record(item, "json_object");
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key], depth + 1)]));
  };
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result, "utf8") > MAX_BYTES) fail("json_bytes");
  return result;
}

export function assessmentEvidenceDigest(value) {
  return createHash("sha256").update(canonicalAssessmentJson(value)).digest("hex");
}

function clone(value) {
  return JSON.parse(canonicalAssessmentJson(value));
}

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function period(value, effectiveDate, field) {
  record(value, field);
  const start = assessmentDate(value.start_date, `${field}.start_date`);
  const end = assessmentDate(value.end_date, `${field}.end_date`);
  if (start > end || end > effectiveDate) fail(`${field}.future_or_reversed`);
  return { start_date: start, end_date: end, date_basis: choice(value.date_basis,
    ["closing_date", "contract_date", "status_as_of", "effective_date"], `${field}.date_basis`) };
}

function scope(value) {
  record(value, "scope");
  return {
    organization_id: uuid(value.organization_id, "scope.organization_id"),
    appraisal_case_id: uuid(value.appraisal_case_id, "scope.appraisal_case_id"),
    subject_snapshot_id: uuid(value.subject_snapshot_id, "scope.subject_snapshot_id"),
    account_id: string(value.account_id, "scope.account_id", 100),
  };
}

function sourceSnapshot(value, assessmentScope) {
  record(value, "source_snapshot");
  const visibility = choice(value.visibility, ["public", "organization", "assignment"], "source.visibility");
  const owner = value.scope === null ? null : scope(value.scope);
  if (visibility === "public" && owner !== null) fail("public_source_scope");
  if (visibility !== "public") {
    if (!owner || owner.organization_id !== assessmentScope.organization_id) fail("private_source_scope");
    if (visibility === "assignment" && canonicalAssessmentJson(owner) !== canonicalAssessmentJson(assessmentScope)) {
      fail("private_source_assignment");
    }
  }
  const hash = string(value.content_sha256, "source.content_sha256", 64);
  if (!DIGEST.test(hash)) fail("source.content_sha256");
  const validFrom = value.valid_from === null ? null : assessmentDate(value.valid_from, "source.valid_from");
  const validTo = value.valid_to === null ? null : assessmentDate(value.valid_to, "source.valid_to");
  if (validFrom && validTo && validFrom > validTo) fail("source.valid_interval");
  return {
    id: string(value.id, "source.id"), revision: string(value.revision, "source.revision"),
    provider: string(value.provider, "source.provider"), content_sha256: hash,
    visibility, scope: owner, valid_from: validFrom, valid_to: validTo,
    observed_at: timestamp(value.observed_at, "source.observed_at"),
    historical_availability: choice(value.historical_availability,
      ["contemporaneous", "reconstructed", "unknown"], "source.historical_availability"),
  };
}

function refs(value, sourceIds, field) {
  const result = strings(value, field);
  if (result.some(id => !sourceIds.has(id))) fail(`${field}.missing_source`);
  return result;
}

// Validity describes the supported fact period, not its retrieval time. Later
// research may support an earlier interval only when explicitly reconstructed.
function sourcesSupportPeriod(sourceRefs, sources, observationPeriod, effectiveDate) {
  if (!sourceRefs.length) return false;
  const intervals = sourceRefs.map(id => sources.get(id)).filter(source =>
    source.valid_from !== null && source.historical_availability !== "unknown" &&
    (source.historical_availability === "reconstructed" || source.observed_at.slice(0, 10) <= effectiveDate),
  ).map(source => ({
    start: Date.parse(`${source.valid_from}T00:00:00.000Z`),
    end: source.valid_to === null ? Infinity : Date.parse(`${source.valid_to}T00:00:00.000Z`),
  })).sort((left, right) => left.start - right.start);
  let cursor = Date.parse(`${observationPeriod.start_date}T00:00:00.000Z`);
  const end = Date.parse(`${observationPeriod.end_date}T00:00:00.000Z`);
  for (const interval of intervals) {
    if (interval.start > cursor) return false;
    if (interval.end >= end) return true;
    if (interval.end >= cursor) cursor = interval.end + 86_400_000;
  }
  return false;
}

// Structural validation only: the named spatial oracle still owns topology,
// source-edge alignment, connectivity, and actual subject containment.
function polygonGeometry(value) {
  if (value === null) return null;
  record(value, "geometry");
  if (value.type !== "Polygon") fail("geometry.type");
  const rings = list(value.coordinates, "geometry.coordinates", 1000);
  if (!rings.length) fail("geometry.empty");
  let positions = 0;
  for (const ring of rings) {
    list(ring, "geometry.ring", 20000);
    if (ring.length < 4 || (positions += ring.length) > 20000) fail("geometry.ring_size");
    for (const point of ring) {
      if (!Array.isArray(point) || point.length !== 2 ||
          point.some(coordinate => typeof coordinate !== "number" || !Number.isFinite(coordinate)) ||
          Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) fail("geometry.coordinate");
    }
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) fail("geometry.ring_not_closed");
    if (new Set(ring.slice(0, -1).map(point => `${point[0]},${point[1]}`)).size < 3) fail("geometry.ring_degenerate");
  }
  return clone({ type: "Polygon", coordinates: rings });
}

function geography(value, sources, effectiveDate) {
  record(value, "geographic_neighborhood");
  const status = choice(value.status, STATES, "geographic_neighborhood.status");
  const reasons = strings(value.reasons, "geographic_neighborhood.reasons");
  const perimeter = list(value.perimeter, "geographic_neighborhood.perimeter", 5000).map(segment => {
    record(segment, "perimeter.segment");
    return {
      edge_id: string(segment.edge_id, "perimeter.edge_id"),
      source_refs: refs(segment.source_refs, sources, "perimeter.source_refs"),
      from_node: string(segment.from_node, "perimeter.from_node"),
      to_node: string(segment.to_node, "perimeter.to_node"),
      name: segment.name === null ? null : string(segment.name, "perimeter.name"),
    };
  });
  if (perimeter.some(edge => edge.from_node === edge.to_node || !edge.source_refs.length)) fail("perimeter.edge");
  if (new Set(perimeter.map(edge => edge.edge_id)).size !== perimeter.length) fail("perimeter.duplicate");
  const geometry = polygonGeometry(value.geometry);
  const cardinal = record(value.cardinal_summaries, "cardinal_summaries");
  const cardinalSummaries = Object.fromEntries(["north", "east", "south", "west"].map(side => [
    side, cardinal[side] === null ? null : string(cardinal[side], `cardinal_summaries.${side}`, 2000),
  ]));
  const validation = record(value.validation, "geographic_neighborhood.validation");
  for (const key of ["valid", "connected", "contains_subject"]) {
    if (validation[key] !== null && typeof validation[key] !== "boolean") fail(`validation.${key}`);
  }
  if (status === "ready") {
    if (!geometry || perimeter.length < 3 || reasons.length ||
        !validation.valid || !validation.connected || !validation.contains_subject ||
        !validation.engine || !validation.revision ||
        Object.values(cardinalSummaries).some(summary => summary === null)) fail("geographic_neighborhood.not_ready");
    for (let i = 0; i < perimeter.length; i++) {
      if (perimeter[i].to_node !== perimeter[(i + 1) % perimeter.length].from_node) fail("perimeter.gap");
      if (!sourcesSupportPeriod(perimeter[i].source_refs, sources,
        { start_date: effectiveDate, end_date: effectiveDate }, effectiveDate)) fail("perimeter.source_temporal_support");
    }
  } else if (!reasons.length) fail("geographic_neighborhood.reason_required");
  return {
    status, reasons, geometry, crs: choice(value.crs, ["EPSG:4326"], "geometry.crs"),
    revision: string(value.revision, "geometry.revision"), perimeter,
    validation: {
      valid: validation.valid, connected: validation.connected, contains_subject: validation.contains_subject,
      engine: validation.engine === null ? null : string(validation.engine, "validation.engine"),
      revision: validation.revision === null ? null : string(validation.revision, "validation.revision"),
    },
    cardinal_summaries: cardinalSummaries,
  };
}

function population(value, effectiveDate, dataCutoff, studyPeriod, sources) {
  record(value, "population");
  const completeness = choice(value.completeness, ["complete", "incomplete", "unknown"], "population.completeness");
  const reasons = strings(value.reasons, "population.reasons");
  if (completeness !== "complete" && !reasons.length) fail("population.reason_required");
  const kind = choice(value.kind, POPULATION_KINDS, "population.kind");
  const memberUnit = choice(value.member_unit,
    ["property", "canonical_transaction", "allocated_property_sale", "listing"], "population.member_unit");
  const allowedUnits = kind === "transactions" ? ["canonical_transaction", "allocated_property_sale"]
    : kind === "listings" ? ["listing"] : ["property"];
  if (!allowedUnits.includes(memberUnit)) fail("population.kind_member_unit");
  const observationPeriod = period(value.observation_period, effectiveDate, "population.observation_period");
  if (observationPeriod.end_date > dataCutoff) fail("population.data_cutoff");
  if (["geographic_stock", "competitive_stock"].includes(kind)) {
    if (observationPeriod.date_basis !== "effective_date" || observationPeriod.start_date !== effectiveDate ||
        observationPeriod.end_date !== effectiveDate) fail("population.stock_effective_date");
  } else {
    const allowedBasis = kind === "transactions" ? ["closing_date", "contract_date"] : ["status_as_of"];
    if (!allowedBasis.includes(observationPeriod.date_basis)) fail("population.date_basis");
    if (observationPeriod.start_date < studyPeriod.start_date || observationPeriod.end_date > studyPeriod.end_date) {
      fail("population.outside_study_period");
    }
    if (kind === "transactions" && observationPeriod.date_basis !== studyPeriod.date_basis) fail("population.study_date_basis");
  }
  const result = {
    id: string(value.id, "population.id"), revision: string(value.revision, "population.revision"),
    kind, member_unit: memberUnit,
    definition: string(value.definition, "population.definition", 2000),
    observation_period: observationPeriod,
    member_count: value.member_count === null ? null : integer(value.member_count, "population.member_count"),
    unique_property_count: value.unique_property_count === null ? null : integer(value.unique_property_count, "population.unique_property_count"),
    property_link_count: value.property_link_count === null ? null : integer(value.property_link_count, "population.property_link_count"),
    member_set_sha256: value.member_set_sha256 === null ? null : checkedDigest(value.member_set_sha256),
    members_resource_id: string(value.members_resource_id, "population.members_resource_id"),
    pocket_ids: strings(value.pocket_ids, "population.pocket_ids", 5000),
    completeness, reasons, source_refs: refs(value.source_refs, sources, "population.source_refs"),
  };
  if (result.property_link_count !== null && result.unique_property_count !== null &&
      result.unique_property_count > result.property_link_count) {
    fail("population.unique_property_count");
  }
  if (result.member_count !== null && result.property_link_count !== null &&
      (memberUnit === "canonical_transaction"
        ? result.property_link_count < result.member_count || (result.member_count === 0 && result.property_link_count !== 0)
        : result.property_link_count !== result.member_count)) fail("population.property_link_count");
  if (memberUnit === "property" && result.member_count !== null && result.unique_property_count !== null &&
      result.unique_property_count !== result.member_count) fail("population.stock_unique_count");
  if (completeness === "complete" && (reasons.length || result.member_count === null ||
      result.unique_property_count === null || result.property_link_count === null || result.member_set_sha256 === null ||
      (result.member_count > 0 && result.unique_property_count === 0) ||
      !sourcesSupportPeriod(result.source_refs, sources, observationPeriod, effectiveDate))) fail("population.not_complete");
  return result;
}

function checkedDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("digest");
  return value;
}

function statistic(value, populations, sources, effectiveDate) {
  record(value, "statistic");
  const id = string(value.population_id, "statistic.population_id");
  const population = populations.get(id);
  if (!population) fail("statistic.missing_population");
  const status = choice(value.status, STATES, "statistic.status");
  const estimator = choice(value.estimator,
    ["count", "exact_median", "exact_quantile", "arithmetic_mean", "ratio", "modal_interval", "coefficient_of_dispersion", "unsupported"], "statistic.estimator");
  const measurement = string(value.measurement, "statistic.measurement");
  if (measurement.includes("predominant") && !["modal_interval", "unsupported"].includes(estimator)) fail("statistic.median_not_predominant");
  const definition = Object.hasOwn(NEIGHBORHOOD_MEASUREMENTS, measurement) ? NEIGHBORHOOD_MEASUREMENTS[measurement] : null;
  if (!definition || value.unit !== definition.unit || !definition.estimators.includes(estimator)) fail("statistic.measurement_unit_estimator");
  const parameters = clone(record(value.estimator_parameters, "statistic.estimator_parameters"));
  if (estimator === "exact_quantile") {
    if (parameters.convention !== "type_7" || typeof parameters.probability !== "number" ||
        !Number.isFinite(parameters.probability) || parameters.probability < 0 || parameters.probability > 1) fail("statistic.quantile_parameters");
  }
  if (value.value !== null && (typeof value.value !== "number" || !Number.isFinite(value.value))) fail("statistic.value");
  if (status === "ready" && (value.value === null || estimator === "unsupported")) fail("statistic.not_ready");
  if ((status === "unsupported" || estimator === "unsupported") && value.value !== null) fail("statistic.unsupported_value");
  if (status !== "ready" && !value.reason) fail("statistic.reason_required");
  const observed = integer(value.observed_count, "statistic.observed_count");
  const missing = integer(value.missing_count, "statistic.missing_count");
  const denominator = integer(value.denominator_count, "statistic.denominator_count");
  const denominatorBasis = choice(value.denominator_basis,
    ["population_members", "unique_properties"], "statistic.denominator_basis");
  const expectedDenominator = denominatorBasis === "population_members" ? population.member_count : population.unique_property_count;
  if (observed + missing !== denominator) fail("statistic.denominator");
  if (expectedDenominator !== null && denominator !== expectedDenominator) fail("statistic.population_denominator");
  if (denominatorBasis === "unique_properties" && estimator !== "count" && estimator !== "unsupported") {
    fail("statistic.unique_property_estimator");
  }
  if (estimator === "count" && value.value !== null &&
      (!Number.isSafeInteger(value.value) || value.value < 0 || value.value !== observed)) fail("statistic.count_value");
  if (estimator === "count" && status === "ready" && missing !== 0) fail("statistic.count_membership_unknown");
  if (measurement === "unique_property_count" && denominatorBasis !== "unique_properties") fail("statistic.unique_property_basis");
  const countUnits = { property_count: "property", transaction_count: "canonical_transaction",
    allocated_property_sale_count: "allocated_property_sale", listing_count: "listing" };
  if (Object.hasOwn(countUnits, measurement) && (population.member_unit !== countUnits[measurement] ||
      denominatorBasis !== "population_members")) fail("statistic.count_population_unit");
  if (["recorded_sale_price", "allocated_sale_price", "predominant_sale_price", "sale_price_per_square_foot", "age_at_sale"].includes(measurement) &&
      population.kind !== "transactions") fail("statistic.transaction_population_required");
  if (measurement === "recorded_sale_price" && population.member_unit !== "canonical_transaction") fail("statistic.recorded_price_member_unit");
  if (measurement === "allocated_sale_price" && population.member_unit !== "allocated_property_sale") fail("statistic.allocated_price_member_unit");
  if (value.value !== null && definition.unit !== "percent" && value.value < 0) fail("statistic.negative_measurement");
  if (measurement === "cod_percent" && value.value !== null && value.value < 0) fail("statistic.negative_dispersion");
  const isCoverage = ["sale_coverage_percent", "data_coverage_percent"].includes(measurement);
  if (isCoverage) {
    // A non-ready coverage record must not carry a number consumers could mistake
    // for usable coverage. Unknown 0/0 remains null; known 0/N can be a true zero.
    if (status !== "ready" && value.value !== null) fail("statistic.coverage_not_ready_value");
    if (estimator === "ratio") {
      const numerator = integer(parameters.numerator_count, "statistic.ratio_numerator");
      if (measurement === "data_coverage_percent" && numerator !== observed) fail("statistic.coverage_observations");
      if (numerator > denominator || (value.value !== null &&
          (denominator <= 0 || Math.abs(value.value - numerator / denominator * 100) > 1e-9))) fail("statistic.ratio_value");
    }
  }
  if (estimator === "modal_interval" && status === "ready") {
    const { lower_bound: lower, upper_bound: upper, bin_width: width } = parameters;
    if (parameters.method !== "fixed_width_histogram" || ![lower, upper, width].every(item => typeof item === "number" && Number.isFinite(item)) ||
        lower < 0 || upper <= lower || width !== upper - lower || value.value < lower || value.value >= upper) fail("statistic.modal_parameters");
  }
  const knownZeroDataCoverage = measurement === "data_coverage_percent" && estimator === "ratio" && denominator > 0;
  if (status === "ready" && observed === 0 && estimator !== "count" && !knownZeroDataCoverage) fail("statistic.no_observations");
  const taxYear = value.assessment_tax_year === null ? null : integer(value.assessment_tax_year, "statistic.assessment_tax_year", 1800);
  if (value.measurement.startsWith("assessed_") && status === "ready" && taxYear === null) fail("statistic.assessment_tax_year_required");
  if (taxYear !== null && taxYear > Number(effectiveDate.slice(0, 4))) fail("statistic.future_assessment_tax_year");
  const sourceRefs = refs(value.source_refs, sources, "statistic.source_refs");
  if (status === "ready" && (value.reason !== null || population.completeness !== "complete" ||
      expectedDenominator === null || !sourcesSupportPeriod(sourceRefs, sources, population.observation_period, effectiveDate))) {
    fail("statistic.not_ready");
  }
  return {
    id: string(value.id, "statistic.id"), population_id: id,
    measurement,
    unit: definition.unit, estimator,
    estimator_parameters: parameters,
    value: value.value, status, reason: value.reason === null ? null : string(value.reason, "statistic.reason", 2000),
    observed_count: observed, missing_count: missing, denominator_count: denominator, denominator_basis: denominatorBasis,
    observation_period: population.observation_period, assessment_tax_year: taxYear,
    uncertainty: clone(record(value.uncertainty, "statistic.uncertainty")),
    source_refs: sourceRefs,
  };
}

function selection(value) {
  const result = clone(record(value, "selection"));
  result.revision = string(result.revision, "selection.revision");
  result.pocket_ids = strings(result.pocket_ids, "selection.pocket_ids", 5000);
  result.overrides = list(result.overrides, "selection.overrides", 5000).map(override => {
    record(override, "selection.override");
    string(override.pocket_id, "selection.override.pocket_id");
    if (typeof override.included !== "boolean") fail("selection.override.included");
    return override;
  }).sort((a, b) => a.pocket_id < b.pocket_id ? -1 : a.pocket_id > b.pocket_id ? 1 : 0);
  if (new Set(result.overrides.map(override => override.pocket_id)).size !== result.overrides.length) fail("selection.override.duplicate");
  return result;
}

/** Pure contract builder. Callers must resolve and authorize scope before calling.
 * It performs no DB access, GET side effects, form application, or report signing.
 */
export function buildNeighborhoodAssessment(input) {
  record(input, "input");
  if (input.contract_version !== NEIGHBORHOOD_ASSESSMENT_CONTRACT_VERSION) fail("contract_version");
  for (const key of ["target", "report_file_id", "assignment_file_id", "review_decisions"]) {
    if (Object.hasOwn(input, key)) fail(`target_outside_core.${key}`);
  }
  const assessmentScope = scope(input.scope);
  const effectiveDate = assessmentDate(input.effective_date);
  const dataCutoff = assessmentDate(input.data_cutoff, "data_cutoff");
  if (dataCutoff > effectiveDate) fail("data_cutoff.after_effective_date");
  const studyPeriod = period(input.observation_period, effectiveDate, "observation_period");
  if (studyPeriod.end_date > dataCutoff) fail("data_cutoff.outside_period");
  const requiredStats = strings(input.required_statistic_ids, "required_statistic_ids");
  const requiredPopulationIds = strings(input.required_population_ids, "required_population_ids", 100);
  const snapshots = list(input.source_snapshots, "source_snapshots", 1000)
    .map(value => sourceSnapshot(value, assessmentScope)).sort(byId);
  const sourceIds = new Set(snapshots.map(source => source.id));
  if (sourceIds.size !== snapshots.length) fail("source_snapshots.duplicate");
  const sources = new Map(snapshots.map(source => [source.id, source]));
  const populations = list(input.populations, "populations", 100)
    .map(value => population(value, effectiveDate, dataCutoff, studyPeriod, sources)).sort(byId);
  const populationMap = new Map(populations.map(value => [value.id, value]));
  if (populationMap.size !== populations.length) fail("populations.duplicate");
  if (requiredPopulationIds.some(id => !populationMap.has(id))) fail("required_population_ids.missing_population");
  const statistics = list(input.statistics, "statistics", 1000)
    .map(value => statistic(value, populationMap, sources, effectiveDate)).sort(byId);
  if (new Set(statistics.map(value => value.id)).size !== statistics.length) fail("statistics.duplicate");
  const methodology = clone(record(input.methodology, "methodology"));
  string(methodology.version, "methodology.version");
  string(methodology.geometry_version, "methodology.geometry_version");
  record(methodology.configuration, "methodology.configuration");
  const discovery = clone(record(input.discovery, "discovery"));
  if (discovery.complete !== null && typeof discovery.complete !== "boolean") fail("discovery.complete");
  const signatureInputs = {
    contract_version: input.contract_version, scope: assessmentScope, effective_date: effectiveDate,
    data_cutoff: dataCutoff,
    observation_period: studyPeriod,
    subject_facts: clone(record(input.subject_facts, "subject_facts")),
    methodology, source_snapshots: snapshots,
    discovery,
    selection: selection(input.selection),
    required_statistic_ids: requiredStats,
    required_population_ids: requiredPopulationIds,
  };
  const result = {
    ...signatureInputs,
    id: uuid(input.id, "id"), revision: integer(input.revision, "revision", 1),
    generated_at: timestamp(input.generated_at, "generated_at"),
    input_signature_sha256: assessmentEvidenceDigest(signatureInputs),
    geographic_neighborhood: geography(input.geographic_neighborhood, sources, effectiveDate),
    populations, statistics,
    development_evidence: clone(record(input.development_evidence, "development_evidence")),
    diagnostics: clone(record(input.diagnostics, "diagnostics")),
  };
  // Geography and derived statistics have one review/application boundary. A
  // consumer may display unsupported measures but cannot accept half a new study.
  const statsById = new Map(statistics.map(item => [item.id, item]));
  if (requiredStats.some(id => !statsById.has(id))) fail("required_statistic_ids.missing_statistic");
  const requiredPopulationSet = new Set(requiredPopulationIds);
  if (requiredStats.some(id => !requiredPopulationSet.has(statsById.get(id).population_id))) {
    fail("required_population_ids.missing_statistic_population");
  }
  const requiredPopulations = requiredPopulationIds.map(id => populationMap.get(id));
  const requiredSources = new Set([
    ...result.geographic_neighborhood.perimeter.flatMap(edge => edge.source_refs),
    ...requiredPopulations.flatMap(item => item.source_refs),
    ...requiredStats.flatMap(id => statsById.get(id).source_refs),
  ]);
  result.application_group = {
    id: `${result.id}:${result.revision}:neighborhood`,
    revision: result.revision,
    application_mode: "atomic",
    policy: "all_or_nothing",
    geometry_revision: result.geographic_neighborhood.revision,
    geometry_sha256: assessmentEvidenceDigest(result.geographic_neighborhood),
    population_refs: requiredPopulations.map(item => ({ id: item.id, revision: item.revision, member_set_sha256: item.member_set_sha256 })),
    required_statistic_ids: requiredStats,
    source_refs: [...requiredSources].sort(),
    effective_date: effectiveDate, data_cutoff: signatureInputs.data_cutoff,
    status: discovery.complete === true && result.geographic_neighborhood.status === "ready" && requiredStats.length > 0 &&
      requiredPopulations.length > 0 && requiredPopulations.every(item => item.completeness === "complete" && item.member_set_sha256 !== null) &&
      requiredStats.every(id => statsById.get(id).status === "ready") ? "ready" : "incomplete",
  };
  const { generated_at: _generatedAt, ...evidence } = result;
  return freeze({ ...result, evidence_digest_sha256: assessmentEvidenceDigest(evidence) });
}

/** Scope/revision binding only; NOT an authorization decision. Existing target
 * access guards, reviewer permission and signed/stale-write gates remain mandatory.
 */
export function buildNeighborhoodAttachment(assessment, target) {
  record(target, "target");
  if (assessment.contract_version !== 1) fail("attachment.contract_version");
  const { generated_at: _generatedAt, evidence_digest_sha256: expectedDigest, ...evidence } = assessment;
  if (assessmentEvidenceDigest(evidence) !== checkedDigest(expectedDigest)) fail("attachment.changed_assessment");
  if (canonicalAssessmentJson(scope(target.scope)) !== canonicalAssessmentJson(assessment.scope)) fail("attachment.scope_mismatch");
  if (assessmentDate(target.effective_date, "target.effective_date") !== assessment.effective_date ||
      assessmentDate(target.data_cutoff, "target.data_cutoff") !== assessment.data_cutoff) fail("attachment.date_mismatch");
  const workflow = choice(target.workflow_type, ["custom_appraisal", "uad_3_6"], "target.workflow_type");
  if (workflow === "custom_appraisal" ? target.uad_workfile_id !== null : target.custom_assignment_file_id !== null) {
    fail("target.inappropriate_workflow_id");
  }
  const customId = workflow === "custom_appraisal"
    ? integer(target.custom_assignment_file_id, "target.custom_assignment_file_id", 1) : null;
  const uadId = workflow === "uad_3_6" ? uuid(target.uad_workfile_id, "target.uad_workfile_id") : null;
  const binding = {
    attachment_id: uuid(target.attachment_id, "target.attachment_id"),
    attachment_revision: integer(target.attachment_revision, "target.attachment_revision", 1),
    assessment_id: assessment.id, assessment_revision: assessment.revision,
    evidence_digest_sha256: expectedDigest, scope: assessment.scope,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
    application_group_id: assessment.application_group.id,
    application_group_revision: assessment.application_group.revision,
    application_group_sha256: assessmentEvidenceDigest(assessment.application_group),
    application_mode: "atomic",
    report_file_id: uuid(target.report_file_id, "target.report_file_id"), workflow_type: workflow,
    custom_assignment_file_id: customId, uad_workfile_id: uadId,
    editor_revision: integer(target.editor_revision, "target.editor_revision", workflow === "uad_3_6" ? 1 : 0),
    source_digest_sha256: checkedDigest(target.source_digest_sha256),
    mapped_manifest_sha256: checkedDigest(target.mapped_manifest_sha256),
    mapper_version: string(target.mapper_version, "target.mapper_version"),
    specification_release: workflow === "uad_3_6"
      ? string(target.specification_release, "target.specification_release") : null,
  };
  // Application identity remains stable through the write's own concurrency
  // increments. Exact evidence, target registration and mapper manifests remain
  // bound; only the optimistic editor/attachment revisions are excluded.
  const { editor_revision: _editorRevision, attachment_revision: _attachmentRevision, ...applicationIdentity } = binding;
  binding.application_identity_sha256 = assessmentEvidenceDigest(applicationIdentity);
  return freeze({ ...binding, review_status: "proposed", binding_digest_sha256: assessmentEvidenceDigest(binding) });
}
