import { randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { isVerifiedDwellingFrontAsset } from "./dwellingExteriorCatalog.js";
import { UAD_FUNCTIONAL_ISSUE_TYPES } from "./functionalObsolescenceCatalog.js";
import { listUadEntities } from "./entities.js";
import {
  UAD_EDITOR_SECTION_KEYS,
  UAD_PHASE_ONE_FIELDS,
  evaluateUadCondition,
  getUadEditorSections,
  normalizeAndValidateUadValue,
  uadFieldAppliesToEntity,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "./fieldCatalog.js";
import { isVerifiedManufacturedHomeAsset } from "./manufacturedHomeCatalog.js";
import { isVerifiedOutbuildingAsset } from "./outbuildingCatalog.js";
import { isVerifiedSketchReportAsset } from "./sketchCatalog.js";
import {
  UAD_SUBJECT_AMENITY_CATEGORIES,
  UAD_SUBJECT_AMENITY_CATEGORY_LIMITS,
  UAD_SUBJECT_AMENITY_FIELD_KEYS,
  isVerifiedSubjectPropertyAmenitiesAsset,
} from "./subjectPropertyAmenitiesCatalog.js";
import { isVerifiedUnitInteriorAsset } from "./unitInteriorCatalog.js";
import { isVerifiedVehicleStorageAsset } from "./vehicleStorageCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

function responseValue(row) {
  return {
    id: row.id,
    entity_id: row.entity_id || null,
    uid: row.uad_uid,
    context_key: row.field_context,
    report_field_id: row.report_field_id,
    value: row.value,
    source_type: row.source_type,
    source_reference: row.source_reference || null,
    is_appraiser_confirmed: Boolean(row.is_appraiser_confirmed),
    is_override: Boolean(row.is_override),
    override_reason: row.override_reason || null,
    updated_at: row.updated_at,
  };
}

function valueKey(value) {
  return `${value.entity_id || "root"}:${value.field_context}:${value.uad_uid}`;
}

function fieldValueKey(field, entityId = null) {
  return `${entityId || "root"}:${field.key}`;
}

function isPresent(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return value.amount !== null && value.amount !== undefined && value.amount !== "" && Boolean(value.unit);
  return true;
}

function valueLookup(valuesByKey, entityId = null) {
  return (requestedKey, options = {}) => {
    if (options.uidOnly) {
      const prefix = `${entityId || "root"}:`;
      const suffix = `:${requestedKey}`;
      for (const [key, value] of valuesByKey) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) return value;
      }
      for (const [key, value] of valuesByKey) {
        if (key.startsWith("root:") && key.endsWith(suffix)) return value;
      }
      return undefined;
    }
    return valuesByKey.get(`${entityId || "root"}:${requestedKey}`)
      ?? valuesByKey.get(`root:${requestedKey}`);
  };
}

function valuesMap(values) {
  return new Map(values.map((value) => [valueKey(value), value.value]));
}

const REQUIRED_UNIT_INTERIOR_ROOM_PHOTO_TYPES = new Set([
  "Bedroom",
  "DiningRoom",
  "FamilyRoom",
  "FullBathroom",
  "HalfBathroom",
  "Kitchen",
  "LivingRoom",
]);

function unitRoomRequiresPhoto(room, valuesByKey, entities) {
  const lookup = valueLookup(valuesByKey, room.id);
  const roomType = lookup("unit_room:0700.0035");
  if (REQUIRED_UNIT_INTERIOR_ROOM_PHOTO_TYPES.has(roomType)) return true;
  const roomLevel = lookup("unit_room:0700.0121");
  return entities.some((entity) => (
    entity.entity_type === "unit_level"
    && entity.parent_entity_id === room.parent_entity_id
    && valueLookup(valuesByKey, entity.id)("unit_level:0700.0030") === roomLevel
    && ["FullyBelowGrade", "PartiallyBelowGrade"].includes(
      valueLookup(valuesByKey, entity.id)("unit_level:0700.0029"),
    )
  ));
}

function workfileHasManufacturedHome(valuesByKey, entities) {
  return entities.some((entity) => (
    (entity.entity_type === "dwelling"
      && valueLookup(valuesByKey, entity.id)("dwelling:0300.0034") === "Manufactured")
    || (entity.entity_type === "outbuilding"
      && valueLookup(valuesByKey, entity.id)("outbuilding:0300.0025") === "ManufacturedHome")
  ));
}

function sectionIsApplicable(section, valuesByKey, entities) {
  if (!section.appliesWhen) return true;
  const candidates = section.appliesToEntityType
    ? entities.filter((entity) => entity.entity_type === section.appliesToEntityType).map((entity) => entity.id)
    : [null];
  return candidates.some((entityId) => evaluateUadCondition(
    section.appliesWhen,
    valueLookup(valuesByKey, entityId),
  ));
}

