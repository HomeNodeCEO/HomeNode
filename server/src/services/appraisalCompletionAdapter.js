import { createHash } from "node:crypto";

export const APPRAISAL_COMPLETION_SCHEMA_VERSION = 1;
export const APPRAISAL_COMPLETION_ADAPTER_VERSION = "2026-08-20.4";

const REPORT_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CANONICAL_JSON_BYTES = 1_500_000;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, maxLength = 4_000) {
  return String(value || "").trim().slice(0, maxLength) || null;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function jsonClone(value, fallback) {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_JSON_BYTES) {
      return fallback;
    }
    return JSON.parse(serialized);
  } catch {
    return fallback;
  }
}

function sectionRecord(sections, key) {
  const record = plainObject(sections?.[key]) ? sections[key] : {};
  return {
    value: plainObject(record.value) ? record.value : {},
    revision: Math.max(0, Number(record.revision || 0)),
  };
}

function selectedPropertySnapshot(subjectData) {
  return subjectData?.custom_signed_snapshot?.evidence?.property_report_data
    || subjectData?.custom_property_snapshot
    || subjectData?.uad_subject_snapshot
    || {};
}

function assignmentDetails(subjectData, property) {
  return subjectData?.assignment_details
    || property?.assignment?.assignment_details
    || {};
}

function assignmentProfile(assignment) {
  return {
    assignment_types: safeArray(assignment.assignment_types, 20)
      .map((value) => text(value, 80))
      .filter(Boolean),
    occupancy: text(assignment.occupancy, 80),
    contract: {
      exists: typeof assignment.subject_under_contract === "boolean"
        ? assignment.subject_under_contract
        : null,
      arms_length: typeof assignment.contract_arms_length === "boolean"
        ? assignment.contract_arms_length
        : null,
      seller_names: text(assignment.contract_seller_names, 1_000),
      contract_price: number(assignment.contract_price),
      contract_date: text(assignment.contract_date, 40),
      loan_amount: number(assignment.loan_amount),
      down_payment: number(assignment.down_payment),
      earnest_money: number(assignment.earnest_money),
      seller_concessions: number(assignment.seller_concessions),
      seller_matches_public_records: typeof assignment.seller_matches_public_records === "boolean"
        ? assignment.seller_matches_public_records
        : null,
      seller_mismatch_explanation: text(assignment.seller_mismatch_explanation, 3_000),
    },
    highest_best_use: {
      conclusion: text(assignment.highest_best_use_conclusion, 80),
      summary: text(assignment.highest_best_use_summary, 2_500),
      zoning_compatible: typeof assignment.highest_best_use_zoning_compatible === "boolean"
        ? assignment.highest_best_use_zoning_compatible
        : null,
      flags: safeArray(assignment.highest_best_use_flags, 50),
      analyzed_at: text(assignment.highest_best_use_analyzed_at, 40),
      source: text(assignment.highest_best_use_source, 200),
    },
  };
}

