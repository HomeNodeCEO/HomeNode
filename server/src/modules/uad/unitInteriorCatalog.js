const condition = (key, equals) => ({ key, equals });

const aduExists = Object.freeze(condition("unit:0700.0089", true));
const belowGradeAreaExists = Object.freeze({
  any: [
    { key: "unit:0700.0143", greaterThan: 0 },
    { key: "unit:1800.0398", greaterThan: 0 },
  ],
});
const belowGradeLevel = Object.freeze({
  any: [
    condition("unit_level:0700.0029", "FullyBelowGrade"),
    condition("unit_level:0700.0029", "PartiallyBelowGrade"),
  ],
});
const belowGradeExteriorAccess = Object.freeze({
  all: [
    belowGradeLevel,
    {
      any: [
        condition("unit_level:0700.0026", "ExteriorAccessOnly"),
        condition("unit_level:0700.0026", "InteriorAndExteriorAccess"),
      ],
    },
  ],
});
const roomRequiresDetail = Object.freeze({
  any: [
    condition("unit_room:0700.0035", "Kitchen"),
    condition("unit_room:0700.0035", "FullBathroom"),
    condition("unit_room:0700.0035", "HalfBathroom"),
  ],
});
const roomWasUpdated = Object.freeze({
  all: [
    roomRequiresDetail,
    {
      any: [
        condition("unit_room:0700.0036", "FullyUpdated"),
        condition("unit_room:0700.0036", "PartiallyUpdated"),
      ],
    },
  ],
});
const flooringFeature = Object.freeze(condition("unit_interior_feature:0700.0046", "Flooring"));
const wallsFeature = Object.freeze(condition("unit_interior_feature:0700.0046", "WallsAndCeiling"));
const otherFeature = Object.freeze(condition("unit_interior_feature:0700.0046", "Other"));
const unitDefectsExist = Object.freeze(condition("unit:3900.0107", true));
const multipleUnitsOrAdu = Object.freeze({
  any: [
    { key: "subject:0100.0022", greaterThan: 1 },
    { key: "subject:0100.0019", greaterThan: 0 },
    aduExists,
  ],
});
const siteOwnedInCommon = Object.freeze(condition("subject:0100.0047", true));
const vacantGovernmentAssignment = Object.freeze({
  all: [
    condition("unit:0700.0070", "Vacant"),
    {
      any: [
        condition("assignment:1000.0029", "FHA"),
        condition("assignment:1000.0029", "USDA"),
      ],
    },
  ],
});

const LEVEL_TYPES = [
  "BelowGradeFive", "BelowGradeFour", "BelowGradeOne", "BelowGradeThree", "BelowGradeTwo",
  "LevelEight", "LevelFive", "LevelFour", "LevelNine", "LevelOne", "LevelSeven", "LevelSix",
  "LevelTen", "LevelThree", "LevelTwo",
];
const ROOM_TYPES = [
  "Bedroom", "BreakfastRoom", "Den", "DiningRoom", "FamilyRoom", "FullBathroom", "HalfBathroom",
  "Kitchen", "LaundryRoom", "LivingRoom", "Loft", "MediaRoom", "Mudroom", "Other", "RecreationRoom",
  "Sunroom", "UtilityRoom", "WalkInPantry", "Workshop",
];
const DATA_SOURCE_TYPES = [
  "AssessorRecord", "BuilderOrDeveloper", "CondominiumQuestionnaire", "CooperativeBoard",
  "CooperativeQuestionnaire", "CostService", "CostSurvey", "DataAggregator", "Deed", "ExteriorInspection",
  "HomeownersAssociation", "InteriorInspection", "LandSurvey", "Lender", "MLS", "Other",
  "PhysicalMeasurement", "PlansAndSpecifications", "PlatMap", "PreviousAppraisalFile", "PropertyDataReport",
  "PropertyManagementCompany", "PropertyOwner", "PropertyTenant", "RealEstateAgent", "ThreeDimensionalScan", "Zoning",
];
export const UAD_UNIT_ACCESSIBILITY_TYPES = Object.freeze([
  "Appliances", "Auditory", "Bathtub", "Cabinets", "Counters", "Doorways", "ElectricalSwitches",
  "GrabBars", "Handrails", "Hardware", "Lighting", "None", "Other", "Ramps", "Shower", "Sink", "Toilet",
]);

