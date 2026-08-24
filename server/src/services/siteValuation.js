import {
  completeCalendarMonthWindow,
  ensureSpatialSupport,
  getMarketContext,
  parseMarketAreaKeys,
  validateCustomMarketGeometry,
} from "./marketConditions.js";
import { buildSiteValuationAnalysis } from "../util/siteValuationAnalysis.js";

function areaLabel(area, subject) {
  if (area.scope === "city") return [subject.city, subject.county].filter(Boolean).join(", ");
  if (area.scope === "zip") return `ZIP ${subject.postal_code}`;
  if (area.scope === "radius") return `Within ${area.radiusMiles} mile${area.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
  return "Appraiser-defined market area";
}

export async function buildSiteValuationStudy(pool, {
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
  const subjectSiteResult = await pool.query(
    `SELECT SUM(area_sqft)::numeric AS site_size_sqft
       FROM core.land_detail
      WHERE account_id = $1
        AND tax_year = (
          SELECT MAX(latest_land.tax_year)
            FROM core.land_detail latest_land
           WHERE latest_land.account_id = $1
        )`,
    [subjectAccountId],
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
       sale.cad_land_value::numeric AS cad_land_value,
       sale.cad_improvement_value::numeric AS cad_improvement_value,
       COALESCE(NULLIF(sale.mls_lot_size_area, 0), NULLIF(cad_site.site_size_sqft, 0))::numeric AS site_size
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
       AND sale.primary_account_id IS DISTINCT FROM $11
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
     ORDER BY sale.closing_date DESC, sale.source_record_id`,
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
      subjectAccountId,
    ],
  );
  return {
    subject: {
      accountId: subject.account_id,
      address: subject.address,
      city: subject.city,
      county: subject.county,
      postalCode: subject.postal_code,
      siteSizeSquareFeet: subjectSiteResult.rows[0]?.site_size_sqft == null
        ? null
        : Number(subjectSiteResult.rows[0].site_size_sqft),
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
    methodology: {
      method: "allocation",
      salePricesTimeAdjusted: false,
      allocationBasis: "cad_land_value_divided_by_cad_land_plus_improvement_value",
      minimumStrongSample: 30,
    },
    ...buildSiteValuationAnalysis(rows),
  };
}

export function siteValuationErrorStatus(message) {
  if (message === "subject_not_found") return 404;
  if (String(message || "").startsWith("invalid_") || String(message || "").startsWith("custom_") || message === "market_areas_required") return 400;
  return 500;
}
