const condition = (key, equals) => ({ key, equals });

export const UAD_SUBJECT_AMENITY_CATEGORIES = Object.freeze([
  "OutdoorAccessories",
  "OutdoorLiving",
  "WaterFeatures",
  "WholeHome",
  "Miscellaneous",
]);

export const UAD_SUBJECT_AMENITY_CATEGORY_LIMITS = Object.freeze({
  OutdoorAccessories: 6,
  OutdoorLiving: 6,
  WaterFeatures: 4,
  WholeHome: 8,
  Miscellaneous: 8,
});

export const UAD_SUBJECT_AMENITY_MATERIAL_TYPES = Object.freeze([
  "Asphalt", "Brick", "Composite", "Concrete", "Fiberglass", "Metal",
  "NaturalStone", "Other", "Pavers", "Vinyl", "Wood",
]);

export const UAD_SUBJECT_AMENITY_TYPES = Object.freeze({
  OutdoorAccessories: Object.freeze([
    "Fence", "IrrigationSystem", "OutdoorFireplace", "OutdoorKitchen",
    "OutdoorRidingRing", "SportsCourt",
  ]),
  OutdoorLiving: Object.freeze(["Balcony", "Deck", "Gazebo", "Patio", "Porch", "Portico"]),
  WaterFeatures: Object.freeze(["IngroundPool", "IngroundSpa", "OutdoorShower", "Sauna"]),
  WholeHome: Object.freeze([
    "ElectricVehicleChargingStation", "Elevator", "FireSuppressionSystem",
    "IndoorFireplace", "MultipleZoneHeatingVentilationAndAirConditioning",
    "SmartHomeSystem", "WholeHouseVentilation", "WoodStove",
  ]),
  Miscellaneous: Object.freeze(["Airstrip", "ClubMembership", "Other", "SharedLaundryFacilities"]),
});

export const UAD_SUBJECT_AMENITY_FIELD_KEYS = Object.freeze({
  OutdoorAccessories: Object.freeze({
    category: "amenity_outdoor_accessories:0200.0016",
    type: "amenity_outdoor_accessories:0200.0007",
  }),
  OutdoorLiving: Object.freeze({
    category: "amenity_outdoor_living:0200.0017",
    type: "amenity_outdoor_living:0200.0023",
    attachedToManufacturedHome: "amenity_outdoor_living:0200.0019",
  }),
  WaterFeatures: Object.freeze({
    category: "amenity_water_features:0200.0027",
    type: "amenity_water_features:0200.0032",
  }),
  WholeHome: Object.freeze({
    category: "amenity_whole_home:0200.0034",
    type: "amenity_whole_home:0200.0039",
  }),
  Miscellaneous: Object.freeze({
    category: "amenity_miscellaneous:0200.0041",
    type: "amenity_miscellaneous:0200.0046",
  }),
});

export const UAD_SUBJECT_AMENITY_CATEGORY_GROUPS = Object.freeze({
  "Outdoor accessories": Object.freeze({
    category: "OutdoorAccessories",
    addLabel: "Add outdoor accessory",
  }),
  "Outdoor living": Object.freeze({
    category: "OutdoorLiving",
    addLabel: "Add outdoor living amenity",
  }),
  "Water features": Object.freeze({
    category: "WaterFeatures",
    addLabel: "Add water feature",
  }),
  "Whole home": Object.freeze({
    category: "WholeHome",
    addLabel: "Add whole-home amenity",
  }),
  "Miscellaneous amenities": Object.freeze({
    category: "Miscellaneous",
    addLabel: "Add miscellaneous amenity",
  }),
});

export const UAD_SUBJECT_PROPERTY_AMENITIES_CAPTION_TYPES = Object.freeze([
  "SubjectPropertyAmenity",
  "SubjectPropertyAmenitiesExhibit",
  "SubjectPropertyAmenityDefect",
]);

export const UAD_SUBJECT_PROPERTY_AMENITIES_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SUBJECT_PROPERTY_AMENITIES_MAX_IMAGES = Object.freeze({
  SubjectPropertyAmenity: 2,
  SubjectPropertyAmenityDefect: 4,
});

export function isVerifiedSubjectPropertyAmenitiesAsset(asset, captionType, entityId = null) {
  return asset?.section_number === 14
    && asset?.status === "verified"
    && asset?.caption_type === captionType
    && (!entityId || asset?.entity_id === entityId)
    && UAD_SUBJECT_PROPERTY_AMENITIES_IMAGE_CONTENT_TYPES.includes(
      String(asset?.content_type || "").toLowerCase(),
    );
}

const amenitiesExist = Object.freeze(condition("subject_property_amenities:0200.0015", true));
const defectsExist = Object.freeze(condition("subject_property_amenities:0200.0053", true));

