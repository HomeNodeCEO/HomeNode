import { buildSketchCalculationBreakdown } from "./calculationBreakdown.js";
import { calculateManualSketch } from "./manualSketch.js";

// Derived evidence only: never rewrite the retained document, request hash,
// optimistic revision, reviewed UAD conclusions, or a signed exhibit.
export function sketchCalculationBreakdown(document) {
  return buildSketchCalculationBreakdown({
    areas: (document?.areas || []).map(area => {
      let calculation;
      try { calculation = calculateManualSketch({ vertices: area.vertices }); }
      catch { calculation = { ready_for_area_classification: false }; }
      return { ...area, vertices: calculation.vertices || area.vertices, calculation };
    }),
  });
}
