import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  UAD_REPEATABLE_ENTITY_GROUPS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
} from "../src/modules/uad/fieldCatalog.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import {
  UAD_NATIVE_AMERICAN_LAND_TYPES,
  UAD_PROPERTY_RIGHTS_NOT_INCLUDED,
  UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES,
  UAD_SALES_COMPARABLE_DISASTER_MITIGATION_TYPES,
  UAD_SALES_COMPARABLE_DIRECTIONS,
  UAD_SALES_COMPARABLE_DWELLING_STYLE_TYPES,
  UAD_SALES_COMPARABLE_FINANCING_TYPES,
  UAD_SALES_COMPARABLE_HEATING_SYSTEM_TYPES,
  UAD_SALES_COMPARABLE_LISTING_STATUSES,
  UAD_SALES_COMPARABLE_RENEWABLE_ENERGY_TYPES,
  UAD_SALES_COMPARABLE_SITE_INFLUENCE_TYPES,
  UAD_SALES_COMPARABLE_VIEW_TYPES,
  UAD_SALES_COMPARABLE_WATER_ACCESS_DEPTH_TYPES,
  UAD_SALES_COMPARABLE_WATERFRONT_FEATURE_TYPES,
  UAD_SALES_COMPARISON_FIELDS,
  isVerifiedSalesComparisonAsset,
} from "../src/modules/uad/salesComparisonCatalog.js";

const value = (entityId, contextKey, uid, fieldValue) => ({
  field: getUadField(contextKey, uid),
  entityId,
  value: fieldValue,
});

test("adds the Section 22A-22F editor on canonical comparable entities", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "sales_comparison");
  assert.equal(sections.at(-1)?.officialSectionNumber, 22);
  assert.equal(section?.title, "Sales Comparison Approach");
  assert.equal(UAD_SALES_COMPARISON_FIELDS.length, 174);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "sales_comparison").length, 174);
  assert.equal(
    section?.groups.find((group) => group.entityType === "sales_comparable")?.createEnabled,
    true,
  );
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_data_source.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_right_not_included.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_project_amenity.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_site_influence.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_body_of_water.parentEntityType, "sales_comparable_site_influence");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_waterfront_feature.parentEntityType, "sales_comparable_body_of_water");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_dwelling.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_construction_method.parentEntityType, "sales_comparable_dwelling");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_heating_system.parentEntityType, "sales_comparable_dwelling");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_cooling_system.parentEntityType, "sales_comparable_dwelling");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_renewable_energy_component.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_green_certification.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_efficiency_rating.parentEntityType, "sales_comparable");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.sales_comparable_site_view.parentEntityType, "sales_comparable");
});

