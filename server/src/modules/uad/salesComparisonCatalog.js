import { UAD_PROJECT_AMENITY_TYPES } from "./projectInformationCatalog.js";

export const UAD_SALES_COMPARISON_CAPTION_TYPES = Object.freeze([
  "PropertyPhoto",
  "SalesComparisonApproachExhibit",
]);

export const UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES = Object.freeze([
  "AssessorRecord",
  "BuilderOrDeveloper",
  "CondominiumQuestionnaire",
  "CooperativeBoard",
  "CooperativeQuestionnaire",
  "DataAggregator",
  "ExteriorInspection",
  "HomeownersAssociation",
  "InteriorInspection",
  "LandSurvey",
  "MLS",
  "Other",
  "PreviousAppraisalFile",
  "PropertyManagementCompany",
  "PropertyOwner",
  "RealEstateAgent",
]);

export const UAD_SALES_COMPARABLE_LISTING_STATUSES = Object.freeze([
  "Active",
  "OffMarket",
  "Pending",
  "SettledSale",
]);

export const UAD_SALES_COMPARABLE_DIRECTIONS = Object.freeze([
  "East", "North", "NorthEast", "NorthWest", "South", "SouthEast", "SouthWest", "West",
]);

export const UAD_SALES_COMPARABLE_FINANCING_TYPES = Object.freeze([
  "Conventional", "FHA", "Other", "Private", "USDARuralDevelopment", "VA",
]);

export const UAD_SALES_COMPARABLE_TRANSFER_TYPES = Object.freeze([
  "CourtOrderedNonForeclosureSale",
  "EstateSale",
  "ForeclosureSale",
  "LandSale",
  "Other",
  "PreSubdivisionSale",
  "RelocationSale",
  "REOSale",
  "SaleBetweenRelatedParties",
  "ShortSale",
  "TypicallyMotivated",
]);

export const UAD_SALES_COMPARABLE_PROPERTY_RIGHTS = Object.freeze([
  "FeeSimple", "Leasehold", "Other",
]);

export const UAD_NATIVE_AMERICAN_LAND_TYPES = Object.freeze([
  "AlaskaNativeCorporationLand", "HawaiianHomeLands", "Other", "TribalTrustLand",
]);

export const UAD_PROPERTY_RIGHTS_NOT_INCLUDED = Object.freeze([
  "AirRights", "MineralRights", "Other", "TimberRights", "WaterRights",
]);

export const UAD_SALES_COMPARABLE_HAZARD_TYPES = Object.freeze([
  "FEMASpecialFloodHazardArea", "None", "Other", "USGSLavaFlowZone",
]);

export const UAD_SALES_COMPARABLE_STREET_TYPES = Object.freeze([
  "Alley", "Arterial", "Collector", "CulDeSac", "DeadEnd", "Local", "Other", "Rural",
]);

export const UAD_SALES_COMPARABLE_SURFACE_TYPES = Object.freeze([
  "Asphalt", "Brick", "Cobblestone", "Concrete", "Dirt", "Gravel", "Other",
]);

export const UAD_SALES_COMPARABLE_RESTRICTION_TYPES = Object.freeze([
  "Age", "HistoricPreservation", "Income", "LandUse", "Other", "Rental", "SalePrice",
]);

export const UAD_SALES_COMPARABLE_EASEMENT_TYPES = Object.freeze([
  "Conservation", "Drainage", "IngressOrEgress", "Other", "Utility",
]);

export const UAD_SALES_COMPARABLE_SITE_FEATURE_TYPES = Object.freeze([
  "CoastalBarrierResourcesSystem", "Drainage", "ExcessLand", "Landlocked", "Landscaping",
  "None", "Other", "RoadFrontage", "Shape", "SoilSuitability", "SurplusLand",
  "Topography", "Wetlands", "ZeroLotLine",
]);

export const UAD_SALES_COMPARABLE_SITE_INFLUENCE_TYPES = Object.freeze([
  "Agricultural", "Airport", "BodyOfWater", "BusyRoadway", "CommercialArea", "GolfCourse",
  "GreenSpace", "HighDensityResidential", "HighPressureGasLine", "HistoricDistrict",
  "IndustrialArea", "LocalDistributionLine", "OilOrGasWell", "Other",
  "OverheadElectricPowerTransmissionLine", "Park", "PublicTransportationHub", "RailLine",
  "Residential", "School", "StormwaterRetention",
]);

export const UAD_SALES_COMPARABLE_BODY_OF_WATER_TYPES = Object.freeze([
  "Bay", "Canal", "Cove", "Creek", "Gulf", "Lake", "Marsh", "Ocean", "Other",
  "Pond", "Reservoir", "River", "Sound",
]);

export const UAD_SALES_COMPARABLE_ENVIRONMENTAL_TYPES = Object.freeze([
  "HazardousAboveGroundStorageTank", "HazardousSubstances", "Landfill", "None", "Other",
  "Radon", "SlushPit", "SoilContamination", "SuperfundSite", "UndergroundStorageTank",
  "WaterContamination",
]);

