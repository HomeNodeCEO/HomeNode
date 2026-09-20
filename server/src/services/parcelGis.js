import { assertNonDallasEnrichmentCounty } from "../util/nonDallasEnrichment.js";
import { esriGeometryToGeoJson, geoJsonAreaSquareFeet } from "../util/parcelArea.js";
import { readBoundedJsonResponse } from "../util/boundedResponse.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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

function countyGisUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("county_gis_invalid_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("county_gis_invalid_url");
  }
  return url;
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
  const url = countyGisUrl(config.url);
  url.search = new URLSearchParams({
    f: "json",
    where,
    outFields: config.idFields.join(","),
    returnGeometry: "true",
    outSR: "4326",
    resultRecordCount: "2",
  }).toString();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("county_gis_unavailable");
  }
  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : "unknown";
    throw new Error(`county_gis_http_${status}`);
  }
  let payload;
  try {
    payload = await readBoundedJsonResponse(response, {
      maximumBytes: MAX_RESPONSE_BYTES,
      tooLargeCode: "county_gis_response_too_large",
      unavailableCode: "county_gis_response_unavailable",
    });
  } catch (error) {
    const code = String(error?.message || "");
    if (["county_gis_response_too_large", "county_gis_response_unavailable"].includes(code)) {
      throw new Error(code);
    }
    throw new Error("county_gis_invalid_response");
  }
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

export const parcelGisInternals = Object.freeze({
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  countyGisUrl,
});
