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
import {
  UAD_MARKET_FIELD_KEYS,
  isVerifiedMarketAsset,
} from "./marketCatalog.js";
import {
  UAD_PROJECT_INFORMATION_FIELD_KEYS,
  isVerifiedProjectInformationAsset,
} from "./projectInformationCatalog.js";
import { UAD_PRIOR_TRANSFER_FIELD_KEYS } from "./priorSaleTransferCatalog.js";
import {
  UAD_SALES_COMPARISON_FIELD_KEYS,
  isVerifiedSalesComparisonAsset,
} from "./salesComparisonCatalog.js";
import {
  UAD_SALES_CONTRACT_FIELD_KEYS,
  isVerifiedSalesContractAsset,
} from "./salesContractCatalog.js";
import { isVerifiedOutbuildingAsset } from "./outbuildingCatalog.js";
import { UAD_HIGHEST_BEST_USE_FIELD_KEYS } from "./highestBestUseCatalog.js";
import { UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS } from "./overallQualityConditionCatalog.js";
import { isVerifiedSketchReportAsset } from "./sketchCatalog.js";
import { isVerifiedSiteAsset } from "./siteCatalog.js";
import {
  UAD_SUBJECT_AMENITY_CATEGORIES,
  UAD_SUBJECT_AMENITY_CATEGORY_LIMITS,
  UAD_SUBJECT_AMENITY_FIELD_KEYS,
  isVerifiedSubjectPropertyAmenitiesAsset,
} from "./subjectPropertyAmenitiesCatalog.js";
import { UAD_SUBJECT_LISTING_FIELD_KEYS } from "./subjectListingCatalog.js";
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

function overallQualityConditionSources(valuesByKey, entities) {
  const rootLookup = valueLookup(valuesByKey);
  const dwellings = entities.filter((entity) => entity.entity_type === "dwelling");
  const units = entities.filter((entity) => entity.entity_type === "unit").map((unit) => ({
    ...unit,
    accessoryDwellingUnit: valueLookup(valuesByKey, unit.id)(
      UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.accessoryDwellingUnit,
    ),
  }));
  return {
    homeownerMaintainsExterior: rootLookup(
      UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.homeownerMaintainsExterior,
    ),
    dwellings,
    units,
  };
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
    if (section === "site") {
      const influences = entities.filter((entity) => entity.entity_type === "site_influence");
      const bodies = entities.filter((entity) => entity.entity_type === "site_body_of_water");
      let hasPrivateWaterAccess = false;
      for (const influence of influences) {
        if (valueLookup(byKey, influence.id)("site_influence:1500.0087") !== "BodyOfWater") continue;
        const influenceBodies = bodies.filter((body) => body.parent_entity_id === influence.id);
        if (!influenceBodies.length) required += 1;
        if (influenceBodies.some((body) => valueLookup(byKey, body.id)("site_influence:1500.0075") === true)) {
          hasPrivateWaterAccess = true;
          required += 1;
          if (isPresent(valueLookup(byKey, influence.id)("site_influence:1500.0091"))) completed += 1;
        }
      }
      if (hasPrivateWaterAccess) {
        required += 1;
        if (assets.some((asset) => isVerifiedSiteAsset(asset, "WaterFrontage"))) completed += 1;
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
    if (section === "overall_quality_condition") {
      const source = overallQualityConditionSources(byKey, entities);
      required += 1;
      if (isPresent(source.homeownerMaintainsExterior)) completed += 1;
      if (source.homeownerMaintainsExterior === true) {
        for (const dwelling of source.dwellings) {
          const lookup = valueLookup(byKey, dwelling.id);
          required += 2;
          if (isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.exteriorQuality))) completed += 1;
          if (isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.exteriorCondition))) completed += 1;
        }
      }
      for (const unit of source.units) {
        required += 1;
        if (isPresent(unit.accessoryDwellingUnit)) completed += 1;
        if (unit.accessoryDwellingUnit === false) {
          const lookup = valueLookup(byKey, unit.id);
          required += 2;
          if (isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.interiorQuality))) completed += 1;
          if (isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.interiorCondition))) completed += 1;
        }
      }
    }
    if (section === "market") {
      const sources = entities.filter((entity) => entity.entity_type === "market_price_trend_source");
      if (!sources.length) required += 1;
      if (!assets.some((asset) => isVerifiedMarketAsset(asset, "PriceTrendGraph"))) {
        required += 1;
        if (isPresent(byKey.get(`root:${UAD_MARKET_FIELD_KEYS.priceTrendCommentary}`))) completed += 1;
      }
    }
    if (section === "project_information") {
      const rootLookup = valueLookup(byKey);
      const applicable = rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.pud) === true
        || isPresent(rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure));
      if (applicable) {
        for (const entityType of ["project_data_source", "project_amenity", "project_utility"]) {
          if (!entities.some((entity) => entity.entity_type === entityType)) required += 1;
        }
        if (
          rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectComplete) === false
          && !entities.some((entity) => entity.entity_type === "project_incomplete_component")
        ) required += 1;
        if (
          rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.blanketFinancing) === true
          && !entities.some((entity) => entity.entity_type === "project_blanket_financing")
        ) required += 1;
        if (rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectDeficiencies) === true) {
          required += 1;
          if (assets.some((asset) => isVerifiedProjectInformationAsset(asset, "ProjectDeficiency", null))) {
            completed += 1;
          }
        }
      }
    }
    if (section === "subject_listing_information") {
      const rootLookup = valueLookup(byKey);
      const hasListings = rootLookup(UAD_SUBJECT_LISTING_FIELD_KEYS.relevantListings);
      if (
        hasListings === true
        && !entities.some((entity) => entity.entity_type === "subject_listing")
      ) required += 1;
      if (
        hasListings === false
        && !entities.some((entity) => entity.entity_type === "subject_listing_data_source")
      ) required += 1;
    }
    if (section === "sales_comparison") {
      const included = valueLookup(byKey)(UAD_SALES_COMPARISON_FIELD_KEYS.included);
      if (included === true) {
        const subjectMaintainsExterior = valueLookup(byKey)("subject:0100.0046") === true;
        const subjectExteriorFeatures = entities.filter((entity) => entity.entity_type === "dwelling_exterior_feature");
        const subjectExteriorSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_exterior_quality_summary");
        if (subjectMaintainsExterior) {
          for (const feature of subjectExteriorFeatures) {
            const featureType = valueLookup(byKey, feature.id)("dwelling_exterior_feature:0300.0055");
            if (["Windows", "Other"].includes(featureType) && !subjectExteriorSummaries.some((summary) => summary.parent_entity_id === feature.id)) {
              required += 1;
            }
          }
        }
        const subjectUnits = entities.filter((entity) => entity.entity_type === "unit");
        const subjectNonAduUnitIds = new Set(
          subjectUnits
            .filter((unit) => valueLookup(byKey, unit.id)("unit:0700.0089") === false)
            .map((unit) => unit.id),
        );
        const subjectUnitSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_unit_interior_summary");
        const subjectKitchenSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_kitchen_summary");
        const subjectInteriorQualitySummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_interior_quality_summary");
        const subjectInteriorConditionSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_interior_condition_summary");
        for (const unit of subjectUnits.filter((entity) => subjectNonAduUnitIds.has(entity.id))) {
          const unitLookup = valueLookup(byKey, unit.id);
          if (
            Number(unitLookup("unit:0700.0119") || 0) + Number(unitLookup("unit:0700.0120") || 0) > 0
            && !subjectUnitSummaries.some((summary) => summary.parent_entity_id === unit.id)
          ) required += 1;
        }
        const subjectKitchens = entities.filter((entity) => (
          entity.entity_type === "unit_room"
          && subjectNonAduUnitIds.has(entity.parent_entity_id)
          && valueLookup(byKey, entity.id)("unit_room:0700.0035") === "Kitchen"
        ));
        for (const kitchen of subjectKitchens) {
          if (!subjectKitchenSummaries.some((summary) => summary.parent_entity_id === kitchen.id)) required += 1;
        }
        const subjectInteriorFeatures = entities.filter((entity) => (
          entity.entity_type === "unit_interior_feature"
          && subjectNonAduUnitIds.has(entity.parent_entity_id)
        ));
        for (const feature of subjectInteriorFeatures) {
          const featureType = valueLookup(byKey, feature.id)("unit_interior_feature:0700.0046");
          if (
            ["Flooring", "WallsAndCeiling", "Other"].includes(featureType)
            && !subjectInteriorQualitySummaries.some((summary) => summary.parent_entity_id === feature.id)
          ) required += 1;
          if (
            ["WallsAndCeiling", "Other"].includes(featureType)
            && !subjectInteriorConditionSummaries.some((summary) => summary.parent_entity_id === feature.id)
          ) required += 1;
        }
        const comparables = entities.filter((entity) => entity.entity_type === "sales_comparable");
        if (!comparables.length) required += 1;
        for (const comparable of comparables) {
          const sources = entities.filter((entity) => (
            entity.entity_type === "sales_comparable_data_source"
            && entity.parent_entity_id === comparable.id
          ));
          if (!sources.length) required += 1;
          required += 1;
          if (assets.some((asset) => isVerifiedSalesComparisonAsset(asset, "PropertyPhoto", comparable.id))) {
            completed += 1;
          }
          if (valueLookup(byKey, comparable.id)(UAD_SALES_COMPARISON_FIELD_KEYS.allRightsIncluded) === false) {
            const rights = entities.filter((entity) => (
              entity.entity_type === "sales_comparable_right_not_included"
              && entity.parent_entity_id === comparable.id
            ));
            if (!rights.length) required += 1;
          }
          const comparableLookup = valueLookup(byKey, comparable.id);
          const projectApplicable = comparableLookup(UAD_SALES_COMPARISON_FIELD_KEYS.pud) === true
            || comparableLookup(UAD_SALES_COMPARISON_FIELD_KEYS.inProject) === true;
          if (projectApplicable) {
            const amenities = entities.filter((entity) => (
              entity.entity_type === "sales_comparable_project_amenity"
              && entity.parent_entity_id === comparable.id
            ));
            if (!amenities.length) required += 1;
          }
          const comparableDwellings = entities.filter((entity) => (
            entity.entity_type === "sales_comparable_dwelling"
            && entity.parent_entity_id === comparable.id
          ));
          if (!comparableDwellings.length) required += 1;
          const attachment = comparableLookup(UAD_SALES_COMPARISON_FIELD_KEYS.propertyAttachment);
          const comparableMaintainsExterior = comparableLookup(UAD_SALES_COMPARISON_FIELD_KEYS.homeownerMaintainsExterior) === true;
          for (const dwelling of comparableDwellings) {
            const dwellingLookup = valueLookup(byKey, dwelling.id);
            const design = dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign);
            if (attachment === "Attached") {
              required += 1;
              if (isPresent(design)) completed += 1;
            }
            const constructionRequired = attachment === "Detached"
              || (attachment === "Attached" && ["RowhouseTownhouse", "SemiDetached", "Other"].includes(design));
            if (constructionRequired && !entities.some((entity) => (
              entity.entity_type === "sales_comparable_construction_method"
              && entity.parent_entity_id === dwelling.id
            ))) required += 1;
            if (!entities.some((entity) => (
              entity.entity_type === "sales_comparable_heating_system"
              && entity.parent_entity_id === dwelling.id
            ))) required += 1;
            if (
              dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingExists) === true
              && !entities.some((entity) => (
                entity.entity_type === "sales_comparable_cooling_system"
                && entity.parent_entity_id === dwelling.id
              ))
            ) required += 1;
            if (subjectMaintainsExterior && comparableMaintainsExterior) {
              required += 2;
              if (isPresent(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQuality))) completed += 1;
              if (isPresent(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorCondition))) completed += 1;
              const componentTypes = new Set(
                entities
                  .filter((entity) => entity.entity_type === "sales_comparable_exterior_component" && entity.parent_entity_id === dwelling.id)
                  .map((entity) => valueLookup(byKey, entity.id)(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType)),
              );
              for (const requiredType of ["ExteriorWallsAndTrim", "Foundation", "Roof", "Windows"]) {
                if (!componentTypes.has(requiredType)) required += 1;
              }
            }
          }
          const comparableStructureIds = new Set(comparableDwellings.map((dwelling) => dwelling.id));
          const comparableNonAduUnits = entities.filter((entity) => (
            entity.entity_type === "sales_comparable_unit"
            && comparableStructureIds.has(entity.parent_entity_id)
            && valueLookup(byKey, entity.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) === false
          ));
          for (const unit of comparableNonAduUnits) {
            const unitLookup = valueLookup(byKey, unit.id);
            required += 2;
            if (isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorQuality))) completed += 1;
            if (isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorCondition))) completed += 1;
            const kitchens = entities.filter((entity) => entity.entity_type === "sales_comparable_kitchen" && entity.parent_entity_id === unit.id);
            const componentTypes = new Set(
              entities
                .filter((entity) => entity.entity_type === "sales_comparable_interior_component" && entity.parent_entity_id === unit.id)
                .map((entity) => valueLookup(byKey, entity.id)(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType)),
            );
            if (!kitchens.length) required += 1;
            for (const requiredType of ["Flooring", "WallsAndCeiling"]) {
              if (!componentTypes.has(requiredType)) required += 1;
            }
            if (Number(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitFullBaths) || 0) + Number(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitHalfBaths) || 0) > 0) {
              required += 2;
              if (isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsQuality))) completed += 1;
              if (isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsUpdate))) completed += 1;
            }
          }
          for (const entityType of [
            "sales_comparable_site_hazard",
            "sales_comparable_site_influence",
            "sales_comparable_site_view",
          ]) {
            if (!entities.some((entity) => (
              entity.entity_type === entityType
              && entity.parent_entity_id === comparable.id
            ))) required += 1;
          }
        }
      }
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