export const UAD_SALES_COMPARABLE_VIEW_TYPES = Object.freeze([
  "Bay", "Canal", "CityStreet", "Commercial", "Cove", "Creek", "GolfCourse", "Gulf",
  "HighDensityResidential", "Highway", "Industrial", "Lake", "Marsh", "Mountain", "Ocean",
  "Other", "Park", "ParkingLot", "Pastoral", "Pond", "Reservoir", "Residential", "River",
  "School", "Skyline", "Sound", "TrafficWallBarriers", "Valley", "Woods",
]);

export const salesComparisonIncluded = Object.freeze({
  key: "sales_comparison_scope:1000.0032",
  equals: true,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "sales_comparison",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const comparableGroup = "Sales comparables — general information";
const comp = (contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  comparableGroup,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { entityType: "sales_comparable", showWhen: salesComparisonIncluded, ...options },
);
const includedAnd = (condition) => Object.freeze({ all: [salesComparisonIncluded, condition] });
const comparableInProject = Object.freeze({
  key: "sales_comparable_project:1800.0378",
  equals: true,
});
const comparablePud = Object.freeze({
  key: "sales_comparable_project:1800.0383",
  equals: true,
});
const comparableProjectOrPud = Object.freeze({
  any: [comparableInProject, comparablePud],
});
const subjectInProject = Object.freeze({ key: "subject:2500.0168", present: true });
const projectComp = (contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  "Sales comparables — project information",
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { entityType: "sales_comparable", showWhen: salesComparisonIncluded, ...options },
);
const comparableSiteNotOwnedInCommon = Object.freeze({
  key: "sales_comparable_site:1800.0277",
  equals: false,
});
const siteComp = (contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  "Sales comparables — site information",
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { entityType: "sales_comparable", showWhen: salesComparisonIncluded, ...options },
);
const siteChild = (group, entityType, contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { entityType, ...options },
);
const statusIs = (value) => Object.freeze({
  key: "sales_comparable_listing:1800.0075",
  equals: value,
});
const pendingOrSettled = Object.freeze({
  any: [statusIs("Pending"), statusIs("SettledSale")],
});
const settled = statusIs("SettledSale");
const notSettled = Object.freeze({
  key: "sales_comparable_listing:1800.0075",
  notEquals: "SettledSale",
});

const adjustment = (contextKey, reportFieldId, label, condition = salesComparisonIncluded) => comp(
  contextKey,
  "1800.0317",
  reportFieldId,
  label,
  "currency",
  { showWhen: condition, maximum: 999999999 },
);
const siteAdjustment = (contextKey, reportFieldId, label) => siteComp(
  contextKey,
  "1800.0317",
  reportFieldId,
  label,
  "currency",
  { maximum: 999999999 },
);

export const UAD_SALES_COMPARISON_FIELDS = Object.freeze([
  field(
    "Approach scope",
    "sales_comparison_scope",
    "1000.0032",
    "Does Not Display",
    "Sales Comparison Approach developed by appraiser",
    "boolean",
    {
      required: true,
      guidance: "Choose Yes when this assignment will include the Sales Comparison Approach and its comparable grid.",
    },
  ),

  comp("sales_comparable_address", "1800.0001", "22.01.17", "Address line", "string", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 100,
  }),
  comp("sales_comparable_address", "1800.0002", "22.01.17", "Unit identifier", "string", {
    maxLength: 12,
  }),
  comp("sales_comparable_address", "1800.0400", "22.01.17", "Unit designator", "enum", {
    options: ["Unit"],
    showWhen: includedAnd({ key: "sales_comparable_address:1800.0002", present: true }),
    requiredWhen: { key: "sales_comparable_address:1800.0002", present: true },
  }),
  comp("sales_comparable_address", "1800.0003", "22.01.17", "City", "string", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 50,
  }),
  comp("sales_comparable_address", "1800.0005", "22.01.17", "State", "state", {
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_address", "1800.0004", "22.01.17", "ZIP code", "postal_code", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 10,
  }),
  comp("sales_comparable_property", "0100.0059", "Does Not Display", "Number of ADUs on property", "integer", {
    requiredWhen: salesComparisonIncluded,
    minimum: 0,
    maximum: 9,
    guidance: "Enter 0 when the comparable has no accessory dwelling units.",
  }),
  comp("sales_comparable_proximity", "1800.0065", "22.01.19", "Proximity to subject", "measurement", {
    requiredWhen: salesComparisonIncluded,
    units: ["Miles", "Kilometers"],
    minimum: 0,
    maximum: 999.99,
  }),
  comp("sales_comparable_proximity", "1800.0066", "22.01.19", "Direction from subject", "enum", {
    options: UAD_SALES_COMPARABLE_DIRECTIONS,
    showWhen: includedAnd({ key: "sales_comparable_proximity:1800.0065", greaterThan: 0 }),
    requiredWhen: { key: "sales_comparable_proximity:1800.0065", greaterThan: 0 },
  }),
  comp("sales_comparable_listing", "1800.0074", "22.01.20", "Last known list price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
  }),
  comp("sales_comparable_listing", "1800.0075", "22.01.21", "Listing status", "enum", {
    options: UAD_SALES_COMPARABLE_LISTING_STATUSES,
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_contract", "1800.0384", "22.01.22", "Contract price unknown", "boolean", {
    showWhen: includedAnd(statusIs("Pending")),
    requiredWhen: statusIs("Pending"),
  }),
  comp("sales_comparable_contract", "1800.0271", "22.01.22", "Contract price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ all: [statusIs("Pending"), { key: "sales_comparable_contract:1800.0384", equals: false }] }),
    requiredWhen: { all: [statusIs("Pending"), { key: "sales_comparable_contract:1800.0384", equals: false }] },
  }),
  comp("sales_comparable_sale", "1800.0272", "22.01.23", "Sale price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_sale", "1800.0274", "22.01.24", "Transfer terms", "enum", {
    options: UAD_SALES_COMPARABLE_TRANSFER_TYPES,
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_sale", "1800.0275", "22.01.24", "Other transfer terms", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_sale:1800.0274", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_sale:1800.0274", equals: "Other" },
  }),
  comp("sales_comparable_financing", "1800.0381", "22.01.26", "Transaction executed without financing", "boolean", {
    showWhen: includedAnd(settled),
  }),
  comp("sales_comparable_financing", "1800.0063", "22.01.26", "Primary financing type", "enum", {
    options: UAD_SALES_COMPARABLE_FINANCING_TYPES,
    showWhen: includedAnd({ key: "sales_comparable_financing:1800.0381", equals: false }),
    requiredWhen: { key: "sales_comparable_financing:1800.0381", equals: false },
  }),
  comp("sales_comparable_financing", "1800.0064", "22.01.26", "Other financing type", "string", {
    maxLength: 21,
    showWhen: includedAnd({ key: "sales_comparable_financing:1800.0063", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_financing:1800.0063", equals: "Other" },
  }),
  comp("sales_comparable_concessions", "1800.0370", "22.01.28", "Known sales concessions", "boolean", {
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_concessions", "1800.0369", "22.01.28", "Sales concession amount known", "boolean", {
    showWhen: includedAnd({ key: "sales_comparable_concessions:1800.0370", equals: true }),
    requiredWhen: { key: "sales_comparable_concessions:1800.0370", equals: true },
  }),
  comp("sales_comparable_concessions", "1800.0203", "22.01.28", "Total sales concessions", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ key: "sales_comparable_concessions:1800.0369", equals: true }),
    requiredWhen: { key: "sales_comparable_concessions:1800.0369", equals: true },
  }),
  comp("sales_comparable_contract", "1800.0385", "22.01.30", "Contract date unknown", "boolean", {
    showWhen: includedAnd(pendingOrSettled),
    requiredWhen: pendingOrSettled,
  }),
  comp("sales_comparable_contract", "1800.0202", "22.01.30", "Contract date", "date", {
    showWhen: includedAnd({ all: [pendingOrSettled, { key: "sales_comparable_contract:1800.0385", equals: false }] }),
    requiredWhen: { all: [pendingOrSettled, { key: "sales_comparable_contract:1800.0385", equals: false }] },
  }),
  comp("sales_comparable_sale", "1800.0342", "22.01.32", "Sale date", "date", {
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_listing", "1800.0189", "22.01.34", "Days on market", "integer", {
    requiredWhen: salesComparisonIncluded,
    minimum: 0,
    maximum: 9999,
  }),
  comp("sales_comparable_listing", "1800.0316", "22.01.35", "Sale to list price ratio", "percentage", {
    minimum: 0,
    maximum: 999,
    showWhen: includedAnd(notSettled),
  }),
  comp("sales_comparable_property", "1800.0195", "22.01.37", "Attached or detached", "enum", {
    options: ["Attached", "Detached"],
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_property", "1800.0337", "22.01.39", "Property rights appraised", "enum", {
    options: UAD_SALES_COMPARABLE_PROPERTY_RIGHTS,
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_property", "1800.0338", "22.01.39", "Other property rights", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0337", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_property:1800.0337", equals: "Other" },
  }),
  comp("sales_comparable_property", "1800.0077", "22.01.41", "Annual ground rent", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0337", equals: "Leasehold" }),
    requiredWhen: { key: "sales_comparable_property:1800.0337", equals: "Leasehold" },
  }),
  comp("sales_comparable_property", "1800.0357", "22.01.42", "Property on Native American lands", "boolean"),
  comp("sales_comparable_property", "1800.0358", "22.01.42", "Native American lands type", "enum", {
    options: UAD_NATIVE_AMERICAN_LAND_TYPES,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0357", equals: true }),
    requiredWhen: { key: "sales_comparable_property:1800.0357", equals: true },
  }),
  comp("sales_comparable_property", "1800.0359", "22.01.42", "Other Native American lands type", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0358", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_property:1800.0358", equals: "Other" },
  }),
  comp("sales_comparable_property", "1800.0201", "22.01.44", "All property rights included", "boolean"),
  comp("sales_comparable_property", "1800.0082", "22.01.47", "Same builder as subject", "boolean", {
    showWhen: includedAnd({ key: "subject:0300.0010", equals: true }),
    requiredWhen: { key: "subject:0300.0010", equals: true },
  }),

  adjustment("sales_comparable_adjustment_transfer_terms", "22.01.25", "Transfer terms adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_financing", "22.01.27", "Financing adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_concessions", "22.01.29", "Sales concessions adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_contract_date", "22.01.31", "Contract date adjustment", includedAnd(pendingOrSettled)),
  adjustment("sales_comparable_adjustment_sale_date", "22.01.33", "Sale date adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_sale_list_ratio", "22.01.36", "Sale to list price ratio adjustment", includedAnd(notSettled)),
  adjustment("sales_comparable_adjustment_attachment", "22.01.38", "Attached or detached adjustment"),
  adjustment("sales_comparable_adjustment_property_rights", "22.01.40", "Property rights adjustment"),
  adjustment("sales_comparable_adjustment_native_lands", "22.01.43", "Native American lands adjustment", includedAnd({ key: "sales_comparable_property:1800.0357", present: true })),
  adjustment("sales_comparable_adjustment_all_rights", "22.01.45", "All rights included adjustment", includedAnd({ key: "sales_comparable_property:1800.0201", present: true })),

  projectComp("sales_comparable_project", "1800.0383", "Does Not Display", "Property in a PUD", "boolean", {
    requiredWhen: salesComparisonIncluded,
  }),
  projectComp("sales_comparable_project", "1800.0378", "Does Not Display", "Property in a condominium, cooperative, or condop", "boolean", {
    requiredWhen: salesComparisonIncluded,
  }),
  projectComp("sales_comparable_project", "1800.0377", "Does Not Display", "Project legal structure", "enum", {
    options: ["Condominium", "Condop", "Cooperative"],
    showWhen: includedAnd(comparableInProject),
    requiredWhen: comparableInProject,
  }),
  projectComp("sales_comparable_project", "1800.0194", "22.02.06", "Project name", "string", {
    maxLength: 33,
    showWhen: includedAnd(comparableInProject),
    requiredWhen: comparableInProject,
  }),
  projectComp("sales_comparable_project", "1800.0083", "22.02.06", "Same project as subject", "boolean", {
    showWhen: includedAnd({ all: [comparableInProject, subjectInProject] }),
    requiredWhen: { all: [comparableInProject, subjectInProject] },
  }),
  projectComp("sales_comparable_project", "1800.0353", "22.02.07", "Mandatory monthly fee", "currency", {
    minimum: 0,
    maximum: 999999,
    showWhen: includedAnd(comparableProjectOrPud),
    requiredWhen: comparableProjectOrPud,
  }),
  projectComp("sales_comparable_project", "1800.0371", "22.02.09", "Special assessment status", "enum", {
    options: ["Existing", "None", "Proposed"],
    showWhen: includedAnd(comparableProjectOrPud),
    requiredWhen: comparableProjectOrPud,
  }),
  projectComp("sales_comparable_adjustment_project", "1800.0317", "22.02.05", "Project information adjustment", "currency", {
    maximum: 999999999,
    showWhen: includedAnd(comparableProjectOrPud),
  }),

  field(
    "Comparable project amenities and services",
    "sales_comparable_project_amenity",
    "1800.0056",
    "22.02.08",
    "Common amenity or service",
    "enum",
    {
      entityType: "sales_comparable_project_amenity",
      options: UAD_PROJECT_AMENITY_TYPES,
      required: true,
    },
  ),
  field(
    "Comparable project amenities and services",
    "sales_comparable_project_amenity",
    "1800.0057",
    "22.02.08",
    "Other common amenity or service",
    "string",
    {
      entityType: "sales_comparable_project_amenity",
      maxLength: 33,
      showWhen: { key: "sales_comparable_project_amenity:1800.0056", equals: "Other" },
      requiredWhen: { key: "sales_comparable_project_amenity:1800.0056", equals: "Other" },
    },
  ),

  siteComp("sales_comparable_site", "1800.0277", "22.03.18", "Site owned in common", "boolean", {
    requiredWhen: salesComparisonIncluded,
  }),
  siteComp("sales_comparable_site", "1800.0239", "22.03.20", "Total site size", "measurement", {
    units: ["Acres", "Hectares", "SquareFeet", "SquareMeters"],
    minimumExclusive: 0,
    showWhen: includedAnd(comparableSiteNotOwnedInCommon),
    requiredWhen: comparableSiteNotOwnedInCommon,
  }),
  siteComp("sales_comparable_site", "1800.0193", "22.03.22", "Neighborhood name", "string", {
    maxLength: 66,
  }),
  siteComp("sales_comparable_site", "1800.0245", "22.03.24", "Zoning compliance", "enum", {
    options: ["Illegal", "Legal", "LegalNonConforming", "NoZoning"],
  }),
  siteComp("sales_comparable_site", "1800.0218", "22.03.28", "Primary property access", "enum", {
    options: ["Other", "PedestrianOnlyAccess", "PrivateAirstrip", "PrivateStreet", "PublicStreet", "Waterway"],
    showWhen: includedAnd(comparableSiteNotOwnedInCommon),
  }),
  siteComp("sales_comparable_site", "1800.0219", "22.03.28", "Other primary property access", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_site:1800.0218", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_site:1800.0218", equals: "Other" },
  }),

  siteChild("Comparable hazard zones", "sales_comparable_site_hazard", "sales_comparable_site_hazard", "1800.0212", "22.03.26", "Hazard zone", "enum", {
    options: UAD_SALES_COMPARABLE_HAZARD_TYPES,
    required: true,
  }),
  siteChild("Comparable hazard zones", "sales_comparable_site_hazard", "sales_comparable_site_hazard", "1800.0213", "22.03.26", "Other hazard zone", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_hazard:1800.0212", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_hazard:1800.0212", equals: "Other" },
  }),
  siteChild("Comparable hazard zones", "sales_comparable_site_hazard", "sales_comparable_site_hazard", "1800.0367", "22.03.26", "USGS lava flow zone", "enum", {
    options: ["Zone1", "Zone2", "Zone3", "Zone4", "Zone5", "Zone6", "Zone7", "Zone8", "Zone9"],
    showWhen: { key: "sales_comparable_site_hazard:1800.0212", equals: "USGSLavaFlowZone" },
    requiredWhen: { key: "sales_comparable_site_hazard:1800.0212", equals: "USGSLavaFlowZone" },
  }),

  siteChild("Comparable access streets", "sales_comparable_site_street", "sales_comparable_site_street", "1800.0216", "22.03.30", "Street type", "enum", {
    options: UAD_SALES_COMPARABLE_STREET_TYPES,
    required: true,
  }),
  siteChild("Comparable access streets", "sales_comparable_site_street", "sales_comparable_site_street", "1800.0217", "22.03.30", "Other street type", "string", {
    maxLength: 12,
    showWhen: { key: "sales_comparable_site_street:1800.0216", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_street:1800.0216", equals: "Other" },
  }),
  siteChild("Comparable access streets", "sales_comparable_site_street", "sales_comparable_site_street", "1800.0214", "22.03.30", "Street surface material", "enum", {
    options: UAD_SALES_COMPARABLE_SURFACE_TYPES,
    required: true,
  }),
  siteChild("Comparable access streets", "sales_comparable_site_street", "sales_comparable_site_street", "1800.0215", "22.03.30", "Other street surface material", "string", {
    maxLength: 12,
    showWhen: { key: "sales_comparable_site_street:1800.0214", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_street:1800.0214", equals: "Other" },
  }),

  siteChild("Comparable property restrictions", "sales_comparable_site_restriction", "sales_comparable_site_restriction", "1800.0068", "22.03.32", "Property restriction", "enum", {
    options: UAD_SALES_COMPARABLE_RESTRICTION_TYPES,
    required: true,
  }),
  siteChild("Comparable property restrictions", "sales_comparable_site_restriction", "sales_comparable_site_restriction", "1800.0069", "22.03.32", "Other property restriction", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_restriction:1800.0068", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_restriction:1800.0068", equals: "Other" },
  }),
  siteChild("Comparable easements", "sales_comparable_site_easement", "sales_comparable_site_easement", "1800.0070", "22.03.34", "Easement", "enum", {
    options: UAD_SALES_COMPARABLE_EASEMENT_TYPES,
    required: true,
  }),
  siteChild("Comparable easements", "sales_comparable_site_easement", "sales_comparable_site_easement", "1800.0071", "22.03.34", "Other easement", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_easement:1800.0070", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_easement:1800.0070", equals: "Other" },
  }),

  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0222", "22.03.40", "Site characteristic", "enum", {
    options: UAD_SALES_COMPARABLE_SITE_FEATURE_TYPES,
    required: true,
  }),
  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0223", "22.03.40", "Other site characteristic", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Other" },
  }),
  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0225", "22.03.36", "Topography", "enum", {
    options: ["Flat", "Other", "Rocky", "Rolling", "Sloping"],
    showWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Topography" },
    requiredWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Topography" },
  }),
  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0226", "22.03.36", "Other topography", "string", {
    maxLength: 33,
    showWhen: { key: "sales_comparable_site_feature:1800.0225", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_feature:1800.0225", equals: "Other" },
  }),
  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0220", "22.03.38", "Drainage reason", "enum", {
    options: ["EvidenceOfErosion", "ImproperGrading", "Other", "StandingWater"],
    showWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Drainage" },
    requiredWhen: { key: "sales_comparable_site_feature:1800.0222", equals: "Drainage" },
  }),
  siteChild("Comparable site characteristics", "sales_comparable_site_feature", "sales_comparable_site_feature", "1800.0221", "22.03.38", "Other drainage reason", "string", {
    maxLength: 33,
    showWhen: { key: "sales_comparable_site_feature:1800.0220", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_feature:1800.0220", equals: "Other" },
  }),

  siteChild("Comparable site influences", "sales_comparable_site_influence", "sales_comparable_site_influence", "1800.0233", "22.03.42", "Site influence", "enum", {
    options: UAD_SALES_COMPARABLE_SITE_INFLUENCE_TYPES,
    required: true,
  }),
  siteChild("Comparable site influences", "sales_comparable_site_influence", "sales_comparable_site_influence", "1800.0234", "22.03.42", "Other site influence", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_influence:1800.0233", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_influence:1800.0233", equals: "Other" },
  }),
  siteChild("Comparable site influences", "sales_comparable_site_influence", "sales_comparable_site_influence", "1800.0228", "22.03.42", "Body of water", "enum", {
    options: UAD_SALES_COMPARABLE_BODY_OF_WATER_TYPES,
    showWhen: { key: "sales_comparable_site_influence:1800.0233", equals: "BodyOfWater" },
    requiredWhen: { key: "sales_comparable_site_influence:1800.0233", equals: "BodyOfWater" },
  }),
  siteChild("Comparable site influences", "sales_comparable_site_influence", "sales_comparable_site_influence", "1800.0229", "22.03.42", "Other body of water", "string", {
    maxLength: 21,
    showWhen: { key: "sales_comparable_site_influence:1800.0228", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_influence:1800.0228", equals: "Other" },
  }),

  siteChild("Comparable apparent environmental conditions", "sales_comparable_site_environmental", "sales_comparable_site_environmental", "1800.0116", "22.03.44", "Apparent environmental condition", "enum", {
    options: UAD_SALES_COMPARABLE_ENVIRONMENTAL_TYPES,
    required: true,
  }),
  siteChild("Comparable apparent environmental conditions", "sales_comparable_site_environmental", "sales_comparable_site_environmental", "1800.0117", "22.03.44", "Other apparent environmental condition", "string", {
    maxLength: 45,
    showWhen: { key: "sales_comparable_site_environmental:1800.0116", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_environmental:1800.0116", equals: "Other" },
  }),

  siteChild("Comparable views", "sales_comparable_site_view", "sales_comparable_site_view", "1800.0243", "22.03.46", "View", "enum", {
    options: UAD_SALES_COMPARABLE_VIEW_TYPES,
    required: true,
  }),
  siteChild("Comparable views", "sales_comparable_site_view", "sales_comparable_site_view", "1800.0244", "22.03.46", "Other view", "string", {
    maxLength: 27,
    showWhen: { key: "sales_comparable_site_view:1800.0243", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_view:1800.0243", equals: "Other" },
  }),
  siteChild("Comparable views", "sales_comparable_site_view", "sales_comparable_site_view", "1800.0242", "22.03.46", "View range", "enum", {
    options: ["Full", "Other", "Partial", "Seasonal"],
  }),
  siteChild("Comparable views", "sales_comparable_site_view", "sales_comparable_site_view", "1800.0250", "22.03.46", "Other view range", "string", {
    maxLength: 9,
    showWhen: { key: "sales_comparable_site_view:1800.0242", equals: "Other" },
    requiredWhen: { key: "sales_comparable_site_view:1800.0242", equals: "Other" },
  }),

  siteAdjustment("sales_comparable_adjustment_site_owned_common", "22.03.19", "Site owned in common adjustment"),
  siteAdjustment("sales_comparable_adjustment_site_size", "22.03.21", "Site size adjustment"),
  siteAdjustment("sales_comparable_adjustment_neighborhood", "22.03.23", "Neighborhood name adjustment"),
  siteAdjustment("sales_comparable_adjustment_zoning", "22.03.25", "Zoning compliance adjustment"),
  siteAdjustment("sales_comparable_adjustment_hazard", "22.03.27", "Hazard zone adjustment"),
  siteAdjustment("sales_comparable_adjustment_primary_access", "22.03.29", "Primary access adjustment"),
  siteAdjustment("sales_comparable_adjustment_street", "22.03.31", "Street type and surface adjustment"),
  siteAdjustment("sales_comparable_adjustment_restriction", "22.03.33", "Property restriction adjustment"),
  siteAdjustment("sales_comparable_adjustment_easement", "22.03.35", "Easement adjustment"),
  siteAdjustment("sales_comparable_adjustment_topography", "22.03.37", "Topography adjustment"),
  siteAdjustment("sales_comparable_adjustment_drainage", "22.03.39", "Drainage adjustment"),
  siteAdjustment("sales_comparable_adjustment_site_characteristic", "22.03.41", "Site characteristics adjustment"),
  siteAdjustment("sales_comparable_adjustment_site_influence", "22.03.43", "Site influence adjustment"),
  siteAdjustment("sales_comparable_adjustment_environmental", "22.03.45", "Apparent environmental conditions adjustment"),
  siteAdjustment("sales_comparable_adjustment_view", "22.03.47", "View and range adjustment"),

  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "0700.0125",
    "22.01.18",
    "Data source",
    "enum",
    {
      entityType: "sales_comparable_data_source",
      options: UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES,
      required: true,
    },
  ),
  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "1800.0347",
    "22.01.18",
    "Data source identifier",
    "string",
    {
      entityType: "sales_comparable_data_source",
      maxLength: 45,
      requiredWhen: { key: "sales_comparable_data_source:0700.0125", equals: "MLS" },
      guidance: "The MLS number is required for MLS sources. Report an identifier for any other source that provides one.",
    },
  ),
  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "0700.0126",
    "22.01.18",
    "Other data source",
    "string",
    {
      entityType: "sales_comparable_data_source",
      maxLength: 66,
      showWhen: { key: "sales_comparable_data_source:0700.0125", equals: "Other" },
      requiredWhen: { key: "sales_comparable_data_source:0700.0125", equals: "Other" },
    },
  ),
  field(
    "Comparable rights not included",
    "sales_comparable_right_not_included",
    "1800.0340",
    "22.01.46",
    "Right not included",
    "enum",
    {
      entityType: "sales_comparable_right_not_included",
      options: UAD_PROPERTY_RIGHTS_NOT_INCLUDED,
      required: true,
    },
  ),
  field(
    "Comparable rights not included",
    "sales_comparable_right_not_included",
    "1800.0341",
    "22.01.46",
    "Other right not included",
    "string",
    {
      entityType: "sales_comparable_right_not_included",
      maxLength: 33,
      showWhen: { key: "sales_comparable_right_not_included:1800.0340", equals: "Other" },
      requiredWhen: { key: "sales_comparable_right_not_included:1800.0340", equals: "Other" },
    },
  ),
]);

