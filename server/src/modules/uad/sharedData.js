import { createHash } from "node:crypto";

import { getLatestNeighborhoodBoundary } from "../../services/neighborhoodBoundaryEngine.js";
import { getAccountPropertyActivityHistory } from "../../services/accountSalesHistory.js";
import { getStoredPropertyContext } from "../../services/propertyContext.js";
import { getPropertyInfluenceContexts } from "../../services/propertyInfluenceStore.js";
import { getPropertyZoningEvidence } from "../../services/zoningEvidence.js";
import { loadUadCompletionSuggestions } from "./completionSuggestions.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

export const UAD_SHARED_SUGGESTION_ADAPTER_VERSION = "2026-08-25.1";

const EMPTY_REVIEW_SUGGESTIONS = Object.freeze({
  assignment_fields: [],
  subject_entity_fields: [],
  subject_amenity_fields: [],
  subject_amenity_entities: [],
  site_fields: [],
  site_influence_entities: [],
  condition_fields: [],
  project_fields: [],
  highest_best_use_fields: [],
  subject_listing_fields: [],
  subject_listing_entities: [],
  sales_contract_fields: [],
  subject_prior_transfer_fields: [],
  subject_prior_transfer_entities: [],
  market_fields: [],
  market_entities: [],
  sales_comparison_fields: [],
  sales_comparable_entities: [],
  sales_comparison_additional_property_entities: [],
  reconciliation_fields: [],
});

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

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function normalizeStandaloneField(suggestion, sourceDigest) {
  const sourceReference = String(suggestion.source_reference || "homenode_shared_data").slice(0, 1_000);
  return {
    ...suggestion,
    suggestion_id: suggestion.suggestion_id
      || `field:${suggestion.field_key}:${digest(sourceReference).slice(0, 16)}`,
    source_reference: sourceReference,
    source_digest_sha256: sourceDigest,
    observed_at: suggestion.observed_at || null,
    requires_appraiser_confirmation: true,
  };
}

function normalizeStandaloneEntity(suggestion, sourceDigest, ordinal) {
  const sourceReference = String(suggestion.source_reference || "homenode_shared_data").slice(0, 1_000);
  const sourceKey = String(suggestion.source_key || sourceReference).slice(0, 120);
  return {
    ...suggestion,
    suggestion_id: suggestion.suggestion_id
      || `entity:${suggestion.entity_type}:${digest(sourceKey).slice(0, 20)}`,
    source_key: sourceKey,
    ordinal: suggestion.ordinal || ordinal,
    source_reference: sourceReference,
    source_digest_sha256: sourceDigest,
    observed_at: suggestion.observed_at || null,
    requires_appraiser_confirmation: true,
    related_entities: (suggestion.related_entities || []).map((child, childIndex) => ({
      ...normalizeStandaloneEntity(child, sourceDigest, childIndex + 1),
      suggestion_id: undefined,
    })),
  };
}

