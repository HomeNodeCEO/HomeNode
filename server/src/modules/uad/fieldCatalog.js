import {
  UAD_DISASTER_ENERGY_ENTITY_GROUPS,
  UAD_DISASTER_ENERGY_FIELDS,
} from "./disasterEnergyCatalog.js";
import {
  UAD_DWELLING_EXTERIOR_ENTITY_GROUPS,
  UAD_DWELLING_EXTERIOR_FIELDS,
} from "./dwellingExteriorCatalog.js";
import { UAD_FUNCTIONAL_OBSOLESCENCE_FIELDS } from "./functionalObsolescenceCatalog.js";
import { UAD_HIGHEST_BEST_USE_FIELDS } from "./highestBestUseCatalog.js";
import { UAD_MARKET_ENTITY_GROUPS, UAD_MARKET_FIELDS } from "./marketCatalog.js";
import {
  UAD_MANUFACTURED_HOME_ENTITY_GROUPS,
  UAD_MANUFACTURED_HOME_FIELDS,
  manufacturedDwelling,
} from "./manufacturedHomeCatalog.js";
import {
  UAD_OUTBUILDING_ENTITY_GROUPS,
  UAD_OUTBUILDING_FIELDS,
} from "./outbuildingCatalog.js";
import { UAD_OVERALL_QUALITY_CONDITION_FIELDS } from "./overallQualityConditionCatalog.js";
import { UAD_SKETCH_FIELDS } from "./sketchCatalog.js";
import { UAD_SITE_ENTITY_GROUPS, UAD_SITE_FIELDS } from "./siteCatalog.js";
import {
  UAD_SUBJECT_PROPERTY_AMENITIES_ENTITY_GROUPS,
  UAD_SUBJECT_PROPERTY_AMENITIES_FIELDS,
} from "./subjectPropertyAmenitiesCatalog.js";
import {
  UAD_UNIT_INTERIOR_ENTITY_GROUPS,
  UAD_UNIT_INTERIOR_FIELDS,
} from "./unitInteriorCatalog.js";
import {
  UAD_VEHICLE_STORAGE_ENTITY_GROUPS,
  UAD_VEHICLE_STORAGE_FIELDS,
} from "./vehicleStorageCatalog.js";

export const UAD_REPEATABLE_ENTITY_GROUPS = Object.freeze({
  ...UAD_SITE_ENTITY_GROUPS,
  ...UAD_DISASTER_ENERGY_ENTITY_GROUPS,
  ...UAD_DWELLING_EXTERIOR_ENTITY_GROUPS,
  ...UAD_MANUFACTURED_HOME_ENTITY_GROUPS,
  ...UAD_UNIT_INTERIOR_ENTITY_GROUPS,
  ...UAD_OUTBUILDING_ENTITY_GROUPS,
  ...UAD_VEHICLE_STORAGE_ENTITY_GROUPS,
  ...UAD_SUBJECT_PROPERTY_AMENITIES_ENTITY_GROUPS,
  ...UAD_MARKET_ENTITY_GROUPS,
});

const UAD_EDITOR_SECTIONS = Object.freeze({
  assignment: { title: "Assignment Information", officialSectionNumber: 2 },
  subject: { title: "Subject Property", officialSectionNumber: 3 },
  site: { title: "Site", officialSectionNumber: 4 },
  disaster_mitigation: { title: "Disaster Mitigation", officialSectionNumber: 5 },
  energy_green: { title: "Energy Efficient and Green Features", officialSectionNumber: 6 },
  sketch: { title: "Sketch", officialSectionNumber: 7 },
  dwelling_exterior: { title: "Dwelling Exterior", officialSectionNumber: 8 },
  manufactured_home: {
    title: "Manufactured Home",
    officialSectionNumber: 9,
    appliesToEntityType: "dwelling",
    appliesWhen: manufacturedDwelling,
  },
  unit_interior: { title: "Unit Interior", officialSectionNumber: 10 },
  functional_obsolescence: { title: "Functional Obsolescence", officialSectionNumber: 11 },
  outbuilding: { title: "Outbuilding", officialSectionNumber: 12 },
  vehicle_storage: { title: "Vehicle Storage", officialSectionNumber: 13 },
  subject_property_amenities: { title: "Subject Property Amenities", officialSectionNumber: 14 },
  overall_quality_condition: { title: "Overall Quality and Condition", officialSectionNumber: 15 },
  highest_best_use: { title: "Highest and Best Use", officialSectionNumber: 16 },
  market: { title: "Market", officialSectionNumber: 17 },
});

