import assert from "node:assert/strict";
import test from "node:test";

import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { getUadField } from "../src/modules/uad/fieldCatalog.js";
import { UAD_SALES_COMPARISON_CAPTION_TYPES } from "../src/modules/uad/salesComparisonCatalog.js";
import { UAD_SITE_CAPTION_TYPES } from "../src/modules/uad/siteCatalog.js";

const value = (entityId, contextKey, uid, fieldValue) => ({
  field: getUadField(contextKey, uid),
  entityId,
  value: fieldValue,
});

const codesFor = (section, values, entities = [], assets = []) => new Set(
  validateCompleteSection(section, [], values, entities, assets).map((error) => error.code),
);

test("fails closed for valuation methods that are not currently eligible for Fannie delivery", () => {
  const exteriorCodes = codesFor("assignment", [
    value(null, "assignment", "1000.0158", "ExteriorAppraisal"),
    value(null, "appraiser_inspection", "2400.0081", "Physical"),
    value(null, "appraiser_inspection", "2400.0082", "NoInspection"),
  ]);
  assert.equal(exteriorCodes.has("fannie_exterior_appraisal_not_eligible"), true);

  const traditionalCodes = codesFor("assignment", [
    value(null, "assignment", "1000.0158", "TraditionalAppraisal"),
    value(null, "appraiser_inspection", "2400.0081", "Virtual"),
    value(null, "appraiser_inspection", "2400.0082", "NoInspection"),
  ]);
  assert.equal(traditionalCodes.has("traditional_appraisal_exterior_inspection_required"), true);
  assert.equal(traditionalCodes.has("traditional_appraisal_interior_inspection_required"), true);
});

test("enforces current subject, site, and sales-comparison image requirements", () => {
  assert.equal(UAD_SITE_CAPTION_TYPES.includes("NonResidentialUse"), true);
  assert.equal(UAD_SALES_COMPARISON_CAPTION_TYPES.includes("SalesComparableMap"), true);

  const view = { id: "d0d51b31-c7b3-4735-9c1d-2f6381978968", entity_type: "site_view", parent_entity_id: null, ordinal: 1, data: {} };
  const siteValues = [
    value(null, "site_mixed_use", "1500.0034", true),
    value(view.id, "site_view", "1500.0184", "Adverse"),
  ];
  const missingCodes = codesFor("site", siteValues, [view]);
  assert.equal(missingCodes.has("site_property_access_photo_required"), true);
  assert.equal(missingCodes.has("site_non_residential_use_photo_required"), true);
  assert.equal(missingCodes.has("site_view_photo_required"), true);

  const assets = [
    { section_number: 4, entity_id: null, caption_type: "PropertyAccess", content_type: "image/jpeg", status: "verified" },
    { section_number: 4, entity_id: null, caption_type: "NonResidentialUse", content_type: "image/jpeg", status: "verified" },
    { section_number: 4, entity_id: view.id, caption_type: "View", content_type: "image/jpeg", status: "verified" },
  ];
  const satisfiedCodes = codesFor("site", siteValues, [view], assets);
  assert.equal(satisfiedCodes.has("site_property_access_photo_required"), false);
  assert.equal(satisfiedCodes.has("site_non_residential_use_photo_required"), false);
  assert.equal(satisfiedCodes.has("site_view_photo_required"), false);
});

test("requires ANSI or a documented controlling alternative for applicable dwellings", () => {
  const dwelling = { id: "1c4d8904-b1d7-4559-8cc6-9bc665914f59", entity_type: "dwelling", parent_entity_id: null, ordinal: 1, data: {} };
  const codes = codesFor("sketch", [
    value(null, "assignment", "1000.0158", "TraditionalAppraisal"),
    value(null, "subject", "0100.0020", "Detached"),
    value(null, "sketch", "3300.0002", true),
    value(null, "sketch", "3300.0007", "AmericanMeasurementStandard"),
  ], [dwelling], [{
    section_number: 7,
    entity_id: null,
    caption_type: "SubjectPropertyImprovementSketch",
    content_type: "image/png",
    status: "verified",
  }]);
  assert.equal(codes.has("ansi_measurement_standard_required"), true);
});

test("requires fully updated new-construction kitchen, bathroom, and flooring classifications", () => {
  const unit = { id: "10e5f9ad-b9f4-4f92-8828-487612c378b3", entity_type: "unit", parent_entity_id: "2ef58f0b-74b1-48d0-bfbb-0c01554df477", ordinal: 1, data: {} };
  const kitchen = { id: "27a6558c-fc5b-45e1-a38b-f842fcf383a1", entity_type: "unit_room", parent_entity_id: unit.id, ordinal: 1, data: {} };
  const codes = codesFor("unit_interior", [
    value(null, "subject", "0300.0010", true),
    value(unit.id, "unit", "0700.0117", "NotUpdated"),
    value(unit.id, "unit", "0700.0122", "PartiallyUpdated"),
    value(kitchen.id, "unit_room", "0700.0035", "Kitchen"),
    value(kitchen.id, "unit_room", "0700.0036", "PartiallyUpdated"),
  ], [unit, kitchen]);
  assert.equal(codes.has("new_construction_fully_updated_required"), true);
  assert.equal(codes.has("new_construction_room_fully_updated_required"), true);
});

test("blocks unsupported native approach scenarios instead of reusing a summary value", () => {
  const dwelling = { id: "f941e0b8-33aa-43c3-a843-f2556e371747", entity_type: "dwelling", parent_entity_id: null, ordinal: 1, data: {} };
  const codes = codesFor("reconciliation", [
    value(null, "subject", "0100.0022", 2),
    value(null, "scope_of_work", "1000.0030", true),
    value(null, "scope_of_work", "1000.0027", true),
    value(null, "income_approach_summary", "1200.0004", 425000),
    value(null, "cost_approach_summary", "1300.0001", 430000),
    value(dwelling.id, "dwelling", "0300.0034", "Manufactured"),
  ], [dwelling]);
  assert.equal(codes.has("native_income_approach_section_required"), true);
  assert.equal(codes.has("native_cost_approach_section_required"), true);
  assert.equal(codes.has("two_to_four_unit_native_income_approach_required"), true);
  assert.equal(codes.has("manufactured_home_native_cost_approach_required"), true);
});

test("requires three closed sales, a map, and an indicated value inside the adjusted range", () => {
  const comparables = [1, 2, 3].map((ordinal) => ({
    id: `00000000-0000-4000-8000-00000000000${ordinal}`,
    entity_type: "sales_comparable",
    parent_entity_id: null,
    ordinal,
    data: {},
  }));
  const values = [
    value(null, "sales_comparison_scope", "1000.0032", true),
    value(null, "sales_comparison_summary", "1300.0006", 500000),
    ...comparables.flatMap((comparable, index) => [
      value(comparable.id, "sales_comparable_listing", "1800.0075", "SettledSale"),
      value(comparable.id, "sales_comparable_sale", "1800.0272", 300000 + (index * 50000)),
      value(comparable.id, "sales_comparable_summary", "1800.0309", 300000 + (index * 50000)),
    ]),
  ];
  const withoutMap = codesFor("sales_comparison", values, comparables);
  assert.equal(withoutMap.has("minimum_three_closed_sales_required"), false);
  assert.equal(withoutMap.has("sales_subject_property_photo_required"), true);
  assert.equal(withoutMap.has("sales_comparable_map_required"), true);
  assert.equal(withoutMap.has("sales_indicated_value_outside_adjusted_range"), true);
});
