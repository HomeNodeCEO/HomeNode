import { buildUadPrefillValues, getUadField, normalizeAndValidateUadValue } from "./fieldCatalog.js";

function number(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Land lines describe one parcel, not additional parcels. Never add tax years
// together or report a partial total when a current line has no usable area.
function latestLand(snapshot) {
  const rows = Array.isArray(snapshot?.land_details) ? snapshot.land_details : [];
  if (rows.length > 10000) return [];
  const years = rows.map((row) => number(row?.tax_year)).filter((year) => Number.isInteger(year) && year >= 1000 && year <= 9999);
  if (!years.length) return [];
  const year = Math.max(...years);
  return rows.filter((row) => number(row?.tax_year) === year);
}

function singleEntity(entities, type, identifier, parentId) {
  const candidates = entities.filter((entity) => entity.entity_type === type);
  return candidates.length === 1
    && candidates[0].entity_identifier === identifier
    && (parentId === undefined || candidates[0].parent_entity_id === parentId)
    ? candidates[0] : null;
}

export function uadPrefillValueKey(entityId, contextKey, uid) {
  return `${entityId || "root"}:${contextKey}:${uid}`;
}

// Public-record candidates only: no values from another appraisal, no automatic
// professional opinions, and no conversion of CAD living area into ANSI area.
export function buildUadSubjectPrefillValues(snapshot, entities, existingRows = [], { includeDefaults = false } = {}) {
  const existing = new Map(existingRows.map((row) => [
    uadPrefillValueKey(row.entity_id, row.field_context, row.uad_uid), row.value,
  ]));
  const values = new Map();
  const add = (key, raw, sourceReference, entityId = null, sourceType = "public_record") => {
    const [context, uid] = key.split(":");
    const field = getUadField(context, uid);
    const target = uadPrefillValueKey(entityId, context, uid);
    // Even explicitly cleared values belong to the appraiser. Never refill them.
    if (!field || existing.has(target) || raw === null || raw === undefined || raw === "") return;
    if (field.entityType && !entityId) return;
    if (field.dataType === "integer" && number(raw) === null) return;
    if (["string", "text", "enum", "state", "postal_code", "year"].includes(field.dataType)
      && !["string", "number"].includes(typeof raw)) return;
    const checked = normalizeAndValidateUadValue(field, raw, { allowIncomplete: true });
    if (!checked.error && checked.value !== null) values.set(target, {
      field, value: checked.value, sourceReference, sourceType, entityId,
    });
  };

  for (const item of buildUadPrefillValues(snapshot)) {
    const sourced = item.sourceReference?.startsWith("subject_snapshot.");
    if (sourced || includeDefaults) add(item.field.key, item.value, item.sourceReference, null, sourced ? "homenode" : "calculated");
  }
  const legal = snapshot?.legal_description;
  const legalText = typeof legal?.legal_text === "string" && legal.legal_text.trim()
    ? legal.legal_text : Array.isArray(legal?.legal_lines) && legal.legal_lines.every((line) => typeof line === "string")
      ? legal.legal_lines.filter((line) => line.trim()).join("\n") : null;
  if (legalText) add("subject_legal:0100.0067", legalText, "subject_snapshot.legal_description");
  const attachment = snapshot?.housing_profile?.attachment_type;
  if (typeof attachment === "string") {
    const mapped = { attached: "Attached", detached: "Detached" }[attachment.trim().toLowerCase()];
    if (mapped) add("subject:0100.0020", mapped, "subject_snapshot.housing_profile.attachment_type");
  }

  const property = singleEntity(entities, "property", "subject");
  if (!property) return [...values.values()];
  const dwelling = singleEntity(entities, "dwelling", "dwelling-1", property.id);
  const unit = dwelling && singleEntity(entities, "unit", "unit-1", dwelling.id);
  const parcel = singleEntity(entities, "site_parcel", "site-parcel-1", property.id);
  const improvement = snapshot?.primary_improvements || {};
  if (dwelling) {
    const year = number(improvement.year_built);
    if (Number.isInteger(year) && year >= 1000 && year <= 9999) {
      add("dwelling:0300.0011", String(year), "subject_snapshot.primary_improvements.year_built", dwelling.id);
    }
    const count = number(improvement.number_units);
    if (Number.isInteger(count) && count > 0) add("dwelling:0300.0063", count, "subject_snapshot.primary_improvements.number_units", dwelling.id);
    else if (includeDefaults) add("dwelling:0300.0063", 1, "uad_workfile.traditional_single_family_default", dwelling.id, "calculated");
  }
  // Aggregate CAD room counts must not be assigned to one unit of a multi-unit
  // property, or to an ADU that the appraiser has classified separately.
  const reportedUnits = number(improvement.number_units);
  const currentUnits = existing.get("root:subject:0100.0022");
  const currentAdus = existing.get("root:subject:0100.0019");
  if (unit && reportedUnits === 1 && (currentUnits === undefined || currentUnits === 1)
    && (currentAdus === undefined || currentAdus === 0)
    && existing.get(`${unit.id}:unit:0700.0089`) !== true) {
    for (const [key, source] of [
      ["unit:0700.0118", "bedroom_count"], ["unit:0700.0119", "baths_full"], ["unit:0700.0120", "baths_half"],
    ]) add(key, improvement[source], `subject_snapshot.primary_improvements.${source}`, unit.id);
    // bath_count is intentionally not split: providers use incompatible decimal conventions.
  }
  if (parcel) {
    const parcelNumber = snapshot?.account?.account_id;
    const savedParcelNumber = existing.get(`${parcel.id}:site_parcel:1500.0027`);
    const sameParcel = savedParcelNumber === undefined || savedParcelNumber === parcelNumber;
    if (sameParcel) add("site_parcel:1500.0027", parcelNumber, "subject_snapshot.account.account_id", parcel.id);
    const land = latestLand(snapshot);
    const areas = land.map((line) => number(line.area_sqft));
    const lines = land.map((line) => line.line_number);
    const complete = land.length > 0 && land.length <= 1000 && areas.every((area) => area !== null)
      && lines.every((line) => line !== null && line !== undefined) && new Set(lines.map(String)).size === land.length;
    const amount = complete ? areas.reduce((sum, area) => sum + area, 0) : 0;
    if (sameParcel && Number.isFinite(amount) && amount > 0 && amount <= Number.MAX_SAFE_INTEGER) {
      const reference = `subject_snapshot.land_details:tax_year=${land[0].tax_year}:sum(area_sqft)`;
      add("site_parcel:1500.0022", { amount, unit: "SquareFeet" }, reference, parcel.id);
      const count = existing.get("root:site:1500.0094");
      const savedArea = existing.get(`${parcel.id}:site_parcel:1500.0022`);
      if ((count === undefined || count === 1) && savedArea === undefined) {
        add("site:1500.0093", { amount, unit: "SquareFeet" }, reference);
      }
    }
  }
  return [...values.values()];
}
