import express from "express";

import { resolveComparableSearchProfile } from "../../util/comparableSearchProfiles.js";

export function createSalesListRouter({
  pool,
  accountIdAllowed,
  distanceSqlBuilder,
  resolveSearchProfile = resolveComparableSearchProfile,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("sales_list_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("sales_list_account_policy_required");
  }
  if (typeof distanceSqlBuilder !== "function" || typeof resolveSearchProfile !== "function") {
    throw new TypeError("sales_list_dependency_required");
  }

  const router = express.Router();

  /**
   * Search transaction-level sales from core.v_sales_enriched.
   *
   * A multi-parcel transaction is returned once. Its sale price must never be
   * multiplied by the number of linked parcels.
   */
  router.get("/api/sales", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const subjectAccountId = String(req.query.subject_account_id || "").trim();
      const accountId = String(req.query.account_id || "").trim();
      const excludeAccountId = String(req.query.exclude_account_id || "").trim();
      const neighborhoodCode = String(req.query.neighborhood_code || "").trim();
      const recordType = String(req.query.record_type || "closed_sale").trim().toLowerCase();
      const dateFrom = String(req.query.date_from || "").trim();
      const dateTo = String(req.query.date_to || "").trim();
      const multiParcel = String(req.query.multi_parcel || "").trim().toLowerCase();
      const limit = Math.min(Math.max(parseInt(String(req.query.limit || "25"), 10) || 25, 1), 200);
      const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
      const searchProfileRequested = req.query.search_profile !== undefined
        && String(req.query.search_profile).trim() !== "";
      const comparableSearchProfile = searchProfileRequested
        ? resolveSearchProfile(req.query.search_profile, { useDefault: false })
        : null;
      if (searchProfileRequested && !comparableSearchProfile) {
        return res.status(400).json({ error: "invalid_comparable_search_profile" });
      }

      const parseOptionalBoolean = (value, name) => {
        if (value === undefined || value === null || value === "") return null;
        const normalized = String(value).trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return true;
        if (["false", "0", "no"].includes(normalized)) return false;
        throw new Error(`invalid_${name}`);
      };

      const matched = parseOptionalBoolean(req.query.matched, "matched");
      const review = parseOptionalBoolean(req.query.review, "review");
      const includeAttached =
        parseOptionalBoolean(req.query.include_attached, "include_attached") ?? true;
      if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        return res.status(400).json({ error: "invalid_date_from" });
      }
      if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return res.status(400).json({ error: "invalid_date_to" });
      }
      if (multiParcel && !["single", "possible", "confirmed"].includes(multiParcel)) {
        return res.status(400).json({ error: "invalid_multi_parcel" });
      }
      if (!["closed_sale", "listing", "all"].includes(recordType)) {
        return res.status(400).json({ error: "invalid_record_type" });
      }
      if (subjectAccountId && !accountIdAllowed(subjectAccountId)) {
        return res.status(400).json({ error: "invalid_subject_account_id" });
      }
      if (comparableSearchProfile && !subjectAccountId) {
        return res.status(400).json({ error: "search_profile_requires_subject" });
      }

      const parsePrice = (value, name) => {
        if (value === undefined || value === null || value === "") return null;
        const parsed = Number(String(value).replace(/[$,\s]/g, ""));
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
        return parsed;
      };
      const minPrice = parsePrice(req.query.min_price, "min_price");
      const maxPrice = parsePrice(req.query.max_price, "max_price");
      if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
        return res.status(400).json({ error: "invalid_price_range" });
      }

      const params = [];
      const where = [];
      const bind = (value) => `$${params.push(value)}`;
      const subjectAccountPlaceholder = subjectAccountId
        ? bind(subjectAccountId)
        : null;
      const addAccountFilter = (id) => {
        const placeholder = bind(id);
        where.push(`(
          v.primary_account_id = ${placeholder}
          OR EXISTS (
            SELECT 1
            FROM core.sale_parcels sp
            WHERE sp.source_record_id = v.source_record_id
              AND sp.account_id = ${placeholder}
          )
        )`);
      };

      if (accountId) addAccountFilter(accountId);
      if (excludeAccountId) {
        const placeholder = bind(excludeAccountId);
        where.push(`(
          v.primary_account_id IS DISTINCT FROM ${placeholder}
          AND NOT EXISTS (
            SELECT 1
            FROM core.sale_parcels excluded_sp
            WHERE excluded_sp.source_record_id = v.source_record_id
              AND excluded_sp.account_id = ${placeholder}
          )
        )`);
      }
      if (neighborhoodCode) {
        where.push(`sale_account.neighborhood_code = ${bind(neighborhoodCode)}`);
      }
      if (q) {
        if (accountIdAllowed(q)) {
          addAccountFilter(q);
        } else {
          const pattern = bind(`%${q.replace(/%/g, "").replace(/_/g, "")}%`);
          where.push(`(
            v.address ILIKE ${pattern}
            OR sale_account.address ILIKE ${pattern}
            OR v.city ILIKE ${pattern}
            OR v.source ILIKE ${pattern}
          )`);
        }
      }
      const activityDateColumn =
        recordType === "listing"
          ? "v.listing_contract_date"
          : recordType === "all"
            ? "COALESCE(v.closing_date, v.listing_contract_date)"
            : "v.closing_date";
      if (dateFrom) where.push(`${activityDateColumn} >= ${bind(dateFrom)}::date`);
      if (dateTo) where.push(`${activityDateColumn} <= ${bind(dateTo)}::date`);
      if (minPrice !== null) where.push(`v.sale_price >= ${bind(minPrice)}`);
      if (maxPrice !== null) where.push(`v.sale_price <= ${bind(maxPrice)}`);
      if (matched !== null) {
        where.push(matched ? "v.primary_account_id IS NOT NULL" : "v.primary_account_id IS NULL");
      }
      if (review !== null) where.push(`v.requires_additional_review = ${bind(review)}`);
      if (multiParcel) where.push(`v.multi_parcel_status = ${bind(multiParcel)}`);
      if (recordType !== "all") where.push(`v.record_type = ${bind(recordType)}`);
      if (!includeAttached) {
        where.push("v.attachment_type NOT IN ('attached', 'mixed')");
      }

      const distanceSql = subjectAccountPlaceholder
        ? `
          CASE
            WHEN subject_location.latitude IS NULL
              OR subject_location.longitude IS NULL
              OR sale_location.latitude IS NULL
              OR sale_location.longitude IS NULL
            THEN NULL
            ELSE ${distanceSqlBuilder({
              subjectLatitude: "subject_location.latitude::double precision",
              subjectLongitude: "subject_location.longitude::double precision",
              comparableLatitude: "sale_location.latitude::double precision",
              comparableLongitude: "sale_location.longitude::double precision",
            })}
          END
        `
        : "NULL::double precision";
      const subjectLocationJoin = subjectAccountPlaceholder
        ? `LEFT JOIN core.account_locations subject_location
             ON subject_location.account_id = ${subjectAccountPlaceholder}`
        : "";
      if (comparableSearchProfile) {
        where.push(
          "subject_location.status = 'matched'",
          "sale_location.status = 'matched'",
          `(${distanceSql}) <= ${bind(comparableSearchProfile.radiusMiles)}::double precision`,
        );
      }

      const sql = `
        SELECT
          v.sale_id,
          v.source_record_id,
          (
            SELECT source_record.listing_id
            FROM core.sales_source_records source_record
            WHERE source_record.id = v.source_record_id
          ) AS listing_id,
          v.primary_account_id,
          v.county,
          sale_account.neighborhood_code,
          sale_account.subdivision,
          COALESCE(NULLIF(BTRIM(v.address), ''), NULLIF(BTRIM(sale_account.address), '')) AS address,
          v.city,
          v.state,
          v.zip,
          v.closing_date,
          v.sale_price,
          v.days_on_market,
          v.concessions,
          v.seller_contributions,
          v.listing_contract_date,
          v.buyer_financing,
          v.mls_status,
          v.record_type,
          v.structural_style,
          v.housing_type,
          v.attachment_type,
          v.architectural_style,
          v.source,
          v.source_filename,
          v.source_row_number,
          v.match_status,
          v.has_multiple_parcel_numbers,
          v.multi_parcel_status,
          v.has_unresolved_parcel,
          v.requires_additional_review,
          v.data_quality_flags,
          v.provided_parcel_fields,
          v.resolved_account_count,
          v.linked_parcels,
          v.mls_bedrooms_total,
          v.mls_bathrooms_total_integer,
          v.mls_bathrooms_full,
          v.mls_bathrooms_half,
          v.mls_living_area,
          v.mls_lot_size_area,
          v.mls_year_built,
          v.mls_garage_spaces,
          v.mls_garage_yn,
          v.mls_pool_yn,
          v.ratio_current_price_by_living_area,
          v.ratio_close_price_by_list_price,
          v.ratio_close_price_by_original_list_price,
          v.ratio_close_price_by_living_area,
          v.cad_bedroom_count,
          v.cad_bath_count,
          v.cad_baths_full,
          v.cad_baths_half,
          v.cad_living_area_sqft,
          v.cad_total_area_sqft,
          v.cad_year_built,
          v.cad_effective_year_built,
          v.cad_stories,
          v.cad_pool,
          v.cad_building_class,
          v.cad_land_value,
          v.cad_improvement_value,
          v.cad_market_value,
          media.primary_photo_url,
          COALESCE(media.photo_count, 0) AS photo_count,
          sale_location.latitude,
          sale_location.longitude,
          sale_location.status AS location_status,
          sale_location.source AS location_source,
          sale_location.precision AS location_precision,
          sale_location.confidence AS location_confidence,
          sale_location.review_required AS location_review_required,
          sale_location.review_reason AS location_review_reason,
          sale_location.geocoded_at AS location_geocoded_at,
          ${distanceSql} AS "distanceMiles"
        FROM core.v_sales_enriched v
        LEFT JOIN core.accounts sale_account
          ON sale_account.account_id = v.primary_account_id
        LEFT JOIN core.v_sales_media_summary media
          ON media.source_record_id = v.source_record_id
        LEFT JOIN core.account_locations sale_location
          ON sale_location.account_id = v.primary_account_id
        ${subjectLocationJoin}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${subjectAccountPlaceholder ? '"distanceMiles" ASC NULLS LAST,' : ""}
                 COALESCE(v.closing_date, v.listing_contract_date) DESC NULLS LAST,
                 v.source_record_id DESC NULLS LAST,
                 v.sale_id DESC NULLS LAST
        LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      `;

      const { rows } = await pool.query(sql, params);
      return res.json(rows);
    } catch (error) {
      const message = error?.message || "sales_search_failed";
      if (String(message).startsWith("invalid_")) {
        return res.status(400).json({ error: message });
      }
      logger.error?.("/api/sales failed", error);
      return res.status(500).json({ error: "sales_search_failed" });
    }
  });

  return router;
}