const inspectionMethods = ["NoInspection", "Physical", "Virtual"];

const fields = [
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0034",
    reportFieldId: "2.000",
    label: "Assignment reason",
    dataType: "enum",
    required: true,
    options: [
      "Construction", "DeedInLieu", "HomeEquity", "LoanModification", "Other",
      "PortfolioEvaluation", "Preforeclosure", "Purchase", "Refinance", "REO", "ShortSale",
    ],
  },
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0035",
    reportFieldId: "2.000",
    label: "Other assignment reason",
    dataType: "string",
    maxLength: 33,
    showWhen: { uid: "1000.0034", equals: "Other" },
  },
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0158",
    reportFieldId: "2.004",
    label: "Property valuation method",
    dataType: "enum",
    required: true,
    options: ["DesktopAppraisal", "ExteriorAppraisal", "HybridAppraisal", "TraditionalAppraisal"],
    initialValue: "TraditionalAppraisal",
  },
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0043",
    reportFieldId: "2.005",
    label: "Property Data Report used instead of an inspection",
    dataType: "boolean",
    required: true,
    initialValue: false,
  },
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0029",
    reportFieldId: "2.008",
    label: "Government agency appraisal",
    dataType: "enum",
    options: ["FHA", "USDA", "VA"],
  },
  {
    section: "assignment",
    group: "Assignment essentials",
    contextKey: "assignment",
    uid: "1000.0038",
    reportFieldId: "2.009",
    label: "Investor-requested identification code",
    dataType: "string",
    maxLength: 66,
  },
  ...[
    ["borrower", "Borrower", "1000.0101", "First name", 50],
    ["borrower", "Borrower", "1000.0170", "Middle name", 50],
    ["borrower", "Borrower", "1000.0102", "Last name", 50],
    ["borrower", "Borrower", "1000.0171", "Suffix", 10],
    ["borrower", "Borrower", "1000.0104", "Legal entity name", 150],
    ["seller", "Seller", "1000.0018", "First name", 50],
    ["seller", "Seller", "1000.0172", "Middle name", 50],
    ["seller", "Seller", "1000.0019", "Last name", 50],
    ["seller", "Seller", "1000.0173", "Suffix", 10],
    ["seller", "Seller", "1000.0020", "Legal entity name", 150],
    ["owner", "Current owner of public record", "1000.0022", "First name", 50],
    ["owner", "Current owner of public record", "1000.0174", "Middle name", 50],
    ["owner", "Current owner of public record", "1000.0023", "Last name", 50],
    ["owner", "Current owner of public record", "1000.0175", "Suffix", 10],
    ["owner", "Current owner of public record", "1000.0024", "Legal entity name", 150],
  ].map(([contextKey, group, uid, label, maxLength]) => ({
    section: "assignment",
    group,
    contextKey,
    uid,
    reportFieldId: contextKey === "borrower" ? "2.001" : contextKey === "seller" ? "2.002" : "2.003",
    label,
    dataType: "string",
    maxLength,
  })),
  {
    section: "assignment",
    group: "Appraiser inspection",
    contextKey: "appraiser_inspection",
    uid: "2400.0081",
    reportFieldId: "2.021",
    label: "Exterior inspection method",
    dataType: "enum",
    required: true,
    options: inspectionMethods,
    initialValue: "Physical",
  },
  {
    section: "assignment",
    group: "Appraiser inspection",
    contextKey: "appraiser_inspection",
    uid: "2400.0082",
    reportFieldId: "2.022",
    label: "Interior inspection method",
    dataType: "enum",
    required: true,
    options: inspectionMethods,
    initialValue: "Physical",
  },
  {
    section: "assignment",
    group: "Appraiser inspection",
    contextKey: "appraiser_inspection",
    uid: "2400.0080",
    reportFieldId: "2.023",
    label: "Inspection date",
    dataType: "date",
    required: true,
  },
  {
    section: "assignment",
    group: "Assignment commentary",
    contextKey: "assignment_commentary",
    uid: "0100.0044",
    reportFieldId: "2.061",
    label: "Additional assignment commentary",
    dataType: "text",
    maxLength: 5000,
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "0100.0007",
    reportFieldId: "3.000",
    label: "Address line",
    dataType: "string",
    required: true,
    maxLength: 100,
    sourcePath: "account.address",
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "1200.0052",
    reportFieldId: "3.000",
    label: "Unit designator",
    dataType: "enum",
    options: ["Unit"],
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "0100.0008",
    reportFieldId: "3.000",
    label: "Unit identifier",
    dataType: "string",
    maxLength: 12,
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "0100.0009",
    reportFieldId: "3.000",
    label: "City",
    dataType: "string",
    required: true,
    maxLength: 50,
    sourcePath: "account.city",
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "0100.0012",
    reportFieldId: "3.000",
    label: "State",
    dataType: "state",
    required: true,
    maxLength: 2,
    sourcePath: "location.metadata.source_state",
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject_address",
    uid: "0100.0011",
    reportFieldId: "3.000",
    label: "Postal code",
    dataType: "postal_code",
    required: true,
    maxLength: 10,
    sourcePath: "account.postal_code",
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject",
    uid: "0100.0010",
    reportFieldId: "3.002",
    label: "County",
    dataType: "string",
    required: true,
    maxLength: 24,
    sourcePath: "account.county",
  },
  {
    section: "subject",
    group: "Physical address",
    contextKey: "subject",
    uid: "0100.0017",
    reportFieldId: "3.003",
    label: "Neighborhood name",
    dataType: "string",
    maxLength: 66,
    sourcePath: "account.subdivision",
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0020",
    reportFieldId: "3.004",
    label: "Attachment type",
    dataType: "enum",
    required: true,
    options: ["Attached", "Detached"],
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0022",
    reportFieldId: "3.005",
    label: "Living units excluding ADUs",
    dataType: "integer",
    required: true,
    sourcePath: "primary_improvements.number_units",
    fallbackValue: 1,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0019",
    reportFieldId: "3.006",
    label: "Accessory dwelling units",
    dataType: "integer",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0021",
    reportFieldId: "3.007",
    label: "Dwellings containing units",
    dataType: "integer",
    required: true,
    fallbackValue: 1,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0033",
    reportFieldId: "3.008",
    label: "Special tax assessments",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0050",
    reportFieldId: "3.009",
    label: "Special assessment description and impact",
    dataType: "text",
    maxLength: 540,
    showWhen: { uid: "0100.0033", equals: true },
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0026",
    reportFieldId: "3.010",
    label: "Planned Unit Development (PUD)",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "2500.0168",
    reportFieldId: "3.011",
    label: "Project legal structure",
    dataType: "enum",
    options: ["Condominium", "Condop", "Cooperative"],
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0054",
    reportFieldId: "3.014",
    label: "Native American lands",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0047",
    reportFieldId: "3.015",
    label: "Site owned in common",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0100.0046",
    reportFieldId: "3.016",
    label: "Homeowner responsible for exterior maintenance",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0300.0010",
    reportFieldId: "3.017",
    label: "New construction",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Property characteristics",
    contextKey: "subject",
    uid: "0300.0066",
    reportFieldId: "3.018",
    label: "Construction stage",
    dataType: "enum",
    options: ["Complete", "Proposed", "UnderConstruction"],
    showWhen: { uid: "0300.0010", equals: true },
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0024",
    reportFieldId: "3.019",
    label: "Property rights appraised",
    dataType: "enum",
    required: true,
    options: ["FeeSimple", "Leasehold", "Other"],
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0053",
    reportFieldId: "3.019",
    label: "Other property rights",
    dataType: "string",
    maxLength: 33,
    showWhen: { uid: "0100.0024", equals: "Other" },
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0034",
    reportFieldId: "3.027",
    label: "All rights included in appraisal",
    dataType: "boolean",
    required: true,
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0036",
    reportFieldId: "3.028",
    label: "Rights not included",
    dataType: "multi_enum",
    options: ["AirRights", "MineralRights", "Other", "TimberRights", "WaterRights"],
    showWhen: { uid: "0100.0034", equals: false },
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0037",
    reportFieldId: "3.028",
    label: "Other excluded right",
    dataType: "string",
    maxLength: 33,
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0023",
    reportFieldId: "3.029",
    label: "Mineral rights leased",
    dataType: "boolean",
  },
  {
    section: "subject",
    group: "Ownership rights",
    contextKey: "subject_ownership",
    uid: "0100.0038",
    reportFieldId: "3.030",
    label: "Rights not appraised description",
    dataType: "text",
    maxLength: 540,
  },
  {
    section: "subject",
    group: "Legal description",
    contextKey: "subject_legal",
    uid: "0100.0067",
    reportFieldId: "3.031",
    label: "Legal description",
    dataType: "text",
    required: true,
    maxLength: 15000,
    sourcePath: "account.legal_description",
  },
  {
    section: "subject",
    group: "Subject commentary",
    contextKey: "subject_commentary",
    uid: "0100.0044",
    reportFieldId: "3.032",
    label: "Additional subject commentary",
    dataType: "text",
    maxLength: 5000,
  },
  ...UAD_SITE_FIELDS,
  ...UAD_DISASTER_ENERGY_FIELDS,
  ...UAD_SKETCH_FIELDS,
  ...UAD_DWELLING_EXTERIOR_FIELDS,
  ...UAD_MANUFACTURED_HOME_FIELDS,
  ...UAD_UNIT_INTERIOR_FIELDS,
  ...UAD_FUNCTIONAL_OBSOLESCENCE_FIELDS,
  ...UAD_OUTBUILDING_FIELDS,
  ...UAD_VEHICLE_STORAGE_FIELDS,
  ...UAD_SUBJECT_PROPERTY_AMENITIES_FIELDS,
  ...UAD_OVERALL_QUALITY_CONDITION_FIELDS,
  ...UAD_HIGHEST_BEST_USE_FIELDS,
  ...UAD_MARKET_FIELDS,
];

