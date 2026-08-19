export const UAD_PROJECT_INFORMATION_CAPTION_TYPES = Object.freeze([
  "ProjectAmenity",
  "ProjectDeficiency",
  "ProjectExhibit",
]);

export const UAD_PROJECT_INFORMATION_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_PROJECT_DATA_SOURCE_TYPES = Object.freeze([
  "AssessorRecord", "BuilderOrDeveloper", "CondominiumQuestionnaire", "CooperativeBoard",
  "CooperativeQuestionnaire", "DataAggregator", "HomeownersAssociation", "LandSurvey", "MLS",
  "Other", "PlatMap", "PreviousAppraisalFile", "PropertyDataReport",
  "PropertyManagementCompany", "PropertyOwner", "PropertyTenant", "RealEstateAgent",
]);

export const UAD_PROJECT_AMENITY_TYPES = Object.freeze([
  "Airstrip", "Beach", "BoatRamp", "BoatSlip", "BuildingMaintenance", "BuiltInPool",
  "BusinessCenter", "CaregiverServices", "Clubhouse", "ClubMembership", "CommunityPier",
  "ConciergeServiceCoordination", "Cooling", "Deck", "DoorAttendant",
  "ElectricVehicleChargingStation", "Elevator", "FitnessArea", "GatedCommunity",
  "GroundsMaintenance", "Heating", "IngroundPool", "IngroundSpa", "Lobby", "None",
  "OngoingCleaningServices", "Other", "OutdoorRidingRing", "OutdoorShower", "Patio",
  "Playground", "RecreationArea", "RegistrationServices", "Sauna", "SharedLaundryFacilities",
  "ShortTermRentalServices", "SportsCourt", "TelevisionOrInternetServices", "TrashRemoval",
  "UnitStorage", "WaterAccess", "WaterFrontage",
]);

export const UAD_PROJECT_UTILITY_TYPES = Object.freeze([
  "Electricity", "Gas", "None", "Other", "SanitarySewer", "Water",
]);

export const UAD_VALUE_MARKETABILITY_IMPACTS = Object.freeze([
  "Adverse", "Beneficial", "Neutral",
]);

const projectProperty = Object.freeze({ key: "subject:2500.0168", present: true });
const pudProperty = Object.freeze({ key: "subject:0100.0026", equals: true });
const projectOrPud = Object.freeze({ any: [projectProperty, pudProperty] });
const condominium = Object.freeze({ key: "subject:2500.0168", equals: "Condominium" });
const cooperativeOrCondop = Object.freeze({
  any: [
    { key: "subject:2500.0168", equals: "Cooperative" },
    { key: "subject:2500.0168", equals: "Condop" },
  ],
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "project_information",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const projectField = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { showWhen: projectProperty, requiredWhen: projectProperty, ...options },
);

const sharedField = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { showWhen: projectOrPud, requiredWhen: projectOrPud, ...options },
);

const impactField = (group, contextKey, uid, reportFieldId, label, condition) => field(
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  "enum",
  { options: UAD_VALUE_MARKETABILITY_IMPACTS, showWhen: condition, requiredWhen: condition },
);

const commentRequiredForMaterialImpact = (impactKey) => ({
  any: [
    { key: impactKey, equals: "Adverse" },
    { key: impactKey, equals: "Beneficial" },
  ],
});

