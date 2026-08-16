import { getPropertyContextSourceHealth } from "./propertyContextStore.js";

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(value, total) {
  const denominator = finiteNumber(total);
  if (denominator <= 0) return 0;
  return Math.round((finiteNumber(value) / denominator) * 1_000) / 10;
}

function normalizeCounty(value) {
  return String(value || "Dallas")
    .trim()
    .replace(/\s+county$/i, "") || "Dallas";
}

function sourceByKey(sources, key) {
  return sources.find((source) => source.source_key === key) || null;
}

function sourceUsable(sources, key) {
  return sourceByKey(sources, key)?.usable === true;
}

function sourceCurrent(sources, key) {
  return sourceByKey(sources, key)?.status === "current";
}

const readinessCacheByPool = new WeakMap();

export function evaluateNeighborhoodEngineReadiness({
  county,
  accounts = {},
  sales = {},
  roads = [],
  zoning = {},
  sourceHealth = [],
} = {}) {
  const totalAccounts = finiteNumber(accounts.total_accounts);
  const accountCoverage = {
    parcel_geometry_percent: percent(accounts.parcel_accounts, totalAccounts),
    year_built_percent: percent(accounts.year_built_accounts, totalAccounts),
    site_size_percent: percent(accounts.site_size_accounts, totalAccounts),
    coordinate_percent: percent(accounts.coordinate_accounts, totalAccounts),
  };
  const usableSales = finiteNumber(sales.usable_sales);
  const salesCoverage = {
    usable_sales: usableSales,
    distinct_sale_accounts: finiteNumber(sales.distinct_sale_accounts),
    coordinate_percent: percent(sales.coordinate_sales, usableSales),
    year_built_percent: percent(sales.year_built_sales, usableSales),
    site_size_percent: percent(sales.site_size_sales, usableSales),
    price_percent: percent(sales.price_sales, usableSales),
  };
  const roadCounts = Object.fromEntries(
    roads.map((row) => [row.road_class, finiteNumber(row.segment_count)]),
  );
  const requiredRoadsAvailable =
    finiteNumber(roadCounts.primary) > 0 && finiteNumber(roadCounts.secondary) > 0;
  const trafficAvailable = finiteNumber(roads.find(
    (row) => row.road_class === "txdot_aadt",
  )?.segment_count) > 0;
  const zoningAvailable = finiteNumber(zoning.provider_count) > 0 &&
    finiteNumber(zoning.district_count) > 0;
  const prototypeChecks = {
    account_inventory: totalAccounts >= 100,
    parcel_geometry: accountCoverage.parcel_geometry_percent >= 60,
    year_built: accountCoverage.year_built_percent >= 50,
    site_size: accountCoverage.site_size_percent >= 60,
    account_coordinates: accountCoverage.coordinate_percent >= 60,
    usable_sales: usableSales >= 30,
    sale_coordinates: salesCoverage.coordinate_percent >= 60,
    roads: requiredRoadsAvailable,
    traffic: trafficAvailable,
    zoning: zoningAvailable,
  };
  const productionChecks = {
    account_inventory: totalAccounts >= 100,
    parcel_geometry: accountCoverage.parcel_geometry_percent >= 95,
    year_built: accountCoverage.year_built_percent >= 80,
    site_size: accountCoverage.site_size_percent >= 90,
    account_coordinates: accountCoverage.coordinate_percent >= 90,
    usable_sales: usableSales >= 100,
    sale_coordinates: salesCoverage.coordinate_percent >= 90,
    sale_year_built: salesCoverage.year_built_percent >= 80,
    sale_site_size: salesCoverage.site_size_percent >= 80,
    roads: requiredRoadsAvailable &&
      sourceCurrent(sourceHealth, "tiger_roads_primary") &&
      sourceCurrent(sourceHealth, "tiger_roads_secondary"),
    traffic: trafficAvailable && sourceCurrent(sourceHealth, "txdot_aadt"),
    zoning: zoningAvailable,
  };
  const prototypeBlockers = Object.entries(prototypeChecks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  const productionBlockers = Object.entries(productionChecks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);
  const warnings = [];
  if (!sourceUsable(sourceHealth, "dcad_parcels")) {
    warnings.push("The local Dallas CAD parcel mirror is unavailable.");
  }
  const staleSources = sourceHealth.filter((source) => source.serving_stale_data);
  if (staleSources.length) {
    warnings.push(`Last-known-good data is being served for: ${staleSources.map(
      (source) => source.label || source.source_key,
    ).join(", ")}.`);
  }
  if (salesCoverage.coordinate_percent < 90) {
    warnings.push("Some otherwise usable sales cannot participate in spatial relevance analysis until coordinates are available.");
  }
  if (accountCoverage.year_built_percent < 80 || accountCoverage.site_size_percent < 90) {
    warnings.push("Physical-characteristic coverage is below the production target for low-review automation.");
  }
  return {
    county: `${normalizeCounty(county)} County`,
    measured_at: new Date().toISOString(),
    prototype_ready: prototypeBlockers.length === 0,
    production_ready: productionBlockers.length === 0,
    prototype_blockers: prototypeBlockers,
    production_blockers: productionBlockers,
    accounts: {
      ...Object.fromEntries(Object.entries(accounts).map(([key, value]) => [key, finiteNumber(value)])),
      coverage: accountCoverage,
    },
    sales: salesCoverage,
    roads: {
      segment_counts: roadCounts,
      required_roads_available: requiredRoadsAvailable,
      traffic_available: trafficAvailable,
    },
    zoning: {
      provider_count: finiteNumber(zoning.provider_count),
      district_count: finiteNumber(zoning.district_count),
      available: zoningAvailable,
    },
    source_health: sourceHealth,
    warnings,
  };
}

export async function getNeighborhoodEngineReadiness(
  pool,
  {
    county = "Dallas",
    cacheTtlMs = 15 * 60 * 1_000,
    now = () => Date.now(),
  } = {},
) {
  const normalizedCounty = normalizeCounty(county);
  if (normalizedCounty.toLowerCase() !== "dallas") {
    throw new Error("neighborhood_engine_county_not_configured");
  }
  const cachedByCounty = readinessCacheByPool.get(pool);
  const cached = cachedByCounty?.get(normalizedCounty.toLowerCase());
  if (cached && now() - cached.cached_at < cacheTtlMs) {
    return { ...cached.value, cache_hit: true };
  }
  const [accountResult, saleResult, roadResult, trafficResult, zoningResult, sourceHealth] =
    await Promise.all([
      pool.query(
        `WITH county_accounts AS (
           SELECT account.account_id
           FROM core.accounts account
           WHERE REGEXP_REPLACE(LOWER(BTRIM(account.county)), '\\s+county$', '') = LOWER($1)
         ), parcel_match AS (
           SELECT DISTINCT ON (account.account_id)
                  account.account_id,
                  parcel.object_id,
                  parcel.residential_year_built,
                  parcel.parcel_area_sqft
           FROM county_accounts account
           LEFT JOIN gis.dcad_parcels parcel
             ON parcel.account_id = account.account_id
             OR parcel.low_parcel_id = account.account_id
           ORDER BY account.account_id,
                    (parcel.account_id = account.account_id) DESC,
                    parcel.parcel_area_sqft ASC NULLS LAST
         )
         SELECT
           COUNT(*)::bigint AS total_accounts,
           COUNT(parcel_match.object_id)::bigint AS parcel_accounts,
           COUNT(*) FILTER (WHERE parcel_match.residential_year_built > 0)::bigint AS year_built_accounts,
           COUNT(*) FILTER (WHERE parcel_match.parcel_area_sqft > 0)::bigint AS site_size_accounts,
           COUNT(*) FILTER (
             WHERE location.location_geom IS NOT NULL
                OR (location.latitude IS NOT NULL AND location.longitude IS NOT NULL)
           )::bigint AS coordinate_accounts
         FROM county_accounts account
         LEFT JOIN parcel_match ON parcel_match.account_id = account.account_id
         LEFT JOIN core.account_locations location ON location.account_id = account.account_id`,
        [normalizedCounty],
      ),
      pool.query(
        `SELECT
           COUNT(*)::bigint AS usable_sales,
           COUNT(DISTINCT sale.primary_account_id)::bigint AS distinct_sale_accounts,
           COUNT(*) FILTER (WHERE sale.sale_price > 0)::bigint AS price_sales,
           COUNT(*) FILTER (
             WHERE location.location_geom IS NOT NULL
                OR (location.latitude IS NOT NULL AND location.longitude IS NOT NULL)
           )::bigint AS coordinate_sales,
           COUNT(*) FILTER (
             WHERE COALESCE(sale.mls_year_built, sale.cad_effective_year_built, sale.cad_year_built) > 0
           )::bigint AS year_built_sales,
           COUNT(*) FILTER (
             WHERE parcel.parcel_area_sqft > 0
           )::bigint AS site_size_sales
         FROM core.v_sales_enriched sale
         JOIN core.accounts account ON account.account_id = sale.primary_account_id
         LEFT JOIN core.account_locations location ON location.account_id = sale.primary_account_id
         LEFT JOIN LATERAL (
           SELECT candidate.parcel_area_sqft
           FROM gis.dcad_parcels candidate
           WHERE candidate.account_id = sale.primary_account_id
              OR candidate.low_parcel_id = sale.primary_account_id
           ORDER BY (candidate.account_id = sale.primary_account_id) DESC,
                    candidate.parcel_area_sqft ASC NULLS LAST
           LIMIT 1
         ) parcel ON TRUE
         WHERE sale.record_type = 'closed_sale'
           AND sale.closing_date >= CURRENT_DATE - INTERVAL '36 months'
           AND REGEXP_REPLACE(LOWER(BTRIM(account.county)), '\\s+county$', '') = LOWER($1)`,
        [normalizedCounty],
      ),
      pool.query(
        `SELECT road_class, COUNT(*)::bigint AS segment_count
         FROM gis.road_segments
         GROUP BY road_class
         ORDER BY road_class`,
      ),
      pool.query(
        `SELECT 'txdot_aadt'::text AS road_class, COUNT(*)::bigint AS segment_count
         FROM gis.traffic_volume_segments
         WHERE current_aadt IS NOT NULL`,
      ),
      pool.query(
        `SELECT COUNT(DISTINCT provider_key)::bigint AS provider_count,
                COUNT(*)::bigint AS district_count
         FROM gis.zoning_districts
         WHERE LOWER(jurisdiction) IN (
           SELECT DISTINCT LOWER(BTRIM(city))
           FROM core.accounts
           WHERE REGEXP_REPLACE(LOWER(BTRIM(county)), '\\s+county$', '') = LOWER($1)
             AND NULLIF(BTRIM(city), '') IS NOT NULL
         )`,
        [normalizedCounty],
      ),
      getPropertyContextSourceHealth(pool),
    ]);
  const value = evaluateNeighborhoodEngineReadiness({
    county: normalizedCounty,
    accounts: accountResult.rows[0] || {},
    sales: saleResult.rows[0] || {},
    roads: [...roadResult.rows, ...trafficResult.rows],
    zoning: zoningResult.rows[0] || {},
    sourceHealth,
  });
  const nextCache = cachedByCounty || new Map();
  nextCache.set(normalizedCounty.toLowerCase(), { cached_at: now(), value });
  if (!cachedByCounty) readinessCacheByPool.set(pool, nextCache);
  return { ...value, cache_hit: false };
}
