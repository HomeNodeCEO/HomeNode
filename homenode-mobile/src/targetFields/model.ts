import type { TargetFieldDefinition } from "../api/client";
import type { FieldState, JsonValue } from "../offline/model";

export function editableTargetValue(state: FieldState | null | undefined) {
  if (!state?.exists) return "";
  const value = state.value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    const measurement = value as { amount?: JsonValue; unit?: JsonValue };
    if (measurement.amount !== undefined && measurement.unit !== undefined) {
      return `${measurement.amount} ${measurement.unit}`.trim();
    }
    return JSON.stringify(value);
  }
  return value == null ? "" : String(value);
}

export function targetValueLabel(state: FieldState | null | undefined) {
  const value = editableTargetValue(state);
  return value || "Not recorded";
}

export function targetFieldChange(field: TargetFieldDefinition, rawValue: string): FieldState {
  const raw = rawValue.trim();
  if (!raw) {
    if (field.required) throw new Error(`${field.label} is required and cannot be cleared.`);
    return { exists: false };
  }

  let value: JsonValue = raw;
  if (field.value_type === "boolean") {
    if (!new Set(["true", "false"]).has(raw)) throw new Error(`${field.label} requires Yes or No.`);
    value = raw === "true";
  } else if (["number", "integer", "percentage"].includes(field.value_type)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (field.value_type === "integer" && !Number.isInteger(parsed))) {
      throw new Error(`${field.label} requires a valid ${field.value_type}.`);
    }
    if (field.value_type === "percentage" && (parsed < 0 || parsed > 100)) {
      throw new Error(`${field.label} must be between 0 and 100.`);
    }
    if ((field.minimum !== null && parsed < field.minimum) || (field.maximum !== null && parsed > field.maximum)) {
      throw new Error(`${field.label} is outside the allowed range.`);
    }
    value = parsed;
  } else if (field.value_type === "multi_enum") {
    const selected = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
    if (!selected.length || selected.some((item) => !field.options.includes(item))) {
      throw new Error(`${field.label} contains an unsupported selection.`);
    }
    value = selected;
  } else if (field.value_type === "measurement") {
    const match = raw.match(/^(-?\d+(?:\.\d+)?)\s+(.+)$/);
    const amount = Number(match?.[1]);
    const unit = String(match?.[2] || "").trim();
    if (!match || !Number.isFinite(amount) || !field.units.includes(unit)) {
      throw new Error(`${field.label} requires a number followed by one of: ${field.units.join(", ")}.`);
    }
    value = { amount, unit };
  } else if (field.value_type === "enum") {
    if (!field.options.includes(raw)) throw new Error(`${field.label} contains an unsupported selection.`);
  } else if (field.value_type === "year" && !/^\d{4}$/.test(raw)) {
    throw new Error(`${field.label} requires YYYY.`);
  } else if (field.value_type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${field.label} requires YYYY-MM-DD.`);
  }

  if (field.maximum_length !== null && typeof value === "string" && value.length > field.maximum_length) {
    throw new Error(`${field.label} is too long.`);
  }
  return { exists: true, value };
}
