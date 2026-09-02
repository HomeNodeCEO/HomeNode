import express from "express";

import { refreshAccountLocations } from "../../services/accountLocations.js";
import { buildGroupedAnalysis } from "../../util/groupedAnalysis.js";
import { parseGroupedAnalysisBreakdowns } from "../../util/groupedAnalysisBreakdowns.js";

export function createGroupedAnalysisRouter({
  pool,
  accountIdAllowed,
  locationsReady,
  refreshLocations = refreshAccountLocations,
  parseBreakdowns = parseGroupedAnalysisBreakdowns,
  buildDimensions = buildGroupedAnalysis,
  debugEnabled = () => process.env.GROUPED_ANALYSIS_DEBUG === "true",
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("grouped_analysis_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("grouped_analysis_account_policy_required");
  }
  if (!locationsReady || typeof locationsReady.then !== "function") {
    throw new TypeError("grouped_analysis_locations_ready_required");
  }
  if (
    typeof refreshLocations !== "function"
    || typeof parseBreakdowns !== "function"
    || typeof buildDimensions !== "function"
    || typeof debugEnabled !== "function"
  ) {
    throw new TypeError("grouped_analysis_dependency_required");
  }

  const router = express.Router();

  /**
   * GET /api/sales/grouped-analysis
   *
   * Builds one-year grouped adjustment studies for any requested combination of
   * the subject's city, ZIP code, and cumulative one-through-five-mile radii.
   * Closed, single-parcel sales are grouped by total bathrooms, garage spaces,
   * pool presence, and ten ordered living-area bands. Missing garage spaces are
   * treated as zero only when the MLS explicitly says the property has no
   * garage.
   */
  router.get("/api/sales/grouped-analysis", async (req, res) => {
    try {
      const subjectAccountId = String(
        req.query.subject_account_id || "",
      ).trim();
      const asOfDate = String(req.query.as_of || "").trim();
      const multipleBreakdownsRequested = req.query.breakdowns !== undefined;
      if (!accountIdAllowed(subjectAccountId)) {
        return res.status(400).json({ error: "invalid_subject_account_id" });
      }
      if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
        return res.status(400).json({ error: "invalid_as_of" });
      }

      let requestedBreakdowns;
      try {
        requestedBreakdowns = parseBreakdowns(
          req.query.breakdowns,
        );
      } catch (error) {
        return res.status(400).json({
          error: error?.message || "invalid_grouped_analysis_breakdown",
        });
      }

      await locationsReady;
      const loadSubject = async () => {
        const subjectResult = await pool.query(
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
              location.latitude,
              location.longitude,
              location.status AS location_status
            FROM core.accounts account
            LEFT JOIN core.account_locations location
              ON location.account_id = account.account_id
            WHERE account.account_id = $1
          `,
          [subjectAccountId],
        );
        return subjectResult.rows[0] || null;
      };

      let subject = await loadSubject();
      if (!subject) {
        return res.status(404).json({ error: "subject_not_found" });
      }

      const radiusRequested = requestedBreakdowns.some(
        (breakdown) => breakdown.scope === "radius",
      );
      if (
        radiusRequested &&
        (
          subject.location_status !== "matched" ||
          subject.latitude == null ||
          subject.longitude == null
        )
      ) {
        try {
          await refreshLocations(pool, [subject], { batchSize: 1 });
          subject = await loadSubject();
        } catch (error) {
          logger.warn?.(
            "[grouped-analysis] subject location refresh failed; radius studies may be unavailable",
            error?.message || error,
          );
        }
      }

      const unavailableBreakdowns = [];
      const availableBreakdowns = requestedBreakdowns.filter((breakdown) => {
        if (breakdown.scope === "city" && !String(subject.city || "").trim()) {
          unavailableBreakdowns.push({
            key: breakdown.key,
            label: "Citywide",
            reason: "The subject city is unavailable.",
          });
          return false;
        }
        if (breakdown.scope === "zip" && !subject.postal_code) {
          unavailableBreakdowns.push({
            key: breakdown.key,
            label: "Subject ZIP code",
            reason: "The subject ZIP code is unavailable.",
          });
          return false;
        }
        if (
          breakdown.scope === "radius" &&
          (
            subject?.location_status !== "matched" ||
            subject?.latitude == null ||
            subject?.longitude == null
          )
        ) {
          unavailableBreakdowns.push({
            key: breakdown.key,
            label: `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"}`,
            reason: "The subject parcel location is unavailable.",
          });
          return false;
        }
        return true;
      });

      if (!multipleBreakdownsRequested && unavailableBreakdowns.length) {
        return res.status(422).json({
          error: "subject_market_area_unavailable",
          subject_account_id: subjectAccountId,
        });
      }

      const analyses = [];
      for (const breakdown of availableBreakdowns) {
        const { rows } = await pool.query(
        `
          WITH parameters AS (
            SELECT
              COALESCE(NULLIF($1, '')::date, CURRENT_DATE) AS period_end,
              BTRIM($2) AS subject_city,
              NULLIF(BTRIM($3), '') AS subject_county,
              NULLIF(BTRIM($4), '') AS subject_postal_code,
              $5::double precision AS subject_latitude,
              $6::double precision AS subject_longitude,
              $7::text AS breakdown_scope,
              $8::double precision AS radius_miles
          ),
          eligible AS (
            SELECT
              sale.sale_price::numeric AS sale_price,
              sale.closing_date,
              sale.mls_bathrooms_total_integer::integer AS bathrooms_total,
              CASE
                WHEN sale.mls_garage_spaces IS NOT NULL
                  THEN ROUND(sale.mls_garage_spaces)::integer
                WHEN sale.mls_garage_yn = false
                  THEN 0
                ELSE NULL
              END AS garage_spaces,
              COALESCE(
                sale.mls_pool_yn,
                CASE
                  WHEN lower(btrim(sale.cad_pool::text))
                    IN ('true', 't', 'yes', 'y', '1') THEN true
                  WHEN lower(btrim(sale.cad_pool::text))
                    IN ('false', 'f', 'no', 'n', '0', '') THEN false
                  ELSE NULL
                END
              ) AS pool_yn,
              COALESCE(
                NULLIF(sale.mls_living_area, 0),
                NULLIF(sale.cad_living_area_sqft, 0)
              )::numeric AS living_area,
              sale.days_on_market
            FROM core.v_sales_enriched sale
            JOIN core.accounts sale_account
              ON sale_account.account_id = sale.primary_account_id
            LEFT JOIN core.account_locations sale_location
              ON sale_location.account_id = sale.primary_account_id
            CROSS JOIN parameters
            WHERE sale.record_type = 'closed_sale'
              AND sale.closing_date >=
                (parameters.period_end - INTERVAL '1 year')::date
              AND sale.closing_date <= parameters.period_end
              AND (
                (
                  parameters.breakdown_scope = 'city'
                  AND LOWER(BTRIM(sale_account.city)) =
                    LOWER(parameters.subject_city)
                  AND (
                    parameters.subject_county IS NULL
                    OR REGEXP_REPLACE(
                      LOWER(BTRIM(sale_account.county)),
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
                  parameters.breakdown_scope = 'zip'
                  AND parameters.subject_postal_code IS NOT NULL
                  AND NULLIF(
                    LEFT(
                      REGEXP_REPLACE(
                        COALESCE(
                          NULLIF(BTRIM(sale_account.postal_code), ''),
                          NULLIF(BTRIM(sale.zip), '')
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
                  parameters.breakdown_scope = 'radius'
                  AND parameters.subject_latitude IS NOT NULL
                  AND parameters.subject_longitude IS NOT NULL
                  AND parameters.radius_miles IS NOT NULL
                  AND sale_location.status = 'matched'
                  AND sale_location.latitude IS NOT NULL
                  AND sale_location.longitude IS NOT NULL
                  AND (
                    3958.7613 * ACOS(
                      LEAST(
                        1.0,
                        GREATEST(
                          -1.0,
                          COS(RADIANS(parameters.subject_latitude)) *
                          COS(RADIANS(sale_location.latitude)) *
                          COS(
                            RADIANS(sale_location.longitude) -
                            RADIANS(parameters.subject_longitude)
                          ) +
                          SIN(RADIANS(parameters.subject_latitude)) *
                          SIN(RADIANS(sale_location.latitude))
                        )
                      )
                    )
                  ) <= parameters.radius_miles
                )
              )
          ),
          living_area_ranked AS (
            SELECT
              eligible.*,
              NTILE(10) OVER (
                ORDER BY living_area, sale_price, closing_date
              ) AS living_area_group
            FROM eligible
            WHERE living_area > 0
          ),
          coverage AS (
            SELECT
              COUNT(*)::integer AS eligible_sale_count,
              COUNT(bathrooms_total)::integer AS bathroom_sale_count,
              COUNT(garage_spaces)::integer AS garage_sale_count,
              COUNT(pool_yn)::integer AS pool_sale_count,
              (COUNT(living_area) FILTER (WHERE living_area > 0))::integer
                AS living_area_sale_count,
              (SELECT period_end FROM parameters) AS period_end,
              (
                SELECT (period_end - INTERVAL '1 year')::date
                FROM parameters
              ) AS period_start
            FROM eligible
          ),
          dimension_rows AS (
            SELECT
              'bathrooms'::text AS dimension,
              bathrooms_total::text AS group_value,
              COUNT(*)::integer AS sample_size,
              MIN(sale_price) AS minimum_sale_price,
              MAX(sale_price) AS maximum_sale_price,
              AVG(sale_price) AS average_sale_price,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price) AS median_sale_price,
              percentile_cont(0.25) WITHIN GROUP
                (ORDER BY sale_price) AS lower_quartile_sale_price,
              percentile_cont(0.75) WITHIN GROUP
                (ORDER BY sale_price) AS upper_quartile_sale_price,
              stddev_samp(sale_price) AS sale_price_standard_deviation,
              AVG(sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
              AVG(living_area) FILTER (WHERE living_area > 0)
                AS average_living_area,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
                FILTER (WHERE living_area > 0) AS median_living_area,
              MIN(living_area) FILTER (WHERE living_area > 0)
                AS minimum_living_area,
              MAX(living_area) FILTER (WHERE living_area > 0)
                AS maximum_living_area,
              AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
                AS average_days_on_market,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
                FILTER (WHERE days_on_market >= 0) AS median_days_on_market
            FROM eligible
            WHERE bathrooms_total >= 1
            GROUP BY bathrooms_total

            UNION ALL

            SELECT
              'garage'::text AS dimension,
              garage_spaces::text AS group_value,
              COUNT(*)::integer AS sample_size,
              MIN(sale_price) AS minimum_sale_price,
              MAX(sale_price) AS maximum_sale_price,
              AVG(sale_price) AS average_sale_price,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price) AS median_sale_price,
              percentile_cont(0.25) WITHIN GROUP
                (ORDER BY sale_price) AS lower_quartile_sale_price,
              percentile_cont(0.75) WITHIN GROUP
                (ORDER BY sale_price) AS upper_quartile_sale_price,
              stddev_samp(sale_price) AS sale_price_standard_deviation,
              AVG(sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
              AVG(living_area) FILTER (WHERE living_area > 0)
                AS average_living_area,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
                FILTER (WHERE living_area > 0) AS median_living_area,
              MIN(living_area) FILTER (WHERE living_area > 0)
                AS minimum_living_area,
              MAX(living_area) FILTER (WHERE living_area > 0)
                AS maximum_living_area,
              AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
                AS average_days_on_market,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
                FILTER (WHERE days_on_market >= 0) AS median_days_on_market
            FROM eligible
            WHERE garage_spaces >= 0
            GROUP BY garage_spaces

            UNION ALL

            SELECT
              'pool'::text AS dimension,
              pool_yn::text AS group_value,
              COUNT(*)::integer AS sample_size,
              MIN(sale_price) AS minimum_sale_price,
              MAX(sale_price) AS maximum_sale_price,
              AVG(sale_price) AS average_sale_price,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price) AS median_sale_price,
              percentile_cont(0.25) WITHIN GROUP
                (ORDER BY sale_price) AS lower_quartile_sale_price,
              percentile_cont(0.75) WITHIN GROUP
                (ORDER BY sale_price) AS upper_quartile_sale_price,
              stddev_samp(sale_price) AS sale_price_standard_deviation,
              AVG(sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price / NULLIF(living_area, 0))
                FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
              AVG(living_area) FILTER (WHERE living_area > 0)
                AS average_living_area,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
                FILTER (WHERE living_area > 0) AS median_living_area,
              MIN(living_area) FILTER (WHERE living_area > 0)
                AS minimum_living_area,
              MAX(living_area) FILTER (WHERE living_area > 0)
                AS maximum_living_area,
              AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
                AS average_days_on_market,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
                FILTER (WHERE days_on_market >= 0) AS median_days_on_market
            FROM eligible
            WHERE pool_yn IS NOT NULL
            GROUP BY pool_yn

            UNION ALL

            SELECT
              'living_area'::text AS dimension,
              living_area_group::text AS group_value,
              COUNT(*)::integer AS sample_size,
              MIN(sale_price) AS minimum_sale_price,
              MAX(sale_price) AS maximum_sale_price,
              AVG(sale_price) AS average_sale_price,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price) AS median_sale_price,
              percentile_cont(0.25) WITHIN GROUP
                (ORDER BY sale_price) AS lower_quartile_sale_price,
              percentile_cont(0.75) WITHIN GROUP
                (ORDER BY sale_price) AS upper_quartile_sale_price,
              stddev_samp(sale_price) AS sale_price_standard_deviation,
              AVG(sale_price / living_area)
                AS average_price_per_square_foot,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY sale_price / living_area)
                AS median_price_per_square_foot,
              AVG(living_area) AS average_living_area,
              percentile_cont(0.5) WITHIN GROUP
                (ORDER BY living_area) AS median_living_area,
              MIN(living_area) AS minimum_living_area,
              MAX(living_area) AS maximum_living_area,
              AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
                AS average_days_on_market,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
                FILTER (WHERE days_on_market >= 0) AS median_days_on_market
            FROM living_area_ranked
            GROUP BY living_area_group
          )
          SELECT dimension_rows.*, coverage.*
          FROM dimension_rows
          CROSS JOIN coverage
          ORDER BY
            CASE dimension
              WHEN 'bathrooms' THEN 1
              WHEN 'garage' THEN 2
              WHEN 'pool' THEN 3
              ELSE 4
            END,
            CASE
              WHEN dimension = 'pool' AND group_value = 'false' THEN 0
              WHEN dimension = 'pool' AND group_value = 'true' THEN 1
              ELSE group_value::integer
            END
        `,
        [
          asOfDate,
          String(subject.city || ""),
          String(subject.county || ""),
          String(subject.postal_code || ""),
          subject.latitude == null ? null : Number(subject.latitude),
          subject.longitude == null ? null : Number(subject.longitude),
          breakdown.scope,
          breakdown.radiusMiles,
        ],
      );

        const coverageRow = rows[0] || {};
        const marketLabel =
          breakdown.scope === "city"
            ? [subject.city, subject.county].filter(Boolean).join(", ")
            : breakdown.scope === "zip"
              ? `ZIP ${subject.postal_code}`
              : `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
        analyses.push({
          subject: {
            account_id: subject.account_id,
            address: subject.address,
          },
          market: {
            key: breakdown.key,
            scope: breakdown.scope,
            city: subject.city,
            county: subject.county,
            postal_code: subject.postal_code,
            radius_miles: breakdown.radiusMiles,
            label: marketLabel,
          },
          period: {
            start: coverageRow.period_start || null,
            end: coverageRow.period_end || asOfDate || null,
          },
          population: {
            eligible_sale_count: Number(coverageRow.eligible_sale_count || 0),
            bathroom_sale_count: Number(coverageRow.bathroom_sale_count || 0),
            garage_sale_count: Number(coverageRow.garage_sale_count || 0),
            pool_sale_count: Number(coverageRow.pool_sale_count || 0),
            living_area_sale_count: Number(coverageRow.living_area_sale_count || 0),
          },
          filters: {
            record_type: "closed_sale",
            minimum_sale_price: null,
            review_flagged_sales_included: true,
            multi_parcel_sales_included: true,
            attached_housing_included: true,
            period_years: 1,
          },
          dimensions: buildDimensions(rows),
        });
      }

      if (!multipleBreakdownsRequested) {
        return res.json(analyses[0]);
      }

      res.json({
        subject: {
          account_id: subject.account_id,
          address: subject.address,
          city: subject.city,
          county: subject.county,
          postal_code: subject.postal_code,
          latitude: subject.latitude == null ? null : Number(subject.latitude),
          longitude: subject.longitude == null ? null : Number(subject.longitude),
        },
        analyses,
        unavailable_breakdowns: unavailableBreakdowns,
      });
    } catch (error) {
      logger.error?.("/api/sales/grouped-analysis failed", error);
      res.status(500).json({
        error: "grouped_analysis_failed",
        ...(debugEnabled()
          ? {
              detail: error?.message || String(error),
              database_code: error?.code || null,
            }
          : {}),
      });
    }
  });

  return router;
}
