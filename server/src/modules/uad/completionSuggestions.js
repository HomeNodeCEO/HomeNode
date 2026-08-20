import { loadSharedAppraisalCompletion } from "../../services/appraisalCompletionAdapter.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

export const UAD_COMPLETION_SUGGESTION_SCHEMA_VERSION = 1;
export const UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION = "2026-08-20.4";

const MAX_OMISSIONS = 200;
const UAD_CONDITION = /^C[1-6]$/;
const UAD_QUALITY = /^Q[1-6]$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, maxLength = 5_000) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function isoDate(value) {
  const normalized = text(value, 40);
  if (!normalized) return null;
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : `${match[1]}-${match[2]}-${match[3]}`;
}

function sourceMetadata(completion, path) {
  return {
    source_reference: `custom_appraisal_completion:${completion.source.report_file_id}:${path}`,
    source_digest_sha256: completion.provenance.source_digest_sha256,
    observed_at: completion.generated_at,
    requires_appraiser_confirmation: true,
  };
}

function field(fieldKey, value, completion, path, options = {}) {
  if (value === null || value === undefined || value === "") return null;
  const target = plainObject(options.target_entity) ? options.target_entity : null;
  const suppliedSuggestionId = options.suggestion_id;
  const metadata = { ...options };
  delete metadata.suggestion_id;
  delete metadata.target_entity;
  return {
    suggestion_id: suppliedSuggestionId || `field:${target ? `${target.entity_type}:${target.entity_identifier}:` : ""}${fieldKey}`,
    field_key: fieldKey,
    value,
    ...(target ? { target_entity: target } : {}),
    ...sourceMetadata(completion, path),
    ...metadata,
  };
}

function addField(target, suggestion) {
  if (suggestion) target.push(suggestion);
}

function addOmission(omissions, omission) {
  if (omissions.length >= MAX_OMISSIONS) return;
  omissions.push(omission);
}

function boundaryDescription(boundary) {
  const values = [
    ["North", boundary?.north],
    ["East", boundary?.east],
    ["South", boundary?.south],
    ["West", boundary?.west],
  ].flatMap(([label, value]) => text(value, 250) ? [`${label}: ${text(value, 250)}`] : []);
  return values.length ? values.join("; ").slice(0, 1_250) : null;
}

function preferredMarketStudy(studies) {
  if (!Array.isArray(studies) || !studies.length) return null;
  return studies.find((study) => String(study?.market?.key || "").toLowerCase() === "appraiser")
    || studies.find((study) => String(study?.market?.key || "").toLowerCase() === "zip")
    || studies[0];
}

const ASSIGNMENT_REASON_BY_TYPE = Object.freeze({
  construction: "Construction",
  new_construction: "Construction",
  heloc: "HomeEquity",
  home_equity: "HomeEquity",
  purchase: "Purchase",
  purchase_transaction: "Purchase",
  refinance: "Refinance",
});

function normalizedToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function buildAssignmentSuggestions(completion, omissions) {
  const fields = [];
  const assignmentTypes = Array.isArray(completion.assignment?.assignment_types)
    ? completion.assignment.assignment_types.map(normalizedToken).filter(Boolean)
    : [];
  const mappedReasons = [...new Set(assignmentTypes.map((value) => ASSIGNMENT_REASON_BY_TYPE[value]).filter(Boolean))];
  if (assignmentTypes.length === 1 && mappedReasons.length === 1) {
    addField(fields, field(
      "assignment:1000.0034",
      mappedReasons[0],
      completion,
      "assignment.assignment_types.0",
    ));
  } else if (assignmentTypes.length) {
    addOmission(omissions, {
      scope: "assignment",
      code: mappedReasons.length > 1
        ? "multiple_assignment_reasons_require_appraiser_selection"
        : "assignment_reason_requires_appraiser_selection",
      source_value: assignmentTypes,
      target_field_key: "assignment:1000.0034",
    });
  }

  addField(fields, field(
    "appraiser_inspection:2400.0080",
    isoDate(completion.assignment_scope?.inspection_date),
    completion,
    "assignment_scope.inspection_date",
  ));
  return { fields };
}

function occupancy(value) {
  const normalized = normalizedToken(value);
  if (["owner", "owner_occupied", "owneroccupied"].includes(normalized)) return "OwnerOccupied";
  if (["tenant", "tenant_occupied", "tenantoccupied"].includes(normalized)) return "Tenant";
  if (normalized === "vacant") return "Vacant";
  return null;
}

function entityTarget(entityType, entityIdentifier) {
  return { entity_type: entityType, entity_identifier: entityIdentifier };
}

const DWELLING_STYLE_BY_TOKEN = Object.freeze({
  a_frame: "AFrame", aframe: "AFrame", barn: "Barn", bi_level: "BiLevel", bilevel: "BiLevel",
  bungalow: "Bungalow", cape_cod: "CapeCod", chalet: "Chalet", colonial: "Colonial",
  contemporary: "Contemporary", cottage: "Cottage", craftsman: "Craftsman", earth_berm: "EarthBerm",
  farmhouse: "Farmhouse", geodesic_dome: "GeodesicDome", georgian: "Georgian", log: "Log",
  mediterranean: "Mediterranean", modern: "Modern", neo_eclectic: "NeoEclectic",
  raised_ranch: "RaisedRanch", rambler: "Rambler", ranch: "Ranch", southwest: "Southwest",
  spanish: "Spanish", split_foyer: "SplitFoyerOrEntry", split_foyer_or_entry: "SplitFoyerOrEntry",
  split_entry: "SplitFoyerOrEntry", split_level: "SplitLevel", stilt: "Stilt",
  traditional: "Traditional", tudor: "Tudor", victorian: "Victorian",
});

function exactAttachment(value) {
  const normalized = normalizedToken(value);
  if (normalized === "attached") return "Attached";
  if (normalized === "detached") return "Detached";
  return null;
}

function exactDwellingStyle(value) {
  const original = text(value, 200);
  if (!original) return null;
  const mapped = DWELLING_STYLE_BY_TOKEN[normalizedToken(original)];
  if (mapped) return { value: mapped, other: null };
  if (original.length <= 33 && !/[,/;&]/.test(original)) return { value: "Other", other: original };
  return null;
}

