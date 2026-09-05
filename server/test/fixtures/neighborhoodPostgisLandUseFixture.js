import { createHash } from "node:crypto";
import { assessmentEvidenceDigest } from "../../src/services/neighborhoodAssessment/contract.js";
import { ASSESSMENT_SCOPE } from "./neighborhoodAssessmentFixture.js";

// All polygons below are invented source geometry. Their original coordinate
// system is a local Cartesian metric plane with origin (0,0), east/right and
// north/up. Translation to the synthetic anchor below gives EPSG:26914 metric
// coordinates inside the kernel's supported projection window. Only an injected
// PostGIS query adapter may transform them to EPSG:4326. Never label the local or
// projected coordinates RFC7946 GeoJSON. No expected output polygons are sent
// to the implementation: expectations are independent hand-calculated areas.
export const LAND_USE_FIXTURE_COORDINATES = Object.freeze({
  original: "synthetic Cartesian metres; origin (0,0)",
  metric_srid: 26914,
  metric_anchor: Object.freeze([700000, 3600000]),
  area_tolerance_m2: 0.001,
});

const ring = (w, s, e, n, clockwise = false) => {
  const points = clockwise ? [[w, s], [w, n], [e, n], [e, s], [w, s]]
    : [[w, s], [e, s], [e, n], [w, n], [w, s]];
  return points.map(([x, y]) => `${x + 700000} ${y + 3600000}`).join(",");
};
const rectangle = (w, s, e, n) => `POLYGON((${ring(w, s, e, n)}))`;
const feature = (id, category, w, s, e, n, extra = {}) => ({
  id, category, classification_status: "supported", semantics: "observed_use",
  metric_wkt: rectangle(w, s, e, n), ...extra,
});
const baseFeatures = () => [
  feature("A1", "one_unit", 0, 0, 20, 50), feature("A2", "one_unit", 20, 0, 40, 50),
  feature("A3", "one_unit", 40, 0, 60, 50), feature("A4", "one_unit", 0, 50, 20, 100),
  feature("A5", "one_unit", 20, 50, 40, 100), feature("A6", "one_unit", 40, 50, 60, 100),
  feature("C1", "commercial", 60, 0, 90, 50),
  feature("PARK1", "park_open_space", 60, 50, 80, 100),
  feature("WATER1", "water", 80, 50, 90, 100),
];
const baseAreas = () => ({ one_unit: 6000, commercial: 1500, park_open_space: 1000,
  water: 500, unknown_uncovered: 1000 });

export const LAND_USE_FIXTURE_VARIANTS = Object.freeze([
  "base", "duplicate_and_stacked", "extending_tract", "conflict", "zero_area_contacts",
  "triple_conflict_and_duplicates", "boundary_hole", "zoning_overlay", "unclassified_gap", "unclassified_over_known", "empty",
]);

