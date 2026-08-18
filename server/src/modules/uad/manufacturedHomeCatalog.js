const condition = (key, equals) => ({ key, equals });

export const manufacturedDwelling = Object.freeze(condition("dwelling:0300.0034", "Manufactured"));
const skirtingExists = Object.freeze(condition("manufactured_home:0500.0030", true));
const modificationsExist = Object.freeze(condition("manufactured_home:0500.0020", true));
const dataPlateAttached = Object.freeze(condition("manufactured_home:0500.0010", true));
const purchasedFromRetailer = Object.freeze(condition("manufactured_home:0500.0022", true));
const newConstruction = Object.freeze(condition("subject:0300.0010", true));
const invoiceReviewed = Object.freeze({
  any: [
    condition("manufactured_home:0500.0023", true),
    condition("manufactured_home:0500.0014", true),
  ],
});

function withManufacturedDwelling(requestedCondition) {
  return requestedCondition
    ? { all: [manufacturedDwelling, requestedCondition] }
    : manufacturedDwelling;
}

const manufacturedHome = (group, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "manufactured_home",
  group,
  contextKey: "manufactured_home",
  entityType: "dwelling",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
  showWhen: withManufacturedDwelling(options.showWhen),
  ...(options.requiredWhen ? { requiredWhen: withManufacturedDwelling(options.requiredWhen) } : {}),
});

const childField = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "manufactured_home",
  group,
  contextKey,
  entityType: contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_MANUFACTURED_HOME_ENTITY_GROUPS = Object.freeze({
  manufactured_home_skirting_material: {
    title: "Skirting materials",
    addLabel: "Add skirting material",
    minItems: 0,
    parentEntityType: "dwelling",
    showWhen: { all: [manufacturedDwelling, skirtingExists] },
  },
  manufactured_home_modification: {
    title: "Modifications, attachments, or additions",
    addLabel: "Add modification or addition",
    minItems: 0,
    parentEntityType: "dwelling",
    showWhen: { all: [manufacturedDwelling, modificationsExist] },
  },
  manufactured_home_hud_label: {
    title: "HUD certification labels",
    addLabel: "Add HUD certification label",
    minItems: 0,
    parentEntityType: "dwelling",
    showWhen: manufacturedDwelling,
  },
  manufactured_home_financing_program: {
    title: "Manufactured home certification programs",
    addLabel: "Add certification program",
    minItems: 0,
    parentEntityType: "dwelling",
    showWhen: manufacturedDwelling,
  },
});

export const UAD_MANUFACTURED_HOME_CAPTION_TYPES = Object.freeze([
  "ManufacturedHomeHUDDataPlate",
  "ManufacturedHomeHUDCertificationLabel",
  "ManufacturedHomeFinancingProgramEligibilityCertification",
  "ManufacturedHomeExhibit",
]);