export function buildUadStandaloneReviewDocument({
  workfile,
  siteFields = [],
  siteEntities = [],
  marketFields = [],
  subjectListingFields = [],
  subjectListingEntities = [],
  subjectPriorTransferFields = [],
  subjectPriorTransferEntities = [],
}) {
  const rawSuggestions = {
    ...EMPTY_REVIEW_SUGGESTIONS,
    site_fields: siteFields,
    site_influence_entities: siteEntities,
    market_fields: marketFields,
    subject_listing_fields: subjectListingFields,
    subject_listing_entities: subjectListingEntities,
    subject_prior_transfer_fields: subjectPriorTransferFields,
    subject_prior_transfer_entities: subjectPriorTransferEntities,
  };
  const sourceDigest = digest({
    adapter_version: UAD_SHARED_SUGGESTION_ADAPTER_VERSION,
    workfile_id: workfile.id,
    report_file_id: workfile.report_file_id,
    suggestions: rawSuggestions,
  });
  const suggestions = Object.fromEntries(Object.entries(rawSuggestions).map(([key, items]) => [
    key,
    key.endsWith("_entities")
      ? items.map((item, index) => normalizeStandaloneEntity(item, sourceDigest, index + 1))
      : items.map((item) => normalizeStandaloneField(item, sourceDigest)),
  ]));
  const fieldCount = Object.entries(suggestions)
    .filter(([key]) => key.endsWith("_fields"))
    .reduce((total, [, items]) => total + items.length, 0);
  const entityCount = Object.entries(suggestions)
    .filter(([key]) => key.endsWith("_entities"))
    .reduce((total, [, items]) => total + items.length, 0);
  if (!fieldCount && !entityCount) return null;
  return {
    schema_version: 1,
    adapter_version: UAD_SHARED_SUGGESTION_ADAPTER_VERSION,
    source_kind: "homenode_shared_data",
    source_completion: {
      source_report_file_id: workfile.report_file_id || workfile.id,
      target_report_file_id: workfile.report_file_id || workfile.id,
      appraisal_case_id: workfile.appraisal_case_id || null,
      subject_snapshot_id: workfile.subject_snapshot_id || null,
      source_digest_sha256: sourceDigest,
    },
    status: "ready_for_review",
    source_readiness: { status: "complete", blockers: [], warnings: [] },
    suggestions,
    omissions: [],
    counts: {
      field_suggestions: fieldCount,
      entity_suggestions: entityCount,
      omissions: 0,
    },
    apply_mode: "review_only",
    requires_appraiser_confirmation: true,
  };
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

export function subjectPriorTransferSuggestions(activityRows) {
  if (!Array.isArray(activityRows)) return [];
  return activityRows
    .filter((row) => ["closed_sale", "cad_transfer"].includes(row.record_type))
    .filter((row) => isoDate(row.closing_date || row.activity_date))
    .slice(0, 12)
    .map((row) => {
      const isDeedOnly = row.record_type === "cad_transfer";
      const amount = row.sale_price == null || row.sale_price === "" ? null : Number(row.sale_price);
      const sourceName = String(row.source || "");
      const dataSourceType = /\bmls\b/i.test(sourceName)
        ? "MLS"
        : /\b(deed|cad|assessor)\b/i.test(sourceName)
          ? "Deed"
          : "DataAggregator";
      return {
        entity_type: "subject_prior_transfer",
        values: {
          "subject_prior_transfer:0800.0018": isDeedOnly ? "DeedTransferOnly" : "Sale",
          "subject_prior_transfer:0800.0011": isoDate(row.closing_date || row.activity_date),
          ...(Number.isFinite(amount) && amount >= 0
            ? { "subject_prior_transfer:0800.0012": amount }
            : { "subject_prior_transfer:0800.0009": "NotRecorded" }),
        },
        related_entities: [{
          entity_type: "subject_prior_transfer_data_source",
          values: { "subject_prior_transfer_data_source:0700.0125": dataSourceType },
        }],
        source_reference: row.source_record_id
          ? `sales_source_record:${row.source_record_id}`
          : row.sale_id
            ? `sale:${row.sale_id}`
            : `property_activity:${isoDate(row.closing_date || row.activity_date)}`,
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
    `SELECT workfile.id, workfile.account_id,
            report_file.id AS report_file_id,
            report_file.appraisal_case_id,
            report_file.subject_snapshot_id
       FROM appraisal.uad_workfiles workfile
       LEFT JOIN LATERAL (
         SELECT id, appraisal_case_id, subject_snapshot_id
           FROM app.report_files
          WHERE uad_workfile_id = workfile.id
            AND workflow_type = 'uad_3_6'
          ORDER BY is_current DESC, updated_at DESC, id
          LIMIT 1
       ) report_file ON true
      WHERE workfile.id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const workfile = workfileResult.rows[0];
  const accountId = workfile.account_id;

  const [contextResult, influenceResult, zoningResult, boundaryResult, activityResult, completionResult] = await Promise.allSettled([
    getStoredPropertyContext(pool, { accountId }),
    getPropertyInfluenceContexts(pool, [accountId]).then((items) => items.get(accountId) || null),
    getPropertyZoningEvidence(pool, { accountId }),
    getLatestNeighborhoodBoundary(pool, { accountId }),
    getAccountPropertyActivityHistory(pool, accountId),
    loadUadCompletionSuggestions(pool, workfileId),
  ]);
  const context = settledSource("property_context", contextResult);
  const influence = settledSource("property_influences", influenceResult);
  const zoning = settledSource("zoning_evidence", zoningResult);
  const boundary = settledSource("neighborhood_boundary", boundaryResult);
  const activity = settledSource("property_activity_history", activityResult);
  const customCompletion = settledSource("custom_appraisal_completion", completionResult);
  const listingSuggestions = subjectListingSuggestions(activity.data);
  const priorTransferSuggestions = subjectPriorTransferSuggestions(activity.data);
  const siteFields = zoningSuggestions(zoning.data);
  const siteEntities = influenceSuggestions(influence.data);
  const marketFields = marketSuggestions(boundary.data);
  const subjectListingFields = listingSuggestions.length ? [{
    field_key: "subject_listing_summary:0900.0004",
    value: true,
    source_reference: "property_activity_history:current_or_relevant_candidates",
    requires_appraiser_confirmation: true,
  }] : [];
  const subjectPriorTransferFields = priorTransferSuggestions.length ? [{
    field_key: "subject_prior_transfer_summary:0800.0005",
    value: true,
    source_reference: "property_activity_history:prior_transfer_candidates",
    requires_appraiser_confirmation: true,
  }] : [];
  const standaloneReview = buildUadStandaloneReviewDocument({
    workfile,
    siteFields,
    siteEntities,
    marketFields,
    subjectListingFields,
    subjectListingEntities: listingSuggestions,
    subjectPriorTransferFields,
    subjectPriorTransferEntities: priorTransferSuggestions,
  });
  const reviewDocument = customCompletion.data || standaloneReview;

  return {
    workfile_id: workfileId,
    account_id: accountId,
    sources: {
      property_context: context,
      property_influences: influence,
      zoning_evidence: zoning,
      neighborhood_boundary: boundary,
      property_activity_history: activity,
      custom_appraisal_completion: customCompletion,
    },
    suggestions: {
      site_fields: siteFields,
      site_entities: siteEntities,
      market_fields: marketFields,
      subject_listing_fields: subjectListingFields,
      subject_listing_entities: listingSuggestions,
      subject_prior_transfer_fields: subjectPriorTransferFields,
      subject_prior_transfer_entities: priorTransferSuggestions,
      custom_completion: customCompletion.data || null,
      review_document: reviewDocument,
    },
    adapters: {
      comparable_search: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: false },
      location_influences: { ready: true, mode: "stored_suggestions", enabled_in_uad_editor: true },
      neighborhood_boundary: { ready: true, mode: "stored_reviewable_suggestions", enabled_in_uad_editor: true },
      market_conditions: { ready: true, mode: "existing_homenode_services", enabled_in_uad_editor: true },
      subject_listing_history: { ready: true, mode: "existing_homenode_activity_service", enabled_in_uad_editor: false },
      subject_prior_transfer_history: { ready: true, mode: "existing_homenode_activity_service", enabled_in_uad_editor: false },
      comparable_prior_transfer_history: { ready: true, mode: "shared_sales_comparable_entities", enabled_in_uad_editor: false },
      custom_appraisal_completion: {
        ready: customCompletion.available,
        mode: "guarded_review_apply",
        enabled_in_uad_editor: true,
      },
      standalone_homenode_suggestions: {
        ready: Boolean(standaloneReview),
        mode: "guarded_review_apply",
        enabled_in_uad_editor: true,
      },
    },
  };
}

export async function loadUadReviewSuggestions(pool, workfileIdValue) {
  try {
    return await loadUadCompletionSuggestions(pool, workfileIdValue);
  } catch (error) {
    const expectedMissingSource = new Set([
      "shared_appraisal_completion_source_not_found",
      "uad_completion_report_file_not_registered",
    ]);
    if (!expectedMissingSource.has(String(error?.message || error))) throw error;
  }
  const shared = await getUadSharedData(pool, workfileIdValue);
  if (!shared.suggestions.review_document) throw new Error("uad_review_suggestions_not_available");
  return shared.suggestions.review_document;
}
