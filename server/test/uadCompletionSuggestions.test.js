import assert from "node:assert/strict";
import test from "node:test";

import { buildCanonicalAppraisalCompletion } from "../src/services/appraisalCompletionAdapter.js";
import {
  UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
  buildUadCompletionSuggestions,
  loadUadCompletionSuggestions,
} from "../src/modules/uad/completionSuggestions.js";
import { applyUadCompletionSuggestions, buildUadCompletionApplyPlan } from "../src/modules/uad/completionApply.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

const CASE_ID = "9be0a6ef-71a8-4503-bb4a-d1c6efb83fe7";
const SNAPSHOT_ID = "1d6aad8b-f9b0-46d4-b1e7-9d024d37df04";
const CUSTOM_REPORT_ID = "95401bd2-05e2-45ca-80bf-ce7b03608264";
const UAD_REPORT_ID = "0f349b77-c91c-4ca7-829c-5edbe71b5a60";
const UAD_WORKFILE_ID = "57f26fb0-0ed7-42dc-a7dd-54a87f2b7ab5";

function fixtureParts() {
  const { snapshot, property } = customAppraisalReportFixture();
  property.account.state = "TX";
  const customSections = structuredClone(snapshot.sections);
  const first = customSections.sales_comparison.value.comparables[0];
  first.sale.distanceMiles = 0.42;
  first.sale.cad_year_built = 1975;
  first.sale.cad_living_area_sqft = 1735;
  first.sale.cad_bedroom_count = 3;
  first.sale.cad_baths_full = 2;
  first.sale.cad_baths_half = 1;
  first.sale.comparableSiteSize = 7600;
  first.sale.attachment_type = "detached";
  first.sale.days_on_market = 12;
  first.sale.source = "NTREIS MLS";
  first.adjustments.concessions = 2500;
  first.adjustments.roomCount = 5000;
  first.adjustments.siteSize = 1200;
  first.adjustments.age = -800;
  first.adjustments.quality = -2500;
  const assignment = snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.neighborhood_demand_supply = "In Balance";
  assignment.neighborhood_marketing_time = "Under 3 Months";

  const sourceReportFile = {
    id: CUSTOM_REPORT_ID,
    account_id: property.account.account_id,
    workflow_type: "custom_appraisal",
    file_number: property.assignment.file_number,
    appraisal_case_id: CASE_ID,
    subject_snapshot_id: SNAPSHOT_ID,
    custom_assignment_file_id: property.assignment.id,
    source_status: "draft",
  };
  const targetReportFile = {
    id: UAD_REPORT_ID,
    account_id: property.account.account_id,
    workflow_type: "uad_3_6",
    file_number: "HN-UAD-2026-000125",
    appraisal_case_id: CASE_ID,
    subject_snapshot_id: SNAPSHOT_ID,
    uad_workfile_id: UAD_WORKFILE_ID,
  };
  const subjectSnapshot = {
    id: SNAPSHOT_ID,
    appraisal_case_id: CASE_ID,
    snapshot_version: 2,
    verification_status: "confirmed",
    effective_date: "2026-08-18",
    inspection_date: "2026-08-17",
    subject_data: { custom_signed_snapshot: snapshot },
  };
  return {
    customSections,
    sourceReportFile,
    targetReportFile,
    subjectSnapshot,
  };
}

function canonicalCompletion() {
  const input = fixtureParts();
  return buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
}

function fieldByKey(suggestions, key) {
  return [
    ...suggestions.suggestions.assignment_fields,
    ...suggestions.suggestions.subject_entity_fields,
    ...suggestions.suggestions.subject_amenity_fields,
    ...suggestions.suggestions.site_fields,
    ...suggestions.suggestions.condition_fields,
    ...suggestions.suggestions.project_fields,
    ...suggestions.suggestions.highest_best_use_fields,
    ...suggestions.suggestions.subject_listing_fields,
    ...suggestions.suggestions.sales_contract_fields,
    ...suggestions.suggestions.subject_prior_transfer_fields,
    ...suggestions.suggestions.market_fields,
    ...suggestions.suggestions.sales_comparison_fields,
  ].find((item) => item.field_key === key);
}