export const UAD_INTERIOR_COMPONENT_TYPES = Object.freeze([
  "Flooring", "Other", "WallsAndCeiling",
]);

export const UAD_INTERIOR_ROOM_UPDATE_STATUS_TYPES = Object.freeze([
  "FullyUpdated", "NotUpdated", "PartiallyUpdated",
]);

export const UAD_INTERIOR_OVERALL_UPDATE_STATUS_TYPES = Object.freeze([
  "FullyUpdated", "SignificantlyUpdated", "ModeratelyUpdated", "NotUpdated",
]);

const field = (group, contextKey, entityType, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "unit_interior",
  group,
  contextKey,
  entityType,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const unit = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => (
  field(group, contextKey, "unit", uid, reportFieldId, label, dataType, options)
);
const child = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => (
  field(group, contextKey, contextKey, uid, reportFieldId, label, dataType, options)
);

export const UAD_UNIT_INTERIOR_ENTITY_GROUPS = Object.freeze({
  unit: {
    title: "Living units",
    addLabel: "Add living unit",
    minItems: 0,
    parentEntityTypes: ["dwelling", "outbuilding"],
  },
  unit_area_data_source: {
    title: "Area data sources",
    addLabel: "Add area data source",
    minItems: 0,
    parentEntityType: "unit",
  },
  unit_adu_data_source: {
    title: "ADU data sources",
    addLabel: "Add ADU data source",
    minItems: 0,
    parentEntityType: "unit",
    showWhen: aduExists,
  },
  unit_level: {
    title: "Levels",
    addLabel: "Add level",
    minItems: 0,
    parentEntityType: "unit",
  },
  unit_room: {
    title: "Rooms",
    addLabel: "Add room",
    minItems: 0,
    parentEntityType: "unit",
  },
  unit_interior_feature: {
    title: "Interior features",
    addLabel: "Add interior feature",
    minItems: 0,
    parentEntityType: "unit",
  },
  unit_interior_defect: {
    title: "Interior defects",
    addLabel: "Add interior defect",
    minItems: 0,
    parentEntityType: "unit",
    showWhen: unitDefectsExist,
  },
});

export const UAD_UNIT_INTERIOR_CAPTION_TYPES = Object.freeze([
  "UnitInteriorExhibit",
  ...ROOM_TYPES,
  "Flooring",
  "WallsAndCeiling",
  "OtherInteriorFeature",
  "UnitInteriorDefect",
]);

export const UAD_UNIT_INTERIOR_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export function isVerifiedUnitInteriorAsset(asset, captionType, entityId = null) {
  return asset?.section_number === 10
    && asset?.status === "verified"
    && asset?.caption_type === captionType
    && (!entityId || asset?.entity_id === entityId)
    && UAD_UNIT_INTERIOR_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_UNIT_INTERIOR_FIELDS = [
  unit("Unit identification and area", "unit", "0700.0114", "10.002", "Unit identifier", "string", {
    maxLength: 25,
    requiredWhen: multipleUnitsOrAdu,
  }),
  unit("Unit identification and area", "unit", "0700.0140", "10.003", "Standard above-grade finished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "0700.0141", "10.004", "Nonstandard above-grade finished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "0700.0142", "10.005", "Above-grade unfinished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "0700.0143", "10.006", "Standard below-grade finished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "1800.0398", "10.007", "Nonstandard below-grade finished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "0700.0144", "10.008", "Below-grade unfinished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  unit("Unit identification and area", "unit", "0700.0064", "10.010", "Below-grade finish comparison", "enum", {
    options: ["Inferior", "Similar", "Superior"], showWhen: belowGradeAreaExists, requiredWhen: belowGradeAreaExists,
  }),

  child("Area data sources", "unit_area_data_source", "0700.0125", "10.009", "Area data source", "enum", { required: true, options: DATA_SOURCE_TYPES }),
  child("Area data sources", "unit_area_data_source", "0700.0126", "10.009", "Other area data source", "string", {
    maxLength: 66, showWhen: condition("unit_area_data_source:0700.0125", "Other"), requiredWhen: condition("unit_area_data_source:0700.0125", "Other"),
  }),

  unit("Accessory dwelling unit", "unit", "0700.0089", "10.011", "Accessory dwelling unit", "boolean", { required: true }),
  unit("Accessory dwelling unit", "unit", "0700.0098", "10.012", "ADU legally rentable", "boolean", { showWhen: aduExists, requiredWhen: aduExists }),
  child("ADU data sources", "unit_adu_data_source", "0700.0125", "10.013", "ADU data source", "enum", { required: true, options: DATA_SOURCE_TYPES }),
  child("ADU data sources", "unit_adu_data_source", "0700.0126", "10.013", "Other ADU data source", "string", {
    maxLength: 66, showWhen: condition("unit_adu_data_source:0700.0125", "Other"), requiredWhen: condition("unit_adu_data_source:0700.0125", "Other"),
  }),
  unit("Accessory dwelling unit", "unit", "0700.0088", "10.014", "ADU typical to market", "boolean", { showWhen: aduExists, requiredWhen: aduExists }),
  unit("Accessory dwelling unit", "unit", "0700.0091", "10.015", "ADU access", "enum", { showWhen: aduExists, requiredWhen: aduExists, options: ["ExteriorAccessOnly", "InteriorAccessOnly", "InteriorAndExteriorAccess"] }),
  unit("Accessory dwelling unit", "unit", "0700.0090", "10.016", "ADU has separate postal address", "boolean", { showWhen: aduExists, requiredWhen: aduExists }),

  unit("Unit summary", "unit", "0700.0063", "10.017", "Number of levels", "integer", { required: true, minimum: 1, maximum: 99 }),
  unit("Unit summary", "unit", "0700.0060", "10.018", "Floor identifier", "string", { maxLength: 3 }),
  unit("Unit summary", "unit", "0700.0058", "10.019", "Corner unit", "boolean"),
  unit("Unit summary", "unit", "0700.0070", "10.020", "Unit occupancy", "enum", { required: true, options: ["OwnerOccupied", "Tenant", "Vacant"] }),
  unit("Unit summary", "unit", "0700.0072", "10.021", "Utilities metered separately", "boolean", { showWhen: multipleUnitsOrAdu, requiredWhen: multipleUnitsOrAdu }),
  unit("Unit summary", "unit", "0700.0068", "10.022", "Utilities operating", "boolean", { showWhen: vacantGovernmentAssignment, requiredWhen: vacantGovernmentAssignment }),
  unit("Unit summary", "unit", "0700.0118", "10.023", "Bedrooms", "integer", { required: true, minimum: 0, maximum: 99 }),
  unit("Unit summary", "unit", "0700.0119", "10.024", "Full bathrooms", "integer", { required: true, minimum: 0, maximum: 99 }),
  unit("Unit summary", "unit", "0700.0120", "10.025", "Half bathrooms", "integer", { required: true, minimum: 0, maximum: 99 }),
  unit("Unit summary", "unit", "0700.0130", "10.026", "Mixed-use unit", "boolean", { showWhen: siteOwnedInCommon, requiredWhen: siteOwnedInCommon }),
  unit("Unit summary", "unit", "0700.0100", "10.027", "Live-work space allowed", "boolean", { showWhen: siteOwnedInCommon, requiredWhen: siteOwnedInCommon }),
  unit("Unit summary", "unit", "0700.0101", "10.028", "Allowed work-space area", "measurement", { showWhen: condition("unit:0700.0100", true), requiredWhen: condition("unit:0700.0100", true), units: ["SquareFeet"], minimum: 0 }),

  child("Levels", "unit_level", "0700.0030", "10.029", "Level", "enum", { required: true, options: LEVEL_TYPES }),
  child("Levels", "unit_level", "0700.0029", "10.030", "Grade level", "enum", { required: true, options: ["AboveGrade", "FullyBelowGrade", "PartiallyBelowGrade"] }),
  child("Levels", "unit_level", "0700.0026", "10.030", "Below-grade access", "enum", { showWhen: belowGradeLevel, requiredWhen: belowGradeLevel, options: ["ExteriorAccessOnly", "InteriorAccessOnly", "InteriorAndExteriorAccess"] }),
  child("Levels", "unit_level", "0700.0027", "10.030", "Below-grade exterior access", "enum", { showWhen: belowGradeExteriorAccess, requiredWhen: belowGradeExteriorAccess, options: ["CellarDoor", "Other", "WalkOut", "WalkUp"] }),
  child("Levels", "unit_level", "0700.0028", "10.030", "Other below-grade exterior access", "string", { maxLength: 36, showWhen: condition("unit_level:0700.0027", "Other"), requiredWhen: condition("unit_level:0700.0027", "Other") }),
  child("Levels", "unit_level", "0700.0137", "10.032", "Level finished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),
  child("Levels", "unit_level", "0700.0138", "10.032", "Level unfinished area", "measurement", { required: true, units: ["SquareFeet"], minimum: 0 }),

  child("Rooms", "unit_room", "0700.0035", "10.033", "Room type", "enum", { required: true, options: ROOM_TYPES }),
  child("Rooms", "unit_room", "0700.0087", "10.033", "Other room type", "string", { maxLength: 33, showWhen: condition("unit_room:0700.0035", "Other"), requiredWhen: condition("unit_room:0700.0035", "Other") }),
  child("Rooms", "unit_room", "0700.0121", "10.037", "Room level", "enum", { required: true, options: LEVEL_TYPES }),
  child("Rooms", "unit_room", "0700.0036", "10.038", "Room update status", "enum", { showWhen: roomRequiresDetail, requiredWhen: roomRequiresDetail, options: UAD_INTERIOR_ROOM_UPDATE_STATUS_TYPES }),
  child("Rooms", "unit_room", "0700.0034", "10.039", "Room update time frame", "enum", { showWhen: roomWasUpdated, requiredWhen: roomWasUpdated, options: ["FiveToTenYears", "LessThanOneYear", "OneToFiveYears", "TenOrMoreYears"] }),
  child("Rooms", "unit_room", "0700.0044", "10.040", "Room quality description", "string", { maxLength: 120, showWhen: roomRequiresDetail, requiredWhen: roomRequiresDetail }),
  child("Rooms", "unit_room", "0700.0033", "10.041", "Room condition", "enum", { showWhen: roomRequiresDetail, requiredWhen: roomRequiresDetail, options: ["DamagedAndFunctional", "DamagedAndNonfunctional", "NewOrLikeNew", "TypicalWearAndTear"] }),
  child("Rooms", "unit_room", "0700.0113", "10.042", "Room condition description", "string", { maxLength: 120, showWhen: roomRequiresDetail }),

  unit("Quality, condition, and accessibility", "unit", "0700.0067", "10.034", "Interior quality rating", "enum", { required: true, options: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"] }),
  unit("Quality, condition, and accessibility", "unit", "0700.0066", "10.035", "Interior condition rating", "enum", { required: true, options: ["C1", "C2", "C3", "C4", "C5", "C6"] }),
  unit("Quality, condition, and accessibility", "unit", "0700.0117", "10.043", "Overall bathroom update status", "enum", { required: true, options: UAD_INTERIOR_OVERALL_UPDATE_STATUS_TYPES }),
  unit("Quality, condition, and accessibility", "unit", "0700.0122", "10.049", "Overall flooring update status", "enum", { required: true, options: UAD_INTERIOR_OVERALL_UPDATE_STATUS_TYPES }),
  unit("Quality, condition, and accessibility", "unit_accessibility", "0700.0005", "10.050", "Accessibility features", "multi_enum", { required: true, options: UAD_UNIT_ACCESSIBILITY_TYPES }),
  unit("Quality, condition, and accessibility", "unit_accessibility", "0700.0006", "10.050", "Other accessibility feature", "string", { maxLength: 33, showWhen: { key: "unit_accessibility:0700.0005", contains: "Other" }, requiredWhen: { key: "unit_accessibility:0700.0005", contains: "Other" } }),
  unit("Quality, condition, and accessibility", "unit_accessibility", "0700.0007", "10.051", "Accessibility commentary", "text", { maxLength: 296 }),

  child("Interior features", "unit_interior_feature", "0700.0046", "10.044", "Feature", "enum", { required: true, options: UAD_INTERIOR_COMPONENT_TYPES }),
  child("Interior features", "unit_interior_feature", "0700.0047", "10.044", "Other feature label", "string", { maxLength: 36, showWhen: otherFeature, requiredWhen: otherFeature }),
  child("Interior features", "unit_interior_feature", "0700.0043", "10.044", "Other feature detail", "string", { maxLength: 70, showWhen: otherFeature }),
  child("Interior features", "unit_interior_feature", "0700.0041", "10.045", "Flooring type", "enum", { showWhen: flooringFeature, requiredWhen: flooringFeature, options: ["Carpet", "CeramicTile", "EngineeredWood", "FinishedConcrete", "Hardwood", "Laminate", "Marble", "Other", "SubflooringOnly", "Vinyl"] }),
  child("Interior features", "unit_interior_feature", "0700.0042", "10.045", "Other flooring type", "string", { maxLength: 36, showWhen: condition("unit_interior_feature:0700.0041", "Other"), requiredWhen: condition("unit_interior_feature:0700.0041", "Other") }),
  child("Interior features", "unit_interior_feature", "0700.0106", "10.046", "Flooring quality description", "string", { maxLength: 144, showWhen: flooringFeature, requiredWhen: flooringFeature }),
  child("Interior features", "unit_interior_feature", "0700.0104", "10.047", "Flooring condition", "enum", { showWhen: flooringFeature, requiredWhen: flooringFeature, options: ["DamagedAndFunctional", "DamagedAndNonfunctional", "NewOrLikeNew", "NoFinish", "TypicalWearAndTear"] }),
  child("Interior features", "unit_interior_feature", "0700.0111", "10.048", "Flooring condition description", "string", { maxLength: 144, showWhen: flooringFeature }),
  child("Interior features", "unit_interior_feature", "0700.0050", "10.044", "Approximate ceiling height", "enum", { showWhen: wallsFeature, requiredWhen: wallsFeature, options: ["EightFeet", "LessThanSevenFeet", "NineFeet", "SevenFeet", "TenFeetAndAbove", "TwoOrMoreStories"] }),
  child("Interior features", "unit_interior_feature", "0700.0108", "10.044", "Ceiling style", "enum", { showWhen: wallsFeature, requiredWhen: wallsFeature, options: ["Barrel", "Beams", "Cathedral", "Coffered", "Drop", "Flat", "Other", "Tray", "Vaulted"] }),
  child("Interior features", "unit_interior_feature", "0700.0109", "10.044", "Other ceiling style", "string", { maxLength: 36, showWhen: condition("unit_interior_feature:0700.0108", "Other"), requiredWhen: condition("unit_interior_feature:0700.0108", "Other") }),
  child("Interior features", "unit_interior_feature", "0700.0107", "10.044", "Feature quality description", "string", { maxLength: 144, showWhen: { any: [wallsFeature, otherFeature] }, requiredWhen: { any: [wallsFeature, otherFeature] } }),
  child("Interior features", "unit_interior_feature", "0700.0045", "10.044", "Feature condition", "enum", { showWhen: { any: [wallsFeature, otherFeature] }, requiredWhen: { any: [wallsFeature, otherFeature] }, options: ["DamagedAndFunctional", "DamagedAndNonfunctional", "NewOrLikeNew", "NoFinish", "TypicalWearAndTear"] }),
  child("Interior features", "unit_interior_feature", "0700.0112", "10.044", "Feature condition description", "string", { maxLength: 144, showWhen: { any: [wallsFeature, otherFeature] } }),

  unit("Apparent interior defects", "unit", "3900.0107", "10.055", "Interior defects exist", "boolean", { required: true }),
  child("Interior defects", "unit_interior_defect", "3900.0130", "10.056", "Defect feature", "enum", { required: true, options: ["Flooring", "Other", "WallsAndCeiling"] }),
  child("Interior defects", "unit_interior_defect", "3900.0131", "10.056", "Other defect feature", "string", { maxLength: 62, showWhen: condition("unit_interior_defect:3900.0130", "Other"), requiredWhen: condition("unit_interior_defect:3900.0130", "Other") }),
  child("Interior defects", "unit_interior_defect", "3900.0135", "10.057", "Defect location", "enum", { required: true, options: ["FullBathroom", "HalfBathroom", "Kitchen", "Other"] }),
  child("Interior defects", "unit_interior_defect", "3900.0160", "10.057", "Other defect location", "string", { maxLength: 31, showWhen: condition("unit_interior_defect:3900.0135", "Other"), requiredWhen: condition("unit_interior_defect:3900.0135", "Other") }),
  child("Interior defects", "unit_interior_defect", "3900.0133", "10.058", "Defect description", "text", { required: true, maxLength: 520 }),
  child("Interior defects", "unit_interior_defect", "3900.0132", "10.059", "Affects soundness or structural integrity", "boolean", { required: true }),
  child("Interior defects", "unit_interior_defect", "3900.0136", "10.060", "Recommended action", "enum", { required: true, options: ["Completion", "Inspection", "None", "Repair"] }),

  unit("Unit interior commentary", "unit", "0700.0115", "10.061", "Unit interior commentary", "text", { maxLength: 5000 }),
];
