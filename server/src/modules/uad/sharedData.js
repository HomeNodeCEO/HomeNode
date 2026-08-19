import { getLatestNeighborhoodBoundary } from "../../services/neighborhoodBoundaryEngine.js";
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

export async function getUadSharedData(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    `SELECT id, account_id FROM appraisal.uad_workfiles WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const accountId = workfileResult.rows[0].account_id;

  const [contextResult, influenceResult, zoningResult, boundaryResult] = await Promise.allSettled([
    getStoredPropertyContext(pool, { accountId }),
    getPropertyInfluenceContexts(pool, [accountId]).then((items) => items.get(accountId) || null),
    getPropertyZoningEvidence(pool, { accountId }),
    getLatestNeighborhoodBoundary(pool, { accountId }),
  ]);
  const context = settledSource("property_context", contextResult);
  const influence = settledSource("property_influences", influenceResult);
  const zoning = settledSource("zoning_evidence", zoningResult);
  const boundary = settledSource("neighborhood_boundary", boundaryResult);

  return {
    workfile_id: workfileId,
    account_id: accountId,
    sources: { property_context: context, property_influences: influence, zoning_evidence: zoning, neighborhood_boundary: boundary },
    suggestions: {
      site_fields: zoningSuggestions(zoning.data),
      site_entities: influenceSuggestions(influence.data),
      market_fields: marketSuggestions(boundary.data),
    },
    adapters: {
      comparable_search: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: false },
      location_influences: { ready: true, mode: "stored_suggestions", enabled_in_uad_editor: true },
      neighborhood_boundary: { ready: true, mode: "stored_reviewable_suggestions", enabled_in_uad_editor: true },
      market_conditions: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: true },
    },
  };
}
