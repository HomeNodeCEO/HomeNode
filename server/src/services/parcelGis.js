import { assertNonDallasEnrichmentCounty } from "../util/nonDallasEnrichment.js";
import { esriGeometryToGeoJson, geoJsonAreaSquareFeet } from "../util/parcelArea.js";

export const COUNTY_GIS_CONFIG = Object.freeze({
  COLLIN: {
    url: "https://services2.arcgis.com/uXyoacYrZTPTKD3R/ArcGIS/rest/services/CCAD_Parcel_Feature_Set/FeatureServer/4/query",
    idFields: ["geoID", "propID"],
  },
  DENTON: {
    url: "https://geo.dentoncad.com/arcgis/rest/services/LandRecords/Parcel_Standalone/FeatureServer/14/query",
    idFields: ["prop_id"],
  },
  ROCKWALL: {
    url: "https://gis.rockwall.com/arcgis/rest/services/Parcels_CM/MapServer/0/query",
    idFields: ["prop_id"],
  },
  TARRANT: {
    url: "https://mapit.tarrantcounty.com/arcgis/rest/services/Tax/TCProperty/MapServer/0/query",
    idFields: ["ACCOUNT", "TAXPIN"],
  },
});

function quoteArcGisValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function countyGisConfiguration(county, env = process.env) {
  const normalized = assertNonDallasEnrichmentCounty(county);
  const envPrefix = `${normalized}_GIS_`;
  const customUrl = String(env[`${envPrefix}QUERY_URL`] || "").trim();
  const customFields = String(env[`${envPrefix}ACCOUNT_FIELDS`] || "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
  const base = COUNTY_GIS_CONFIG[normalized];
  const url = customUrl || base?.url || "";
  const idFields = customFields.length ? customFields : (base?.idFields || []);
  return { county: normalized, configured: Boolean(url && idFields.length), url, idFields };
}

export async function fetchParcelAreaSuggestion({ county, accountId, env = process.env, fetchImpl = globalThis.fetch }) {
  const config = countyGisConfiguration(county, env);
  if (!config.configured) throw new Error("county_gis_not_configured");
  const account = String(accountId ?? "").trim();
  if (!account) throw new Error("missing_account_id");
  const where = config.idFields
    .map((field) => `${field} = ${quoteArcGisValue(account)}`)
    .join(" OR ");
  const url = new URL(config.url);
  url.search = new URLSearchParams({
    f: "json",
    where,
    outFields: config.idFields.join(","),
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "2",
  }).toString();
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`county_gis_http_${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error("county_gis_query_failed");
  const features = payload?.features || [];
  if (!features.length) return null;
  if (features.length > 1) throw new Error("county_gis_multiple_parcels");
  const geometry = esriGeometryToGeoJson(features[0].geometry);
  const areaSquareFeet = geoJsonAreaSquareFeet(geometry);
  return {
    county: config.county,
    account_id: account,
    source_url: config.url,
    source_attributes: features[0].attributes || {},
    geometry,
    area_square_feet: Math.round(areaSquareFeet),
    area_acres: areaSquareFeet / 43_560,
    status: "pending",
  };
}
