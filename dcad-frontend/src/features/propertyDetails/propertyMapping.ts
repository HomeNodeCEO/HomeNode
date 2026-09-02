export type EditableProperty = {
  [key: string]: unknown;
  account_number?: string;
  market_value?: number | "";
  taxable_value?: number | "";
  land_value?: number | "";
  improvement_value?: number | "";
  owner_name?: string;
  square_footage?: number | "";
  bedroom_count?: number | "";
  bath_count?: number | "";
  garage_bay_count?: number | "";
  land_acreage?: number | "";
  zoning?: string;
  classification?: string;
  year_built?: number | "";
  effective_year_built?: number | "";
  last_inspection_year?: number | "";
  solar_panels?: boolean;
  functional_obsolescence?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nestedValue(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined);
}

function textOrBlank(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function finiteNumberOrBlank(value: unknown): number | "" {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" && !value.trim()) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : "";
}

export function mapDcadDetailToProperty(
  detail: unknown,
  accountNumber: string,
): EditableProperty {
  return {
    account_number: accountNumber,
    owner_name: textOrBlank(nestedValue(detail, "owner", "name")),
    market_value: finiteNumberOrBlank(nestedValue(detail, "current_year", "market_value")),
    taxable_value: finiteNumberOrBlank(nestedValue(detail, "current_year", "taxable_value")),
    land_value: finiteNumberOrBlank(firstPresent(
      nestedValue(detail, "value_summary", "land_value"),
      nestedValue(detail, "improvements", "land_value"),
    )),
    improvement_value: finiteNumberOrBlank(firstPresent(
      nestedValue(detail, "value_summary", "improvement_value"),
      nestedValue(detail, "improvements", "improvement_value"),
    )),
    square_footage: finiteNumberOrBlank(
      nestedValue(detail, "characteristics", "living_area_sqft"),
    ),
    bedroom_count: finiteNumberOrBlank(nestedValue(detail, "characteristics", "bedrooms")),
    bath_count: finiteNumberOrBlank(nestedValue(detail, "characteristics", "baths")),
    garage_bay_count: finiteNumberOrBlank(
      nestedValue(detail, "characteristics", "garage_bays"),
    ),
    land_acreage: finiteNumberOrBlank(nestedValue(detail, "land", "acreage")),
    zoning: textOrBlank(nestedValue(detail, "zoning")),
    classification: textOrBlank(nestedValue(detail, "classification")),
    year_built: finiteNumberOrBlank(nestedValue(detail, "characteristics", "year_built")),
    effective_year_built: finiteNumberOrBlank(
      nestedValue(detail, "characteristics", "effective_year_built"),
    ),
    last_inspection_year: finiteNumberOrBlank(nestedValue(detail, "inspection", "last_year")),
    solar_panels: Boolean(nestedValue(detail, "features", "solar_panels")),
    functional_obsolescence: Boolean(
      nestedValue(detail, "condition", "functional_obsolescence"),
    ),
  };
}

export function propertyDetailsErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "Import failed";
}
