import {
  completeCalendarMonthWindow,
  ensureSpatialSupport,
  getMarketContext,
  parseMarketAreaKeys,
  validateCustomMarketGeometry,
} from "./marketConditions.js";
import { buildRegressionAnalysis } from "../util/regressionAnalysis.js";

function areaLabel(area, subject) {
  if (area.scope === "city") return [subject.city, subject.county].filter(Boolean).join(", ");
  if (area.scope === "zip") return `ZIP ${subject.postal_code}`;
  if (area.scope === "radius") return `Within ${area.radiusMiles} mile${area.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
  return "Appraiser-defined market area";
}

function housingGroup(housingType, attachmentType, structuralStyle) {
  const combined = [attachmentType, housingType, structuralStyle]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
  if (!combined) return "unknown";
  if (/condo|minium/.test(combined)) return "condominium";
  if (/town\s*home|town\s*house/.test(combined)) return "townhome";
  if (/duplex|triplex|fourplex|multi[ -]?family/.test(combined)) return "multi-family";
  if (/attached|patio home|zero[ -]?lot/.test(combined)) return "attached";
  if (/detached|single[ -]?family/.test(combined)) return "detached";
  return "unknown";
}

export async function buildRegressionStudy(pool, {
  subjectAccountId,
  marketKey = "city",
  asOfDate = "",
  customGeometry = null,
  accountIdAllowed,
}) {
  const [area] = parseMarketAreaKeys([marketKey]);
  const period = completeCalendarMonthWindow(asOfDate, 12);
  const subject = await getMarketContext(pool, subjectAccountId, {
    accountIdAllowed,
  });
  const normalizedCustomGeometry = area.scope === "custom" ? validateCustomMarketGeometry(customGeometry) : null;
  await ensureSpatialSupport(pool);
  const subjectProfileResult = await pool.query(
    `SELECT housing_type, attachment_type, architectural_style
       FROM core.v_account_housing_profiles
      WHERE account_id = $1
      LIMIT 1`,
    [subjectAccountId],
  );
  const subjectProfile = subjectProfileResult.rows[0] || {};
  const subjectHousingGroup = housingGroup(
    subjectProfile.housing_type,
    subjectProfile.attachment_type,
    subjectProfile.architectural_style,
  );
  const { rows } = await pool.query(
    `WITH parameters AS (
       SELECT $1::date AS period_start,
              $2::date AS period_end,
              BTRIM($3) AS subject_city,
              NULLIF(BTRIM($4), '') AS subject_county,
              NULLIF(BTRIM($5), '') AS subject_postal_code,
              $6::double precision AS subject_latitude,
              $7::double precision AS subject_longitude,
              $8::text AS area_scope,
              $9::double precision AS radius_miles,
              CASE WHEN NULLIF($10, '') IS NULL THEN NULL
                   ELSE ST_SetSRID(ST_GeomFromGeoJSON($10), 4326) END AS custom_geom
     )
     SELECT
       sale.sale_id,
       sale.source_record_id,
       sale.primary_account_id,
       COALESCE(NULLIF(BTRIM(sale.address), ''), NULLIF(BTRIM(sale_account.address), '')) AS address,
       sale.closing_date,
       sale.sale_price::numeric AS sale_price,
       COALESCE(
         CASE WHEN sale.mls_bathrooms_full IS NOT NULL
              THEN sale.mls_bathrooms_full + COALESCE(sale.mls_bathrooms_half, 0) * 0.5 END,
         CASE WHEN sale.cad_baths_full IS NOT NULL
              THEN sale.cad_baths_full + COALESCE(sale.cad_baths_half, 0) * 0.5 END,
         sale.mls_bathrooms_total_integer,
         sale.cad_bath_count
       )::numeric AS bathrooms,
       CASE WHEN sale.mls_garage_spaces IS NOT NULL THEN ROUND(sale.mls_garage_spaces)::integer
            WHEN sale.mls_garage_yn = false THEN 0 ELSE NULL END AS garage_spaces,
       COALESCE(
         sale.mls_pool_yn,
         CASE
           WHEN lower(btrim(sale.cad_pool::text)) IN ('true', 't', 'yes', 'y', '1') THEN true
           WHEN lower(btrim(sale.cad_pool::text)) IN ('false', 'f', 'no', 'n', '0', '') THEN false
           ELSE NULL
         END
       ) AS pool_yn,
       COALESCE(NULLIF(sale.mls_living_area, 0), NULLIF(sale.cad_living_area_sqft, 0))::numeric AS living_area,
       COALESCE(NULLIF(sale.mls_lot_size_area, 0), NULLIF(cad_site.site_size_sqft, 0))::numeric AS site_size,
       CASE WHEN COALESCE(NULLIF(sale.mls_year_built, 0), NULLIF(sale.cad_effective_year_built, 0), NULLIF(sale.cad_year_built, 0)) IS NULL THEN NULL
            ELSE GREATEST(0, EXTRACT(YEAR FROM sale.closing_date)::integer - COALESCE(NULLIF(sale.mls_year_built, 0), NULLIF(sale.cad_effective_year_built, 0), NULLIF(sale.cad_year_built, 0))) END AS age_years,
       sale.housing_type,
       sale.attachment_type,
       sale.structural_style
     FROM core.v_sales_enriched sale
     LEFT JOIN core.accounts sale_account ON sale_account.account_id = sale.primary_account_id
     LEFT JOIN core.account_locations sale_location ON sale_location.account_id = sale.primary_account_id
     LEFT JOIN LATERAL (
       SELECT SUM(land.area_sqft)::numeric AS site_size_sqft
         FROM core.land_detail land
        WHERE land.account_id = sale.primary_account_id
          AND land.tax_year = (
            SELECT MAX(latest_land.tax_year)
              FROM core.land_detail latest_land
             WHERE latest_land.account_id = sale.primary_account_id
          )
     ) cad_site ON true
     CROSS JOIN parameters
     WHERE sale.record_type = 'closed_sale'
       AND sale.closing_date >= parameters.period_start
       AND sale.closing_date <= parameters.period_end
       AND sale.sale_price > 0
       AND (
         (parameters.area_scope = 'city'
          AND LOWER(BTRIM(COALESCE(sale_account.city, sale.city, ''))) = LOWER(parameters.subject_city)
          AND (parameters.subject_county IS NULL OR REGEXP_REPLACE(LOWER(BTRIM(COALESCE(sale_account.county, sale.county, ''))), '\\s+county$', '') = REGEXP_REPLACE(LOWER(parameters.subject_county), '\\s+county$', '')))
         OR (parameters.area_scope = 'zip'
          AND parameters.subject_postal_code IS NOT NULL
          AND NULLIF(LEFT(REGEXP_REPLACE(COALESCE(NULLIF(BTRIM(sale_account.postal_code), ''), NULLIF(BTRIM(sale.zip), '')), '\\D', '', 'g'), 5), '') = parameters.subject_postal_code)
         OR (parameters.area_scope = 'radius'
          AND parameters.subject_latitude IS NOT NULL AND parameters.subject_longitude IS NOT NULL
          AND parameters.radius_miles IS NOT NULL AND sale_location.status = 'matched' AND sale_location.location_geom IS NOT NULL
          AND ST_DWithin(sale_location.location_geom::geography, ST_SetSRID(ST_MakePoint(parameters.subject_longitude, parameters.subject_latitude), 4326)::geography, parameters.radius_miles * 1609.344))
         OR (parameters.area_scope = 'custom'
          AND parameters.custom_geom IS NOT NULL AND sale_location.status = 'matched' AND sale_location.location_geom IS NOT NULL
          AND ST_Covers(parameters.custom_geom, sale_location.location_geom))
       )
     ORDER BY sale.closing_date, sale.source_record_id`,
    [
      period.start,
      period.end,
      String(subject.city || ""),
      String(subject.county || ""),
      String(subject.postal_code || ""),
      subject.latitude == null ? null : Number(subject.latitude),
      subject.longitude == null ? null : Number(subject.longitude),
      area.scope,
      area.radiusMiles,
      normalizedCustomGeometry ? JSON.stringify(normalizedCustomGeometry) : "",
    ],
  );
  const housingFilteredRows = subjectHousingGroup === "unknown"
    ? rows
    : rows.filter((row) => housingGroup(row.housing_type, row.attachment_type, row.structural_style) === subjectHousingGroup);
  const analysis = buildRegressionAnalysis(housingFilteredRows);
  return {
    subject: {
      accountId: subject.account_id,
      address: subject.address,
      city: subject.city,
      county: subject.county,
      postalCode: subject.postal_code,
      housingGroup: subjectHousingGroup,
    },
    market: {
      key: area.key,
      scope: area.scope,
      radiusMiles: area.radiusMiles,
      label: areaLabel(area, subject),
      customGeometry: normalizedCustomGeometry,
    },
    period: {
      start: period.start,
      end: period.end,
      analysisAsOf: period.analysisAsOf,
      periodMonths: period.periodMonths,
      completeCalendarMonths: true,
    },
    rawEligibleSaleCount: rows.length,
    housingTypeExcludedCount: rows.length - housingFilteredRows.length,
    ...analysis,
  };
}

export function regressionAnalysisErrorStatus(message) {
  if (message === "subject_not_found") return 404;
  if (String(message || "").startsWith("invalid_") || String(message || "").startsWith("custom_") || message === "market_areas_required") return 400;
  return 500;
}
