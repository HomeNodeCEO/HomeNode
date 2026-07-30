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
      COALESCE(NULLIF($1, '')::date, CURRENT_DATE) AS period_end,
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
      AND sale.closing_date >
        (parameters.period_end - (parameters.period_months * INTERVAL '1 month'))::date
      AND sale.closing_date <= parameters.period_end
      AND sale.sale_price >= 10000
      AND sale.multi_parcel_status = 'single'
      AND sale.attachment_type NOT IN ('attached', 'mixed')
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
      'maximum_sale_price', (SELECT MAX(sale_price) FROM eligible)
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
    (
      SELECT (period_end - (period_months * INTERVAL '1 month'))::date
      FROM parameters
    ) AS period_start
`;

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAnalysisRow(row) {
  const summary = row?.summary || {};
  const series = Array.isArray(row?.series) ? row.series : [];
  return {
    period: {
      start: row?.period_start || null,
      end: row?.period_end || null,
    },
    population: {
      eligible_sale_count: Number(summary.eligible_sale_count || 0),
      mapped_sale_count: Number(summary.mapped_sale_count || 0),
    },
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
    },
    series: {
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
    },
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
  },
) {
  const areas = parseMarketAreaKeys(areaKeys);
  const parsedPeriodMonths = Number(periodMonths);
  if (![12, 24, 36].includes(parsedPeriodMonths)) {
    throw new Error("invalid_market_period");
  }
  if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error("invalid_as_of");
  }

  const subject = await getMarketContext(pool, subjectAccountId);
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
      asOfDate,
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
      ...normalizeAnalysisRow(rows[0]),
      filters: {
        record_type: "closed_sale",
        minimum_sale_price: 10000,
        multi_parcel_status: "single",
        attached_housing_excluded: true,
        period_months: parsedPeriodMonths,
      },
    });
  }

  return {
    subject,
    analyses,
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