test("maps exact assignment, subject, and highest-and-best-use facts for review", () => {
  const completion = canonicalCompletion();
  const suggestions = buildUadCompletionSuggestions(completion);

  assert.equal(completion.assignment.assignment_types[0], "purchase_transaction");
  assert.equal(fieldByKey(suggestions, "assignment:1000.0034").value, "Purchase");
  assert.equal(fieldByKey(suggestions, "appraiser_inspection:2400.0080").value, "2026-08-17");
  assert.equal(fieldByKey(suggestions, "subject_address:0100.0007").value, "1909 Snowmass Ln");
  assert.equal(fieldByKey(suggestions, "subject_address:0100.0009").value, "Garland");
  assert.equal(fieldByKey(suggestions, "subject_address:0100.0012").value, "TX");
  assert.equal(fieldByKey(suggestions, "subject_address:0100.0011").value, "75044");
  assert.equal(fieldByKey(suggestions, "subject:0100.0010").value, "Dallas");
  assert.equal(fieldByKey(suggestions, "subject:0100.0017").value, "Holiday Park North 6");
  assert.equal(fieldByKey(suggestions, "subject_legal:0100.0067").value, "HOLIDAY PARK NORTH 6 BLK F LOT 15");
  assert.equal(fieldByKey(suggestions, "subject:0100.0020").value, "Detached");
  assert.equal(fieldByKey(suggestions, "unit:0700.0070").value, "OwnerOccupied");
  assert.deepEqual(fieldByKey(suggestions, "unit:0700.0140").value, { amount: 1762, unit: "SquareFeet" });
  assert.equal(fieldByKey(suggestions, "unit:0700.0118").value, 3);
  assert.equal(fieldByKey(suggestions, "unit:0700.0119").value, 2);
  assert.equal(fieldByKey(suggestions, "unit:0700.0120").value, 0);
  assert.deepEqual(fieldByKey(suggestions, "site:1500.0093").value, { amount: 8050, unit: "SquareFeet" });
  assert.deepEqual(fieldByKey(suggestions, "site_parcel:1500.0022").value, { amount: 8050, unit: "SquareFeet" });
  assert.equal(fieldByKey(suggestions, "site:1500.0160").value, "70 ft x 115 ft");
  assert.equal(fieldByKey(suggestions, "site:1500.0094").value, 1);
  assert.equal(fieldByKey(suggestions, "site_parcel:1500.0027").value, "26272500060150000");
  assert.equal(fieldByKey(suggestions, "site_zoning:1500.0122").value, "PD-SF");
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0011").value, "1978");
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0039").value, 31);
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0030").value, "Traditional");
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0088"), undefined);
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0022").value, true);
  assert.deepEqual(fieldByKey(suggestions, "dwelling:0300.0084").value, ["Centralized"]);
  assert.equal(fieldByKey(suggestions, "vehicle_storage:3200.0006").value, "Garage");
  assert.equal(fieldByKey(suggestions, "vehicle_storage:3200.0005").value, "Attached");
  assert.deepEqual(fieldByKey(suggestions, "vehicle_storage:3200.0004").value, { amount: 440, unit: "SquareFeet" });
  assert.equal(fieldByKey(suggestions, "highest_best_use:3100.0007").value, true);
  assert.match(fieldByKey(suggestions, "highest_best_use_commentary:3100.0010").value, /single-family residential use/);
  assert.deepEqual(fieldByKey(suggestions, "unit:0700.0140").target_entity, {
    entity_type: "unit",
    entity_identifier: "unit-1",
  });
  assert.deepEqual(fieldByKey(suggestions, "vehicle_storage:3200.0006").target_entity, {
    entity_type: "vehicle_storage",
    entity_identifier: "vehicle-storage-1",
  });
  assert.equal(suggestions.omissions.some((item) => item.code === "zoning_compliance_requires_appraiser_selection"), true);
  assert.equal(suggestions.omissions.some((item) => item.code === "vehicle_storage_parking_count_requires_appraiser_entry"), true);
  assert.equal(fieldByKey(suggestions, "subject_property_amenities:0200.0015").value, true);
  assert.equal(suggestions.suggestions.subject_amenity_entities.length, 1);
  assert.deepEqual(suggestions.suggestions.subject_amenity_entities[0].values, {
    "amenity_whole_home:0200.0034": "WholeHome",
    "amenity_whole_home:0200.0039": "IndoorFireplace",
    "amenity_whole_home:0200.0036": 1,
  });
  assert.equal(suggestions.omissions.some((item) => item.code === "construction_method_requires_appraiser_selection"), true);
  assert.equal(suggestions.omissions.some((item) => item.code === "heating_system_requires_appraiser_selection"), true);
  assert.equal(suggestions.omissions.some((item) => item.code === "amenity_defects_require_appraiser_confirmation"), true);
  assert.equal(suggestions.omissions.some((item) => item.code === "cost_to_cure_repairs_require_component_allocation"), true);
});

test("maps only complete, explicit construction and outdoor-living amenity evidence", () => {
  const input = fixtureParts();
  const property = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data;
  property.improvement.construction_type = "Site Built";
  property.improvement.heating = "Forced Air";
  property.additional_improvements.push({
    improvement_type: "Covered Patio",
    construction: "Concrete",
    area_sqft: 180,
    year_built: 2008,
    value: 7500,
  });
  property.additional_improvements.push({
    improvement_type: "Deck",
    construction: "Frame",
    area_sqft: 120,
    year_built: 2012,
    value: 4000,
  });
  property.improvement.pool = true;

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "dwelling:0300.0034").value, "SiteBuilt");
  assert.deepEqual(fieldByKey(suggestions, "dwelling:0300.0088").value, ["ForcedWarmAir"]);
  assert.equal(suggestions.suggestions.subject_amenity_entities.length, 2);
  const patio = suggestions.suggestions.subject_amenity_entities.find((item) => item.source_key === "outdoor-living-2");
  assert.deepEqual(patio.data, { amenity_category: "OutdoorLiving" });
  assert.equal(patio.values["amenity_outdoor_living:0200.0023"], "Patio");
  assert.equal(patio.values["amenity_outdoor_living:0200.0021"], "Concrete");
  assert.deepEqual(patio.values["amenity_outdoor_living:0200.0025"], { amount: 180, unit: "SquareFeet" });
  const omissionCodes = new Set(suggestions.omissions.map((item) => item.code));
  assert.equal(omissionCodes.has("additional_improvement_requires_uad_classification"), true);
  assert.equal(omissionCodes.has("pool_type_and_material_require_appraiser_classification"), true);
});