export function neighborhoodLandUseMetricFixture(variant = "base") {
  if (!LAND_USE_FIXTURE_VARIANTS.includes(variant)) throw new TypeError("unknown_synthetic_land_use_variant");
  let boundaryWkt = rectangle(0, 0, 100, 100);
  let features = baseFeatures();
  let boundaryArea = 10000;
  let areas = baseAreas();
  if (variant === "duplicate_and_stacked") features.push(
    feature("DUPLICATE-TAX-400", "one_unit", 10, 10, 30, 30),
    feature("STACKED-CONDO-1", "one_unit", 0, 0, 20, 50),
    feature("STACKED-CONDO-2", "one_unit", 0, 0, 20, 50),
  );
  if (variant === "extending_tract") features = features.map(row => row.id === "C1"
    ? feature("C1", "commercial", 60, -20, 90, 50) : row);
  if (variant === "conflict") {
    features.push(feature("CONFLICT-COMMERCIAL-400", "commercial", 10, 10, 30, 30));
    areas = { ...areas, one_unit: 5600, unknown_conflict: 400 };
  }
  if (variant === "triple_conflict_and_duplicates") {
    // Three classes and duplicate tax accounts all claim the same 400 m².
    // The conflict is the geometric union, not the sum of pair intersections.
    features.push(feature("CONFLICT-COMMERCIAL-400", "commercial", 10, 10, 30, 30),
      feature("CONFLICT-PARK-400", "park_open_space", 10, 10, 30, 30),
      feature("DUPLICATE-TAX-400", "one_unit", 10, 10, 30, 30),
      feature("STACKED-CONDO-1", "one_unit", 0, 0, 20, 50));
    areas = { ...areas, one_unit: 5600, unknown_conflict: 400 };
  }
  if (variant === "zero_area_contacts") features.push(
    feature("POINT-ONLY", "commercial", -20, -20, 0, 0),
    // Use the boundary's exact two west-edge endpoints. An independently
    // transformed intermediate vertex would test projection/chord differences,
    // not an identical shared edge, and could create a real numerical sliver.
    feature("EDGE-ONLY", "commercial", -20, 0, 0, 100),
  );
  if (variant === "boundary_hole") {
    boundaryWkt = `POLYGON((${ring(0, 0, 100, 100)}),(${ring(5, 5, 15, 15, true)}))`;
    boundaryArea = 9900;
    areas = { ...areas, one_unit: 5900 };
  }
  if (variant === "zoning_overlay") features.push(
    feature("PERMITTED-COMMERCIAL", "commercial", 0, 0, 100, 100, { semantics: "zoning" }),
  );
  if (variant === "unclassified_gap") {
    features.push(feature("UNCLASSIFIED-500", null, 90, 0, 100, 50, { classification_status: "unknown" }));
    areas = { ...areas, unknown_uncovered: 500, unknown_classification: 500 };
  }
  if (variant === "unclassified_over_known") features.push(
    feature("UNCLASSIFIED-OVER-KNOWN", null, 10, 10, 30, 30, { classification_status: "unknown" }),
  );
  if (variant === "empty") { features = []; areas = { unknown_uncovered: 10000 }; }
  return {
    variant, coordinate_system: LAND_USE_FIXTURE_COORDINATES,
    boundary_metric_wkt: boundaryWkt, source_features: features,
    expected: {
      boundary_area_m2: boundaryArea, areas_m2: areas,
      percentages: Object.fromEntries(Object.entries(areas).map(([category, area]) => [category, area / boundaryArea * 100])),
      zero_area_feature_ids: variant === "zero_area_contacts" ? ["EDGE-ONLY", "POINT-ONLY"] : [],
    },
  };
}

// Accepts a function query(text, values), a pg-like client/pool, or a scratch WASM
// adapter. It creates no connection and imports no database package. Queries are
// geometry transformations on parameter values only, with no tables/providers.
export async function projectNeighborhoodLandUseFixture(adapter, variant = "base") {
  const query = typeof adapter === "function" ? adapter : (text, values) => adapter.query(text, values);
  const metric = neighborhoodLandUseMetricFixture(variant);
  const project = async wkt => {
    const result = await query(`/* land-use-fixture:project */ SELECT
      encode(ST_AsEWKB(ST_Transform(ST_GeomFromText($1,26914),4326),'NDR'),'hex') AS ewkb`, [wkt]);
    const ewkb = result.rows[0]?.ewkb;
    if (typeof ewkb !== "string" || !/^(?:[0-9a-f]{2})+$/.test(ewkb)) throw new TypeError("invalid_synthetic_projection_result");
    return { srid: 4326, ewkb, content_sha256: createHash("sha256").update(Buffer.from(ewkb, "hex")).digest("hex") };
  };
  const boundary = await project(metric.boundary_metric_wkt);
  const features = [];
  for (const row of metric.source_features) {
    const { metric_wkt, ...identity } = row;
    features.push({ ...identity, geometry: await project(metric_wkt) });
  }
  return { variant, boundary, features, expected: metric.expected };
}

// The accepted general canonical helper has a 1.5MB ceiling; these small
// fixtures deliberately fit beneath it. Production kernel budgets are separate.
const digest = assessmentEvidenceDigest;
const orderedRefs = refs => [...refs].sort((a, b) => a.source_ref < b.source_ref ? -1 : a.source_ref > b.source_ref ? 1
  : a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);

