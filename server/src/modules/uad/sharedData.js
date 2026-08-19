import { getLatestNeighborhoodBoundary } from "../../services/neighborhoodBoundaryEngine.js";
import { getAccountPropertyActivityHistory } from "../../services/accountSalesHistory.js";
import { getStoredPropertyContext } from "../../services/propertyContext.js";
import { getPropertyInfluenceContexts } from "../../services/propertyInfluenceStore.js";
import { getPropertyZoningEvidence } from "../../services/zoningEvidence.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const influenceTypeByHomeNodeCategory = Object.freeze({
  external_use: "Other",
  major_road: "BusyRoadway",
  traffic_volume: "BusyRoadway",
  railroad: "RailLine",
  flood: "BodyOfWater",
  corner: "Other",
});

function settledSource(name, result) {
  if (result.status === "fulfilled") {
    return { name, available: Boolean(result.value), data: result.value || null };
  }
  return { name, available: false, data: null, error: String(result.reason?.message || result.reason || "unavailable") };
}

function influenceSuggestions(influence) {
  if (!influence) return [];
  return (influence.material_keys || []).map((key) => {
    const [category] = String(key).split(":");
    return {
      entity_type: "site_influence",
      values: {
        "site_influence:1500.0087": influenceTypeByHomeNodeCategory[category] || "Other",
        "site_influence:1500.0181": (influence.influence_signature?.descriptors || []).join("; ") || String(key),
      },
      source_reference: `property_influence_context:${key}`,
      observed_at: influence.computed_at || influence.updated_at || null,
      requires_appraiser_confirmation: true,
    };
  });
}

function zoningSuggestions(evidence) {
  const result = evidence?.verification || evidence?.automatic_result;
  if (!result?.zoning_code) return [];
  return [
    {
      field_key: "site_zoning:1500.0122",
      value: result.zoning_code,
      source_reference: evidence.verification ? "property_zoning_verification" : `official_zoning:${result.provider_key || "spatial"}`,
      observed_at: result.verified_at || result.source_updated_at || result.synced_at || null,
      requires_appraiser_confirmation: true,
    },
    ...(result.zoning_description ? [{
      field_key: "site_zoning:1500.0123",
      value: result.zoning_description,
      source_reference: evidence.verification ? "property_zoning_verification" : `official_zoning:${result.provider_key || "spatial"}`,
      observed_at: result.verified_at || result.source_updated_at || result.synced_at || null,
      requires_appraiser_confirmation: true,
    }] : []),
  ];
}

function marketSuggestions(boundary) {
  if (!boundary) return [];
  const summary = String(boundary.evidence?.roads?.summary || "").trim();
  if (!summary) return [];
  return [{
    field_key: "market:3000.0008",
    value: summary,
    source_reference: `neighborhood_boundary_assessment:${boundary.id}`,
    observed_at: boundary.confirmed_at || boundary.generated_at || boundary.updated_at || null,
    requires_appraiser_confirmation: true,
    source_status: boundary.status,
    confidence: boundary.confidence,
  }];
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

export function subjectListingSuggestions(activityRows) {
  if (!Array.isArray(activityRows)) return [];
  return activityRows
    .filter((row) => ["listing", "contract"].includes(row.record_type))
    .slice(0, 6)
    .map((row) => {
      const statusText = String(row.mls_status || row.record_type || "").toLowerCase();
      const listingStatus = /pending|contract|option/.test(statusText)
        ? "Pending"
        : /active/.test(statusText)
          ? "Active"
          : "OffMarket";
      const isMls = Boolean(row.listing_id || row.listing_key || /\bmls\b/i.test(String(row.source || "")));
      const values = {
        "subject_listing:0900.0013": listingStatus,
        "subject_listing:0900.0015": isMls ? "MLS" : "Other",
        ...(isMls && row.listing_id ? { "subject_listing:0900.0011": String(row.listing_id).slice(0, 45) } : {}),
        ...(!isMls ? { "subject_listing:0900.0016": String(row.source || "Third-party listing").slice(0, 45) } : {}),
        ...(isoDate(row.listing_date) ? { "subject_listing:0900.0012": isoDate(row.listing_date) } : {}),
        ...(row.days_on_market != null && row.days_on_market !== ""
          && Number.isInteger(Number(row.days_on_market)) && Number(row.days_on_market) >= 0
          ? { "subject_listing:0900.0007": Number(row.days_on_market) }
          : {}),
        ...(row.list_price != null && row.list_price !== ""
          && Number.isFinite(Number(row.list_price)) && Number(row.list_price) >= 0
          ? { "subject_listing:0900.0008": Number(row.list_price) }
          : {}),
      };
      return {
        entity_type: "subject_listing",
        values,
        source_reference: row.source_record_id
          ? `sales_source_record:${row.source_record_id}`
          : `property_activity:${row.listing_id || row.listing_key || "unidentified"}`,
        observed_at: isoDate(row.activity_date),
        requires_appraiser_confirmation: true,
        source_name: row.source || null,
        data_quality_flags: row.data_quality_flags || [],
        requires_additional_review: Boolean(row.requires_additional_review),
      };
    });
}

export async function getUadSharedData(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    `SELECT id, account_id FROM appraisal.uad_workfiles WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const accountId = workfileResult.rows[0].account_id;

  const [contextResult, influenceResult, zoningResult, boundaryResult, activityResult] = await Promise.allSettled([
    getStoredPropertyContext(pool, { accountId }),
    getPropertyInfluenceContexts(pool, [accountId]).then((items) => items.get(accountId) || null),
    getPropertyZoningEvidence(pool, { accountId }),
    getLatestNeighborhoodBoundary(pool, { accountId }),
    getAccountPropertyActivityHistory(pool, accountId),
  ]);
  const context = settledSource("property_context", contextResult);
  const influence = settledSource("property_influences", influenceResult);
  const zoning = settledSource("zoning_evidence", zoningResult);
  const boundary = settledSource("neighborhood_boundary", boundaryResult);
  const activity = settledSource("property_activity_history", activityResult);
  const listingSuggestions = subjectListingSuggestions(activity.data);

  return {
    workfile_id: workfileId,
    account_id: accountId,
    sources: {
      property_context: context,
      property_influences: influence,
      zoning_evidence: zoning,
      neighborhood_boundary: boundary,
      property_activity_history: activity,
    },
    suggestions: {
      site_fields: zoningSuggestions(zoning.data),
      site_entities: influenceSuggestions(influence.data),
      market_fields: marketSuggestions(boundary.data),
      subject_listing_fields: listingSuggestions.length ? [{
        field_key: "subject_listing_summary:0900.0004",
        value: true,
        source_reference: "property_activity_history:current_or_relevant_candidates",
        requires_appraiser_confirmation: true,
      }] : [],
      subject_listing_entities: listingSuggestions,
    },
    adapters: {
      comparable_search: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: false },
      location_influences: { ready: true, mode: "stored_suggestions", enabled_in_uad_editor: true },
      neighborhood_boundary: { ready: true, mode: "stored_reviewable_suggestions", enabled_in_uad_editor: true },
      market_conditions: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: true },
      subject_listing_history: { ready: true, mode: "existing_homenode_activity_service", enabled_in_uad_editor: false },
    },
  };
}
