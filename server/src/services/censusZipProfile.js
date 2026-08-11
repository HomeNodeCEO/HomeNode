const DEFAULT_ACS_YEAR = "2024";
const UNEMPLOYMENT_VARIABLE = "DP03_0009PE";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const profileCache = new Map();
const placeTableCache = new Map();
const TEXAS_STATE_FIPS = "48";

function serviceError(code, status = 500) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export function normalizeCensusZip(value) {
  const zip = String(value || "").replace(/\D/g, "").slice(0, 5);
  if (!/^\d{5}$/.test(zip)) throw serviceError("invalid_census_zip", 400);
  return zip;
}

export function normalizeCensusCity(value) {
  const city = String(value || "").trim().replace(/\s+/g, " ");
  if (!city || city.length > 100 || !/^[a-zA-Z0-9 .'-]+$/.test(city)) {
    throw serviceError("invalid_census_city", 400);
  }
  return city;
}

function normalizeState(value) {
  const state = String(value || "TX").trim().toUpperCase();
  if (["TX", "TEXAS", TEXAS_STATE_FIPS].includes(state)) {
    return { abbreviation: "TX", fips: TEXAS_STATE_FIPS };
  }
  throw serviceError("unsupported_census_state", 400);
}

function comparablePlaceName(value) {
  return String(value || "")
    .split(",")[0]
    .replace(/\s+(city|town|village|municipality|borough|cdp)$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export async function fetchCensusZipProfile(
  postalCode,
  {
    apiKey = process.env.CENSUS_API_KEY,
    datasetYear = process.env.CENSUS_ACS_YEAR || DEFAULT_ACS_YEAR,
    fetchImpl = fetch,
    now = Date.now(),
    useCache = true,
  } = {},
) {
  const zip = normalizeCensusZip(postalCode);
  const year = String(datasetYear || DEFAULT_ACS_YEAR).trim();
  if (!/^20\d{2}$/.test(year)) throw serviceError("invalid_census_acs_year", 500);
  const key = String(apiKey || "").trim();
  if (!key) throw serviceError("census_api_key_not_configured", 503);

  const cacheKey = `${year}:${zip}`;
  const cached = profileCache.get(cacheKey);
  if (useCache && cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const url = new URL(`https://api.census.gov/data/${year}/acs/acs5/profile`);
  url.searchParams.set("get", `NAME,${UNEMPLOYMENT_VARIABLE}`);
  url.searchParams.set("for", `zip code tabulation area:${zip}`);
  url.searchParams.set("key", key);
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "HomeNode neighborhood-characteristics/1.0",
    },
  });
  if (!response.ok) throw serviceError(`census_zip_profile_http_${response.status}`, 502);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw serviceError("census_zip_profile_invalid_response", 502);
  }
  const headers = Array.isArray(payload?.[0]) ? payload[0] : [];
  const row = Array.isArray(payload?.[1]) ? payload[1] : [];
  const valueIndex = headers.indexOf(UNEMPLOYMENT_VARIABLE);
  const nameIndex = headers.indexOf("NAME");
  const unemploymentRate = Number(row[valueIndex]);
  if (valueIndex < 0 || !Number.isFinite(unemploymentRate) || unemploymentRate < 0 || unemploymentRate > 100) {
    throw serviceError("census_zip_profile_unemployment_unavailable", 422);
  }

  const value = {
    postal_code: zip,
    geography_name: nameIndex >= 0 ? String(row[nameIndex] || "") || null : null,
    unemployment_percent: unemploymentRate,
    dataset: "ACS 5-Year Data Profiles",
    dataset_year: Number(year),
    variable: UNEMPLOYMENT_VARIABLE,
    source: "U.S. Census Bureau",
    retrieved_at: new Date(now).toISOString(),
  };
  if (useCache) profileCache.set(cacheKey, { cachedAt: now, value });
  return value;
}

