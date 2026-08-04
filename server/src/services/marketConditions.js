import {
  ensureAccountLocationsTable,
  refreshAccountLocations,
} from "./accountLocations.js";

export const MARKET_AREA_KEYS = Object.freeze([
  "city",
  "zip",
  "radius_1",
  "radius_2",
  "radius_3",
  "radius_4",
  "radius_5",
  "custom",
]);

const AREA_BY_KEY = new Map([
  ["city", { key: "city", scope: "city", radiusMiles: null }],
  ["zip", { key: "zip", scope: "zip", radiusMiles: null }],
  ["radius_1", { key: "radius_1", scope: "radius", radiusMiles: 1 }],
  ["radius_2", { key: "radius_2", scope: "radius", radiusMiles: 2 }],
  ["radius_3", { key: "radius_3", scope: "radius", radiusMiles: 3 }],
  ["radius_4", { key: "radius_4", scope: "radius", radiusMiles: 4 }],
  ["radius_5", { key: "radius_5", scope: "radius", radiusMiles: 5 }],
  ["custom", { key: "custom", scope: "custom", radiusMiles: null }],
]);

const DFW_BOUNDS = Object.freeze({
  minimumLongitude: -100.5,
  maximumLongitude: -95,
  minimumLatitude: 31.5,
  maximumLatitude: 34.5,
});

const MAX_CUSTOM_VERTICES = 500;
const MAX_CUSTOM_AREA_SQUARE_MILES = 5000;

function centralDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function utcDateString(value) {
  return value.toISOString().slice(0, 10);
}

export function completeCalendarMonthWindow(
  asOfDate = "",
  periodMonths = 24,
  fallbackNow = new Date(),
) {
  const parsedPeriodMonths = Number(periodMonths);
  if (![12, 24, 36].includes(parsedPeriodMonths)) {
    throw new Error("invalid_market_period");
  }

  const analysisAsOf = String(asOfDate || centralDateString(fallbackNow)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(analysisAsOf)) {
    throw new Error("invalid_as_of");
  }
  const [year, month, day] = analysisAsOf.split("-").map(Number);
  const requestedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    requestedDate.getUTCFullYear() !== year ||
    requestedDate.getUTCMonth() !== month - 1 ||
    requestedDate.getUTCDate() !== day
  ) {
    throw new Error("invalid_as_of");
  }

  const lastDayOfRequestedMonth = new Date(
    Date.UTC(year, month, 0),
  ).getUTCDate();
  const partialMonthExcluded = day !== lastDayOfRequestedMonth;
  const periodEnd = partialMonthExcluded
    ? new Date(Date.UTC(year, month - 1, 0))
    : requestedDate;
  const periodStart = new Date(
    Date.UTC(
      periodEnd.getUTCFullYear(),
      periodEnd.getUTCMonth() - (parsedPeriodMonths - 1),
      1,
    ),
  );

  return {
    analysisAsOf,
    start: utcDateString(periodStart),
    end: utcDateString(periodEnd),
    periodMonths: parsedPeriodMonths,
    partialMonthExcluded,
  };
}

function normalizePostalCode(value) {
  return (
    String(value || "")
      .replace(/\D/g, "")
      .slice(0, 5) || null
  );
}

function normalizedCounty(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+county$/, "");
}

function areaLabel(area, subject) {
  if (area.scope === "city") {
    return [subject.city, subject.county].filter(Boolean).join(", ");
  }
  if (area.scope === "zip") {
    return `ZIP ${subject.postal_code}`;
  }
  if (area.scope === "radius") {
    return `Within ${area.radiusMiles} mile${area.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
  }
  return "Appraiser-defined market area";
}

function countPolygonVertices(coordinates) {
  if (!Array.isArray(coordinates)) return 0;
  return coordinates.reduce(
    (total, ring) => total + (Array.isArray(ring) ? ring.length : 0),
    0,
  );
}

function sameCoordinate(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    Number(left[0]) === Number(right[0]) &&
    Number(left[1]) === Number(right[1])
  );
}

export function validateCustomMarketGeometry(value) {
  const geometry =
    value?.type === "Feature" ? value.geometry : value;
  if (!geometry || geometry.type !== "Polygon") {
    throw new Error("custom_area_must_be_polygon");
  }
  if (!Array.isArray(geometry.coordinates) || !geometry.coordinates.length) {
    throw new Error("custom_area_coordinates_required");
  }

  const vertexCount = countPolygonVertices(geometry.coordinates);
  if (vertexCount < 4) {
    throw new Error("custom_area_requires_three_points");
  }
  if (vertexCount > MAX_CUSTOM_VERTICES) {
    throw new Error("custom_area_too_many_vertices");
  }

  for (const ring of geometry.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new Error("custom_area_ring_invalid");
    }
    if (!sameCoordinate(ring[0], ring[ring.length - 1])) {
      throw new Error("custom_area_ring_not_closed");
    }
    for (const coordinate of ring) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        throw new Error("custom_area_coordinate_invalid");
      }
      const longitude = Number(coordinate[0]);
      const latitude = Number(coordinate[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        throw new Error("custom_area_coordinate_invalid");
      }
      if (
        longitude < DFW_BOUNDS.minimumLongitude ||
        longitude > DFW_BOUNDS.maximumLongitude ||
        latitude < DFW_BOUNDS.minimumLatitude ||
        latitude > DFW_BOUNDS.maximumLatitude
      ) {
        throw new Error("custom_area_outside_dfw_bounds");
      }
    }
  }

  return {
    type: "Polygon",
    coordinates: geometry.coordinates.map((ring) =>
      ring.map((coordinate) => [
        Number(coordinate[0]),
        Number(coordinate[1]),
      ]),
    ),
  };
}

export function parseMarketAreaKeys(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const keys = [...new Set(raw)];
  if (!keys.length) throw new Error("market_areas_required");
  const areas = keys.map((key) => AREA_BY_KEY.get(key));
  if (areas.some((area) => !area)) {
    throw new Error("invalid_market_area");
  }
  return areas;
}

async function ensureSpatialSupport(pool) {
  await ensureAccountLocationsTable(pool);
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    ALTER TABLE core.account_locations
      ADD COLUMN IF NOT EXISTS location_geom geometry(Point, 4326);
    UPDATE core.account_locations
    SET location_geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND (
        location_geom IS NULL
        OR ST_X(location_geom) IS DISTINCT FROM longitude
        OR ST_Y(location_geom) IS DISTINCT FROM latitude
      );
    CREATE OR REPLACE FUNCTION core.sync_account_location_geom()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.location_geom :=
        CASE
          WHEN NEW.latitude IS NULL OR NEW.longitude IS NULL THEN NULL
          ELSE ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)
        END;
      RETURN NEW;
    END;
    $$;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'account_locations_sync_geom'
          AND tgrelid = 'core.account_locations'::regclass
      ) THEN
        CREATE TRIGGER account_locations_sync_geom
        BEFORE INSERT OR UPDATE OF latitude, longitude
        ON core.account_locations
        FOR EACH ROW
        EXECUTE FUNCTION core.sync_account_location_geom();
      END IF;
    END;
    $$;
    CREATE INDEX IF NOT EXISTS account_locations_geom_gist_idx
      ON core.account_locations
      USING GIST (location_geom)
      WHERE status = 'matched' AND location_geom IS NOT NULL;
  `);
}

