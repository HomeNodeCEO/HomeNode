import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { getAccountPropertyActivityHistory } from "../../services/accountSalesHistory.js";
import { loadAccountDetailSections } from "../../services/accountDetailSections.js";
import { ensureCensusGeographySchema } from "../../services/censusGeography.js";
import { getStoredPropertyContext } from "../../services/propertyContext.js";
import {
  APPLICATION_WORKFLOWS,
  hasApplicationPermission,
} from "../../security/applicationAccess.js";

function requirePromise(value, code) {
  if (!value || typeof value.then !== "function") throw new TypeError(code);
  return value;
}

function requireFunction(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
  return value;
}

export function createAccountDetailRouter({
  pool,
  accountQualityReady,
  censusGeographyReady,
  propertyEnrichmentReady,
  ensurePropertyContextAvailable,
  authenticationRequired,
  hasPermission = hasApplicationPermission,
  resolveAccountId = resolveCanonicalAccountId,
  loadPropertyActivity = getAccountPropertyActivityHistory,
  loadDetailSections = loadAccountDetailSections,
  ensureCensusSchema = ensureCensusGeographySchema,
  loadPropertyContext = getStoredPropertyContext,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("account_detail_query_client_required");
  }
  requirePromise(accountQualityReady, "account_detail_quality_readiness_required");
  requirePromise(censusGeographyReady, "account_detail_census_readiness_required");
  requirePromise(propertyEnrichmentReady, "account_detail_enrichment_readiness_required");
  requireFunction(ensurePropertyContextAvailable, "account_detail_context_readiness_required");
  requireFunction(resolveAccountId, "account_detail_resolver_required");
  requireFunction(loadPropertyActivity, "account_detail_activity_loader_required");
  requireFunction(loadDetailSections, "account_detail_section_loader_required");
  requireFunction(ensureCensusSchema, "account_detail_census_schema_required");
  requireFunction(loadPropertyContext, "account_detail_context_loader_required");
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("account_detail_authentication_mode_required");
  }
  requireFunction(hasPermission, "account_detail_permission_policy_required");

  const router = express.Router();

  router.get("/api/accounts/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "missing_id" });
    if (authenticationRequired) {
      if (!req.mobileAuth) {
        return res.set("cache-control", "no-store")
          .status(401)
          .json({ error: "authentication_required" });
      }
      const mayReadApplication = APPLICATION_WORKFLOWS.some((workflow) => (
        hasPermission(req.mobileAuth, workflow, "read")
      ));
      if (!mayReadApplication) {
        return res.set("cache-control", "no-store")
          .status(403)
          .json({ error: "application_access_denied" });
      }
    }
    try {
      await accountQualityReady;
      const canonicalId = await resolveAccountId(pool, id);
      const accountSql = `
        SELECT
          a.account_id,
          COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
          COALESCE(NULLIF(BTRIM(a.city), ''), raw_loc.city) AS city,
          COALESCE(NULLIF(BTRIM(a.postal_code), ''), raw_loc.postal_code) AS postal_code,
          a.county,
          a.neighborhood_code,
          a.subdivision,
          a.legal_description,
          a.data_quality_status,
          a.data_quality_flags,
          a.canonical_account_id,
          COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
          COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
          COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
          COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
          COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
        FROM core.accounts a
        LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
        LEFT JOIN LATERAL (
          SELECT m.* FROM core.market_values m
          WHERE m.account_id = a.account_id
          ORDER BY m.tax_year DESC
          LIMIT 1
        ) mv ON TRUE
        LEFT JOIN LATERAL (
          SELECT COALESCE(
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
                 ) AS address,
                 COALESCE(
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,city}'), ''),
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,situs_city}'), '')
                 ) AS city,
                 COALESCE(
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,postal_code}'), ''),
                   NULLIF(BTRIM(r.raw #>> '{detail,property_location,zip_code}'), '')
                 ) AS postal_code
          FROM core.dcad_json_raw r
          WHERE r.account_id = a.account_id
            AND COALESCE(
                  NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                  NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
                ) IS NOT NULL
          ORDER BY r.tax_year DESC, r.fetched_at DESC
          LIMIT 1
        ) raw_loc ON TRUE
        WHERE a.account_id = $1
      `;
      const { rows: accRows } = await pool.query(accountSql, [canonicalId]);
      if (!accRows.length) return res.status(404).json({ error: "not_found" });

      const propertyActivityHistoryPromise = loadPropertyActivity(pool, canonicalId)
        .catch((error) => {
          logger.warn?.("property activity lookup failed", error?.code || "unknown_error");
          return [];
        });
      const censusGeographyPromise = (async () => {
        await censusGeographyReady;
        await ensureCensusSchema(pool);
        const { rows } = await pool.query(
          `SELECT tract_geoid, tract_code, state_fips, county_fips, block_code,
                  benchmark, vintage, status, response_status, review_reason,
                  source_method, source_latitude, source_longitude,
                  looked_up_at, updated_at
           FROM core.account_census_geographies
           WHERE account_id = $1`,
          [canonicalId],
        );
        return rows[0] || null;
      })().catch((error) => {
        logger.warn?.("census geography lookup failed", error?.message || error);
        return null;
      });
      const reportManualValuesPromise = authenticationRequired ? Promise.resolve({}) : (async () => {
        await propertyEnrichmentReady;
        const { rows } = await pool.query(
          `SELECT attribute_key, attribute_value, revision, reviewer, notes, updated_at
           FROM app.property_attribute_manual_values
           WHERE account_id = $1 AND attribute_key LIKE 'report.%'
           ORDER BY attribute_key`,
          [canonicalId],
        );
        return Object.fromEntries(
          rows.map((row) => [row.attribute_key, {
            value: row.attribute_value,
            revision: Number(row.revision || 0),
            reviewer: row.reviewer,
            notes: row.notes,
            updated_at: row.updated_at,
          }]),
        );
      })().catch((error) => {
        logger.warn?.("report manual values lookup failed", error?.code || "unknown_error");
        return {};
      });
      const propertyContextPromise = authenticationRequired ? Promise.resolve(null) : (async () => {
        await ensurePropertyContextAvailable();
        return loadPropertyContext(pool, { accountId: canonicalId });
      })().catch((error) => {
        logger.warn?.("property context lookup failed", error?.message || error);
        return null;
      });

      const sections = await loadDetailSections(pool, canonicalId);
      const response = {
        account: {
          ...accRows[0],
          requested_account_id: id,
          resolved_from_legacy: canonicalId !== id.toUpperCase(),
        },
        primary_improvements: sections.primaryImprovement,
        housing_profile: sections.housingProfile,
        owner_summary: sections.owner
          ? {
              owner_name: sections.owner.owner_name,
              mailing_address: sections.owner.mailing_address,
              tax_year: sections.owner.tax_year,
            }
          : null,
        owner_parties: sections.owner?.owner_parties || [],
        legal_current: sections.legalCurrent,
        legal_history: sections.legalHistory,
        exemptions_summary_year: sections.exemptionYear,
        exemptions_summary: sections.exemptions,
        homestead_yes: sections.homesteadYes,
        land_detail: sections.landRows,
        property_activity_history: await propertyActivityHistoryPromise,
        census_geography: await censusGeographyPromise,
        report_manual_values: await reportManualValuesPromise,
        property_context: await propertyContextPromise,
        additional_improvements: sections.additionalImprovements,
      };
      response.sales_history = response.property_activity_history.filter(
        (row) => row.record_type === "closed_sale",
      );

      return res.json(response);
    } catch (error) {
      logger.error?.("account detail load failed", error);
      return res.status(500).json({ error: "accounts_failed" });
    }
  });

  return router;
}