test("maps inspection narratives while keeping incomplete component records in review", () => {
  const input = fixtureParts();
  const property = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence
    .property_report_data;
  property.report_manual_values = {
    "report.property_characteristics": {
      attribute_value: {
        main_improvement: {
          ...property.improvement,
          roof_type: "Gable",
          roof_material: "Composition shingle",
        },
        inspection_details: {
          skirting: "Not applicable",
          window_type: "Vinyl double-pane",
          interior_floor_type: "Carpet and ceramic tile",
          bath_floor_type: "Ceramic tile",
          kitchen_countertop_type: "Granite",
          interior_wall_type: "Painted drywall",
          garage_carport: "Attached two-car garage",
          pool_amenities: "No pool observed",
          updates_remodeling: "Kitchen updated approximately five years ago",
          additions: "Enclosed rear sunroom",
          defects_deferred_maintenance: "Damaged flooring in the living room",
          repair_cost_to_cure: 12_500,
          additional_improvements_notes: "Covered rear patio",
          appraiser_comments: "All observations are subject to the final appraisal review.",
        },
      },
    },
  };

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));
  const exterior = fieldByKey(suggestions, "dwelling:0300.0096");
  const interior = fieldByKey(suggestions, "unit:0700.0115");
  const overall = fieldByKey(suggestions, "overall_quality_condition_commentary:1600.0008");

  assert.match(exterior.value, /foundation: Slab/i);
  assert.match(exterior.value, /windows: Vinyl double-pane/i);
  assert.match(exterior.value, /roof material: Composition shingle/i);
  assert.deepEqual(exterior.target_entity, {
    entity_type: "dwelling",
    entity_identifier: "dwelling-1",
  });
  assert.match(interior.value, /flooring: Carpet and ceramic tile/i);
  assert.match(interior.value, /kitchen countertops: Granite/i);
  assert.deepEqual(interior.target_entity, {
    entity_type: "unit",
    entity_identifier: "unit-1",
  });
  assert.match(overall.value, /Kitchen updated approximately five years ago/);
  assert.match(overall.value, /Damaged flooring in the living room/);
  assert.match(overall.value, /\$12,500\.00/);
  assert.match(overall.value, /final appraisal review/);

  const omissionCodes = new Set(suggestions.omissions.map((item) => item.code));
  assert.equal(
    omissionCodes.has("exterior_components_require_appraiser_condition_and_classification_review"),
    true,
  );
  assert.equal(
    omissionCodes.has("interior_components_require_appraiser_condition_and_classification_review"),
    true,
  );
  assert.equal(
    omissionCodes.has("inspection_alterations_require_room_and_timeframe_review"),
    true,
  );
  assert.equal(
    omissionCodes.has("inspection_repairs_require_component_location_and_action_review"),
    true,
  );
  assert.equal(
    omissionCodes.has("inspection_vehicle_storage_details_require_appraiser_reconciliation"),
    true,
  );
  assert.equal(
    omissionCodes.has("inspection_pool_amenities_require_appraiser_classification"),
    true,
  );

  const entityTypes = [
    ...suggestions.suggestions.subject_amenity_entities,
    ...suggestions.suggestions.site_influence_entities,
    ...suggestions.suggestions.subject_listing_entities,
    ...suggestions.suggestions.subject_prior_transfer_entities,
    ...suggestions.suggestions.market_entities,
    ...suggestions.suggestions.sales_comparable_entities,
  ].map((item) => item.entity_type);
  assert.equal(entityTypes.includes("dwelling_exterior_feature"), false);
  assert.equal(entityTypes.includes("unit_interior_feature"), false);
  assert.equal(entityTypes.includes("dwelling_exterior_defect"), false);
  assert.equal(entityTypes.includes("unit_interior_defect"), false);
});

test("preserves frozen location evidence as site commentary and does not guess influence impact", () => {
  const input = fixtureParts();
  input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_context = {
    confidence: "high",
    automatic_assessment: {
      computed_at: "2026-08-17T15:30:00.000Z",
      spatial_context: {
        parcel_available: true,
        adjacent_influences: [{
          category: "commercial",
          category_label: "Commercial",
          relationship: "rear",
          site_address: "100 Retail Road",
        }],
        nearby_influences: [],
        nearest_high_traffic_road: {
          name: "Belt Line Road",
          distance_feet: 240,
          annual_average_daily_traffic: 31_500,
        },
        nearest_railroad: null,
        corner_lot: false,
      },
    },
  };

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.match(fieldByKey(suggestions, "site_commentary:0100.0044").value, /100 Retail Road borders the rear/i);
  assert.match(fieldByKey(suggestions, "site_commentary:0100.0044").value, /31,500 vehicles per day/i);
  assert.equal(suggestions.suggestions.site_influence_entities.length, 0);
  const impactReview = suggestions.omissions.find(
    (item) => item.code === "site_influence_impact_requires_appraiser_selection",
  );
  assert.equal(impactReview.source_value.type, "CommercialArea");
  assert.equal(impactReview.source_value.proximity, "Bordering");
  assert.equal(
    suggestions.omissions.some((item) => item.code === "busy_roadway_influence_requires_appraiser_impact_review"),
    true,
  );
});