function fieldKey(field) {
  return `${field.contextKey}:${field.uid}`;
}

export const UAD_PHASE_ONE_FIELDS = Object.freeze(fields.map((field, ordinal) => Object.freeze({
  ...field,
  key: fieldKey(field),
  ordinal: ordinal + 1,
})));

const fieldByKey = new Map(UAD_PHASE_ONE_FIELDS.map((field) => [field.key, field]));

export const UAD_EDITOR_SECTION_KEYS = Object.freeze(Object.keys(UAD_EDITOR_SECTIONS));

function valueAtPath(document, path) {
  return String(path || "").split(".").reduce((value, segment) => value?.[segment], document);
}

function isBlank(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export function evaluateUadCondition(requestedCondition, lookup) {
  if (!requestedCondition) return true;
  if (Array.isArray(requestedCondition.all)) {
    return requestedCondition.all.every((item) => evaluateUadCondition(item, lookup));
  }
  if (Array.isArray(requestedCondition.any)) {
    return requestedCondition.any.some((item) => evaluateUadCondition(item, lookup));
  }
  if (requestedCondition.not) return !evaluateUadCondition(requestedCondition.not, lookup);

  const key = requestedCondition.key || (requestedCondition.uid ? requestedCondition.uid : null);
  const value = key ? lookup(key) : undefined;
  if (Object.hasOwn(requestedCondition, "equals")) return value === requestedCondition.equals;
  if (Object.hasOwn(requestedCondition, "notEquals")) return value !== requestedCondition.notEquals;
  if (Object.hasOwn(requestedCondition, "greaterThan")) {
    const numericValue = value && typeof value === "object" && !Array.isArray(value) ? value.amount : value;
    return Number(numericValue) > Number(requestedCondition.greaterThan);
  }
  if (Object.hasOwn(requestedCondition, "contains")) return Array.isArray(value) && value.includes(requestedCondition.contains);
  if (Object.hasOwn(requestedCondition, "present")) return isBlank(value) !== Boolean(requestedCondition.present);
  return true;
}

export function uadFieldIsVisible(field, lookup) {
  return evaluateUadCondition(field.showWhen, (requestedKey) => {
    if (requestedKey.includes(":")) return lookup(requestedKey);
    return lookup(requestedKey, { uidOnly: true });
  });
}

export function uadFieldIsRequired(field, lookup) {
  return Boolean(field.required || (field.requiredWhen && evaluateUadCondition(field.requiredWhen, lookup)));
}

function entityDataMatches(filter, data) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => data?.[key] === value);
}

