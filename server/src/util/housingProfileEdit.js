import { timingSafeEqual } from "node:crypto";

export const HOUSING_ATTACHMENT_TYPES = new Set([
  "detached",
  "attached",
  "mixed",
  "unknown",
]);

function optionalText(value, maxLength, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new Error(`invalid_${fieldName}`);
  }
  return text;
}

export function editorKeyMatches(providedKey, configuredKey) {
  const provided = Buffer.from(String(providedKey ?? ""), "utf8");
  const configured = Buffer.from(String(configuredKey ?? ""), "utf8");
  if (!provided.length || provided.length !== configured.length) return false;
  return timingSafeEqual(provided, configured);
}

export function normalizeHousingProfileUpdate(input = {}) {
  const housingType = optionalText(input.housing_type, 120, "housing_type");
  if (!housingType) throw new Error("missing_housing_type");

  const attachmentType = String(input.attachment_type ?? "unknown")
    .trim()
    .toLowerCase();
  if (!HOUSING_ATTACHMENT_TYPES.has(attachmentType)) {
    throw new Error("invalid_attachment_type");
  }

  const sourceUrl = optionalText(input.source_url, 1000, "source_url");
  if (sourceUrl) {
    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new Error("invalid_source_url");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("invalid_source_url");
    }
  }

  return {
    structuralStyle: housingType,
    housingType,
    attachmentType,
    architecturalStyle: optionalText(
      input.architectural_style,
      120,
      "architectural_style",
    ),
    sourceUrl,
    sourceRecordReference: optionalText(
      input.source_record_reference,
      200,
      "source_record_reference",
    ),
    notes: optionalText(input.notes, 2000, "notes"),
  };
}