test("uses official Section 22 general-information enumerations and conditional fields", () => {
  assert.deepEqual(UAD_SALES_COMPARABLE_LISTING_STATUSES, ["Active", "OffMarket", "Pending", "SettledSale"]);
  assert.deepEqual(UAD_SALES_COMPARABLE_DIRECTIONS, ["East", "North", "NorthEast", "NorthWest", "South", "SouthEast", "SouthWest", "West"]);
  assert.deepEqual(UAD_SALES_COMPARABLE_FINANCING_TYPES, ["Conventional", "FHA", "Other", "Private", "USDARuralDevelopment", "VA"]);
  assert.equal(UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES.includes("MLS"), true);
  assert.equal(UAD_NATIVE_AMERICAN_LAND_TYPES.includes("TribalTrustLand"), true);
  assert.equal(UAD_SALES_COMPARABLE_SITE_INFLUENCE_TYPES.includes("BusyRoadway"), true);
  assert.equal(UAD_SALES_COMPARABLE_VIEW_TYPES.includes("TrafficWallBarriers"), true);
  assert.deepEqual(UAD_SALES_COMPARABLE_WATER_ACCESS_DEPTH_TYPES, ["DeepWater", "NonNavigable", "Other", "ShallowWater"]);
  assert.equal(UAD_SALES_COMPARABLE_WATERFRONT_FEATURE_TYPES.includes("SeawallOrBulkhead"), true);
  assert.equal(UAD_SALES_COMPARABLE_DWELLING_STYLE_TYPES.includes("Traditional"), true);
  assert.equal(UAD_SALES_COMPARABLE_HEATING_SYSTEM_TYPES.includes("ForcedWarmAir"), true);
  assert.equal(UAD_SALES_COMPARABLE_DISASTER_MITIGATION_TYPES.includes("FortifiedRoof"), true);
  assert.deepEqual(UAD_SALES_COMPARABLE_RENEWABLE_ENERGY_TYPES, ["Geothermal", "Other", "Solar", "WindTurbine"]);
  assert.deepEqual(UAD_PROPERTY_RIGHTS_NOT_INCLUDED, ["AirRights", "MineralRights", "Other", "TimberRights", "WaterRights"]);

  const ratio = getUadField("sales_comparable_listing", "1800.0316");
  const direction = getUadField("sales_comparable_proximity", "1800.0066");
  const salePrice = getUadField("sales_comparable_sale", "1800.0272");
  assert.equal(normalizeAndValidateUadValue(ratio, 102).error, null);
  assert.equal(normalizeAndValidateUadValue(ratio, 1000).error?.code, "percentage");
  assert.equal(uadFieldIsVisible(direction, (key) => key.endsWith("1800.0065") ? { amount: 0, unit: "Miles" } : true), false);
  assert.equal(uadFieldIsRequired(salePrice, (key) => key.endsWith("1800.0075") ? "SettledSale" : true), true);
});