function coolingProfile(value) {
  const normalized = normalizedToken(value);
  if (!normalized) return null;
  if (["none", "no", "no_ac", "not_available"].includes(normalized)) return { exists: false, systems: null };
  if (["central", "central_air", "central_ac", "centralized"].includes(normalized)) {
    return { exists: true, systems: ["Centralized"] };
  }
  if (["individual", "window", "window_unit", "room_unit"].includes(normalized)) {
    return { exists: true, systems: ["Individual"] };
  }
  return null;
}

function dimensionValue(value) {
  const parsed = number(value);
  if (parsed === null || parsed <= 0) return null;
  return Number.isInteger(parsed) ? String(parsed) : String(Math.round(parsed * 100) / 100);
}

function buildSubjectEntitySuggestions(completion, omissions) {
  const fields = [];
  const identity = completion.subject?.identity || {};
  const characteristics = completion.subject?.characteristics || {};
  const unitTarget = entityTarget("unit", "unit-1");
  const dwellingTarget = entityTarget("dwelling", "dwelling-1");
  const parcelTarget = entityTarget("site_parcel", "site-parcel-1");
  const vehicleTarget = entityTarget("vehicle_storage", "vehicle-storage-1");
  const addEntityField = (fieldKey, value, path, target) => addField(fields, field(
    fieldKey, value, completion, path, { target_entity: target },
  ));

  addField(fields, field("subject_address:0100.0007", text(identity.address, 100), completion, "subject.identity.address"));
  addField(fields, field("subject_address:0100.0009", text(identity.city, 50), completion, "subject.identity.city"));
  const state = text(identity.state, 2)?.toUpperCase();
  addField(fields, field("subject_address:0100.0012", state && /^[A-Z]{2}$/.test(state) ? state : null, completion, "subject.identity.state"));
  addField(fields, field("subject_address:0100.0011", text(identity.postal_code, 10), completion, "subject.identity.postal_code"));
  addField(fields, field("subject:0100.0010", text(identity.county, 24), completion, "subject.identity.county"));
  addField(fields, field("subject:0100.0017", text(identity.neighborhood_name, 66), completion, "subject.identity.neighborhood_name"));

  const legalDescriptions = Array.isArray(identity.legal_descriptions)
    ? [...new Set(identity.legal_descriptions.map((value) => text(value, 15_000)).filter(Boolean))]
    : [];
  if (legalDescriptions.length === 1) {
    addField(fields, field("subject_legal:0100.0067", legalDescriptions[0], completion, "subject.identity.legal_descriptions.0"));
  } else if (legalDescriptions.length > 1) {
    addOmission(omissions, {
      scope: "subject", code: "multiple_legal_descriptions_require_appraiser_reconciliation",
      source_value: legalDescriptions, target_field_key: "subject_legal:0100.0067",
    });
  }

  const attachment = exactAttachment(characteristics.attachment_type);
  addField(fields, field("subject:0100.0020", attachment, completion, "subject.characteristics.attachment_type"));
  if (text(characteristics.attachment_type, 200) && !attachment) {
    addOmission(omissions, {
      scope: "subject", code: "subject_attachment_requires_appraiser_selection",
      source_value: text(characteristics.attachment_type, 200), target_field_key: "subject:0100.0020",
    });
  }
  if (text(characteristics.housing_type, 200)) {
    addOmission(omissions, {
      scope: "subject", code: "subject_unit_counts_require_appraiser_confirmation",
      source_value: text(characteristics.housing_type, 200), target_field_key: "subject:0100.0022",
    });
  }

  const occupancyValue = occupancy(completion.assignment?.occupancy);
  addEntityField("unit:0700.0070", occupancyValue, "assignment.occupancy", unitTarget);
  if (text(completion.assignment?.occupancy, 80) && !occupancyValue) {
    addOmission(omissions, {
      scope: "subject", code: "subject_occupancy_requires_appraiser_selection",
      source_value: text(completion.assignment.occupancy, 80), target_field_key: "unit:0700.0070",
    });
  }

  const gla = number(characteristics.gross_living_area_sqft);
  if (gla !== null && gla >= 0 && gla <= 999_999_999) {
    addEntityField("unit:0700.0140", { amount: gla, unit: "SquareFeet" }, "subject.characteristics.gross_living_area_sqft", unitTarget);
  }
  addEntityField("unit:0700.0118", integer(characteristics.bedrooms, 0, 99), "subject.characteristics.bedrooms", unitTarget);
  addEntityField("unit:0700.0119", integer(characteristics.full_baths, 0, 99), "subject.characteristics.full_baths", unitTarget);
  addEntityField("unit:0700.0120", integer(characteristics.half_baths, 0, 99), "subject.characteristics.half_baths", unitTarget);

  const site = plainObject(characteristics.site) ? characteristics.site : {};
  const siteArea = number(site.total_area_sqft ?? characteristics.site_area_sqft);
  if (siteArea !== null && siteArea > 0 && siteArea <= 999_999_999) {
    addField(fields, field("site:1500.0093", { amount: siteArea, unit: "SquareFeet" }, completion, "subject.characteristics.site.total_area_sqft"));
    addEntityField("site_parcel:1500.0022", { amount: siteArea, unit: "SquareFeet" }, "subject.characteristics.site.total_area_sqft", parcelTarget);
  }
  const frontage = dimensionValue(site.dimensions?.frontage_ft);
  const depth = dimensionValue(site.dimensions?.depth_ft);
  if (frontage && depth) {
    addField(fields, field("site:1500.0160", frontage + " ft x " + depth + " ft", completion, "subject.characteristics.site.dimensions"));
  }

  const parcelIds = Array.isArray(identity.parcel_ids)
    ? [...new Set(identity.parcel_ids.map((value) => text(value, 60)).filter(Boolean))]
    : [];
  if (parcelIds.length === 1) {
    addField(fields, field("site:1500.0094", 1, completion, "subject.identity.parcel_ids"));
    addEntityField("site_parcel:1500.0027", parcelIds[0], "subject.identity.parcel_ids.0", parcelTarget);
    addOmission(omissions, { scope: "site_parcel", code: "site_parcel_description_requires_appraiser_selection", target_field_key: "site_parcel:1500.0023" });
  } else if (parcelIds.length > 1) {
    addField(fields, field("site:1500.0094", parcelIds.length, completion, "subject.identity.parcel_ids"));
    addOmission(omissions, {
      scope: "site", code: "multiple_site_parcels_require_appraiser_reconciliation",
      source_value: parcelIds, target_field_key: "site_parcel:1500.0027",
    });
  }

  const zoningClassifications = Array.isArray(site.zoning_classifications)
    ? [...new Set(site.zoning_classifications.map((value) => text(value, 100)).filter(Boolean))]
    : [];
  const zoningDescriptions = Array.isArray(site.zoning_descriptions)
    ? [...new Set(site.zoning_descriptions.map((value) => text(value, 500)).filter(Boolean))]
    : [];
  if (zoningClassifications.length === 1) {
    addField(fields, field("site_zoning:1500.0122", text(zoningClassifications[0], 33), completion, "subject.characteristics.site.zoning_classifications.0"));
    addOmission(omissions, {
      scope: "site_zoning", code: "zoning_compliance_requires_appraiser_selection",
      source_value: zoningClassifications[0], target_field_key: "site_zoning:1500.0125",
    });
    if (zoningDescriptions.length === 1) {
      addField(fields, field("site_zoning:1500.0123", text(zoningDescriptions[0], 100), completion, "subject.characteristics.site.zoning_descriptions.0"));
    } else {
      addOmission(omissions, {
        scope: "site_zoning",
        code: zoningDescriptions.length > 1 ? "multiple_zoning_descriptions_require_appraiser_reconciliation" : "zoning_description_requires_appraiser_entry",
        source_value: zoningDescriptions, target_field_key: "site_zoning:1500.0123",
      });
    }
  } else if (zoningClassifications.length > 1) {
    addOmission(omissions, {
      scope: "site_zoning", code: "multiple_zoning_classifications_require_appraiser_reconciliation",
      source_value: zoningClassifications, target_field_key: "site_zoning:1500.0122",
    });
  }

  const yearBuilt = integer(characteristics.year_built, 1000, 9999);
  addEntityField("dwelling:0300.0011", yearBuilt === null ? null : String(yearBuilt), "subject.characteristics.year_built", dwellingTarget);
  const effectiveYear = integer(characteristics.effective_year_built, 1000, 9999);
  const effectiveDate = isoDate(completion.assignment_scope?.effective_date);
  const effectiveDateYear = effectiveDate ? Number(effectiveDate.slice(0, 4)) : null;
  const effectiveAge = effectiveYear !== null && effectiveDateYear !== null && effectiveDateYear >= effectiveYear ? effectiveDateYear - effectiveYear : null;
  addEntityField("dwelling:0300.0039", integer(effectiveAge, 0, 999), "subject.characteristics.effective_year_built", dwellingTarget);

  const style = attachment === "Detached" ? exactDwellingStyle(characteristics.architectural_style) : null;
  if (style) {
    addEntityField("dwelling:0300.0030", style.value, "subject.characteristics.architectural_style", dwellingTarget);
    addEntityField("dwelling:0300.0031", style.other, "subject.characteristics.architectural_style", dwellingTarget);
  } else if (text(characteristics.architectural_style, 200)) {
    addOmission(omissions, {
      scope: "dwelling",
      code: attachment === "Attached" ? "attached_structure_design_requires_appraiser_selection" : "dwelling_style_requires_appraiser_selection",
      source_value: text(characteristics.architectural_style, 200),
      target_field_key: attachment === "Attached" ? "dwelling:0300.0032" : "dwelling:0300.0030",
    });
  }

  const cooling = coolingProfile(characteristics.air_conditioning);
  if (cooling) {
    addEntityField("dwelling:0300.0022", cooling.exists, "subject.characteristics.air_conditioning", dwellingTarget);
    addEntityField("dwelling:0300.0084", cooling.systems, "subject.characteristics.air_conditioning", dwellingTarget);
  } else if (text(characteristics.air_conditioning, 200)) {
    addOmission(omissions, {
      scope: "dwelling", code: "cooling_system_requires_appraiser_selection",
      source_value: text(characteristics.air_conditioning, 200), target_field_key: "dwelling:0300.0084",
    });
  }

  const vehicleStorage = Array.isArray(characteristics.vehicle_storage) ? characteristics.vehicle_storage.filter(plainObject) : [];
  if (vehicleStorage.length === 1) {
    const storage = vehicleStorage[0];
    const description = text(storage.description, 200);
    const storageType = /\bgarage\b/i.test(description || "") ? "Garage" : /\bcarport\b/i.test(description || "") ? "Carport" : null;
    const storageAttachment = /\bbuilt[ -]?in\b/i.test(description || "") ? "BuiltIn"
      : /\battached\b/i.test(description || "") ? "Attached"
        : /\bdetached\b/i.test(description || "") ? "Detached" : null;
    addEntityField("vehicle_storage:3200.0006", storageType, "subject.characteristics.vehicle_storage.0.description", vehicleTarget);
    addEntityField("vehicle_storage:3200.0005", storageAttachment, "subject.characteristics.vehicle_storage.0.description", vehicleTarget);
    const storageArea = number(storage.area_sqft);
    if (storageArea !== null && storageArea > 0) {
      addEntityField("vehicle_storage:3200.0004", { amount: storageArea, unit: "SquareFeet" }, "subject.characteristics.vehicle_storage.0.area_sqft", vehicleTarget);
    }
    const parkingSpaces = integer(storage.parking_spaces, 0, 99);
    addEntityField("vehicle_storage:3200.0010", parkingSpaces, "subject.characteristics.vehicle_storage.0.parking_spaces", vehicleTarget);
    if (!storageType || !storageAttachment) {
      addOmission(omissions, {
        scope: "vehicle_storage", code: "vehicle_storage_classification_requires_appraiser_selection",
        source_value: description, target_field_key: !storageType ? "vehicle_storage:3200.0006" : "vehicle_storage:3200.0005",
      });
    }
    if (parkingSpaces === null) {
      addOmission(omissions, {
        scope: "vehicle_storage", code: "vehicle_storage_parking_count_requires_appraiser_entry",
        source_value: description, target_field_key: "vehicle_storage:3200.0010",
      });
    }
  } else if (vehicleStorage.length > 1) {
    addOmission(omissions, {
      scope: "vehicle_storage", code: "multiple_vehicle_storage_records_require_appraiser_reconciliation",
      source_value: vehicleStorage.map((item) => item.description).filter(Boolean), target_field_key: "vehicle_storage:3200.0006",
    });
  }

  if (text(characteristics.foundation, 200) || text(characteristics.exterior_material, 200)) {
    addOmission(omissions, {
      scope: "dwelling", code: "exterior_components_require_appraiser_condition_review",
      source_value: { foundation: text(characteristics.foundation, 200), exterior_material: text(characteristics.exterior_material, 200) },
    });
  }
  if (number(characteristics.fireplace_count) > 0 || characteristics.pool_present === true) {
    addOmission(omissions, {
      scope: "subject_amenities", code: "subject_amenities_require_appraiser_classification",
      source_value: { fireplace_count: number(characteristics.fireplace_count), pool_present: characteristics.pool_present === true },
    });
  }

  const conditionRating = exactRating(characteristics.condition_rating, UAD_CONDITION);
  const qualityRating = exactRating(characteristics.quality_rating, UAD_QUALITY);
  addEntityField("dwelling:1600.0004", conditionRating, "subject.characteristics.condition_rating", dwellingTarget);
  addEntityField("dwelling:1600.0005", qualityRating, "subject.characteristics.quality_rating", dwellingTarget);
  if (text(characteristics.condition_rating, 20) && !conditionRating) {
    addOmission(omissions, {
      scope: "subject", code: "subject_condition_range_requires_appraiser_reconciliation",
      source_value: text(characteristics.condition_rating, 20), target_field_key: "dwelling:1600.0004",
    });
  }
  if (text(characteristics.quality_rating, 20) && !qualityRating) {
    addOmission(omissions, {
      scope: "subject", code: "subject_quality_range_requires_appraiser_reconciliation",
      source_value: text(characteristics.quality_rating, 20), target_field_key: "dwelling:1600.0005",
    });
  }
  return { fields };
}
function currentUseConclusion(value) {
  const normalized = normalizedToken(value);
  if (["current_use", "existing_use", "present_use"].includes(normalized)) return true;
  if (["alternative_use", "not_current_use", "different_use"].includes(normalized)) return false;
  return null;
}

