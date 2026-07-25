export const GROUPED_ANALYSIS_BREAKDOWNS = Object.freeze([
  Object.freeze({ key: "city", scope: "city", radiusMiles: null }),
  Object.freeze({ key: "zip", scope: "zip", radiusMiles: null }),
  Object.freeze({ key: "radius_1", scope: "radius", radiusMiles: 1 }),
  Object.freeze({ key: "radius_2", scope: "radius", radiusMiles: 2 }),
  Object.freeze({ key: "radius_3", scope: "radius", radiusMiles: 3 }),
  Object.freeze({ key: "radius_4", scope: "radius", radiusMiles: 4 }),
  Object.freeze({ key: "radius_5", scope: "radius", radiusMiles: 5 }),
]);

const BREAKDOWN_BY_KEY = new Map(
  GROUPED_ANALYSIS_BREAKDOWNS.map((breakdown) => [
    breakdown.key,
    breakdown,
  ]),
);

export function parseGroupedAnalysisBreakdowns(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const keys = rawValues
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!keys.length) {
    return [BREAKDOWN_BY_KEY.get("city")];
  }

  const uniqueKeys = [...new Set(keys)];
  const invalidKey = uniqueKeys.find((key) => !BREAKDOWN_BY_KEY.has(key));
  if (invalidKey) {
    throw new Error("invalid_grouped_analysis_breakdown");
  }

  return uniqueKeys.map((key) => BREAKDOWN_BY_KEY.get(key));
}

