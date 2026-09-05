import assert from "node:assert/strict";
import test from "node:test";

import { assertUadAssetEntityRelationship } from "../src/modules/uad/assets.js";

const ID = "00000000-0000-4000-8000-000000000001";
const PARENT_ID = "00000000-0000-4000-8000-000000000002";

function asset(sectionNumber, captionType, entityId = ID) {
  return { sectionNumber, captionType, entityId };
}

function entity(entityType, parentEntityType = null) {
  return {
    id: ID,
    entity_type: entityType,
    parent_entity_id: parentEntityType ? PARENT_ID : null,
    parent_entity_type: parentEntityType,
  };
}

test("accepts every canonical entity relationship used by Sections 8 through 13", () => {
  const validRelationships = [
    [asset(8, "DwellingFront"), entity("dwelling")],
    [asset(9, "ManufacturedHomeHUDDataPlate"), entity("dwelling")],
    [asset(9, "ManufacturedHomeHUDCertificationLabel"), entity("manufactured_home_hud_label", "dwelling")],
    [asset(9, "ManufacturedHomeFinancingProgramEligibilityCertification"), entity("manufactured_home_financing_program", "dwelling")],
    [asset(10, "UnitInteriorExhibit"), entity("unit", "dwelling")],
    [asset(10, "Kitchen"), entity("unit_room", "unit")],
    [asset(10, "Flooring"), entity("unit_interior_feature", "unit")],
    [asset(10, "UnitInteriorDefect"), entity("unit_interior_defect", "unit")],
    [asset(11, "FunctionalObsolescenceExhibit", null), null],
    [asset(12, "OutbuildingFront"), entity("outbuilding")],
    [asset(12, "OutbuildingDefect"), entity("outbuilding_defect", "outbuilding")],
    [asset(13, "VehicleStorage"), entity("vehicle_storage")],
    [asset(13, "VehicleStorageDefect"), entity("vehicle_storage_defect", "vehicle_storage")],
  ];
  for (const [input, selectedEntity] of validRelationships) {
    assert.doesNotThrow(() => assertUadAssetEntityRelationship(input, selectedEntity));
  }
});

test("rejects same-workfile entities from an unrelated evidence section", () => {
  const mismatches = [
    [asset(8, "DwellingFront"), entity("vehicle_storage")],
    [asset(9, "ManufacturedHomeHUDDataPlate"), entity("outbuilding")],
    [asset(10, "Kitchen"), entity("dwelling")],
    [asset(11, "FunctionalObsolescenceExhibit"), entity("unit")],
    [asset(12, "OutbuildingFront"), entity("dwelling")],
    [asset(13, "VehicleStorage"), entity("outbuilding")],
  ];
  for (const [input, selectedEntity] of mismatches) {
    assert.throws(
      () => assertUadAssetEntityRelationship(input, selectedEntity),
      /invalid_uad_.*_asset_entity/,
    );
  }
});

test("requires canonical parents for child evidence entities", () => {
  assert.throws(
    () => assertUadAssetEntityRelationship(
      asset(10, "Kitchen"),
      entity("unit_room", "outbuilding"),
    ),
    /invalid_uad_unit_interior_asset_entity/,
  );
  assert.throws(
    () => assertUadAssetEntityRelationship(
      asset(12, "OutbuildingDefect"),
      entity("outbuilding_defect"),
    ),
    /invalid_uad_outbuilding_asset_entity/,
  );
  assert.throws(
    () => assertUadAssetEntityRelationship(
      asset(13, "VehicleStorageDefect"),
      entity("vehicle_storage_defect", "dwelling"),
    ),
    /invalid_uad_vehicle_storage_asset_entity/,
  );
});

test("preserves both subject and comparable Section 22 property photos", () => {
  assert.doesNotThrow(() => assertUadAssetEntityRelationship(asset(22, "PropertyPhoto", null), null));
  assert.doesNotThrow(() => assertUadAssetEntityRelationship(
    asset(22, "PropertyPhoto"),
    entity("sales_comparable"),
  ));
  assert.throws(
    () => assertUadAssetEntityRelationship(asset(22, "PropertyPhoto"), entity("dwelling")),
    /invalid_uad_sales_comparison_asset_entity/,
  );
});

test("rejects entities on workfile-level exhibits and accepts canonical typed exhibits", () => {
  assert.doesNotThrow(() => assertUadAssetEntityRelationship(
    asset(4, "View"),
    entity("site_view"),
  ));
  assert.doesNotThrow(() => assertUadAssetEntityRelationship(
    asset(14, "SubjectPropertyAmenityDefect"),
    entity("amenity_defect", "amenity"),
  ));
  assert.throws(
    () => assertUadAssetEntityRelationship(asset(7, "FloorPlan"), entity("dwelling")),
    /invalid_uad_sketch_asset_entity/,
  );
  assert.throws(
    () => assertUadAssetEntityRelationship(asset(18, "ProjectExhibit"), entity("project_amenity")),
    /invalid_uad_project_information_asset_entity/,
  );
});