function buildHighestBestUseSuggestions(completion, omissions) {
  const fields = [];
  const hbu = completion.assignment?.highest_best_use || {};
  const conclusion = currentUseConclusion(hbu.conclusion);
  addField(fields, field(
    "highest_best_use:3100.0007",
    conclusion,
    completion,
    "assignment.highest_best_use.conclusion",
  ));
  addField(fields, field(
    "highest_best_use_commentary:3100.0010",
    text(hbu.summary, 2_500),
    completion,
    "assignment.highest_best_use.summary",
  ));
  if (text(hbu.conclusion, 80) && conclusion === null) {
    addOmission(omissions, {
      scope: "highest_best_use",
      code: "highest_best_use_conclusion_requires_appraiser_selection",
      source_value: text(hbu.conclusion, 80),
      target_field_key: "highest_best_use:3100.0007",
    });
  }
  return { fields };
}

function activityRows(completion) {
  return Array.isArray(completion.subject?.activity_history)
    ? completion.subject.activity_history.filter(plainObject)
    : [];
}

function activitySourceKey(row, ordinal) {
  return text(
    row.source_record_id
      || row.id
      || row.listing_key
      || row.listing_id
      || [row.record_type, row.activity_date, row.closing_date, ordinal].filter(Boolean).join("-"),
    160,
  ) || `ordinal-${ordinal}`;
}