const field = (contextKey, entityType, group, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "subject_property_amenities",
  group,
  contextKey,
  entityType,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const root = (group, uid, reportFieldId, label, dataType, options = {}) => (
  field("subject_property_amenities", null, group, uid, reportFieldId, label, dataType, options)
);

const commentary = (uid, reportFieldId, label, dataType, options = {}) => (
  field("subject_property_amenities_commentary", null, "Subject property amenities commentary", uid, reportFieldId, label, dataType, options)
);

const amenity = (category, group, contextKey, uid, reportFieldId, label, dataType, options = {}) => (
  field(contextKey, "amenity", group, uid, reportFieldId, label, dataType, {
    entityDataFilter: { amenity_category: category },
    ...options,
  })
);

const defect = (uid, reportFieldId, label, dataType, options = {}) => (
  field(
    "subject_property_amenity_defect",
    "amenity_defect",
    "Apparent amenity defects, damages, and deficiencies",
    uid,
    reportFieldId,
    label,
    dataType,
    options,
  )
);

const typeIs = (contextKey, uid, ...types) => Object.freeze({
  any: types.map((type) => condition(`${contextKey}:${uid}`, type)),
});

function categoryFields({
  category,
  group,
  contextKey,
  categoryUid,
  typeUid,
  materialUid,
  materialOtherUid,
  areaUid,
  countUid,
  typeOtherUid,
  attachedUid,
  poolFeatureUid,
  poolFeatureOtherUid,
  requiredMaterialTypes = [],
  requiredAreaTypes = [],
  requiredCountTypes = [],
  countTypes = null,
}) {
  const amenityTypeIs = (...types) => typeIs(contextKey, typeUid, ...types);
  const fields = [
    amenity(category, group, contextKey, categoryUid, "14.001", "Amenity category", "enum", {
      required: true,
      options: [category],
    }),
    amenity(category, group, contextKey, typeUid, "14.002 / 14.006", "Subject property amenity", "enum", {
      required: true,
      options: UAD_SUBJECT_AMENITY_TYPES[category],
    }),
  ];

  if (typeOtherUid) {
    fields.push(amenity(
      category,
      group,
      contextKey,
      typeOtherUid,
      "14.002 / 14.006",
      "Other amenity description",
      "string",
      {
        maxLength: 33,
        showWhen: amenityTypeIs("Other"),
        requiredWhen: amenityTypeIs("Other"),
      },
    ));
  }

  fields.push(
    amenity(category, group, contextKey, materialUid, "14.003", "Predominant material", "enum", {
      options: UAD_SUBJECT_AMENITY_MATERIAL_TYPES,
      requiredWhen: requiredMaterialTypes.length ? amenityTypeIs(...requiredMaterialTypes) : undefined,
    }),
    amenity(category, group, contextKey, materialOtherUid, "14.003", "Other material description", "string", {
      maxLength: 45,
      showWhen: condition(`${contextKey}:${materialUid}`, "Other"),
      requiredWhen: condition(`${contextKey}:${materialUid}`, "Other"),
    }),
    amenity(category, group, contextKey, areaUid, "14.004", "Amenity area", "measurement", {
      units: ["SquareFeet"],
      minimumExclusive: 0,
      maximum: 999999,
      requiredWhen: requiredAreaTypes.length ? amenityTypeIs(...requiredAreaTypes) : undefined,
    }),
  );

  if (countUid) {
    fields.push(amenity(category, group, contextKey, countUid, "14.004", "Amenity count", "integer", {
      minimum: 1,
      maximum: 99,
      showWhen: countTypes ? amenityTypeIs(...countTypes) : undefined,
      requiredWhen: requiredCountTypes.length ? amenityTypeIs(...requiredCountTypes) : undefined,
    }));
  }

  if (attachedUid) {
    fields.push(amenity(
      category,
      group,
      contextKey,
      attachedUid,
      "14.004",
      "Attached to manufactured home",
      "boolean",
      {
        showWhen: amenityTypeIs("Deck", "Gazebo", "Porch", "Portico"),
        manufacturedHomeConditional: true,
      },
    ));
  }

  if (poolFeatureUid) {
    const poolTypes = amenityTypeIs("IngroundPool", "IngroundSpa", "Sauna");
    fields.push(
      amenity(category, group, contextKey, poolFeatureUid, "14.004", "Amenity features", "multi_enum", {
        options: ["Caged", "Heated", "Indoor", "Other"],
        showWhen: poolTypes,
      }),
      amenity(category, group, contextKey, poolFeatureOtherUid, "14.004", "Other amenity feature description", "string", {
        maxLength: 45,
        showWhen: {
          all: [poolTypes, { key: `${contextKey}:${poolFeatureUid}`, contains: "Other" }],
        },
        requiredWhen: { key: `${contextKey}:${poolFeatureUid}`, contains: "Other" },
      }),
    );
  }
  return fields;
}

export const UAD_SUBJECT_PROPERTY_AMENITIES_ENTITY_GROUPS = Object.freeze({
  amenity: {
    title: "Subject property amenities",
    addLabel: "Add amenity",
    minItems: 0,
    maxItems: 32,
    showWhen: amenitiesExist,
    variants: Object.freeze(Object.fromEntries(
      Object.entries(UAD_SUBJECT_AMENITY_CATEGORY_GROUPS).map(([group, value]) => [group, {
        addLabel: value.addLabel,
        minItems: 0,
        maxItems: UAD_SUBJECT_AMENITY_CATEGORY_LIMITS[value.category],
        showWhen: amenitiesExist,
        entityDataFilter: { amenity_category: value.category },
        createData: { amenity_category: value.category },
      }]),
    )),
  },
  amenity_defect: {
    title: "Apparent amenity defects, damages, and deficiencies",
    addLabel: "Add amenity defect",
    minItems: 0,
    maxItems: 6,
    parentEntityType: "amenity",
    showWhen: defectsExist,
  },
});

export const UAD_SUBJECT_PROPERTY_AMENITIES_FIELDS = Object.freeze([
  root("Property amenities", "0200.0015", "14.000", "Property amenities exist", "boolean", { required: true }),

  ...categoryFields({
    category: "OutdoorAccessories",
    group: "Outdoor accessories",
    contextKey: "amenity_outdoor_accessories",
    categoryUid: "0200.0016",
    typeUid: "0200.0007",
    materialUid: "0200.0005",
    materialOtherUid: "0200.0006",
    areaUid: "0200.0054",
    countUid: "0200.0004",
  }),
  ...categoryFields({
    category: "OutdoorLiving",
    group: "Outdoor living",
    contextKey: "amenity_outdoor_living",
    categoryUid: "0200.0017",
    typeUid: "0200.0023",
    materialUid: "0200.0021",
    materialOtherUid: "0200.0022",
    areaUid: "0200.0025",
    attachedUid: "0200.0019",
    requiredMaterialTypes: ["Balcony", "Deck", "Gazebo", "Patio", "Porch"],
    requiredAreaTypes: ["Balcony", "Deck", "Gazebo", "Porch", "Portico"],
  }),
  ...categoryFields({
    category: "WaterFeatures",
    group: "Water features",
    contextKey: "amenity_water_features",
    categoryUid: "0200.0027",
    typeUid: "0200.0032",
    materialUid: "0200.0030",
    materialOtherUid: "0200.0031",
    areaUid: "0200.0056",
    countUid: "0200.0029",
    countTypes: ["OutdoorShower"],
    poolFeatureUid: "0200.0012",
    poolFeatureOtherUid: "0200.0013",
    requiredMaterialTypes: ["IngroundPool"],
  }),
  ...categoryFields({
    category: "WholeHome",
    group: "Whole home",
    contextKey: "amenity_whole_home",
    categoryUid: "0200.0034",
    typeUid: "0200.0039",
    materialUid: "0200.0037",
    materialOtherUid: "0200.0038",
    areaUid: "0200.0058",
    countUid: "0200.0036",
    requiredCountTypes: ["IndoorFireplace", "WoodStove"],
  }),
  ...categoryFields({
    category: "Miscellaneous",
    group: "Miscellaneous amenities",
    contextKey: "amenity_miscellaneous",
    categoryUid: "0200.0041",
    typeUid: "0200.0046",
    typeOtherUid: "0200.0047",
    materialUid: "0200.0044",
    materialOtherUid: "0200.0045",
    areaUid: "0200.0060",
    countUid: "0200.0043",
  }),

  root(
    "Amenities condition",
    "0200.0053",
    "14.005",
    "Subject property amenities defects exist",
    "boolean",
    { showWhen: amenitiesExist, requiredWhen: amenitiesExist },
  ),

  defect("3900.0141", "Does not display", "Defect location type", "enum", {
    required: true,
    options: ["Other"],
  }),
  defect("3900.0161", "14.007", "Defect location", "string", { required: true, maxLength: 31 }),
  defect("3900.0139", "14.008", "Defect description", "text", { required: true, maxLength: 520 }),
  defect("3900.0138", "14.009", "Affects soundness or structural integrity", "boolean", { required: true }),
  defect("3900.0142", "14.010", "Recommended action", "enum", {
    required: true,
    options: ["Completion", "Inspection", "None", "Repair"],
  }),

  commentary("0200.0063", "14.011", "Subject property amenities commentary", "text", {
    maxLength: 5000,
    showWhen: amenitiesExist,
  }),
]);

export {
  amenitiesExist,
  defectsExist,
};