function completionFor(values, entities, assets = []) {
  const byKey = valuesMap(values);
  const result = {};
  for (const section of UAD_EDITOR_SECTION_KEYS) {
    let required = 0;
    let completed = 0;
    for (const field of UAD_PHASE_ONE_FIELDS.filter((candidate) => candidate.section === section)) {
      const instances = field.entityType
        ? entities.filter((entity) => uadFieldAppliesToEntity(field, entity)).map((entity) => entity.id)
        : [null];
      for (const entityId of instances) {
        const lookup = valueLookup(byKey, entityId);
        if (!uadFieldIsVisible(field, lookup) || !uadFieldIsRequired(field, lookup)) continue;
        required += 1;
        if (isPresent(byKey.get(fieldValueKey(field, entityId)))) completed += 1;
      }
    }
    if (section === "sketch" && byKey.get("root:sketch:3300.0002") === true) {
      required += 1;
      if (assets.some(isVerifiedSketchReportAsset)) completed += 1;
    }
    if (section === "dwelling_exterior") {
      const dwellings = entities.filter((entity) => entity.entity_type === "dwelling");
      required += dwellings.length;
      completed += dwellings.filter((dwelling) => assets.some((asset) => isVerifiedDwellingFrontAsset(asset, dwelling.id))).length;
    }
    if (section === "manufactured_home") {
      const manufacturedDwellings = entities.filter((entity) => (
        entity.entity_type === "dwelling"
        && valueLookup(byKey, entity.id)("dwelling:0300.0034") === "Manufactured"
      ));
      for (const dwelling of manufacturedDwellings) {
        const lookup = valueLookup(byKey, dwelling.id);
        if (lookup("manufactured_home:0500.0010") === true) {
          required += 1;
          if (assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeHUDDataPlate", dwelling.id))) completed += 1;
        }
        const labels = entities.filter((entity) => entity.entity_type === "manufactured_home_hud_label" && entity.parent_entity_id === dwelling.id);
        if (lookup("manufactured_home:0500.0009") === true || labels.length) {
          required += Math.max(1, labels.length);
          completed += labels.filter((label) => assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeHUDCertificationLabel", label.id))).length;
        }
        const programs = entities.filter((entity) => entity.entity_type === "manufactured_home_financing_program" && entity.parent_entity_id === dwelling.id);
        required += programs.length;
        completed += programs.filter((program) => assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeFinancingProgramEligibilityCertification", program.id))).length;
      }
    }
    if (section === "unit_interior") {
      const rooms = entities.filter((entity) => entity.entity_type === "unit_room");
      for (const room of rooms) {
        const roomType = valueLookup(byKey, room.id)("unit_room:0700.0035");
        if (unitRoomRequiresPhoto(room, byKey, entities)) {
          required += 1;
          if (assets.some((asset) => isVerifiedUnitInteriorAsset(asset, roomType, room.id))) completed += 1;
        }
      }
      const units = entities.filter((entity) => entity.entity_type === "unit");
      for (const unit of units) {
        const flooringUpdated = valueLookup(byKey, unit.id)("unit:0700.0122");
        if (flooringUpdated && flooringUpdated !== "NotUpdated") {
          const flooringFeatures = entities.filter((entity) => (
            entity.entity_type === "unit_interior_feature"
            && entity.parent_entity_id === unit.id
            && valueLookup(byKey, entity.id)("unit_interior_feature:0700.0046") === "Flooring"
          ));
          required += 1;
          if (flooringFeatures.some((feature) => assets.some((asset) => (
            isVerifiedUnitInteriorAsset(asset, "Flooring", feature.id)
          )))) completed += 1;
        }
      }
      const defects = entities.filter((entity) => entity.entity_type === "unit_interior_defect");
      required += defects.length;
      completed += defects.filter((defect) => assets.some((asset) => (
        isVerifiedUnitInteriorAsset(asset, "UnitInteriorDefect", defect.id)
      ))).length;
    }
    if (section === "outbuilding") {
      const outbuildings = entities.filter((entity) => entity.entity_type === "outbuilding");
      for (const outbuilding of outbuildings) {
        for (const captionType of ["OutbuildingFront", "OutbuildingInterior"]) {
          required += 1;
          if (assets.some((asset) => isVerifiedOutbuildingAsset(asset, captionType, outbuilding.id))) {
            completed += 1;
          }
        }
      }
      const defects = entities.filter((entity) => entity.entity_type === "outbuilding_defect");
      required += defects.length;
      completed += defects.filter((defect) => assets.some((asset) => (
        isVerifiedOutbuildingAsset(asset, "OutbuildingDefect", defect.id)
      ))).length;
    }
    if (section === "vehicle_storage") {
      const vehicleStorages = entities.filter((entity) => entity.entity_type === "vehicle_storage");
      const storageTypes = vehicleStorages.map((entity) => (
        valueLookup(byKey, entity.id)("vehicle_storage:3200.0006")
      ));
      if (storageTypes.some((type) => type && type !== "None")) {
        required += 1;
        if (isPresent(byKey.get("root:vehicle_storage:3200.0021"))) completed += 1;
      }
      if (storageTypes.includes("SharedDriveway")) {
        required += 1;
        if (isPresent(byKey.get("root:vehicle_storage_commentary:3200.0018"))) completed += 1;
      }
      const defects = entities.filter((entity) => entity.entity_type === "vehicle_storage_defect");
      required += defects.length;
      completed += defects.filter((defect) => assets.some((asset) => (
        isVerifiedVehicleStorageAsset(asset, "VehicleStorageDefect", defect.id)
      ))).length;
    }
    if (section === "subject_property_amenities") {
      const amenities = entities.filter((entity) => entity.entity_type === "amenity");
      const amenitiesExist = byKey.get("root:subject_property_amenities:0200.0015");
      if (amenitiesExist === true) {
        required += 1;
        if (amenities.length) completed += 1;
      }
      if (workfileHasManufacturedHome(byKey, entities)) {
        for (const amenity of amenities.filter((entity) => entity.data?.amenity_category === "OutdoorLiving")) {
          const lookup = valueLookup(byKey, amenity.id);
          const type = lookup(UAD_SUBJECT_AMENITY_FIELD_KEYS.OutdoorLiving.type);
          if (["Deck", "Gazebo", "Porch", "Portico"].includes(type)) {
            required += 1;
            if (isPresent(lookup(UAD_SUBJECT_AMENITY_FIELD_KEYS.OutdoorLiving.attachedToManufacturedHome))) {
              completed += 1;
            }
          }
        }
      }
      const defects = entities.filter((entity) => entity.entity_type === "amenity_defect");
      required += defects.length;
      completed += defects.filter((defect) => assets.some((asset) => (
        isVerifiedSubjectPropertyAmenitiesAsset(asset, "SubjectPropertyAmenityDefect", defect.id)
      ))).length;
    }
    result[section] = {
      completed,
      required,
      percent: required ? Math.round((completed / required) * 100) : 100,
    };
  }
  return result;
}

async function loadValues(queryable, workfileId, suffix = "") {
  const { rows } = await queryable.query(
    `SELECT *
       FROM appraisal.uad_field_values
      WHERE workfile_id = $1
      ORDER BY created_at, id
      ${suffix}`,
    [workfileId],
  );
  return rows;
}

export async function getUadEditor(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    `SELECT id, account_id, file_number, specification_release_key, status,
            current_revision, updated_at
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const [rows, entities, assets] = await Promise.all([
    loadValues(pool, workfileId),
    listUadEntities(pool, workfileId),
    listUadAssets(pool, workfileId),
  ]);
  const sections = getUadEditorSections();
  const responseRows = rows.map(responseValue);
  const byKey = valuesMap(rows);
  return {
    workfile: { ...workfileResult.rows[0], current_revision: Number(workfileResult.rows[0].current_revision) },
    sections: sections.map((section) => ({
      ...section,
      applicable: sectionIsApplicable(section, byKey, entities),
    })),
    entities,
    values: responseRows,
    completion: completionFor(rows, entities, assets),
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validationError(field, entityId, code, message) {
  return { key: field.key, uid: field.uid, context_key: field.contextKey, entity_id: entityId, code, message };
}

function validateCompleteSection(section, existingRows, submitted, entities, assets = []) {
  const merged = valuesMap(existingRows);
  for (const item of submitted) merged.set(fieldValueKey(item.field, item.entityId), item.value);
  const errors = [];
  for (const field of UAD_PHASE_ONE_FIELDS.filter((candidate) => candidate.section === section)) {
    const instances = field.entityType
      ? entities.filter((entity) => uadFieldAppliesToEntity(field, entity)).map((entity) => entity.id)
      : [null];
    for (const entityId of instances) {
      const lookup = valueLookup(merged, entityId);
      if (!uadFieldIsVisible(field, lookup) || !uadFieldIsRequired(field, lookup)) continue;
      const rawValue = merged.get(fieldValueKey(field, entityId));
      if (!isPresent(rawValue)) {
        errors.push(validationError(field, entityId, "required", `${field.label} is required.`));
        continue;
      }
      const result = normalizeAndValidateUadValue(field, rawValue);
      if (result.error) errors.push({ ...result.error, entity_id: entityId });
    }
  }

  if (section === "site") {
    const rootLookup = valueLookup(merged);
    const parcelCount = Number(rootLookup("site:1500.0094"));
    const parcels = entities.filter((entity) => entity.entity_type === "site_parcel");
    if (Number.isInteger(parcelCount) && parcelCount !== parcels.length) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0094");
      errors.push(validationError(field, null, "parcel_count", `Parcel count must match the ${parcels.length} parcel record${parcels.length === 1 ? "" : "s"} in this workfile.`));
    }
    const defectsExist = rootLookup("site:1500.0178");
    const defects = entities.filter((entity) => entity.entity_type === "site_defect");
    if (defectsExist === true && defects.length === 0) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0178");
      errors.push(validationError(field, null, "site_defect_required", "Add at least one site defect when site defects exist."));
    }
    if (defectsExist === false && defects.length > 0) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0178");
      errors.push(validationError(field, null, "site_defect_conflict", "Remove site defect records or change the site-defects answer to Yes."));
    }
  }

  if (section === "disaster_mitigation") {
    const rootLookup = valueLookup(merged);
    const features = rootLookup("disaster_mitigation:3700.0002");
    if (Array.isArray(features) && features.includes("None") && features.length > 1) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "disaster_mitigation:3700.0002");
      errors.push(validationError(field, null, "mitigation_none_conflict", "Select None by itself, or remove None before selecting disaster mitigation features."));
    }
  }

  if (section === "energy_green") {
    const rootLookup = valueLookup(merged);
    const entityRequirements = [
      {
        key: "energy_green:2600.0005",
        entityType: "renewable_energy_component",
        label: "renewable energy component",
      },
      {
        key: "energy_green:2600.0004",
        entityType: "green_building_certification",
        label: "building certification",
      },
      {
        key: "energy_green:2600.0003",
        entityType: "green_efficiency_rating",
        label: "efficiency rating",
      },
    ];
    for (const requirement of entityRequirements) {
      const indicator = rootLookup(requirement.key);
      const matchingEntities = entities.filter((entity) => entity.entity_type === requirement.entityType);
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === requirement.key);
      if (indicator === true && matchingEntities.length === 0) {
        errors.push(validationError(field, null, "energy_detail_required", `Add at least one ${requirement.label} when the known-features answer is Yes.`));
      }
      if (indicator === false && matchingEntities.length > 0) {
        errors.push(validationError(field, null, "energy_detail_conflict", `Remove ${requirement.label} records or change the known-features answer to Yes.`));
      }
    }
  }

  if (section === "sketch") {
    const rootLookup = valueLookup(merged);
    const sketchExists = rootLookup("sketch:3300.0002");
    const reportAssets = assets.filter(isVerifiedSketchReportAsset);
    const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "sketch:3300.0002");
    if (sketchExists === true && reportAssets.length === 0) {
      errors.push(validationError(field, null, "sketch_asset_required", "Upload and verify at least one sketch or floor plan image."));
    }
    if (sketchExists === false && reportAssets.length > 0) {
      errors.push(validationError(field, null, "sketch_asset_conflict", "Remove the saved sketch or floor plan images, or change the provided answer to Yes."));
    }
  }

  if (section === "dwelling_exterior") {
    const rootLookup = valueLookup(merged);
    const dwellings = entities.filter((entity) => entity.entity_type === "dwelling");
    const maintenance = rootLookup("subject:0100.0046");
    const requiredFeatureTypes = ["ExteriorWallsAndTrim", "Foundation", "Roof", "Windows"];
    const structureIdentifiers = new Set();
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0063");
    if (!dwellings.length) {
      errors.push(validationError(baseField, null, "dwelling_required", "Add at least one dwelling to the workfile."));
    }
    for (const dwelling of dwellings) {
      const lookup = valueLookup(merged, dwelling.id);
      const featureEntities = entities.filter((entity) => entity.entity_type === "dwelling_exterior_feature" && entity.parent_entity_id === dwelling.id);
      const roomEntities = entities.filter((entity) => entity.entity_type === "dwelling_noncontinuous_room" && entity.parent_entity_id === dwelling.id);
      const defectEntities = entities.filter((entity) => entity.entity_type === "dwelling_exterior_defect" && entity.parent_entity_id === dwelling.id);
      const manufacturedHomeEntities = entities.filter((entity) => (
        [
          "manufactured_home_skirting_material",
          "manufactured_home_modification",
          "manufactured_home_hud_label",
          "manufactured_home_financing_program",
        ].includes(entity.entity_type) && entity.parent_entity_id === dwelling.id
      ));
      const featureTypes = new Set(featureEntities.map((entity) => valueLookup(merged, entity.id)("dwelling_exterior_feature:0300.0055")));

      if (maintenance === true) {
        const missingTypes = requiredFeatureTypes.filter((type) => !featureTypes.has(type));
        if (missingTypes.length) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:1600.0005");
          errors.push(validationError(field, dwelling.id, "dwelling_feature_required", `Add the required exterior feature records: ${missingTypes.join(", ")}.`));
        }
      } else if (maintenance === false && featureEntities.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:1600.0005");
        errors.push(validationError(field, dwelling.id, "dwelling_feature_conflict", "Remove exterior feature records or change exterior-maintenance responsibility to Yes in Subject Property."));
      }

      const noncontinuousExists = lookup("dwelling:0300.0114");
      if (noncontinuousExists === true && roomEntities.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0114");
        errors.push(validationError(field, dwelling.id, "noncontinuous_room_required", "Add at least one room type for the noncontinuous finished area."));
      }
      if (noncontinuousExists === false && roomEntities.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0114");
        errors.push(validationError(field, dwelling.id, "noncontinuous_room_conflict", "Remove noncontinuous room records or change the noncontinuous-area answer to Yes."));
      }

      const defectsExist = lookup("dwelling:3900.0097");
      if (defectsExist === true && defectEntities.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:3900.0097");
        errors.push(validationError(field, dwelling.id, "dwelling_defect_required", "Add at least one exterior defect when exterior defects exist."));
      }
      if (defectsExist === false && defectEntities.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:3900.0097");
        errors.push(validationError(field, dwelling.id, "dwelling_defect_conflict", "Remove exterior defect records or change the exterior-defects answer to Yes."));
      }

      const heatingSystems = lookup("dwelling:0300.0088");
      if (Array.isArray(heatingSystems) && heatingSystems.includes("None") && heatingSystems.length > 1) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0088");
        errors.push(validationError(field, dwelling.id, "heating_none_conflict", "Select None by itself, or remove None before selecting heating systems."));
      }

      if (!assets.some((asset) => isVerifiedDwellingFrontAsset(asset, dwelling.id))) {
        errors.push(validationError(baseField, dwelling.id, "dwelling_front_photo_required", "Upload and verify a front photo for this dwelling."));
      }

      const structureIdentifier = lookup("dwelling:0300.0101");
      if (structureIdentifier) {
        if (structureIdentifiers.has(structureIdentifier)) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0101");
          errors.push(validationError(field, dwelling.id, "duplicate_structure_identifier", "Structure identifiers must be unique within the workfile."));
        }
        structureIdentifiers.add(structureIdentifier);
      }

      if (lookup("dwelling:0300.0034") !== "Manufactured") {
        const manufacturedEntityIds = new Set(manufacturedHomeEntities.map((entity) => entity.id));
        const manufacturedAssets = assets.filter((asset) => (
          asset.section_number === 9
          && (asset.entity_id === dwelling.id || manufacturedEntityIds.has(asset.entity_id))
        ));
        if (manufacturedHomeEntities.length || manufacturedAssets.length) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0034");
          errors.push(validationError(field, dwelling.id, "manufactured_home_data_conflict", "Remove the saved Manufactured Home records and exhibits before changing Construction Method from Manufactured."));
        }
      }
    }
  }

  if (section === "manufactured_home") {
    const manufacturedDwellings = entities.filter((entity) => (
      entity.entity_type === "dwelling"
      && valueLookup(merged, entity.id)("dwelling:0300.0034") === "Manufactured"
    ));
    const manufacturedDwellingIds = new Set(manufacturedDwellings.map((entity) => entity.id));
    const childTypes = new Set([
      "manufactured_home_skirting_material",
      "manufactured_home_modification",
      "manufactured_home_hud_label",
      "manufactured_home_financing_program",
    ]);
    const orphanedChildren = entities.filter((entity) => (
      childTypes.has(entity.entity_type) && !manufacturedDwellingIds.has(entity.parent_entity_id)
    ));
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0017");
    if (orphanedChildren.length) {
      errors.push(validationError(baseField, null, "manufactured_home_parent_conflict", "Manufactured Home detail records must belong to a dwelling whose Construction Method is Manufactured."));
    }

    for (const dwelling of manufacturedDwellings) {
      const lookup = valueLookup(merged, dwelling.id);
      const skirtingMaterials = entities.filter((entity) => entity.entity_type === "manufactured_home_skirting_material" && entity.parent_entity_id === dwelling.id);
      const modifications = entities.filter((entity) => entity.entity_type === "manufactured_home_modification" && entity.parent_entity_id === dwelling.id);
      const hudLabels = entities.filter((entity) => entity.entity_type === "manufactured_home_hud_label" && entity.parent_entity_id === dwelling.id);
      const financingPrograms = entities.filter((entity) => entity.entity_type === "manufactured_home_financing_program" && entity.parent_entity_id === dwelling.id);

      const skirting = lookup("manufactured_home:0500.0030");
      if (skirting === true && skirtingMaterials.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0030");
        errors.push(validationError(field, dwelling.id, "manufactured_home_skirting_required", "Add at least one skirting material when skirting exists."));
      }
      if (skirting === false && skirtingMaterials.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0030");
        errors.push(validationError(field, dwelling.id, "manufactured_home_skirting_conflict", "Remove skirting material records or change the skirting answer to Yes."));
      }

      const modificationsExist = lookup("manufactured_home:0500.0020");
      if (modificationsExist === true && modifications.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0020");
        errors.push(validationError(field, dwelling.id, "manufactured_home_modification_required", "Add at least one modification, attachment, or addition record."));
      }
      if (modificationsExist === false && modifications.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0020");
        errors.push(validationError(field, dwelling.id, "manufactured_home_modification_conflict", "Remove modification records or change the modifications answer to Yes."));
      }

      const labelPresent = lookup("manufactured_home:0500.0009");
      if (labelPresent === true && hudLabels.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0009");
        errors.push(validationError(field, dwelling.id, "manufactured_home_hud_label_required", "Add each HUD certification label and its certification number."));
      }
      for (const hudLabel of hudLabels) {
        if (!assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeHUDCertificationLabel", hudLabel.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home_hud_label:0500.0037");
          errors.push(validationError(field, hudLabel.id, "manufactured_home_hud_label_asset_required", "Upload and verify an image for this HUD certification label."));
        }
      }

      if (
        lookup("manufactured_home:0500.0010") === true
        && !assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeHUDDataPlate", dwelling.id))
      ) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0010");
        errors.push(validationError(field, dwelling.id, "manufactured_home_data_plate_asset_required", "Upload and verify an image of the HUD data plate or verification source."));
      }

      for (const program of financingPrograms) {
        if (!assets.some((asset) => isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeFinancingProgramEligibilityCertification", program.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home_financing_program:0500.0005");
          errors.push(validationError(field, program.id, "manufactured_home_program_asset_required", "Upload and verify the certification image for this financing program."));
        }
      }

      const manufactureDate = String(lookup("manufactured_home:0500.0016") || "");
      const yearBuilt = String(lookup("dwelling:0300.0011") || "");
      if (manufactureDate && yearBuilt && manufactureDate.slice(0, 4) !== yearBuilt) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "manufactured_home:0500.0016");
        errors.push(validationError(field, dwelling.id, "manufactured_home_year_mismatch", "The Date of Manufacture year must match Year Built in Dwelling Exterior."));
      }
    }
  }

  if (section === "functional_obsolescence") {
    const rootLookup = valueLookup(merged);
    const issueTypes = rootLookup("functional_obsolescence:3600.0002");
    const issueField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === "functional_obsolescence:3600.0002"
    ));
    if (Array.isArray(issueTypes) && issueTypes.includes("None") && issueTypes.length > 1) {
      errors.push(validationError(
        issueField,
        null,
        "functional_issue_none_conflict",
        "Select None by itself, or remove None before selecting functional issues.",
      ));
    }
    if (Array.isArray(issueTypes) && issueTypes.length > 10) {
      errors.push(validationError(
        issueField,
        null,
        "functional_issue_limit",
        "No more than 10 functional issues may be delivered for the subject property.",
      ));
    }
    if (Array.isArray(issueTypes) && issueTypes.some((type) => !UAD_FUNCTIONAL_ISSUE_TYPES.includes(type))) {
      errors.push(validationError(
        issueField,
        null,
        "functional_issue_type",
        "Functional issues contain an unsupported selection.",
      ));
    }
  }

  if (section === "outbuilding") {
    const outbuildings = entities.filter((entity) => entity.entity_type === "outbuilding");
    const outbuildingIds = new Set(outbuildings.map((entity) => entity.id));
    const childTypes = new Set(["outbuilding_room", "outbuilding_defect"]);
    const orphanedChildren = entities.filter((entity) => (
      childTypes.has(entity.entity_type) && !outbuildingIds.has(entity.parent_entity_id)
    ));
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0025");
    if (orphanedChildren.length) {
      errors.push(validationError(baseField, null, "outbuilding_parent_conflict", "Outbuilding room and defect records must belong to an outbuilding in this workfile."));
    }

    for (const outbuilding of outbuildings) {
      const lookup = valueLookup(merged, outbuilding.id);
      const rooms = entities.filter((entity) => entity.entity_type === "outbuilding_room" && entity.parent_entity_id === outbuilding.id);
      const defects = entities.filter((entity) => entity.entity_type === "outbuilding_defect" && entity.parent_entity_id === outbuilding.id);
      const units = entities.filter((entity) => entity.entity_type === "unit" && entity.parent_entity_id === outbuilding.id);
      const realProperty = lookup("outbuilding:0300.0024");
      const reportedUnits = Number(lookup("outbuilding:0300.0063"));
      const finishedArea = Number(lookup("outbuilding:0300.0112")?.amount ?? 0);
      const utilities = lookup("outbuilding:0300.0028");
      const heating = lookup("outbuilding:0300.0088");
      const outbuildingType = lookup("outbuilding:0300.0025");

      for (const captionType of ["OutbuildingFront", "OutbuildingInterior"]) {
        if (!assets.some((asset) => isVerifiedOutbuildingAsset(asset, captionType, outbuilding.id))) {
          errors.push(validationError(baseField, outbuilding.id, "outbuilding_photo_required", `Upload and verify an ${captionType === "OutbuildingFront" ? "exterior/front" : "interior"} photo for this outbuilding.`));
        }
      }

      if (realProperty === true && Number.isInteger(reportedUnits) && reportedUnits !== units.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0063");
        errors.push(validationError(field, outbuilding.id, "outbuilding_unit_count", `Units in structure must match the ${units.length} saved Unit Interior record${units.length === 1 ? "" : "s"} for this outbuilding.`));
      }
      if (realProperty === false && (units.length || rooms.length || defects.length)) {
        errors.push(validationError(baseField, outbuilding.id, "outbuilding_real_property_conflict", "Remove unit, room, and defect detail records before marking this outbuilding as not real property."));
      }
      if (outbuildingType === "StandaloneADU" && (!Number.isInteger(reportedUnits) || reportedUnits < 1)) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0063");
        errors.push(validationError(field, outbuilding.id, "outbuilding_adu_unit_required", "A Standalone ADU must contain at least one living unit."));
      }
      if (Array.isArray(utilities) && utilities.includes("None") && utilities.length > 1) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0028");
        errors.push(validationError(field, outbuilding.id, "outbuilding_utility_none_conflict", "Select None by itself, or remove None before selecting utilities."));
      }
      if (Array.isArray(heating) && heating.includes("None") && heating.length > 1) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0088");
        errors.push(validationError(field, outbuilding.id, "outbuilding_heating_none_conflict", "Select None by itself, or remove None before selecting heating systems."));
      }
      if (realProperty === true && finishedArea > 0 && rooms.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0112");
        errors.push(validationError(field, outbuilding.id, "outbuilding_room_required", "Add at least one room summary when the outbuilding has finished area."));
      }
      if (finishedArea === 0 && rooms.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0112");
        errors.push(validationError(field, outbuilding.id, "outbuilding_room_conflict", "Remove finished room records or report finished outbuilding area greater than zero."));
      }
      const defectsExist = lookup("outbuilding:0300.0111");
      if (defectsExist === true && defects.length === 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0111");
        errors.push(validationError(field, outbuilding.id, "outbuilding_defect_required", "Add at least one outbuilding defect when defects exist."));
      }
      if (defectsExist === false && defects.length > 0) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding:0300.0111");
        errors.push(validationError(field, outbuilding.id, "outbuilding_defect_conflict", "Remove outbuilding defect records or change the defects answer to Yes."));
      }
      for (const defect of defects) {
        if (!assets.some((asset) => isVerifiedOutbuildingAsset(asset, "OutbuildingDefect", defect.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "outbuilding_defect:3900.0164");
          errors.push(validationError(field, defect.id, "outbuilding_defect_photo_required", "Upload and verify a photo documenting this outbuilding defect."));
        }
      }
    }
  }

  if (section === "vehicle_storage") {
    const vehicleStorages = entities.filter((entity) => entity.entity_type === "vehicle_storage");
    const vehicleStorageIds = new Set(vehicleStorages.map((entity) => entity.id));
    const defects = entities.filter((entity) => entity.entity_type === "vehicle_storage_defect");
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "vehicle_storage:3200.0006");
    const indicatorField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "vehicle_storage:3200.0021");

    if (!vehicleStorages.length) {
      errors.push(validationError(baseField, null, "vehicle_storage_required", "Add one vehicle storage record and select None when the property has no vehicle storage."));
    }

    const orphanedDefects = defects.filter((defect) => !vehicleStorageIds.has(defect.parent_entity_id));
    if (orphanedDefects.length) {
      errors.push(validationError(baseField, null, "vehicle_storage_parent_conflict", "Every vehicle storage defect must belong to a vehicle storage in this workfile."));
    }

    const storageTypes = vehicleStorages.map((entity) => ({
      entity,
      type: valueLookup(merged, entity.id)("vehicle_storage:3200.0006"),
    }));
    const noneStorages = storageTypes.filter(({ type }) => type === "None");
    const reportedStorages = storageTypes.filter(({ type }) => type && type !== "None");
    if (noneStorages.length && vehicleStorages.length > 1) {
      errors.push(validationError(baseField, noneStorages[0].entity.id, "vehicle_storage_none_conflict", "Select None as the only vehicle storage record, or remove None before reporting other storage types."));
    }

    const rootLookup = valueLookup(merged);
    const defectsExist = rootLookup("vehicle_storage:3200.0021");
    if (reportedStorages.length && typeof defectsExist !== "boolean") {
      errors.push(validationError(indicatorField, null, "vehicle_storage_defects_indicator_required", "Indicate whether any reported vehicle storage has defects, damages, or deficiencies."));
    }
    if (noneStorages.length && (defectsExist === true || defects.length)) {
      errors.push(validationError(indicatorField, null, "vehicle_storage_none_defect_conflict", "A property with Vehicle Storage set to None cannot contain vehicle storage defects."));
    }
    if (defectsExist === true && defects.length === 0) {
      errors.push(validationError(indicatorField, null, "vehicle_storage_defect_required", "Add at least one vehicle storage defect when defects exist."));
    }
    if (defectsExist === false && defects.length > 0) {
      errors.push(validationError(indicatorField, null, "vehicle_storage_defect_conflict", "Remove vehicle storage defect records or change the defects answer to Yes."));
    }

    if (storageTypes.some(({ type }) => type === "SharedDriveway")) {
      const commentaryField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
        candidate.key === "vehicle_storage_commentary:3200.0018"
      ));
      if (!isPresent(rootLookup("vehicle_storage_commentary:3200.0018"))) {
        errors.push(validationError(commentaryField, null, "shared_driveway_commentary_required", "Explain the shared driveway in Vehicle Storage Commentary."));
      }
    }

    for (const { entity, type } of storageTypes) {
      const lookup = valueLookup(merged, entity.id);
      if (["Driveway", "SharedDriveway"].includes(type)) {
        const tenOrMore = lookup("vehicle_storage:3200.0011");
        const parkingSpaces = lookup("vehicle_storage:3200.0010");
        if (tenOrMore === false && (!Number.isInteger(parkingSpaces) || parkingSpaces < 1 || parkingSpaces > 9)) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "vehicle_storage:3200.0010");
          errors.push(validationError(field, entity.id, "vehicle_storage_driveway_space_count", "Enter between 1 and 9 parking spaces when the driveway has fewer than ten spaces."));
        }
      }

      const storageDefects = defects.filter((defect) => defect.parent_entity_id === entity.id);
      if (type === "None" && storageDefects.length) {
        errors.push(validationError(baseField, entity.id, "vehicle_storage_none_child_conflict", "Remove defect records from a Vehicle Storage record set to None."));
      }
      for (const defect of storageDefects) {
        if (!assets.some((asset) => isVerifiedVehicleStorageAsset(asset, "VehicleStorageDefect", defect.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "vehicle_storage_defect:3900.0181");
          errors.push(validationError(field, defect.id, "vehicle_storage_defect_photo_required", "Upload and verify a photo documenting this vehicle storage defect."));
        }
      }
    }
  }

  if (section === "subject_property_amenities") {
    const rootLookup = valueLookup(merged);
    const amenitiesExist = rootLookup("subject_property_amenities:0200.0015");
    const defectsExist = rootLookup("subject_property_amenities:0200.0053");
    const amenities = entities.filter((entity) => entity.entity_type === "amenity");
    const amenityIds = new Set(amenities.map((entity) => entity.id));
    const defects = entities.filter((entity) => entity.entity_type === "amenity_defect");
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === "subject_property_amenities:0200.0015"
    ));
    const indicatorField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === "subject_property_amenities:0200.0053"
    ));

    if (amenitiesExist === true && !amenities.length) {
      errors.push(validationError(baseField, null, "subject_amenity_required", "Add at least one subject property amenity when Property Amenities Exist is Yes."));
    }
    if (amenitiesExist === false && (amenities.length || defects.length || defectsExist === true)) {
      errors.push(validationError(baseField, null, "subject_amenity_none_conflict", "Remove amenity and defect records before changing Property Amenities Exist to No."));
    }

    for (const category of UAD_SUBJECT_AMENITY_CATEGORIES) {
      const categoryAmenities = amenities.filter((entity) => entity.data?.amenity_category === category);
      if (categoryAmenities.length > UAD_SUBJECT_AMENITY_CATEGORY_LIMITS[category]) {
        errors.push(validationError(
          baseField,
          null,
          "subject_amenity_category_limit",
          `${category.replace(/([a-z])([A-Z])/g, "$1 $2")} supports no more than ${UAD_SUBJECT_AMENITY_CATEGORY_LIMITS[category]} amenity records.`,
        ));
      }
    }

    const manufacturedHomePresent = workfileHasManufacturedHome(merged, entities);
    for (const amenity of amenities) {
      const category = amenity.data?.amenity_category;
      const keys = UAD_SUBJECT_AMENITY_FIELD_KEYS[category];
      if (!keys) {
        errors.push(validationError(baseField, amenity.id, "subject_amenity_category_invalid", "The amenity record must use one of the five supported UAD amenity categories."));
        continue;
      }
      const lookup = valueLookup(merged, amenity.id);
      const categoryField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === keys.category);
      if (isPresent(lookup(keys.category)) && lookup(keys.category) !== category) {
        errors.push(validationError(categoryField, amenity.id, "subject_amenity_category_conflict", "The selected amenity category must match the category of this amenity record."));
      }

      const type = lookup(keys.type);
      if (
        manufacturedHomePresent
        && category === "OutdoorLiving"
        && ["Deck", "Gazebo", "Porch", "Portico"].includes(type)
        && !isPresent(lookup(keys.attachedToManufacturedHome))
      ) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => (
          candidate.key === keys.attachedToManufacturedHome
        ));
        errors.push(validationError(field, amenity.id, "subject_amenity_manufactured_attachment_required", "Indicate whether this amenity is permanently attached to the manufactured home."));
      }

      const amenityImages = assets.filter((asset) => (
        isVerifiedSubjectPropertyAmenitiesAsset(asset, "SubjectPropertyAmenity", amenity.id)
      ));
      if (amenityImages.length > 2) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === keys.type);
        errors.push(validationError(field, amenity.id, "subject_amenity_photo_limit", "No more than two report images may be attached to one amenity."));
      }
    }

    const orphanedDefects = defects.filter((defect) => !amenityIds.has(defect.parent_entity_id));
    if (orphanedDefects.length) {
      errors.push(validationError(baseField, null, "subject_amenity_defect_parent_conflict", "Every amenity defect must belong to a subject property amenity in this workfile."));
    }
    if (defects.length > 6) {
      errors.push(validationError(indicatorField, null, "subject_amenity_defect_limit", "No more than six amenity defects may be delivered."));
    }
    if (defectsExist === true && !defects.length) {
      errors.push(validationError(indicatorField, null, "subject_amenity_defect_required", "Add at least one amenity defect when defects exist."));
    }
    if (defectsExist === false && defects.length) {
      errors.push(validationError(indicatorField, null, "subject_amenity_defect_conflict", "Remove amenity defect records or change the defects answer to Yes."));
    }
    for (const defect of defects) {
      const defectImages = assets.filter((asset) => (
        isVerifiedSubjectPropertyAmenitiesAsset(asset, "SubjectPropertyAmenityDefect", defect.id)
      ));
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => (
        candidate.key === "subject_property_amenity_defect:3900.0139"
      ));
      if (!defectImages.length) {
        errors.push(validationError(field, defect.id, "subject_amenity_defect_photo_required", "Upload and verify a photo documenting this physical amenity defect."));
      }
      if (defectImages.length > 4) {
        errors.push(validationError(field, defect.id, "subject_amenity_defect_photo_limit", "No more than four report images may be attached to one amenity defect."));
      }
    }
  }

  if (section === "unit_interior") {
    const units = entities.filter((entity) => entity.entity_type === "unit");
    const unitIds = new Set(units.map((entity) => entity.id));
    const structures = new Map(entities.filter((entity) => (
      entity.entity_type === "dwelling" || entity.entity_type === "outbuilding"
    )).map((entity) => [entity.id, entity]));
    const childTypes = new Set([
      "unit_area_data_source",
      "unit_adu_data_source",
      "unit_level",
      "unit_room",
      "unit_interior_feature",
      "unit_interior_defect",
    ]);
    const baseField = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0140");
    const identifiers = new Set();
    const amount = (value) => Number(value?.amount ?? 0);
    const orphanedChildren = entities.filter((entity) => (
      childTypes.has(entity.entity_type) && !unitIds.has(entity.parent_entity_id)
    ));
    if (!units.length) {
      errors.push(validationError(baseField, null, "unit_required", "Add at least one living unit to the workfile."));
    }
    if (orphanedChildren.length) {
      errors.push(validationError(baseField, null, "unit_interior_parent_conflict", "Unit Interior detail records must belong to a living unit in this workfile."));
    }
    const orphanedUnits = units.filter((unit) => !structures.has(unit.parent_entity_id));
    if (orphanedUnits.length) {
      errors.push(validationError(baseField, null, "unit_structure_parent_conflict", "Every living unit must belong to a dwelling or outbuilding in this workfile."));
    }

    for (const unit of units) {
      const lookup = valueLookup(merged, unit.id);
      const areaSources = entities.filter((entity) => entity.entity_type === "unit_area_data_source" && entity.parent_entity_id === unit.id);
      const aduSources = entities.filter((entity) => entity.entity_type === "unit_adu_data_source" && entity.parent_entity_id === unit.id);
      const levels = entities.filter((entity) => entity.entity_type === "unit_level" && entity.parent_entity_id === unit.id);
      const rooms = entities.filter((entity) => entity.entity_type === "unit_room" && entity.parent_entity_id === unit.id);
      const features = entities.filter((entity) => entity.entity_type === "unit_interior_feature" && entity.parent_entity_id === unit.id);
      const defects = entities.filter((entity) => entity.entity_type === "unit_interior_defect" && entity.parent_entity_id === unit.id);

      const unitIdentifier = String(lookup("unit:0700.0114") || "").trim();
      if ((units.length > 1 || lookup("unit:0700.0089") === true) && !unitIdentifier) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0114");
        errors.push(validationError(field, unit.id, "unit_identifier_required", "Provide a unique identifier for every multi-unit dwelling unit and ADU."));
      }
      if (unitIdentifier) {
        const normalizedIdentifier = unitIdentifier.toLowerCase();
        if (identifiers.has(normalizedIdentifier)) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0114");
          errors.push(validationError(field, unit.id, "duplicate_unit_identifier", "Unit identifiers must be unique within the workfile."));
        }
        identifiers.add(normalizedIdentifier);
      }

      if (!areaSources.length) {
        errors.push(validationError(baseField, unit.id, "unit_area_source_required", "Add at least one source for the unit area measurements."));
      }
      const aduExists = lookup("unit:0700.0089");
      if (structures.get(unit.parent_entity_id)?.entity_type === "outbuilding" && aduExists !== true) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0089");
        errors.push(validationError(field, unit.id, "outbuilding_unit_must_be_adu", "Every living unit in an outbuilding must be identified as an ADU."));
      }
      if (aduExists === true && !aduSources.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0089");
        errors.push(validationError(field, unit.id, "unit_adu_source_required", "Add at least one source supporting the ADU determination."));
      }
      if (aduExists === false && aduSources.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0089");
        errors.push(validationError(field, unit.id, "unit_adu_source_conflict", "Remove ADU source records or change the ADU answer to Yes."));
      }

      const reportedLevelCount = Number(lookup("unit:0700.0063"));
      if (!levels.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0063");
        errors.push(validationError(field, unit.id, "unit_level_required", "Add every above-grade and below-grade level in this unit."));
      } else if (Number.isInteger(reportedLevelCount) && reportedLevelCount !== levels.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0063");
        errors.push(validationError(field, unit.id, "unit_level_count", `Number of levels must match the ${levels.length} saved level record${levels.length === 1 ? "" : "s"}.`));
      }

      let aboveFinished = 0;
      let aboveUnfinished = 0;
      let belowFinished = 0;
      let belowUnfinished = 0;
      const levelTypes = new Set();
      for (const level of levels) {
        const levelLookup = valueLookup(merged, level.id);
        const levelType = levelLookup("unit_level:0700.0030");
        if (levelType) levelTypes.add(levelType);
        const below = ["FullyBelowGrade", "PartiallyBelowGrade"].includes(levelLookup("unit_level:0700.0029"));
        if (below) {
          belowFinished += amount(levelLookup("unit_level:0700.0137"));
          belowUnfinished += amount(levelLookup("unit_level:0700.0138"));
        } else {
          aboveFinished += amount(levelLookup("unit_level:0700.0137"));
          aboveUnfinished += amount(levelLookup("unit_level:0700.0138"));
        }
      }
      const reportedAboveFinished = amount(lookup("unit:0700.0140")) + amount(lookup("unit:0700.0141"));
      const reportedBelowFinished = amount(lookup("unit:0700.0143")) + amount(lookup("unit:1800.0398"));
      const areaChecks = [
        [aboveFinished, reportedAboveFinished, "above-grade finished"],
        [aboveUnfinished, amount(lookup("unit:0700.0142")), "above-grade unfinished"],
        [belowFinished, reportedBelowFinished, "below-grade finished"],
        [belowUnfinished, amount(lookup("unit:0700.0144")), "below-grade unfinished"],
      ];
      for (const [levelTotal, reportedTotal, label] of areaChecks) {
        if (Math.abs(levelTotal - reportedTotal) > 0.01) {
          errors.push(validationError(baseField, unit.id, "unit_area_reconciliation", `The ${label} level total (${levelTotal} sq ft) must equal the unit area total (${reportedTotal} sq ft).`));
        }
      }

      const roomTypes = rooms.map((room) => valueLookup(merged, room.id)("unit_room:0700.0035"));
      if (!roomTypes.includes("Kitchen")) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_room:0700.0035");
        errors.push(validationError(field, unit.id, "unit_kitchen_required", "Add at least one kitchen for each living unit."));
      }
      const roomCountChecks = [
        ["Bedroom", "unit:0700.0118", "bedroom"],
        ["FullBathroom", "unit:0700.0119", "full bathroom"],
        ["HalfBathroom", "unit:0700.0120", "half bathroom"],
      ];
      for (const [roomType, fieldKey, label] of roomCountChecks) {
        const actual = roomTypes.filter((type) => type === roomType).length;
        const reported = Number(lookup(fieldKey));
        if (Number.isInteger(reported) && reported !== actual) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === fieldKey);
          errors.push(validationError(field, unit.id, "unit_room_count", `The ${label} count must match the ${actual} saved ${label} record${actual === 1 ? "" : "s"}.`));
        }
      }
      for (const room of rooms) {
        const roomLookup = valueLookup(merged, room.id);
        const roomType = roomLookup("unit_room:0700.0035");
        const roomLevel = roomLookup("unit_room:0700.0121");
        if (roomLevel && !levelTypes.has(roomLevel)) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_room:0700.0121");
          errors.push(validationError(field, room.id, "unit_room_level_conflict", "Room level must match one of this unit's saved level records."));
        }
        if (unitRoomRequiresPhoto(room, merged, entities)
          && !assets.some((asset) => isVerifiedUnitInteriorAsset(asset, roomType, room.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_room:0700.0035");
          const roomLabel = String(roomType || "room").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
          errors.push(validationError(field, room.id, "unit_room_photo_required", `Upload and verify a photo for this ${roomLabel}.`));
        }
      }

      const featureTypes = features.map((feature) => valueLookup(merged, feature.id)("unit_interior_feature:0700.0046"));
      for (const requiredFeature of ["Flooring", "WallsAndCeiling"]) {
        if (!featureTypes.includes(requiredFeature)) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_interior_feature:0700.0046");
          errors.push(validationError(field, unit.id, "unit_interior_feature_required", `Add the required ${requiredFeature.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} feature record.`));
        }
      }
      const flooringUpdated = lookup("unit:0700.0122");
      if (flooringUpdated && flooringUpdated !== "NotUpdated") {
        const flooringFeatures = features.filter((feature) => (
          valueLookup(merged, feature.id)("unit_interior_feature:0700.0046") === "Flooring"
        ));
        if (!flooringFeatures.some((feature) => assets.some((asset) => (
          isVerifiedUnitInteriorAsset(asset, "Flooring", feature.id)
        )))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0122");
          errors.push(validationError(field, unit.id, "unit_flooring_update_photo_required", "Upload and verify a photo documenting the reported flooring update."));
        }
      }

      const accessibility = lookup("unit_accessibility:0700.0005");
      if (Array.isArray(accessibility) && accessibility.includes("None") && accessibility.length > 1) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_accessibility:0700.0005");
        errors.push(validationError(field, unit.id, "unit_accessibility_none_conflict", "Select None by itself, or remove None before selecting accessibility features."));
      }

      const defectsExist = lookup("unit:3900.0107");
      if (defectsExist === true && !defects.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:3900.0107");
        errors.push(validationError(field, unit.id, "unit_interior_defect_required", "Add every apparent interior defect, damage, or deficiency requiring action."));
      }
      if (defectsExist === false && defects.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:3900.0107");
        errors.push(validationError(field, unit.id, "unit_interior_defect_conflict", "Remove interior defect records or change the interior-defects answer to Yes."));
      }
      for (const defect of defects) {
        if (!assets.some((asset) => isVerifiedUnitInteriorAsset(asset, "UnitInteriorDefect", defect.id))) {
          const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit_interior_defect:3900.0130");
          errors.push(validationError(field, defect.id, "unit_interior_defect_photo_required", "Upload and verify a photo documenting this interior defect."));
        }
      }
    }

    const dwellings = entities.filter((entity) => entity.entity_type === "dwelling");
    for (const dwelling of dwellings) {
      const dwellingUnits = units.filter((unit) => unit.parent_entity_id === dwelling.id);
      const reportedDwellingUnits = Number(valueLookup(merged, dwelling.id)("dwelling:0300.0063"));
      if (Number.isInteger(reportedDwellingUnits) && reportedDwellingUnits !== dwellingUnits.length) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "dwelling:0300.0063");
        errors.push(validationError(field, dwelling.id, "dwelling_unit_count", `Subject property units in structure must match the ${dwellingUnits.length} saved living unit record${dwellingUnits.length === 1 ? "" : "s"}.`));
      }
      const hasPrimaryUnit = dwellingUnits.some((unit) => valueLookup(merged, unit.id)("unit:0700.0089") === false);
      if (!hasPrimaryUnit) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "unit:0700.0089");
        errors.push(validationError(field, dwelling.id, "dwelling_primary_unit_required", "Each dwelling must contain at least one living unit that is not an ADU."));
      }
    }
    const primaryUnitCount = units.filter((unit) => valueLookup(merged, unit.id)("unit:0700.0089") === false).length;
    const aduCount = units.filter((unit) => valueLookup(merged, unit.id)("unit:0700.0089") === true).length;
    const subjectCountChecks = [
      ["subject:0100.0022", primaryUnitCount, "Living units excluding ADUs"],
      ["subject:0100.0019", aduCount, "Accessory dwelling units"],
      ["subject:0100.0021", dwellings.filter((dwelling) => units.some((unit) => unit.parent_entity_id === dwelling.id)).length, "Dwellings containing units"],
    ];
    for (const [fieldKey, actual, label] of subjectCountChecks) {
      const reported = Number(valueLookup(merged)(fieldKey));
      if (Number.isInteger(reported) && reported !== actual) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === fieldKey);
        errors.push(validationError(field, null, "subject_unit_count", `${label} must match the ${actual} saved Unit Interior record${actual === 1 ? "" : "s"}.`));
      }
    }
  }
  return errors;
}

export async function saveUadSection(pool, workfileIdValue, section, input = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, current_revision, specification_release_key
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");

    const [existingRows, entities, assets] = await Promise.all([
      loadValues(client, workfileId, "FOR UPDATE"),
      listUadEntities(client, workfileId),
      listUadAssets(client, workfileId),
    ]);
    const entityTypesById = new Map(entities.map((entity) => [entity.id, entity.entity_type]));
    const entityDataById = new Map(entities.map((entity) => [entity.id, entity.data]));
    const validation = validateUadSectionValues(section, input.values, { entityTypesById, entityDataById });
    if (validation.errors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = validation.errors;
      throw error;
    }
    const completeSectionErrors = validateCompleteSection(section, existingRows, validation.normalized, entities, assets);
    if (completeSectionErrors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = completeSectionErrors;
      throw error;
    }

    const existingByKey = new Map(existingRows.map((row) => [valueKey(row), row]));
    const changed = [];
    for (const { field, value, entityId } of validation.normalized) {
      const key = fieldValueKey(field, entityId);
      const previous = existingByKey.get(key);
      const changedFromPrevious = !previous || !jsonEqual(previous.value, value);
      const isOverride = Boolean(previous && previous.source_type !== "appraiser" && changedFromPrevious);
      const sourceType = previous && !changedFromPrevious ? previous.source_type : "appraiser";
      const sourceReference = previous && !changedFromPrevious ? previous.source_reference : "uad_workspace.section_save";
      const overrideReason = isOverride ? "Appraiser edited a HomeNode-prefilled value." : null;
      const id = previous?.id || randomUUID();

      if (previous) {
        await client.query(
          `UPDATE appraisal.uad_field_values
              SET value = $2::jsonb, report_field_id = $3, source_type = $4,
                  source_reference = $5, is_appraiser_confirmed = true,
                  is_override = $6, override_reason = $7, updated_at = now()
            WHERE id = $1`,
          [id, JSON.stringify(value), field.reportFieldId, sourceType, sourceReference, isOverride, overrideReason],
        );
      } else {
        await client.query(
          `INSERT INTO appraisal.uad_field_values (
             id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
             source_type, source_reference, is_appraiser_confirmed
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser', 'uad_workspace.section_save', true)`,
          [id, workfileId, entityId, field.contextKey, field.uid, field.reportFieldId, JSON.stringify(value)],
        );
      }
      if (changedFromPrevious || !previous?.is_appraiser_confirmed) {
        changed.push({ key: field.key, uid: field.uid, context_key: field.contextKey, entity_id: entityId, before: previous?.value ?? null, after: value });
      }
    }

    const revisionNumber = Number(locked.rows[0].current_revision) + 1;
    const allRows = await loadValues(client, workfileId);
    const revisionDocument = {
      entities,
      field_values: allRows.map((row) => ({
        entity_id: row.entity_id || null,
        uid: row.uad_uid,
        context_key: row.field_context,
        report_field_id: row.report_field_id,
        value: row.value,
        source_type: row.source_type,
        is_appraiser_confirmed: row.is_appraiser_confirmed,
      })),
    };
    await client.query(
      `UPDATE appraisal.uad_workfiles SET current_revision = $2, status = 'draft', updated_at = now() WHERE id = $1`,
      [workfileId, revisionNumber],
    );
    await client.query(
      `INSERT INTO appraisal.uad_revisions (
         id, workfile_id, revision_number, specification_release_key, document, change_summary
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [randomUUID(), workfileId, revisionNumber, locked.rows[0].specification_release_key, JSON.stringify(revisionDocument), `Saved ${section} information`],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, before_data, after_data, metadata
       ) VALUES ($1, 'uad_section.saved', 'uad_section', $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        workfileId,
        section,
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, before }) => ({ key, uid, context_key, entity_id, value: before }))),
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, after }) => ({ key, uid, context_key, entity_id, value: after }))),
        JSON.stringify({ revision_number: revisionNumber, submitted_field_count: validation.normalized.length }),
      ],
    );
    await client.query("COMMIT");

    return {
      section,
      current_revision: revisionNumber,
      saved_field_count: validation.normalized.length,
      changed_field_count: changed.length,
      values: allRows.map(responseValue),
      completion: completionFor(allRows, entities, assets),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