export const UAD_SALES_COMPARISON_ENTITY_GROUPS = Object.freeze({
  sales_comparable_data_source: Object.freeze({
    title: "Comparable data sources",
    addLabel: "Add comparable data source",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES.length,
    parentEntityType: "sales_comparable",
    showWhen: salesComparisonIncluded,
  }),
  sales_comparable_right_not_included: Object.freeze({
    title: "Comparable rights not included",
    addLabel: "Add excluded right",
    minItems: 0,
    maxItems: UAD_PROPERTY_RIGHTS_NOT_INCLUDED.length,
    parentEntityType: "sales_comparable",
    showWhen: { key: "sales_comparable_property:1800.0201", equals: false },
  }),
  sales_comparable_project_amenity: Object.freeze({
    title: "Comparable project amenities and services",
    addLabel: "Add common amenity or service",
    minItems: 0,
    maxItems: UAD_PROJECT_AMENITY_TYPES.length,
    parentEntityType: "sales_comparable",
    showWhen: comparableProjectOrPud,
  }),
  sales_comparable_site_hazard: Object.freeze({
    title: "Comparable hazard zones",
    addLabel: "Add hazard zone",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_HAZARD_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_street: Object.freeze({
    title: "Comparable access streets",
    addLabel: "Add access street",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_STREET_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_restriction: Object.freeze({
    title: "Comparable property restrictions",
    addLabel: "Add property restriction",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_RESTRICTION_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_easement: Object.freeze({
    title: "Comparable easements",
    addLabel: "Add easement",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_EASEMENT_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_feature: Object.freeze({
    title: "Comparable site characteristics",
    addLabel: "Add site characteristic",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_SITE_FEATURE_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_influence: Object.freeze({
    title: "Comparable site influences",
    addLabel: "Add site influence",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_SITE_INFLUENCE_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_environmental: Object.freeze({
    title: "Comparable apparent environmental conditions",
    addLabel: "Add apparent environmental condition",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_ENVIRONMENTAL_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
  sales_comparable_site_view: Object.freeze({
    title: "Comparable views",
    addLabel: "Add view",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_VIEW_TYPES.length,
    parentEntityType: "sales_comparable",
  }),
});

export const UAD_SALES_COMPARISON_FIELD_KEYS = Object.freeze({
  included: "sales_comparison_scope:1000.0032",
  ordinal: "sales_comparable:1800.0192",
  dataSourceType: "sales_comparable_data_source:0700.0125",
  dataSourceIdentifier: "sales_comparable_data_source:1800.0347",
  dataSourceOther: "sales_comparable_data_source:0700.0126",
  listingStatus: "sales_comparable_listing:1800.0075",
  contractPriceUnknown: "sales_comparable_contract:1800.0384",
  contractPrice: "sales_comparable_contract:1800.0271",
  salePrice: "sales_comparable_sale:1800.0272",
  saleType: "sales_comparable_sale:1800.0274",
  saleTypeOther: "sales_comparable_sale:1800.0275",
  noFinancing: "sales_comparable_financing:1800.0381",
  financingType: "sales_comparable_financing:1800.0063",
  financingOther: "sales_comparable_financing:1800.0064",
  concessions: "sales_comparable_concessions:1800.0370",
  concessionAmountKnown: "sales_comparable_concessions:1800.0369",
  concessionAmount: "sales_comparable_concessions:1800.0203",
  contractDateUnknown: "sales_comparable_contract:1800.0385",
  contractDate: "sales_comparable_contract:1800.0202",
  saleDate: "sales_comparable_sale:1800.0342",
  propertyRights: "sales_comparable_property:1800.0337",
  propertyRightsOther: "sales_comparable_property:1800.0338",
  nativeLands: "sales_comparable_property:1800.0357",
  nativeLandsType: "sales_comparable_property:1800.0358",
  nativeLandsOther: "sales_comparable_property:1800.0359",
  allRightsIncluded: "sales_comparable_property:1800.0201",
  rightNotIncluded: "sales_comparable_right_not_included:1800.0340",
  pud: "sales_comparable_project:1800.0383",
  inProject: "sales_comparable_project:1800.0378",
  projectLegalStructure: "sales_comparable_project:1800.0377",
  projectName: "sales_comparable_project:1800.0194",
  sameProject: "sales_comparable_project:1800.0083",
  projectMonthlyFee: "sales_comparable_project:1800.0353",
  projectSpecialAssessment: "sales_comparable_project:1800.0371",
  projectAdjustment: "sales_comparable_adjustment_project:1800.0317",
  projectAmenity: "sales_comparable_project_amenity:1800.0056",
  projectAmenityOther: "sales_comparable_project_amenity:1800.0057",
  siteOwnedInCommon: "sales_comparable_site:1800.0277",
  siteSize: "sales_comparable_site:1800.0239",
  sitePrimaryAccess: "sales_comparable_site:1800.0218",
  sitePrimaryAccessOther: "sales_comparable_site:1800.0219",
  siteHazard: "sales_comparable_site_hazard:1800.0212",
  siteHazardOther: "sales_comparable_site_hazard:1800.0213",
  siteHazardLavaZone: "sales_comparable_site_hazard:1800.0367",
  siteStreetType: "sales_comparable_site_street:1800.0216",
  siteStreetTypeOther: "sales_comparable_site_street:1800.0217",
  siteStreetSurface: "sales_comparable_site_street:1800.0214",
  siteStreetSurfaceOther: "sales_comparable_site_street:1800.0215",
  siteRestriction: "sales_comparable_site_restriction:1800.0068",
  siteRestrictionOther: "sales_comparable_site_restriction:1800.0069",
  siteEasement: "sales_comparable_site_easement:1800.0070",
  siteEasementOther: "sales_comparable_site_easement:1800.0071",
  siteFeature: "sales_comparable_site_feature:1800.0222",
  siteFeatureOther: "sales_comparable_site_feature:1800.0223",
  siteTopography: "sales_comparable_site_feature:1800.0225",
  siteTopographyOther: "sales_comparable_site_feature:1800.0226",
  siteDrainage: "sales_comparable_site_feature:1800.0220",
  siteDrainageOther: "sales_comparable_site_feature:1800.0221",
  siteInfluence: "sales_comparable_site_influence:1800.0233",
  siteInfluenceOther: "sales_comparable_site_influence:1800.0234",
  siteBodyOfWater: "sales_comparable_site_influence:1800.0228",
  siteBodyOfWaterOther: "sales_comparable_site_influence:1800.0229",
  siteEnvironmental: "sales_comparable_site_environmental:1800.0116",
  siteEnvironmentalOther: "sales_comparable_site_environmental:1800.0117",
  siteView: "sales_comparable_site_view:1800.0243",
  siteViewOther: "sales_comparable_site_view:1800.0244",
  siteViewRange: "sales_comparable_site_view:1800.0242",
  siteViewRangeOther: "sales_comparable_site_view:1800.0250",
});

export function isVerifiedSalesComparisonAsset(asset, captionType = null, entityId = undefined) {
  return asset?.section_number === 22
    && asset?.status === "verified"
    && UAD_SALES_COMPARISON_CAPTION_TYPES.includes(asset?.caption_type)
    && (!captionType || asset?.caption_type === captionType)
    && (entityId === undefined || asset?.entity_id === entityId)
    && UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}
