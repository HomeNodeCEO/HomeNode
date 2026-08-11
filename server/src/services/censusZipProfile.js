const DEFAULT_ACS_YEAR = "2024";
const UNEMPLOYMENT_VARIABLE = "DP03_0009PE";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const profileCache = new Map();

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

export const censusZipProfileInternals = {
  DEFAULT_ACS_YEAR,
  UNEMPLOYMENT_VARIABLE,
  profileCache,
};