export const UAD_MANUFACTURED_HOME_IMAGE_CONTENT_TYPES = Object.freeze([
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

export function isVerifiedManufacturedHomeAsset(asset, captionType, entityId = null) {
  return asset?.section_number === 9
    && asset?.status === "verified"
    && asset?.caption_type === captionType
    && (!entityId || asset?.entity_id === entityId)
    && UAD_MANUFACTURED_HOME_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export const UAD_MANUFACTURED_HOME_FIELDS = [
  manufacturedHome("General information", "0500.0017", "9.000", "Manufacturer name", "string", {
    required: true,
    maxLength: 66,
  }),
  manufacturedHome("General information", "0500.0011", "9.001", "Year installed", "year", {
    required: true,
    maxLength: 4,
  }),
  manufacturedHome("General information", "0500.0041", "9.001", "Year installed estimated", "boolean", {
    required: true,
  }),
  manufacturedHome("General information", "0500.0021", "9.002", "Moved since original installation", "boolean", {
    required: true,
  }),
  manufacturedHome("General information", "0500.0007", "9.003", "Attached to permanent foundation", "boolean", {
    required: true,
  }),
  manufacturedHome("General information", "0500.0008", "9.004", "Towing hitch, wheels, and axles removed", "boolean", {
    required: true,
  }),
  manufacturedHome("General information", "0500.0044", "9.005", "Manufactured home width", "enum", {
    required: true,
    options: ["MultiWide", "SingleWide"],
  }),
  manufacturedHome("General information", "0500.0030", "9.006", "Skirting exists", "boolean", {
    required: true,
  }),
  childField("Skirting materials", "manufactured_home_skirting_material", "0500.0039", "9.006", "Skirting material", "enum", {
    required: true,
    options: ["Asbestos", "Brick", "CementBoard", "ConcreteBlock", "EngineeredWood", "Fiberglass", "Log", "Metal", "Other", "PouredConcrete", "Vinyl", "Wood"],
  }),
  childField("Skirting materials", "manufactured_home_skirting_material", "0500.0040", "9.006", "Other skirting material", "string", {
    maxLength: 33,
    showWhen: condition("manufactured_home_skirting_material:0500.0039", "Other"),
    requiredWhen: condition("manufactured_home_skirting_material:0500.0039", "Other"),
  }),
  manufacturedHome("Modifications and additions", "0500.0020", "9.007", "Modifications, attachments, or additions rely on or altered the original structure", "boolean", {
    required: true,
  }),
  childField("Modifications, attachments, or additions", "manufactured_home_modification", "0500.0035", "9.008", "Modification, attachment, or addition", "enum", {
    required: true,
    options: ["Carport", "Deck", "Garage", "LivingArea", "Other", "Porch", "Sunroom"],
  }),
  childField("Modifications, attachments, or additions", "manufactured_home_modification", "0500.0036", "9.008", "Other modification, attachment, or addition", "string", {
    maxLength: 33,
    showWhen: condition("manufactured_home_modification:0500.0035", "Other"),
    requiredWhen: condition("manufactured_home_modification:0500.0035", "Other"),
  }),
  manufacturedHome("Modifications and additions", "0500.0019", "9.009", "Description of modification, attachment, or addition", "text", {
    maxLength: 1250,
    showWhen: modificationsExist,
    requiredWhen: modificationsExist,
  }),
  manufacturedHome("HUD data plate", "0500.0010", "9.010", "HUD data plate attached", "boolean", {
    required: true,
  }),
  manufacturedHome("HUD data plate", "0500.0016", "9.011", "Date of manufacture", "date", {
    showWhen: undefined,
    requiredWhen: dataPlateAttached,
  }),
  manufacturedHome("HUD data plate", "0500.0027", "9.012", "Serial number", "string", {
    maxLength: 132,
    showWhen: undefined,
    requiredWhen: dataPlateAttached,
  }),
  manufacturedHome("HUD data plate", "0500.0033", "9.013", "HUD wind zone", "enum", {
    options: ["ZoneI", "ZoneII", "ZoneIII"],
    showWhen: undefined,
    requiredWhen: dataPlateAttached,
  }),
  manufacturedHome("HUD data plate", "0500.0031", "9.014", "HUD thermal zone", "enum", {
    options: ["Zone1", "Zone2", "Zone3"],
    showWhen: undefined,
    requiredWhen: dataPlateAttached,
  }),
  manufacturedHome("HUD data plate", "0500.0028", "9.015", "HUD roof load zone", "enum", {
    options: ["Middle", "North", "South"],
    showWhen: undefined,
    requiredWhen: dataPlateAttached,
  }),
  manufacturedHome("HUD certification label", "0500.0009", "9.016", "HUD label present for all sections", "boolean", {
    required: true,
  }),
  childField("HUD certification labels", "manufactured_home_hud_label", "0500.0037", "9.017", "HUD certification number", "string", {
    required: true,
    maxLength: 33,
  }),
  childField("Manufactured home certification programs", "manufactured_home_financing_program", "0500.0005", "9.018", "Certification", "enum", {
    required: true,
    options: ["FannieMaeMHAdvantage", "FreddieMacCHOICEHome", "Other"],
  }),
  childField("Manufactured home certification programs", "manufactured_home_financing_program", "0500.0006", "9.018", "Other certification", "string", {
    maxLength: 45,
    showWhen: condition("manufactured_home_financing_program:0500.0005", "Other"),
    requiredWhen: condition("manufactured_home_financing_program:0500.0005", "Other"),
  }),
  childField("Manufactured home certification programs", "manufactured_home_financing_program", "0500.0004", "9.019", "Certification identifier", "string", {
    required: true,
    maxLength: 45,
  }),
  manufacturedHome("Invoice information", "0500.0022", "9.020", "Purchased from retailer", "boolean", {
    showWhen: newConstruction,
    requiredWhen: newConstruction,
  }),
  manufacturedHome("Invoice information", "0500.0025", "9.021", "Retailer name", "string", {
    maxLength: 66,
    showWhen: { all: [newConstruction, purchasedFromRetailer] },
    requiredWhen: { all: [newConstruction, purchasedFromRetailer] },
  }),
  manufacturedHome("Invoice information", "0500.0023", "9.022", "Retailer's invoice reviewed", "boolean", {
    showWhen: { all: [newConstruction, purchasedFromRetailer] },
    requiredWhen: { all: [newConstruction, purchasedFromRetailer] },
  }),
  manufacturedHome("Invoice information", "0500.0014", "9.023", "Manufacturer's invoice reviewed", "boolean", {
    showWhen: newConstruction,
    requiredWhen: newConstruction,
  }),
  manufacturedHome("Invoice information", "0500.0013", "9.024", "Invoice(s) appear reasonable", "boolean", {
    showWhen: { all: [newConstruction, invoiceReviewed] },
    requiredWhen: { all: [newConstruction, invoiceReviewed] },
  }),
  manufacturedHome("Invoice information", "0500.0012", "9.025", "Commentary on why invoice(s) are not reasonable", "text", {
    maxLength: 1250,
    showWhen: { all: [newConstruction, condition("manufactured_home:0500.0013", false)] },
    requiredWhen: { all: [newConstruction, condition("manufactured_home:0500.0013", false)] },
  }),
  manufacturedHome("Manufactured home commentary", "0500.0042", "9.026", "Manufactured home commentary", "text", {
    maxLength: 5000,
  }),
];

export {
  dataPlateAttached,
  modificationsExist,
  newConstruction,
  purchasedFromRetailer,
  skirtingExists,
};
