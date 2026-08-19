const condition = (key, equals) => ({ key, equals });

export const UAD_EXTERIOR_COMPONENT_TYPES = Object.freeze([
  "ExteriorWallsAndTrim", "Foundation", "Other", "Roof", "Windows",
]);

export const UAD_EXTERIOR_WALL_MATERIAL_TYPES = Object.freeze([
  "Adobe", "Aluminum", "Asbestos", "Brick", "CementBoard", "ConcreteBlock",
  "EngineeredWood", "Glass", "Log", "Other", "PouredConcrete", "Steel", "Stone",
  "Stucco", "SyntheticStone", "SyntheticStucco", "Vinyl", "Wood",
]);

export const UAD_EXTERIOR_FOUNDATION_TYPES = Object.freeze([
  "Basement", "CrawlSpace", "Other", "PostAndPier", "Runner", "Slab",
]);

export const UAD_EXTERIOR_ROOF_MATERIAL_TYPES = Object.freeze([
  "Asbestos", "Asphalt", "CeramicTile", "Clay", "Composition", "Concrete", "Copper",
  "Metal", "Other", "Rubber", "Slate", "SolarShingles", "Synthetic", "TarAndGravel", "Wood",
]);

export const UAD_EXTERIOR_CONDITION_STATUS_TYPES = Object.freeze([
  "DamagedAndFunctional", "DamagedAndNonfunctional", "NewOrLikeNew", "TypicalWearAndTear",
]);

const subjectAttached = Object.freeze(condition("subject:0100.0020", "Attached"));
const subjectDetached = Object.freeze(condition("subject:0100.0020", "Detached"));
const homeownerMaintainsExterior = Object.freeze(condition("subject:0100.0046", true));
const rowhouseTownhouse = Object.freeze(condition("dwelling:0300.0032", "RowhouseTownhouse"));
const convertedAreaExists = Object.freeze(condition("dwelling:0300.0079", true));
const noncontinuousAreaExists = Object.freeze(condition("dwelling:0300.0114", true));
const dwellingDefectsExist = Object.freeze(condition("dwelling:3900.0097", true));
const governmentFhaOrUsda = Object.freeze({
  any: [
    condition("assignment:1000.0029", "FHA"),
    condition("assignment:1000.0029", "USDA"),
  ],
});
const heatingProvided = Object.freeze({
  all: [
    { key: "dwelling:0300.0088", present: true },
    { not: { key: "dwelling:0300.0088", contains: "None" } },
  ],
});