function activityIsMls(row) {
  return Boolean(
    text(row.listing_id || row.listing_key, 80)
    || /\bmls\b/i.test(String(row.source || "")),
  );
}

function listingStatus(row) {
  const normalized = String(row.mls_status || row.record_type || "").toLowerCase();
  if (/pending|contract|option/.test(normalized)) return "Pending";
  if (/active/.test(normalized)) return "Active";
  return "OffMarket";
}

function validCurrency(value, { minimum = 0 } = {}) {
  const parsed = number(value);
  return parsed !== null && parsed >= minimum && parsed <= 999_999_999.99 ? parsed : null;
}

function buildSubjectListingSuggestions(completion, omissions) {
  const fields = [];
  const entities = activityRows(completion)
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter(({ row }) => ["listing", "contract"].includes(normalizedToken(row.record_type)))
    .slice(0, 6)
    .map(({ row, sourceIndex }, index) => {
      const ordinal = index + 1;
      const sourceKey = activitySourceKey(row, ordinal);
      const isMls = activityIsMls(row);
      const values = {
        "subject_listing:0900.0013": listingStatus(row),
        "subject_listing:0900.0015": isMls ? "MLS" : "Other",
      };
      const setValue = (key, value) => {
        if (value !== null && value !== undefined && value !== "") values[key] = value;
      };
      setValue("subject_listing:0900.0011", text(row.listing_id || row.listing_key, 45));
      setValue("subject_listing:0900.0012", isoDate(row.listing_date));
      setValue("subject_listing:0900.0007", integer(row.days_on_market, 0, 9_999));
      setValue("subject_listing:0900.0008", validCurrency(row.list_price));
      if (!isMls) {
        setValue("subject_listing:0900.0016", text(row.source || "Other listing source", 45));
      }
      if (integer(row.days_on_market, 0, 9_999) === null) {
        addOmission(omissions, {
          scope: `subject_listing:${sourceKey}`,
          code: "subject_listing_days_on_market_requires_appraiser_entry",
          target_field_key: "subject_listing:0900.0007",
        });
      }
      if (validCurrency(row.list_price) === null) {
        addOmission(omissions, {
          scope: `subject_listing:${sourceKey}`,
          code: "subject_listing_final_price_requires_appraiser_entry",
          target_field_key: "subject_listing:0900.0008",
        });
      }
      return {
        suggestion_id: `entity:subject_listing:${sourceKey}`,
        entity_type: "subject_listing",
        source_key: sourceKey,
        ordinal,
        values,
        ...sourceMetadata(completion, `subject.activity_history.${sourceIndex}`),
        data_quality_flags: Array.isArray(row.data_quality_flags)
          ? row.data_quality_flags.slice(0, 25)
          : [],
        requires_additional_review: Boolean(row.requires_additional_review),
      };
    });

  if (entities.length) {
    addField(fields, field(
      "subject_listing_summary:0900.0004",
      true,
      completion,
      "subject.activity_history",
    ));
    const days = entities.map((entity) => entity.values["subject_listing:0900.0007"]);
    if (days.every((value) => Number.isInteger(value))) {
      addField(fields, field(
        "subject_listing_summary:0900.0003",
        days.reduce((sum, value) => sum + value, 0),
        completion,
        "subject.activity_history",
      ));
    }
    addField(fields, field(
      "subject_listing_commentary:0900.0020",
      text(
        `The immutable Custom Appraisal snapshot contains ${entities.length} current or relevant subject listing record${entities.length === 1 ? "" : "s"} for appraiser review.`,
        5_000,
      ),
      completion,
      "subject.activity_history",
    ));
  }
  return { fields, entities };
}