export const UAD_PROJECT_INFORMATION_FIELDS = Object.freeze([
  field("Project information sources", "project_data_source", "0700.0125", "18.005", "Project information data source", "enum", {
    entityType: "project_data_source",
    required: true,
    options: UAD_PROJECT_DATA_SOURCE_TYPES,
  }),
  field("Project information sources", "project_data_source", "0700.0126", "18.005", "Other data source", "string", {
    entityType: "project_data_source",
    maxLength: 66,
    showWhen: { uid: "0700.0125", equals: "Other" },
    requiredWhen: { uid: "0700.0125", equals: "Other" },
  }),

  projectField("Project identity and unit counts", "project_information", "2500.0065", "18.004", "Project name", "string", { maxLength: 33 }),
  projectField("Project identity and unit counts", "project_information", "2500.0060", "18.006", "Total units", "integer", { minimum: 1, maximum: 9999 }),
  projectField("Project identity and unit counts", "project_information", "2500.0064", "18.007", "Units sold", "integer", { minimum: 0, maximum: 9999 }),
  projectField("Project identity and unit counts", "project_information", "2500.0061", "18.008", "Units for sale", "integer", { minimum: 0, maximum: 9999 }),
  projectField("Project identity and unit counts", "project_information", "2500.0062", "18.009", "Units rented", "integer", { minimum: 0, maximum: 9999 }),
  projectField("Project identity and unit counts", "project_information", "2500.0161", "18.009", "Units rented is estimated", "boolean"),
  field("Project identity and unit counts", "project_information", "2500.0162", "18.010", "Reason units rented is estimated", "text", {
    maxLength: 352,
    showWhen: { key: "project_information:2500.0161", equals: true },
    requiredWhen: { key: "project_information:2500.0161", equals: true },
  }),

  sharedField("Mandatory monthly fees", "project_association_dues", "2500.0007", "18.011", "Mandatory monthly fee amount", "currency", {
    minimum: 0,
    maximum: 999999,
    guidance: "Enter the combined monthly amount of mandatory fees that transfer upon sale. Do not include special assessments or private utilities.",
  }),
  field("Utilities included in monthly fees", "project_utility", "2500.0009", "18.013", "Utility included", "enum", {
    entityType: "project_utility",
    required: true,
    options: UAD_PROJECT_UTILITY_TYPES,
  }),
  field("Utilities included in monthly fees", "project_utility", "2500.0010", "18.013", "Other included utility or service", "string", {
    entityType: "project_utility",
    maxLength: 33,
    showWhen: { uid: "2500.0009", equals: "Other" },
    requiredWhen: { uid: "2500.0009", equals: "Other" },
  }),

  field("Common amenities and services", "project_amenity", "2500.0004", "18.012", "Common amenity or service", "enum", {
    entityType: "project_amenity",
    required: true,
    options: UAD_PROJECT_AMENITY_TYPES,
  }),
  field("Common amenities and services", "project_amenity", "2500.0005", "18.012", "Other amenity or service", "string", {
    entityType: "project_amenity",
    maxLength: 33,
    showWhen: { uid: "2500.0004", equals: "Other" },
    requiredWhen: { uid: "2500.0004", equals: "Other" },
  }),
  field("Common amenities and services", "project_amenity", "2500.0002", "18.012", "Amenity ownership", "enum", {
    entityType: "project_amenity",
    options: ["Assigned", "Other", "Owned", "Unassigned"],
    showWhen: {
      any: [
        { uid: "2500.0004", equals: "BoatSlip" },
        { uid: "2500.0004", equals: "UnitStorage" },
      ],
    },
    requiredWhen: {
      any: [
        { uid: "2500.0004", equals: "BoatSlip" },
        { uid: "2500.0004", equals: "UnitStorage" },
      ],
    },
  }),
  field("Common amenities and services", "project_amenity", "2500.0003", "18.012", "Other amenity ownership", "string", {
    entityType: "project_amenity",
    maxLength: 33,
    showWhen: { uid: "2500.0002", equals: "Other" },
    requiredWhen: { uid: "2500.0002", equals: "Other" },
  }),

  projectField("Observed deficiencies and completeness", "project_analysis", "2500.0033", "18.014", "Observed project deficiencies", "boolean"),
  field("Observed deficiencies and completeness", "project_analysis", "2500.0032", "18.015", "Description of observed deficiencies", "text", {
    maxLength: 528,
    showWhen: { key: "project_analysis:2500.0033", equals: true },
    requiredWhen: { key: "project_analysis:2500.0033", equals: true },
  }),
  projectField("Observed deficiencies and completeness", "project_information", "2500.0058", "18.016", "Project complete", "boolean"),
  field("Observed deficiencies and completeness", "project_information", "2500.0066", "18.017", "Subject property building complete", "boolean", {
    showWhen: { key: "project_information:2500.0058", equals: false },
    requiredWhen: { key: "project_information:2500.0058", equals: false },
  }),
  projectField("Observed deficiencies and completeness", "project_conversion", "2500.0048", "18.018", "Converted in past three years", "boolean"),

  projectField("Ground rent", "project_analysis", "2500.0031", "18.019", "Project subject to ground rent", "boolean"),
  field("Ground rent", "project_analysis", "2500.0028", "18.020", "Annual ground rent amount", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: { key: "project_analysis:2500.0031", equals: true },
    requiredWhen: { key: "project_analysis:2500.0031", equals: true },
  }),
  field("Ground rent", "project_analysis", "2500.0030", "18.021", "Ground rent expiration", "month", {
    showWhen: { key: "project_analysis:2500.0031", equals: true },
    requiredWhen: { key: "project_analysis:2500.0031", equals: true },
  }),
  field("Ground rent", "project_analysis", "2500.0029", "18.022", "Ground rent description", "text", {
    maxLength: 540,
    showWhen: { key: "project_analysis:2500.0031", equals: true },
  }),

  field("Cooperative information", "project_financial", "2500.0075", "18.023", "Shares issued and outstanding", "integer", {
    minimum: 1,
    maximum: 99999,
    showWhen: cooperativeOrCondop,
    requiredWhen: cooperativeOrCondop,
  }),
  field("Cooperative information", "project_property_unit", "2500.0024", "18.024", "Shares attributable to subject property", "integer", {
    minimum: 1,
    maximum: 99999,
    showWhen: cooperativeOrCondop,
    requiredWhen: cooperativeOrCondop,
  }),
  field("Cooperative information", "project_property", "2500.0023", "18.025", "Proprietary lease expiration", "month", {
    showWhen: cooperativeOrCondop,
    requiredWhen: cooperativeOrCondop,
  }),
  field("Cooperative information", "project_financial", "2500.0074", "18.026", "Project blanket financing", "boolean", {
    showWhen: cooperativeOrCondop,
    requiredWhen: cooperativeOrCondop,
  }),

  field("Project blanket financing liens", "project_blanket_financing", "2500.0039", "18.028", "Lien priority", "enum", {
    entityType: "project_blanket_financing",
    required: true,
    options: ["FirstLien", "SecondLien", "ThirdLien", "FourthLien"],
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0151", "Does Not Display", "Line of credit", "boolean", {
    entityType: "project_blanket_financing",
    required: true,
    guidance: "This appraiser input controls which financing balances display; it is delivered in UAD XML but does not print on the URAR.",
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0046", "18.029", "Unpaid principal balance", "currency", {
    entityType: "project_blanket_financing",
    minimum: 0,
    maximum: 999999999.99,
    showWhen: { uid: "2500.0151", equals: false },
    requiredWhen: { uid: "2500.0151", equals: false },
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0153", "18.030", "Line of credit maximum amount", "currency", {
    entityType: "project_blanket_financing",
    minimum: 0,
    maximum: 999999999.99,
    showWhen: { uid: "2500.0151", equals: true },
    requiredWhen: { uid: "2500.0151", equals: true },
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0155", "18.030", "Line of credit drawn amount", "currency", {
    entityType: "project_blanket_financing",
    minimum: 0,
    maximum: 999999999.99,
    showWhen: { uid: "2500.0151", equals: true },
    requiredWhen: { uid: "2500.0151", equals: true },
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0036", "18.031", "Balloon mortgage", "boolean", { entityType: "project_blanket_financing", required: true }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0041", "18.032", "Remaining term (months)", "integer", {
    entityType: "project_blanket_financing", required: true, minimum: 0, maximum: 999,
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0042", "18.033", "Monthly payment known", "boolean", { entityType: "project_blanket_financing", required: true }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0045", "18.033", "Monthly payment", "currency", {
    entityType: "project_blanket_financing",
    minimum: 0,
    maximum: 999999999.99,
    showWhen: { uid: "2500.0042", equals: true },
    requiredWhen: { uid: "2500.0042", equals: true },
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0038", "18.034", "Interest rate known", "boolean", { entityType: "project_blanket_financing", required: true }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0037", "18.034", "Current interest rate", "percentage", {
    entityType: "project_blanket_financing",
    showWhen: { uid: "2500.0038", equals: true },
    requiredWhen: { uid: "2500.0038", equals: true },
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0034", "18.035", "Amortization type", "enum", {
    entityType: "project_blanket_financing", required: true, options: ["AdjustableRate", "Fixed", "Other"],
  }),
  field("Project blanket financing liens", "project_blanket_financing", "2500.0035", "18.035", "Other amortization type", "string", {
    entityType: "project_blanket_financing",
    maxLength: 36,
    showWhen: { uid: "2500.0034", equals: "Other" },
    requiredWhen: { uid: "2500.0034", equals: "Other" },
  }),

  sharedField("Project factors", "project_developer", "2500.0067", "18.064", "Developer or sponsor in control", "boolean"),
  impactField("Project factors", "project_developer_impact", "2500.0144", "18.074", "Developer control impact", { key: "project_developer:2500.0067", equals: true }),
  field("Project factors", "project_developer_commentary", "2500.0143", "18.084", "Developer control comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_developer:2500.0067", equals: true },
    requiredWhen: commentRequiredForMaterialImpact("project_developer_impact:2500.0144"),
  }),

  field("Incomplete project factors", "project_incomplete_component", "2500.0071", "18.065", "Incomplete project element", "enum", {
    entityType: "project_incomplete_component", required: true, options: ["Amenities", "CommonAreas", "Other", "Units"],
  }),
  field("Incomplete project factors", "project_incomplete_component", "2500.0072", "18.065", "Other incomplete element", "string", {
    entityType: "project_incomplete_component",
    maxLength: 45,
    showWhen: { uid: "2500.0071", equals: "Other" },
    requiredWhen: { uid: "2500.0071", equals: "Other" },
  }),
  impactField("Project factors", "project_incomplete_impact", "2500.0141", "18.075", "Incomplete project impact", { key: "project_information:2500.0058", equals: false }),
  field("Project factors", "project_incomplete_commentary", "2500.0140", "18.085", "Incomplete project comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_information:2500.0058", equals: false },
    requiredWhen: { key: "project_information:2500.0058", equals: false },
  }),

  field("Project factors", "project_conversion", "2500.0049", "18.066", "Prior use before conversion", "enum", {
    options: ["Apartment", "CommercialBuilding", "HotelOrMotel", "House", "IndustrialBuilding", "Other"],
    showWhen: { key: "project_conversion:2500.0048", equals: true },
    requiredWhen: { key: "project_conversion:2500.0048", equals: true },
  }),
  field("Project factors", "project_conversion", "2500.0050", "18.066", "Other prior use", "string", {
    maxLength: 45,
    showWhen: { key: "project_conversion:2500.0049", equals: "Other" },
    requiredWhen: { key: "project_conversion:2500.0049", equals: "Other" },
  }),
  impactField("Project factors", "project_conversion_impact", "2500.0138", "18.076", "Conversion impact", { key: "project_conversion:2500.0048", equals: true }),
  field("Project factors", "project_conversion_commentary", "2500.0137", "18.086", "Conversion comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_conversion:2500.0048", equals: true },
    requiredWhen: { key: "project_conversion:2500.0048", equals: true },
  }),

  field("Project factors", "project_financial", "2500.0078", "18.067", "Greatest number of units owned by one entity", "integer", {
    minimum: 1, maximum: 9999, showWhen: condominium, requiredWhen: condominium,
  }),
  impactField("Project factors", "project_units_impact", "2500.0135", "18.077", "Multiple-unit ownership impact", condominium),
  field("Project factors", "project_units_commentary", "2500.0134", "18.087", "Multiple-unit ownership comment", "text", {
    maxLength: 210,
    showWhen: condominium,
    requiredWhen: commentRequiredForMaterialImpact("project_units_impact:2500.0135"),
  }),
  field("Project factors", "project_financial", "2500.0076", "18.068", "Greatest number of shares owned by one entity", "integer", {
    minimum: 1, maximum: 9999, showWhen: cooperativeOrCondop, requiredWhen: cooperativeOrCondop,
  }),
  impactField("Project factors", "project_shares_impact", "2500.0132", "18.078", "Multiple-share ownership impact", cooperativeOrCondop),
  field("Project factors", "project_shares_commentary", "2500.0131", "18.088", "Multiple-share ownership comment", "text", {
    maxLength: 210,
    showWhen: cooperativeOrCondop,
    requiredWhen: commentRequiredForMaterialImpact("project_shares_impact:2500.0132"),
  }),

  projectField("Project factors", "project_information", "2500.0055", "18.069", "Commercial space in project", "boolean"),
  field("Project factors", "project_information", "2500.0057", "18.069", "Estimated commercial space", "percentage", {
    showWhen: { key: "project_information:2500.0055", equals: true },
    requiredWhen: { key: "project_information:2500.0055", equals: true },
  }),
  impactField("Project factors", "project_commercial_impact", "2500.0129", "18.079", "Commercial space impact", { key: "project_information:2500.0055", equals: true }),
  field("Project factors", "project_commercial_commentary", "2500.0128", "18.089", "Commercial space comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_information:2500.0055", equals: true },
    requiredWhen: commentRequiredForMaterialImpact("project_commercial_impact:2500.0129"),
  }),

  sharedField("Project factors", "project_information", "2500.0051", "18.070", "Known legal actions", "boolean"),
  impactField("Project factors", "project_legal_action_impact", "2500.0126", "18.080", "Known legal actions impact", { key: "project_information:2500.0051", equals: true }),
  field("Project factors", "project_legal_action_commentary", "2500.0125", "18.090", "Known legal actions comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_information:2500.0051", equals: true },
    requiredWhen: { key: "project_information:2500.0051", equals: true },
  }),

  projectField("Project factors", "project_transfer_fee", "2500.0019", "18.071", "Unit transfer fee", "boolean"),
  field("Project factors", "project_transfer_fee", "2500.0017", "18.071", "Unit transfer fee amount", "currency", {
    minimum: 0, maximum: 999999,
    showWhen: { key: "project_transfer_fee:2500.0019", equals: true },
    requiredWhen: { key: "project_transfer_fee:2500.0019", equals: true },
  }),
  impactField("Project factors", "project_transfer_fee_impact", "2500.0147", "18.081", "Unit transfer fee impact", { key: "project_transfer_fee:2500.0019", equals: true }),
  field("Project factors", "project_transfer_fee_commentary", "2500.0146", "18.091", "Unit transfer fee comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_transfer_fee:2500.0019", equals: true },
    requiredWhen: { key: "project_transfer_fee:2500.0019", equals: true },
  }),

  sharedField("Project factors", "project_special_assessment", "2500.0163", "18.072", "Unit special assessment status", "enum", {
    options: ["Existing", "None", "Proposed"],
  }),
  field("Project factors", "project_special_assessment", "2500.0013", "18.072", "Special assessment amount attributable to subject", "currency", {
    minimum: 0, maximum: 999999999,
    showWhen: {
      any: [
        { key: "project_special_assessment:2500.0163", equals: "Existing" },
        { key: "project_special_assessment:2500.0163", equals: "Proposed" },
      ],
    },
    requiredWhen: { key: "project_special_assessment:2500.0163", equals: "Existing" },
  }),
  impactField("Project factors", "project_special_assessment_impact", "2500.0123", "18.082", "Special assessment impact", {
    any: [
      { key: "project_special_assessment:2500.0163", equals: "Existing" },
      { key: "project_special_assessment:2500.0163", equals: "Proposed" },
    ],
  }),
  field("Project factors", "project_special_assessment_commentary", "2500.0122", "18.092", "Special assessment comment", "text", {
    maxLength: 210,
    showWhen: {
      any: [
        { key: "project_special_assessment:2500.0163", equals: "Existing" },
        { key: "project_special_assessment:2500.0163", equals: "Proposed" },
      ],
    },
    requiredWhen: {
      any: [
        { key: "project_special_assessment:2500.0163", equals: "Existing" },
        { key: "project_special_assessment:2500.0163", equals: "Proposed" },
      ],
    },
  }),

  sharedField("Project factors", "project_tax", "2500.0081", "18.073", "Unit tax abatement or exemption", "boolean"),
  field("Project factors", "project_tax", "2500.0082", "18.073", "Annual tax abatement or exemption amount", "currency", {
    minimum: 0, maximum: 999999999,
    showWhen: { key: "project_tax:2500.0081", equals: true },
  }),
  field("Project factors", "project_tax", "2500.0084", "18.073", "Tax abatement or exemption expiration", "month", {
    showWhen: { key: "project_tax:2500.0081", equals: true },
  }),
  impactField("Project factors", "project_tax_impact", "2500.0120", "18.083", "Tax abatement or exemption impact", { key: "project_tax:2500.0081", equals: true }),
  field("Project factors", "project_tax_commentary", "2500.0108", "18.093", "Tax abatement or exemption comment", "text", {
    maxLength: 210,
    showWhen: { key: "project_tax:2500.0081", equals: true },
    requiredWhen: { key: "project_tax:2500.0081", equals: true },
  }),

  field("Project commentary", "project_factors_commentary", "2500.0170", "18.094", "Project factors commentary", "text", { maxLength: 2500 }),
  field("Project commentary", "project_information_commentary", "2500.0170", "18.095", "Project information commentary", "text", { maxLength: 2500 }),
]);