/**
 * Load the official ACS place-level unemployment estimate for the subject city.
 * ACS place codes are not reliably present in CAD data, so the service resolves
 * the city name against the state's place table and caches that result for a day.
 */
export async function fetchCensusCityProfile(
  cityName,
  state = "TX",
  {
    apiKey = process.env.CENSUS_API_KEY,
    datasetYear = process.env.CENSUS_ACS_YEAR || DEFAULT_ACS_YEAR,
    fetchImpl = fetch,
    now = Date.now(),
    useCache = true,
  } = {},
) {
  const city = normalizeCensusCity(cityName);
  const resolvedState = normalizeState(state);
  const year = String(datasetYear || DEFAULT_ACS_YEAR).trim();
  if (!/^20\d{2}$/.test(year)) throw serviceError("invalid_census_acs_year", 500);
  const key = String(apiKey || "").trim();
  if (!key) throw serviceError("census_api_key_not_configured", 503);

  const cityKey = comparablePlaceName(city);
  const cacheKey = `${year}:${resolvedState.fips}:place:${cityKey}`;
  const cached = profileCache.get(cacheKey);
  if (useCache && cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const placeTableKey = `${year}:${resolvedState.fips}:places`;
  const cachedPlaceTable = placeTableCache.get(placeTableKey);
  let payload = useCache && cachedPlaceTable && now - cachedPlaceTable.cachedAt < CACHE_TTL_MS
    ? cachedPlaceTable.value
    : null;
  if (!payload) {
    const url = new URL(`https://api.census.gov/data/${year}/acs/acs5/profile`);
    url.searchParams.set("get", `NAME,${UNEMPLOYMENT_VARIABLE}`);
    url.searchParams.set("for", "place:*");
    url.searchParams.set("in", `state:${resolvedState.fips}`);
    url.searchParams.set("key", key);
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "user-agent": "HomeNode neighborhood-characteristics/1.0",
      },
    });
    if (!response.ok) throw serviceError(`census_city_profile_http_${response.status}`, 502);
    try {
      payload = await response.json();
    } catch {
      throw serviceError("census_city_profile_invalid_response", 502);
    }
    if (useCache) placeTableCache.set(placeTableKey, { cachedAt: now, value: payload });
  }
  const headers = Array.isArray(payload?.[0]) ? payload[0] : [];
  const nameIndex = headers.indexOf("NAME");
  const valueIndex = headers.indexOf(UNEMPLOYMENT_VARIABLE);
  const placeIndex = headers.indexOf("place");
  const row = (Array.isArray(payload) ? payload.slice(1) : []).find(
    (candidate) => Array.isArray(candidate) && comparablePlaceName(candidate[nameIndex]) === cityKey,
  );
  if (!row) throw serviceError("census_city_profile_not_found", 404);
  const unemploymentRate = Number(row[valueIndex]);
  if (valueIndex < 0 || !Number.isFinite(unemploymentRate) || unemploymentRate < 0 || unemploymentRate > 100) {
    throw serviceError("census_city_profile_unemployment_unavailable", 422);
  }

  const value = {
    city,
    state: resolvedState.abbreviation,
    state_fips: resolvedState.fips,
    place_code: placeIndex >= 0 ? String(row[placeIndex] || "") || null : null,
    geography_name: nameIndex >= 0 ? String(row[nameIndex] || "") || null : null,
    unemployment_percent: unemploymentRate,
    dataset: "ACS 5-Year Data Profiles",
    dataset_year: Number(year),
    variable: UNEMPLOYMENT_VARIABLE,
    source: "U.S. Census Bureau",
    retrieved_at: new Date(now).toISOString(),
  };
  if (useCache) profileCache.set(cacheKey, { cachedAt: now, value });
  return value;
}

export const censusZipProfileInternals = {
  DEFAULT_ACS_YEAR,
  UNEMPLOYMENT_VARIABLE,
  profileCache,
  placeTableCache,
  comparablePlaceName,
};
