const impactOptions = ["Adverse", "Beneficial", "Neutral"];

const condition = (key, equals) => ({ key, equals });
const bodyOfWaterInfluence = condition("site_influence:1500.0087", "BodyOfWater");
const privateWaterAccess = condition("site_influence:1500.0075", true);

export const UAD_SITE_CAPTION_TYPES = Object.freeze([
  "PropertyAccess", "PropertyPhoto", "SiteInfluence", "View", "SiteCharacteristic",
  "PropertyBoundaries", "Encroachment", "WaterFrontage", "NonResidentialUse", "SiteExhibit",
]);

export const UAD_SITE_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SITE_ENTITY_GROUPS = Object.freeze({
  site_parcel: { title: "Parcels", addLabel: "Add parcel", minItems: 0 },
  site_influence: { title: "Location and site influences", addLabel: "Add influence", minItems: 0 },
  site_body_of_water: {
    title: "Bodies of water",
    addLabel: "Add body of water",
    minItems: 0,
    maxItems: 20,
    parentEntityType: "site_influence",
    showWhen: bodyOfWaterInfluence,
  },
  site_waterfront_feature: {
    title: "Permanent waterfront features",
    addLabel: "Add permanent waterfront feature",
    minItems: 0,
    maxItems: 10,
    parentEntityType: "site_body_of_water",
    showWhen: privateWaterAccess,
  },
  site_view: { title: "Views", addLabel: "Add view", minItems: 0 },
  site_encumbrance: { title: "Restrictions, easements, and encroachments", addLabel: "Add encumbrance", minItems: 0 },
  site_feature: { title: "Other site features", addLabel: "Add site feature", minItems: 0 },
  site_utility: { title: "Utilities", addLabel: "Add utility", minItems: 0 },
  site_defect: { title: "Site defects", addLabel: "Add defect", minItems: 0 },
});

