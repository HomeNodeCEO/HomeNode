// Pure calculation engine. The server and native copies are byte-identical;
// parity tests prevent drift while keeping each deployable package standalone.
const MAX_SECTIONS = 256;
const EPSILON = 1e-8;

export function calculationNumber(value, digits = 6) {
  return Number(Number(value).toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits, useGrouping: false });
}

function roundArea(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function sectionLabel(index) {
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  }
  return result;
}
function atY(edge, y) {
  return edge.from.x + ((y - edge.from.y) * (edge.to.x - edge.from.x) / (edge.to.y - edge.from.y));
}

function sectionsFor(vertices) {
  const levels = [...new Set(vertices.map(point => point.y))].sort((a, b) => a - b);
  const edges = vertices.slice(0, -1).map((from, index) => ({ from, to: vertices[index + 1] }));
  const sections = [];
  for (let index = 0; index < levels.length - 1; index++) {
    const bottom = levels[index];
    const top = levels[index + 1];
    const height = top - bottom;
    if (height <= EPSILON) continue;
    const middle = bottom + (height / 2);
    const crossings = edges.filter(edge => middle > Math.min(edge.from.y, edge.to.y)
      && middle < Math.max(edge.from.y, edge.to.y)).sort((a, b) => atY(a, middle) - atY(b, middle));
    if (crossings.length % 2 !== 0) return null;
    for (let crossing = 0; crossing < crossings.length; crossing += 2) {
      const left = crossings[crossing];
      const right = crossings[crossing + 1];
      const leftBottom = atY(left, bottom);
      const rightBottom = atY(right, bottom);
      const leftTop = atY(left, top);
      const rightTop = atY(right, top);
      const bottomWidth = Math.max(0, rightBottom - leftBottom);
      const topWidth = Math.max(0, rightTop - leftTop);
      const squareFeet = ((bottomWidth + topWidth) / 2) * height;
      if (squareFeet <= EPSILON) continue;
      const rectangular = Math.abs(leftBottom - leftTop) <= EPSILON && Math.abs(rightBottom - rightTop) <= EPSILON;
      const previous = rectangular ? sections.find(section => section.shape === "rectangle"
        && Math.abs(section.vertices[2].y - bottom) <= EPSILON
        && Math.abs(section.vertices[0].x - leftBottom) <= EPSILON
        && Math.abs(section.vertices[1].x - rightBottom) <= EPSILON) : null;
      if (previous) {
        previous.vertices[2].y = top;
        previous.vertices[3].y = top;
        previous.height_feet += height;
        previous.calculated_area_sqft += squareFeet;
      } else {
        if (sections.length >= MAX_SECTIONS) return null;
        sections.push({
          shape: rectangular ? "rectangle" : bottomWidth <= EPSILON || topWidth <= EPSILON ? "triangle" : "trapezoid",
          vertices: [{ x: leftBottom, y: bottom }, { x: rightBottom, y: bottom }, { x: rightTop, y: top }, { x: leftTop, y: top }],
          bottom_width_feet: bottomWidth,
          top_width_feet: topWidth,
          height_feet: height,
          calculated_area_sqft: squareFeet,
        });
      }
    }
  }
  return sections.map((section, index) => ({
    ...section,
    label: sectionLabel(index),
    formula: section.shape === "rectangle"
      ? `${calculationNumber(section.bottom_width_feet)} x ${calculationNumber(section.height_feet)}`
      : section.shape === "triangle"
        ? `${calculationNumber(Math.max(section.bottom_width_feet, section.top_width_feet))} x ${calculationNumber(section.height_feet)} / 2`
        : `(${calculationNumber(section.bottom_width_feet)} + ${calculationNumber(section.top_width_feet)}) / 2 x ${calculationNumber(section.height_feet)}`,
  }));
}