export function uadFieldAppliesToEntity(field, entity) {
  return Boolean(
    entity
    && field.entityType === entity.entity_type
    && entityDataMatches(field.entityDataFilter, entity.data),
  );
}

export function buildUadPrefillValues(subjectSnapshot) {
  const values = [];
  for (const field of UAD_PHASE_ONE_FIELDS) {
    if (field.entityType) continue;
    let value = field.sourcePath ? valueAtPath(subjectSnapshot, field.sourcePath) : undefined;
    let sourceReference = field.sourcePath ? `subject_snapshot.${field.sourcePath}` : null;

    if (isBlank(value) && field.sourcePath === "location.metadata.source_state") {
      const county = String(subjectSnapshot?.account?.county || "").toLowerCase();
      if (county === "dallas" || county === "collin") {
        value = "TX";
        sourceReference = "subject_snapshot.account.county:Texas county inference";
      }
    }
    if (isBlank(value) && field.fallbackValue !== undefined) {
      value = field.fallbackValue;
      sourceReference = "uad_workfile.traditional_single_family_default";
    }
    if (isBlank(value) && field.initialValue !== undefined) {
      value = field.initialValue;
      sourceReference = "uad_workfile.initial_assignment_default";
    }
    if (isBlank(value)) continue;
    values.push({ field, value, sourceReference });
  }
  return values;
}

