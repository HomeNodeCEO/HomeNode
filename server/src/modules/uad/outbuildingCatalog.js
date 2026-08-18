const condition = (key, equals) => ({ key, equals });

const realProperty = Object.freeze(condition("outbuilding:0300.0024", true));
const manufacturedHome = Object.freeze(condition("outbuilding:0300.0025", "ManufacturedHome"));
const livingUnitsPresent = Object.freeze({
  all: [realProperty, { key: "outbuilding:0300.0063", greaterThan: 0 }],
});
const noLivingUnits = Object.freeze({
  all: [realProperty, condition("outbuilding:0300.0063", 0)],
});
const heatingProvided = Object.freeze({
  all: [
    livingUnitsPresent,
    { key: "outbuilding:0300.0088", present: true },
    { not: { key: "outbuilding:0300.0088", contains: "None" } },
  ],
});
const coolingProvided = Object.freeze({
  all: [livingUnitsPresent, condition("outbuilding:0300.0022", true)],
});
const finishedAreaExists = Object.freeze({
  all: [realProperty, { key: "outbuilding:0300.0112", greaterThan: 0 }],
});
const defectsExist = Object.freeze({
  all: [realProperty, condition("outbuilding:0300.0111", true)],
});

export const UAD_OUTBUILDING_TYPES = Object.freeze([
  "Barn", "Boathouse", "Bunkhouse", "EnclosedKennel", "Greenhouse", "GuestHouse",
  "IndoorRidingArena", "ManufacturedHome", "Office", "Other", "PoolHouse", "Shed",
  "Silo", "Stable", "StandaloneADU", "Studio", "Workshop",
]);

export const UAD_OUTBUILDING_ROOM_TYPES = Object.freeze([
  "Bedroom", "BreakfastRoom", "Den", "DiningRoom", "FamilyRoom", "FullBathroom",
  "HalfBathroom", "Kitchen", "LaundryRoom", "LivingRoom", "Loft", "MediaRoom",
  "Mudroom", "Other", "RecreationRoom", "Sunroom", "UtilityRoom", "WalkInPantry",
  "Workshop",
]);