test("creates a complete site-influence suggestion only when the assignment snapshot contains an explicit impact", () => {
  const input = fixtureParts();
  input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_context = {
    confidence: "high",
    automatic_assessment: {
      computed_at: "2026-08-17T15:30:00.000Z",
      spatial_context: {
        parcel_available: true,
        adjacent_influences: [{
          category: "commercial",
          relationship: "rear",
          site_address: "100 Retail Road",
          appraiser_impact: "Adverse",
        }],
        nearby_influences: [],
      },
    },
  };

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));
  const entity = suggestions.suggestions.site_influence_entities[0];

  assert.deepEqual(entity.values, {
    "site_influence:1500.0087": "CommercialArea",
    "site_influence:1500.0086": "Bordering",
    "site_influence:1500.0182": "Adverse",
    "site_influence:1500.0181": "100 Retail Road borders the rear of the subject.",
  });
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [entity.suggestion_id]),
  );
  assert.equal(plan.entities.length, 1);
  assert.equal(plan.entities[0].fields.length, 4);
});

test("maps explicit project, HOA, condition, and nonconformity evidence for review", () => {
  const input = fixtureParts();
  const assignment = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.pud = true;
  assignment.hoa_dues_amount = 1200;
  assignment.hoa_frequency = "per_year";
  assignment.hoa_explanation = "Mandatory dues cover common-area maintenance.";
  assignment.subject_condition_rating = "C4";
  assignment.subject_quality_rating = "Q4";
  assignment.subject_condition_notes = "The subject has typical wear and tear with average-quality finishes.";
  assignment.significant_physical_deficiencies = true;
  assignment.subject_conforms_to_neighborhood = false;
  assignment.subject_nonconformity_type = "under_improvement";
  assignment.subject_nonconformity_explanation = "The subject is smaller and less improved than the predominant neighborhood housing stock.";

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "subject:0100.0026").value, true);
  assert.equal(fieldByKey(suggestions, "project_association_dues:2500.0007").value, 100);
  assert.equal(
    fieldByKey(suggestions, "project_information_commentary:2500.0170").value,
    "Mandatory dues cover common-area maintenance.",
  );
  assert.equal(fieldByKey(suggestions, "subject:1600.0006").value, "C4");
  assert.equal(fieldByKey(suggestions, "subject:1600.0007").value, "Q4");
  assert.equal(fieldByKey(suggestions, "dwelling:1600.0004"), undefined);
  assert.equal(fieldByKey(suggestions, "dwelling:1600.0005"), undefined);
  assert.match(
    fieldByKey(suggestions, "overall_quality_condition_commentary:1600.0008").value,
    /typical wear and tear/i,
  );
  assert.deepEqual(
    fieldByKey(suggestions, "functional_obsolescence:3600.0002").value,
    ["Underimprovement"],
  );
  assert.match(
    fieldByKey(suggestions, "functional_obsolescence_commentary:3600.0006").value,
    /smaller and less improved/i,
  );
  const omissionCodes = new Set(suggestions.omissions.map((item) => item.code));
  assert.equal(omissionCodes.has("significant_physical_deficiencies_require_component_allocation"), true);
  assert.equal(omissionCodes.has("exterior_and_interior_ratings_require_component_review"), true);
  assert.equal(omissionCodes.has("project_data_source_requires_appraiser_selection"), true);
  assert.equal(omissionCodes.has("project_common_amenities_require_appraiser_selection"), true);
  assert.equal(omissionCodes.has("project_included_utilities_require_appraiser_selection"), true);
});

test("omits unnormalizable HOA dues, rating ranges, and conflicting conformity evidence", () => {
  const input = fixtureParts();
  const assignment = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.pud = true;
  assignment.hoa_dues_amount = 725;
  assignment.hoa_frequency = "other";
  assignment.subject_condition_rating = "C4-C3";
  assignment.subject_quality_rating = "Q4-Q3";
  assignment.subject_condition_notes = "The range requires final appraiser reconciliation.";
  assignment.subject_conforms_to_neighborhood = true;
  assignment.subject_nonconformity_type = "over_improvement";
  assignment.subject_nonconformity_explanation = "Stale prior classification.";

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "project_association_dues:2500.0007"), undefined);
  assert.equal(fieldByKey(suggestions, "subject:1600.0006"), undefined);
  assert.equal(fieldByKey(suggestions, "subject:1600.0007"), undefined);
  assert.equal(fieldByKey(suggestions, "functional_obsolescence:3600.0002"), undefined);
  const omissionCodes = new Set(suggestions.omissions.map((item) => item.code));
  assert.equal(omissionCodes.has("hoa_frequency_requires_monthly_normalization"), true);
  assert.equal(omissionCodes.has("subject_condition_range_requires_appraiser_reconciliation"), true);
  assert.equal(omissionCodes.has("subject_quality_range_requires_appraiser_reconciliation"), true);
  assert.equal(omissionCodes.has("conformity_evidence_conflict_requires_appraiser_review"), true);
});

test("flags a confirmed PUD when mandatory monthly dues still require entry", () => {
  const input = fixtureParts();
  const assignment = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.pud = true;
  assignment.hoa_dues_amount = "";
  assignment.hoa_frequency = "";
  assignment.hoa_explanation = "The association is confirmed; dues remain pending verification.";

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "project_association_dues:2500.0007"), undefined);
  assert.equal(
    suggestions.omissions.some((item) => item.code === "mandatory_monthly_fee_requires_appraiser_entry"),
    true,
  );
});