function contractAnalysisCommentary(contract) {
  const parts = [
    text(contract.seller_names, 1_000) ? `Contract seller(s): ${text(contract.seller_names, 1_000)}.` : null,
    contract.seller_matches_public_records === true
      ? "The contract seller matches the public-record owner identified in the Custom Appraisal."
      : contract.seller_matches_public_records === false
        ? "The contract seller does not match the public-record owner identified in the Custom Appraisal."
        : null,
    text(contract.seller_mismatch_explanation, 3_000),
    number(contract.loan_amount) !== null ? `Reported loan amount: ${number(contract.loan_amount)}.` : null,
    number(contract.down_payment) !== null ? `Reported down payment: ${number(contract.down_payment)}.` : null,
    number(contract.earnest_money) !== null ? `Reported earnest money: ${number(contract.earnest_money)}.` : null,
  ].filter(Boolean);
  return text(parts.join(" "), 5_000);
}

function buildSalesContractSuggestions(completion, omissions) {
  const fields = [];
  const contract = completion.assignment?.contract || {};
  if (typeof contract.exists !== "boolean") return { fields };

  addField(fields, field(
    "sales_contract:0600.0016",
    contract.exists,
    completion,
    "assignment.contract.exists",
  ));
  if (!contract.exists) return { fields };

  addField(fields, field(
    "sales_contract:0600.0002",
    typeof contract.arms_length === "boolean" ? contract.arms_length : null,
    completion,
    "assignment.contract.arms_length",
  ));
  addField(fields, field(
    "sales_contract:0600.0008",
    validCurrency(contract.contract_price, { minimum: 0.01 }),
    completion,
    "assignment.contract.contract_price",
  ));
  addField(fields, field(
    "sales_contract:0600.0009",
    isoDate(contract.contract_date),
    completion,
    "assignment.contract.contract_date",
  ));

  const concessions = validCurrency(contract.seller_concessions);
  if (concessions !== null) {
    addField(fields, field(
      "sales_contract:0600.0006",
      concessions > 0,
      completion,
      "assignment.contract.seller_concessions",
    ));
    if (concessions > 0) {
      addField(fields, field(
        "sales_contract:0600.0005",
        true,
        completion,
        "assignment.contract.seller_concessions",
      ));
      addField(fields, field(
        "sales_contract:0600.0011",
        concessions,
        completion,
        "assignment.contract.seller_concessions",
      ));
    }
  }
  addField(fields, field(
    "sales_contract_commentary:0600.0014",
    contractAnalysisCommentary(contract),
    completion,
    "assignment.contract",
  ));

  addOmission(omissions, {
    scope: "sales_contract",
    code: "sales_contract_review_requires_appraiser_selection",
    target_field_key: "sales_contract:0600.0010",
  });
  addOmission(omissions, {
    scope: "sales_contract",
    code: "sales_contract_transfer_terms_require_appraiser_selection",
    target_field_key: "sales_contract:0600.0017",
  });
  return { fields };
}

function priorTransferDataSource(row) {
  const source = String(row.source || "");
  if (/\bmls\b/i.test(source) || activityIsMls(row)) return { type: "MLS", other: null };
  if (/\b(deed|cad|assessor)\b/i.test(source) || normalizedToken(row.record_type) === "cad_transfer") {
    return { type: "Deed", other: null };
  }
  if (/aggregator/i.test(source)) return { type: "DataAggregator", other: null };
  return { type: "Other", other: text(source || "Custom Appraisal activity record", 66) };
}

function buildPriorTransferSuggestions(completion, omissions) {
  const fields = [];
  const effectiveDate = isoDate(completion.assignment_scope?.effective_date);
  const entities = activityRows(completion)
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter(({ row }) => ["closed_sale", "cad_transfer"].includes(normalizedToken(row.record_type)))
    .filter(({ row }) => {
      const transferDate = isoDate(row.closing_date || row.activity_date);
      return transferDate && (!effectiveDate || transferDate < effectiveDate);
    })
    .slice(0, 12)
    .map(({ row, sourceIndex }, index) => {
      const ordinal = index + 1;
      const sourceKey = activitySourceKey(row, ordinal);
      const isDeedOnly = normalizedToken(row.record_type) === "cad_transfer";
      const amount = validCurrency(row.sale_price);
      const dataSource = priorTransferDataSource(row);
      const values = {
        "subject_prior_transfer:0800.0018": isDeedOnly ? "DeedTransferOnly" : "Sale",
        "subject_prior_transfer:0800.0011": isoDate(row.closing_date || row.activity_date),
        ...(amount !== null
          ? { "subject_prior_transfer:0800.0012": amount }
          : { "subject_prior_transfer:0800.0009": "NotRecorded" }),
      };
      if (!isDeedOnly) {
        addOmission(omissions, {
          scope: `subject_prior_transfer:${sourceKey}`,
          code: "subject_prior_transfer_sale_type_requires_appraiser_selection",
          target_field_key: "subject_prior_transfer:0800.0013",
        });
      }
      return {
        suggestion_id: `entity:subject_prior_transfer:${sourceKey}`,
        entity_type: "subject_prior_transfer",
        source_key: sourceKey,
        ordinal,
        values,
        related_entities: [{
          entity_type: "subject_prior_transfer_data_source",
          ordinal: 1,
          values: {
            "subject_prior_transfer_data_source:0700.0125": dataSource.type,
            ...(dataSource.other
              ? { "subject_prior_transfer_data_source:0700.0126": dataSource.other }
              : {}),
          },
          ...sourceMetadata(completion, `subject.activity_history.${sourceIndex}`),
        }],
        ...sourceMetadata(completion, `subject.activity_history.${sourceIndex}`),
        data_quality_flags: Array.isArray(row.data_quality_flags)
          ? row.data_quality_flags.slice(0, 25)
          : [],
        requires_additional_review: Boolean(row.requires_additional_review),
      };
    });

  if (entities.length) {
    addField(fields, field(
      "subject_prior_transfer_summary:0800.0005",
      true,
      completion,
      "subject.activity_history",
    ));
    addField(fields, field(
      "subject_prior_transfer_commentary:1600.0008",
      text(
        `The immutable Custom Appraisal snapshot contains ${entities.length} prior subject sale or transfer record${entities.length === 1 ? "" : "s"} for appraiser reconciliation.`,
        5_000,
      ),
      completion,
      "subject.activity_history",
    ));
  }
  return { fields, entities };
}

