import { OFFICIAL_ZONING_SOURCES } from "../../src/services/propertyZoningSources.js";
import { ASSESSMENT_SCOPE } from "./neighborhoodAssessmentFixture.js";

// No driver imports or connection creation. The caller supplies an already
// isolated query adapter and the canonical schema from propertyContextStore.js:
// source_sync_runs/state (lines 79/95), dcad_parcels (113), road_segments
// (155), traffic_volume_segments (227), zoning registry/districts (248/306).
// ensurePropertyContextSchema performs local DDL/static registry
// writes only; it does not invoke sync workers or fetch provider data.
// Coordinates are synthetic EPSG:4326 WKT, not a metric-area reference fixture.
const polygon = (w, s, e, n) => `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
const zone = OFFICIAL_ZONING_SOURCES[0];
const parcelIds = ["9007199254740992", "9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"];
const keys = ["dcad_parcels", "tiger_roads_primary", "txdot_aadt", zone.sourceKey, "tiger_roads_local"];
const urls = [
  "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query",
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer/0/query",
  "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT/FeatureServer/0/query",
  zone.url,
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer/2/query",
];
const runIds = Object.fromEntries(keys.map((key, index) => [key, {
  older: `91000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`,
  latest: `91000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, "0")}`,
}]));

export const NEIGHBORHOOD_GIS_POSTGIS_FIXTURE = Object.freeze({
  scope: Object.freeze({ ...ASSESSMENT_SCOPE }),
  bounds: Object.freeze({ west: -97.01, south: 32.99, east: -96.99, north: 33.01 }),
  sourceKeys: Object.freeze(keys.slice(0, 4)),
  parcelIds: Object.freeze(parcelIds),
  subjectIds: Object.freeze(parcelIds.slice(0, 2)),
  insideParcelIds: Object.freeze(parcelIds.slice(0, 3)),
  outsideAccount: "SYNTHETIC-GIS-OUTSIDE",
  emptySourceKey: "tiger_roads_local", missingStateSourceKey: "tiger_roads_secondary",
  zone, runIds,
  zoningIds: Object.freeze(["Z-1", "\uE000", "\u{1F600}"]),
  // Both sort before Z-1 in PostgreSQL C order. Null-last sorting of a bounded
  // display ID could otherwise skip these rows and falsely claim exhaustion.
  malformedZoningIds: Object.freeze(["0".repeat(141), `0${"é".repeat(128)}`]),
  insideWkt: polygon(-97.008, 32.992, -97.006, 32.994),
  outsideWkt: polygon(-96.985, 33.012, -96.98, 33.017),
});

/** Seed once in a fresh isolated database; accepts query(text, values) or {query}.
 * No cleanup, deletes, provider operations or transaction ownership are hidden.
 * Canonical source tables must already exist. All inserted facts are synthetic.
 */
export async function seedNeighborhoodGisPostgisFixture(adapter) {
  const query = typeof adapter === "function" ? adapter : (text, values = []) => adapter.query(text, values);
  const fixture = NEIGHBORHOOD_GIS_POSTGIS_FIXTURE;
  const oldStart = "2024-01-01T00:00:00.000Z", oldEnd = "2024-01-02T00:00:00.000Z";
  const newStart = "2024-02-01T00:00:00.000Z", newEnd = "2024-02-02T00:00:00.000Z";
  const counts = [5, 2, 2, 5, 0];
  for (const [index, key] of keys.entries()) {
    for (const [revision, mode, started, completed] of [["older", "full", oldStart, oldEnd], ["latest", "incremental", newStart, newEnd]]) {
      await query(`INSERT INTO gis.source_sync_runs(id, source_key, mode, status, started_at, completed_at)
        VALUES($1::uuid,$2,$3,'complete',$4::timestamptz,$5::timestamptz)`, [runIds[key][revision], key, mode, started, completed]);
    }
    await query(`INSERT INTO gis.source_sync_state(source_key, source_label, status, source_url, source_vintage,
      row_count, last_attempt_at, last_success_at, last_run_id)
      VALUES($1,$2,'current',$3,'synthetic-2024',$4,$5::timestamptz,$6::timestamptz,$7::uuid)`,
    [key, `Synthetic ${key}`, urls[index], counts[index], newStart, newEnd, runIds[key].latest]);
  }
  await query(`UPDATE gis.zoning_source_registry SET status='current', last_success_at=$2::timestamptz
    WHERE provider_key=$1`, [zone.providerKey, newEnd]);

  const geometries = [
    fixture.insideWkt,
    "MULTIPOLYGON(((-97.004 32.996,-97.002 32.996,-97.002 32.998,-97.004 32.998,-97.004 32.996)),((-97.008 33.002,-97.006 33.002,-97.006 33.004,-97.008 33.004,-97.008 33.002)))",
    polygon(-96.995, 33.005, -96.989, 33.008), // Actual boundary intersection; retain the full source geometry.
    fixture.outsideWkt,
    // Its bbox contains the envelope, but the actual polygon has a hole that
    // contains the entire envelope. A bbox-only selection must not capture it.
    "POLYGON((-97.04 32.96,-96.96 32.96,-96.96 33.04,-97.04 33.04,-97.04 32.96),(-97.02 32.98,-97.02 33.02,-96.98 33.02,-96.98 32.98,-97.02 32.98))",
  ];
  const padding = "SYNTHETIC-FIXTURE-".repeat(160);
  // Keep the unsafe-for-JS integer literal as JSON text until PostgreSQL stores
  // it; the reader must return the source JSONB as text without numeric rounding.
  const attributes = `{"fixture":"neighborhood-gis-native-v1","precise":9007199254740993,"padding":${JSON.stringify(padding)}}`;
  for (const [index, id] of parcelIds.entries()) {
    const account = index < 2 ? fixture.scope.account_id : index === 3 ? fixture.outsideAccount : `SYNTHETIC-GIS-P${index}`;
    await query(`INSERT INTO gis.dcad_parcels(object_id,account_id,site_address,property_description,
      source_attributes,source_record_hash,sync_run_id,synced_at,geom)
      VALUES($1::bigint,$2,$3,$4,$5::jsonb,$6,$7::uuid,$8::timestamptz,ST_Multi(ST_GeomFromText($9,4326)))`,
    [id, account, index === 2 ? "Synthetic before" : `Synthetic parcel ${index}`, `Synthetic parcel ${index}`,
      attributes, `synthetic-parcel-${index}`, runIds.dcad_parcels.older, oldEnd, geometries[index]]);
  }
  for (const [index, wkt] of ["LINESTRING(-97.02 33,-96.98 33)", "LINESTRING(-96.98 33.02,-96.97 33.03)"].entries()) {
    await query(`INSERT INTO gis.road_segments(source_layer,source_object_id,name,road_class,source_record_hash,sync_run_id,synced_at,geom)
      VALUES('tiger_roads_primary',$1::bigint,$2,'primary',$3,$4::uuid,$5::timestamptz,ST_Multi(ST_GeomFromText($6,4326)))`,
    [String(9007199254741000n + BigInt(index)), `Synthetic road ${index}`, `synthetic-road-${index}`, runIds.tiger_roads_primary.older, oldEnd, wkt]);
  }
  for (const [index, wkt] of ["LINESTRING(-97 32.985,-97 33.015)", "LINESTRING(-96.98 33.02,-96.97 33.03)"].entries()) {
    await query(`INSERT INTO gis.traffic_volume_segments(source_key,source_object_id,route_name,current_aadt,source_record_hash,sync_run_id,synced_at,geom)
      VALUES('txdot_aadt',$1::bigint,$2,1234,$3,$4::uuid,$5::timestamptz,ST_Multi(ST_GeomFromText($6,4326)))`,
    [String(33 + index), `Synthetic traffic ${index}`, `synthetic-traffic-${index}`, runIds.txdot_aadt.older, oldEnd, wkt]);
  }
  for (const [index, id] of [...fixture.zoningIds, ...fixture.malformedZoningIds].entries()) {
    await query(`INSERT INTO gis.zoning_districts(provider_key,source_record_id,jurisdiction,zoning_code,
      source_record_hash,sync_run_id,synced_at,geom)
      VALUES($1,$2,'Synthetic jurisdiction','R-SYNTHETIC',$3,$4::uuid,$5::timestamptz,ST_Multi(ST_GeomFromText($6,4326)))`,
    [zone.providerKey, id, `synthetic-zone-${index}`, runIds[zone.sourceKey].older, oldEnd,
      index < fixture.zoningIds.length ? fixture.insideWkt : fixture.outsideWkt]);
  }
  return fixture;
}