test("omits ambiguous subject, zoning, and storage classifications instead of guessing", () => {
  const input = fixtureParts();
  const property = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data;
  property.housing_profile.attachment_type = "Attached or Detached";
  property.housing_profile.architectural_style = "Traditional / Ranch";
  property.improvement.air_conditioning = "Mixed systems";
  property.land.push({ line_number: 2, zoning: "R-7.5", area_sqft: 100 });
  property.additional_improvements.push({ improvement_type: "Detached Carport", area_sqft: 220 });
  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "subject:0100.0020"), undefined);
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0030"), undefined);
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0022"), undefined);
  assert.equal(fieldByKey(suggestions, "site_zoning:1500.0122"), undefined);
  assert.equal(fieldByKey(suggestions, "vehicle_storage:3200.0006"), undefined);
  const omissionCodes = new Set(suggestions.omissions.map((item) => item.code));
  assert.equal(omissionCodes.has("subject_attachment_requires_appraiser_selection"), true);
  assert.equal(omissionCodes.has("dwelling_style_requires_appraiser_selection"), true);
  assert.equal(omissionCodes.has("cooling_system_requires_appraiser_selection"), true);
  assert.equal(omissionCodes.has("multiple_zoning_classifications_require_appraiser_reconciliation"), true);
  assert.equal(omissionCodes.has("multiple_vehicle_storage_records_require_appraiser_reconciliation"), true);
});

test("includes assignment and subject facts in completion provenance", () => {
  const before = canonicalCompletion();
  const input = fixtureParts();
  input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details.occupancy = "tenant";
  const after = buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
  assert.notEqual(before.provenance.source_digest_sha256, after.provenance.source_digest_sha256);
});

test("maps immutable listing, contract, and prior-transfer evidence for review", () => {
  const completion = canonicalCompletion();
  const suggestions = buildUadCompletionSuggestions(completion);

  assert.equal(completion.subject.activity_history.length, 3);
  assert.equal(suggestions.suggestions.subject_listing_entities.length, 1);
  const listing = suggestions.suggestions.subject_listing_entities[0];
  assert.equal(listing.values["subject_listing:0900.0013"], "Pending");
  assert.equal(listing.values["subject_listing:0900.0015"], "MLS");
  assert.equal(listing.values["subject_listing:0900.0011"], "21062330");
  assert.equal(listing.values["subject_listing:0900.0007"], 18);
  assert.equal(listing.values["subject_listing:0900.0008"], 315000);
  assert.equal(fieldByKey(suggestions, "subject_listing_summary:0900.0004").value, true);
  assert.equal(fieldByKey(suggestions, "subject_listing_summary:0900.0003").value, 18);

  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0016").value, true);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0002").value, true);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0008").value, 315000);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0009").value, "2026-08-12");
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0006").value, true);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0011").value, 6000);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0010"), undefined);
  assert.match(fieldByKey(suggestions, "sales_contract_commentary:0600.0014").value, /contract seller does not match/i);

  assert.equal(suggestions.suggestions.subject_prior_transfer_entities.length, 2);
  const sale = suggestions.suggestions.subject_prior_transfer_entities[0];
  const deed = suggestions.suggestions.subject_prior_transfer_entities[1];
  assert.equal(sale.values["subject_prior_transfer:0800.0018"], "Sale");
  assert.equal(sale.values["subject_prior_transfer:0800.0012"], 280000);
  assert.equal(
    sale.related_entities[0].values["subject_prior_transfer_data_source:0700.0125"],
    "MLS",
  );
  assert.equal(deed.values["subject_prior_transfer:0800.0018"], "DeedTransferOnly");
  assert.equal(deed.values["subject_prior_transfer:0800.0009"], "NotRecorded");
  assert.equal(fieldByKey(suggestions, "subject_prior_transfer_summary:0800.0005").value, true);
  assert.equal(
    suggestions.omissions.some((item) => item.code === "sales_contract_review_requires_appraiser_selection"),
    true,
  );
  assert.equal(
    suggestions.omissions.some((item) => item.code === "subject_prior_transfer_sale_type_requires_appraiser_selection"),
    true,
  );
});

test("maps an explicit no-contract answer without inventing contract details", () => {
  const input = fixtureParts();
  const assignment = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.subject_under_contract = false;
  assignment.contract_arms_length = true;
  assignment.contract_price = 315000;
  assignment.contract_date = "2026-08-12";
  assignment.seller_concessions = 6000;
  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));

  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0016").value, false);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0002"), undefined);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0008"), undefined);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0009"), undefined);
  assert.equal(fieldByKey(suggestions, "sales_contract:0600.0011"), undefined);
  assert.equal(
    suggestions.omissions.some((item) => item.scope === "sales_contract"),
    false,
  );
});