async function loadSubject(pool, subjectAccountId) {
  const { rows } = await pool.query(
    `
      SELECT
        account.account_id,
        account.address,
        account.city,
        account.county,
        NULLIF(
          LEFT(
            REGEXP_REPLACE(COALESCE(account.postal_code, ''), '\\D', '', 'g'),
            5
          ),
          ''
        ) AS postal_code,
        account.neighborhood_code,
        location.latitude,
        location.longitude,
        location.status AS location_status,
        location.source AS location_source,
        location.precision AS location_precision,
        location.confidence AS location_confidence,
        location.review_required AS location_review_required,
        location.review_reason AS location_review_reason
      FROM core.accounts account
      LEFT JOIN core.account_locations location
        ON location.account_id = account.account_id
      WHERE account.account_id = $1
    `,
    [subjectAccountId],
  );
  return rows[0] || null;
}

export async function getMarketContext(pool, subjectAccountId) {
  if (!/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
    throw new Error("invalid_subject_account_id");
  }
  await ensureSpatialSupport(pool);
  let subject = await loadSubject(pool, subjectAccountId);
  if (!subject) throw new Error("subject_not_found");
  if (
    subject.location_status !== "matched" ||
    subject.latitude == null ||
    subject.longitude == null
  ) {
    try {
      await refreshAccountLocations(pool, [subject], { batchSize: 1 });
      subject = await loadSubject(pool, subjectAccountId);
    } catch (error) {
      console.warn(
        "[market-conditions] subject location refresh failed",
        error?.message || error,
      );
    }
  }

  return {
    account_id: subject.account_id,
    address: subject.address,
    city: subject.city,
    county: subject.county,
    postal_code: normalizePostalCode(subject.postal_code),
    neighborhood_code: subject.neighborhood_code,
    latitude:
      subject.latitude == null ? null : Number(subject.latitude),
    longitude:
      subject.longitude == null ? null : Number(subject.longitude),
    location_status: subject.location_status,
    location_source: subject.location_source,
    location_precision: subject.location_precision,
    location_confidence: subject.location_confidence,
    location_review_required: Boolean(subject.location_review_required),
    location_review_reason: subject.location_review_reason,
    context_override_active: false,
    context_override_source: null,
    context_overridden_fields: [],
    context_source_account_id: null,
    context_review_note: null,
  };
}

function optionalMarketText(value, maximumLength) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  if (normalized.length > maximumLength) {
    throw new Error("market_context_override_too_long");
  }
  return normalized;
}

/**
 * Overlay reviewable study geography without modifying the subject account.
 * Every active override is returned with provenance fields so the workfile can
 * visibly distinguish it from the stored CAD context.
 */
