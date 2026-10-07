import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { findAccountByCountyIdentifier } from "../../services/salesReconciliation.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
import { PaginationError, parsePagination } from "../../util/pagination.js";
import { normalizePropertyCity, parsePropertySearch } from "../../util/propertySearch.js";

export function createPropertySearchRouter({
  pool,
  accountQualityReady,
  salesReconciliationReady,
  requireApplicationReader,
  hasPermission = hasApplicationPermission,
  normalizeCity = normalizePropertyCity,
  parseSearch = parsePropertySearch,
  findCountyAccount = findAccountByCountyIdentifier,
  resolveAccountId = resolveCanonicalAccountId,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("property_search_pool_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("property_search_account_readiness_required");
  }
  if (!salesReconciliationReady || typeof salesReconciliationReady.then !== "function") {
    throw new TypeError("property_search_sales_readiness_required");
  }
  if (typeof requireApplicationReader !== "function") {
    throw new TypeError("property_search_reader_policy_required");
  }
  if (
    typeof normalizeCity !== "function"
    || typeof parseSearch !== "function"
    || typeof findCountyAccount !== "function"
    || typeof hasPermission !== "function"
    || typeof resolveAccountId !== "function"
  ) {
    throw new TypeError("property_search_dependency_required");
  }

  const router = express.Router();

  /** Search Dallas and reconciled non-Dallas accounts by identifiers or indexed address data. */
  router.get("/api/search", async (req, res) => {
    if (!requireApplicationReader(req, res)) return undefined;
    try {
      await accountQualityReady;
      await salesReconciliationReady;
      const q = String(req.query.q || "").trim();
      const requestedCity = normalizeCity(req.query.city) || null;
      if (!q && !requestedCity) return res.json([]);
      const { limit, offset } = parsePagination(req.query, { defaultLimit: 25 });

      const parsed = q ? parseSearch(q) : null;
      if (q && !parsed.isAccountId && !parsed.normalizedAddress) return res.json([]);

      const params = [];
      const bind = (value) => `$${params.push(value)}`;
      const manualOrganizationIds = (req.mobileAuth?.organizations || [])
        .filter((organization) => hasPermission(
          req.mobileAuth, "custom_appraisal", "read", organization.organizationId,
        ))
        .map((organization) => organization.organizationId);
      let where;
      let matchSql;
      let orderSql;
      let requestedLegacyAccountId = null;
      const citySql = `upper(COALESCE(a.city, '')) COLLATE "C"`;
      const cityWhere = (parsedCity = null) => {
        const filters = [];
        if (parsedCity) filters.push(`upper(a.city) = ${bind(parsedCity)}`);
        if (requestedCity) filters.push(`${citySql} LIKE ${bind(`${requestedCity}%`)}`);
        return filters.length ? `AND ${filters.join(" AND ")}` : "";
      };

      if (!q && requestedCity) {
        const cityPlaceholder = bind(`${requestedCity}%`);
        where = `
          a.canonical_account_id IS NULL
          AND ${citySql} LIKE ${cityPlaceholder}
        `;
        matchSql = `'city_prefix'`;
        orderSql = `
          ${citySql},
          upper(COALESCE(a.street_name, '')) COLLATE "C",
          upper(btrim(split_part(COALESCE(a.address, ''), ',', 1))) COLLATE "C",
          a.account_id
        `;
      } else if (parsed.isAccountId) {
        await salesReconciliationReady;
        const countyAccount = await findCountyAccount(pool, q);
        const canonicalAccountId = countyAccount?.account_id || await resolveAccountId(pool, q);
        if (canonicalAccountId !== q.toUpperCase()) {
          requestedLegacyAccountId = q;
        }
        where = `a.account_id = ${bind(canonicalAccountId)} ${cityWhere(parsed.city)}`;
        matchSql = `'exact_account'`;
        orderSql = "a.account_id";
      } else if (parsed.isAddressPrefix) {
        const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
        const normalizedAddressPlaceholder = bind(parsed.normalizedAddress);
        const addressPrefixPlaceholder = bind(`${parsed.normalizedAddress}%`);
        const cityFilter = cityWhere(parsed.city);

        where = `
          a.address IS NOT NULL
          AND a.canonical_account_id IS NULL
          AND ${addressLineSql} LIKE ${addressPrefixPlaceholder}
          ${cityFilter}
        `;
        matchSql = `
          CASE
            WHEN ${addressLineSql} = ${normalizedAddressPlaceholder} THEN 'exact_address'
            ELSE 'address_prefix'
          END
        `;
        orderSql = `
          ${addressLineSql},
          upper(COALESCE(a.city, '')) COLLATE "C",
          a.account_id
        `;
      } else {
        const streetSql = `upper(a.street_name) COLLATE "C"`;
        const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
        const streetPlaceholder = bind(`${parsed.streetName}%`);
        const cityFilter = cityWhere(parsed.city);

        where = `
          a.street_name IS NOT NULL
          AND a.canonical_account_id IS NULL
          AND ${streetSql} LIKE ${streetPlaceholder}
          ${cityFilter}
        `;
        matchSql = `'same_street'`;
        orderSql = `
          ${streetSql},
          ${citySql},
          ${addressLineSql},
          a.account_id
        `;
      }

      const manualVisibilitySql = manualOrganizationIds.length ? `EXISTS (
              SELECT 1 FROM app.report_files manual_file
              WHERE manual_file.account_id = a.account_id
                AND manual_file.workflow_type = 'custom_appraisal'
                AND manual_file.organization_id = ANY(${bind(manualOrganizationIds)}::uuid[])
            )` : "FALSE";
      const sql = `
        SELECT
          a.account_id,
          a.address,
          a.street_name,
          a.city,
          a.postal_code,
          a.county,
          a.neighborhood_code,
          a.subdivision,
          a.legal_description,
          a.data_quality_status,
          a.data_quality_flags,
          a.canonical_account_id,
          native_identifier.native_account_id,
          ${matchSql} AS search_match,
          COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
          COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
          COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
          COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
          COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
        FROM core.accounts a
        LEFT JOIN LATERAL (
          SELECT identifier.native_account_id
          FROM app.county_account_identifiers identifier
          WHERE identifier.account_id = a.account_id
          ORDER BY
            (identifier.verification_source = 'collin_cad_open_data') DESC,
            identifier.updated_at DESC
          LIMIT 1
        ) native_identifier ON TRUE
        LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
        LEFT JOIN LATERAL (
          SELECT m.* FROM core.market_values m
          WHERE m.account_id = a.account_id
          ORDER BY m.tax_year DESC
          LIMIT 1
        ) mv ON TRUE
        WHERE ${where}
          AND (a.data_quality_status IS DISTINCT FROM 'manual_subject'
            OR ${manualVisibilitySql})
        ORDER BY ${orderSql}
        LIMIT ${bind(limit)} OFFSET ${bind(offset)}
      `;
      const { rows } = await pool.query(sql, params);
      return res.json(
        requestedLegacyAccountId
          ? rows.map((row) => ({
              ...row,
              requested_account_id: requestedLegacyAccountId,
              resolved_from_legacy: true,
              data_quality_status: "legacy_resolved",
            }))
          : rows,
      );
    } catch (error) {
      if (error instanceof PaginationError) return res.status(400).json({ error: error.message });
      try { logger.error?.("property search failed", safeOperationalErrorCode(error)); } catch { /* Keep the fixed response. */ }
      return res.status(500).json({ error: "search_failed" });
    }
  });

  return router;
}