test("maps canonical market evidence to review-only official UAD fields", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());

  assert.equal(suggestions.adapter_version, UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION);
  assert.equal(suggestions.apply_mode, "review_only");
  assert.equal(suggestions.requires_appraiser_confirmation, true);
  assert.match(fieldByKey(suggestions, "market:3000.0008").value, /North: Arapaho Road/);
  assert.equal(fieldByKey(suggestions, "market:3000.0009").value, 12);
  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0026").value, 143);
  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0029").value, 306000);
  assert.equal(fieldByKey(suggestions, "market:3000.0033").value, "InBalance");
  assert.equal(fieldByKey(suggestions, "market:3000.0031").value, "UnderThreeMonths");
  assert.equal(
    suggestions.suggestions.market_entities[0].values["market_price_trend_source:3000.0051"],
    "HomeNode Appraiser Defined Area",
  );
  assert.equal(
    fieldByKey(suggestions, "market:3000.0008").source_digest_sha256,
    suggestions.source_completion.source_digest_sha256,
  );
});

test("maps only unambiguous comparable facts, ratings, and typed adjustments", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const comparable = suggestions.suggestions.sales_comparable_entities[0];

  assert.equal(fieldByKey(suggestions, "sales_comparison_scope:1000.0032").value, true);
  assert.equal(fieldByKey(suggestions, "sales_comparison_summary:1300.0006").value, 302000);
  assert.equal(comparable.values["sales_comparable_address:1800.0001"], "3209 Innsbrook Dr");
  assert.deepEqual(
    comparable.values["sales_comparable_proximity:1800.0065"],
    { amount: 0.42, unit: "Miles" },
  );
  assert.equal(comparable.values["sales_comparable_listing:1800.0075"], "SettledSale");
  assert.equal(comparable.values["sales_comparable_sale:1800.0272"], 300000);
  assert.equal(comparable.values["sales_comparable_property:1800.0195"], "Detached");
  assert.equal(comparable.values["sales_comparable_property:1800.0197"], "Q4");
  assert.equal(comparable.values["sales_comparable_property:1800.0196"], undefined);
  assert.equal(comparable.values["sales_comparable_adjustment_concessions:1800.0317"], -2500);
  assert.equal(comparable.values["sales_comparable_adjustment_site_size:1800.0317"], 1200);
  assert.equal(comparable.values["sales_comparable_adjustment_year_built:1800.0317"], -800);
  assert.equal(comparable.values["sales_comparable_adjustment_overall_quality:1800.0317"], -2500);

  const dwelling = comparable.related_entities.find((item) => item.entity_type === "sales_comparable_dwelling");
  const unit = dwelling.related_entities.find((item) => item.entity_type === "sales_comparable_unit");
  assert.equal(dwelling.values["sales_comparable_dwelling:1800.0128"], "1975");
  assert.equal(unit.values["sales_comparable_unit:1800.0330"], 3);
  assert.deepEqual(
    unit.values["sales_comparable_unit:1800.0390"],
    { amount: 1735, unit: "SquareFeet" },
  );
  assert.equal(
    suggestions.omissions.some((item) => item.code === "condition_range_requires_appraiser_reconciliation"),
    true,
  );
  assert.equal(
    suggestions.omissions.some((item) => item.code === "combined_room_count_adjustment_requires_split"),
    true,
  );
});

test("omits a market count that exceeds the official UAD field bound", () => {
  const input = fixtureParts();
  input.customSections.market_conditions.value.response.analyses[0].population.eligible_sale_count = 1_200;
  const completion = buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
  const suggestions = buildUadCompletionSuggestions(completion);

  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0026"), undefined);
  assert.equal(
    suggestions.omissions.some((item) => item.code === "market_sale_count_outside_uad_bounds"),
    true,
  );
});

test("requires a UAD target and complete snapshot provenance", () => {
  const completion = canonicalCompletion();
  completion.target.workflow_type = "custom_appraisal";
  assert.throws(
    () => buildUadCompletionSuggestions(completion),
    /uad_completion_target_required/,
  );
  completion.target.workflow_type = "uad_3_6";
  delete completion.provenance.source_digest_sha256;
  assert.throws(
    () => buildUadCompletionSuggestions(completion),
    /invalid_appraisal_completion_provenance/,
  );
});

test("loads the exact UAD report file and same-snapshot Custom source", async () => {
  const input = fixtureParts();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("WHERE uad_workfile_id = $1")) {
        return { rows: [{ id: UAD_REPORT_ID, account_id: "26272500060150000" }] };
      }
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) return { rows: [input.subjectSnapshot] };
      if (sql.includes("report_file.workflow_type = 'custom_appraisal'")) {
        return { rows: [input.sourceReportFile] };
      }
      if (sql.includes("FROM app.custom_appraisal_workfile_sections")) {
        return {
          rows: Object.entries(input.customSections).map(([sectionKey, section]) => ({
            section_key: sectionKey,
            section_value: section.value,
            revision: section.revision,
          })),
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const suggestions = await loadUadCompletionSuggestions(pool, UAD_WORKFILE_ID);
  assert.equal(suggestions.source_completion.target_report_file_id, UAD_REPORT_ID);
  assert.equal(suggestions.suggestions.sales_comparable_entities.length, 6);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].params, [UAD_WORKFILE_ID]);
});

test("reports a missing UAD report registration without synthesizing an assignment", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    loadUadCompletionSuggestions(pool, UAD_WORKFILE_ID),
    /uad_completion_report_file_not_registered/,
  );
});