export const UAD_SITE_FIELDS = [
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0093", reportFieldId: "4.000",
    label: "Total site size", dataType: "measurement", units: ["Acres", "Hectares", "SquareFeet", "SquareMeters"],
    requiredWhen: condition("subject:0100.0047", false), minimumExclusive: 0,
  },
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0160", reportFieldId: "4.001",
    label: "Site dimensions", dataType: "string", maxLength: 66,
  },
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0094", reportFieldId: "4.002",
    label: "Parcel count", dataType: "integer", requiredWhen: condition("subject:0100.0047", false), minimum: 1, maximum: 99,
  },
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0095", reportFieldId: "4.003",
    label: "All parcels are contiguous", dataType: "boolean", showWhen: { key: "site:1500.0094", greaterThan: 1 },
    requiredWhen: { key: "site:1500.0094", greaterThan: 1 },
  },
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0020", reportFieldId: "4.004",
    label: "Parcel separator", dataType: "enum", options: ["BodyOfWater", "Other", "OtherParcel", "Road"],
    showWhen: condition("site:1500.0095", false), requiredWhen: condition("site:1500.0095", false),
  },
  {
    section: "site", group: "Site overview", contextKey: "site", uid: "1500.0021", reportFieldId: "4.004",
    label: "Other parcel separator", dataType: "string", maxLength: 33,
    showWhen: condition("site:1500.0020", "Other"), requiredWhen: condition("site:1500.0020", "Other"),
  },
  {
    section: "site", group: "Zoning", contextKey: "site_zoning", uid: "1500.0125", reportFieldId: "4.008",
    label: "Zoning compliance", dataType: "enum", required: true, options: ["Illegal", "Legal", "LegalNonConforming", "NoZoning"],
  },
  {
    section: "site", group: "Zoning", contextKey: "site_zoning", uid: "1500.0122", reportFieldId: "4.009",
    label: "Zoning classification", dataType: "string", maxLength: 33,
    showWhen: { key: "site_zoning:1500.0125", notEquals: "NoZoning" }, requiredWhen: { key: "site_zoning:1500.0125", notEquals: "NoZoning" },
  },
  {
    section: "site", group: "Zoning", contextKey: "site_zoning", uid: "1500.0123", reportFieldId: "4.010",
    label: "Zoning description", dataType: "text", maxLength: 100,
    showWhen: { key: "site_zoning:1500.0125", notEquals: "NoZoning" }, requiredWhen: { key: "site_zoning:1500.0125", notEquals: "NoZoning" },
  },
  {
    section: "site", group: "Zoning", contextKey: "site_zoning", uid: "1500.0127", reportFieldId: "4.013",
    label: "Property may be rebuilt under current zoning", dataType: "boolean",
    showWhen: condition("site_zoning:1500.0125", "LegalNonConforming"),
  },
  {
    section: "site", group: "Zoning", contextKey: "site_zoning", uid: "1500.0124", reportFieldId: "4.014",
    label: "Zoning compliance explanation", dataType: "text", maxLength: 246,
    showWhen: { key: "site_zoning:1500.0125", notEquals: "Legal" }, requiredWhen: { key: "site_zoning:1500.0125", notEquals: "Legal" },
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0034", reportFieldId: "4.017",
    label: "Mixed-use property", dataType: "boolean", required: true,
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0036", reportFieldId: "4.015",
    label: "Use is primarily residential", dataType: "boolean", showWhen: condition("site_mixed_use:1500.0034", true),
    requiredWhen: condition("site_mixed_use:1500.0034", true),
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0037", reportFieldId: "4.016",
    label: "Residential use percentage", dataType: "percentage", showWhen: condition("site_mixed_use:1500.0034", true),
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0039", reportFieldId: "4.017",
    label: "Non-residential use", dataType: "multi_enum", options: ["Agricultural", "Commercial", "Industrial", "Other"],
    showWhen: condition("site_mixed_use:1500.0034", true), requiredWhen: condition("site_mixed_use:1500.0034", true),
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0040", reportFieldId: "4.017",
    label: "Other non-residential use", dataType: "string", maxLength: 33,
    showWhen: { key: "site_mixed_use:1500.0039", contains: "Other" }, requiredWhen: { key: "site_mixed_use:1500.0039", contains: "Other" },
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0032", reportFieldId: "4.018",
    label: "Non-residential use modified for residential use", dataType: "boolean", showWhen: condition("site_mixed_use:1500.0034", true),
  },
  {
    section: "site", group: "Mixed use", contextKey: "site_mixed_use", uid: "1500.0033", reportFieldId: "4.019",
    label: "Mixed-use description", dataType: "text", maxLength: 1250, showWhen: condition("site_mixed_use:1500.0034", true),
    requiredWhen: condition("site_mixed_use:1500.0034", true),
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0055", reportFieldId: "4.020",
    label: "Primary property access", dataType: "enum", required: true,
    options: ["Other", "PedestrianOnlyAccess", "PrivateAirstrip", "PrivateStreet", "PublicStreet", "Waterway"],
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0056", reportFieldId: "4.020",
    label: "Other primary access", dataType: "string", maxLength: 33,
    showWhen: condition("site_access:1500.0055", "Other"), requiredWhen: condition("site_access:1500.0055", "Other"),
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0047", reportFieldId: "4.021",
    label: "Access surface", dataType: "enum", options: ["Asphalt", "Brick", "Cobblestone", "Concrete", "Dirt", "Gravel", "Other"],
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0049", reportFieldId: "4.021",
    label: "Street type", dataType: "enum", options: ["Alley", "Arterial", "Collector", "CulDeSac", "DeadEnd", "Local", "Other", "Rural"],
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0052", reportFieldId: "4.022",
    label: "Private street has a maintenance agreement", dataType: "boolean", showWhen: condition("site_access:1500.0055", "PrivateStreet"),
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0054", reportFieldId: "4.023",
    label: "Access is typical for the market", dataType: "boolean", required: true,
  },
  {
    section: "site", group: "Access", contextKey: "site_access", uid: "1500.0053", reportFieldId: "4.024",
    label: "Access explanation", dataType: "text", maxLength: 300,
    showWhen: condition("site_access:1500.0054", false), requiredWhen: condition("site_access:1500.0054", false),
  },
  {
    section: "site", group: "Utilities and defects", contextKey: "site", uid: "1500.0166", reportFieldId: "4.067",
    label: "Broadband internet is available", dataType: "boolean", required: true,
  },
  {
    section: "site", group: "Utilities and defects", contextKey: "site", uid: "1500.0178", reportFieldId: "4.099",
    label: "Site defects exist", dataType: "boolean", required: true,
  },
  {
    section: "site", group: "Site commentary", contextKey: "site_commentary", uid: "0100.0044", reportFieldId: "4.116",
    label: "Additional site commentary", dataType: "text", maxLength: 5000,
  },

  { section: "site", entityType: "site_parcel", group: "Parcels", contextKey: "site_parcel", uid: "1500.0027", reportFieldId: "4.005", label: "Assessor parcel number", dataType: "string", required: true, maxLength: 60 },
  { section: "site", entityType: "site_parcel", group: "Parcels", contextKey: "site_parcel", uid: "1500.0023", reportFieldId: "4.006", label: "Parcel description", dataType: "enum", required: true, options: ["BoatSlip", "CondominiumUnit", "LandWithDwelling", "LandWithImprovement", "Other", "Parking", "Storage", "VacantLand"] },
  { section: "site", entityType: "site_parcel", group: "Parcels", contextKey: "site_parcel", uid: "1500.0024", reportFieldId: "4.006", label: "Other parcel description", dataType: "string", maxLength: 60, showWhen: condition("site_parcel:1500.0023", "Other"), requiredWhen: condition("site_parcel:1500.0023", "Other") },
  { section: "site", entityType: "site_parcel", group: "Parcels", contextKey: "site_parcel", uid: "1500.0022", reportFieldId: "4.007", label: "Parcel area", dataType: "measurement", required: true, units: ["Acres", "Hectares", "SquareFeet", "SquareMeters"], minimumExclusive: 0 },

  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0087", reportFieldId: "4.025", label: "Influence type", dataType: "enum", required: true, options: ["Agricultural", "Airport", "BodyOfWater", "BusyRoadway", "CommercialArea", "GolfCourse", "GreenSpace", "HighDensityResidential", "HighPressureGasLine", "HistoricDistrict", "IndustrialArea", "LocalDistributionLine", "OilOrGasWell", "Other", "OverheadElectricPowerTransmissionLine", "Park", "PublicTransportationHub", "RailLine", "Residential", "School", "StormwaterRetention"] },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0088", reportFieldId: "4.025", label: "Other influence type", dataType: "string", maxLength: 33, showWhen: condition("site_influence:1500.0087", "Other"), requiredWhen: condition("site_influence:1500.0087", "Other") },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0086", reportFieldId: "4.026", label: "Influence proximity", dataType: "enum", required: true, options: ["Bordering", "Offsite", "Onsite"] },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0015", reportFieldId: "4.026", label: "Distance to influence", dataType: "measurement", units: ["Feet", "Kilometers", "Meters", "Miles"], minimum: 0 },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0182", reportFieldId: "4.028", label: "Influence impact", dataType: "enum", required: true, options: impactOptions },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0181", reportFieldId: "4.029", label: "Influence description", dataType: "text", required: true, maxLength: 500 },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0092", reportFieldId: "4.033", label: "Right to build waterfront features", dataType: "boolean", showWhen: bodyOfWaterInfluence },
  { section: "site", entityType: "site_influence", group: "Location and site influences", contextKey: "site_influence", uid: "1500.0091", reportFieldId: "4.031", label: "Total private water frontage", dataType: "measurement", units: ["Feet", "Meters"], minimum: 0, maximum: 999999, showWhen: bodyOfWaterInfluence, guidance: "Enter the combined linear measurement for all bodies of water with private access." },

  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0073", reportFieldId: "4.034", label: "Body of water", dataType: "enum", required: true, options: ["Bay", "Canal", "Cove", "Creek", "Gulf", "Lake", "Marsh", "Ocean", "Other", "Pond", "Reservoir", "River", "Sound"] },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0074", reportFieldId: "4.034", label: "Other body of water", dataType: "string", maxLength: 21, showWhen: condition("site_influence:1500.0073", "Other"), requiredWhen: condition("site_influence:1500.0073", "Other") },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0075", reportFieldId: "Does Not Display", label: "Private access to this body of water", dataType: "boolean", required: true },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0072", reportFieldId: "4.035", label: "Body of water name", dataType: "string", maxLength: 45, showWhen: privateWaterAccess },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0197", reportFieldId: "4.037", label: "Waterfront access depth", dataType: "enum", options: ["DeepWater", "NonNavigable", "Other", "ShallowWater"], showWhen: privateWaterAccess, requiredWhen: privateWaterAccess },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0198", reportFieldId: "4.037", label: "Other waterfront access depth", dataType: "string", maxLength: 21, showWhen: condition("site_influence:1500.0197", "Other"), requiredWhen: condition("site_influence:1500.0197", "Other") },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0079", reportFieldId: "4.036", label: "Waterfront access rights", dataType: "enum", options: ["Deeded", "Other", "Permitted", "PrivatelyOwned"], showWhen: privateWaterAccess, requiredWhen: privateWaterAccess },
  { section: "site", entityType: "site_body_of_water", group: "Bodies of water", contextKey: "site_influence", uid: "1500.0080", reportFieldId: "4.036", label: "Other waterfront access rights", dataType: "string", maxLength: 45, showWhen: condition("site_influence:1500.0079", "Other"), requiredWhen: condition("site_influence:1500.0079", "Other") },

  { section: "site", entityType: "site_waterfront_feature", group: "Permanent waterfront features", contextKey: "site_influence", uid: "1500.0082", reportFieldId: "4.032", label: "Permanent waterfront feature", dataType: "enum", required: true, options: ["Beach", "BoatLift", "BoatRamp", "BoatSlip", "Dock", "None", "Other", "Pier", "Riprap", "SeawallOrBulkhead"] },
  { section: "site", entityType: "site_waterfront_feature", group: "Permanent waterfront features", contextKey: "site_influence", uid: "1500.0083", reportFieldId: "4.032", label: "Other permanent waterfront feature", dataType: "string", maxLength: 33, showWhen: condition("site_influence:1500.0082", "Other"), requiredWhen: condition("site_influence:1500.0082", "Other") },

  { section: "site", entityType: "site_view", group: "Views", contextKey: "site_view", uid: "1500.0117", reportFieldId: "4.039", label: "Primary view", dataType: "boolean", required: true },
  { section: "site", entityType: "site_view", group: "Views", contextKey: "site_view", uid: "1500.0120", reportFieldId: "4.039", label: "View type", dataType: "enum", required: true, options: ["Bay", "Canal", "CityStreet", "Commercial", "Cove", "Creek", "GolfCourse", "Gulf", "HighDensityResidential", "Highway", "Industrial", "Lake", "Marsh", "Mountain", "Ocean", "Other", "Park", "ParkingLot", "Pastoral", "Pond", "Reservoir", "Residential", "River", "School", "Skyline", "Sound", "TrafficWallBarriers", "Valley", "Woods"] },
  { section: "site", entityType: "site_view", group: "Views", contextKey: "site_view", uid: "1500.0121", reportFieldId: "4.039", label: "Other view type", dataType: "string", maxLength: 33, showWhen: condition("site_view:1500.0120", "Other"), requiredWhen: condition("site_view:1500.0120", "Other") },
  { section: "site", entityType: "site_view", group: "Views", contextKey: "site_view", uid: "1500.0118", reportFieldId: "4.040", label: "View range", dataType: "enum", required: true, options: ["Full", "Other", "Partial", "Seasonal"] },
  { section: "site", entityType: "site_view", group: "Views", contextKey: "site_view", uid: "1500.0184", reportFieldId: "4.041", label: "View impact", dataType: "enum", required: true, options: impactOptions },

  { section: "site", entityType: "site_encumbrance", group: "Restrictions, easements, and encroachments", contextKey: "site_encumbrance", uid: "1500.0012", reportFieldId: "4.050", label: "Encumbrance type", dataType: "enum", required: true, options: ["ConditionsCovenantsRestrictions", "Easement", "Encroachment"] },
  { section: "site", entityType: "site_encumbrance", group: "Restrictions, easements, and encroachments", contextKey: "site_encumbrance", uid: "1500.0171", reportFieldId: "4.053", label: "Encumbrance impact", dataType: "enum", required: true, options: impactOptions },
  { section: "site", entityType: "site_encumbrance", group: "Restrictions, easements, and encroachments", contextKey: "site_encumbrance", uid: "1500.0170", reportFieldId: "4.054", label: "Encumbrance description", dataType: "text", required: true, maxLength: 500 },

  { section: "site", entityType: "site_feature", group: "Other site features", contextKey: "site_feature", uid: "1500.0062", reportFieldId: "4.063", label: "Site feature", dataType: "enum", required: true, options: ["CoastalBarrierResourcesSystem", "Drainage", "ExcessLand", "Landlocked", "Landscaping", "None", "Other", "RoadFrontage", "Shape", "SoilSuitability", "SurplusLand", "Topography", "Wetlands", "ZeroLotLine"] },
  { section: "site", entityType: "site_feature", group: "Other site features", contextKey: "site_feature", uid: "1500.0063", reportFieldId: "4.063", label: "Other site feature", dataType: "string", maxLength: 33, showWhen: condition("site_feature:1500.0062", "Other"), requiredWhen: condition("site_feature:1500.0062", "Other") },
  { section: "site", entityType: "site_feature", group: "Other site features", contextKey: "site_feature", uid: "1500.0180", reportFieldId: "4.064", label: "Feature impact", dataType: "enum", required: true, options: impactOptions },
  { section: "site", entityType: "site_feature", group: "Other site features", contextKey: "site_feature", uid: "1500.0179", reportFieldId: "4.065", label: "Feature description", dataType: "text", required: true, maxLength: 500 },

  { section: "site", entityType: "site_utility", group: "Utilities", contextKey: "site_utility", uid: "1500.0104", reportFieldId: "4.069", label: "Utility type", dataType: "enum", required: true, options: ["Electricity", "Gas", "Other", "SanitarySewer", "Water"] },
  { section: "site", entityType: "site_utility", group: "Utilities", contextKey: "site_utility", uid: "1500.0102", reportFieldId: "4.070", label: "Utility ownership", dataType: "enum", required: true, options: ["NonPublic", "Public"] },
  { section: "site", entityType: "site_utility", group: "Utilities", contextKey: "site_utility", uid: "1500.0103", reportFieldId: "4.071", label: "Shared utility", dataType: "boolean", required: true },
  { section: "site", entityType: "site_utility", group: "Utilities", contextKey: "site_utility", uid: "1500.0183", reportFieldId: "4.072", label: "Utility impact", dataType: "enum", required: true, options: impactOptions },
  { section: "site", entityType: "site_utility", group: "Utilities", contextKey: "site_utility", uid: "1500.0132", reportFieldId: "4.073", label: "Utility description", dataType: "text", maxLength: 150 },

  { section: "site", entityType: "site_defect", group: "Site defects", contextKey: "site_defect", uid: "3900.0123", reportFieldId: "4.100", label: "Defective component", dataType: "string", required: true, maxLength: 66 },
  { section: "site", entityType: "site_defect", group: "Site defects", contextKey: "site_defect", uid: "3900.0159", reportFieldId: "4.101", label: "Defect location", dataType: "string", required: true, maxLength: 66 },
  { section: "site", entityType: "site_defect", group: "Site defects", contextKey: "site_defect", uid: "3900.0125", reportFieldId: "4.102", label: "Defect description", dataType: "text", required: true, maxLength: 520 },
  { section: "site", entityType: "site_defect", group: "Site defects", contextKey: "site_defect", uid: "3900.0124", reportFieldId: "4.103", label: "Affects soundness or structural integrity", dataType: "boolean", required: true },
  { section: "site", entityType: "site_defect", group: "Site defects", contextKey: "site_defect", uid: "3900.0128", reportFieldId: "4.104", label: "Required action", dataType: "enum", required: true, options: ["Completion", "Inspection", "None", "Repair"] },
];

export function isVerifiedSiteAsset(asset, captionType = null, entityId = undefined) {
  return asset?.section_number === 4
    && asset?.status === "verified"
    && UAD_SITE_CAPTION_TYPES.includes(asset?.caption_type)
    && (!captionType || asset?.caption_type === captionType)
    && (entityId === undefined || asset?.entity_id === entityId)
    && UAD_SITE_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}