export function getUadField(contextKey, uid) {
  return fieldByKey.get(`${String(contextKey || "").trim()}:${String(uid || "").trim()}`) || null;
}

export function getUadEditorSections() {
  const sections = [];
  for (const sectionKey of UAD_EDITOR_SECTION_KEYS) {
    const sectionFields = UAD_PHASE_ONE_FIELDS.filter((field) => field.section === sectionKey);
    const groups = [];
    for (const field of sectionFields) {
      let group = groups.find((candidate) => candidate.name === field.group);
      if (!group) {
        const repeatable = field.entityType ? UAD_REPEATABLE_ENTITY_GROUPS[field.entityType] : null;
        const variant = repeatable?.variants?.[field.group] || null;
        group = {
          name: field.group,
          fields: [],
          ...(repeatable ? {
            entityType: field.entityType,
            addLabel: variant?.addLabel ?? repeatable.addLabel,
            minItems: variant?.minItems ?? repeatable.minItems,
            maxItems: variant?.maxItems ?? repeatable.maxItems,
            createEnabled: variant?.createEnabled ?? repeatable.createEnabled,
            parentEntityType: variant?.parentEntityType ?? repeatable.parentEntityType,
            parentEntityTypes: variant?.parentEntityTypes ?? repeatable.parentEntityTypes,
            showWhen: variant?.showWhen ?? repeatable.showWhen,
            entityDataFilter: variant?.entityDataFilter,
            createData: variant?.createData,
          } : {}),
        };
        groups.push(group);
      }
      const { sourcePath: _sourcePath, fallbackValue: _fallbackValue, initialValue: _initialValue, ...publicField } = field;
      group.fields.push(publicField);
    }
    const metadata = UAD_EDITOR_SECTIONS[sectionKey];
    sections.push({
      key: sectionKey,
      title: metadata.title,
      officialSectionNumber: metadata.officialSectionNumber,
      ...(metadata.appliesWhen ? {
        appliesToEntityType: metadata.appliesToEntityType,
        appliesWhen: metadata.appliesWhen,
      } : {}),
      groups,
    });
  }
  return sections;
}

function invalid(field, code, message) {
  return { key: field.key, uid: field.uid, context_key: field.contextKey, code, message };
}