export function validateCompleteSection(section, existingRows, submitted, entities, assets = []) {
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

  if (section === "subject") {
    const rootLookup = valueLookup(merged);
    if (
      rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.pud) === true
      && isPresent(rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure))
    ) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => (
        candidate.key === UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure
      ));
      errors.push(validationError(
        field,
        null,
        "project_classification_conflict",
        "A property cannot be classified as both a PUD and a condominium, cooperative, or condop.",
      ));
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

    const influences = entities.filter((entity) => entity.entity_type === "site_influence");
    const bodiesOfWater = entities.filter((entity) => entity.entity_type === "site_body_of_water");
    const waterfrontFeatures = entities.filter((entity) => entity.entity_type === "site_waterfront_feature");
    const influenceIds = new Set(influences.map((entity) => entity.id));
    const bodyIds = new Set(bodiesOfWater.map((entity) => entity.id));
    const siteField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    if (bodiesOfWater.some((body) => !influenceIds.has(body.parent_entity_id))) {
      errors.push(validationError(siteField("site_influence:1500.0073"), null, "site_body_of_water_orphaned", "Every body of water must be linked to a Site Influence."));
    }
    if (waterfrontFeatures.some((feature) => !bodyIds.has(feature.parent_entity_id))) {
      errors.push(validationError(siteField("site_influence:1500.0082"), null, "site_waterfront_feature_orphaned", "Every permanent waterfront feature must be linked to a body of water."));
    }

    let privateWaterAccessExists = false;
    for (const influence of influences) {
      const lookup = valueLookup(merged, influence.id);
      const influenceType = lookup("site_influence:1500.0087");
      const influenceBodies = bodiesOfWater.filter((body) => body.parent_entity_id === influence.id);
      const influenceFeatures = waterfrontFeatures.filter((feature) => (
        influenceBodies.some((body) => body.id === feature.parent_entity_id)
      ));
      const developmentRights = lookup("site_influence:1500.0092");
      const totalLength = lookup("site_influence:1500.0091");

      if (influenceType === "BodyOfWater" && !influenceBodies.length) {
        errors.push(validationError(siteField("site_influence:1500.0073"), influence.id, "site_body_of_water_required", "Add at least one body of water to every Body of Water influence."));
      }
      if (influenceType !== "BodyOfWater" && (influenceBodies.length || [developmentRights, totalLength].some(isPresent))) {
        errors.push(validationError(siteField("site_influence:1500.0087"), influence.id, "site_body_of_water_conflict", "Remove waterfront records and details or change Influence Type to Body of Water."));
      }

      const privateBodies = influenceBodies.filter((body) => (
        valueLookup(merged, body.id)("site_influence:1500.0075") === true
      ));
      if (privateBodies.length) {
        privateWaterAccessExists = true;
        if (!isPresent(totalLength)) {
          errors.push(validationError(siteField("site_influence:1500.0091"), influence.id, "site_water_frontage_total_length_required", "Provide total linear measurement when one or more bodies of water have private access."));
        }
      }

      for (const body of influenceBodies) {
        const bodyLookup = valueLookup(merged, body.id);
        const privateAccess = bodyLookup("site_influence:1500.0075");
        const bodyFeatures = waterfrontFeatures.filter((feature) => feature.parent_entity_id === body.id);
        const bodyType = bodyLookup("site_influence:1500.0073");
        const depth = bodyLookup("site_influence:1500.0197");
        const accessRights = bodyLookup("site_influence:1500.0079");
        if (bodyType !== "Other" && isPresent(bodyLookup("site_influence:1500.0074"))) {
          errors.push(validationError(siteField("site_influence:1500.0074"), body.id, "site_body_of_water_other_conflict", "Clear the other body-of-water description or select Other."));
        }
        if (depth !== "Other" && isPresent(bodyLookup("site_influence:1500.0198"))) {
          errors.push(validationError(siteField("site_influence:1500.0198"), body.id, "site_water_access_depth_other_conflict", "Clear the other access-depth description or select Other."));
        }
        if (accessRights !== "Other" && isPresent(bodyLookup("site_influence:1500.0080"))) {
          errors.push(validationError(siteField("site_influence:1500.0080"), body.id, "site_water_access_right_other_conflict", "Clear the other waterfront-access-right description or select Other."));
        }
        if (privateAccess !== true && [
          "site_influence:1500.0072",
          "site_influence:1500.0197",
          "site_influence:1500.0198",
          "site_influence:1500.0079",
          "site_influence:1500.0080",
        ].some((key) => isPresent(bodyLookup(key)))) {
          errors.push(validationError(siteField("site_influence:1500.0075"), body.id, "site_private_water_detail_conflict", "Clear private-water details or change Private Access to Yes."));
        }
        if (privateAccess !== true && bodyFeatures.length) {
          errors.push(validationError(siteField("site_influence:1500.0082"), body.id, "site_waterfront_feature_private_access_conflict", "Remove permanent waterfront features or change Private Access to Yes."));
        }
        const selections = bodyFeatures.map((feature) => valueLookup(merged, feature.id)("site_influence:1500.0082")).filter(isPresent);
        if (new Set(selections).size !== selections.length) {
          errors.push(validationError(siteField("site_influence:1500.0082"), body.id, "site_waterfront_feature_duplicate", "Each permanent waterfront feature may be selected only once for a body of water."));
        }
        if (selections.includes("None") && selections.length > 1) {
          errors.push(validationError(siteField("site_influence:1500.0082"), body.id, "site_waterfront_feature_none_conflict", "Select None by itself, or remove None before adding another permanent waterfront feature."));
        }
        for (const feature of bodyFeatures) {
          const featureLookup = valueLookup(merged, feature.id);
          if (featureLookup("site_influence:1500.0082") !== "Other" && isPresent(featureLookup("site_influence:1500.0083"))) {
            errors.push(validationError(siteField("site_influence:1500.0083"), feature.id, "site_waterfront_feature_other_conflict", "Clear the other waterfront-feature description or select Other."));
          }
        }
      }

      const featureSelections = influenceFeatures.map((feature) => valueLookup(merged, feature.id)("site_influence:1500.0082")).filter(isPresent);
      if (!privateBodies.length && (influenceFeatures.length || [developmentRights, totalLength].some(isPresent))) {
        errors.push(validationError(siteField("site_influence:1500.0075"), influence.id, "site_private_water_frontage_conflict", "Remove waterfront features, rights, and total frontage unless at least one body of water has private access."));
      }
      if (!featureSelections.includes("None") && isPresent(developmentRights)) {
        errors.push(validationError(siteField("site_influence:1500.0092"), influence.id, "site_waterfront_development_rights_conflict", "Clear Right to Build unless Permanent Waterfront Feature is None."));
      }
    }
    if (privateWaterAccessExists && !assets.some((asset) => isVerifiedSiteAsset(asset, "WaterFrontage"))) {
      errors.push(validationError(siteField("site_influence:1500.0075"), null, "site_water_frontage_photo_required", "Upload and verify a Water Frontage photo when the subject has private water access."));
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

  if (section === "overall_quality_condition") {
    const source = overallQualityConditionSources(merged, entities);
    const overallQualityField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.overallQuality
    ));
    const overallConditionField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.overallCondition
    ));

    if (!isPresent(source.homeownerMaintainsExterior)) {
      errors.push(validationError(
        overallQualityField,
        null,
        "overall_qc_exterior_responsibility_required",
        "Complete Homeowner Responsible for Exterior Maintenance in Section 3 before reconciling overall quality and condition.",
      ));
    }

    if (source.homeownerMaintainsExterior === true) {
      for (const dwelling of source.dwellings) {
        const lookup = valueLookup(merged, dwelling.id);
        if (!isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.exteriorQuality))) {
          errors.push(validationError(
            overallQualityField,
            dwelling.id,
            "overall_qc_exterior_quality_required",
            `Complete the Section 8 exterior quality rating for ${dwelling.label || `Dwelling ${dwelling.ordinal}`}.`,
          ));
        }
        if (!isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.exteriorCondition))) {
          errors.push(validationError(
            overallConditionField,
            dwelling.id,
            "overall_qc_exterior_condition_required",
            `Complete the Section 8 exterior condition rating for ${dwelling.label || `Dwelling ${dwelling.ordinal}`}.`,
          ));
        }
      }
    }

    for (const unit of source.units) {
      if (!isPresent(unit.accessoryDwellingUnit)) {
        errors.push(validationError(
          overallQualityField,
          unit.id,
          "overall_qc_adu_classification_required",
          `Complete the Section 10 accessory-dwelling-unit answer for ${unit.label || `Unit ${unit.ordinal}`}.`,
        ));
        continue;
      }
      if (unit.accessoryDwellingUnit === true) continue;
      const lookup = valueLookup(merged, unit.id);
      if (!isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.interiorQuality))) {
        errors.push(validationError(
          overallQualityField,
          unit.id,
          "overall_qc_interior_quality_required",
          `Complete the Section 10 interior quality rating for ${unit.label || `Unit ${unit.ordinal}`}.`,
        ));
      }
      if (!isPresent(lookup(UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS.interiorCondition))) {
        errors.push(validationError(
          overallConditionField,
          unit.id,
          "overall_qc_interior_condition_required",
          `Complete the Section 10 interior condition rating for ${unit.label || `Unit ${unit.ordinal}`}.`,
        ));
      }
    }
  }

  if (section === "highest_best_use") {
    const lookup = valueLookup(merged);
    const conclusionField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === UAD_HIGHEST_BEST_USE_FIELD_KEYS.presentUseIsHighestBest
    ));
    const fourTestAnswers = [
      UAD_HIGHEST_BEST_USE_FIELD_KEYS.legallyPermissible,
      UAD_HIGHEST_BEST_USE_FIELD_KEYS.physicallyPossible,
      UAD_HIGHEST_BEST_USE_FIELD_KEYS.financiallyFeasible,
      UAD_HIGHEST_BEST_USE_FIELD_KEYS.maximallyProductive,
    ].map((key) => lookup(key));
    if (
      lookup(UAD_HIGHEST_BEST_USE_FIELD_KEYS.presentUseIsHighestBest) === true
      && fourTestAnswers.some((value) => value === false)
    ) {
      errors.push(validationError(
        conclusionField,
        null,
        "highest_best_use_present_use_conflict",
        "The present or proposed use cannot be concluded as highest and best when it fails one of the four tests.",
      ));
    }
  }

  if (section === "market") {
    const lookup = valueLookup(merged);
    const priceTrendField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
      candidate.key === UAD_MARKET_FIELD_KEYS.priceTrendCommentary
    ));
    const sources = entities.filter((entity) => entity.entity_type === "market_price_trend_source");
    if (!sources.length) {
      const sourceField = UAD_PHASE_ONE_FIELDS.find((candidate) => (
        candidate.key === UAD_MARKET_FIELD_KEYS.priceTrendSource
      ));
      errors.push(validationError(
        sourceField,
        null,
        "market_price_trend_source_required",
        "Add at least one source used to determine the price trend.",
      ));
    }
    if (
      !assets.some((asset) => isVerifiedMarketAsset(asset, "PriceTrendGraph"))
      && !isPresent(lookup(UAD_MARKET_FIELD_KEYS.priceTrendCommentary))
    ) {
      errors.push(validationError(
        priceTrendField,
        null,
        "market_price_trend_commentary_required",
        "Provide price trend analysis commentary or upload and verify a Price Trend Graph.",
      ));
    }
    const validatePriceOrder = ({ countKey, lowKey, medianKey, highKey, code, message }) => {
      if (Number(lookup(countKey)) <= 0) return;
      const low = Number(lookup(lowKey));
      const median = Number(lookup(medianKey));
      const high = Number(lookup(highKey));
      if (![low, median, high].every(Number.isFinite) || low > median || median > high) {
        const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === medianKey);
        errors.push(validationError(field, null, code, message));
      }
    };
    validatePriceOrder({
      countKey: UAD_MARKET_FIELD_KEYS.activeListingCount,
      lowKey: UAD_MARKET_FIELD_KEYS.activeLowestPrice,
      medianKey: UAD_MARKET_FIELD_KEYS.activeMedianPrice,
      highKey: UAD_MARKET_FIELD_KEYS.activeHighestPrice,
      code: "market_active_price_order",
      message: "Active listing prices must be ordered from lowest to median to highest.",
    });
    validatePriceOrder({
      countKey: UAD_MARKET_FIELD_KEYS.salesCount,
      lowKey: UAD_MARKET_FIELD_KEYS.salesLowestPrice,
      medianKey: UAD_MARKET_FIELD_KEYS.salesMedianPrice,
      highKey: UAD_MARKET_FIELD_KEYS.salesHighestPrice,
      code: "market_sale_price_order",
      message: "Sale prices must be ordered from lowest to median to highest.",
    });
  }

  if (section === "project_information") {
    const lookup = valueLookup(merged);
    const projectField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    const pud = lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.pud) === true;
    const legalStructure = lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure);
    const applicable = pud || isPresent(legalStructure);
    const classificationField = projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure);
    if (!applicable) {
      errors.push(validationError(
        classificationField,
        null,
        "project_information_not_applicable",
        "Select PUD or a project legal structure in Subject Property before completing Project Information.",
      ));
    }
    if (pud && isPresent(legalStructure)) {
      errors.push(validationError(
        classificationField,
        null,
        "project_classification_conflict",
        "A property cannot be classified as both a PUD and a condominium, cooperative, or condop.",
      ));
    }

    const requireEntity = (entityType, fieldKey, code, message) => {
      if (!entities.some((entity) => entity.entity_type === entityType)) {
        errors.push(validationError(projectField(fieldKey), null, code, message));
      }
    };
    if (applicable) {
      requireEntity(
        "project_data_source",
        "project_data_source:0700.0125",
        "project_data_source_required",
        "Add at least one source used for the Project Information section.",
      );
      requireEntity(
        "project_amenity",
        UAD_PROJECT_INFORMATION_FIELD_KEYS.amenityType,
        "project_amenity_required",
        "Add the common amenities and services, or add one record and select None.",
      );
      requireEntity(
        "project_utility",
        UAD_PROJECT_INFORMATION_FIELD_KEYS.utilityType,
        "project_utility_required",
        "Add the utilities included in the mandatory monthly fees, or add one record and select None.",
      );
    }

    const validateNoneExclusivity = (entityType, fieldKey, code, label) => {
      const selected = entities
        .filter((entity) => entity.entity_type === entityType)
        .map((entity) => valueLookup(merged, entity.id)(fieldKey))
        .filter(isPresent);
      if (selected.includes("None") && selected.length > 1) {
        errors.push(validationError(
          projectField(fieldKey),
          null,
          code,
          `Select None by itself, or remove None before adding ${label}.`,
        ));
      }
      if (new Set(selected).size !== selected.length) {
        errors.push(validationError(
          projectField(fieldKey),
          null,
          `${code}_duplicate`,
          `Each ${label} may be selected only once.`,
        ));
      }
    };
    validateNoneExclusivity("project_amenity", UAD_PROJECT_INFORMATION_FIELD_KEYS.amenityType, "project_amenity_none_conflict", "common amenity or service");
    validateNoneExclusivity("project_utility", UAD_PROJECT_INFORMATION_FIELD_KEYS.utilityType, "project_utility_none_conflict", "included utility");

    if (isPresent(legalStructure)) {
      const totalUnits = Number(lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.totalUnits));
      for (const [key, label] of [
        [UAD_PROJECT_INFORMATION_FIELD_KEYS.unitsSold, "Units sold"],
        [UAD_PROJECT_INFORMATION_FIELD_KEYS.unitsForSale, "Units for sale"],
        [UAD_PROJECT_INFORMATION_FIELD_KEYS.unitsRented, "Units rented"],
      ]) {
        const count = Number(lookup(key));
        if (Number.isFinite(totalUnits) && Number.isFinite(count) && count > totalUnits) {
          errors.push(validationError(
            projectField(key),
            null,
            "project_unit_count_conflict",
            `${label} cannot exceed total project units.`,
          ));
        }
      }
    }

    const incompleteComponents = entities.filter((entity) => entity.entity_type === "project_incomplete_component");
    const projectComplete = lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectComplete);
    if (projectComplete === false && !incompleteComponents.length) {
      errors.push(validationError(
        projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectComplete),
        null,
        "project_incomplete_component_required",
        "Add at least one incomplete project element when the project is not complete.",
      ));
    }
    if (projectComplete === true && incompleteComponents.length) {
      errors.push(validationError(
        projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectComplete),
        null,
        "project_incomplete_component_conflict",
        "Remove incomplete project elements or change Project complete to No.",
      ));
    }

    const liens = entities
      .filter((entity) => entity.entity_type === "project_blanket_financing")
      .sort((left, right) => left.ordinal - right.ordinal);
    const blanketFinancing = lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.blanketFinancing);
    if (blanketFinancing === true && !liens.length) {
      errors.push(validationError(
        projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.blanketFinancing),
        null,
        "project_blanket_financing_lien_required",
        "Add at least one project blanket-financing lien.",
      ));
    }
    if (blanketFinancing === false && liens.length) {
      errors.push(validationError(
        projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.blanketFinancing),
        null,
        "project_blanket_financing_lien_conflict",
        "Remove project blanket-financing liens or change Project blanket financing to Yes.",
      ));
    }
    if (blanketFinancing === true) {
      const priorities = ["FirstLien", "SecondLien", "ThirdLien", "FourthLien"];
      liens.forEach((lien, index) => {
        const lienLookup = valueLookup(merged, lien.id);
        if (lienLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.lienPriority) !== priorities[index]) {
          errors.push(validationError(
            projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.lienPriority),
            lien.id,
            "project_lien_priority_order",
            `Lien ${index + 1} must use ${priorities[index]} so blanket financing is reported in lien-priority order.`,
          ));
        }
        if (lienLookup("project_blanket_financing:2500.0151") === true) {
          const maximum = Number(lienLookup("project_blanket_financing:2500.0153"));
          const drawn = Number(lienLookup("project_blanket_financing:2500.0155"));
          if (Number.isFinite(maximum) && Number.isFinite(drawn) && drawn > maximum) {
            errors.push(validationError(
              projectField("project_blanket_financing:2500.0155"),
              lien.id,
              "project_line_of_credit_balance_conflict",
              "The drawn line-of-credit amount cannot exceed its maximum amount.",
            ));
          }
        }
      });
    }

    if (
      lookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectDeficiencies) === true
      && !assets.some((asset) => isVerifiedProjectInformationAsset(asset, "ProjectDeficiency", null))
    ) {
      errors.push(validationError(
        projectField(UAD_PROJECT_INFORMATION_FIELD_KEYS.projectDeficiencies),
        null,
        "project_deficiency_asset_required",
        "Upload and verify a photo of the observed physical project deficiency.",
      ));
    }
  }

  if (section === "subject_listing_information") {
    const lookup = valueLookup(merged);
    const listingField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    const hasListings = lookup(UAD_SUBJECT_LISTING_FIELD_KEYS.relevantListings);
    const listings = entities
      .filter((entity) => entity.entity_type === "subject_listing")
      .sort((left, right) => left.ordinal - right.ordinal);
    const dataSources = entities.filter((entity) => entity.entity_type === "subject_listing_data_source");

    if (hasListings === true && !listings.length) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.listingStatus),
        null,
        "subject_listing_required",
        "Add at least one current or relevant listing.",
      ));
    }
    if (hasListings === true && dataSources.length) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.dataSource),
        null,
        "subject_listing_no_listing_source_conflict",
        "Remove the no-listing data sources or change Current or relevant listings to No.",
      ));
    }
    if (hasListings === false && !dataSources.length) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.dataSource),
        null,
        "subject_listing_data_source_required",
        "Add at least one data source used to determine that no current or relevant listings exist.",
      ));
    }
    if (hasListings === false && listings.length) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.relevantListings),
        null,
        "subject_listing_record_conflict",
        "Remove the saved listing records or change Current or relevant listings to Yes.",
      ));
    }

    const selectedSources = dataSources
      .map((entity) => valueLookup(merged, entity.id)(UAD_SUBJECT_LISTING_FIELD_KEYS.dataSource))
      .filter(isPresent);
    if (new Set(selectedSources).size !== selectedSources.length) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.dataSource),
        null,
        "subject_listing_data_source_duplicate",
        "Each no-listing data source may be selected only once.",
      ));
    }

    const listingIdentifiers = new Set();
    let totalDaysOnMarket = 0;
    for (const listing of listings) {
      const entityLookup = valueLookup(merged, listing.id);
      const identifier = String(entityLookup(UAD_SUBJECT_LISTING_FIELD_KEYS.listingId) || "").trim().toLowerCase();
      if (identifier) {
        if (listingIdentifiers.has(identifier)) {
          errors.push(validationError(
            listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.listingId),
            listing.id,
            "subject_listing_identifier_duplicate",
            "Listing IDs must be unique within the subject listing history.",
          ));
        }
        listingIdentifiers.add(identifier);
      }

      const startDate = entityLookup(UAD_SUBJECT_LISTING_FIELD_KEYS.listingStartDate);
      const endDate = entityLookup(UAD_SUBJECT_LISTING_FIELD_KEYS.listingEndDate);
      const daysOnMarket = Number(entityLookup(UAD_SUBJECT_LISTING_FIELD_KEYS.daysOnMarket));
      if (Number.isFinite(daysOnMarket)) totalDaysOnMarket += daysOnMarket;
      if (isPresent(startDate) && isPresent(endDate)) {
        if (String(startDate) > String(endDate)) {
          errors.push(validationError(
            listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.listingStartDate),
            listing.id,
            "subject_listing_date_order",
            "The listing start date cannot be after the listing end date.",
          ));
        } else {
          const calculatedDays = Math.round(
            (Date.parse(String(endDate)) - Date.parse(String(startDate))) / 86_400_000,
          ) + 1;
          if (Number.isFinite(daysOnMarket) && calculatedDays !== daysOnMarket) {
            errors.push(validationError(
              listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.daysOnMarket),
              listing.id,
              "subject_listing_dom_date_conflict",
              `Days on market must equal ${calculatedDays} for the provided start and end dates.`,
            ));
          }
        }
      }
    }

    if (
      hasListings === true
      && listings.length
      && Number(lookup(UAD_SUBJECT_LISTING_FIELD_KEYS.totalDaysOnMarket)) !== totalDaysOnMarket
    ) {
      errors.push(validationError(
        listingField(UAD_SUBJECT_LISTING_FIELD_KEYS.totalDaysOnMarket),
        null,
        "subject_listing_total_dom_conflict",
        `Total days on market must equal the ${totalDaysOnMarket} days reported across the listing rows.`,
      ));
    }
  }

  if (section === "sales_contract") {
    const lookup = valueLookup(merged);
    const contractField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    const exists = lookup(UAD_SALES_CONTRACT_FIELD_KEYS.exists);
    const reviewed = lookup(UAD_SALES_CONTRACT_FIELD_KEYS.reviewed);
    const concessions = lookup(UAD_SALES_CONTRACT_FIELD_KEYS.concessions);
    const concessionAmountKnown = lookup(UAD_SALES_CONTRACT_FIELD_KEYS.concessionAmountKnown);
    const detailKeys = Object.values(UAD_SALES_CONTRACT_FIELD_KEYS).filter((key) => ![
      UAD_SALES_CONTRACT_FIELD_KEYS.exists,
      UAD_SALES_CONTRACT_FIELD_KEYS.appraisalEffectiveDate,
    ].includes(key));
    const reviewedDetailKeys = [
      UAD_SALES_CONTRACT_FIELD_KEYS.contractPrice,
      UAD_SALES_CONTRACT_FIELD_KEYS.contractDate,
      UAD_SALES_CONTRACT_FIELD_KEYS.transferTerms,
      UAD_SALES_CONTRACT_FIELD_KEYS.personalProperty,
      UAD_SALES_CONTRACT_FIELD_KEYS.concessions,
      UAD_SALES_CONTRACT_FIELD_KEYS.concessionAmountKnown,
      UAD_SALES_CONTRACT_FIELD_KEYS.totalConcessions,
      UAD_SALES_CONTRACT_FIELD_KEYS.typicalConcessions,
    ];

    if (exists === false && detailKeys.some((key) => isPresent(lookup(key)))) {
      errors.push(validationError(
        contractField(UAD_SALES_CONTRACT_FIELD_KEYS.exists),
        null,
        "sales_contract_absent_detail_conflict",
        "Clear the saved sales contract details before changing Is there a sales contract to No.",
      ));
    }
    if (exists === false && assets.some((asset) => isVerifiedSalesContractAsset(asset))) {
      errors.push(validationError(
        contractField(UAD_SALES_CONTRACT_FIELD_KEYS.exists),
        null,
        "sales_contract_asset_conflict",
        "Remove the verified Sales Contract exhibits before changing Is there a sales contract to No.",
      ));
    }
    if (exists === true && reviewed === false && reviewedDetailKeys.some((key) => isPresent(lookup(key)))) {
      errors.push(validationError(
        contractField(UAD_SALES_CONTRACT_FIELD_KEYS.reviewed),
        null,
        "sales_contract_unreviewed_detail_conflict",
        "Clear the discrete contract terms and report any transaction details learned through other sources in Sales Contract Analysis.",
      ));
    }
    if (
      concessions === false
      && [
        UAD_SALES_CONTRACT_FIELD_KEYS.concessionAmountKnown,
        UAD_SALES_CONTRACT_FIELD_KEYS.totalConcessions,
        UAD_SALES_CONTRACT_FIELD_KEYS.typicalConcessions,
      ].some((key) => isPresent(lookup(key)))
    ) {
      errors.push(validationError(
        contractField(UAD_SALES_CONTRACT_FIELD_KEYS.concessions),
        null,
        "sales_contract_concession_detail_conflict",
        "Clear the concession amount details or change Known sales concessions to Yes.",
      ));
    }
    if (
      concessionAmountKnown === false
      && [
        UAD_SALES_CONTRACT_FIELD_KEYS.totalConcessions,
        UAD_SALES_CONTRACT_FIELD_KEYS.typicalConcessions,
      ].some((key) => isPresent(lookup(key)))
    ) {
      errors.push(validationError(
        contractField(UAD_SALES_CONTRACT_FIELD_KEYS.concessionAmountKnown),
        null,
        "sales_contract_known_amount_conflict",
        "Clear the total and market-typical answers or change Total sales concessions known to Yes.",
      ));
    }
  }

  if (section === "prior_sale_transfer_history") {
    const rootLookup = valueLookup(merged);
    const priorField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    const subjectHasTransfers = rootLookup(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectHasTransfers);
    const subjectTransfers = entities.filter((entity) => entity.entity_type === "subject_prior_transfer");
    const subjectNoTransferSources = entities.filter((entity) => entity.entity_type === "subject_no_prior_transfer_data_source");
    const subjectTransferSources = entities.filter((entity) => entity.entity_type === "subject_prior_transfer_data_source");
    const salesComparables = entities.filter((entity) => entity.entity_type === "sales_comparable");
    const comparableNoTransferSources = entities.filter((entity) => entity.entity_type === "comparable_no_prior_transfer_data_source");
    const comparableTransfers = entities.filter((entity) => entity.entity_type === "comparable_prior_transfer");
    const comparableTransferSources = entities.filter((entity) => entity.entity_type === "comparable_prior_transfer_data_source");

    const duplicateSourceErrors = (sourceEntities, fieldKey, entityId, code, message) => {
      const selected = sourceEntities
        .map((entity) => valueLookup(merged, entity.id)(fieldKey))
        .filter(isPresent);
      if (new Set(selected).size !== selected.length) {
        errors.push(validationError(priorField(fieldKey), entityId, code, message));
      }
    };

    const validateTransfer = ({
      transfer,
      sources,
      transactionTypeKey,
      saleTypeKey,
      saleTypeOtherKey,
      amountKey,
      unavailableKey,
      unavailableOtherKey,
      sourceKey,
      prefix,
      ownerLabel,
    }) => {
      const transferLookup = valueLookup(merged, transfer.id);
      const amount = transferLookup(amountKey);
      const unavailable = transferLookup(unavailableKey);
      const transactionType = transferLookup(transactionTypeKey);
      if (isPresent(amount) === isPresent(unavailable)) {
        errors.push(validationError(
          priorField(amountKey),
          transfer.id,
          `${prefix}_amount_choice_required`,
          `Provide either the ${ownerLabel} transfer amount or one reason it is unavailable, but not both.`,
        ));
      }
      if (
        transactionType !== "Sale"
        && [saleTypeKey, saleTypeOtherKey].some((key) => isPresent(transferLookup(key)))
      ) {
        errors.push(validationError(
          priorField(transactionTypeKey),
          transfer.id,
          `${prefix}_deed_sale_type_conflict`,
          `Clear the prior sale type because this ${ownerLabel} record is a deed transfer only.`,
        ));
      }
      if (unavailable !== "Other" && isPresent(transferLookup(unavailableOtherKey))) {
        errors.push(validationError(
          priorField(unavailableKey),
          transfer.id,
          `${prefix}_amount_reason_other_conflict`,
          `Clear the other amount-unavailable description or select Other for this ${ownerLabel} transfer.`,
        ));
      }
      if (!sources.length) {
        errors.push(validationError(
          priorField(sourceKey),
          transfer.id,
          `${prefix}_data_source_required`,
          `Add at least one data source for this ${ownerLabel} prior sale or transfer.`,
        ));
      }
      duplicateSourceErrors(
        sources,
        sourceKey,
        transfer.id,
        `${prefix}_data_source_duplicate`,
        `Each data source may be selected only once for a given ${ownerLabel} transfer.`,
      );
    };

    if (subjectHasTransfers === true && !subjectTransfers.length) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectTransactionType),
        null,
        "subject_prior_transfer_required",
        "Add at least one subject prior sale or transfer.",
      ));
    }
    if (subjectHasTransfers === true && subjectNoTransferSources.length) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectNoTransferDataSource),
        null,
        "subject_prior_transfer_no_source_conflict",
        "Remove the no-transfer data sources or change Prior sales or transfers to No.",
      ));
    }
    if (subjectHasTransfers === false && !subjectNoTransferSources.length) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectNoTransferDataSource),
        null,
        "subject_no_prior_transfer_data_source_required",
        "Add at least one data source used to determine that the subject has no prior sale or transfer.",
      ));
    }
    if (subjectHasTransfers === false && subjectTransfers.length) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectHasTransfers),
        null,
        "subject_prior_transfer_record_conflict",
        "Remove the saved subject transfer records or change Prior sales or transfers to Yes.",
      ));
    }
    duplicateSourceErrors(
      subjectNoTransferSources,
      UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectNoTransferDataSource,
      null,
      "subject_no_prior_transfer_data_source_duplicate",
      "Each no-transfer subject data source may be selected only once.",
    );

    const subjectTransferIds = new Set(subjectTransfers.map((entity) => entity.id));
    if (subjectTransferSources.some((entity) => !subjectTransferIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectTransferDataSource),
        null,
        "subject_prior_transfer_data_source_orphaned",
        "Every subject transfer data source must be linked to a subject prior sale or transfer.",
      ));
    }
    for (const transfer of subjectTransfers) {
      validateTransfer({
        transfer,
        sources: subjectTransferSources.filter((source) => source.parent_entity_id === transfer.id),
        transactionTypeKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectTransactionType,
        saleTypeKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectSaleType,
        saleTypeOtherKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectSaleTypeOther,
        amountKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectAmount,
        unavailableKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectAmountUnavailable,
        unavailableOtherKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectAmountUnavailableOther,
        sourceKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.subjectTransferDataSource,
        prefix: "subject_prior_transfer",
        ownerLabel: "subject",
      });
    }

    const comparableOrdinals = new Set();
    for (const comparable of salesComparables) {
      const comparableLookup = valueLookup(merged, comparable.id);
      const ordinal = comparableLookup(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableOrdinal);
      if (isPresent(ordinal)) {
        if (comparableOrdinals.has(ordinal)) {
          errors.push(validationError(
            priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableOrdinal),
            comparable.id,
            "comparable_ordinal_duplicate",
            "Comparable numbers must be unique.",
          ));
        }
        comparableOrdinals.add(ordinal);
      }
      const hasTransfers = comparableLookup(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableHasTransfers);
      const transfers = comparableTransfers.filter((entity) => entity.parent_entity_id === comparable.id);
      const noTransferSources = comparableNoTransferSources.filter((entity) => entity.parent_entity_id === comparable.id);
      if (hasTransfers === true && !transfers.length) {
        errors.push(validationError(
          priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableTransactionType),
          comparable.id,
          "comparable_prior_transfer_required",
          "Add at least one prior sale or transfer for this comparable.",
        ));
      }
      if (hasTransfers === true && noTransferSources.length) {
        errors.push(validationError(
          priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableNoTransferDataSource),
          comparable.id,
          "comparable_prior_transfer_no_source_conflict",
          "Remove this comparable's no-transfer data sources or change its prior-transfer answer to No.",
        ));
      }
      if (hasTransfers === false && !noTransferSources.length) {
        errors.push(validationError(
          priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableNoTransferDataSource),
          comparable.id,
          "comparable_no_prior_transfer_data_source_required",
          "Add at least one data source used to determine that this comparable has no prior sale or transfer.",
        ));
      }
      if (hasTransfers === false && transfers.length) {
        errors.push(validationError(
          priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableHasTransfers),
          comparable.id,
          "comparable_prior_transfer_record_conflict",
          "Remove this comparable's saved transfer records or change its prior-transfer answer to Yes.",
        ));
      }
      duplicateSourceErrors(
        noTransferSources,
        UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableNoTransferDataSource,
        comparable.id,
        "comparable_no_prior_transfer_data_source_duplicate",
        "Each no-transfer comparable data source may be selected only once.",
      );
    }

    const comparableTransferIds = new Set(comparableTransfers.map((entity) => entity.id));
    const salesComparableIds = new Set(salesComparables.map((entity) => entity.id));
    if (comparableNoTransferSources.some((entity) => !salesComparableIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableNoTransferDataSource),
        null,
        "comparable_no_prior_transfer_data_source_orphaned",
        "Every comparable no-transfer data source must be linked to a sales comparable.",
      ));
    }
    if (comparableTransfers.some((entity) => !salesComparableIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableTransactionType),
        null,
        "comparable_prior_transfer_orphaned",
        "Every comparable prior sale or transfer must be linked to a sales comparable.",
      ));
    }
    if (comparableTransferSources.some((entity) => !comparableTransferIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        priorField(UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableTransferDataSource),
        null,
        "comparable_prior_transfer_data_source_orphaned",
        "Every comparable transfer data source must be linked to a comparable prior sale or transfer.",
      ));
    }
    for (const transfer of comparableTransfers) {
      validateTransfer({
        transfer,
        sources: comparableTransferSources.filter((source) => source.parent_entity_id === transfer.id),
        transactionTypeKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableTransactionType,
        saleTypeKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableSaleType,
        saleTypeOtherKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableSaleTypeOther,
        amountKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableAmount,
        unavailableKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableAmountUnavailable,
        unavailableOtherKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableAmountUnavailableOther,
        sourceKey: UAD_PRIOR_TRANSFER_FIELD_KEYS.comparableTransferDataSource,
        prefix: "comparable_prior_transfer",
        ownerLabel: "comparable",
      });
    }
  }

  if (section === "sales_comparison") {
    const rootLookup = valueLookup(merged);
    const salesField = (key) => UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === key);
    const included = rootLookup(UAD_SALES_COMPARISON_FIELD_KEYS.included);
    const comparables = entities.filter((entity) => entity.entity_type === "sales_comparable");
    const sources = entities.filter((entity) => entity.entity_type === "sales_comparable_data_source");
    const rights = entities.filter((entity) => entity.entity_type === "sales_comparable_right_not_included");
    const projectAmenities = entities.filter((entity) => entity.entity_type === "sales_comparable_project_amenity");
    const comparableBodiesOfWater = entities.filter((entity) => entity.entity_type === "sales_comparable_body_of_water");
    const comparableWaterfrontFeatures = entities.filter((entity) => entity.entity_type === "sales_comparable_waterfront_feature");
    const comparableDwellings = entities.filter((entity) => entity.entity_type === "sales_comparable_dwelling");
    const comparableConstructionMethods = entities.filter((entity) => entity.entity_type === "sales_comparable_construction_method");
    const comparableHeatingSystems = entities.filter((entity) => entity.entity_type === "sales_comparable_heating_system");
    const comparableCoolingSystems = entities.filter((entity) => entity.entity_type === "sales_comparable_cooling_system");
    const comparableFunctionalIssues = entities.filter((entity) => entity.entity_type === "sales_comparable_functional_issue");
    const comparableDisasterMitigation = entities.filter((entity) => entity.entity_type === "sales_comparable_disaster_mitigation");
    const comparableRenewableEnergyComponents = entities.filter((entity) => entity.entity_type === "sales_comparable_renewable_energy_component");
    const comparableGreenCertifications = entities.filter((entity) => entity.entity_type === "sales_comparable_green_certification");
    const comparableEfficiencyRatings = entities.filter((entity) => entity.entity_type === "sales_comparable_efficiency_rating");
    const comparableOutbuildings = entities.filter((entity) => entity.entity_type === "sales_comparable_outbuilding");
    const comparableUnits = entities.filter((entity) => entity.entity_type === "sales_comparable_unit");
    const comparableUnitAccessibility = entities.filter((entity) => entity.entity_type === "sales_comparable_unit_accessibility_feature");
    const comparableExteriorComponents = entities.filter((entity) => entity.entity_type === "sales_comparable_exterior_component");
    const comparableKitchens = entities.filter((entity) => entity.entity_type === "sales_comparable_kitchen");
    const comparableInteriorComponents = entities.filter((entity) => entity.entity_type === "sales_comparable_interior_component");
    const subjectExteriorFeatures = entities.filter((entity) => entity.entity_type === "dwelling_exterior_feature");
    const subjectExteriorSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_exterior_quality_summary");
    const subjectUnits = entities.filter((entity) => entity.entity_type === "unit");
    const subjectRooms = entities.filter((entity) => entity.entity_type === "unit_room");
    const subjectInteriorFeatures = entities.filter((entity) => entity.entity_type === "unit_interior_feature");
    const subjectUnitInteriorSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_unit_interior_summary");
    const subjectKitchenSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_kitchen_summary");
    const subjectInteriorQualitySummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_interior_quality_summary");
    const subjectInteriorConditionSummaries = entities.filter((entity) => entity.entity_type === "sales_comparison_subject_interior_condition_summary");
    const comparableSiteChildTypes = new Set([
      "sales_comparable_site_hazard",
      "sales_comparable_site_street",
      "sales_comparable_site_restriction",
      "sales_comparable_site_easement",
      "sales_comparable_site_feature",
      "sales_comparable_site_influence",
      "sales_comparable_site_environmental",
      "sales_comparable_site_view",
    ]);
    const comparableSiteChildren = entities.filter((entity) => comparableSiteChildTypes.has(entity.entity_type));
    const comparableIds = new Set(comparables.map((entity) => entity.id));
    const comparableInfluenceIds = new Set(
      comparableSiteChildren
        .filter((entity) => entity.entity_type === "sales_comparable_site_influence")
        .map((entity) => entity.id),
    );
    const comparableBodyOfWaterIds = new Set(comparableBodiesOfWater.map((entity) => entity.id));
    const comparableDwellingIds = new Set(comparableDwellings.map((entity) => entity.id));
    const comparableOutbuildingIds = new Set(comparableOutbuildings.map((entity) => entity.id));
    const comparableStructureIds = new Set([...comparableDwellingIds, ...comparableOutbuildingIds]);
    const comparableUnitIds = new Set(comparableUnits.map((entity) => entity.id));
    const subjectExteriorFeatureIds = new Set(subjectExteriorFeatures.map((entity) => entity.id));
    const subjectUnitIds = new Set(subjectUnits.map((entity) => entity.id));
    const subjectRoomIds = new Set(subjectRooms.map((entity) => entity.id));
    const subjectInteriorFeatureIds = new Set(subjectInteriorFeatures.map((entity) => entity.id));

    if (included === true && !comparables.length) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.included),
        null,
        "sales_comparable_required",
        "Add at least one sales comparable when the Sales Comparison Approach is developed.",
      ));
    }
    if (included === false && comparables.length) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.included),
        null,
        "sales_comparable_scope_conflict",
        "Remove the saved sales comparables or change Sales Comparison Approach developed by appraiser to Yes.",
      ));
    }
    if (sources.some((source) => !comparableIds.has(source.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dataSourceType),
        null,
        "sales_comparable_data_source_orphaned",
        "Every comparable data source must be linked to a sales comparable.",
      ));
    }
    if (rights.some((right) => !comparableIds.has(right.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.rightNotIncluded),
        null,
        "sales_comparable_right_orphaned",
        "Every excluded property right must be linked to a sales comparable.",
      ));
    }
    if (projectAmenities.some((amenity) => !comparableIds.has(amenity.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity),
        null,
        "sales_comparable_project_amenity_orphaned",
        "Every comparable project amenity must be linked to a sales comparable.",
      ));
    }
    if (comparableSiteChildren.some((entity) => !comparableIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence),
        null,
        "sales_comparable_site_child_orphaned",
        "Every comparable site record must be linked to a sales comparable.",
      ));
    }
    if (comparableBodiesOfWater.some((body) => !comparableInfluenceIds.has(body.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWater),
        null,
        "sales_comparable_body_of_water_orphaned",
        "Every comparable body of water must be linked to a comparable Body of Water influence.",
      ));
    }
    if (comparableWaterfrontFeatures.some((feature) => !comparableBodyOfWaterIds.has(feature.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature),
        null,
        "sales_comparable_waterfront_feature_orphaned",
        "Every permanent waterfront feature must be linked to a comparable body of water.",
      ));
    }
    if (comparableDwellings.some((dwelling) => !comparableIds.has(dwelling.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingYearBuilt),
        null,
        "sales_comparable_dwelling_orphaned",
        "Every comparable dwelling must be linked to a sales comparable.",
      ));
    }
    if (comparableOutbuildings.some((outbuilding) => !comparableIds.has(outbuilding.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingType),
        null,
        "sales_comparable_outbuilding_orphaned",
        "Every comparable outbuilding must be linked to a sales comparable.",
      ));
    }
    if (comparableUnits.some((unit) => !comparableStructureIds.has(unit.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIdentifier),
        null,
        "sales_comparable_unit_orphaned",
        "Every comparable unit must be linked to a comparable dwelling or outbuilding.",
      ));
    }
    if (comparableUnitAccessibility.some((feature) => !comparableUnitIds.has(feature.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibility),
        null,
        "sales_comparable_unit_accessibility_orphaned",
        "Every comparable accessibility feature must be linked to a comparable unit.",
      ));
    }
    if (comparableExteriorComponents.some((component) => !comparableDwellingIds.has(component.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType),
        null,
        "sales_comparable_exterior_component_orphaned",
        "Every comparable exterior component must be linked to a comparable dwelling.",
      ));
    }
    if (subjectExteriorSummaries.some((summary) => !subjectExteriorFeatureIds.has(summary.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectExteriorQualitySummary),
        null,
        "sales_comparison_subject_exterior_summary_orphaned",
        "Every subject exterior quality summary must be linked to a subject Windows or Other exterior feature.",
      ));
    }
    if (comparableKitchens.some((kitchen) => !comparableUnitIds.has(kitchen.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.kitchenType),
        null,
        "sales_comparable_kitchen_orphaned",
        "Every comparable kitchen comparison record must be linked to a comparable unit.",
      ));
    }
    if (comparableInteriorComponents.some((component) => !comparableUnitIds.has(component.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType),
        null,
        "sales_comparable_interior_component_orphaned",
        "Every comparable interior component must be linked to a comparable unit.",
      ));
    }
    const subjectInteriorSummaryFamilies = [
      [subjectUnitInteriorSummaries, subjectUnitIds, UAD_SALES_COMPARISON_FIELD_KEYS.subjectOverallBathroomsQuality, "unit interior"],
      [subjectKitchenSummaries, subjectRoomIds, UAD_SALES_COMPARISON_FIELD_KEYS.subjectKitchenQualitySummary, "kitchen"],
      [subjectInteriorQualitySummaries, subjectInteriorFeatureIds, UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorQualitySummary, "interior quality"],
      [subjectInteriorConditionSummaries, subjectInteriorFeatureIds, UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorConditionSummary, "interior condition"],
    ];
    for (const [summaries, parentIds, key, label] of subjectInteriorSummaryFamilies) {
      if (summaries.some((summary) => !parentIds.has(summary.parent_entity_id))) {
        errors.push(validationError(
          salesField(key),
          null,
          `sales_comparison_subject_${label.replaceAll(" ", "_")}_summary_orphaned`,
          `Every subject ${label} summary must be linked to its canonical Section 10 record.`,
        ));
      }
    }

    const subjectMaintainsExterior = rootLookup("subject:0100.0046") === true;
    const subjectExteriorComparisonFeatures = subjectExteriorFeatures.filter((feature) => (
      ["Windows", "Other"].includes(valueLookup(merged, feature.id)("dwelling_exterior_feature:0300.0055"))
    ));
    const subjectExteriorComparisonFeatureIds = new Set(subjectExteriorComparisonFeatures.map((feature) => feature.id));
    if (subjectExteriorSummaries.some((summary) => !subjectExteriorComparisonFeatureIds.has(summary.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectExteriorQualitySummary),
        null,
        "sales_comparison_subject_exterior_summary_parent_invalid",
        "A subject exterior quality summary may be linked only to a Windows or Other exterior feature.",
      ));
    }
    const subjectOtherExteriorLabels = new Set(
      subjectExteriorComparisonFeatures
        .filter((feature) => valueLookup(merged, feature.id)("dwelling_exterior_feature:0300.0055") === "Other")
        .map((feature) => String(valueLookup(merged, feature.id)("dwelling_exterior_feature:0300.0056") || "").trim())
        .filter(Boolean),
    );
    if (included === true && subjectMaintainsExterior) {
      if (!subjectExteriorComparisonFeatures.some((feature) => valueLookup(merged, feature.id)("dwelling_exterior_feature:0300.0055") === "Windows")) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectExteriorQualitySummary),
          null,
          "sales_comparison_subject_windows_feature_required",
          "Complete the required subject Windows exterior feature in Section 8 before completing the exterior comparison.",
        ));
      }
      for (const feature of subjectExteriorComparisonFeatures) {
        const summaries = subjectExteriorSummaries.filter((summary) => summary.parent_entity_id === feature.id);
        if (summaries.length !== 1) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectExteriorQualitySummary),
            feature.id,
            summaries.length ? "sales_comparison_subject_exterior_summary_duplicate" : "sales_comparison_subject_exterior_summary_required",
            summaries.length
              ? "Keep exactly one Section 22 quality summary for this subject exterior feature."
              : "Add the Section 22 quality summary for this subject Windows or Other exterior feature.",
          ));
        }
      }
    } else if (subjectExteriorSummaries.length) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectExteriorQualitySummary),
        null,
        "sales_comparison_subject_exterior_summary_conflict",
        "Remove subject exterior comparison summaries unless the Sales Comparison Approach is developed and the subject homeowner maintains all dwelling exteriors.",
      ));
    }

    const subjectNonAduUnitIds = new Set(
      subjectUnits
        .filter((unit) => valueLookup(merged, unit.id)("unit:0700.0089") === false)
        .map((unit) => unit.id),
    );
    const subjectNonAduKitchens = subjectRooms.filter((room) => (
      subjectNonAduUnitIds.has(room.parent_entity_id)
      && valueLookup(merged, room.id)("unit_room:0700.0035") === "Kitchen"
    ));
    const subjectNonAduInteriorFeatures = subjectInteriorFeatures.filter((feature) => (
      subjectNonAduUnitIds.has(feature.parent_entity_id)
    ));
    const subjectOtherInteriorLabels = new Set(
      subjectNonAduInteriorFeatures
        .filter((feature) => valueLookup(merged, feature.id)("unit_interior_feature:0700.0046") === "Other")
        .map((feature) => String(valueLookup(merged, feature.id)("unit_interior_feature:0700.0047") || "").trim())
        .filter(Boolean),
    );
    const subjectKitchenIds = new Set(subjectRooms
      .filter((room) => valueLookup(merged, room.id)("unit_room:0700.0035") === "Kitchen")
      .map((room) => room.id));
    const subjectQualityFeatureIds = new Set(subjectInteriorFeatures
      .filter((feature) => ["Flooring", "WallsAndCeiling", "Other"].includes(
        valueLookup(merged, feature.id)("unit_interior_feature:0700.0046"),
      ))
      .map((feature) => feature.id));
    const subjectConditionFeatureIds = new Set(subjectInteriorFeatures
      .filter((feature) => ["WallsAndCeiling", "Other"].includes(
        valueLookup(merged, feature.id)("unit_interior_feature:0700.0046"),
      ))
      .map((feature) => feature.id));
    if (subjectKitchenSummaries.some((summary) => !subjectKitchenIds.has(summary.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectKitchenQualitySummary),
        null,
        "sales_comparison_subject_kitchen_summary_parent_invalid",
        "A subject kitchen quality summary may be linked only to a canonical Section 10 Kitchen room.",
      ));
    }
    if (subjectInteriorQualitySummaries.some((summary) => !subjectQualityFeatureIds.has(summary.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorQualitySummary),
        null,
        "sales_comparison_subject_interior_quality_summary_parent_invalid",
        "A subject interior quality summary may be linked only to a Flooring, Walls and Ceiling, or Other Section 10 feature.",
      ));
    }
    if (subjectInteriorConditionSummaries.some((summary) => !subjectConditionFeatureIds.has(summary.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorConditionSummary),
        null,
        "sales_comparison_subject_interior_condition_summary_parent_invalid",
        "A subject interior condition summary may be linked only to a Walls and Ceiling or Other Section 10 feature.",
      ));
    }
    const requireOneSubjectSummary = (records, parent, key, code, label) => {
      const matches = records.filter((record) => record.parent_entity_id === parent.id);
      if (matches.length !== 1) {
        errors.push(validationError(
          salesField(key),
          parent.id,
          matches.length ? `${code}_duplicate` : `${code}_required`,
          matches.length ? `Keep exactly one ${label}.` : `Add the ${label}.`,
        ));
      }
    };
    const allSubjectInteriorSummaries = [
      ...subjectUnitInteriorSummaries,
      ...subjectKitchenSummaries,
      ...subjectInteriorQualitySummaries,
      ...subjectInteriorConditionSummaries,
    ];
    if (included === true) {
      for (const unit of subjectUnits.filter((entity) => subjectNonAduUnitIds.has(entity.id))) {
        const unitLookup = valueLookup(merged, unit.id);
        if (Number(unitLookup("unit:0700.0119") || 0) + Number(unitLookup("unit:0700.0120") || 0) > 0) {
          requireOneSubjectSummary(
            subjectUnitInteriorSummaries,
            unit,
            UAD_SALES_COMPARISON_FIELD_KEYS.subjectOverallBathroomsQuality,
            "sales_comparison_subject_bathrooms_quality_summary",
            "Section 22 overall bathrooms quality summary for this non-ADU subject unit",
          );
        }
      }
      for (const kitchen of subjectNonAduKitchens) {
        requireOneSubjectSummary(
          subjectKitchenSummaries,
          kitchen,
          UAD_SALES_COMPARISON_FIELD_KEYS.subjectKitchenQualitySummary,
          "sales_comparison_subject_kitchen_quality_summary",
          "Section 22 kitchen quality summary for this subject kitchen",
        );
      }
      for (const feature of subjectNonAduInteriorFeatures) {
        const featureType = valueLookup(merged, feature.id)("unit_interior_feature:0700.0046");
        if (["Flooring", "WallsAndCeiling", "Other"].includes(featureType)) {
          requireOneSubjectSummary(
            subjectInteriorQualitySummaries,
            feature,
            UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorQualitySummary,
            "sales_comparison_subject_interior_quality_summary",
            `Section 22 quality summary for this ${featureType} subject feature`,
          );
        }
        if (["WallsAndCeiling", "Other"].includes(featureType)) {
          requireOneSubjectSummary(
            subjectInteriorConditionSummaries,
            feature,
            UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorConditionSummary,
            "sales_comparison_subject_interior_condition_summary",
            `Section 22 condition summary for this ${featureType} subject feature`,
          );
        }
      }
    } else if (allSubjectInteriorSummaries.length) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.subjectInteriorQualitySummary),
        null,
        "sales_comparison_subject_interior_summary_conflict",
        "Remove subject interior comparison summaries unless the Sales Comparison Approach is developed.",
      ));
    }
    if ([...comparableConstructionMethods, ...comparableHeatingSystems, ...comparableCoolingSystems]
      .some((entity) => !comparableDwellingIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod),
        null,
        "sales_comparable_dwelling_child_orphaned",
        "Every comparable construction, heating, and cooling record must be linked to a comparable dwelling.",
      ));
    }
    if ([...comparableFunctionalIssues, ...comparableDisasterMitigation]
      .some((entity) => !comparableIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingFunctionalIssue),
        null,
        "sales_comparable_dwelling_property_child_orphaned",
        "Every comparable functional-issue and disaster-mitigation record must be linked to a sales comparable.",
      ));
    }
    if ([
      ...comparableRenewableEnergyComponents,
      ...comparableGreenCertifications,
      ...comparableEfficiencyRatings,
    ].some((entity) => !comparableIds.has(entity.parent_entity_id))) {
      errors.push(validationError(
        salesField(UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyExists),
        null,
        "sales_comparable_energy_green_child_orphaned",
        "Every comparable renewable component, building certification, and efficiency rating must be linked to a sales comparable.",
      ));
    }

    const ordinals = new Set();
    for (const comparable of comparables) {
      const lookup = valueLookup(merged, comparable.id);
      const ordinal = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.ordinal) ?? comparable.ordinal;
      if (ordinals.has(ordinal)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.ordinal),
          comparable.id,
          "sales_comparable_ordinal_duplicate",
          "Sales comparable numbers must be unique.",
        ));
      }
      ordinals.add(ordinal);

      const comparableSources = sources.filter((source) => source.parent_entity_id === comparable.id);
      if (!comparableSources.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dataSourceType),
          comparable.id,
          "sales_comparable_data_source_required",
          "Add at least one data source for this sales comparable.",
        ));
      }
      const sourceTypes = comparableSources
        .map((source) => valueLookup(merged, source.id)(UAD_SALES_COMPARISON_FIELD_KEYS.dataSourceType))
        .filter(isPresent);
      if (new Set(sourceTypes).size !== sourceTypes.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dataSourceType),
          comparable.id,
          "sales_comparable_data_source_duplicate",
          "Each comparable data source type may be selected only once.",
        ));
      }
      if (!assets.some((asset) => isVerifiedSalesComparisonAsset(asset, "PropertyPhoto", comparable.id))) {
        errors.push(validationError(
          salesField("sales_comparable_address:1800.0001"),
          comparable.id,
          "sales_comparable_photo_required",
          "Upload and verify a property photo for this sales comparable.",
        ));
      }

      const status = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.listingStatus);
      const pending = status === "Pending";
      const settledSale = status === "SettledSale";
      const contractPriceUnknown = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.contractPriceUnknown);
      const contractPrice = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.contractPrice);
      const salePrice = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.salePrice);
      const saleType = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.saleType);
      const saleTypeOther = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.saleTypeOther);
      const noFinancing = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.noFinancing);
      const financingType = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.financingType);
      const financingOther = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.financingOther);
      const concessions = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.concessions);
      const concessionAmountKnown = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.concessionAmountKnown);
      const concessionAmount = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.concessionAmount);
      const contractDateUnknown = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.contractDateUnknown);
      const contractDate = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.contractDate);
      const saleDate = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.saleDate);

      if (!pending && [contractPriceUnknown, contractPrice].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.contractPriceUnknown),
          comparable.id,
          "sales_comparable_contract_price_status_conflict",
          "Contract price details are only reported for a pending comparable.",
        ));
      }
      if (contractPriceUnknown === true && isPresent(contractPrice)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.contractPriceUnknown),
          comparable.id,
          "sales_comparable_contract_price_unknown_conflict",
          "Clear the contract price or change Contract price unknown to No.",
        ));
      }
      if (!settledSale && [salePrice, saleType, saleTypeOther, saleDate, noFinancing, financingType, financingOther, concessions, concessionAmountKnown, concessionAmount].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.listingStatus),
          comparable.id,
          "sales_comparable_settled_detail_conflict",
          "Clear the settled-sale details or change Listing status to Settled Sale.",
        ));
      }
      if (saleType !== "Other" && isPresent(saleTypeOther)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.saleType),
          comparable.id,
          "sales_comparable_sale_type_other_conflict",
          "Clear the other transfer-terms description or select Other.",
        ));
      }
      if (noFinancing === true && [financingType, financingOther].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.noFinancing),
          comparable.id,
          "sales_comparable_financing_conflict",
          "Clear the financing details when the transaction was executed without financing.",
        ));
      }
      if (financingType !== "Other" && isPresent(financingOther)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.financingType),
          comparable.id,
          "sales_comparable_financing_other_conflict",
          "Clear the other financing description or select Other.",
        ));
      }
      if (concessions === false && [concessionAmountKnown, concessionAmount].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.concessions),
          comparable.id,
          "sales_comparable_concession_conflict",
          "Clear the concession amount details when there are no known sales concessions.",
        ));
      }
      if (concessionAmountKnown === false && isPresent(concessionAmount)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.concessionAmountKnown),
          comparable.id,
          "sales_comparable_concession_amount_conflict",
          "Clear the concession amount or change Sales concession amount known to Yes.",
        ));
      }
      if (!pending && !settledSale && [contractDateUnknown, contractDate].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.contractDateUnknown),
          comparable.id,
          "sales_comparable_contract_date_status_conflict",
          "Contract date details are only reported for pending or settled comparables.",
        ));
      }
      if (contractDateUnknown === true && isPresent(contractDate)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.contractDateUnknown),
          comparable.id,
          "sales_comparable_contract_date_unknown_conflict",
          "Clear the contract date or change Contract date unknown to No.",
        ));
      }

      const propertyRights = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.propertyRights);
      const propertyRightsOther = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.propertyRightsOther);
      if (propertyRights !== "Other" && isPresent(propertyRightsOther)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.propertyRights),
          comparable.id,
          "sales_comparable_property_rights_other_conflict",
          "Clear the other property-rights description or select Other.",
        ));
      }
      const nativeLands = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.nativeLands);
      const nativeLandsType = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.nativeLandsType);
      const nativeLandsOther = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.nativeLandsOther);
      if (nativeLands !== true && [nativeLandsType, nativeLandsOther].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.nativeLands),
          comparable.id,
          "sales_comparable_native_lands_conflict",
          "Clear the Native American lands details or change the indicator to Yes.",
        ));
      }
      if (nativeLandsType !== "Other" && isPresent(nativeLandsOther)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.nativeLandsType),
          comparable.id,
          "sales_comparable_native_lands_other_conflict",
          "Clear the other Native American lands description or select Other.",
        ));
      }

      const comparableRights = rights.filter((right) => right.parent_entity_id === comparable.id);
      const allRightsIncluded = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.allRightsIncluded);
      if (allRightsIncluded === false && !comparableRights.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.rightNotIncluded),
          comparable.id,
          "sales_comparable_right_not_included_required",
          "Add at least one right that is not included in the appraisal.",
        ));
      }
      if (allRightsIncluded === true && comparableRights.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.allRightsIncluded),
          comparable.id,
          "sales_comparable_right_not_included_conflict",
          "Remove the excluded-right records or change All property rights included to No.",
        ));
      }
      const selectedRights = comparableRights
        .map((right) => valueLookup(merged, right.id)(UAD_SALES_COMPARISON_FIELD_KEYS.rightNotIncluded))
        .filter(isPresent);
      if (new Set(selectedRights).size !== selectedRights.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.rightNotIncluded),
          comparable.id,
          "sales_comparable_right_not_included_duplicate",
          "Each excluded property right may be selected only once.",
        ));
      }

      const pud = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.pud);
      const inProject = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.inProject);
      const projectLegalStructure = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.projectLegalStructure);
      const projectName = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.projectName);
      const sameProject = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.sameProject);
      const projectMonthlyFee = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.projectMonthlyFee);
      const projectSpecialAssessment = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.projectSpecialAssessment);
      const projectAdjustment = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.projectAdjustment);
      const comparableProjectAmenities = projectAmenities.filter((amenity) => amenity.parent_entity_id === comparable.id);
      const projectApplicable = pud === true || inProject === true;
      const subjectProject = isPresent(rootLookup(UAD_PROJECT_INFORMATION_FIELD_KEYS.legalStructure));

      if (pud === true && inProject === true) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.inProject),
          comparable.id,
          "sales_comparable_project_classification_conflict",
          "A sales comparable cannot be classified as both a PUD and a condominium, cooperative, or condop.",
        ));
      }
      if (inProject !== true && [projectLegalStructure, projectName, sameProject].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.inProject),
          comparable.id,
          "sales_comparable_project_detail_conflict",
          "Clear the condominium, cooperative, or condop details or change the comparable project indicator to Yes.",
        ));
      }
      if (!subjectProject && isPresent(sameProject)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.sameProject),
          comparable.id,
          "sales_comparable_same_project_subject_conflict",
          "Clear Same project as subject because the subject is not identified as a condominium, cooperative, or condop.",
        ));
      }
      if (!projectApplicable && [projectMonthlyFee, projectSpecialAssessment, projectAdjustment].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.pud),
          comparable.id,
          "sales_comparable_project_financial_conflict",
          "Clear project fees, special assessment status, and project adjustment when the comparable is not in a project or PUD.",
        ));
      }
      if (projectApplicable && !comparableProjectAmenities.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity),
          comparable.id,
          "sales_comparable_project_amenity_required",
          "Add at least one common amenity or service for this project or PUD comparable.",
        ));
      }
      if (!projectApplicable && comparableProjectAmenities.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity),
          comparable.id,
          "sales_comparable_project_amenity_conflict",
          "Remove comparable project amenities when the comparable is not in a project or PUD.",
        ));
      }
      const selectedAmenities = comparableProjectAmenities
        .map((amenity) => valueLookup(merged, amenity.id)(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity))
        .filter(isPresent);
      if (new Set(selectedAmenities).size !== selectedAmenities.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity),
          comparable.id,
          "sales_comparable_project_amenity_duplicate",
          "Each comparable project amenity or service may be selected only once.",
        ));
      }
      if (selectedAmenities.includes("None") && selectedAmenities.length > 1) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.projectAmenity),
          comparable.id,
          "sales_comparable_project_amenity_none_conflict",
          "Select None by itself, or remove None before adding another comparable project amenity.",
        ));
      }

      const dwellings = comparableDwellings.filter((dwelling) => dwelling.parent_entity_id === comparable.id);
      const outbuildings = comparableOutbuildings.filter((outbuilding) => outbuilding.parent_entity_id === comparable.id);
      const functionalIssues = comparableFunctionalIssues.filter((issue) => issue.parent_entity_id === comparable.id);
      const disasterFeatures = comparableDisasterMitigation.filter((feature) => feature.parent_entity_id === comparable.id);
      const renewableEnergyComponents = comparableRenewableEnergyComponents.filter((component) => component.parent_entity_id === comparable.id);
      const greenCertifications = comparableGreenCertifications.filter((certification) => certification.parent_entity_id === comparable.id);
      const efficiencyRatings = comparableEfficiencyRatings.filter((rating) => rating.parent_entity_id === comparable.id);
      const attachment = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.propertyAttachment);
      const comparableMaintainsExterior = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.homeownerMaintainsExterior);
      if (!dwellings.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingYearBuilt),
          comparable.id,
          "sales_comparable_dwelling_required",
          "Add at least one dwelling for this sales comparable.",
        ));
      }

      const validateUniqueDwellingSelections = (records, key, code, label, noneExclusive = false) => {
        const selected = records
          .map((record) => valueLookup(merged, record.id)(key))
          .filter(isPresent);
        if (new Set(selected).size !== selected.length) {
          errors.push(validationError(
            salesField(key),
            comparable.id,
            code,
            `Each ${label} may be selected only once within its owning comparable record.`,
          ));
        }
        if (noneExclusive && selected.includes("None") && selected.length > 1) {
          errors.push(validationError(
            salesField(key),
            comparable.id,
            `${code}_none_conflict`,
            `Select None by itself, or remove None before adding another ${label}.`,
          ));
        }
      };
      const conditionalDwellingConflict = (record, controlKey, expectedValue, dependentKeys, code, message) => {
        const childLookup = valueLookup(merged, record.id);
        if (childLookup(controlKey) !== expectedValue && dependentKeys.some((key) => isPresent(childLookup(key)))) {
          errors.push(validationError(salesField(controlKey), record.id, code, message));
        }
      };

      for (const dwelling of dwellings) {
        const dwellingLookup = valueLookup(merged, dwelling.id);
        const design = dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign);
        const livingUnitCount = Number(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingUnits));
        const methods = comparableConstructionMethods.filter((method) => method.parent_entity_id === dwelling.id);
        const heatingSystems = comparableHeatingSystems.filter((system) => system.parent_entity_id === dwelling.id);
        const coolingSystems = comparableCoolingSystems.filter((system) => system.parent_entity_id === dwelling.id);
        const exteriorComponents = comparableExteriorComponents.filter((component) => component.parent_entity_id === dwelling.id);

        if (attachment === "Attached" && !isPresent(design)) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign),
            dwelling.id,
            "sales_comparable_structure_design_required",
            "Provide Structure Design for every attached comparable dwelling.",
          ));
        }
        if (attachment !== "Attached" && [
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesignOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseEnd,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseBack,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseStacked,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseLocation,
        ].some((key) => isPresent(dwellingLookup(key)))) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign),
            dwelling.id,
            "sales_comparable_structure_design_attachment_conflict",
            "Clear attached-structure details or change Attached or Detached to Attached.",
          ));
        }
        if (attachment !== "Detached" && [
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStyle,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStyleOther,
        ].some((key) => isPresent(dwellingLookup(key)))) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStyle),
            dwelling.id,
            "sales_comparable_dwelling_style_attachment_conflict",
            "Clear Dwelling Style unless the comparable is detached.",
          ));
        }
        conditionalDwellingConflict(
          dwelling,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign,
          "Other",
          [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesignOther],
          "sales_comparable_structure_design_other_conflict",
          "Clear the other structure-design description or select Other.",
        );
        conditionalDwellingConflict(
          dwelling,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStyle,
          "Other",
          [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStyleOther],
          "sales_comparable_dwelling_style_other_conflict",
          "Clear the other dwelling-style description or select Other.",
        );
        if (design !== "RowhouseTownhouse" && [
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseEnd,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseBack,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseStacked,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseLocation,
        ].some((key) => isPresent(dwellingLookup(key)))) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseEnd),
            dwelling.id,
            "sales_comparable_townhouse_detail_conflict",
            "Clear townhouse details unless Structure Design is Rowhouse / Townhouse.",
          ));
        }
        if (
          dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseStacked) !== true
          && isPresent(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseLocation))
        ) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingTownhouseLocation),
            dwelling.id,
            "sales_comparable_townhouse_location_conflict",
            "Clear Townhouse Location unless Units Above or Below is Yes.",
          ));
        }
        if (
          Number.isFinite(livingUnitCount) && livingUnitCount > 1
          && isPresent(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingNoncontinuousArea))
        ) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingNoncontinuousArea),
            dwelling.id,
            "sales_comparable_noncontinuous_area_multiunit_conflict",
            "Include noncontinuous finished area in GBFA for a multiunit comparable and clear this one-unit row.",
          ));
        }

        const constructionRequired = attachment === "Detached"
          || (attachment === "Attached" && ["RowhouseTownhouse", "SemiDetached", "Other"].includes(design));
        if (constructionRequired && !methods.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod),
            dwelling.id,
            "sales_comparable_construction_method_required",
            "Add at least one Construction Method for this comparable dwelling.",
          ));
        }
        if (!constructionRequired && methods.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod),
            dwelling.id,
            "sales_comparable_construction_method_conflict",
            "Remove Construction Method records for a high-rise, mid-rise, or low-rise attached dwelling.",
          ));
        }
        validateUniqueDwellingSelections(
          methods,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod,
          "sales_comparable_construction_method_duplicate",
          "construction method",
        );
        for (const method of methods) {
          conditionalDwellingConflict(
            method,
            UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod,
            "Other",
            [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethodOther],
            "sales_comparable_construction_method_other_conflict",
            "Clear the other construction-method description or select Other.",
          );
          conditionalDwellingConflict(
            method,
            UAD_SALES_COMPARISON_FIELD_KEYS.dwellingConstructionMethod,
            "Manufactured",
            [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingManufacturedWidth],
            "sales_comparable_manufactured_width_conflict",
            "Clear Manufactured Home Width or select Manufactured construction.",
          );
        }

        if (!heatingSystems.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystem),
            dwelling.id,
            "sales_comparable_heating_system_required",
            "Add at least one Heating System; select None when the dwelling has no heating system.",
          ));
        }
        validateUniqueDwellingSelections(
          heatingSystems,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystem,
          "sales_comparable_heating_system_duplicate",
          "heating system",
          true,
        );
        for (const system of heatingSystems) {
          const systemLookup = valueLookup(merged, system.id);
          conditionalDwellingConflict(system, UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystem, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystemOther], "sales_comparable_heating_system_other_conflict", "Clear the other heating-system description or select Other.");
          conditionalDwellingConflict(system, UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingFuel, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingFuelOther], "sales_comparable_heating_fuel_other_conflict", "Clear the other heating-fuel description or select Other.");
          if (systemLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystem) === "None" && [
            UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystemOther,
            UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingFuel,
            UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingFuelOther,
          ].some((key) => isPresent(systemLookup(key)))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingHeatingSystem),
              system.id,
              "sales_comparable_heating_none_detail_conflict",
              "Clear heating details when Heating System is None.",
            ));
          }
        }

        const coolingExists = dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingExists);
        if (coolingExists === true && !coolingSystems.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingSystem),
            dwelling.id,
            "sales_comparable_cooling_system_required",
            "Add at least one Cooling System when Permanent Cooling Exists is Yes.",
          ));
        }
        if (coolingExists !== true && coolingSystems.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingExists),
            dwelling.id,
            "sales_comparable_cooling_system_conflict",
            "Remove Cooling System records or change Permanent Cooling Exists to Yes.",
          ));
        }
        validateUniqueDwellingSelections(
          coolingSystems,
          UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingSystem,
          "sales_comparable_cooling_system_duplicate",
          "cooling system",
        );
        for (const system of coolingSystems) {
          conditionalDwellingConflict(system, UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingSystem, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCoolingSystemOther], "sales_comparable_cooling_system_other_conflict", "Clear the other cooling-system description or select Other.");
        }

        const exteriorComparisonApplies = subjectMaintainsExterior && comparableMaintainsExterior === true;
        const exteriorQuality = dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQuality);
        const exteriorCondition = dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorCondition);
        if (exteriorComparisonApplies) {
          if (!isPresent(exteriorQuality)) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQuality),
              dwelling.id,
              "sales_comparable_exterior_quality_required",
              "Provide the UAD exterior quality rating for this comparable dwelling.",
            ));
          }
          if (!isPresent(exteriorCondition)) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorCondition),
              dwelling.id,
              "sales_comparable_exterior_condition_required",
              "Provide the UAD exterior condition rating for this comparable dwelling.",
            ));
          }
          const componentTypes = exteriorComponents
            .map((component) => valueLookup(merged, component.id)(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType))
            .filter(isPresent);
          for (const requiredType of ["ExteriorWallsAndTrim", "Foundation", "Roof", "Windows"]) {
            if (!componentTypes.includes(requiredType)) {
              errors.push(validationError(
                salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType),
                dwelling.id,
                "sales_comparable_exterior_component_required",
                `Add the required ${requiredType} exterior comparison component.`,
              ));
            }
          }
          for (const coreType of ["ExteriorWallsAndTrim", "Foundation", "Roof", "Windows"]) {
            if (componentTypes.filter((type) => type === coreType).length > 1) {
              errors.push(validationError(
                salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType),
                dwelling.id,
                "sales_comparable_exterior_component_duplicate",
                `Keep exactly one ${coreType} component for this comparable dwelling.`,
              ));
            }
          }
        } else if (exteriorComponents.length || [exteriorQuality, exteriorCondition].some(isPresent)) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.homeownerMaintainsExterior),
            comparable.id,
            "sales_comparable_exterior_comparison_conflict",
            "Clear exterior ratings and components unless both the subject and comparable homeowners maintain all dwelling exteriors.",
          ));
        }

        const componentDetailKeys = [
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterial,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterialOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationType,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterial,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterialOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQualitySummary,
          UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofObservable,
        ];
        const allowedDetails = {
          ExteriorWallsAndTrim: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterial,
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterialOther,
          ]),
          Foundation: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationType,
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationOther,
          ]),
          Roof: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterial,
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterialOther,
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofObservable,
          ]),
          Windows: new Set([UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQualitySummary]),
          Other: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentOther,
            UAD_SALES_COMPARISON_FIELD_KEYS.exteriorQualitySummary,
          ]),
        };
        const otherComponentLabels = [];
        for (const component of exteriorComponents) {
          const componentLookup = valueLookup(merged, component.id);
          const componentType = componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType);
          const allowed = allowedDetails[componentType] || new Set();
          if (componentDetailKeys.some((key) => !allowed.has(key) && isPresent(componentLookup(key)))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentType),
              component.id,
              "sales_comparable_exterior_component_detail_conflict",
              "Clear details that do not belong to the selected exterior component type.",
            ));
          }
          const wallMaterials = componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterial);
          if (Array.isArray(wallMaterials) && !wallMaterials.includes("Other") && isPresent(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterialOther))) {
            errors.push(validationError(salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorWallMaterialOther), component.id, "sales_comparable_exterior_wall_other_conflict", "Clear the other wall material description or select Other."));
          }
          const foundationTypes = componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationType);
          if (Array.isArray(foundationTypes) && !foundationTypes.includes("Other") && isPresent(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationOther))) {
            errors.push(validationError(salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorFoundationOther), component.id, "sales_comparable_exterior_foundation_other_conflict", "Clear the other foundation type or select Other."));
          }
          const roofMaterials = componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterial);
          if (Array.isArray(roofMaterials) && !roofMaterials.includes("Other") && isPresent(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterialOther))) {
            errors.push(validationError(salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofMaterialOther), component.id, "sales_comparable_exterior_roof_other_conflict", "Clear the other roof material or select Other."));
          }
          if (componentType === "Roof" && componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorRoofObservable) !== true && isPresent(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentCondition))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentCondition),
              component.id,
              "sales_comparable_exterior_roof_condition_conflict",
              "Clear the roof condition status when the roof is not observable.",
            ));
          }
          if (componentType === "Other") {
            const label = String(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentOther) || "").trim();
            if (label) {
              otherComponentLabels.push(label);
              if (!subjectOtherExteriorLabels.has(label)) {
                errors.push(validationError(
                  salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentOther),
                  component.id,
                  "sales_comparable_exterior_other_subject_mismatch",
                  "Comparable Other exterior rows must use the exact label of a subject Other exterior feature; unrelated features belong in the Dwelling(s) additional row.",
                ));
              }
            }
          }
        }
        if (new Set(otherComponentLabels).size !== otherComponentLabels.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.exteriorComponentOther),
            dwelling.id,
            "sales_comparable_exterior_other_duplicate",
            "Each subject-defined Other exterior feature may appear only once per comparable dwelling.",
          ));
        }
      }

      const structures = [...dwellings, ...outbuildings];
      const structureIds = new Set(structures.map((structure) => structure.id));
      const units = comparableUnits.filter((unit) => structureIds.has(unit.parent_entity_id));
      const aduUnits = units.filter((unit) => valueLookup(merged, unit.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) === true);
      const nonAduUnits = units.filter((unit) => valueLookup(merged, unit.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) === false);
      const reportedNonAduCount = Number(lookup(UAD_SALES_COMPARISON_FIELD_KEYS.nonAduUnitCount));
      const reportedAduCount = Number(lookup(UAD_SALES_COMPARISON_FIELD_KEYS.aduCount));
      const reportedDwellingCount = Number(lookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCount));

      if (!units.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIdentifier),
          comparable.id,
          "sales_comparable_unit_required",
          "Add at least one living unit for this sales comparable.",
        ));
      }
      for (const [key, reported, actual, code, label] of [
        [UAD_SALES_COMPARISON_FIELD_KEYS.nonAduUnitCount, reportedNonAduCount, nonAduUnits.length, "sales_comparable_non_adu_count_mismatch", "Living units excluding ADUs"],
        [UAD_SALES_COMPARISON_FIELD_KEYS.aduCount, reportedAduCount, aduUnits.length, "sales_comparable_adu_count_mismatch", "Number of ADUs on property"],
        [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingCount, reportedDwellingCount, dwellings.length, "sales_comparable_dwelling_count_mismatch", "Dwelling count"],
      ]) {
        if (Number.isFinite(reported) && reported !== actual) {
          errors.push(validationError(
            salesField(key),
            comparable.id,
            code,
            `${label} must equal the saved comparable hierarchy count (${actual}).`,
          ));
        }
      }

      for (const dwelling of dwellings) {
        const dwellingLookup = valueLookup(merged, dwelling.id);
        const dwellingUnits = units.filter((unit) => unit.parent_entity_id === dwelling.id);
        const primaryUnits = dwellingUnits.filter((unit) => valueLookup(merged, unit.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) === false);
        const reportedUnits = Number(dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingUnits));
        if (!primaryUnits.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu),
            dwelling.id,
            "sales_comparable_dwelling_primary_unit_required",
            "Each comparable dwelling must contain at least one primary living unit that is not an ADU.",
          ));
        }
        if (Number.isFinite(reportedUnits) && reportedUnits !== dwellingUnits.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingUnits),
            dwelling.id,
            "sales_comparable_dwelling_unit_count_mismatch",
            `Units in structure must equal the saved unit count (${dwellingUnits.length}).`,
          ));
        }
        if (dwellingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.comparableImprovementType) !== "Dwelling") {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.comparableImprovementType),
            dwelling.id,
            "sales_comparable_dwelling_improvement_type_invalid",
            "A comparable dwelling must use Improvement Type Dwelling.",
          ));
        }
      }

      for (const outbuilding of outbuildings) {
        const outbuildingLookup = valueLookup(merged, outbuilding.id);
        const outbuildingUnits = units.filter((unit) => unit.parent_entity_id === outbuilding.id);
        if (!outbuildingUnits.length || outbuildingUnits.some((unit) => valueLookup(merged, unit.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) !== true)) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu),
            outbuilding.id,
            "sales_comparable_outbuilding_adu_required",
            "A comparable outbuilding in Unit(s) must contain at least one ADU and cannot contain a primary living unit.",
          ));
        }
        if (
          outbuildingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingImprovementType) !== "Outbuilding"
          || outbuildingLookup(UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingRealProperty) !== true
        ) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingImprovementType),
            outbuilding.id,
            "sales_comparable_outbuilding_classification_invalid",
            "A comparable outbuilding in Unit(s) must be classified as real-property Improvement Type Outbuilding.",
          ));
        }
        conditionalDwellingConflict(
          outbuilding,
          UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingType,
          "Other",
          [UAD_SALES_COMPARISON_FIELD_KEYS.comparableOutbuildingOther],
          "sales_comparable_outbuilding_other_conflict",
          "Clear the other outbuilding description or select Other.",
        );
      }

      const structureIdentifiers = dwellings.map((structure) => ({
        structure,
        key: UAD_SALES_COMPARISON_FIELD_KEYS.comparableDwellingStructureIdentifier,
        identifier: valueLookup(merged, structure.id)(UAD_SALES_COMPARISON_FIELD_KEYS.comparableDwellingStructureIdentifier),
      }));
      if (nonAduUnits.length > 1 || reportedNonAduCount > 1) {
        for (const { structure, key, identifier } of structureIdentifiers) {
          if (!isPresent(identifier)) {
            errors.push(validationError(
              salesField(key),
              structure.id,
              "sales_comparable_structure_identifier_required",
              "Provide a unique Structure Identifier for each dwelling when the comparable has more than one primary living unit.",
            ));
          }
        }
      }
      const savedStructureIdentifiers = structureIdentifiers.map(({ identifier }) => identifier).filter(isPresent);
      if (new Set(savedStructureIdentifiers).size !== savedStructureIdentifiers.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.comparableDwellingStructureIdentifier),
          comparable.id,
          "sales_comparable_structure_identifier_duplicate",
          "Structure identifiers must be unique within a sales comparable.",
        ));
      }

      const unitIdentifiers = units.map((unit) => ({
        unit,
        identifier: valueLookup(merged, unit.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitIdentifier),
      }));
      if (nonAduUnits.length > 1 || aduUnits.length > 0) {
        for (const { unit, identifier } of unitIdentifiers) {
          if (!isPresent(identifier)) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIdentifier),
              unit.id,
              "sales_comparable_unit_identifier_required",
              "Provide a unique Unit Identifier when the comparable has multiple primary units or any ADU.",
            ));
          }
        }
      }
      const savedUnitIdentifiers = unitIdentifiers.map(({ identifier }) => identifier).filter(isPresent);
      if (new Set(savedUnitIdentifiers).size !== savedUnitIdentifiers.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitIdentifier),
          comparable.id,
          "sales_comparable_unit_identifier_duplicate",
          "Unit identifiers must be unique within a sales comparable.",
        ));
      }

      for (const unit of units) {
        const parentDwelling = dwellings.find((dwelling) => dwelling.id === unit.parent_entity_id);
        const design = parentDwelling
          ? valueLookup(merged, parentDwelling.id)(UAD_SALES_COMPARISON_FIELD_KEYS.dwellingStructureDesign)
          : null;
        const unitLookup = valueLookup(merged, unit.id);
        if (
          attachment === "Attached"
          && ["Lowrise", "Midrise", "Highrise"].includes(design)
          && !isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitFloor))
        ) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitFloor),
            unit.id,
            "sales_comparable_unit_floor_required",
            "Provide Floor Number for each attached low-rise, mid-rise, or high-rise comparable unit.",
          ));
        }

        const accessibility = comparableUnitAccessibility.filter((feature) => feature.parent_entity_id === unit.id);
        const selectedAccessibility = accessibility
          .map((feature) => valueLookup(merged, feature.id)(UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibility))
          .filter(isPresent);
        if (new Set(selectedAccessibility).size !== selectedAccessibility.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibility),
            unit.id,
            "sales_comparable_unit_accessibility_duplicate",
            "Each accessibility feature may be selected only once for a comparable unit.",
          ));
        }
        if (selectedAccessibility.includes("None") && selectedAccessibility.length > 1) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibility),
            unit.id,
            "sales_comparable_unit_accessibility_none_conflict",
            "Select None by itself, or remove None before adding another accessibility feature.",
          ));
        }
        for (const feature of accessibility) {
          conditionalDwellingConflict(
            feature,
            UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibility,
            "Other",
            [UAD_SALES_COMPARISON_FIELD_KEYS.unitAccessibilityOther],
            "sales_comparable_unit_accessibility_other_conflict",
            "Clear the other accessibility description or select Other.",
          );
        }

        const kitchens = comparableKitchens.filter((kitchen) => kitchen.parent_entity_id === unit.id);
        const interiorComponents = comparableInteriorComponents.filter((component) => component.parent_entity_id === unit.id);
        const isAdu = unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitIsAdu) === true;
        if (!isAdu) {
          if (!isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorQuality))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorQuality),
              unit.id,
              "sales_comparable_interior_quality_required",
              "Provide the UAD interior quality rating for this non-ADU comparable unit.",
            ));
          }
          if (!isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorCondition))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorCondition),
              unit.id,
              "sales_comparable_interior_condition_required",
              "Provide the UAD interior condition rating for this non-ADU comparable unit.",
            ));
          }
          if (!kitchens.length) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.kitchenType),
              unit.id,
              "sales_comparable_kitchen_required",
              "Add the Kitchen quality and update-status row for this non-ADU comparable unit.",
            ));
          }
          const bathroomCount = Number(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitFullBaths) || 0)
            + Number(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.unitHalfBaths) || 0);
          if (bathroomCount > 0) {
            if (!isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsQuality))) {
              errors.push(validationError(
                salesField(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsQuality),
                unit.id,
                "sales_comparable_bathrooms_quality_summary_required",
                "Provide the overall bathrooms quality summary for this comparable unit.",
              ));
            }
            if (!isPresent(unitLookup(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsUpdate))) {
              errors.push(validationError(
                salesField(UAD_SALES_COMPARISON_FIELD_KEYS.overallBathroomsUpdate),
                unit.id,
                "sales_comparable_bathrooms_update_required",
                "Provide the overall bathroom update status for this comparable unit.",
              ));
            }
          }
          const componentTypes = interiorComponents
            .map((component) => valueLookup(merged, component.id)(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType))
            .filter(isPresent);
          for (const requiredType of ["Flooring", "WallsAndCeiling"]) {
            const count = componentTypes.filter((type) => type === requiredType).length;
            if (count !== 1) {
              errors.push(validationError(
                salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType),
                unit.id,
                count ? "sales_comparable_interior_component_duplicate" : "sales_comparable_interior_component_required",
                count
                  ? `Keep exactly one ${requiredType} component for this comparable unit.`
                  : `Add the required ${requiredType} component for this comparable unit.`,
              ));
            }
          }
        }

        for (const kitchen of kitchens) {
          if (valueLookup(merged, kitchen.id)(UAD_SALES_COMPARISON_FIELD_KEYS.kitchenType) !== "Kitchen") {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.kitchenType),
              kitchen.id,
              "sales_comparable_kitchen_type_invalid",
              "A comparable kitchen comparison record must use Room Type Kitchen.",
            ));
          }
        }

        const componentDetailKeys = [
          UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentOther,
          UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentQualitySummary,
          UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentConditionSummary,
          UAD_SALES_COMPARISON_FIELD_KEYS.interiorFlooringUpdate,
        ];
        const allowedComponentDetails = {
          Flooring: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentQualitySummary,
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorFlooringUpdate,
          ]),
          WallsAndCeiling: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentQualitySummary,
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentConditionSummary,
          ]),
          Other: new Set([
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentOther,
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentQualitySummary,
            UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentConditionSummary,
          ]),
        };
        const otherInteriorLabels = [];
        for (const component of interiorComponents) {
          const componentLookup = valueLookup(merged, component.id);
          const componentType = componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType);
          const allowed = allowedComponentDetails[componentType] || new Set();
          if (componentDetailKeys.some((key) => !allowed.has(key) && isPresent(componentLookup(key)))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentType),
              component.id,
              "sales_comparable_interior_component_detail_conflict",
              "Clear details that do not belong to the selected interior component type.",
            ));
          }
          if (componentType === "Other") {
            const label = String(componentLookup(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentOther) || "").trim();
            if (label) {
              otherInteriorLabels.push(label);
              if (!subjectOtherInteriorLabels.has(label)) {
                errors.push(validationError(
                  salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentOther),
                  component.id,
                  "sales_comparable_interior_other_subject_mismatch",
                  "Comparable Other interior rows must use the exact label of a subject Other interior feature; unrelated features belong in the Unit(s) additional row.",
                ));
              }
            }
          }
        }
        if (new Set(otherInteriorLabels).size !== otherInteriorLabels.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.interiorComponentOther),
            unit.id,
            "sales_comparable_interior_other_duplicate",
            "Each subject-defined Other interior feature may appear only once per comparable unit.",
          ));
        }
      }

      validateUniqueDwellingSelections(
        functionalIssues,
        UAD_SALES_COMPARISON_FIELD_KEYS.dwellingFunctionalIssue,
        "sales_comparable_functional_issue_duplicate",
        "functional issue",
        true,
      );
      for (const issue of functionalIssues) {
        conditionalDwellingConflict(issue, UAD_SALES_COMPARISON_FIELD_KEYS.dwellingFunctionalIssue, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingFunctionalIssueOther], "sales_comparable_functional_issue_other_conflict", "Clear the other functional-issue description or select Other.");
      }
      validateUniqueDwellingSelections(
        disasterFeatures,
        UAD_SALES_COMPARISON_FIELD_KEYS.dwellingDisasterMitigation,
        "sales_comparable_disaster_mitigation_duplicate",
        "disaster mitigation feature",
        true,
      );
      for (const feature of disasterFeatures) {
        conditionalDwellingConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.dwellingDisasterMitigation, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.dwellingDisasterMitigationOther], "sales_comparable_disaster_mitigation_other_conflict", "Clear the other disaster-mitigation description or select Other.");
      }

      const validateEnergyGreenFamily = (indicatorKey, records, childKey, code, label) => {
        const indicator = lookup(indicatorKey);
        if (indicator === true && !records.length) {
          errors.push(validationError(
            salesField(childKey),
            comparable.id,
            `${code}_required`,
            `Add at least one ${label} when its known-feature indicator is Yes.`,
          ));
        }
        if (indicator !== true && records.length) {
          errors.push(validationError(
            salesField(indicatorKey),
            comparable.id,
            `${code}_conflict`,
            `Remove the saved ${label} records or change the known-feature indicator to Yes.`,
          ));
        }
      };
      validateEnergyGreenFamily(
        UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyExists,
        renewableEnergyComponents,
        UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyType,
        "sales_comparable_renewable_energy_component",
        "renewable energy component",
      );
      validateEnergyGreenFamily(
        UAD_SALES_COMPARISON_FIELD_KEYS.greenCertificationExists,
        greenCertifications,
        UAD_SALES_COMPARISON_FIELD_KEYS.greenCertificationName,
        "sales_comparable_green_certification",
        "building certification",
      );
      validateEnergyGreenFamily(
        UAD_SALES_COMPARISON_FIELD_KEYS.efficiencyRatingExists,
        efficiencyRatings,
        UAD_SALES_COMPARISON_FIELD_KEYS.efficiencyRatingName,
        "sales_comparable_efficiency_rating",
        "efficiency rating",
      );

      const renewableTypes = renewableEnergyComponents
        .map((component) => valueLookup(merged, component.id)(UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyType))
        .filter(isPresent);
      if (new Set(renewableTypes).size !== renewableTypes.length) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyType),
          comparable.id,
          "sales_comparable_renewable_energy_component_duplicate",
          "Each renewable energy component type may be selected only once for a comparable.",
        ));
      }
      for (const component of renewableEnergyComponents) {
        conditionalDwellingConflict(
          component,
          UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyType,
          "Other",
          [UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyOther],
          "sales_comparable_renewable_energy_other_conflict",
          "Clear the other renewable-energy description or select Other.",
        );
      }

      const energyGreenAdjustment = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.energyGreenAdjustment);
      const energyGreenIndicators = [
        lookup(UAD_SALES_COMPARISON_FIELD_KEYS.renewableEnergyExists),
        lookup(UAD_SALES_COMPARISON_FIELD_KEYS.greenCertificationExists),
        lookup(UAD_SALES_COMPARISON_FIELD_KEYS.efficiencyRatingExists),
      ];
      if (isPresent(energyGreenAdjustment) && !energyGreenIndicators.some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.energyGreenAdjustment),
          comparable.id,
          "sales_comparable_energy_green_adjustment_detail_required",
          "Include at least one Energy Efficient and Green Features comparison row when an adjustment is entered.",
        ));
      }

      const siteOwnedInCommon = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteOwnedInCommon);
      const siteSize = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteSize);
      const sitePrimaryAccess = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.sitePrimaryAccess);
      const sitePrimaryAccessOther = lookup(UAD_SALES_COMPARISON_FIELD_KEYS.sitePrimaryAccessOther);
      const siteChildren = (entityType) => comparableSiteChildren.filter((entity) => (
        entity.entity_type === entityType && entity.parent_entity_id === comparable.id
      ));
      const hazards = siteChildren("sales_comparable_site_hazard");
      const streets = siteChildren("sales_comparable_site_street");
      const restrictions = siteChildren("sales_comparable_site_restriction");
      const easements = siteChildren("sales_comparable_site_easement");
      const siteFeatures = siteChildren("sales_comparable_site_feature");
      const siteInfluences = siteChildren("sales_comparable_site_influence");
      const environmentalConditions = siteChildren("sales_comparable_site_environmental");
      const siteViews = siteChildren("sales_comparable_site_view");

      for (const requirement of [
        [hazards, UAD_SALES_COMPARISON_FIELD_KEYS.siteHazard, "sales_comparable_site_hazard_required", "Add at least one hazard-zone record; select None when no hazard zone is identified."],
        [siteInfluences, UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence, "sales_comparable_site_influence_required", "Add at least one Site Influence (Location) record for this sales comparable."],
        [siteViews, UAD_SALES_COMPARISON_FIELD_KEYS.siteView, "sales_comparable_site_view_required", "Add at least one View record for this sales comparable."],
      ]) {
        if (!requirement[0].length) {
          errors.push(validationError(
            salesField(requirement[1]),
            comparable.id,
            requirement[2],
            requirement[3],
          ));
        }
      }

      if (siteOwnedInCommon === true && [siteSize, sitePrimaryAccess, sitePrimaryAccessOther].some(isPresent)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteOwnedInCommon),
          comparable.id,
          "sales_comparable_site_common_ownership_conflict",
          "Clear site size and primary-access details when the comparable site is owned in common.",
        ));
      }
      if (sitePrimaryAccess !== "Other" && isPresent(sitePrimaryAccessOther)) {
        errors.push(validationError(
          salesField(UAD_SALES_COMPARISON_FIELD_KEYS.sitePrimaryAccessOther),
          comparable.id,
          "sales_comparable_site_primary_access_other_conflict",
          "Clear the other primary-access description or select Other.",
        ));
      }

      const validateUniqueSiteSelections = (records, key, code, label, noneExclusive = false) => {
        const selected = records
          .map((record) => valueLookup(merged, record.id)(key))
          .filter(isPresent);
        if (new Set(selected).size !== selected.length) {
          errors.push(validationError(
            salesField(key),
            comparable.id,
            code,
            `Each ${label} may be selected only once for a sales comparable.`,
          ));
        }
        if (noneExclusive && selected.includes("None") && selected.length > 1) {
          errors.push(validationError(
            salesField(key),
            comparable.id,
            `${code}_none_conflict`,
            `Select None by itself, or remove None before adding another ${label}.`,
          ));
        }
      };
      validateUniqueSiteSelections(hazards, UAD_SALES_COMPARISON_FIELD_KEYS.siteHazard, "sales_comparable_site_hazard_duplicate", "hazard zone", true);
      validateUniqueSiteSelections(streets, UAD_SALES_COMPARISON_FIELD_KEYS.siteStreetType, "sales_comparable_site_street_duplicate", "street type");
      validateUniqueSiteSelections(restrictions, UAD_SALES_COMPARISON_FIELD_KEYS.siteRestriction, "sales_comparable_site_restriction_duplicate", "property restriction");
      validateUniqueSiteSelections(easements, UAD_SALES_COMPARISON_FIELD_KEYS.siteEasement, "sales_comparable_site_easement_duplicate", "easement");
      validateUniqueSiteSelections(siteFeatures, UAD_SALES_COMPARISON_FIELD_KEYS.siteFeature, "sales_comparable_site_feature_duplicate", "site characteristic", true);
      validateUniqueSiteSelections(siteInfluences, UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence, "sales_comparable_site_influence_duplicate", "site influence");
      validateUniqueSiteSelections(environmentalConditions, UAD_SALES_COMPARISON_FIELD_KEYS.siteEnvironmental, "sales_comparable_site_environmental_duplicate", "environmental condition", true);
      validateUniqueSiteSelections(siteViews, UAD_SALES_COMPARISON_FIELD_KEYS.siteView, "sales_comparable_site_view_duplicate", "view type");

      const conditionalConflict = (record, controlKey, expectedValue, dependentKeys, code, message) => {
        const childLookup = valueLookup(merged, record.id);
        if (childLookup(controlKey) !== expectedValue && dependentKeys.some((key) => isPresent(childLookup(key)))) {
          errors.push(validationError(salesField(controlKey), record.id, code, message));
        }
      };
      for (const hazard of hazards) {
        conditionalConflict(
          hazard,
          UAD_SALES_COMPARISON_FIELD_KEYS.siteHazard,
          "Other",
          [UAD_SALES_COMPARISON_FIELD_KEYS.siteHazardOther],
          "sales_comparable_site_hazard_other_conflict",
          "Clear the other hazard-zone description or select Other.",
        );
        conditionalConflict(
          hazard,
          UAD_SALES_COMPARISON_FIELD_KEYS.siteHazard,
          "USGSLavaFlowZone",
          [UAD_SALES_COMPARISON_FIELD_KEYS.siteHazardLavaZone],
          "sales_comparable_site_hazard_lava_conflict",
          "Clear the lava-flow zone or select USGS Lava Flow Zone.",
        );
      }
      for (const street of streets) {
        conditionalConflict(street, UAD_SALES_COMPARISON_FIELD_KEYS.siteStreetType, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteStreetTypeOther], "sales_comparable_site_street_other_conflict", "Clear the other street-type description or select Other.");
        conditionalConflict(street, UAD_SALES_COMPARISON_FIELD_KEYS.siteStreetSurface, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteStreetSurfaceOther], "sales_comparable_site_surface_other_conflict", "Clear the other surface description or select Other.");
      }
      for (const restriction of restrictions) {
        conditionalConflict(restriction, UAD_SALES_COMPARISON_FIELD_KEYS.siteRestriction, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteRestrictionOther], "sales_comparable_site_restriction_other_conflict", "Clear the other restriction description or select Other.");
      }
      for (const easement of easements) {
        conditionalConflict(easement, UAD_SALES_COMPARISON_FIELD_KEYS.siteEasement, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteEasementOther], "sales_comparable_site_easement_other_conflict", "Clear the other easement description or select Other.");
      }
      for (const feature of siteFeatures) {
        conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteFeature, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteFeatureOther], "sales_comparable_site_feature_other_conflict", "Clear the other site-characteristic description or select Other.");
        conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteFeature, "Topography", [UAD_SALES_COMPARISON_FIELD_KEYS.siteTopography, UAD_SALES_COMPARISON_FIELD_KEYS.siteTopographyOther], "sales_comparable_site_topography_conflict", "Clear topography details unless Site Characteristic is Topography.");
        conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteTopography, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteTopographyOther], "sales_comparable_site_topography_other_conflict", "Clear the other topography description or select Other.");
        conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteFeature, "Drainage", [UAD_SALES_COMPARISON_FIELD_KEYS.siteDrainage, UAD_SALES_COMPARISON_FIELD_KEYS.siteDrainageOther], "sales_comparable_site_drainage_conflict", "Clear drainage details unless Site Characteristic is Drainage.");
        conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteDrainage, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteDrainageOther], "sales_comparable_site_drainage_other_conflict", "Clear the other drainage description or select Other.");
      }
      for (const influence of siteInfluences) {
        conditionalConflict(influence, UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluenceOther], "sales_comparable_site_influence_other_conflict", "Clear the other influence description or select Other.");
        const influenceLookup = valueLookup(merged, influence.id);
        const bodiesOfWater = comparableBodiesOfWater.filter((body) => body.parent_entity_id === influence.id);
        const privateBodies = bodiesOfWater.filter((body) => (
          valueLookup(merged, body.id)(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterPrivateAccess) === true
        ));
        const waterfrontFeatures = comparableWaterfrontFeatures.filter((feature) => (
          bodiesOfWater.some((body) => body.id === feature.parent_entity_id)
        ));
        const influenceType = influenceLookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence);
        const developmentRights = influenceLookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontDevelopmentRights);
        const totalLength = influenceLookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterFrontageTotalLength);

        if (influenceType === "BodyOfWater" && !bodiesOfWater.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWater),
            influence.id,
            "sales_comparable_body_of_water_required",
            "Add at least one body of water to every Body of Water influence.",
          ));
        }
        if (influenceType !== "BodyOfWater" && bodiesOfWater.length) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteInfluence),
            influence.id,
            "sales_comparable_body_of_water_conflict",
            "Remove the body-of-water records or change Site Influence to Body of Water.",
          ));
        }

        for (const body of bodiesOfWater) {
          const bodyLookup = valueLookup(merged, body.id);
          const privateAccess = bodyLookup(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterPrivateAccess);
          const bodyFeatures = comparableWaterfrontFeatures.filter((feature) => feature.parent_entity_id === body.id);
          conditionalConflict(body, UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWater, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterOther], "sales_comparable_site_body_of_water_other_conflict", "Clear the other body-of-water description or select Other.");
          if (privateAccess !== true && [
            UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterName,
            UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterAccessDepth,
            UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterAccessDepthOther,
          ].some((key) => isPresent(bodyLookup(key)))) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterPrivateAccess),
              body.id,
              "sales_comparable_private_water_detail_conflict",
              "Clear the private-water name and access-depth details or change Private Access to Yes.",
            ));
          }
          conditionalConflict(body, UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterAccessDepth, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterAccessDepthOther], "sales_comparable_water_access_depth_other_conflict", "Clear the other access-depth description or select Other.");
          if (privateAccess !== true && bodyFeatures.length) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature),
              body.id,
              "sales_comparable_waterfront_feature_private_access_conflict",
              "Remove permanent waterfront features or change Private Access to Yes.",
            ));
          }

          const selectedFeatures = bodyFeatures
            .map((feature) => valueLookup(merged, feature.id)(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature))
            .filter(isPresent);
          if (new Set(selectedFeatures).size !== selectedFeatures.length) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature),
              body.id,
              "sales_comparable_waterfront_feature_duplicate",
              "Each permanent waterfront feature may be selected only once for a body of water.",
            ));
          }
          if (selectedFeatures.includes("None") && selectedFeatures.length > 1) {
            errors.push(validationError(
              salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature),
              body.id,
              "sales_comparable_waterfront_feature_none_conflict",
              "Select None by itself, or remove None before adding another permanent waterfront feature.",
            ));
          }
          for (const feature of bodyFeatures) {
            conditionalConflict(feature, UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeatureOther], "sales_comparable_waterfront_feature_other_conflict", "Clear the other waterfront-feature description or select Other.");
          }
        }

        const featureSelections = waterfrontFeatures.map((feature) => (
          valueLookup(merged, feature.id)(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontFeature)
        )).filter(isPresent);
        if (!privateBodies.length && (waterfrontFeatures.length || [developmentRights, totalLength].some(isPresent))) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteBodyOfWaterPrivateAccess),
            influence.id,
            "sales_comparable_private_water_frontage_conflict",
            "Remove waterfront features, rights, and total frontage unless at least one body of water has private access.",
          ));
        }
        if (featureSelections.includes("None") && !isPresent(developmentRights)) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontDevelopmentRights),
            influence.id,
            "sales_comparable_waterfront_development_rights_required",
            "Indicate the right to build waterfront features when Permanent Waterfront Feature is None.",
          ));
        }
        if (!featureSelections.includes("None") && isPresent(developmentRights)) {
          errors.push(validationError(
            salesField(UAD_SALES_COMPARISON_FIELD_KEYS.siteWaterfrontDevelopmentRights),
            influence.id,
            "sales_comparable_waterfront_development_rights_conflict",
            "Clear Right to Build unless Permanent Waterfront Feature is None.",
          ));
        }
      }
      for (const condition of environmentalConditions) {
        conditionalConflict(condition, UAD_SALES_COMPARISON_FIELD_KEYS.siteEnvironmental, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteEnvironmentalOther], "sales_comparable_site_environmental_other_conflict", "Clear the other environmental-condition description or select Other.");
      }
      for (const view of siteViews) {
        conditionalConflict(view, UAD_SALES_COMPARISON_FIELD_KEYS.siteView, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteViewOther], "sales_comparable_site_view_other_conflict", "Clear the other view description or select Other.");
        conditionalConflict(view, UAD_SALES_COMPARISON_FIELD_KEYS.siteViewRange, "Other", [UAD_SALES_COMPARISON_FIELD_KEYS.siteViewRangeOther], "sales_comparable_site_view_range_other_conflict", "Clear the other view-range description or select Other.");
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