function demandSupply(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "shortage") return "Shortage";
  if (["inbalance", "balanced", "balance"].includes(normalized)) return "InBalance";
  if (["oversupply", "oversupplied"].includes(normalized)) return "OverSupply";
  return null;
}

function marketingTime(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("under3") || normalized.includes("underthree")) return "UnderThreeMonths";
  if (normalized.includes("3to6") || normalized.includes("threetosix")) return "ThreeToSixMonths";
  if (normalized.includes("over6") || normalized.includes("oversix")) return "OverSixMonths";
  return null;
}

function buildMarketSuggestions(completion, omissions) {
  const fields = [];
  const entities = [];
  const neighborhood = completion.analyses?.neighborhood || {};
  const market = completion.analyses?.market_conditions || {};
  const boundary = boundaryDescription(neighborhood.boundary);
  addField(fields, field(
    "market:3000.0008",
    boundary,
    completion,
    "analyses.neighborhood.boundary",
    { confidence: neighborhood.boundary?.confirmed ? "confirmed" : "review_required" },
  ));

  const study = preferredMarketStudy(market.studies);
  const periodMonths = integer(market.period_months, 1, 99);
  const studyLabel = text(study?.market?.label || study?.market?.key, 120);
  const periodStart = isoDate(study?.period?.start);
  const periodEnd = isoDate(study?.period?.end);
  const criteria = [
    studyLabel,
    periodStart && periodEnd ? `${periodStart} through ${periodEnd}` : null,
    periodMonths ? `${periodMonths} complete-month lookback` : null,
  ].filter(Boolean).join("; ");
  addField(fields, field("market:3000.0010", text(criteria, 1_250), completion, "analyses.market_conditions.studies"));
  addField(fields, field("market:3000.0009", periodMonths, completion, "analyses.market_conditions.period_months"));

  const saleCountValue = number(study?.population?.eligible_sale_count ?? study?.summary?.sale_count);
  const saleCount = integer(saleCountValue, 0, 999);
  if (saleCountValue !== null && saleCount === null) {
    addOmission(omissions, {
      scope: "market",
      code: "market_sale_count_outside_uad_bounds",
      source_value: saleCountValue,
      target_field_key: "market_total_sales:3000.0026",
    });
  }
  addField(fields, field("market_total_sales:3000.0026", saleCount, completion, "analyses.market_conditions.studies.population"));

  const medianSalePrice = number(study?.summary?.median_sale_price);
  addField(fields, field(
    "market_total_sales:3000.0029",
    medianSalePrice !== null && medianSalePrice > 0 && medianSalePrice <= 999_999_999.99
      ? medianSalePrice
      : null,
    completion,
    "analyses.market_conditions.studies.summary.median_sale_price",
  ));

  addField(fields, field(
    "market:3000.0033",
    demandSupply(neighborhood.profile?.demand_supply),
    completion,
    "analyses.neighborhood.profile.demand_supply",
  ));
  addField(fields, field(
    "market:3000.0031",
    marketingTime(neighborhood.profile?.marketing_time),
    completion,
    "analyses.neighborhood.profile.marketing_time",
  ));

  const trend = text(market.reconciliation?.trendConclusion, 80);
  const explanation = text(market.reconciliation?.explanation, 2_300);
  const commentary = [
    trend ? `Market trend conclusion: ${trend}.` : null,
    explanation,
  ].filter(Boolean).join(" ");
  addField(fields, field(
    "market_price_trend_commentary:3000.0040",
    text(commentary, 2_500),
    completion,
    "analyses.market_conditions.reconciliation",
  ));
  if (studyLabel) {
    entities.push({
      suggestion_id: "entity:market_price_trend_source:primary",
      entity_type: "market_price_trend_source",
      ordinal: 1,
      values: {
        "market_price_trend_source:3000.0051": text(`HomeNode ${studyLabel}`, 33),
      },
      ...sourceMetadata(completion, "analyses.market_conditions.studies.0"),
    });
  }

  return { fields, entities };
}

function attachmentType(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("detached")) return "Detached";
  if (normalized.includes("attached")) return "Attached";
  return null;
}

function exactRating(value, pattern) {
  const normalized = String(value || "").trim().toUpperCase();
  return pattern.test(normalized) ? normalized : null;
}

function comparableSourceKey(sale, ordinal) {
  return text(
    sale?.source_record_id
      || sale?.listing_key
      || sale?.listing_id
      || sale?.sale_id
      || sale?.primary_account_id
      || `ordinal-${ordinal}`,
    120,
  );
}

function finiteAdjustment(value) {
  const parsed = number(value);
  return parsed !== null && Math.abs(parsed) <= 999_999_999 ? parsed : null;
}

