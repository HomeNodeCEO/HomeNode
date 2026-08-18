const condition = (key, equals) => ({ key, equals });

const storageTypeIs = (...types) => Object.freeze({
  any: types.map((type) => condition("vehicle_storage:3200.0006", type)),
});

const garageOrCarport = storageTypeIs("Carport", "Garage");
const driveway = storageTypeIs("Driveway", "SharedDriveway");
const sharedProjectParking = storageTypeIs("CommonCarport", "OpenLot", "ParkingGarage");
const parkingCountRequired = Object.freeze({
  any: [
    storageTypeIs("Carport", "CommonCarport", "Garage", "OpenLot", "Other", "ParkingGarage"),
    {
      all: [
        driveway,
        condition("vehicle_storage:3200.0011", false),
      ],
    },
  ],
});
const surfaceMaterialOther = Object.freeze({
  all: [driveway, condition("vehicle_storage:3200.0008", "Other")],
});
const defectsExist = Object.freeze(condition("vehicle_storage:3200.0021", true));

export const UAD_VEHICLE_STORAGE_TYPES = Object.freeze([
  "Carport", "CommonCarport", "Driveway", "Garage", "None", "OpenLot",
  "Other", "ParkingGarage", "SharedDriveway",
]);

const field = (contextKey, entityType, group, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "vehicle_storage",
  group,
  contextKey,
  entityType,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const storage = (uid, reportFieldId, label, dataType, options = {}) => (
  field("vehicle_storage", "vehicle_storage", "Vehicle storage", uid, reportFieldId, label, dataType, options)
);
const root = (contextKey, group, uid, reportFieldId, label, dataType, options = {}) => (
  field(contextKey, null, group, uid, reportFieldId, label, dataType, options)
);
const defect = (uid, reportFieldId, label, dataType, options = {}) => (
  field("vehicle_storage_defect", "vehicle_storage_defect", "Apparent vehicle storage defects", uid, reportFieldId, label, dataType, options)
);

export const UAD_VEHICLE_STORAGE_ENTITY_GROUPS = Object.freeze({
  vehicle_storage: {
    title: "Vehicle storage",
    addLabel: "Add vehicle storage",
    minItems: 1,
  },
  vehicle_storage_defect: {
    title: "Apparent vehicle storage defects",
    addLabel: "Add vehicle storage defect",
    minItems: 0,
    parentEntityType: "vehicle_storage",
    showWhen: defectsExist,
  },
});

export const UAD_VEHICLE_STORAGE_CAPTION_TYPES = Object.freeze([
  "VehicleStorage",
  "VehicleStorageExhibit",
  "VehicleStorageDefect",
]);

export const UAD_VEHICLE_STORAGE_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export function isVerifiedVehicleStorageAsset(asset, captionType, entityId = null) {
  return asset?.section_number === 13
    && asset?.status === "verified"
    && asset?.caption_type === captionType
    && (!entityId || asset?.entity_id === entityId)
    && UAD_VEHICLE_STORAGE_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_VEHICLE_STORAGE_FIELDS = Object.freeze([
  storage("3200.0006", "13.000 / 13.001", "Storage type", "enum", {
    required: true,
    options: UAD_VEHICLE_STORAGE_TYPES,
  }),
  storage("3200.0007", "13.000 / 13.001", "Other storage type description", "string", {
    maxLength: 45,
    showWhen: condition("vehicle_storage:3200.0006", "Other"),
    requiredWhen: condition("vehicle_storage:3200.0006", "Other"),
  }),
  storage("3200.0011", "13.002", "Ten or more parking spaces", "boolean", {
    showWhen: driveway,
    requiredWhen: driveway,
  }),
  storage("3200.0010", "13.002", "Number of dedicated parking spaces", "integer", {
    minimum: 0,
    maximum: 99,
    showWhen: parkingCountRequired,
    requiredWhen: parkingCountRequired,
  }),
  storage("3200.0012", "13.002", "Parking space assignment", "enum", {
    options: ["Assigned", "Owned", "Unassigned"],
    showWhen: sharedProjectParking,
    requiredWhen: sharedProjectParking,
  }),
  storage("3200.0005", "13.003", "Attachment type", "enum", {
    options: ["Attached", "BuiltIn", "Detached"],
    showWhen: garageOrCarport,
    requiredWhen: garageOrCarport,
  }),
  storage("3200.0004", "13.003", "Vehicle storage area", "measurement", {
    units: ["SquareFeet"],
    minimumExclusive: 0,
    showWhen: garageOrCarport,
    requiredWhen: garageOrCarport,
  }),
  storage("3200.0008", "13.003", "Driveway surface material", "enum", {
    options: ["Asphalt", "Brick", "Cobblestone", "Concrete", "Dirt", "Gravel", "Other"],
    showWhen: driveway,
    requiredWhen: driveway,
  }),
  storage("3200.0009", "13.003", "Other surface material description", "string", {
    maxLength: 12,
    showWhen: surfaceMaterialOther,
    requiredWhen: surfaceMaterialOther,
  }),

  root(
    "vehicle_storage",
    "Vehicle storage condition",
    "3200.0021",
    "13.004",
    "Defects, damages, or deficiencies exist",
    "boolean",
  ),

  defect("3900.0183", "Does not display", "Defect location type", "enum", {
    required: true,
    options: ["Other"],
  }),
  defect("3900.0184", "13.006", "Defect location", "string", { required: true, maxLength: 31 }),
  defect("3900.0181", "13.007", "Defect description", "text", { required: true, maxLength: 520 }),
  defect("3900.0180", "13.008", "Affects soundness or structural integrity", "boolean", { required: true }),
  defect("3900.0185", "13.009", "Recommended action", "enum", {
    required: true,
    options: ["Completion", "Inspection", "None", "Repair"],
  }),

  root(
    "vehicle_storage_commentary",
    "Vehicle storage commentary",
    "3200.0018",
    "13.010",
    "Vehicle storage commentary",
    "text",
    { maxLength: 5000 },
  ),
]);

export {
  defectsExist,
  driveway,
  garageOrCarport,
  parkingCountRequired,
  sharedProjectParking,
  surfaceMaterialOther,
};
