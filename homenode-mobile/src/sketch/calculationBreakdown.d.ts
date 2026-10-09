export type CalculationPoint = { x: number; y: number };
export type CalculationSection = {
  label: string;
  shape: "rectangle" | "triangle" | "trapezoid";
  vertices: CalculationPoint[];
  bottom_width_feet: number;
  top_width_feet: number;
  height_feet: number;
  calculated_area_sqft: number;
  formula: string;
};
export type CalculationArea = {
  area_id: string;
  label: string;
  level_label: string;
  classification: string;
  gla_treatment: "included" | "excluded" | "deduction";
  parent_area_id: string | null;
  status: "ready" | "pending" | "unavailable";
  reason: string | null;
  calculated_area_sqft: number | null;
  reported_area_sqft: number | null;
  section_sum_sqft: number | null;
  displayed_row_rounding_difference_sqft: number;
  sections: CalculationSection[];
  angled_walls: Array<{
    wall_index: number;
    length_feet: number;
    bearing_degrees: number;
    horizontal_feet: number;
    vertical_feet: number;
    formula: string;
  }>;
};
export type SketchCalculationBreakdown = {
  schema_version: "1.0";
  method: "non_overlapping_horizontal_sections";
  units: "feet";
  precision_note: string;
  areas: CalculationArea[];
  summary: {
    all_breakdowns_ready: boolean;
    gross_included_sqft: number;
    deduction_sqft: number;
    net_gla_sqft: number;
    gross_calculated_sqft: number;
    deduction_calculated_sqft: number;
    net_calculated_sqft: number;
    by_classification: Record<string, number>;
    levels: Array<{ level_label: string; gross_included_sqft: number; deduction_sqft: number; net_gla_sqft: number }>;
  };
};
export function calculationNumber(value: number, digits?: number): string;
export function buildSketchCalculationBreakdown(document: { areas: Array<{
  id: string;
  label: string;
  level_label: string;
  classification: string;
  gla_treatment?: string;
  parent_area_id?: string | null;
  vertices: CalculationPoint[];
  calculation: { ready_for_area_classification: boolean; calculated_area_sqft: number | null; reported_area_sqft: number | null };
}> }): SketchCalculationBreakdown;
