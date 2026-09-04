import express from "express";

import {
  analyzeComparableOutliers,
  analysisWindow,
  applyRecommendationPolicy,
  DEFAULT_COMPARABLE_SCORING,
  DEFAULT_OUTLIER_ANALYSIS,
  DEFAULT_RECOMMENDATION_POLICY,
  filterComparablesForMarket,
  scoreComparable,
} from "../../util/comparableScoring.js";
import { resolveComparableSearchProfile } from "../../util/comparableSearchProfiles.js";
import { parseGroupedAnalysisBreakdowns } from "../../util/groupedAnalysisBreakdowns.js";
import { decorateAndRankByInfluence } from "../../util/propertyInfluence.js";
import { refreshAccountLocations } from "../../services/accountLocations.js";
import { summarizeComparableResults } from "../../services/comparableResponseSummary.js";
import { enqueueLocationBackfillAccounts } from "../../services/locationBackfillQueue.js";
import {
  enqueuePropertyInfluenceAccounts,
  getPropertyInfluenceContexts,
} from "../../services/propertyInfluenceStore.js";

function positiveSiteSize(value) {
  const parsed = typeof value === "string"
    ? Number(value.replace(/[^0-9.-]/g, ""))
    : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function manualLandSiteSize(value) {
  const rows = Array.isArray(value?.land_detail) ? value.land_detail : [];
  let total = 0;
  let measuredRows = 0;
  for (const row of rows) {
    const area = positiveSiteSize(row?.area_sqft);
    if (area === null) continue;
    total += area;
    measuredRows += 1;
  }
  return measuredRows > 0 && total > 0 ? total : null;
}

function mlsLotSizeSquareFeet(value) {
  const area = positiveSiteSize(value);
  if (area === null) return null;
  // NTREIS exports omit the unit column: values below 100 are acreage while
  // larger values are already square feet.
  return area < 100 ? area * 43_560 : area;
}

export function createComparableRecommendationsRouter({
  pool,
  accountIdAllowed,
  locationsReady,
  enrichmentReady,
  backfillReady,
  distanceSqlBuilder,
  resolveSearchProfile = resolveComparableSearchProfile,
  resolveAnalysisWindow = analysisWindow,
  parseBreakdowns = parseGroupedAnalysisBreakdowns,
  refreshLocations = refreshAccountLocations,
  loadInfluenceContexts = getPropertyInfluenceContexts,
  enqueueInfluences = enqueuePropertyInfluenceAccounts,
  enqueueLocationBackfill = enqueueLocationBackfillAccounts,
  scoreCandidate = scoreComparable,
  filterForMarket = filterComparablesForMarket,
  rankByInfluence = decorateAndRankByInfluence,
  applyPolicy = applyRecommendationPolicy,
  analyzeOutliers = analyzeComparableOutliers,
  summarizeResults = summarizeComparableResults,
  currentDate = () => new Date().toISOString().slice(0, 10),
  requireCustomAccountScope,
  requirePropertyTaxAccountScope,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("comparable_recommendations_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("comparable_recommendations_account_policy_required");
  }
  if (
    typeof requireCustomAccountScope !== "function"
    || typeof requirePropertyTaxAccountScope !== "function"
  ) {
    throw new TypeError("comparable_recommendations_access_policy_required");
  }
  for (const readiness of [locationsReady, enrichmentReady, backfillReady]) {
    if (!readiness || typeof readiness.then !== "function") {
      throw new TypeError("comparable_recommendations_readiness_required");
    }
  }
  if (
    typeof distanceSqlBuilder !== "function"
    || typeof resolveSearchProfile !== "function"
    || typeof resolveAnalysisWindow !== "function"
    || typeof parseBreakdowns !== "function"
    || typeof refreshLocations !== "function"
    || typeof loadInfluenceContexts !== "function"
    || typeof enqueueInfluences !== "function"
    || typeof enqueueLocationBackfill !== "function"
    || typeof scoreCandidate !== "function"
    || typeof filterForMarket !== "function"
    || typeof rankByInfluence !== "function"
    || typeof applyPolicy !== "function"
    || typeof analyzeOutliers !== "function"
    || typeof summarizeResults !== "function"
    || typeof currentDate !== "function"
  ) {
    throw new TypeError("comparable_recommendations_dependency_required");
  }

  const router = express.Router();

  /**
   * GET /api/sales/recommendations
   *
   * Ranks matched CAD sales first by comparable mapped location influences when
   * local influence coverage is sufficient, then by parcel-centroid distance (40%), continuous
   * living-area similarity (37%), year-built similarity (10%), site-size
   * similarity (5%), and closing-date recency (8%). The default
   * 12-month analysis period excludes older sales unless the caller explicitly
   * expands the period to 24 or 36 months. The response also returns lower-ranked
   * one-year challengers and a price-per-square-foot outlier audit for sales at
   * or above the requested score floor. Statistical flags require at least 30
   * distinct properties plus adequate data and time coverage.
   */
  router.get("/api/sales/recommendations", async (req, res) => {
    try {
      const subjectAccountId = String(
        req.query.subject_account_id || "",
      ).trim();
      const dateFrom = String(req.query.date_from || "").trim();
      const dateTo = String(req.query.date_to || "").trim();
      const requestedAnalysisAsOf = String(
        req.query.analysis_as_of ||
        dateTo ||
        currentDate(),
      ).trim();
      const requestedPeriodMonths = Number(
        req.query.period_months ||
        DEFAULT_RECOMMENDATION_POLICY.periodMonths,
      );
      const comparableSearchProfile = resolveSearchProfile(
        req.query.search_profile,
      );
      if (!comparableSearchProfile) {
        return res.status(400).json({ error: "invalid_comparable_search_profile" });
      }
      const marketBreakdownValue = String(
        req.query.market_breakdown || "",
      ).trim();
      const resultLimit = Math.min(
        Math.max(
          parseInt(String(req.query.limit || "25"), 10) || 25,
          DEFAULT_RECOMMENDATION_POLICY.count,
        ),
        100,
      );
      if (!accountIdAllowed(subjectAccountId)) {
        return res.status(400).json({ error: "invalid_subject_account_id" });
      }
      const assignmentFileId = String(req.query.assignment_file_id || "").trim();
      const propertyTaxFileId = String(req.query.property_tax_file_id || "").trim();
      if (assignmentFileId && propertyTaxFileId) {
        return res.status(400).json({ error: "ambiguous_recommendation_scope" });
      }
      const accessGranted = propertyTaxFileId
        ? await requirePropertyTaxAccountScope(
          req,
          res,
          subjectAccountId,
          propertyTaxFileId,
          "read",
        )
        : await requireCustomAccountScope(
          req,
          res,
          subjectAccountId,
          assignmentFileId || null,
          "read",
        );
      if (!accessGranted) return undefined;
      await locationsReady;
      await enrichmentReady;
      if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        return res.status(400).json({ error: "invalid_date_from" });
      }
      if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return res.status(400).json({ error: "invalid_date_to" });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAnalysisAsOf)) {
        return res.status(400).json({ error: "invalid_analysis_as_of" });
      }
      if (
        !Number.isInteger(requestedPeriodMonths) ||
        ![12, 24, 36].includes(requestedPeriodMonths)
      ) {
        return res.status(400).json({ error: "invalid_analysis_period" });
      }
      const requestedWindow = resolveAnalysisWindow(
        requestedAnalysisAsOf,
        requestedPeriodMonths,
      );
      if (!requestedWindow) {
        return res.status(400).json({ error: "invalid_analysis_period" });
      }
      const effectiveDateFrom =
        dateFrom || requestedWindow.analysisStartDate;
      const effectiveDateTo =
        dateTo || requestedWindow.analysisAsOf;
      let marketBreakdown = null;
      if (marketBreakdownValue) {
        try {
          const parsedBreakdowns = parseBreakdowns(
            marketBreakdownValue,
          );
          if (parsedBreakdowns.length !== 1) {
            return res.status(400).json({
              error: "invalid_market_breakdown",
            });
          }
          [marketBreakdown] = parsedBreakdowns;
        } catch {
          return res.status(400).json({
            error: "invalid_market_breakdown",
          });
        }
      }

      const parseTunableNumber = (value, fallback, minimum, maximum) => {
        if (value === undefined || value === null || value === "") return fallback;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
          throw new Error("invalid_scoring_configuration");
        }
        return parsed;
      };
      const scoringConfig = {
        locationWeight: parseTunableNumber(
          req.query.location_weight,
          DEFAULT_COMPARABLE_SCORING.locationWeight,
          0,
          1,
        ),
        squareFootageWeight: parseTunableNumber(
          req.query.square_footage_weight,
          DEFAULT_COMPARABLE_SCORING.squareFootageWeight,
          0,
          1,
        ),
        yearBuiltWeight: parseTunableNumber(
          req.query.year_built_weight,
          DEFAULT_COMPARABLE_SCORING.yearBuiltWeight,
          0,
          1,
        ),
        siteSizeWeight: parseTunableNumber(
          req.query.site_size_weight,
          DEFAULT_COMPARABLE_SCORING.siteSizeWeight,
          0,
          1,
        ),
        salesDateWeight: parseTunableNumber(
          req.query.sales_date_weight,
          DEFAULT_COMPARABLE_SCORING.salesDateWeight,
          0,
          1,
        ),
        locationScaleMiles: parseTunableNumber(
          req.query.location_scale_miles,
          DEFAULT_COMPARABLE_SCORING.locationScaleMiles,
          0.05,
          25,
        ),
        squareFootageScaleRatio: parseTunableNumber(
          req.query.square_footage_scale_ratio,
          DEFAULT_COMPARABLE_SCORING.squareFootageScaleRatio,
          0.01,
          1,
        ),
        yearBuiltScaleYears: parseTunableNumber(
          req.query.year_built_scale_years,
          DEFAULT_COMPARABLE_SCORING.yearBuiltScaleYears,
          1,
          100,
        ),
        siteSizeScaleRatio: parseTunableNumber(
          req.query.site_size_scale_ratio,
          DEFAULT_COMPARABLE_SCORING.siteSizeScaleRatio,
          0.01,
          2,
        ),
        salesDateScaleDays: parseTunableNumber(
          req.query.sales_date_scale_days,
          DEFAULT_COMPARABLE_SCORING.salesDateScaleDays,
          30,
          1095,
        ),
      };
      const outlierScoreThreshold = parseTunableNumber(
        req.query.outlier_score_threshold,
        DEFAULT_OUTLIER_ANALYSIS.scoreThreshold,
        0,
        100,
      );
      if (
        scoringConfig.locationWeight +
          scoringConfig.squareFootageWeight +
          scoringConfig.yearBuiltWeight +
          scoringConfig.siteSizeWeight +
          scoringConfig.salesDateWeight <=
        0
      ) {
        return res.status(400).json({ error: "invalid_scoring_configuration" });
      }

      const loadSubject = async () => {
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
              profile.structural_style,
              profile.housing_type,
              profile.attachment_type,
              COALESCE(improvement.living_area_sqft, improvement.total_living_area) AS living_area_sqft,
              COALESCE(
                CASE
                  WHEN manual_report.attribute_value #>> '{main_improvement,year_built}' ~ '^[0-9]{4}$'
                    THEN (manual_report.attribute_value #>> '{main_improvement,year_built}')::integer
                  ELSE NULL
                END,
                improvement.year_built
              ) AS year_built,
              manual_land_report.attribute_value AS manual_land_value,
              cad_site.site_size_sqft AS cad_site_size_sqft,
              location.latitude,
              location.longitude,
              location.status AS location_status,
              location.source AS location_source,
              location.precision AS location_precision,
              location.confidence AS location_confidence,
              location.review_required AS location_review_required,
              location.review_reason AS location_review_reason,
              location.geocoded_at
            FROM core.accounts account
            LEFT JOIN core.primary_improvements improvement
              ON improvement.account_id = account.account_id
            LEFT JOIN core.v_account_housing_profiles profile
              ON profile.account_id = account.account_id
            LEFT JOIN app.property_attribute_manual_values manual_report
              ON manual_report.account_id = account.account_id
             AND manual_report.attribute_key = 'report.property_characteristics'
            LEFT JOIN app.property_attribute_manual_values manual_land_report
              ON manual_land_report.account_id = account.account_id
             AND manual_land_report.attribute_key = 'report.land_details'
            LEFT JOIN LATERAL (
              SELECT SUM(land.area_sqft)::numeric AS site_size_sqft
              FROM core.land_detail land
              WHERE land.account_id = account.account_id
                AND land.tax_year = (
                  SELECT MAX(latest_land.tax_year)
                  FROM core.land_detail latest_land
                  WHERE latest_land.account_id = account.account_id
                )
            ) cad_site ON TRUE
            LEFT JOIN core.account_locations location
              ON location.account_id = account.account_id
            WHERE account.account_id = $1
          `,
          [subjectAccountId],
        );
        const row = rows[0] || null;
        if (!row) return null;
        row.site_size_sqft =
          manualLandSiteSize(row.manual_land_value) ??
          positiveSiteSize(row.cad_site_size_sqft);
        delete row.manual_land_value;
        delete row.cad_site_size_sqft;
        return row;
      };

      let subject = await loadSubject();
      if (!subject) {
        return res.status(404).json({ error: "subject_not_found" });
      }
      if (
        subject.location_status !== "matched" ||
        subject.latitude == null ||
        subject.longitude == null
      ) {
        await refreshLocations(pool, [subject], { batchSize: 1 });
        subject = await loadSubject();
      }
      if (
        subject?.location_status !== "matched" ||
        subject?.latitude == null ||
        subject?.longitude == null
      ) {
        return res.status(422).json({
          error: "subject_location_unavailable",
          subject_account_id: subjectAccountId,
        });
      }
      if (!Number.isFinite(Number(subject.living_area_sqft)) || Number(subject.living_area_sqft) <= 0) {
        return res.status(422).json({
          error: "subject_living_area_unavailable",
          subject_account_id: subjectAccountId,
        });
      }

      const subjectInfluenceContexts = await loadInfluenceContexts(
        pool,
        [subjectAccountId],
      );
      const subjectInfluenceContext = subjectInfluenceContexts.get(subjectAccountId) || null;
      const subjectInfluenceSignature = subjectInfluenceContext?.influence_signature || null;
      if (!subjectInfluenceSignature) {
        void enqueueInfluences(pool, [subjectAccountId], {
          reason: "comparable_subject",
          priority: 120,
        }).catch((error) => {
          logger.warn?.(
            "[recommendations] subject influence queueing failed",
            error?.message || error,
          );
        });
      }

      const candidateParams = [subjectAccountId];
      const candidateWhere = [
        "sale.primary_account_id IS NOT NULL",
        "sale.primary_account_id <> $1",
        "sale.record_type = 'closed_sale'",
      ];
      candidateParams.push(effectiveDateFrom);
      candidateWhere.push(
        `sale.closing_date >= $${candidateParams.length}::date`,
      );
      candidateParams.push(effectiveDateTo);
      candidateWhere.push(
        `sale.closing_date <= $${candidateParams.length}::date`,
      );
      const subjectLatitude = Number(subject.latitude);
      const subjectLongitude = Number(subject.longitude);
      const radiusMiles = comparableSearchProfile.radiusMiles;
      const latitudeDelta = radiusMiles / 69;
      const longitudeDelta = radiusMiles /
        (69 * Math.max(Math.cos(subjectLatitude * Math.PI / 180), 0.1));
      const latitudeMinimum = `$${candidateParams.push(subjectLatitude - latitudeDelta)}::double precision`;
      const latitudeMaximum = `$${candidateParams.push(subjectLatitude + latitudeDelta)}::double precision`;
      const longitudeMinimum = `$${candidateParams.push(subjectLongitude - longitudeDelta)}::double precision`;
      const longitudeMaximum = `$${candidateParams.push(subjectLongitude + longitudeDelta)}::double precision`;
      const subjectLatitudeSql = `$${candidateParams.push(subjectLatitude)}::double precision`;
      const subjectLongitudeSql = `$${candidateParams.push(subjectLongitude)}::double precision`;
      const radiusMilesSql = `$${candidateParams.push(radiusMiles)}::double precision`;
      const candidateDistanceSql = distanceSqlBuilder({
        subjectLatitude: subjectLatitudeSql,
        subjectLongitude: subjectLongitudeSql,
        comparableLatitude: "location.latitude::double precision",
        comparableLongitude: "location.longitude::double precision",
      });
      candidateWhere.push(
        "location.status = 'matched'",
        "location.latitude IS NOT NULL",
        "location.longitude IS NOT NULL",
      );
      const standardRadiusScopeSql = `(
        location.latitude::double precision BETWEEN ${latitudeMinimum} AND ${latitudeMaximum}
        AND location.longitude::double precision BETWEEN ${longitudeMinimum} AND ${longitudeMaximum}
        AND (${candidateDistanceSql}) <= ${radiusMilesSql}
      )`;
      const subjectMaterialCategories = subjectInfluenceSignature?.material_influence_present
        ? subjectInfluenceSignature.material_categories || []
        : [];
      if (subjectMaterialCategories.length) {
        const influenceCategoriesSql = `$${candidateParams.push(subjectMaterialCategories)}::text[]`;
        candidateWhere.push(`(
          ${standardRadiusScopeSql}
          OR candidate_influence.material_categories && ${influenceCategoriesSql}
        )`);
      } else {
        candidateWhere.push(standardRadiusScopeSql);
      }

      const candidateSql = `
        SELECT
          sale.sale_id,
          sale.source_record_id,
          (
            SELECT source_record.listing_id
            FROM core.sales_source_records source_record
            WHERE source_record.id = sale.source_record_id
          ) AS listing_id,
          sale.primary_account_id,
          sale.county,
          account.county AS account_county,
          account.neighborhood_code,
          account.subdivision,
          COALESCE(NULLIF(BTRIM(sale.address), ''), NULLIF(BTRIM(account.address), '')) AS address,
          COALESCE(NULLIF(BTRIM(sale.city), ''), NULLIF(BTRIM(account.city), '')) AS city,
          sale.state,
          COALESCE(NULLIF(BTRIM(sale.zip), ''), NULLIF(BTRIM(account.postal_code), '')) AS zip,
          sale.closing_date,
          sale.sale_price,
          sale.days_on_market,
          sale.concessions,
          sale.seller_contributions,
          sale.listing_contract_date,
          sale.buyer_financing,
          sale.mls_status,
          sale.record_type,
          sale.structural_style,
          sale.housing_type,
          sale.attachment_type,
          sale.architectural_style,
          sale.source,
          sale.source_filename,
          sale.source_row_number,
          sale.match_status,
          sale.has_multiple_parcel_numbers,
          sale.multi_parcel_status,
          sale.has_unresolved_parcel,
          sale.requires_additional_review,
          sale.data_quality_flags,
          sale.provided_parcel_fields,
          sale.resolved_account_count,
          sale.linked_parcels,
          sale.mls_bedrooms_total,
          sale.mls_bathrooms_total_integer,
          sale.mls_bathrooms_full,
          sale.mls_bathrooms_half,
          sale.mls_living_area,
          sale.mls_lot_size_area,
          sale.mls_year_built,
          sale.mls_garage_spaces,
          sale.mls_garage_yn,
          sale.mls_pool_yn,
          sale.ratio_current_price_by_living_area,
          sale.ratio_close_price_by_list_price,
          sale.ratio_close_price_by_original_list_price,
          sale.ratio_close_price_by_living_area,
          sale.cad_bedroom_count,
          sale.cad_bath_count,
          sale.cad_baths_full,
          sale.cad_baths_half,
          sale.cad_living_area_sqft,
          sale.cad_total_area_sqft,
          sale.cad_year_built,
          sale.cad_effective_year_built,
          sale.cad_stories,
          sale.cad_pool,
          sale.cad_building_class,
          sale.cad_land_value,
          sale.cad_improvement_value,
          sale.cad_market_value,
          manual_land_report.attribute_value AS manual_land_value,
          CASE
            WHEN manual_report.attribute_value #>> '{main_improvement,year_built}' ~ '^[0-9]{4}$'
              THEN (manual_report.attribute_value #>> '{main_improvement,year_built}')::integer
            ELSE NULL
          END AS manual_year_built,
          media.primary_photo_url,
          COALESCE(media.photo_count, 0) AS photo_count,
          location.latitude,
          location.longitude,
          location.status AS location_status,
          location.source AS location_source,
          location.precision AS location_precision,
          location.confidence AS location_confidence,
          location.review_required AS location_review_required,
          location.review_reason AS location_review_reason,
          location.geocoded_at AS location_geocoded_at,
          candidate_influence.influence_signature AS candidate_influence_signature,
          candidate_influence.material_keys AS candidate_material_keys,
          candidate_influence.material_categories AS candidate_material_categories,
          candidate_influence.computed_at AS candidate_influence_computed_at
        FROM core.v_sales_enriched sale
        JOIN core.accounts account
          ON account.account_id = sale.primary_account_id
        LEFT JOIN core.account_locations location
          ON location.account_id = sale.primary_account_id
        LEFT JOIN gis.property_influence_contexts candidate_influence
          ON candidate_influence.account_id = sale.primary_account_id
         AND candidate_influence.methodology_version >= 3
        LEFT JOIN app.property_attribute_manual_values manual_report
          ON manual_report.account_id = sale.primary_account_id
         AND manual_report.attribute_key = 'report.property_characteristics'
        LEFT JOIN app.property_attribute_manual_values manual_land_report
          ON manual_land_report.account_id = sale.primary_account_id
         AND manual_land_report.attribute_key = 'report.land_details'
        LEFT JOIN core.v_sales_media_summary media
          ON media.source_record_id = sale.source_record_id
        WHERE ${candidateWhere.join(" AND ")}
        ORDER BY sale.closing_date DESC NULLS LAST,
                 sale.source_record_id DESC NULLS LAST,
                 sale.sale_id DESC NULLS LAST
        LIMIT 10000
      `;
      const { rows: candidates } = await pool.query(
        candidateSql,
        candidateParams,
      );

      // Ranking uses only cached coordinates. Missing candidate locations are
      // prioritized for the background worker without delaying this response.
      const candidateLocationQueue = [
        ...new Map(
          candidates
            .filter(
              (candidate) =>
                candidate.primary_account_id &&
                (
                  candidate.location_status !== "matched" ||
                  candidate.latitude == null ||
                  candidate.longitude == null
                ),
            )
            .map((candidate) => [
              candidate.primary_account_id,
              {
                account_id: candidate.primary_account_id,
                address: candidate.address,
                county: candidate.account_county || candidate.county,
              },
            ]),
        ).values(),
      ].slice(0, 1000);
      if (candidateLocationQueue.length) {
        void (async () => {
          await backfillReady;
          await enqueueLocationBackfill(pool, candidateLocationQueue, {
            reason: "comparable_recommendation",
            priority: 100,
          });
        })().catch((error) => {
          logger.warn?.(
            "[recommendations] candidate location queueing failed",
            error?.message || error,
          );
        });
      }

      const candidateAccountIds = [
        ...new Set(
          candidates
            .map((candidate) => candidate.primary_account_id)
            .filter(Boolean),
        ),
      ];
      const missingInfluenceAccounts = candidates
        .filter((candidate) => !candidate.candidate_influence_signature)
        .slice(0, 1_000)
        .map((candidate) => candidate.primary_account_id);
      if (missingInfluenceAccounts.length) {
        void enqueueInfluences(pool, missingInfluenceAccounts, {
          reason: "comparable_recommendation",
          priority: 110,
        }).catch((error) => {
          logger.warn?.(
            "[recommendations] candidate influence queueing failed",
            error?.message || error,
          );
        });
      }
      const cadSiteSizeByAccount = new Map();
      if (candidateAccountIds.length) {
        const { rows: cadSiteRows } = await pool.query(
          `
            SELECT account_id, SUM(area_sqft)::numeric AS site_size_sqft
            FROM (
              SELECT
                land.account_id,
                land.area_sqft,
                land.tax_year,
                MAX(land.tax_year) OVER (PARTITION BY land.account_id) AS latest_tax_year
              FROM core.land_detail land
              WHERE land.account_id = ANY($1::text[])
            ) latest_land
            WHERE tax_year = latest_tax_year
            GROUP BY account_id
          `,
          [candidateAccountIds],
        );
        for (const row of cadSiteRows) {
          const siteSize = positiveSiteSize(row.site_size_sqft);
          if (siteSize !== null) {
            cadSiteSizeByAccount.set(row.account_id, siteSize);
          }
        }
      }

      let missingLocationCount = 0;
      let unsupportedCountyCount = 0;
      let missingSquareFootageCount = 0;
      let missingYearBuiltCount = 0;
      let missingSiteSizeCount = 0;
      const scored = [];
      for (const candidate of candidates) {
        if (
          candidate.location_status !== "matched" ||
          candidate.latitude == null ||
          candidate.longitude == null
        ) {
          const candidateCounty = String(candidate.account_county || "")
            .trim()
            .toLowerCase();
          if (candidateCounty && !candidateCounty.includes("dallas")) {
            unsupportedCountyCount += 1;
          } else {
            missingLocationCount += 1;
          }
          continue;
        }
        const comparableSquareFeet =
          candidate.cad_living_area_sqft ?? candidate.mls_living_area;
        if (
          !Number.isFinite(Number(comparableSquareFeet)) ||
          Number(comparableSquareFeet) <= 0
        ) {
          missingSquareFootageCount += 1;
          continue;
        }
        const comparableYearBuilt =
          candidate.manual_year_built ??
          candidate.cad_year_built ??
          candidate.mls_year_built;
        if (
          !Number.isFinite(Number(subject.year_built)) ||
          Number(subject.year_built) <= 0 ||
          !Number.isFinite(Number(comparableYearBuilt)) ||
          Number(comparableYearBuilt) <= 0
        ) {
          missingYearBuiltCount += 1;
        }
        const manualSiteSize = manualLandSiteSize(candidate.manual_land_value);
        delete candidate.manual_land_value;
        const cadSiteSize = cadSiteSizeByAccount.get(candidate.primary_account_id) ?? null;
        const mlsSiteSize = mlsLotSizeSquareFeet(candidate.mls_lot_size_area);
        const candidateCounty = String(
          candidate.account_county || candidate.county || "",
        ).toLowerCase();
        const comparableSiteSize = manualSiteSize ?? (
          candidateCounty.includes("dallas")
            ? cadSiteSize ?? mlsSiteSize
            : mlsSiteSize ?? cadSiteSize
        );
        if (
          !Number.isFinite(Number(subject.site_size_sqft)) ||
          Number(subject.site_size_sqft) <= 0 ||
          !Number.isFinite(Number(comparableSiteSize)) ||
          Number(comparableSiteSize) <= 0
        ) {
          missingSiteSizeCount += 1;
        }
        const score = scoreCandidate(
          {
            subjectLatitude: subject.latitude,
            subjectLongitude: subject.longitude,
            comparableLatitude: candidate.latitude,
            comparableLongitude: candidate.longitude,
            subjectSquareFeet: subject.living_area_sqft,
            comparableSquareFeet,
            subjectYearBuilt: subject.year_built,
            comparableYearBuilt,
            subjectSiteSize: subject.site_size_sqft,
            comparableSiteSize,
            closingDate: candidate.closing_date,
            referenceDate: effectiveDateTo,
            subjectHousingType: subject.housing_type,
            subjectAttachmentType: subject.attachment_type,
            subjectStructuralStyle: subject.structural_style,
            comparableHousingType: candidate.housing_type,
            comparableAttachmentType: candidate.attachment_type,
            comparableStructuralStyle: candidate.structural_style,
          },
          scoringConfig,
        );
        if (!score) continue;
        scored.push({
          ...candidate,
          ...score,
          comparable_square_feet: Number(comparableSquareFeet),
          score_requires_review:
            Boolean(candidate.requires_additional_review) ||
            Boolean(candidate.location_review_required) ||
            !score.ageDataAvailable ||
            !score.siteDataAvailable,
        });
      }

      const scoped = filterForMarket(
        scored,
        subject,
        marketBreakdown,
      );

      scoped.sort(
        (left, right) =>
          right.comparableScore - left.comparableScore ||
          left.distanceMiles - right.distanceMiles ||
          left.squareFootageDifferenceRatio -
            right.squareFootageDifferenceRatio ||
          String(right.closing_date || "").localeCompare(
            String(left.closing_date || ""),
          ),
      );
      const influenceRanked = rankByInfluence(
        scoped,
        subjectInfluenceSignature,
        (candidate) => candidate.candidate_influence_signature || null,
      );
      const rankedScoped = influenceRanked.sales.map((candidate) => ({
        ...candidate,
        influence_support_candidate:
          Number(candidate.distanceMiles) > Number(radiusMiles) &&
          candidate.influence_similarity?.exact_material_match === true,
        candidate_purpose:
          Number(candidate.distanceMiles) > Number(radiusMiles) &&
          candidate.influence_similarity?.exact_material_match === true
            ? "influence_support"
            : "primary_similarity",
      }));
      rankedScoped.forEach((candidate, index) => {
        candidate.score_rank = index + 1;
      });
      const recommendationResult = applyPolicy(rankedScoped, {
        referenceDate: effectiveDateTo,
        policy: {
          ...DEFAULT_RECOMMENDATION_POLICY,
          periodMonths: requestedPeriodMonths,
        },
      });
      const outlierResult = analyzeOutliers(
        recommendationResult.sales,
        {
          ...DEFAULT_OUTLIER_ANALYSIS,
          scoreThreshold: outlierScoreThreshold,
        },
      );
      const analyzedSales = outlierResult.sales;
      const {
        recommendedSales,
        secondarySales,
        olderThanOneYearCount,
        olderThanTwoYearsCount,
      } = summarizeResults(analyzedSales);

      const marketLabel = !marketBreakdown
        ? "All eligible sales"
        : marketBreakdown.scope === "city"
          ? [subject.city, subject.county].filter(Boolean).join(", ")
          : marketBreakdown.scope === "zip"
            ? `ZIP ${subject.postal_code}`
            : `Within ${marketBreakdown.radiusMiles} mile${marketBreakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;

      res.json({
        subject: {
          account_id: subject.account_id,
          address: subject.address,
          city: subject.city,
          county: subject.county,
          postal_code: subject.postal_code,
          neighborhood_code: subject.neighborhood_code,
          structural_style: subject.structural_style,
          housing_type: subject.housing_type,
          attachment_type: subject.attachment_type,
          living_area_sqft: Number(subject.living_area_sqft),
          year_built: Number.isFinite(Number(subject.year_built))
            ? Number(subject.year_built)
            : null,
          site_size_sqft: Number.isFinite(Number(subject.site_size_sqft))
            ? Number(subject.site_size_sqft)
            : null,
          latitude: Number(subject.latitude),
          longitude: Number(subject.longitude),
          location_source: subject.location_source,
          location_precision: subject.location_precision,
          location_confidence: subject.location_confidence,
          location_review_required: subject.location_review_required,
          location_review_reason: subject.location_review_reason,
          location_geocoded_at: subject.geocoded_at,
          influence_signature: subjectInfluenceSignature,
        },
        scoring: {
          ...scoringConfig,
          locationWeightPercent: Math.round(scoringConfig.locationWeight * 100),
          squareFootageWeightPercent: Math.round(
            scoringConfig.squareFootageWeight * 100,
          ),
          yearBuiltWeightPercent: Math.round(
            scoringConfig.yearBuiltWeight * 100,
          ),
          siteSizeWeightPercent: Math.round(
            scoringConfig.siteSizeWeight * 100,
          ),
          salesDateWeightPercent: Math.round(
            scoringConfig.salesDateWeight * 100,
          ),
          squareFootageScalePercent: Math.round(
            scoringConfig.squareFootageScaleRatio * 100,
          ),
          yearBuiltScaleYears: Math.round(scoringConfig.yearBuiltScaleYears),
          siteSizeScalePercent: Math.round(
            scoringConfig.siteSizeScaleRatio * 100,
          ),
          salesDateScaleDays: Math.round(scoringConfig.salesDateScaleDays),
          squareFootageIsHardFilter: false,
        },
        coverage: {
          candidate_count: candidates.length,
          eligible_count: scoped.length,
          total_scored_count: scored.length,
          scope_eligible_count: scoped.length,
          missing_location_count: missingLocationCount,
          unsupported_county_count: unsupportedCountyCount,
          missing_square_footage_count: missingSquareFootageCount,
          missing_year_built_count: missingYearBuiltCount,
          missing_site_size_count: missingSiteSizeCount,
          housing_type_mismatch_count:
            recommendationResult.policy.housingTypeMismatchCount,
          recommended_count: recommendedSales.length,
          older_than_two_years_count: olderThanTwoYearsCount,
          older_than_one_year_count: olderThanOneYearCount,
          recent_high_score_count:
            recommendationResult.policy.recentHighScoreCount,
          influence_context_count: influenceRanked.policy.measured_sale_count,
          missing_influence_context_count: Math.max(
            0,
            influenceRanked.policy.eligible_sale_count -
              influenceRanked.policy.measured_sale_count,
          ),
        },
        influence_ranking: influenceRanked.policy,
        recommendation_policy: recommendationResult.policy,
        statistical_analysis: outlierResult.analysis,
        analysis_period: {
          analysis_as_of: effectiveDateTo,
          date_from: effectiveDateFrom,
          period_months: requestedPeriodMonths,
        },
        search_profile: {
          key: comparableSearchProfile.key,
          label: comparableSearchProfile.label,
          geography: comparableSearchProfile.geography,
          complexity: comparableSearchProfile.complexity,
          radius_miles: comparableSearchProfile.radiusMiles,
        },
        study_market: {
          key: marketBreakdown?.key || null,
          scope: marketBreakdown?.scope || null,
          radius_miles: marketBreakdown?.radiusMiles || null,
          label: marketLabel,
        },
        recommended_sales: recommendedSales,
        secondary_sales: secondarySales.slice(0, resultLimit),
        competitive_sales: secondarySales.slice(0, resultLimit),
        sales: analyzedSales.slice(0, resultLimit),
      });
    } catch (err) {
      const message = err?.message || "comparable_recommendations_failed";
      if (String(message).startsWith("invalid_")) {
        return res.status(400).json({ error: message });
      }
      logger.error?.("/api/sales/recommendations failed", err);
      res.status(500).json({ error: "comparable_recommendations_failed" });
    }
  });

  return router;
}
