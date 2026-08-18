import type { CustomAppraisalFieldDefinition } from "../api/client";
import type { FieldState, JsonValue } from "../offline/model";

export function customAppraisalFieldChange(
  field: CustomAppraisalFieldDefinition,
  rawValue: string,
): FieldState {
  const raw = rawValue.trim();
  if (!raw) return { exists: false };
  let value: JsonValue = raw;
  if (field.value_type === "boolean") {
    if (!new Set(["true", "false"]).has(raw)) throw new Error(`${field.label} requires Yes or No.`);
    value = raw === "true";
  }
  if (field.value_type === "number" || field.value_type === "integer") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (field.value_type === "integer" && !Number.isInteger(parsed))) {
      throw new Error(`${field.label} requires a valid ${field.value_type}.`);
    }
    if ((field.minimum !== null && parsed < field.minimum) || (field.maximum !== null && parsed > field.maximum)) {
      throw new Error(`${field.label} is outside the allowed range.`);
    }
    value = parsed;
  }
  if (field.value_type === "condition") value = raw.toUpperCase();
  if (field.maximum_length !== null && typeof value === "string" && value.length > field.maximum_length) {
    throw new Error(`${field.label} is too long.`);
  }
  return { exists: true, value };
}