function buildComparableSuggestions(completion, omissions) {
  const sales = completion.analyses?.comparable_sales || {};
  const fields = [];
  const entities = [];
  const comparables = Array.isArray(sales.primary_comparables)
    ? sales.primary_comparables.slice(0, 12)
    : [];

  if (comparables.length) {
    addField(fields, field(
      "sales_comparison_scope:1000.0032",
      true,
      completion,
      "analyses.comparable_sales.primary_comparables",
    ));
  }
  const indicated = number(sales.indicated_value);
  addField(fields, field(
    "sales_comparison_summary:1300.0006",
    indicated !== null && indicated > 0 && indicated <= 999_999_999 ? indicated : null,
    completion,
    "analyses.comparable_sales.indicated_value",
  ));
  const reconciliation = [
    text(sales.sales_notes, 7_000),
    text(sales.adjustment_notes, 3_000),
  ].filter(Boolean).join("\n\n");
  addField(fields, field(
    "sales_comparison_reconciliation:1800.0278",
    text(reconciliation, 10_000),
    completion,
    "analyses.comparable_sales.notes",
  ));

  const subjectCondition = exactRating(completion.subject?.characteristics?.condition_rating, UAD_CONDITION);
  const subjectQuality = exactRating(completion.subject?.characteristics?.quality_rating, UAD_QUALITY);
  addField(fields, field("subject:1600.0006", subjectCondition, completion, "subject.characteristics.condition_rating"));
  addField(fields, field("subject:1600.0007", subjectQuality, completion, "subject.characteristics.quality_rating"));

  comparables.forEach((comparable, index) => {
    const sale = plainObject(comparable?.sale) ? comparable.sale : {};
    const ordinal = index + 1;
    const sourceKey = comparableSourceKey(sale, ordinal);
    const values = {
      "sales_comparable:1800.0192": ordinal,
    };
    const setValue = (key, value) => {
      if (value !== null && value !== undefined && value !== "") values[key] = value;
    };

    setValue("sales_comparable_address:1800.0001", text(sale.address, 100));
    setValue("sales_comparable_address:1800.0003", text(sale.city, 50));
    setValue("sales_comparable_address:1800.0005", text(sale.state, 2)?.toUpperCase());
    setValue("sales_comparable_address:1800.0004", text(sale.zip || sale.postal_code, 10));
    const distance = number(sale.distanceMiles ?? sale.distance_miles);
    if (distance !== null && distance >= 0 && distance <= 999.99) {
      setValue("sales_comparable_proximity:1800.0065", { amount: distance, unit: "Miles" });
    }
    setValue("sales_comparable_listing:1800.0075", "SettledSale");
    const salePrice = number(sale.sale_price);
    if (salePrice !== null && salePrice >= 0 && salePrice <= 999_999_999.99) {
      setValue("sales_comparable_sale:1800.0272", salePrice);
    }
    setValue("sales_comparable_sale:1800.0342", isoDate(sale.closing_date));
    setValue("sales_comparable_listing:1800.0189", integer(sale.days_on_market, 0, 9_999));
    setValue(
      "sales_comparable_property:1800.0195",
      attachmentType(sale.attachment_type || sale.comparableHousingType || sale.housing_type),
    );

    const condition = exactRating(comparable.condition, UAD_CONDITION);
    const quality = exactRating(comparable.quality, UAD_QUALITY);
    setValue("sales_comparable_property:1800.0196", condition);
    setValue("sales_comparable_property:1800.0197", quality);
    if (text(comparable.condition, 20) && !condition) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "condition_range_requires_appraiser_reconciliation",
        source_value: text(comparable.condition, 20),
        target_field_key: "sales_comparable_property:1800.0196",
      });
    }
    if (text(comparable.quality, 20) && !quality) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "quality_range_requires_appraiser_reconciliation",
        source_value: text(comparable.quality, 20),
        target_field_key: "sales_comparable_property:1800.0197",
      });
    }

    const adjustments = plainObject(comparable.adjustments) ? comparable.adjustments : {};
    const mappedAdjustments = [
      ["time", "sales_comparable_adjustment_sale_date:1800.0317"],
      ["livingArea", "sales_comparable_adjustment_standard_above:1800.0317"],
      ["garage", "sales_comparable_adjustment_vehicle_storage:1800.0317"],
      ["pool", "sales_comparable_adjustment_water_features_amenity:1800.0317"],
      ["siteSize", "sales_comparable_adjustment_site_size:1800.0317"],
      ["age", "sales_comparable_adjustment_year_built:1800.0317"],
      ["condition", "sales_comparable_adjustment_overall_condition:1800.0317"],
      ["quality", "sales_comparable_adjustment_overall_quality:1800.0317"],
    ];
    mappedAdjustments.forEach(([sourceName, targetKey]) => {
      const adjustment = finiteAdjustment(adjustments[sourceName]);
      if (adjustment !== null) setValue(targetKey, adjustment);
    });
    const concession = finiteAdjustment(adjustments.concessions);
    if (concession !== null) {
      setValue(
        "sales_comparable_adjustment_concessions:1800.0317",
        concession > 0 ? -concession : concession,
      );
    }
    if (finiteAdjustment(adjustments.roomCount)) {
      addOmission(omissions, {
        scope: `comparable:${sourceKey}`,
        code: "combined_room_count_adjustment_requires_split",
        source_value: finiteAdjustment(adjustments.roomCount),
        target_field_keys: [
          "sales_comparable_adjustment_bedrooms:1800.0317",
          "sales_comparable_adjustment_bathrooms:1800.0317",
        ],
      });
    }

    const relatedEntities = [];
    const listingId = text(sale.listing_id || sale.listing_key, 45);
    if (listingId || text(sale.source, 45)) {
      relatedEntities.push({
        entity_type: "sales_comparable_data_source",
        ordinal: 1,
        values: {
          "sales_comparable_data_source:0700.0125": "MLS",
          ...(listingId ? { "sales_comparable_data_source:1800.0347": listingId } : {}),
        },
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    }

    const dwellingValues = {};
    const yearBuilt = integer(
      sale.comparableYearBuilt ?? sale.cad_year_built ?? sale.mls_year_built,
      1000,
      2100,
    );
    if (yearBuilt !== null) {
      dwellingValues["sales_comparable_dwelling:1800.0128"] = String(yearBuilt);
    }
    const unitValues = {};
    const livingArea = number(sale.cad_living_area_sqft ?? sale.mls_living_area ?? sale.comparable_square_feet);
    if (livingArea !== null && livingArea > 0 && livingArea <= 999_999) {
      unitValues["sales_comparable_unit:1800.0390"] = { amount: livingArea, unit: "SquareFeet" };
    }
    const bedrooms = integer(sale.cad_bedroom_count ?? sale.mls_bedrooms_total, 0, 99);
    const fullBaths = integer(sale.cad_baths_full ?? sale.mls_bathrooms_full, 0, 99);
    const halfBaths = integer(sale.cad_baths_half ?? sale.mls_bathrooms_half, 0, 99);
    if (bedrooms !== null) unitValues["sales_comparable_unit:1800.0330"] = bedrooms;
    if (fullBaths !== null) unitValues["sales_comparable_unit:1800.0331"] = fullBaths;
    if (halfBaths !== null) unitValues["sales_comparable_unit:1800.0332"] = halfBaths;
    if (Object.keys(unitValues).length) {
      dwellingValues["sales_comparable_dwelling:1800.0368"] = 1;
      relatedEntities.push({
        entity_type: "sales_comparable_dwelling",
        ordinal: 1,
        values: dwellingValues,
        related_entities: [{
          entity_type: "sales_comparable_unit",
          ordinal: 1,
          values: unitValues,
          ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
        }],
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    } else if (Object.keys(dwellingValues).length) {
      relatedEntities.push({
        entity_type: "sales_comparable_dwelling",
        ordinal: 1,
        values: dwellingValues,
        ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}.sale`),
      });
    }

    const siteSize = number(sale.comparableSiteSize ?? sale.comparable_site_size);
    if (siteSize !== null && siteSize > 0 && siteSize <= 999_999_999) {
      setValue("sales_comparable_site:1800.0239", { amount: siteSize, unit: "SquareFeet" });
    }

    entities.push({
      suggestion_id: `entity:sales_comparable:${sourceKey}`,
      entity_type: "sales_comparable",
      source_key: sourceKey,
      ordinal,
      values,
      related_entities: relatedEntities,
      ...sourceMetadata(completion, `analyses.comparable_sales.primary_comparables.${index}`),
      data_quality_flags: Array.isArray(sale.data_quality_flags)
        ? sale.data_quality_flags.slice(0, 25)
        : [],
      requires_additional_review: Boolean(sale.requires_additional_review),
    });
  });

  return { fields, entities };
}

export function buildUadCompletionSuggestions(completion) {
  if (!plainObject(completion) || completion.schema_version !== 1) {
    throw new Error("unsupported_appraisal_completion_schema");
  }
  if (completion.target?.workflow_type !== "uad_3_6") {
    throw new Error("uad_completion_target_required");
  }
  if (
    !completion.source?.report_file_id
    || !completion.assignment_scope?.appraisal_case_id
    || !completion.assignment_scope?.subject_snapshot_id
    || !completion.provenance?.source_digest_sha256
  ) {
    throw new Error("invalid_appraisal_completion_provenance");
  }

  const omissions = [];
  const assignment = buildAssignmentSuggestions(completion, omissions);
  const subject = buildSubjectEntitySuggestions(completion, omissions);
  const highestBestUse = buildHighestBestUseSuggestions(completion, omissions);
  const subjectListings = buildSubjectListingSuggestions(completion, omissions);
  const salesContract = buildSalesContractSuggestions(completion, omissions);
  const priorTransfers = buildPriorTransferSuggestions(completion, omissions);
  const market = buildMarketSuggestions(completion, omissions);
  const sales = buildComparableSuggestions(completion, omissions);
  return {
    schema_version: UAD_COMPLETION_SUGGESTION_SCHEMA_VERSION,
    adapter_version: UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
    source_completion: {
      schema_version: completion.schema_version,
      adapter_version: completion.adapter_version,
      source_report_file_id: completion.source.report_file_id,
      target_report_file_id: completion.target.report_file_id,
      appraisal_case_id: completion.assignment_scope.appraisal_case_id,
      subject_snapshot_id: completion.assignment_scope.subject_snapshot_id,
      source_digest_sha256: completion.provenance.source_digest_sha256,
    },
    status: completion.readiness?.status === "complete" ? "ready_for_review" : "source_review_required",
    source_readiness: completion.readiness || { status: "review_required", blockers: [], warnings: [] },
    suggestions: {
      assignment_fields: assignment.fields,
      subject_entity_fields: subject.fields,
      highest_best_use_fields: highestBestUse.fields,
      subject_listing_fields: subjectListings.fields,
      subject_listing_entities: subjectListings.entities,
      sales_contract_fields: salesContract.fields,
      subject_prior_transfer_fields: priorTransfers.fields,
      subject_prior_transfer_entities: priorTransfers.entities,
      market_fields: market.fields,
      market_entities: market.entities,
      sales_comparison_fields: sales.fields,
      sales_comparable_entities: sales.entities,
    },
    omissions,
    counts: {
      field_suggestions: assignment.fields.length + subject.fields.length
        + highestBestUse.fields.length + subjectListings.fields.length
        + salesContract.fields.length + priorTransfers.fields.length
        + market.fields.length + sales.fields.length,
      entity_suggestions: subjectListings.entities.length + priorTransfers.entities.length
        + market.entities.length + sales.entities.length,
      omissions: omissions.length,
    },
    apply_mode: "review_only",
    requires_appraiser_confirmation: true,
  };
}

export async function loadUadCompletionSuggestions(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const result = await pool.query(
    `SELECT id, account_id
       FROM app.report_files
      WHERE uad_workfile_id = $1
        AND workflow_type = 'uad_3_6'
      ORDER BY is_current DESC, updated_at DESC
      LIMIT 1`,
    [workfileId],
  );
  if (!result.rows.length) throw new Error("uad_completion_report_file_not_registered");
  const reportFile = result.rows[0];
  const completion = await loadSharedAppraisalCompletion(pool, {
    accountId: reportFile.account_id,
    reportFileId: reportFile.id,
  });
  return buildUadCompletionSuggestions(completion);
}
