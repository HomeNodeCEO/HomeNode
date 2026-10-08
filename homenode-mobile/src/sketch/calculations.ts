import { buildSketchCalculationBreakdown } from "./calculationBreakdown.js";
import { calculateSketchOutline, toSketchApiDocument, type ManualSketchDraft } from "./model";

export function sketchCalculationBreakdown(draft: ManualSketchDraft) {
  const document = toSketchApiDocument(draft);
  return buildSketchCalculationBreakdown({
    areas: document.areas.map(area => {
      const calculation = calculateSketchOutline(area.vertices);
      return {
        ...area,
        calculation: {
          ready_for_area_classification: calculation.ready,
          calculated_area_sqft: calculation.calculatedAreaSqft,
          reported_area_sqft: calculation.reportedAreaSqft,
        },
      };
    }),
  });
}