const dwelling = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "dwelling_exterior",
  group,
  contextKey,
  entityType: "dwelling",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const feature = (uid, reportFieldId, label, dataType, options = {}) => ({
  section: "dwelling_exterior",
  group: "Exterior feature details",
  contextKey: "dwelling_exterior_feature",
  entityType: "dwelling_exterior_feature",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const room = (uid, reportFieldId, label, dataType, options = {}) => ({
  section: "dwelling_exterior",
  group: "Noncontinuous finished rooms",
  contextKey: "dwelling_noncontinuous_room",
  entityType: "dwelling_noncontinuous_room",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const defect = (uid, reportFieldId, label, dataType, options = {}) => ({
  section: "dwelling_exterior",
  group: "Apparent exterior defects",
  contextKey: "dwelling_exterior_defect",
  entityType: "dwelling_exterior_defect",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_DWELLING_EXTERIOR_ENTITY_GROUPS = Object.freeze({
  dwelling: {
    title: "Dwellings",
    addLabel: "Add dwelling",
    minItems: 1,
    createEnabled: false,
  },
  dwelling_exterior_feature: {
    title: "Exterior feature details",
    addLabel: "Add exterior feature",
    minItems: 0,
    parentEntityType: "dwelling",
    showWhen: homeownerMaintainsExterior,
  },
  dwelling_noncontinuous_room: {
    title: "Noncontinuous finished rooms",
    addLabel: "Add finished room type",
    minItems: 0,
    parentEntityType: "dwelling",
  },
  dwelling_exterior_defect: {
    title: "Apparent exterior defects",
    addLabel: "Add exterior defect",
    minItems: 0,
    parentEntityType: "dwelling",
  },
});

export const UAD_DWELLING_EXTERIOR_CAPTION_TYPES = Object.freeze([
  "DwellingFront",
  "DwellingRear",
  "DwellingExteriorExhibit",
  "NoncontinuousArea",
]);

export const UAD_DWELLING_EXTERIOR_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

export function isVerifiedDwellingFrontAsset(asset, dwellingId = null) {
  return asset?.section_number === 8
    && asset?.status === "verified"
    && asset?.caption_type === "DwellingFront"
    && (!dwellingId || asset?.entity_id === dwellingId)
    && UAD_DWELLING_EXTERIOR_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_DWELLING_EXTERIOR_FIELDS = [
  dwelling("Dwelling identification and design", "dwelling", "0300.0101", "8.000", "Structure identifier", "string", {
    maxLength: 30,
    showWhen: { key: "subject:0100.0022", greaterThan: 1 },
    requiredWhen: { key: "subject:0100.0022", greaterThan: 1 },
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0063", "8.001", "Subject property units in structure", "integer", {
    required: true,
    minimum: 1,
    maximum: 99,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0032", "8.002", "Structure design", "enum", {
    options: ["Highrise", "Lowrise", "Midrise", "Other", "RowhouseTownhouse", "SemiDetached"],
    showWhen: subjectAttached,
    requiredWhen: subjectAttached,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0033", "8.002", "Other structure design", "string", {
    maxLength: 33,
    showWhen: condition("dwelling:0300.0032", "Other"),
    requiredWhen: condition("dwelling:0300.0032", "Other"),
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0064", "8.003", "Floors in building", "integer", {
    minimum: 1,
    maximum: 99,
    showWhen: { any: [condition("dwelling:0300.0032", "Highrise"), condition("dwelling:0300.0032", "Midrise")] },
    requiredWhen: { any: [condition("dwelling:0300.0032", "Highrise"), condition("dwelling:0300.0032", "Midrise")] },
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0030", "8.004", "Dwelling style", "enum", {
    options: [
      "AFrame", "Barn", "BiLevel", "Bungalow", "CapeCod", "Chalet", "Colonial", "Contemporary",
      "Cottage", "Craftsman", "EarthBerm", "Farmhouse", "GeodesicDome", "Georgian", "Log",
      "Mediterranean", "Modern", "NeoEclectic", "Other", "RaisedRanch", "Rambler", "Ranch",
      "Southwest", "Spanish", "SplitFoyerOrEntry", "SplitLevel", "Stilt", "Traditional", "Tudor", "Victorian",
    ],
    showWhen: subjectDetached,
    requiredWhen: subjectDetached,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0031", "8.004", "Other dwelling style", "string", {
    maxLength: 33,
    showWhen: condition("dwelling:0300.0030", "Other"),
    requiredWhen: condition("dwelling:0300.0030", "Other"),
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0117", "8.005", "Front door elevation", "enum", {
    required: true,
    options: [
      "GroundLevel", "UpToOneFoot", "OneToTwoFeet", "TwoToThreeFeet", "ThreeToFourFeet", "FourToFiveFeet",
      "FiveToSixFeet", "SixToSevenFeet", "SevenToEightFeet", "EightToNineFeet", "NineToTenFeet", "TenOrMoreFeet",
    ],
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0059", "8.006", "Townhouse end unit", "boolean", {
    showWhen: rowhouseTownhouse,
    requiredWhen: rowhouseTownhouse,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0070", "8.007", "Townhouse back-to-back unit", "boolean", {
    showWhen: rowhouseTownhouse,
    requiredWhen: rowhouseTownhouse,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0069", "8.008", "Units above or below townhouse", "boolean", {
    showWhen: rowhouseTownhouse,
    requiredWhen: rowhouseTownhouse,
  }),
  dwelling("Dwelling identification and design", "dwelling", "0300.0067", "8.009", "Townhouse unit location", "enum", {
    options: ["BottomUnit", "MiddleUnit", "TopUnit"],
    showWhen: { all: [rowhouseTownhouse, condition("dwelling:0300.0069", true)] },
    requiredWhen: { all: [rowhouseTownhouse, condition("dwelling:0300.0069", true)] },
  }),
  dwelling("Age and construction", "dwelling", "0300.0011", "8.010", "Year built", "year", {
    required: true,
    maxLength: 4,
  }),
  dwelling("Age and construction", "dwelling", "0300.0012", "8.010", "Year built estimated", "boolean", {
    required: true,
  }),
  dwelling("Age and construction", "dwelling", "0300.0034", "8.011", "Construction method", "enum", {
    options: ["Container", "Manufactured", "Modular", "OnFrameModular", "Other", "SiteBuilt", "ThreeDimensionalPrintingTechnology"],
    showWhen: {
      any: [
        subjectDetached,
        { all: [subjectAttached, { any: [rowhouseTownhouse, condition("dwelling:0300.0032", "SemiDetached"), condition("dwelling:0300.0032", "Other")] }] },
      ],
    },
    requiredWhen: {
      any: [
        subjectDetached,
        { all: [subjectAttached, { any: [rowhouseTownhouse, condition("dwelling:0300.0032", "SemiDetached"), condition("dwelling:0300.0032", "Other")] }] },
      ],
    },
  }),
  dwelling("Age and construction", "dwelling", "0300.0035", "8.011", "Other construction method", "string", {
    maxLength: 33,
    showWhen: condition("dwelling:0300.0034", "Other"),
    requiredWhen: condition("dwelling:0300.0034", "Other"),
  }),
  dwelling("Age and construction", "dwelling", "0300.0079", "8.012", "Converted area exists", "boolean", {
    required: true,
  }),
  dwelling("Age and construction", "dwelling", "0300.0077", "8.012", "Converted area original use", "enum", {
    options: ["Garage", "Other", "Patio", "Porch"],
    showWhen: convertedAreaExists,
    requiredWhen: convertedAreaExists,
  }),
  dwelling("Age and construction", "dwelling", "0300.0078", "8.012", "Other converted area original use", "string", {
    maxLength: 33,
    showWhen: condition("dwelling:0300.0077", "Other"),
    requiredWhen: condition("dwelling:0300.0077", "Other"),
  }),
  dwelling("Age and construction", "dwelling", "0300.0076", "8.013", "Converted area finish comparison", "enum", {
    options: ["Inferior", "Similar", "Superior"],
    showWhen: convertedAreaExists,
    requiredWhen: convertedAreaExists,
  }),
  dwelling("Age and construction", "dwelling", "0300.0074", "8.014", "Factory-built certification examined", "boolean", {
    showWhen: { any: [condition("dwelling:0300.0034", "Modular"), condition("dwelling:0300.0034", "OnFrameModular")] },
    requiredWhen: { any: [condition("dwelling:0300.0034", "Modular"), condition("dwelling:0300.0034", "OnFrameModular")] },
  }),
  dwelling("Age and construction", "dwelling", "0300.0073", "8.015", "Structure volume", "measurement", {
    units: ["CubicFeet"],
    minimumExclusive: 0,
  }),
  dwelling("Age and construction", "dwelling", "0300.0071", "8.016", "Window surface area", "measurement", {
    units: ["SquareFeet"],
    minimumExclusive: 0,
  }),
  dwelling("Age and construction", "dwelling", "0300.0058", "8.017", "Attic exists", "boolean", {
    showWhen: governmentFhaOrUsda,
    requiredWhen: governmentFhaOrUsda,
  }),
  dwelling("Age and construction", "dwelling_attic", "0300.0107", "8.017", "Attic accessible for observation", "boolean", {
    showWhen: { all: [governmentFhaOrUsda, condition("dwelling:0300.0058", true)] },
    requiredWhen: { all: [governmentFhaOrUsda, condition("dwelling:0300.0058", true)] },
  }),
  dwelling("Age and construction", "dwelling_attic", "0300.0108", "8.017", "Attic visual observation completed", "boolean", {
    showWhen: condition("dwelling_attic:0300.0107", true),
    requiredWhen: condition("dwelling_attic:0300.0107", true),
  }),
  dwelling("Age and construction", "dwelling", "0300.0041", "8.018", "Remaining economic life (years)", "integer", {
    minimum: 0,
    maximum: 999,
  }),
  dwelling("Age and construction", "dwelling", "0300.0039", "8.019", "Effective age (years)", "integer", {
    minimum: 0,
    maximum: 999,
  }),
  dwelling("Age and construction", "dwelling", "0300.0040", "8.020", "Remaining economic life commentary", "text", {
    maxLength: 2500,
  }),
  dwelling("Age and construction", "dwelling", "0300.0036", "8.021", "Effective age commentary", "text", {
    maxLength: 2500,
  }),
  dwelling("Exterior quality and condition", "dwelling", "1600.0005", "8.022", "Exterior quality rating", "enum", {
    options: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"],
    showWhen: homeownerMaintainsExterior,
    requiredWhen: homeownerMaintainsExterior,
  }),
  dwelling("Exterior quality and condition", "dwelling", "1600.0004", "8.023", "Exterior condition rating", "enum", {
    options: ["C1", "C2", "C3", "C4", "C5", "C6"],
    showWhen: homeownerMaintainsExterior,
    requiredWhen: homeownerMaintainsExterior,
  }),
  feature("0300.0055", "8.041", "Exterior feature", "enum", {
    required: true,
    options: UAD_EXTERIOR_COMPONENT_TYPES,
  }),
  feature("0300.0056", "8.041", "Other exterior feature", "string", {
    maxLength: 36,
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Other"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Other"),
  }),
  feature("0300.0098", "8.025", "Exterior wall materials", "multi_enum", {
    options: UAD_EXTERIOR_WALL_MATERIAL_TYPES,
    showWhen: condition("dwelling_exterior_feature:0300.0055", "ExteriorWallsAndTrim"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "ExteriorWallsAndTrim"),
  }),
  feature("0300.0099", "8.025", "Other exterior wall material", "string", {
    maxLength: 36,
    showWhen: { key: "dwelling_exterior_feature:0300.0098", contains: "Other" },
    requiredWhen: { key: "dwelling_exterior_feature:0300.0098", contains: "Other" },
  }),
  feature("0300.0075", "8.026", "Feature quality description", "text", { maxLength: 144 }),
  feature("0300.0054", "8.027", "Condition status", "enum", {
    options: UAD_EXTERIOR_CONDITION_STATUS_TYPES,
    showWhen: {
      any: [
        { not: condition("dwelling_exterior_feature:0300.0055", "Roof") },
        condition("dwelling_exterior_feature:0300.0049", true),
      ],
    },
    requiredWhen: {
      any: [
        { not: condition("dwelling_exterior_feature:0300.0055", "Roof") },
        condition("dwelling_exterior_feature:0300.0049", true),
      ],
    },
  }),
  feature("0300.0100", "8.028", "Condition description", "text", { maxLength: 144 }),
  feature("0300.0044", "8.029", "Foundation materials", "multi_enum", {
    options: ["Brick", "ConcreteBlock", "Metal", "Other", "PouredConcrete", "Stone", "Wood"],
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Foundation"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Foundation"),
  }),
  feature("0300.0045", "8.029", "Other foundation material", "string", {
    maxLength: 36,
    showWhen: { key: "dwelling_exterior_feature:0300.0044", contains: "Other" },
    requiredWhen: { key: "dwelling_exterior_feature:0300.0044", contains: "Other" },
  }),
  feature("0300.0046", "8.029", "Foundation types", "multi_enum", {
    options: UAD_EXTERIOR_FOUNDATION_TYPES,
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Foundation"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Foundation"),
  }),
  feature("0300.0047", "8.029", "Other foundation type", "string", {
    maxLength: 36,
    showWhen: { key: "dwelling_exterior_feature:0300.0046", contains: "Other" },
    requiredWhen: { key: "dwelling_exterior_feature:0300.0046", contains: "Other" },
  }),
  feature("0300.0080", "8.029", "Foundation accessible for observation", "boolean", {
    showWhen: { all: [governmentFhaOrUsda, { key: "dwelling_exterior_feature:0300.0046", contains: "CrawlSpace" }] },
    requiredWhen: { all: [governmentFhaOrUsda, { key: "dwelling_exterior_feature:0300.0046", contains: "CrawlSpace" }] },
  }),
  feature("0300.0081", "8.029", "Foundation visual observation completed", "boolean", {
    showWhen: condition("dwelling_exterior_feature:0300.0080", true),
    requiredWhen: condition("dwelling_exterior_feature:0300.0080", true),
  }),
  feature("0300.0049", "8.033", "Roof observable", "boolean", {
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
  }),
  feature("0300.0048", "8.033", "Roof estimated age", "enum", {
    options: ["LessThanOneYear", "OneToTenYears", "TenToTwentyYears", "TwentyOrMoreYears"],
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
  }),
  feature("0300.0050", "8.033", "Roof materials", "multi_enum", {
    options: UAD_EXTERIOR_ROOF_MATERIAL_TYPES,
    showWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
    requiredWhen: condition("dwelling_exterior_feature:0300.0055", "Roof"),
  }),
  feature("0300.0051", "8.033", "Other roof material", "string", {
    maxLength: 36,
    showWhen: { key: "dwelling_exterior_feature:0300.0050", contains: "Other" },
    requiredWhen: { key: "dwelling_exterior_feature:0300.0050", contains: "Other" },
  }),
  feature("0300.0052", "8.037", "Feature detail", "string", {
    maxLength: 70,
    showWhen: { any: [condition("dwelling_exterior_feature:0300.0055", "Windows"), condition("dwelling_exterior_feature:0300.0055", "Other")] },
    requiredWhen: { any: [condition("dwelling_exterior_feature:0300.0055", "Windows"), condition("dwelling_exterior_feature:0300.0055", "Other")] },
  }),
  dwelling("Noncontinuous finished area", "dwelling", "0300.0114", "8.046", "Noncontinuous finished area exists", "boolean", {
    required: true,
  }),
  dwelling("Noncontinuous finished area", "dwelling", "0300.0115", "8.047", "Noncontinuous finished area", "measurement", {
    units: ["SquareFeet"],
    minimumExclusive: 0,
    showWhen: noncontinuousAreaExists,
    requiredWhen: noncontinuousAreaExists,
  }),
  room("0300.0018", "8.048", "Room type", "enum", {
    required: true,
    options: ["Bedroom", "BreakfastRoom", "Den", "DiningRoom", "FamilyRoom", "FullBathroom", "HalfBathroom", "Kitchen", "LaundryRoom", "LivingRoom", "Loft", "MediaRoom", "Mudroom", "Other", "RecreationRoom", "Sunroom", "UtilityRoom", "WalkInPantry", "Workshop"],
  }),
  room("0300.0019", "8.048", "Other room type", "string", {
    maxLength: 33,
    showWhen: condition("dwelling_noncontinuous_room:0300.0018", "Other"),
    requiredWhen: condition("dwelling_noncontinuous_room:0300.0018", "Other"),
  }),
  room("0300.0020", "8.048", "Number of rooms", "integer", {
    required: true,
    minimum: 1,
    maximum: 99,
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0088", "8.049", "Heating systems", "multi_enum", {
    required: true,
    options: ["Baseboard", "Fireplace", "ForcedWarmAir", "GravityAir", "MiniSplit", "None", "Other", "PassiveSolar", "Radiant", "Radiators", "Stove"],
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0089", "8.049", "Other heating system", "string", {
    maxLength: 19,
    showWhen: { key: "dwelling:0300.0088", contains: "Other" },
    requiredWhen: { key: "dwelling:0300.0088", contains: "Other" },
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0083", "8.050", "Lack of heating typical for market", "boolean", {
    showWhen: { key: "dwelling:0300.0088", contains: "None" },
    requiredWhen: { key: "dwelling:0300.0088", contains: "None" },
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0086", "8.050", "Heating fuels", "multi_enum", {
    options: ["Coal", "Electric", "Geothermal", "NaturalGas", "Oil", "Other", "Propane", "Solar", "Wood"],
    showWhen: heatingProvided,
    requiredWhen: heatingProvided,
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0087", "8.050", "Other heating fuel", "string", {
    maxLength: 31,
    showWhen: { key: "dwelling:0300.0086", contains: "Other" },
    requiredWhen: { key: "dwelling:0300.0086", contains: "Other" },
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0022", "8.051", "Permanent cooling exists", "boolean", {
    required: true,
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0084", "8.051", "Cooling systems", "multi_enum", {
    options: ["Centralized", "Individual", "Other"],
    showWhen: condition("dwelling:0300.0022", true),
    requiredWhen: condition("dwelling:0300.0022", true),
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0085", "8.051", "Other cooling system", "string", {
    maxLength: 19,
    showWhen: { key: "dwelling:0300.0084", contains: "Other" },
    requiredWhen: { key: "dwelling:0300.0084", contains: "Other" },
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0116", "8.052", "Core heating system below grade", "boolean", {
    showWhen: heatingProvided,
    requiredWhen: heatingProvided,
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0090", "8.053", "Other mechanical systems", "multi_enum", {
    options: ["RadonMitigation", "SumpPump", "WaterHeater", "WholeHouseWaterTreatment", "Other"],
  }),
  dwelling("Mechanical system details", "dwelling", "0300.0091", "8.053", "Other mechanical system description", "string", {
    maxLength: 33,
    showWhen: { key: "dwelling:0300.0090", contains: "Other" },
    requiredWhen: { key: "dwelling:0300.0090", contains: "Other" },
  }),
  dwelling("Apparent defects, damages, and deficiencies", "dwelling", "3900.0097", "8.055", "Exterior defects exist", "boolean", {
    required: true,
  }),
  defect("3900.0060", "8.056", "Affected feature", "enum", {
    required: true,
    options: ["ExteriorWallsAndTrim", "Foundation", "MechanicalSystem", "Other", "Roof", "Windows"],
  }),
  defect("3900.0095", "8.056", "Other affected feature", "string", {
    maxLength: 62,
    showWhen: condition("dwelling_exterior_defect:3900.0060", "Other"),
    requiredWhen: condition("dwelling_exterior_defect:3900.0060", "Other"),
  }),
  defect("3900.0158", "8.057", "Location", "string", { required: true, maxLength: 31 }),
  defect("3900.0057", "8.058", "Description", "text", { required: true, maxLength: 520 }),
  defect("3900.0056", "8.059", "Affects soundness or structural integrity", "boolean", { required: true }),
  defect("3900.0059", "8.060", "Recommended action", "enum", {
    required: true,
    options: ["Completion", "Inspection", "None", "Repair"],
  }),
  dwelling("Dwelling exterior commentary", "dwelling", "0300.0096", "8.061", "Dwelling exterior commentary", "text", {
    maxLength: 5000,
  }),
];

export {
  convertedAreaExists,
  dwellingDefectsExist,
  heatingProvided,
  homeownerMaintainsExterior,
  noncontinuousAreaExists,
  subjectAttached,
  subjectDetached,
};