function areaBreakdown(area) {
  const calculation = area.calculation || {};
  const result = {
    area_id: area.id,
    label: area.label,
    level_label: area.level_label,
    classification: area.classification,
    gla_treatment: area.gla_treatment || (area.classification === "above_grade_finished" ? "included" : "excluded"),
    parent_area_id: area.parent_area_id || null,
    status: "pending",
    reason: "Close a non-crossing outline to calculate its sections.",
    calculated_area_sqft: calculation.calculated_area_sqft ?? null,
    reported_area_sqft: calculation.reported_area_sqft ?? null,
    section_sum_sqft: null,
    displayed_row_rounding_difference_sqft: 0,
    sections: [],
    angled_walls: [],
  };
  if (!calculation.ready_for_area_classification) return result;
  if (!Array.isArray(area.vertices) || area.vertices.length < 4 || area.vertices.length > 500
    || area.vertices.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000)) {
    return { ...result, status: "unavailable", reason: "The saved outline cannot be decomposed safely." };
  }
  const vertices = [...area.vertices.slice(0, -1), { ...area.vertices[0] }];
  const sections = sectionsFor(vertices);
  const sum = sections?.reduce((total, section) => total + section.calculated_area_sqft, 0);
  if (!sections?.length || sum == null || !Number.isFinite(sum)
    || !Number.isFinite(result.calculated_area_sqft) || Math.abs(roundArea(sum) - result.calculated_area_sqft) > 0.011) {
    return { ...result, status: "unavailable", reason: "Section breakdown is too complex or does not reconcile. The saved area is retained." };
  }
  const angledWalls = vertices.slice(0, -1).flatMap((from, index) => {
    const to = vertices[index + 1];
    const horizontal = to.x - from.x;
    const vertical = to.y - from.y;
    if (Math.abs(horizontal) <= EPSILON || Math.abs(vertical) <= EPSILON) return [];
    const length = Math.hypot(horizontal, vertical);
    const bearing = (Math.atan2(vertical, horizontal) * 180 / Math.PI + 360) % 360;
    return [{
      wall_index: index + 1,
      length_feet: length,
      bearing_degrees: bearing,
      horizontal_feet: horizontal,
      vertical_feet: vertical,
      formula: `${calculationNumber(length)} ft at ${calculationNumber(bearing)} degrees: horizontal ${calculationNumber(horizontal)} ft; vertical ${calculationNumber(vertical)} ft`,
    }];
  });
  return {
    ...result,
    status: "ready",
    reason: null,
    sections,
    angled_walls: angledWalls,
    section_sum_sqft: sum,
    displayed_row_rounding_difference_sqft: roundArea(sections.reduce((total, section) => total + roundArea(section.calculated_area_sqft), 0) - result.calculated_area_sqft),
  };
}

export function buildSketchCalculationBreakdown(document) {
  const areas = (Array.isArray(document?.areas) ? document.areas.slice(0, 20) : []).map(areaBreakdown);
  const byClassification = Object.create(null);
  const levels = new Map();
  const areasById = new Map(areas.map(area => [area.area_id, area]));
  let gross = 0;
  let deduction = 0;
  let grossCalculated = 0;
  let deductionCalculated = 0;
  for (const area of areas) {
    const reported = area.reported_area_sqft || 0;
    const calculated = area.calculated_area_sqft || 0;
    byClassification[area.classification] = (byClassification[area.classification] || 0) + reported;
    const levelLabel = area.gla_treatment === "deduction" ? areasById.get(area.parent_area_id)?.level_label || area.level_label : area.level_label;
    if (!levels.has(levelLabel)) levels.set(levelLabel, { level_label: levelLabel, gross_included_sqft: 0, deduction_sqft: 0, net_gla_sqft: 0 });
    const level = levels.get(levelLabel);
    if (area.gla_treatment === "included") { gross += reported; grossCalculated += calculated; level.gross_included_sqft += reported; }
    if (area.gla_treatment === "deduction") { deduction += reported; deductionCalculated += calculated; level.deduction_sqft += reported; }
  }
  return {
    schema_version: "1.0",
    method: "non_overlapping_horizontal_sections",
    units: "feet",
    precision_note: "Sections use saved vertices in decimal feet and retain full calculation precision. Displayed formulas use up to six decimals; row areas use two. Reported areas keep the existing whole-square-foot rounding for each outline. Classification and ANSI compliance require appraiser review.",
    areas,
    summary: {
      all_breakdowns_ready: areas.length > 0 && areas.every(area => area.status === "ready"),
      gross_included_sqft: gross,
      deduction_sqft: deduction,
      net_gla_sqft: Math.max(0, gross - deduction),
      gross_calculated_sqft: roundArea(grossCalculated),
      deduction_calculated_sqft: roundArea(deductionCalculated),
      net_calculated_sqft: roundArea(Math.max(0, grossCalculated - deductionCalculated)),
      by_classification: byClassification,
      levels: [...levels.values()].map(level => ({ ...level, net_gla_sqft: Math.max(0, level.gross_included_sqft - level.deduction_sqft) })),
    },
  };
}