export function applyMarketContextOverride(subject, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return subject;
  }
  const source = optionalMarketText(value.source, 40) || "manual";
  if (!["manual", "dcad_related_parcel"].includes(source)) {
    throw new Error("invalid_market_context_override_source");
  }
  const address = optionalMarketText(value.address, 200);
  const city = optionalMarketText(value.city, 100);
  const county = optionalMarketText(value.county, 100);
  const reviewNote = optionalMarketText(value.review_note, 1000);
  const postalRaw = optionalMarketText(value.postal_code, 20);
  const postalCode = postalRaw ? normalizePostalCode(postalRaw) : null;
  if (postalRaw && (!postalCode || postalCode.length !== 5)) {
    throw new Error("invalid_market_context_postal_code");
  }
  const sourceAccountId = optionalMarketText(value.source_account_id, 50);
  if (sourceAccountId && !/^[0-9A-Za-z]{17}$/.test(sourceAccountId)) {
    throw new Error("invalid_market_context_source_account_id");
  }

  const latitudeProvided =
    value.latitude !== undefined && value.latitude !== null && value.latitude !== "";
  const longitudeProvided =
    value.longitude !== undefined && value.longitude !== null && value.longitude !== "";
  if (latitudeProvided !== longitudeProvided) {
    throw new Error("market_context_coordinates_incomplete");
  }
  const latitude = latitudeProvided ? Number(value.latitude) : null;
  const longitude = longitudeProvided ? Number(value.longitude) : null;
  if (
    latitudeProvided &&
    (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      longitude < DFW_BOUNDS.minimumLongitude ||
      longitude > DFW_BOUNDS.maximumLongitude ||
      latitude < DFW_BOUNDS.minimumLatitude ||
      latitude > DFW_BOUNDS.maximumLatitude
    )
  ) {
    throw new Error("market_context_coordinates_outside_dfw");
  }

  const overriddenFields = [];
  if (address) overriddenFields.push("address");
  if (city) overriddenFields.push("city");
  if (county) overriddenFields.push("county");
  if (postalRaw) overriddenFields.push("postal_code");
  if (latitudeProvided) overriddenFields.push("coordinates");
  if (sourceAccountId) overriddenFields.push("source_account_id");
  if (!overriddenFields.length) {
    throw new Error("market_context_override_empty");
  }

  return {
    ...subject,
    address: address || subject.address,
    city: city || subject.city,
    county: county || subject.county,
    postal_code: postalRaw ? postalCode : subject.postal_code,
    latitude: latitudeProvided ? latitude : subject.latitude,
    longitude: longitudeProvided ? longitude : subject.longitude,
    location_status: latitudeProvided ? "matched" : subject.location_status,
    location_source: latitudeProvided
      ? source === "dcad_related_parcel"
        ? "dcad_related_parcel_override"
        : "manual_market_context"
      : subject.location_source,
    location_precision: latitudeProvided ? "study_origin" : subject.location_precision,
    location_confidence: latitudeProvided ? "medium" : subject.location_confidence,
    location_review_required: true,
    location_review_reason: "market_context_override_active",
    context_override_active: true,
    context_override_source: source,
    context_overridden_fields: overriddenFields,
    context_source_account_id: sourceAccountId,
    context_review_note: reviewNote,
  };
}

async function validateCustomAreaInDatabase(pool, geometry, subject) {
  const { rows } = await pool.query(
    `
      WITH custom AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
      )
      SELECT
        ST_IsValid(geom) AS is_valid,
        ST_IsValidReason(geom) AS validity_reason,
        ST_Area(geom::geography) / 2589988.110336 AS area_square_miles,
        CASE
          WHEN $2::double precision IS NULL OR $3::double precision IS NULL
            THEN NULL
          ELSE ST_Covers(
            geom,
            ST_SetSRID(ST_MakePoint($3, $2), 4326)
          )
        END AS includes_subject
      FROM custom
    `,
    [
      JSON.stringify(geometry),
      subject.latitude,
      subject.longitude,
    ],
  );
  const validation = rows[0];
  if (!validation?.is_valid) {
    const error = new Error("custom_area_geometry_invalid");
    error.detail = validation?.validity_reason || null;
    throw error;
  }
  const areaSquareMiles = Number(validation.area_square_miles || 0);
  if (
    !Number.isFinite(areaSquareMiles) ||
    areaSquareMiles <= 0 ||
    areaSquareMiles > MAX_CUSTOM_AREA_SQUARE_MILES
  ) {
    throw new Error("custom_area_size_invalid");
  }
  return {
    areaSquareMiles,
    includesSubject:
      validation.includes_subject == null
        ? null
        : Boolean(validation.includes_subject),
  };
}