function subjectActivity(property) {
  const candidates = [
    ...safeArray(property?.property_activity_history, 100),
    ...safeArray(property?.sales_history, 100),
  ].filter(plainObject);
  const seen = new Set();
  const rows = [];
  for (const row of candidates) {
    const key = text(row.source_record_id || row.id, 160)
      || [
        text(row.record_type, 40),
        text(row.listing_id || row.listing_key, 80),
        text(row.closing_date || row.contract_date || row.listing_date || row.activity_date, 40),
        number(row.sale_price ?? row.list_price),
      ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(jsonClone(row, {}));
    if (rows.length >= 150) break;
  }
  return rows;
}

function subjectCharacteristics(subjectData, property, assignment) {
  const captured = subjectData?.property_characteristics || {};
  const manual = property?.report_manual_values?.["report.property_characteristics"]
    ?.attribute_value || {};
  const improvement = captured.main_improvement
    || manual.main_improvement
    || property.improvement
    || subjectData?.uad_subject_snapshot?.primary_improvements
    || {};
  const housing = captured.housing_profile
    || manual.housing_profile
    || property.housing_profile
    || subjectData?.uad_subject_snapshot?.housing_profile
    || {};
  const capturedLand = captured.land_detail;
  const manualLand = property?.report_manual_values?.["report.land_details"]
    ?.attribute_value?.land_detail;
  const propertyLand = property.land;
  const uadLand = subjectData?.uad_subject_snapshot?.land_details;
  const land = safeArray(
    Array.isArray(capturedLand) && capturedLand.length ? capturedLand
      : Array.isArray(manualLand) && manualLand.length ? manualLand
        : Array.isArray(propertyLand) && propertyLand.length ? propertyLand
          : uadLand,
    50,
  );
  const siteArea = land.reduce((total, row) => {
    const area = number(row?.area_sqft ?? row?.size_sqft ?? row?.land_size);
    return total + (area && area > 0 ? area : 0);
  }, 0);
  return {
    gross_living_area_sqft: number(
      improvement.living_area_sqft
        ?? improvement.total_living_area
        ?? improvement.gross_living_area
        ?? improvement.area_sqft,
    ),
    site_area_sqft: siteArea || null,
    year_built: number(improvement.year_built ?? improvement.actual_year_built),
    effective_year_built: number(improvement.effective_year_built),
    bedrooms: number(improvement.bedroom_count ?? improvement.bedrooms),
    full_baths: number(improvement.baths_full),
    half_baths: number(improvement.baths_half),
    housing_type: text(housing.housing_type ?? housing.property_sub_type, 200),
    attachment_type: text(housing.attachment_type, 200),
    condition_rating: text(assignment.subject_condition_rating, 20),
    quality_rating: text(assignment.subject_quality_rating, 20),
  };
}

function subjectIdentity(targetReportFile, subjectData, property) {
  const account = subjectData?.account
    || property.account
    || subjectData?.uad_subject_snapshot?.account
    || {};
  const manualLegal = property?.report_manual_values?.["report.subject_identification"]
    ?.attribute_value?.legal_description?.lines;
  const legalValues = [
    account.legal_description,
    ...(Array.isArray(manualLegal) ? manualLegal : []),
    property?.legal?.legal_text,
    property?.legal?.legal_description,
  ].map((value) => text(value, 2_000)).filter(Boolean);
  return {
    account_id: text(targetReportFile.account_id || account.account_id, 100),
    address: text(account.address || property?.property_location?.address, 500),
    city: text(account.city || property?.property_location?.city, 120),
    county: text(account.county || property?.property_location?.county, 120),
    state: text(account.state || property?.property_location?.state, 20),
    postal_code: text(account.postal_code || property?.property_location?.postal_code, 20),
    parcel_ids: [...new Set([
      targetReportFile.account_id,
      account.account_id,
      ...(Array.isArray(account.parcel_ids) ? account.parcel_ids : []),
    ].map((value) => text(value, 100)).filter(Boolean))],
    legal_descriptions: [...new Set(legalValues)],
  };
}

function neighborhoodAnalysis(assignment) {
  return {
    status: assignment.neighborhood_boundary_confirmed ? "confirmed" : "review_required",
    boundary: {
      confirmed: assignment.neighborhood_boundary_confirmed === true,
      north: text(assignment.neighborhood_boundary_north, 500),
      east: text(assignment.neighborhood_boundary_east, 500),
      south: text(assignment.neighborhood_boundary_south, 500),
      west: text(assignment.neighborhood_boundary_west, 500),
      geometry: jsonClone(assignment.neighborhood_boundary_geometry, null),
      exclusions: text(assignment.neighborhood_boundary_exclusions, 8_000),
      disclosure: text(assignment.neighborhood_boundary_engine_disclosure, 8_000),
    },
    profile: {
      location_type: text(assignment.neighborhood_location_type, 80),
      built_up: text(assignment.neighborhood_built_up, 80),
      growth: text(assignment.neighborhood_growth, 80),
      market_trend: text(assignment.neighborhood_market_trend, 80),
      demand_supply: text(assignment.neighborhood_demand_supply, 80),
      marketing_time: text(assignment.neighborhood_marketing_time, 80),
      sales_representativeness_score: number(
        assignment.neighborhood_sales_representativeness_score,
      ),
      land_use_percent: {
        one_unit: number(assignment.neighborhood_land_use_one_unit_pct),
        two_to_four_unit: number(assignment.neighborhood_land_use_two_to_four_pct),
        multifamily: number(assignment.neighborhood_land_use_multifamily_pct),
        commercial: number(assignment.neighborhood_land_use_commercial_pct),
        other_vacant: number(assignment.neighborhood_land_use_other_vacant_pct),
      },
    },
  };
}

function marketAnalysis(section) {
  const value = section.value;
  const studies = safeArray(value?.response?.analyses, 50);
  const trend = text(value?.reconciliation?.trendConclusion, 80);
  return {
    status: studies.length && trend ? "complete" : studies.length ? "in_progress" : "not_started",
    as_of_date: text(value.asOfDate || value.as_of_date, 20),
    period_months: number(value.periodMonths || value.period_months),
    studies: jsonClone(studies, []),
    reconciliation: jsonClone(value.reconciliation, {}),
  };
}

function salesAnalysis(section) {
  const value = section.value;
  const workspace = plainObject(value.workspace) ? value.workspace : {};
  const primary = safeArray(value.comparables, 12);
  const secondary = safeArray(workspace.secondaryComparables, 24);
  const listings = safeArray(workspace.selectedListings, 24);
  return {
    status: primary.length ? "developed" : "not_started",
    primary_comparables: jsonClone(primary, []),
    secondary_comparables: jsonClone(secondary, []),
    listings: jsonClone(listings, []),
    search: jsonClone(workspace.search, {}),
    subject_ratings: jsonClone(workspace.subjectRatings, {}),
    adjustments: {
      grouped: jsonClone(workspace.appliedGroupedAdjustments, {}),
      condition_quality: jsonClone(workspace.appliedConditionQualityAdjustments, {}),
      qualitative: jsonClone(workspace.qualitativeAnalysis, null),
      cost_to_cure_total: number(value.costToCureTotal),
    },
    indicated_value: number(value.opinionAfterCostToCure ?? value.opinionOfValue),
    sales_notes: text(value.salesNotes, 10_000),
    adjustment_notes: text(value.adjustmentNotes, 10_000),
  };
}

function approachSummary(section, kind) {
  const value = section.value;
  const indicated = kind === "sales"
    ? number(value.opinionAfterCostToCure ?? value.opinionOfValue)
    : number(value.rounded_indicated_value ?? value.indicated_value);
  return {
    developed: kind === "sales" ? Boolean(indicated && indicated > 0) : value.developed === true,
    indicated_value: indicated,
    effective_date: text(value.as_of_date || value.asOfDate, 20),
    revision: section.revision,
  };
}

function locationInfluences(subjectData, property) {
  const context = property.property_context
    || subjectData?.property_context
    || subjectData?.custom_signed_snapshot?.evidence?.property_report_data?.property_context
    || null;
  if (!plainObject(context)) return { status: "not_available", assessment: null };
  return {
    status: context.status || context.confidence ? "available" : "review_required",
    assessment: jsonClone(context, null),
  };
}

function sourceDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requiredIdentity(value, errorName) {
  const normalized = text(value, 100);
  if (!normalized) throw new Error(errorName);
  return normalized;
}

export function normalizeAppraisalCompletionReportFileId(value) {
  const normalized = String(value || "").trim();
  if (!REPORT_FILE_ID_PATTERN.test(normalized)) {
    throw new Error("invalid_appraisal_report_file_id");
  }
  return normalized.toLowerCase();
}

/**
 * Convert one assignment-scoped Custom workfile into a workflow-neutral result.
 * Subject facts are intentionally accepted only through the selected immutable
 * appraisal subject snapshot. A timeless property row is not an input.
 */
export function buildCanonicalAppraisalCompletion({
  targetReportFile,
  sourceReportFile,
  subjectSnapshot,
  customSections,
  generatedAt = new Date().toISOString(),
}) {
  if (![targetReportFile, sourceReportFile, subjectSnapshot, customSections].every(plainObject)) {
    throw new Error("invalid_appraisal_completion_input");
  }
  const targetCaseId = requiredIdentity(targetReportFile.appraisal_case_id, "appraisal_case_required");
  const targetSnapshotId = requiredIdentity(
    targetReportFile.subject_snapshot_id,
    "appraisal_subject_snapshot_required",
  );
  if (
    String(subjectSnapshot.id || "") !== targetSnapshotId
    || String(subjectSnapshot.appraisal_case_id || "") !== targetCaseId
    || String(sourceReportFile.appraisal_case_id || "") !== targetCaseId
    || String(sourceReportFile.subject_snapshot_id || "") !== targetSnapshotId
  ) {
    throw new Error("appraisal_completion_snapshot_mismatch");
  }
  if (sourceReportFile.workflow_type !== "custom_appraisal") {
    throw new Error("appraisal_completion_custom_source_required");
  }

  if (!["custom_appraisal", "uad_3_6"].includes(targetReportFile.workflow_type)) {
    throw new Error("appraisal_completion_target_workflow_unsupported");
  }
  const subjectData = plainObject(subjectSnapshot.subject_data)
    ? subjectSnapshot.subject_data
    : {};
  const property = selectedPropertySnapshot(subjectData);
  const assignment = assignmentDetails(subjectData, property);
  const sales = sectionRecord(customSections, "sales_comparison");
  const market = sectionRecord(customSections, "market_conditions");
  const income = sectionRecord(customSections, "income_approach");
  const cost = sectionRecord(customSections, "cost_approach");
  const final = sectionRecord(customSections, "final_reconciliation");
  const assignmentProfileData = assignmentProfile(assignment);
  const subjectProfileData = {
    identity: subjectIdentity(targetReportFile, subjectData, property),
    characteristics: subjectCharacteristics(subjectData, property, assignment),
    activity_history: subjectActivity(property),
  };
  const analyses = {
    neighborhood: neighborhoodAnalysis(assignment),
    market_conditions: marketAnalysis(market),
    comparable_sales: salesAnalysis(sales),
    location_influences: locationInfluences(subjectData, property),
    approaches: {
      sales_comparison: approachSummary(sales, "sales"),
      income_approach: approachSummary(income, "income"),
      cost_approach: approachSummary(cost, "cost"),
    },
    final_reconciliation: jsonClone(final.value, {}),
  };
  const blockers = [];
  if (!analyses.neighborhood.boundary.confirmed) blockers.push("neighborhood_boundary_unconfirmed");
  if (analyses.market_conditions.status !== "complete") blockers.push("market_conditions_incomplete");
  if (analyses.comparable_sales.status !== "developed") blockers.push("comparable_sales_incomplete");
  if (analyses.final_reconciliation.developed !== true) blockers.push("final_reconciliation_incomplete");
  const warnings = [];
  if (analyses.location_influences.status !== "available") warnings.push("location_influences_review");
  if (!subjectSnapshot.verification_status || subjectSnapshot.verification_status === "pending_review") {
    warnings.push("subject_snapshot_review");
  }
  const sourceSectionRevisions = {
    sales_comparison: sales.revision,
    market_conditions: market.revision,
    income_approach: income.revision,
    cost_approach: cost.revision,
    final_reconciliation: final.revision,
  };
  const digestInput = {
    schema_version: APPRAISAL_COMPLETION_SCHEMA_VERSION,
    adapter_version: APPRAISAL_COMPLETION_ADAPTER_VERSION,
    target_report_file_id: targetReportFile.id,
    source_report_file_id: sourceReportFile.id,
    appraisal_case_id: targetCaseId,
    subject_snapshot_id: targetSnapshotId,
    subject_snapshot_version: Number(subjectSnapshot.snapshot_version || 1),
    source_section_revisions: sourceSectionRevisions,
    assignment: assignmentProfileData,
    subject: subjectProfileData,
    analyses,
  };
  const result = {
    schema_version: APPRAISAL_COMPLETION_SCHEMA_VERSION,
    adapter_version: APPRAISAL_COMPLETION_ADAPTER_VERSION,
    generated_at: generatedAt,
    target: {
      report_file_id: targetReportFile.id,
      workflow_type: targetReportFile.workflow_type,
      file_number: targetReportFile.file_number,
    },
    source: {
      report_file_id: sourceReportFile.id,
      workflow_type: sourceReportFile.workflow_type,
      file_number: sourceReportFile.file_number,
      workfile_status: sourceReportFile.source_status || null,
      section_revisions: sourceSectionRevisions,
    },
    assignment_scope: {
      appraisal_case_id: targetCaseId,
      subject_snapshot_id: targetSnapshotId,
      subject_snapshot_version: Number(subjectSnapshot.snapshot_version || 1),
      subject_snapshot_status: subjectSnapshot.verification_status || null,
      effective_date: subjectSnapshot.effective_date
        || text(final.value.effective_date, 20)
        || null,
      inspection_date: subjectSnapshot.inspection_date || null,
    },
    assignment: assignmentProfileData,
    subject: subjectProfileData,
    analyses,
    readiness: {
      status: blockers.length ? "review_required" : "complete",
      blockers,
      warnings: [...new Set(warnings)],
    },
    provenance: {
      subject_source: "app.appraisal_subject_snapshots",
      analysis_source: "app.custom_appraisal_workfile_sections",
      source_digest_sha256: sourceDigest(digestInput),
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CANONICAL_JSON_BYTES) {
    throw new Error("appraisal_completion_result_too_large");
  }
  return result;
}

function reportFileSelect(whereClause) {
  return `SELECT report_file.*,
                 custom_workfile.status AS source_status
            FROM app.report_files report_file
            LEFT JOIN app.custom_appraisal_workfiles custom_workfile
              ON custom_workfile.assignment_file_id = report_file.custom_assignment_file_id
           WHERE ${whereClause}`;
}

export async function loadSharedAppraisalCompletion(pool, {
  accountId: accountIdValue,
  reportFileId: reportFileIdValue,
}) {
  const accountId = String(accountIdValue || "").trim();
  if (!accountId || accountId.length > 100) throw new Error("invalid_account_id");
  const reportFileId = normalizeAppraisalCompletionReportFileId(reportFileIdValue);
  const targetResult = await pool.query(
    `${reportFileSelect("report_file.id = $1 AND report_file.account_id = $2")} LIMIT 1`,
    [reportFileId, accountId],
  );
  if (!targetResult.rows.length) throw new Error("appraisal_report_file_not_found");
  const target = targetResult.rows[0];
  if (!target.appraisal_case_id || !target.subject_snapshot_id) {
    throw new Error("appraisal_subject_snapshot_required");
  }
  const snapshotResult = await pool.query(
    `SELECT snapshot.*, case_record.effective_date, case_record.inspection_date
       FROM app.appraisal_subject_snapshots snapshot
       JOIN app.appraisal_cases case_record ON case_record.id = snapshot.appraisal_case_id
      WHERE snapshot.id = $1 AND snapshot.appraisal_case_id = $2`,
    [target.subject_snapshot_id, target.appraisal_case_id],
  );
  if (!snapshotResult.rows.length) throw new Error("appraisal_subject_snapshot_not_found");

  let source = target.custom_assignment_file_id ? target : null;
  if (!source) {
    const sourceResult = await pool.query(
      `${reportFileSelect(`report_file.account_id = $1
                            AND report_file.appraisal_case_id = $2
                            AND report_file.subject_snapshot_id = $3
                            AND report_file.workflow_type = 'custom_appraisal'
                            AND report_file.custom_assignment_file_id IS NOT NULL`)}
       ORDER BY report_file.is_current DESC, report_file.updated_at DESC
       LIMIT 1`,
      [accountId, target.appraisal_case_id, target.subject_snapshot_id],
    );
    source = sourceResult.rows[0] || null;
  }
  if (!source) throw new Error("shared_appraisal_completion_source_not_found");
  const sectionResult = await pool.query(
    `SELECT section_key, section_value, revision
       FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id = $1
      ORDER BY section_key`,
    [source.custom_assignment_file_id],
  );
  const sections = Object.fromEntries(sectionResult.rows.map((section) => [
    section.section_key,
    {
      value: section.section_value || {},
      revision: Number(section.revision || 0),
    },
  ]));
  return buildCanonicalAppraisalCompletion({
    targetReportFile: target,
    sourceReportFile: source,
    subjectSnapshot: snapshotResult.rows[0],
    customSections: sections,
  });
}