export const UAD_PROJECT_INFORMATION_ENTITY_GROUPS = Object.freeze({
  project_data_source: Object.freeze({
    title: "Project information sources",
    addLabel: "Add project data source",
    minItems: 1,
    maxItems: 20,
  }),
  project_utility: Object.freeze({
    title: "Utilities included in monthly fees",
    addLabel: "Add included utility",
    minItems: 1,
    maxItems: 6,
  }),
  project_amenity: Object.freeze({
    title: "Common amenities and services",
    addLabel: "Add common amenity or service",
    minItems: 1,
    maxItems: UAD_PROJECT_AMENITY_TYPES.length,
  }),
  project_incomplete_component: Object.freeze({
    title: "Incomplete project factors",
    addLabel: "Add incomplete project element",
    minItems: 0,
    maxItems: 4,
    showWhen: { key: "project_information:2500.0058", equals: false },
  }),
  project_blanket_financing: Object.freeze({
    title: "Project blanket financing liens",
    addLabel: "Add blanket financing lien",
    minItems: 0,
    maxItems: 4,
    showWhen: { key: "project_financial:2500.0074", equals: true },
  }),
});

export const UAD_PROJECT_INFORMATION_FIELD_KEYS = Object.freeze({
  pud: "subject:0100.0026",
  legalStructure: "subject:2500.0168",
  projectComplete: "project_information:2500.0058",
  projectDeficiencies: "project_analysis:2500.0033",
  totalUnits: "project_information:2500.0060",
  unitsSold: "project_information:2500.0064",
  unitsForSale: "project_information:2500.0061",
  unitsRented: "project_information:2500.0062",
  blanketFinancing: "project_financial:2500.0074",
  lienPriority: "project_blanket_financing:2500.0039",
  amenityType: "project_amenity:2500.0004",
  utilityType: "project_utility:2500.0009",
});

export function isVerifiedProjectInformationAsset(asset, captionType = null, entityId = undefined) {
  return asset?.section_number === 18
    && asset?.status === "verified"
    && (!captionType || asset?.caption_type === captionType)
    && (entityId === undefined || asset?.entity_id === entityId)
    && UAD_PROJECT_INFORMATION_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_PROJECT_INFORMATION_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export { condominium, cooperativeOrCondop, projectOrPud, projectProperty, pudProperty };
