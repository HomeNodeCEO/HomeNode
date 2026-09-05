import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { getAccountPropertyActivityHistory } from "../../services/accountSalesHistory.js";
import { loadAccountDetailSections } from "../../services/accountDetailSections.js";
import { ensureCensusGeographySchema } from "../../services/censusGeography.js";
import { getStoredPropertyContext } from "../../services/propertyContext.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import { authorizePublicCadastralCatalogRead } from "../../security/publicCadastralCatalog.js";

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
  authorizePublicAccount = (auth, accountId) => authorizePublicCadastralCatalogRead(
    auth,
    accountId,
    { permissionChecker: hasPermission },
  ),
  requireCustomAccountScope,
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
  requireFunction(authorizePublicAccount, "account_detail_public_catalog_authorizer_required");
  requireFunction(requireCustomAccountScope, "account_detail_assignment_authorizer_required");

  const router = express.Router();

  router.get("/api/accounts/:id", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!requestedId) return res.status(400).json({ error: "missing_id" });
    let publicGrant;
    try {
      publicGrant = authorizePublicAccount(req.mobileAuth, requestedId);
    } catch (error) {
      const message = String(error?.message || "");
      const status = message.endsWith("_authentication_required") ? 401
        : message === "invalid_account_id" ? 400
          : 403;
      return res.set("cache-control", "no-store")
        .status(status)
        .json({ error: status === 401 ? "authentication_required"
          : status === 400 ? "invalid_account_id"
            : "application_access_denied" });
    }
    const id = publicGrant.accountId;
    const assignmentFileId = String(req.query.assignment_file_id || "").trim();
    const assignmentScoped = Boolean(assignmentFileId);
    if (assignmentScoped && !await requireCustomAccountScope(
      req,
      res,
      id,
      assignmentFileId,
      "read",
    )) return undefined;
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

      const propertyActivityHistoryPromise = (assignmentScoped
        ? loadPropertyActivity(pool, canonicalId)
        : Promise.resolve([]))
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
      const reportManualValuesPromise = Promise.resolve({});
      const propertyContextPromise = Promise.resolve(null);

      const sections = await loadDetailSections(pool, canonicalId);
      const response = {
        account: {
          ...accRows[0],
          requested_account_id: id,
          resolved_from_legacy: canonicalId !== id.toUpperCase(),
        },
        primary_improvements: sections.primaryImprovement,
        housing_profile: sections.housingProfile,
        owner_summary: assignmentScoped && sections.owner
          ? {
              owner_name: sections.owner.owner_name,
              mailing_address: sections.owner.mailing_address,
              tax_year: sections.owner.tax_year,
            }
          : null,
        owner_parties: assignmentScoped ? sections.owner?.owner_parties || [] : [],
        legal_current: sections.legalCurrent,
        legal_history: assignmentScoped ? sections.legalHistory : [],
        exemptions_summary_year: assignmentScoped ? sections.exemptionYear : null,
        exemptions_summary: assignmentScoped ? sections.exemptions : [],
        homestead_yes: assignmentScoped ? sections.homesteadYes : false,
        land_detail: sections.landRows,
        property_activity_history: await propertyActivityHistoryPromise,
        census_geography: await censusGeographyPromise,
        report_manual_values: await reportManualValuesPromise,
        property_context: await propertyContextPromise,
        additional_improvements: sections.additionalImprovements,
        data_scope: assignmentScoped ? "custom_appraisal_assignment" : publicGrant.scope,
      };
      response.sales_history = response.property_activity_history.filter(
        (row) => row.record_type === "closed_sale",
      );

      return res.set("cache-control", "no-store").json(response);
    } catch (error) {
      logger.error?.("account detail load failed", error);
      return res.status(500).json({ error: "accounts_failed" });
    }
  });

  return router;
}