const MARKET_ANALYSIS_SQL = `
  WITH parameters AS (
    SELECT
      NULLIF($1, '')::date AS period_end,
      (
        DATE_TRUNC('month', NULLIF($1, '')::date)
        - (($2::integer - 1) * INTERVAL '1 month')
      )::date AS period_start,
      $2::integer AS period_months,
      BTRIM($3) AS subject_city,
      NULLIF(BTRIM($4), '') AS subject_county,
      NULLIF(BTRIM($5), '') AS subject_postal_code,
      $6::double precision AS subject_latitude,
      $7::double precision AS subject_longitude,
      $8::text AS area_scope,
      $9::double precision AS radius_miles,
      CASE
        WHEN NULLIF($10, '') IS NULL THEN NULL
        ELSE ST_SetSRID(ST_GeomFromGeoJSON($10), 4326)
      END AS custom_geom
  ),
  base AS (
    SELECT
      sale.sale_id,
      sale.source_record_id,
      sale.primary_account_id,
      COALESCE(
        NULLIF(BTRIM(sale.address), ''),
        NULLIF(BTRIM(sale_account.address), '')
      ) AS address,
      COALESCE(
        NULLIF(BTRIM(sale.city), ''),
        NULLIF(BTRIM(sale_account.city), '')
      ) AS city,
      sale.closing_date,
      sale.sale_price::numeric AS sale_price,
      sale.days_on_market,
      CASE
        WHEN sale.ratio_close_price_by_list_price BETWEEN 0.2 AND 2
          THEN sale.ratio_close_price_by_list_price * 100
        WHEN sale.ratio_close_price_by_list_price BETWEEN 20 AND 200
          THEN sale.ratio_close_price_by_list_price
        ELSE NULL
      END AS sale_to_list_ratio,
      CASE
        WHEN COALESCE(
          NULLIF(sale.mls_living_area, 0),
          NULLIF(sale.cad_living_area_sqft, 0)
        ) > 0
          THEN sale.sale_price / COALESCE(
            NULLIF(sale.mls_living_area, 0),
            NULLIF(sale.cad_living_area_sqft, 0)
          )
        ELSE NULL
      END AS price_per_square_foot,
      COALESCE(
        NULLIF(sale.mls_living_area, 0),
        NULLIF(sale.cad_living_area_sqft, 0)
      )::numeric AS living_area,
      CASE
        WHEN COALESCE(
          NULLIF(sale.mls_year_built, 0),
          NULLIF(sale.cad_effective_year_built, 0),
          NULLIF(sale.cad_year_built, 0)
        ) IS NULL THEN NULL
        ELSE GREATEST(
          EXTRACT(YEAR FROM parameters.period_end)::integer - COALESCE(
            NULLIF(sale.mls_year_built, 0),
            NULLIF(sale.cad_effective_year_built, 0),
            NULLIF(sale.cad_year_built, 0)
          ),
          0
        )::numeric
      END AS age_years,
      LOWER(NULLIF(BTRIM(sale.housing_type), '')) AS housing_type,
      sale_location.latitude,
      sale_location.longitude,
      sale_location.status AS location_status,
      sale_location.location_geom,
      sale_account.postal_code AS account_postal_code,
      sale.zip AS sale_postal_code,
      sale_account.city AS account_city,
      sale_account.county AS account_county
    FROM core.v_sales_enriched sale
    JOIN core.accounts sale_account
      ON sale_account.account_id = sale.primary_account_id
    LEFT JOIN core.account_locations sale_location
      ON sale_location.account_id = sale.primary_account_id
    CROSS JOIN parameters
    WHERE sale.record_type = 'closed_sale'
      AND sale.closing_date >= parameters.period_start
      AND sale.closing_date <= parameters.period_end
  ),
  eligible AS (
    SELECT base.*
    FROM base
    CROSS JOIN parameters
    WHERE
      (
        parameters.area_scope = 'city'
        AND LOWER(BTRIM(base.account_city)) =
          LOWER(parameters.subject_city)
        AND (
          parameters.subject_county IS NULL
          OR REGEXP_REPLACE(
            LOWER(BTRIM(base.account_county)),
            '\\s+county$',
            ''
          ) = REGEXP_REPLACE(
            LOWER(parameters.subject_county),
            '\\s+county$',
            ''
          )
        )
      )
      OR (
        parameters.area_scope = 'zip'
        AND parameters.subject_postal_code IS NOT NULL
        AND NULLIF(
          LEFT(
            REGEXP_REPLACE(
              COALESCE(
                NULLIF(BTRIM(base.account_postal_code), ''),
                NULLIF(BTRIM(base.sale_postal_code), '')
              ),
              '\\D',
              '',
              'g'
            ),
            5
          ),
          ''
        ) = parameters.subject_postal_code
      )
      OR (
        parameters.area_scope = 'radius'
        AND parameters.subject_latitude IS NOT NULL
        AND parameters.subject_longitude IS NOT NULL
        AND parameters.radius_miles IS NOT NULL
        AND base.location_status = 'matched'
        AND base.location_geom IS NOT NULL
        AND ST_DWithin(
          base.location_geom::geography,
          ST_SetSRID(
            ST_MakePoint(
              parameters.subject_longitude,
              parameters.subject_latitude
            ),
            4326
          )::geography,
          parameters.radius_miles * 1609.344
        )
      )
      OR (
        parameters.area_scope = 'custom'
        AND parameters.custom_geom IS NOT NULL
        AND base.location_status = 'matched'
        AND base.location_geom IS NOT NULL
        AND ST_Covers(parameters.custom_geom, base.location_geom)
      )
  ),
  numeric_medians AS (
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY living_area)
        FILTER (WHERE living_area IS NOT NULL) AS living_area_median,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_per_square_foot)
        FILTER (WHERE price_per_square_foot IS NOT NULL) AS ppsf_median,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sale_price)
        FILTER (WHERE sale_price IS NOT NULL) AS sale_price_median,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY age_years)
        FILTER (WHERE age_years IS NOT NULL) AS age_median
    FROM eligible
  ),
  numeric_dispersion AS (
    SELECT
      COUNT(living_area)::integer AS living_area_count,
      AVG(ABS(living_area - numeric_medians.living_area_median))
        / NULLIF(ABS(numeric_medians.living_area_median), 0) * 100
          AS living_area_cod,
      STDDEV_SAMP(living_area) / NULLIF(ABS(AVG(living_area)), 0) * 100
          AS living_area_cv,
      COUNT(price_per_square_foot)::integer AS ppsf_count,
      AVG(ABS(price_per_square_foot - numeric_medians.ppsf_median))
        / NULLIF(ABS(numeric_medians.ppsf_median), 0) * 100 AS ppsf_cod,
      STDDEV_SAMP(price_per_square_foot)
        / NULLIF(ABS(AVG(price_per_square_foot)), 0) * 100 AS ppsf_cv,
      COUNT(sale_price)::integer AS sale_price_count,
      AVG(ABS(sale_price - numeric_medians.sale_price_median))
        / NULLIF(ABS(numeric_medians.sale_price_median), 0) * 100
          AS sale_price_cod,
      STDDEV_SAMP(sale_price) / NULLIF(ABS(AVG(sale_price)), 0) * 100
          AS sale_price_cv,
      COUNT(age_years)::integer AS age_count,
      AVG(ABS(age_years - numeric_medians.age_median))
        / NULLIF(ABS(numeric_medians.age_median), 0) * 100 AS age_cod,
      STDDEV_SAMP(age_years) / NULLIF(ABS(AVG(age_years)), 0) * 100 AS age_cv
    FROM eligible
    CROSS JOIN numeric_medians
    GROUP BY
      numeric_medians.living_area_median,
      numeric_medians.ppsf_median,
      numeric_medians.sale_price_median,
      numeric_medians.age_median
  ),
  housing_type_groups AS (
    SELECT housing_type, COUNT(*)::integer AS type_count
    FROM eligible
    WHERE housing_type IS NOT NULL
    GROUP BY housing_type
  ),
  housing_type_stats AS (
    SELECT
      COALESCE(SUM(type_count), 0)::integer AS observation_count,
      COALESCE(MAX(type_count), 0)::integer AS dominant_count,
      (ARRAY_AGG(housing_type ORDER BY type_count DESC, housing_type))[1]
        AS dominant_housing_type
    FROM housing_type_groups
  ),
  series_rows AS (
    SELECT
      'monthly'::text AS interval_key,
      DATE_TRUNC('month', closing_date)::date AS period_start,
      *
    FROM eligible
    UNION ALL
    SELECT
      'quarterly'::text,
      DATE_TRUNC('quarter', closing_date)::date,
      *
    FROM eligible
    UNION ALL
    SELECT
      'semiannual'::text,
      MAKE_DATE(
        EXTRACT(YEAR FROM closing_date)::integer,
        CASE WHEN EXTRACT(MONTH FROM closing_date) <= 6 THEN 1 ELSE 7 END,
        1
      ),
      *
    FROM eligible
    UNION ALL
    SELECT
      'yearly'::text,
      DATE_TRUNC('year', closing_date)::date,
      *
    FROM eligible
  ),
  series AS (
    SELECT
      interval_key,
      period_start,
      COUNT(*)::integer AS sale_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY sale_price) AS median_sale_price,
      PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY days_on_market)
        FILTER (WHERE days_on_market >= 0) AS median_days_on_market,
      PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY sale_to_list_ratio)
        FILTER (WHERE sale_to_list_ratio IS NOT NULL)
          AS median_sale_to_list_ratio,
      PERCENTILE_CONT(0.5) WITHIN GROUP
        (ORDER BY price_per_square_foot)
        FILTER (WHERE price_per_square_foot IS NOT NULL)
          AS median_price_per_square_foot
    FROM series_rows
    GROUP BY interval_key, period_start
  )
  SELECT
    JSONB_BUILD_OBJECT(
      'eligible_sale_count', (SELECT COUNT(*)::integer FROM eligible),
      'mapped_sale_count', (
        SELECT COUNT(*)::integer
        FROM eligible
        WHERE location_status = 'matched'
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
      ),
      'median_sale_price', (
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sale_price)
        FROM eligible
      ),
      'median_days_on_market', (
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_on_market)
        FROM eligible
        WHERE days_on_market >= 0
      ),
      'median_sale_to_list_ratio', (
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sale_to_list_ratio)
        FROM eligible
        WHERE sale_to_list_ratio IS NOT NULL
      ),
      'median_price_per_square_foot', (
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_per_square_foot)
        FROM eligible
        WHERE price_per_square_foot IS NOT NULL
      ),
      'minimum_sale_price', (SELECT MIN(sale_price) FROM eligible),
      'maximum_sale_price', (SELECT MAX(sale_price) FROM eligible),
      'congruency_factors', JSONB_BUILD_OBJECT(
        'living_area', JSONB_BUILD_OBJECT(
          'count', (SELECT living_area_count FROM numeric_dispersion),
          'cod', (SELECT living_area_cod FROM numeric_dispersion),
          'cv', (SELECT living_area_cv FROM numeric_dispersion)
        ),
        'price_per_square_foot', JSONB_BUILD_OBJECT(
          'count', (SELECT ppsf_count FROM numeric_dispersion),
          'cod', (SELECT ppsf_cod FROM numeric_dispersion),
          'cv', (SELECT ppsf_cv FROM numeric_dispersion)
        ),
        'sale_price', JSONB_BUILD_OBJECT(
          'count', (SELECT sale_price_count FROM numeric_dispersion),
          'cod', (SELECT sale_price_cod FROM numeric_dispersion),
          'cv', (SELECT sale_price_cv FROM numeric_dispersion)
        ),
        'age', JSONB_BUILD_OBJECT(
          'count', (SELECT age_count FROM numeric_dispersion),
          'cod', (SELECT age_cod FROM numeric_dispersion),
          'cv', (SELECT age_cv FROM numeric_dispersion)
        ),
        'housing_type', JSONB_BUILD_OBJECT(
          'count', (SELECT observation_count FROM housing_type_stats),
          'dominant_type', (
            SELECT dominant_housing_type FROM housing_type_stats
          ),
          'dispersion', (
            SELECT CASE
              WHEN observation_count <= 0 THEN NULL
              ELSE (1 - dominant_count::numeric / observation_count) * 100
            END
            FROM housing_type_stats
          )
        )
      )
    ) AS summary,
    COALESCE(
      (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'interval_key', interval_key,
            'period_start', period_start,
            'sale_count', sale_count,
            'median_sale_price', median_sale_price,
            'median_days_on_market', median_days_on_market,
            'median_sale_to_list_ratio', median_sale_to_list_ratio,
            'median_price_per_square_foot', median_price_per_square_foot
          )
          ORDER BY
            CASE interval_key
              WHEN 'monthly' THEN 1
              WHEN 'quarterly' THEN 2
              WHEN 'semiannual' THEN 3
              ELSE 4
            END,
            period_start
        )
        FROM series
      ),
      '[]'::jsonb
    ) AS series,
    COALESCE(
      (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'sale_id', mapped.sale_id,
            'source_record_id', mapped.source_record_id,
            'account_id', mapped.primary_account_id,
            'address', mapped.address,
            'city', mapped.city,
            'closing_date', mapped.closing_date,
            'sale_price', mapped.sale_price,
            'latitude', mapped.latitude,
            'longitude', mapped.longitude
          )
          ORDER BY mapped.closing_date DESC NULLS LAST, mapped.sale_id
        )
        FROM (
          SELECT *
          FROM eligible
          WHERE location_status = 'matched'
            AND latitude IS NOT NULL
            AND longitude IS NOT NULL
          ORDER BY closing_date DESC NULLS LAST, sale_id
          LIMIT 1000
        ) mapped
      ),
      '[]'::jsonb
    ) AS map_sales,
    (SELECT period_end FROM parameters) AS period_end,
    (SELECT period_start FROM parameters) AS period_start
`;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const CONGRUENCY_WEIGHTS = Object.freeze({
  living_area: 0.6,
  price_per_square_foot: 0.1,
  sale_price: 0.1,
  age: 0.1,
  housing_type: 0.1,
});

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function weightedCompositeDispersion(factors, measure) {
  let weightedTotal = 0;
  let availableWeight = 0;
  for (const [key, weight] of Object.entries(CONGRUENCY_WEIGHTS)) {
    const factor = factors?.[key];
    const rawValue =
      key === "housing_type" ? factor?.dispersion : factor?.[measure];
    const value = numberOrNull(rawValue);
    if (value === null || Number(factor?.count || 0) <= 0) continue;
    weightedTotal += value * weight;
    availableWeight += weight;
  }
  return {
    value:
      availableWeight > 0
        ? rounded(weightedTotal / availableWeight, 2)
        : null,
    available_weight: rounded(availableWeight, 2) || 0,
  };
}