function applyInput(suggestions, selectedSuggestionIds) {
  return {
    selected_suggestion_ids: selectedSuggestionIds,
    expected_source_digest_sha256: suggestions.source_completion.source_digest_sha256,
    expected_adapter_version: suggestions.adapter_version,
    expected_revision: 4,
    preserve_existing: true,
    confirmed: true,
  };
}

test("validates every generated suggestion against the official UAD catalog", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const all = [
    ...suggestions.suggestions.assignment_fields,
    ...suggestions.suggestions.subject_entity_fields,
    ...suggestions.suggestions.subject_amenity_fields,
    ...suggestions.suggestions.site_fields,
    ...suggestions.suggestions.condition_fields,
    ...suggestions.suggestions.project_fields,
    ...suggestions.suggestions.highest_best_use_fields,
    ...suggestions.suggestions.subject_listing_fields,
    ...suggestions.suggestions.sales_contract_fields,
    ...suggestions.suggestions.subject_prior_transfer_fields,
    ...suggestions.suggestions.market_fields,
    ...suggestions.suggestions.sales_comparison_fields,
    ...suggestions.suggestions.subject_amenity_entities,
    ...suggestions.suggestions.site_influence_entities,
    ...suggestions.suggestions.subject_listing_entities,
    ...suggestions.suggestions.subject_prior_transfer_entities,
    ...suggestions.suggestions.market_entities,
    ...suggestions.suggestions.sales_comparable_entities,
  ];
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, all.map((item) => item.suggestion_id)),
    {
      existingEntities: [
        { id: "dwelling-id", entity_type: "dwelling", entity_identifier: "dwelling-1", data: {} },
        { id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} },
        { id: "parcel-id", entity_type: "site_parcel", entity_identifier: "site-parcel-1", data: {} },
        { id: "vehicle-id", entity_type: "vehicle_storage", entity_identifier: "vehicle-storage-1", data: {} },
      ],
    },
  );

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.fields.length, suggestions.counts.field_suggestions);
  assert.equal(plan.entities.length, suggestions.counts.entity_suggestions);
  assert.equal(plan.entities.some((item) => item.children.length > 0), true);
});

test("applies reviewed project and overall condition fields while preserving existing values", () => {
  const input = fixtureParts();
  const assignment = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.pud = true;
  assignment.hoa_dues_amount = 450;
  assignment.hoa_frequency = "per_quarter";
  assignment.subject_condition_rating = "C3";
  assignment.subject_quality_rating = "Q4";

  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));
  const pud = fieldByKey(suggestions, "subject:0100.0026");
  const dues = fieldByKey(suggestions, "project_association_dues:2500.0007");
  const condition = fieldByKey(suggestions, "subject:1600.0006");
  const quality = fieldByKey(suggestions, "subject:1600.0007");
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [pud.suggestion_id, dues.suggestion_id, condition.suggestion_id, quality.suggestion_id]),
    { existingValues: [{ entity_id: null, field_context: "subject", uad_uid: "1600.0007" }] },
  );

  assert.deepEqual(
    plan.fields.map((item) => [item.suggestion.field_key, item.value]),
    [
      ["subject:0100.0026", true],
      ["project_association_dues:2500.0007", 150],
      ["subject:1600.0006", "C3"],
    ],
  );
  assert.deepEqual(plan.conflicts, [{
    suggestion_id: quality.suggestion_id,
    reason: "existing_value_preserved",
  }]);
});

test("preserves existing UAD values and populated entity groups", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const root = suggestions.suggestions.market_fields[0];
  const comparable = suggestions.suggestions.sales_comparable_entities[0];
  const [context, uid] = root.field_key.split(":");
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [root.suggestion_id, comparable.suggestion_id]),
    {
      existingValues: [{ entity_id: null, field_context: context, uad_uid: uid }],
      existingEntities: [{ id: "existing-comparable", entity_type: "sales_comparable", data: {} }],
    },
  );

  assert.equal(plan.fields.length, 0);
  assert.equal(plan.entities.length, 0);
  assert.deepEqual(plan.conflicts.map((item) => item.reason), [
    "existing_value_preserved",
    "entity_type_already_populated",
  ]);
});

test("preserves existing subject listing and prior-transfer groups independently", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const listing = suggestions.suggestions.subject_listing_entities[0];
  const transfer = suggestions.suggestions.subject_prior_transfer_entities[0];

  const listingPreserved = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [listing.suggestion_id, transfer.suggestion_id]),
    { existingEntities: [{ id: "listing-id", entity_type: "subject_listing", data: {} }] },
  );
  assert.equal(listingPreserved.entities.length, 1);
  assert.equal(listingPreserved.entities[0].suggestion.entity_type, "subject_prior_transfer");
  assert.deepEqual(listingPreserved.conflicts, [{
    suggestion_id: listing.suggestion_id,
    reason: "entity_type_already_populated",
  }]);

  const transferPreserved = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [listing.suggestion_id, transfer.suggestion_id]),
    { existingEntities: [{ id: "transfer-id", entity_type: "subject_prior_transfer", data: {} }] },
  );
  assert.equal(transferPreserved.entities.length, 1);
  assert.equal(transferPreserved.entities[0].suggestion.entity_type, "subject_listing");
  assert.deepEqual(transferPreserved.conflicts, [{
    suggestion_id: transfer.suggestion_id,
    reason: "entity_type_already_populated",
  }]);
});

