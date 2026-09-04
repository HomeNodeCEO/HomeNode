import express from "express";

import { findDcadParcelsByAddress } from "../../services/accountLocations.js";
import { markMaterialParcelDifferences } from "../../util/relatedParcelDifferences.js";

export function createRelatedParcelsRouter({
  pool,
  accountIdAllowed,
  requireCustomAccountScope,
  findParcelsByAddress = findDcadParcelsByAddress,
  markDifferences = markMaterialParcelDifferences,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("related_parcels_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("related_parcels_account_policy_required");
  }
  if (
    typeof requireCustomAccountScope !== "function"
    || typeof findParcelsByAddress !== "function"
    || typeof markDifferences !== "function"
  ) {
    throw new TypeError("related_parcels_dependency_required");
  }

  const router = express.Router();

  /**
   * Review-only companion parcel discovery. Exact situs-address matches are
   * collected from both the local account inventory and official DCAD parcel
   * GIS. No records are merged or changed by this endpoint.
   */
  router.get("/api/accounts/:id/related-parcels", async (req, res) => {
    const accountId = String(req.params.id || "").trim();
    if (!accountIdAllowed(accountId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!await requireCustomAccountScope(
      req,
      res,
      accountId,
      req.query.assignment_file_id,
      "read",
    )) return undefined;
    try {
      const { rows: accountRows } = await pool.query(
        `SELECT account_id, address, city, postal_code, county
         FROM core.accounts WHERE account_id = $1`,
        [accountId],
      );
      const account = accountRows[0];
      if (!account) return res.status(404).json({ error: "account_not_found" });
      const requestedAddress = String(account.address || "")
        .trim()
        .slice(0, 200);
      if (!requestedAddress) {
        return res.status(422).json({ error: "related_parcel_address_required" });
      }
      const addressLine = requestedAddress
        .split(",")[0]
        .toUpperCase()
        .trim();
      const isDallasCounty =
        !account.county || /dallas/i.test(String(account.county));
      let liveResult = { query_address: requestedAddress, parcels: [] };
      let liveQueryStatus = isDallasCounty ? "complete" : "unsupported_county";
      let liveQueryError = null;
      if (isDallasCounty) {
        try {
          liveResult = await findParcelsByAddress(requestedAddress);
        } catch (error) {
          liveQueryStatus = "unavailable";
          liveQueryError = String(error?.message || "dcad_address_query_failed");
        }
      }
      const remoteIds = liveResult.parcels.map((parcel) => parcel.account_id);
      const { rows: localRows } = await pool.query(
        `SELECT
           account.account_id,
           account.address,
           account.city,
           account.postal_code,
           account.county,
           account.neighborhood_code,
           account.legal_description,
           account.data_quality_status,
           COALESCE(improvement.living_area_sqft, improvement.total_living_area) AS living_area_sqft,
           values.land_value,
           values.improvement_value,
           values.market_value AS total_value,
           location.latitude,
           location.longitude
         FROM core.accounts account
         LEFT JOIN core.account_locations location
           ON location.account_id = account.account_id
         LEFT JOIN core.value_summary_current values
           ON values.account_id = account.account_id
         LEFT JOIN LATERAL (
           SELECT living_area_sqft, total_living_area
           FROM core.primary_improvements
           WHERE account_id = account.account_id
           LIMIT 1
         ) improvement ON TRUE
         WHERE account.account_id = ANY($1::text[])
            OR UPPER(BTRIM(SPLIT_PART(COALESCE(account.address, ''), ',', 1))) = $2
         ORDER BY account.account_id`,
        [remoteIds, addressLine],
      );
      const localById = new Map(localRows.map((row) => [row.account_id, row]));
      const combined = new Map();
      for (const parcel of liveResult.parcels) {
        const local = localById.get(parcel.account_id) || null;
        combined.set(parcel.account_id, {
          ...parcel,
          address: local?.address || parcel.site_address,
          city: local?.city || null,
          postal_code: local?.postal_code || null,
          county: local?.county || account.county || "DALLAS COUNTY",
          legal_description: local?.legal_description || parcel.property_description,
          living_area_sqft:
            parcel.living_area_sqft ??
            (local?.living_area_sqft == null ? null : Number(local.living_area_sqft)),
          land_value:
            parcel.land_value ?? (local?.land_value == null ? null : Number(local.land_value)),
          improvement_value:
            parcel.improvement_value ??
            (local?.improvement_value == null ? null : Number(local.improvement_value)),
          total_value:
            parcel.total_value ?? (local?.total_value == null ? null : Number(local.total_value)),
          data_quality_status: local?.data_quality_status || null,
          in_database: Boolean(local),
          is_subject: parcel.account_id === accountId,
        });
      }
      for (const local of localRows) {
        if (combined.has(local.account_id)) continue;
        combined.set(local.account_id, {
          account_id: local.account_id,
          low_parcel_id: null,
          site_address: local.address?.split(",")[0]?.trim() || null,
          address: local.address,
          city: local.city,
          postal_code: local.postal_code,
          county: local.county,
          neighborhood_code: local.neighborhood_code,
          property_description: local.legal_description,
          legal_description: local.legal_description,
          use_description: null,
          living_area_sqft:
            local.living_area_sqft == null ? null : Number(local.living_area_sqft),
          land_value: local.land_value == null ? null : Number(local.land_value),
          improvement_value:
            local.improvement_value == null ? null : Number(local.improvement_value),
          total_value: local.total_value == null ? null : Number(local.total_value),
          latitude: local.latitude == null ? null : Number(local.latitude),
          longitude: local.longitude == null ? null : Number(local.longitude),
          source_updated_at: null,
          source: "database_address_match",
          data_quality_status: local.data_quality_status,
          in_database: true,
          is_subject: local.account_id === accountId,
        });
      }
      const parcels = markDifferences([...combined.values()], accountId).sort((left, right) => {
        if (left.is_subject !== right.is_subject) return left.is_subject ? -1 : 1;
        return String(left.account_id).localeCompare(String(right.account_id));
      });
      const materialDifferenceFound = parcels.some((parcel) => parcel.materially_different);
      return res.json({
        subject_account_id: accountId,
        query_address: liveResult.query_address || requestedAddress,
        live_query_status: liveQueryStatus,
        live_query_error: liveQueryError,
        review_required: materialDifferenceFound,
        material_difference_found: materialDifferenceFound,
        merge_performed: false,
        parcels,
      });
    } catch (error) {
      logger.error?.("related parcel lookup failed", error);
      return res.status(500).json({ error: "related_parcel_lookup_failed" });
    }
  });

  return router;
}