function normalizeCongruencyFactors(rawFactors) {
  const numericFactor = (key, weight) => ({
    count: Number(rawFactors?.[key]?.count || 0),
    cod: numberOrNull(rawFactors?.[key]?.cod),
    cv: numberOrNull(rawFactors?.[key]?.cv),
    weight,
  });
  return {
    living_area: numericFactor("living_area", CONGRUENCY_WEIGHTS.living_area),
    price_per_square_foot: numericFactor(
      "price_per_square_foot",
      CONGRUENCY_WEIGHTS.price_per_square_foot,
    ),
    sale_price: numericFactor("sale_price", CONGRUENCY_WEIGHTS.sale_price),
    age: numericFactor("age", CONGRUENCY_WEIGHTS.age),
    housing_type: {
      count: Number(rawFactors?.housing_type?.count || 0),
      dispersion: numberOrNull(rawFactors?.housing_type?.dispersion),
      dominant_type: rawFactors?.housing_type?.dominant_type || null,
      weight: CONGRUENCY_WEIGHTS.housing_type,
    },
  };
}

function calendarMonthIndex(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

export function calculateMarketStudyStatistics({
  monthlySeries,
  eligibleSaleCount,
  periodMonths,
  congruencyFactors,
}) {
  const validMonthly = [...(monthlySeries || [])]
    .filter(
      (point) =>
        numberOrNull(point?.median_sale_price) !== null &&
        calendarMonthIndex(point?.period_start) !== null,
    )
    .sort(
      (left, right) =>
        calendarMonthIndex(left.period_start) -
        calendarMonthIndex(right.period_start),
    );
  const first = validMonthly[0] || null;
  const last = validMonthly.at(-1) || null;
  const firstMonth = calendarMonthIndex(first?.period_start);
  const lastMonth = calendarMonthIndex(last?.period_start);
  const elapsedMonths =
    firstMonth !== null && lastMonth !== null ? lastMonth - firstMonth : 0;
  const firstMedian = numberOrNull(first?.median_sale_price);
  const lastMedian = numberOrNull(last?.median_sale_price);
  const annualizedChange =
    elapsedMonths > 0 &&
    firstMedian !== null &&
    lastMedian !== null &&
    firstMedian > 0 &&
    lastMedian > 0
      ? ((lastMedian / firstMedian) ** (12 / elapsedMonths) - 1) * 100
      : null;
  const compositeCod = weightedCompositeDispersion(
    congruencyFactors,
    "cod",
  );
  const compositeCv = weightedCompositeDispersion(
    congruencyFactors,
    "cv",
  );
  const availableWeight = Math.min(
    compositeCod.available_weight,
    compositeCv.available_weight,
  );
  const sampleScore = Math.min(Number(eligibleSaleCount || 0) / 100, 1);
  const coverageScore = Math.min(
    validMonthly.length / Math.max(Number(periodMonths || 0), 1),
    1,
  );
  const meanDispersion =
    compositeCod.value !== null && compositeCv.value !== null
      ? (compositeCod.value + compositeCv.value) / 2
      : compositeCod.value ?? compositeCv.value;
  const congruencyScore =
    meanDispersion === null ? 0 : 1 / (1 + Math.max(meanDispersion, 0) / 100);
  const reliabilityScore =
    (sampleScore * 0.35 +
      coverageScore * 0.2 +
      congruencyScore * 0.35 +
      availableWeight * 0.1) *
    100;
  return {
    annualized_change_percent: rounded(annualizedChange, 2),
    trend_start_period: first?.period_start || null,
    trend_end_period: last?.period_start || null,
    trend_start_median_price: firstMedian,
    trend_end_median_price: lastMedian,
    monthly_observation_count: validMonthly.length,
    composite_cod: compositeCod.value,
    composite_cv: compositeCv.value,
    characteristic_weight_available: availableWeight,
    reliability_score: rounded(reliabilityScore, 1),
    sample_sufficient: Number(eligibleSaleCount || 0) >= 30,
  };
}

export function buildMarketTrendRecommendation(analyses) {
  const rankedStudies = (analyses || [])
    .filter(
      (analysis) =>
        numberOrNull(analysis?.statistics?.annualized_change_percent) !== null,
    )
    .sort((left, right) => {
      if (
        left.statistics.sample_sufficient !==
        right.statistics.sample_sufficient
      ) {
        return left.statistics.sample_sufficient ? -1 : 1;
      }
      return (
        Number(right.statistics.reliability_score || 0) -
          Number(left.statistics.reliability_score || 0) ||
        Number(right.population?.eligible_sale_count || 0) -
          Number(left.population?.eligible_sale_count || 0)
      );
    });
  const changes = rankedStudies.map((analysis) =>
    Number(analysis.statistics.annualized_change_percent),
  );
  const average = changes.length
    ? changes.reduce((total, value) => total + value, 0) / changes.length
    : null;
  const orderedChanges = [...changes].sort((left, right) => left - right);
  const middle = Math.floor(orderedChanges.length / 2);
  const median = orderedChanges.length
    ? orderedChanges.length % 2
      ? orderedChanges[middle]
      : (orderedChanges[middle - 1] + orderedChanges[middle]) / 2
    : null;
  const recommendedChange =
    (() => {
      if (average === null || median === null) return null;
      const customStudy = rankedStudies.find(
        (analysis) => analysis.market.key === "custom",
      );
      if (!customStudy) return (average + median) / 2;
      const otherStudies = rankedStudies.filter(
        (analysis) => analysis.market.key !== "custom",
      );
      if (!otherStudies.length) {
        return Number(customStudy.statistics.annualized_change_percent);
      }
      const reliabilityTotal = otherStudies.reduce(
        (total, analysis) =>
          total + Math.max(Number(analysis.statistics.reliability_score || 0), 0),
        0,
      );
      const otherWeightedChange = otherStudies.reduce((total, analysis) => {
        const share = reliabilityTotal > 0
          ? Math.max(Number(analysis.statistics.reliability_score || 0), 0) /
            reliabilityTotal
          : 1 / otherStudies.length;
        return total + Number(analysis.statistics.annualized_change_percent) * share;
      }, 0);
      return Number(customStudy.statistics.annualized_change_percent) * 0.6 +
        otherWeightedChange * 0.4;
    })();
  const conclusion =
    recommendedChange === null
      ? "insufficient"
      : Math.abs(recommendedChange) < 1
        ? "stable"
        : recommendedChange > 0
          ? "increasing"
          : "decreasing";
  return {
    methodology_version: 2,
    weighting_method: rankedStudies.some(
      (analysis) => analysis.market.key === "custom",
    )
      ? "appraiser_defined_area_60_percent"
      : "mean_median_reconciliation",
    appraiser_defined_area_weight_percent: rankedStudies.some(
      (analysis) => analysis.market.key === "custom",
    )
      ? rankedStudies.length === 1
        ? 100
        : 60
      : 0,
    stable_threshold_percent: 1,
    conclusion,
    average_annualized_change_percent: rounded(average, 2),
    median_annualized_change_percent: rounded(median, 2),
    recommended_change_percent: rounded(recommendedChange, 2),
    ranked_studies: rankedStudies.map((analysis, index) => {
      const customStudyPresent = rankedStudies.some(
        (study) => study.market.key === "custom",
      );
      const otherStudies = rankedStudies.filter(
        (study) => study.market.key !== "custom",
      );
      const reliabilityTotal = otherStudies.reduce(
        (total, study) =>
          total + Math.max(Number(study.statistics.reliability_score || 0), 0),
        0,
      );
      let reconciliationWeight = null;
      if (customStudyPresent) {
        if (rankedStudies.length === 1) {
          reconciliationWeight = 1;
        } else if (analysis.market.key === "custom") {
          reconciliationWeight = 0.6;
        } else {
          const reliabilityShare = reliabilityTotal > 0
            ? Math.max(Number(analysis.statistics.reliability_score || 0), 0) /
              reliabilityTotal
            : 1 / otherStudies.length;
          reconciliationWeight = 0.4 * reliabilityShare;
        }
      }
      return {
        rank: index + 1,
        key: analysis.market.key,
        label: analysis.market.label,
        reliability_score: analysis.statistics.reliability_score,
        reconciliation_weight_percent:
          reconciliationWeight === null ? null : rounded(reconciliationWeight * 100, 1),
        sale_count: analysis.population.eligible_sale_count,
        sample_sufficient: analysis.statistics.sample_sufficient,
        annualized_change_percent:
          analysis.statistics.annualized_change_percent,
        composite_cod: analysis.statistics.composite_cod,
        composite_cv: analysis.statistics.composite_cv,
      };
    }),
  };
}

function normalizeAnalysisRow(row, periodMonths) {
  const summary = row?.summary || {};
  const series = Array.isArray(row?.series) ? row.series : [];
  const normalizedSeries = {
    monthly: series
      .filter((item) => item.interval_key === "monthly")
      .map(normalizeSeriesPoint),
    quarterly: series
      .filter((item) => item.interval_key === "quarterly")
      .map(normalizeSeriesPoint),
    semiannual: series
      .filter((item) => item.interval_key === "semiannual")
      .map(normalizeSeriesPoint),
    yearly: series
      .filter((item) => item.interval_key === "yearly")
      .map(normalizeSeriesPoint),
  };
  const congruencyFactors = normalizeCongruencyFactors(
    summary.congruency_factors,
  );
  const population = {
    eligible_sale_count: Number(summary.eligible_sale_count || 0),
    mapped_sale_count: Number(summary.mapped_sale_count || 0),
  };
  return {
    period: {
      start: row?.period_start || null,
      end: row?.period_end || null,
    },
    population,
    summary: {
      median_sale_price: numberOrNull(summary.median_sale_price),
      median_days_on_market: numberOrNull(summary.median_days_on_market),
      median_sale_to_list_ratio: numberOrNull(
        summary.median_sale_to_list_ratio,
      ),
      median_price_per_square_foot: numberOrNull(
        summary.median_price_per_square_foot,
      ),
      minimum_sale_price: numberOrNull(summary.minimum_sale_price),
      maximum_sale_price: numberOrNull(summary.maximum_sale_price),
      congruency_factors: congruencyFactors,
    },
    statistics: calculateMarketStudyStatistics({
      monthlySeries: normalizedSeries.monthly,
      eligibleSaleCount: population.eligible_sale_count,
      periodMonths,
      congruencyFactors,
    }),
    series: normalizedSeries,
    map_sales: Array.isArray(row?.map_sales)
      ? row.map_sales.map((sale) => ({
          ...sale,
          sale_price: numberOrNull(sale.sale_price),
          latitude: numberOrNull(sale.latitude),
          longitude: numberOrNull(sale.longitude),
        }))
      : [],
  };
}

function normalizeSeriesPoint(item) {
  return {
    period_start: item.period_start || null,
    sale_count: Number(item.sale_count || 0),
    median_sale_price: numberOrNull(item.median_sale_price),
    median_days_on_market: numberOrNull(item.median_days_on_market),
    median_sale_to_list_ratio: numberOrNull(
      item.median_sale_to_list_ratio,
    ),
    median_price_per_square_foot: numberOrNull(
      item.median_price_per_square_foot,
    ),
  };
}

export async function buildMarketConditionsAnalyses(
  pool,
  {
    subjectAccountId,
    areaKeys,
    asOfDate = "",
    periodMonths = 24,
    customGeometry = null,
    marketContextOverride = null,
  },
) {
  const areas = parseMarketAreaKeys(areaKeys);
  const parsedPeriodMonths = Number(periodMonths);
  const calendarWindow = completeCalendarMonthWindow(
    asOfDate,
    parsedPeriodMonths,
  );

  const storedSubject = await getMarketContext(pool, subjectAccountId);
  const subject = applyMarketContextOverride(
    storedSubject,
    marketContextOverride,
  );
  const customRequested = areas.some((area) => area.scope === "custom");
  let normalizedCustomGeometry = null;
  let customValidation = null;
  if (customRequested) {
    normalizedCustomGeometry = validateCustomMarketGeometry(customGeometry);
    customValidation = await validateCustomAreaInDatabase(
      pool,
      normalizedCustomGeometry,
      subject,
    );
  }

  const unavailableAreas = [];
  const availableAreas = areas.filter((area) => {
    if (area.scope === "city" && !String(subject.city || "").trim()) {
      unavailableAreas.push({
        key: area.key,
        label: "Entire subject city",
        reason: "The subject city is unavailable.",
      });
      return false;
    }
    if (area.scope === "zip" && !subject.postal_code) {
      unavailableAreas.push({
        key: area.key,
        label: "Subject ZIP code",
        reason: "The subject ZIP code is unavailable.",
      });
      return false;
    }
    if (
      (area.scope === "radius" || area.scope === "custom") &&
      (
        subject.location_status !== "matched" ||
        subject.latitude == null ||
        subject.longitude == null
      )
    ) {
      unavailableAreas.push({
        key: area.key,
        label: areaLabel(area, subject),
        reason: "The subject parcel location is unavailable.",
      });
      return false;
    }
    return true;
  });

  const analyses = [];
  for (const area of availableAreas) {
    const { rows } = await pool.query(MARKET_ANALYSIS_SQL, [
      calendarWindow.end,
      parsedPeriodMonths,
      String(subject.city || ""),
      String(subject.county || ""),
      String(subject.postal_code || ""),
      subject.latitude,
      subject.longitude,
      area.scope,
      area.radiusMiles,
      area.scope === "custom"
        ? JSON.stringify(normalizedCustomGeometry)
        : "",
    ]);
    analyses.push({
      market: {
        key: area.key,
        scope: area.scope,
        label: areaLabel(area, subject),
        city: subject.city,
        county: subject.county,
        postal_code: subject.postal_code,
        radius_miles: area.radiusMiles,
        custom_geometry:
          area.scope === "custom" ? normalizedCustomGeometry : null,
        area_square_miles:
          area.scope === "custom"
            ? customValidation?.areaSquareMiles || null
            : null,
        includes_subject:
          area.scope === "custom"
            ? customValidation?.includesSubject ?? null
            : true,
      },
      ...normalizeAnalysisRow(rows[0], parsedPeriodMonths),
      filters: {
        record_type: "closed_sale",
        minimum_sale_price: null,
        review_flagged_sales_included: true,
        multi_parcel_sales_included: true,
        attached_housing_included: true,
        inclusive_start_date: true,
        period_months: parsedPeriodMonths,
        complete_calendar_months: true,
        analysis_as_of: calendarWindow.analysisAsOf,
        partial_as_of_month_excluded: calendarWindow.partialMonthExcluded,
      },
    });
  }

  return {
    subject,
    analyses,
    recommendation: buildMarketTrendRecommendation(analyses),
    unavailable_areas: unavailableAreas,
    independence_notice:
      "Market-study areas do not restrict or alter the comparable-sales inventory.",
  };
}

export function marketConditionsErrorStatus(message) {
  if (message === "subject_not_found") return 404;
  if (
    [
      "custom_area_geometry_invalid",
      "custom_area_size_invalid",
    ].includes(message)
  ) {
    return 422;
  }
  if (
    String(message || "").startsWith("invalid_") ||
    String(message || "").startsWith("market_context_") ||
    String(message || "").startsWith("custom_") ||
    message === "market_areas_required"
  ) {
    return 400;
  }
  return 500;
}

export const marketConditionsInternals = {
  DFW_BOUNDS,
  MAX_CUSTOM_VERTICES,
  MAX_CUSTOM_AREA_SQUARE_MILES,
  normalizedCounty,
};