test("accepts a complete settled comparable with a source and verified property photo", () => {
  const comparable = { id: "048540df-2f90-43d3-b574-1c8705675b8d", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const source = { id: "dc64e88d-e329-4b57-ad42-a1e426fd739c", entity_type: "sales_comparable_data_source", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const hazard = { id: "52eaeb42-71ae-42bd-9b25-a8d7439e238a", entity_type: "sales_comparable_site_hazard", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const influence = { id: "3f78d850-5ec7-47b0-9f04-e63d25c7ef69", entity_type: "sales_comparable_site_influence", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const view = { id: "f8bab272-4177-40d7-978c-d12828874c69", entity_type: "sales_comparable_site_view", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const dwelling = { id: "617fa2b7-1855-450c-a459-42f7a2dde071", entity_type: "sales_comparable_dwelling", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const method = { id: "525232de-51df-48c9-92a4-f5fc2b6774b3", entity_type: "sales_comparable_construction_method", parent_entity_id: dwelling.id, ordinal: 1, data: {} };
  const heating = { id: "85ac6d0b-4404-45d8-a311-c399d049b96f", entity_type: "sales_comparable_heating_system", parent_entity_id: dwelling.id, ordinal: 1, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable", "1800.0192", 1),
    value(comparable.id, "sales_comparable_address", "1800.0001", "1234 Oak Street"),
    value(comparable.id, "sales_comparable_address", "1800.0003", "Garland"),
    value(comparable.id, "sales_comparable_address", "1800.0005", "TX"),
    value(comparable.id, "sales_comparable_address", "1800.0004", "75044"),
    value(comparable.id, "sales_comparable_property", "0100.0059", 0),
    value(comparable.id, "sales_comparable_proximity", "1800.0065", { amount: 0, unit: "Miles" }),
    value(comparable.id, "sales_comparable_listing", "1800.0075", "SettledSale"),
    value(comparable.id, "sales_comparable_sale", "1800.0272", 425000),
    value(comparable.id, "sales_comparable_sale", "1800.0274", "TypicallyMotivated"),
    value(comparable.id, "sales_comparable_concessions", "1800.0370", false),
    value(comparable.id, "sales_comparable_contract", "1800.0385", true),
    value(comparable.id, "sales_comparable_sale", "1800.0342", "2026-07-15"),
    value(comparable.id, "sales_comparable_listing", "1800.0189", 8),
    value(comparable.id, "sales_comparable_property", "1800.0195", "Detached"),
    value(comparable.id, "sales_comparable_property", "1800.0337", "FeeSimple"),
    value(comparable.id, "sales_comparable_project", "1800.0383", false),
    value(comparable.id, "sales_comparable_project", "1800.0378", false),
    value(comparable.id, "sales_comparable_site", "1800.0277", false),
    value(comparable.id, "sales_comparable_site", "1800.0239", { amount: 8400, unit: "SquareFeet" }),
    value(hazard.id, "sales_comparable_site_hazard", "1800.0212", "None"),
    value(influence.id, "sales_comparable_site_influence", "1800.0233", "Residential"),
    value(view.id, "sales_comparable_site_view", "1800.0243", "Residential"),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0368", 1),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0128", "2004"),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0129", false),
    value(method.id, "sales_comparable_construction_method", "1800.0171", "SiteBuilt"),
    value(heating.id, "sales_comparable_heating_system", "1800.0165", "ForcedWarmAir"),
    value(source.id, "sales_comparable_data_source", "0700.0125", "MLS"),
    value(source.id, "sales_comparable_data_source", "1800.0347", "NTREIS-123456"),
  ];
  const assets = [{
    section_number: 22,
    entity_id: comparable.id,
    caption_type: "PropertyPhoto",
    content_type: "image/jpeg",
    status: "verified",
  }];
  assert.deepEqual(validateCompleteSection("sales_comparison", [], values, [comparable, source, hazard, influence, view, dwelling, method, heating], assets), []);
});

test("rejects missing evidence and contradictory comparable transaction records", () => {
  const comparable = { id: "fbf1ae14-78fe-41fd-86c4-fc82716d7f58", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable_address", "1800.0001", "9 Main Street"),
    value(comparable.id, "sales_comparable_listing", "1800.0075", "Active"),
    value(comparable.id, "sales_comparable_sale", "1800.0272", 400000),
  ];
  const codes = validateCompleteSection("sales_comparison", [], values, [comparable]).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_data_source_required"), true);
  assert.equal(codes.includes("sales_comparable_photo_required"), true);
  assert.equal(codes.includes("sales_comparable_settled_detail_conflict"), true);
});

test("validates Section 22B project classification, financial details, and amenities", () => {
  const comparable = { id: "02f965b1-fb7a-425c-a7f3-33280878dc99", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const amenityOne = { id: "69157369-a8ec-48df-ac48-f7063085f359", entity_type: "sales_comparable_project_amenity", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const amenityTwo = { id: "471387b0-e32e-4c61-88c8-6ea83df1455a", entity_type: "sales_comparable_project_amenity", parent_entity_id: comparable.id, ordinal: 2, data: {} };
  const contradictory = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable_project", "1800.0383", true),
    value(comparable.id, "sales_comparable_project", "1800.0378", true),
    value(comparable.id, "sales_comparable_project", "1800.0377", "Condominium"),
    value(comparable.id, "sales_comparable_project", "1800.0194", "Test Project"),
    value(comparable.id, "sales_comparable_project", "1800.0353", 125),
    value(comparable.id, "sales_comparable_project", "1800.0371", "None"),
    value(amenityOne.id, "sales_comparable_project_amenity", "1800.0056", "None"),
    value(amenityTwo.id, "sales_comparable_project_amenity", "1800.0056", "Clubhouse"),
  ];
  const codes = validateCompleteSection(
    "sales_comparison",
    [],
    contradictory,
    [comparable, amenityOne, amenityTwo],
  ).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_project_classification_conflict"), true);
  assert.equal(codes.includes("sales_comparable_project_amenity_none_conflict"), true);

  const noAmenityCodes = validateCompleteSection(
    "sales_comparison",
    [],
    [
      value(null, "sales_comparison_scope", "1000.0032", true),
      value(comparable.id, "sales_comparable_project", "1800.0383", true),
      value(comparable.id, "sales_comparable_project", "1800.0378", false),
      value(comparable.id, "sales_comparable_project", "1800.0353", 125),
      value(comparable.id, "sales_comparable_project", "1800.0371", "None"),
    ],
    [comparable],
  ).map((error) => error.code);
  assert.equal(noAmenityCodes.includes("sales_comparable_project_amenity_required"), true);
});

test("validates mandatory Section 22C Site records and exclusive None selections", () => {
  const comparable = { id: "ce740d51-00d9-40dc-915c-2721586119c6", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const hazardNone = { id: "aaeb7f39-3a8e-459e-a367-c7676426b5e5", entity_type: "sales_comparable_site_hazard", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const hazardFlood = { id: "509a2d12-c95b-4d5c-9567-c3549527b072", entity_type: "sales_comparable_site_hazard", parent_entity_id: comparable.id, ordinal: 2, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable_site", "1800.0277", true),
    value(hazardNone.id, "sales_comparable_site_hazard", "1800.0212", "None"),
    value(hazardFlood.id, "sales_comparable_site_hazard", "1800.0212", "FEMASpecialFloodHazardArea"),
  ];
  const codes = validateCompleteSection(
    "sales_comparison",
    [],
    values,
    [comparable, hazardNone, hazardFlood],
  ).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_site_hazard_duplicate_none_conflict"), true);
  assert.equal(codes.includes("sales_comparable_site_influence_required"), true);
  assert.equal(codes.includes("sales_comparable_site_view_required"), true);
});

test("validates Section 22D body-of-water hierarchy and private-access conditions", () => {
  const comparable = { id: "d9c0bfac-b523-4437-8365-c5ec1ba89acb", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const influence = { id: "c8cb2b08-5b79-4f94-82b2-4951bed38dc0", entity_type: "sales_comparable_site_influence", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const body = { id: "703a338b-5458-44db-af73-38bbbc2fe6e0", entity_type: "sales_comparable_body_of_water", parent_entity_id: influence.id, ordinal: 1, data: {} };
  const noneFeature = { id: "cf321677-4801-418d-aa31-826aee90b194", entity_type: "sales_comparable_waterfront_feature", parent_entity_id: body.id, ordinal: 1, data: {} };
  const dockFeature = { id: "03e2015e-b49d-48bb-b005-52298d56be5c", entity_type: "sales_comparable_waterfront_feature", parent_entity_id: body.id, ordinal: 2, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(influence.id, "sales_comparable_site_influence", "1800.0233", "BodyOfWater"),
    value(body.id, "sales_comparable_site_influence", "1800.0228", "Lake"),
    value(body.id, "sales_comparable_site_influence", "1800.0279", true),
    value(body.id, "sales_comparable_site_influence", "1800.0321", "ShallowWater"),
    value(noneFeature.id, "sales_comparable_waterfront_feature", "1800.0230", "None"),
    value(dockFeature.id, "sales_comparable_waterfront_feature", "1800.0230", "Dock"),
  ];
  const codes = validateCompleteSection(
    "sales_comparison",
    [],
    values,
    [comparable, influence, body, noneFeature, dockFeature],
  ).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_waterfront_feature_none_conflict"), true);
  assert.equal(codes.includes("sales_comparable_waterfront_development_rights_required"), true);

  const missingBodyCodes = validateCompleteSection(
    "sales_comparison",
    [],
    [
      value(null, "sales_comparison_scope", "1000.0032", true),
      value(influence.id, "sales_comparable_site_influence", "1800.0233", "BodyOfWater"),
    ],
    [comparable, influence],
  ).map((error) => error.code);
  assert.equal(missingBodyCodes.includes("sales_comparable_body_of_water_required"), true);
});

test("validates Section 22E dwelling hierarchy and mechanical-system conditions", () => {
  const comparable = { id: "a3009ac2-cb0a-4b86-a104-539a95e4fdcb", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const dwelling = { id: "b728626c-f47e-4d78-9c15-9c35db71e7fa", entity_type: "sales_comparable_dwelling", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const method = { id: "268c55b0-cd9e-478e-b9c5-d1eca53796e1", entity_type: "sales_comparable_construction_method", parent_entity_id: dwelling.id, ordinal: 1, data: {} };
  const heatingNone = { id: "1181ac3d-112c-4c1c-bd9e-04c034074cdb", entity_type: "sales_comparable_heating_system", parent_entity_id: dwelling.id, ordinal: 1, data: {} };
  const heatingForcedAir = { id: "133011e6-46c0-4b1d-8e60-e34b982e77bb", entity_type: "sales_comparable_heating_system", parent_entity_id: dwelling.id, ordinal: 2, data: {} };
  const cooling = { id: "57265b72-720e-477d-9ce2-b584b3b53986", entity_type: "sales_comparable_cooling_system", parent_entity_id: dwelling.id, ordinal: 1, data: {} };
  const issueNone = { id: "2f39c51d-90ce-42dc-95a5-b5eaac64c3f6", entity_type: "sales_comparable_functional_issue", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const issueFloorPlan = { id: "b58731dd-3137-44b7-aee2-a6f0f72297e1", entity_type: "sales_comparable_functional_issue", parent_entity_id: comparable.id, ordinal: 2, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable_property", "1800.0195", "Detached"),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0368", 1),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0128", "2004"),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0129", false),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0169", "RowhouseTownhouse"),
    value(dwelling.id, "sales_comparable_dwelling", "1800.0123", false),
    value(method.id, "sales_comparable_construction_method", "1800.0171", "Manufactured"),
    value(heatingNone.id, "sales_comparable_heating_system", "1800.0165", "None"),
    value(heatingForcedAir.id, "sales_comparable_heating_system", "1800.0165", "ForcedWarmAir"),
    value(cooling.id, "sales_comparable_cooling_system", "1800.0161", "Centralized"),
    value(issueNone.id, "sales_comparable_functional_issue", "1800.0121", "None"),
    value(issueFloorPlan.id, "sales_comparable_functional_issue", "1800.0121", "FloorPlan"),
  ];
  const codes = validateCompleteSection(
    "sales_comparison",
    [],
    values,
    [comparable, dwelling, method, heatingNone, heatingForcedAir, cooling, issueNone, issueFloorPlan],
  ).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_structure_design_attachment_conflict"), true);
  assert.equal(codes.includes("required"), true); // Manufactured Home Width is required.
  assert.equal(codes.includes("sales_comparable_heating_system_duplicate_none_conflict"), true);
  assert.equal(codes.includes("sales_comparable_cooling_system_conflict"), true);
  assert.equal(codes.includes("sales_comparable_functional_issue_duplicate_none_conflict"), true);
});

test("validates Section 22F comparable energy and green hierarchy and conditional records", () => {
  const comparable = { id: "a4c92569-f14e-4b2a-9295-e420fc296aac", entity_type: "sales_comparable", parent_entity_id: null, ordinal: 1, data: {} };
  const solarOne = { id: "88e83e35-a87f-4737-89e8-c79ab225b730", entity_type: "sales_comparable_renewable_energy_component", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const solarTwo = { id: "f63d3c55-c727-456c-b3d1-1a496758eaea", entity_type: "sales_comparable_renewable_energy_component", parent_entity_id: comparable.id, ordinal: 2, data: {} };
  const staleCertification = { id: "afc135c5-1d03-43ed-aadc-59b3cd671f01", entity_type: "sales_comparable_green_certification", parent_entity_id: comparable.id, ordinal: 1, data: {} };
  const orphanRating = { id: "5a8a7f02-7a20-4fe8-824d-eb22235c6fd1", entity_type: "sales_comparable_efficiency_rating", parent_entity_id: "bfed6f75-1c13-4bc6-aa65-a92f70c898b0", ordinal: 1, data: {} };
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(comparable.id, "sales_comparable_energy_green", "1800.0108", true),
    value(comparable.id, "sales_comparable_energy_green", "1800.0107", false),
    value(comparable.id, "sales_comparable_energy_green", "1800.0106", true),
    value(solarOne.id, "sales_comparable_renewable_energy_component", "1800.0113", "Solar"),
    value(solarOne.id, "sales_comparable_renewable_energy_component", "1800.0114", "stale description"),
    value(solarTwo.id, "sales_comparable_renewable_energy_component", "1800.0113", "Solar"),
    value(staleCertification.id, "sales_comparable_green_certification", "1800.0110", "NGBS Green"),
    value(orphanRating.id, "sales_comparable_efficiency_rating", "1800.0111", "HERS Index"),
    value(orphanRating.id, "sales_comparable_efficiency_rating", "1800.0112", "62"),
    value(comparable.id, "sales_comparable_adjustment_energy_green", "1800.0317", 0),
  ];
  const codes = validateCompleteSection(
    "sales_comparison",
    [],
    values,
    [comparable, solarOne, solarTwo, staleCertification, orphanRating],
  ).map((error) => error.code);
  assert.equal(codes.includes("sales_comparable_energy_green_child_orphaned"), true);
  assert.equal(codes.includes("sales_comparable_green_certification_conflict"), true);
  assert.equal(codes.includes("sales_comparable_efficiency_rating_required"), true);
  assert.equal(codes.includes("sales_comparable_renewable_energy_component_duplicate"), true);
  assert.equal(codes.includes("sales_comparable_renewable_energy_other_conflict"), true);
});

test("recognizes only verified entity-linked Section 22 comparable photos", () => {
  const asset = {
    section_number: 22,
    entity_id: "923d5c2a-cce9-4f07-8f8e-a3ed2e498142",
    caption_type: "PropertyPhoto",
    content_type: "image/webp",
    status: "verified",
  };
  assert.equal(isVerifiedSalesComparisonAsset(asset, "PropertyPhoto", asset.entity_id), true);
  assert.equal(isVerifiedSalesComparisonAsset({ ...asset, entity_id: null }, "PropertyPhoto", asset.entity_id), false);
  assert.equal(isVerifiedSalesComparisonAsset({ ...asset, content_type: "application/pdf" }, "PropertyPhoto", asset.entity_id), false);
  assert.equal(isVerifiedSalesComparisonAsset({ ...asset, status: "pending_upload" }, "PropertyPhoto", asset.entity_id), false);
});

test("seeds Section 22A additively with official compliance rules", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260904_uad_sales_comparison_general.sql"), "utf8");
  assert.match(sql, /SalesComparisonApproachIndicator/);
  assert.match(sql, /'1800\.0192','sales_comparable','22\.01\.16'/);
  assert.match(sql, /PropertyPhoto/);
  assert.match(sql, /SalesComparisonApproachExhibit/);
  for (const ruleId of [
    "UAD1218", "UAD1275", "UAD1390", "UAD1391", "UAD1392", "UAD1393",
    "UAD1394", "UAD1395", "UAD1396", "UAD1397", "UAD1402", "UAD1403",
    "UAD1404", "UAD1428", "UAD1433", "UAD1469", "UAD1477", "UAD1481",
    "UAD1731", "UAD1771", "UAD1773",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-SALES-COMPARISON-004/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("seeds Section 22B project information additively from the official delivery specification", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260905_uad_sales_comparison_project.sql"), "utf8");
  assert.match(sql, /PropertyInProjectIndicator/);
  assert.match(sql, /PUDIndicator/);
  assert.match(sql, /ProjectInformation/);
  assert.match(sql, /'2500\.0065','project_information','22\.02\.01'/);
  assert.match(sql, /'1800\.0056','sales_comparable_project_amenity','22\.02\.08'/);
  assert.match(sql, /HN-UAD-SALES-COMPARISON-PROJECT-004/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("seeds Section 22C Site fields, redisplays, and current official rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260906_uad_sales_comparison_site.sql"), "utf8");
  for (const ruleId of [
    "UAD1398", "UAD1399", "UAD1400", "UAD1401", "UAD1445", "UAD1446",
    "UAD1447", "UAD1448", "UAD1449", "UAD1450", "UAD1451", "UAD1452",
    "UAD1476", "UAD1769", "UAD1770",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /'0100\.0047','subject','22\.03\.01'/);
  assert.match(sql, /'1800\.0233','sales_comparable_site_influence','22\.03\.42'/);
  assert.match(sql, /PropertyStreetAccessAndSurface/);
  assert.match(sql, /sales_comparable_site_environmental/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("seeds Section 22D water frontage fields, hierarchy, redisplays, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260907_uad_sales_comparison_water_frontage.sql"), "utf8");
  const runner = fs.readFileSync(path.resolve(directory, "../src/database/uadMigrations.js"), "utf8");
  assert.match(sql, /UAD1462/);
  assert.match(sql, /PrivateAccessIndicator/);
  assert.match(sql, /sales_comparable_body_of_water/);
  assert.match(sql, /sales_comparable_waterfront_feature/);
  assert.match(sql, /'1500\.0072','site_influence','22\.04\.01'/);
  assert.match(sql, /'1800\.0317','sales_comparable_adjustment_water_frontage','22\.04\.05'/);
  assert.match(sql, /WaterFrontage/);
  assert.match(sql, /HN-UAD-SALES-COMPARISON-WATER-005/);
  assert.match(runner, /20260907_uad_sales_comparison_water_frontage\.sql/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("seeds Section 22E dwelling fields, hierarchy, redisplays, adjustments, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260908_uad_sales_comparison_dwelling.sql"), "utf8");
  const runner = fs.readFileSync(path.resolve(directory, "../src/database/uadMigrations.js"), "utf8");
  for (const ruleId of [
    "UAD1097", "UAD1416", "UAD1418", "UAD1421", "UAD1422", "UAD1423",
    "UAD1424", "UAD1425", "UAD1467", "UAD1774", "UAD1775",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /sales_comparable_dwelling/);
  assert.match(sql, /sales_comparable_heating_system/);
  assert.match(sql, /sales_comparable_cooling_system/);
  assert.match(sql, /'0300\.0011','dwelling','22\.05\.02'/);
  assert.match(sql, /'1800\.0128','sales_comparable_dwelling','22\.05\.21'/);
  assert.match(sql, /GrossBuildingFinishedArea/);
  assert.match(sql, /HN-UAD-SALES-COMPARISON-DWELLING-006/);
  assert.match(runner, /20260908_uad_sales_comparison_dwelling\.sql/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("seeds Section 22F energy and green fields, redisplays, adjustment, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260909_uad_sales_comparison_energy_green.sql"), "utf8");
  const runner = fs.readFileSync(path.resolve(directory, "../src/database/uadMigrations.js"), "utf8");
  assert.match(sql, /sales_comparable_renewable_energy_component/);
  assert.match(sql, /sales_comparable_green_certification/);
  assert.match(sql, /sales_comparable_efficiency_rating/);
  assert.match(sql, /'2600\.0005','energy_green','22\.06\.01'/);
  assert.match(sql, /'1800\.0108','sales_comparable_energy_green','22\.06\.05'/);
  assert.match(sql, /EnergyEfficientAndGreenFeatures/);
  assert.match(sql, /HN-UAD-SALES-COMPARISON-ENERGY-GREEN-004/);
  assert.match(runner, /20260909_uad_sales_comparison_energy_green\.sql/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("wires Section 22 through server and frontend without changing legacy forms", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const entities = fs.readFileSync(path.resolve(directory, "../src/modules/uad/entities.js"), "utf8");
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(entities, /uad_entity\.ordinal/);
  assert.match(entities, /parent_entity_id IS NOT DISTINCT FROM/);
  assert.match(editor, /sales_comparable_photo_required/);
  assert.match(editor, /sales_comparable_data_source_required/);
  assert.match(assets, /invalid_uad_sales_comparison_asset_entity/);
  assert.match(frontend, /Sales Comparison Approach exhibits/);
  assert.match(frontend, /future adjustment grid/);
  assert.doesNotMatch(frontend, /PropertyReport/);
});