export function normalizeAndValidateUadValue(field, rawValue) {
  if (!field) throw new Error("invalid_uad_field");
  if (isBlank(rawValue)) {
    return field.required
      ? { value: null, error: invalid(field, "required", `${field.label} is required.`) }
      : { value: null, error: null };
  }

  if (field.dataType === "boolean") {
    return typeof rawValue === "boolean"
      ? { value: rawValue, error: null }
      : { value: null, error: invalid(field, "boolean", `${field.label} must be Yes or No.`) };
  }

  if (field.dataType === "integer") {
    const value = typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
    const validMinimum = field.minimum == null || value >= field.minimum;
    const validMaximum = field.maximum == null || value <= field.maximum;
    return Number.isInteger(value) && validMinimum && validMaximum
      ? { value, error: null }
      : { value: null, error: invalid(field, "integer", `${field.label} must be a whole number in the supported range.`) };
  }

  if (field.dataType === "percentage") {
    const value = typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
    return Number.isFinite(value) && value >= 0 && value <= 100
      ? { value, error: null }
      : { value: null, error: invalid(field, "percentage", `${field.label} must be between 0 and 100.`) };
  }

  if (field.dataType === "currency") {
    const value = typeof rawValue === "number" ? rawValue : Number(String(rawValue).trim());
    const minimumOk = field.minimum == null || value >= field.minimum;
    const exclusiveMinimumOk = field.minimumExclusive == null || value > field.minimumExclusive;
    const maximumOk = field.maximum == null || value <= field.maximum;
    return Number.isFinite(value) && minimumOk && exclusiveMinimumOk && maximumOk
      ? { value, error: null }
      : { value: null, error: invalid(field, "currency", `${field.label} must be a valid dollar amount in the supported range.`) };
  }

  if (field.dataType === "measurement") {
    const amount = Number(rawValue?.amount);
    const unit = String(rawValue?.unit || "").trim();
    const minimumOk = field.minimum == null || amount >= field.minimum;
    const exclusiveMinimumOk = field.minimumExclusive == null || amount > field.minimumExclusive;
    const maximumOk = field.maximum == null || amount <= field.maximum;
    return Number.isFinite(amount) && minimumOk && exclusiveMinimumOk && maximumOk && field.units.includes(unit)
      ? { value: { amount, unit }, error: null }
      : { value: null, error: invalid(field, "measurement", `${field.label} requires a valid amount and unit.`) };
  }

  if (field.dataType === "multi_enum") {
    const value = Array.isArray(rawValue) ? [...new Set(rawValue.map(String))] : [];
    return value.length > 0 && value.every((item) => field.options.includes(item))
      ? { value, error: null }
      : { value: null, error: invalid(field, "enumeration", `${field.label} contains an unsupported selection.`) };
  }

  let value = String(rawValue).trim();
  if (field.dataType === "state") value = value.toUpperCase();
  if (field.maxLength && value.length > field.maxLength) {
    return { value: null, error: invalid(field, "max_length", `${field.label} cannot exceed ${field.maxLength} characters.`) };
  }
  if (field.dataType === "enum" && !field.options.includes(value)) {
    return { value: null, error: invalid(field, "enumeration", `${field.label} contains an unsupported selection.`) };
  }
  if (field.dataType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { value: null, error: invalid(field, "date", `${field.label} must use YYYY-MM-DD.`) };
  }
  if (field.dataType === "year" && !/^\d{4}$/.test(value)) {
    return { value: null, error: invalid(field, "year", `${field.label} must use YYYY.`) };
  }
  if (field.dataType === "postal_code" && !/^\d{5}(?:-\d{4})?$/.test(value)) {
    return { value: null, error: invalid(field, "postal_code", `${field.label} must be a five-digit ZIP or ZIP+4.`) };
  }
  if (field.dataType === "state" && !/^[A-Z]{2}$/.test(value)) {
    return { value: null, error: invalid(field, "state", `${field.label} must be a two-letter state code.`) };
  }
  return { value, error: null };
}

export function validateUadSectionValues(
  section,
  submittedValues,
  { entityTypesById = new Map(), entityDataById = new Map() } = {},
) {
  if (!UAD_EDITOR_SECTION_KEYS.includes(section)) throw new Error("invalid_uad_section");
  if (!Array.isArray(submittedValues) || submittedValues.length > 1000) {
    throw new Error("invalid_uad_field_values");
  }

  const normalized = [];
  const errors = [];
  const seen = new Set();
  for (const submitted of submittedValues) {
    const field = getUadField(submitted?.context_key, submitted?.uid);
    const entityId = submitted?.entity_id || null;
    const submittedKey = `${entityId || "root"}:${field?.key || "unknown"}`;
    const entityType = entityId ? entityTypesById.get(entityId) : null;
    const entityData = entityId ? entityDataById.get(entityId) : null;
    if (
      !field || field.section !== section || seen.has(submittedKey) ||
      (field.entityType && entityType !== field.entityType) ||
      (field.entityType && !entityDataMatches(field.entityDataFilter, entityData)) ||
      (!field.entityType && entityId)
    ) {
      throw new Error("invalid_uad_field_values");
    }
    seen.add(submittedKey);
    const result = normalizeAndValidateUadValue(field, submitted.value);
    if (result.error) errors.push(result.error);
    normalized.push({ field, value: result.value, entityId });
  }
  return { normalized, errors };
}