const field = (contextKey, entityType, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "outbuilding",
  group: entityType === "outbuilding"
    ? "Outbuildings"
    : entityType === "outbuilding_room"
      ? "Finished room summary"
      : "Apparent outbuilding defects",
  contextKey,
  entityType,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const outbuilding = (uid, reportFieldId, label, dataType, options = {}) => (
  field("outbuilding", "outbuilding", uid, reportFieldId, label, dataType, options)
);
const room = (uid, reportFieldId, label, dataType, options = {}) => (
  field("outbuilding_room", "outbuilding_room", uid, reportFieldId, label, dataType, options)
);
const defect = (uid, reportFieldId, label, dataType, options = {}) => (
  field("outbuilding_defect", "outbuilding_defect", uid, reportFieldId, label, dataType, options)
);

export const UAD_OUTBUILDING_ENTITY_GROUPS = Object.freeze({
  outbuilding: {
    title: "Outbuildings",
    addLabel: "Add outbuilding",
    minItems: 0,
  },
  outbuilding_room: {
    title: "Finished room summary",
    addLabel: "Add finished room type",
    minItems: 0,
    parentEntityType: "outbuilding",
    showWhen: finishedAreaExists,
  },
  outbuilding_defect: {
    title: "Apparent outbuilding defects",
    addLabel: "Add outbuilding defect",
    minItems: 0,
    parentEntityType: "outbuilding",
    showWhen: defectsExist,
  },
});

export const UAD_OUTBUILDING_CAPTION_TYPES = Object.freeze([
  "OutbuildingFront",
  "OutbuildingInterior",
  "OutbuildingRear",
  "OutbuildingRoom",
  "ManufacturedHomeFoundation",
  "OutbuildingExhibit",
  "OutbuildingDefect",
]);

export const UAD_OUTBUILDING_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export function isVerifiedOutbuildingAsset(asset, captionType, entityId = null) {
  return asset?.section_number === 12
    && asset?.status === "verified"
    && asset?.caption_type === captionType
    && (!entityId || asset?.entity_id === entityId)
    && UAD_OUTBUILDING_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_OUTBUILDING_FIELDS = Object.freeze([
  outbuilding("0300.0025", "12.001", "Outbuilding type", "enum", {
    required: true,
    options: UAD_OUTBUILDING_TYPES,
  }),
  outbuilding("0300.0026", "12.001", "Other outbuilding type description", "string", {
    maxLength: 21,
    showWhen: condition("outbuilding:0300.0025", "Other"),
    requiredWhen: condition("outbuilding:0300.0025", "Other"),
  }),
  outbuilding("0300.0024", "12.002", "Considered real property", "boolean", { required: true }),
  outbuilding("0300.0063", "12.003", "Units in structure", "integer", {
    minimum: 0,
    maximum: 99,
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0500.0007", "12.004", "Attached to a permanent foundation", "boolean", {
    showWhen: manufacturedHome,
    requiredWhen: manufacturedHome,
  }),
  outbuilding("0300.0073", "12.005", "Structure volume", "measurement", {
    units: ["CubicFeet"],
    minimumExclusive: 0,
    showWhen: realProperty,
  }),
  outbuilding("0300.0060", "12.006", "Gross building area", "measurement", {
    units: ["SquareFeet"],
    minimumExclusive: 0,
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0023", "12.008", "Permanent heating system exists", "boolean", {
    showWhen: noLivingUnits,
    requiredWhen: noLivingUnits,
  }),
  outbuilding("0300.0022", "12.009 / 12.016", "Permanent cooling system exists", "boolean", {
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0028", "12.010", "Utilities", "multi_enum", {
    options: ["Electricity", "Gas", "None", "Other", "SanitarySewer", "Water"],
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0029", "12.010", "Other utility description", "string", {
    maxLength: 28,
    showWhen: { all: [realProperty, { key: "outbuilding:0300.0028", contains: "Other" }] },
    requiredWhen: { all: [realProperty, { key: "outbuilding:0300.0028", contains: "Other" }] },
  }),
  outbuilding("0300.0112", "12.011", "Finished area excluding vehicle storage and ADU", "measurement", {
    units: ["SquareFeet"],
    minimum: 0,
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0113", "12.013", "Unfinished area excluding vehicle storage and ADU", "measurement", {
    units: ["SquareFeet"],
    minimum: 0,
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0088", "12.014", "Heating system types", "multi_enum", {
    options: ["Baseboard", "Fireplace", "ForcedWarmAir", "GravityAir", "MiniSplit", "None", "Other", "PassiveSolar", "Radiant", "Radiators", "Stove"],
    showWhen: livingUnitsPresent,
    requiredWhen: livingUnitsPresent,
  }),
  outbuilding("0300.0089", "12.014", "Other heating system description", "string", {
    maxLength: 19,
    showWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0088", contains: "Other" }] },
    requiredWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0088", contains: "Other" }] },
  }),
  outbuilding("0300.0086", "12.015", "Heating fuel types", "multi_enum", {
    options: ["Coal", "Electric", "Geothermal", "NaturalGas", "Oil", "Other", "Propane", "Solar", "Wood"],
    showWhen: heatingProvided,
    requiredWhen: heatingProvided,
  }),
  outbuilding("0300.0087", "12.015", "Other heating fuel description", "string", {
    maxLength: 31,
    showWhen: { all: [heatingProvided, { key: "outbuilding:0300.0086", contains: "Other" }] },
    requiredWhen: { all: [heatingProvided, { key: "outbuilding:0300.0086", contains: "Other" }] },
  }),
  outbuilding("0300.0083", "12.015", "Lack of permanent heating is typical", "boolean", {
    showWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0088", contains: "None" }] },
    requiredWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0088", contains: "None" }] },
  }),
  outbuilding("0300.0084", "12.016", "Cooling system types", "multi_enum", {
    options: ["Centralized", "Individual", "Other"],
    showWhen: coolingProvided,
    requiredWhen: coolingProvided,
  }),
  outbuilding("0300.0085", "12.016", "Other cooling system description", "string", {
    maxLength: 19,
    showWhen: { all: [coolingProvided, { key: "outbuilding:0300.0084", contains: "Other" }] },
    requiredWhen: { all: [coolingProvided, { key: "outbuilding:0300.0084", contains: "Other" }] },
  }),
  outbuilding("0300.0090", "12.017", "Other mechanical systems", "multi_enum", {
    options: ["Other", "RadonMitigation", "SumpPump", "WaterHeater", "WholeHouseWaterTreatment"],
    showWhen: livingUnitsPresent,
  }),
  outbuilding("0300.0091", "12.017", "Other mechanical system description", "string", {
    maxLength: 33,
    showWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0090", contains: "Other" }] },
    requiredWhen: { all: [livingUnitsPresent, { key: "outbuilding:0300.0090", contains: "Other" }] },
  }),
  outbuilding("0300.0111", "12.019", "Defects, damages, or deficiencies exist", "boolean", {
    showWhen: realProperty,
    requiredWhen: realProperty,
  }),
  outbuilding("0300.0096", "12.025", "Outbuilding commentary", "text", { maxLength: 5000 }),

  room("0300.0018", "12.012", "Room type", "enum", {
    required: true,
    options: UAD_OUTBUILDING_ROOM_TYPES,
  }),
  room("0300.0019", "12.012", "Other room type description", "string", {
    maxLength: 33,
    showWhen: condition("outbuilding_room:0300.0018", "Other"),
    requiredWhen: condition("outbuilding_room:0300.0018", "Other"),
  }),
  room("0300.0020", "12.012", "Room count", "integer", { required: true, minimum: 1, maximum: 99 }),

  defect("3900.0164", "12.020", "Defect feature", "enum", {
    required: true,
    options: ["ExteriorWallsAndTrim", "Flooring", "Foundation", "MechanicalSystem", "Other", "Roof", "WallsAndCeiling", "Windows"],
  }),
  defect("3900.0165", "12.020", "Other defect feature description", "string", {
    maxLength: 62,
    showWhen: condition("outbuilding_defect:3900.0164", "Other"),
    requiredWhen: condition("outbuilding_defect:3900.0164", "Other"),
  }),
  defect("3900.0169", "12.021", "Defect location", "enum", {
    required: true,
    options: ["FullBathroom", "HalfBathroom", "Kitchen", "Other"],
  }),
  defect("3900.0170", "12.021", "Other defect location description", "string", {
    maxLength: 31,
    showWhen: condition("outbuilding_defect:3900.0169", "Other"),
    requiredWhen: condition("outbuilding_defect:3900.0169", "Other"),
  }),
  defect("3900.0167", "12.022", "Defect description", "text", { required: true, maxLength: 520 }),
  defect("3900.0166", "12.023", "Affects structural soundness or livability", "boolean", { required: true }),
  defect("3900.0171", "12.024", "Required action", "enum", {
    required: true,
    options: ["Completion", "Inspection", "None", "Repair"],
  }),
]);

export {
  coolingProvided,
  defectsExist,
  finishedAreaExists,
  livingUnitsPresent,
  manufacturedHome,
  noLivingUnits,
  realProperty,
};