test("targets the seeded subject entity and preserves an existing entity value", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const gla = fieldByKey(suggestions, "unit:0700.0140");
  const entities = [{ id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} }];

  const available = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
    { existingEntities: entities },
  );
  assert.equal(available.fields[0].entityId, "unit-id");
  assert.deepEqual(available.fields[0].value, { amount: 1762, unit: "SquareFeet" });

  const preserved = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
    {
      existingEntities: entities,
      existingValues: [{ entity_id: "unit-id", field_context: "unit", uad_uid: "0700.0140" }],
    },
  );
  assert.equal(preserved.fields.length, 0);
  assert.equal(preserved.conflicts[0].reason, "existing_value_preserved");

  const missing = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
  );
  assert.equal(missing.conflicts[0].reason, "target_entity_not_found");
});

test("targets seeded site and vehicle entities while preserving existing values", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const parcelNumber = fieldByKey(suggestions, "site_parcel:1500.0027");
  const garageType = fieldByKey(suggestions, "vehicle_storage:3200.0006");
  const entities = [
    { id: "parcel-id", entity_type: "site_parcel", entity_identifier: "site-parcel-1", data: {} },
    { id: "vehicle-id", entity_type: "vehicle_storage", entity_identifier: "vehicle-storage-1", data: {} },
  ];
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [parcelNumber.suggestion_id, garageType.suggestion_id]),
    {
      existingEntities: entities,
      existingValues: [{ entity_id: "vehicle-id", field_context: "vehicle_storage", uad_uid: "3200.0006" }],
    },
  );

  assert.equal(plan.fields.length, 1);
  assert.equal(plan.fields[0].entityId, "parcel-id");
  assert.equal(plan.fields[0].value, "26272500060150000");
  assert.deepEqual(plan.conflicts, [{ suggestion_id: garageType.suggestion_id, reason: "existing_value_preserved" }]);
});

test("requires explicit confirmation, preservation, revision, and exact provenance", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const selected = [suggestions.suggestions.market_fields[0].suggestion_id];
  const valid = applyInput(suggestions, selected);

  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, confirmed: false }),
    /uad_completion_confirmation_required/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, preserve_existing: false }),
    /uad_completion_preserve_existing_required/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, expected_revision: 0 }),
    /invalid_uad_completion_revision/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, expected_source_digest_sha256: "0".repeat(64) }),
    /uad_completion_source_changed/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, selected_suggestion_ids: ["field:unknown:0000"] }),
    /uad_completion_selection_changed/,
  );
});


test("applies reviewed root and seeded-subject fields in one revision and one audit transaction", async () => {
  const input = fixtureParts();
  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));
  const selected = suggestions.suggestions.market_fields[0];
  const selectedGla = fieldByKey(suggestions, "unit:0700.0140");
  const insertedRows = [];
  let revisionInserts = 0;
  let auditInserts = 0;
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (sql.includes("SELECT id, current_revision, specification_release_key")) {
        return { rows: [{ id: UAD_WORKFILE_ID, current_revision: 4, specification_release_key: "uad-3.6-2026-01-26" }] };
      }
      if (sql.includes("WHERE uad_workfile_id = $1")) {
        return { rows: [{ id: UAD_REPORT_ID, account_id: "26272500060150000" }] };
      }
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) return { rows: [input.subjectSnapshot] };
      if (sql.includes("report_file.workflow_type = 'custom_appraisal'")) return { rows: [input.sourceReportFile] };
      if (sql.includes("FROM app.custom_appraisal_workfile_sections")) {
        return {
          rows: Object.entries(input.customSections).map(([sectionKey, section]) => ({
            section_key: sectionKey, section_value: section.value, revision: section.revision,
          })),
        };
      }
      if (sql.includes("SELECT * FROM appraisal.uad_field_values")) return { rows: insertedRows };
      if (sql.includes("SELECT *") && sql.includes("FROM appraisal.uad_entities")) {
        return {
          rows: [{ id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} }],
        };
      }
      if (sql.includes("INSERT INTO appraisal.uad_field_values")) {
        insertedRows.push({
          id: params[0], workfile_id: params[1], entity_id: params[2], field_context: params[3],
          uad_uid: params[4], report_field_id: params[5], value: JSON.parse(params[6]),
          source_type: "homenode", source_reference: params[7], is_appraiser_confirmed: true,
        });
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO appraisal.uad_revisions")) { revisionInserts += 1; return { rows: [] }; }
      if (sql.includes("INSERT INTO appraisal.uad_audit_events")) { auditInserts += 1; return { rows: [] }; }
      if (sql.includes("UPDATE appraisal.uad_workfiles")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() { releases += 1; },
  };
  const pool = { connect: async () => client };
  const result = await applyUadCompletionSuggestions(
    pool,
    UAD_WORKFILE_ID,
    applyInput(suggestions, [selected.suggestion_id, selectedGla.suggestion_id]),
  );

  assert.equal(result.current_revision, 5);
  assert.equal(result.applied_suggestion_count, 2);
  assert.equal(insertedRows.length, 2);
  assert.equal(insertedRows.find((row) => row.uad_uid === "0700.0140").entity_id, "unit-id");
  assert.equal(revisionInserts, 1);
  assert.equal(auditInserts, 1);
  assert.equal(releases, 1);
});