export function landUseFixtureFeatureContext(feature) {
  return {
    semantics: feature.semantics,
    classification: { ...feature.classification, evidence_refs: orderedRefs(feature.classification.evidence_refs) },
    fact_validity: feature.fact_validity,
    historical_availability: feature.historical_availability,
  };
}

export function rehashLandUseFixtureSnapshot(snapshot) {
  const { content_sha256: _previous, ...manifest } = snapshot;
  manifest.records = [...manifest.records].sort((a, b) => a.source_record_id < b.source_record_id ? -1 : a.source_record_id > b.source_record_id ? 1 : 0);
  snapshot.records = manifest.records;
  snapshot.content_sha256 = digest(manifest);
  return snapshot;
}

export function rebindLandUseFixtureFeature(input, id) {
  const feature = input.features.find(row => row.id === id);
  if (!feature) throw new TypeError("unknown_synthetic_feature");
  const source = input.source_snapshots.find(row => row.id === feature.source_ref);
  const record = source?.records.find(row => row.source_record_id === feature.source_record_id);
  if (!record) throw new TypeError("unknown_synthetic_source_record");
  record.geometry_sha256 = feature.geometry.content_sha256;
  record.context_sha256 = digest(landUseFixtureFeatureContext(feature));
  return rehashLandUseFixtureSnapshot(source);
}

/** Returns {input, expected, metric}; only input may be passed to the kernel.
 * Projection always occurs through the caller's injected query adapter. The
 * fixture declares synthetic evidence support; it does not mint authorization.
 */
export async function buildNeighborhoodPostgisLandUseFixture(adapter, variant = "base") {
  const projected = await projectNeighborhoodLandUseFixture(adapter, variant);
  const scope = { ...ASSESSMENT_SCOPE };
  const sourceId = "synthetic-land-use-capture";
  const validity = () => ({ valid_from: "2024-01-01", valid_to: null });
  const availability = () => ({ status: "supported", available_at: "2024-01-01T00:00:00.000Z" });
  const ref = source_record_id => ({ source_ref: sourceId, source_record_id });
  const features = projected.features.map(feature => ({
    id: feature.id, source_ref: sourceId, source_record_id: `source:${feature.id}`,
    geometry: feature.geometry, semantics: feature.semantics,
    classification: { status: feature.classification_status, category: feature.category,
      policy_version: "synthetic-explicit-current-use-v1", evidence_refs: [ref(`source:${feature.id}`)] },
    fact_validity: validity(), historical_availability: availability(),
  }));
  const snapshot = {
    id: sourceId, revision: `synthetic-capture:${variant}:1`, scope: { ...scope },
    captured_at: "2024-07-01T00:00:00.000Z", state: "complete",
    records: [{ source_record_id: "source:boundary", record_sha256: digest({ synthetic_boundary: projected.boundary }),
      geometry_sha256: null, context_sha256: null }, ...features.map(feature => ({
      source_record_id: feature.source_record_id,
      record_sha256: digest({ synthetic_source_record: feature.id, geometry: feature.geometry, context: landUseFixtureFeatureContext(feature) }),
      geometry_sha256: feature.geometry.content_sha256,
      context_sha256: digest(landUseFixtureFeatureContext(feature)),
    }))],
  };
  rehashLandUseFixtureSnapshot(snapshot);
  return {
    input: {
      partition_version: "postgis-land-use-partition-v1", scope,
      effective_date: "2024-06-30", knowledge_cutoff: "2024-07-02T00:00:00.000Z",
      boundary: { role: "geographic_neighborhood", revision: `synthetic-boundary:${variant}:1`, geometry: projected.boundary,
        source_refs: [ref("source:boundary")], selection_evidence_sha256: digest({ synthetic_selection: "descriptive-A", variant }),
        fact_validity: validity(), historical_availability: availability() },
      source_snapshots: [snapshot], features,
      policy: { version: "synthetic-partition-policy-v1", metric_srid: 26914,
        overlap: "unresolved_conflict", numerical_tolerance_version: "area-conservation-v1" },
    },
    expected: projected.expected,
    metric: neighborhoodLandUseMetricFixture(variant),
  };
}
