import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sketchCalculationBreakdown } from "../src/modules/mobile/sketchCalculations.js";
import { normalizeManualSketchDocument, sketchResponse } from "../src/modules/mobile/sketches.js";
import { indexAssignmentFileDetails } from "../src/services/assignmentFileDetails.js";
import { renderSketchPdf } from "../src/modules/mobile/sketchArtifacts.js";
import { extractText } from "unpdf";

const ID = "11111111-1111-4111-8111-111111111111";
function area(vertices, update = {}) {
  return { id: ID, label: "First floor", level_label: "Level 1", classification: "above_grade_finished", gla_treatment: "included", vertices, position: 1, ...update };
}
function rectangle(width, height, x = 0, y = 0) {
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y }];
}
function calculation(areas) { return sketchCalculationBreakdown({ areas, rooms: [] }); }

test("standalone server and native calculation engines cannot drift", () => {
  const server = readFileSync(new URL("../src/modules/mobile/calculationBreakdown.js", import.meta.url), "utf8");
  const native = readFileSync(new URL("../../homenode-mobile/src/sketch/calculationBreakdown.js", import.meta.url), "utf8");
  assert.equal(server, native);
});

test("rectangle shows its exact multiplication without changing reported rounding", () => {
  const result = calculation([area(rectangle(25, 15))]);
  assert.equal(result.areas[0].status, "ready");
  assert.equal(result.areas[0].sections.length, 1);
  assert.equal(result.areas[0].sections[0].formula, "25 x 15");
  assert.equal(result.areas[0].sections[0].label, "A");
  assert.equal(result.areas[0].section_sum_sqft, 375);
  assert.equal(result.summary.net_gla_sqft, 375);
});

test("three non-overlapping rectangles reproduce stepped floor dimensions", () => {
  const vertices = [{ x: 0, y: -4.5 }, { x: 17.2, y: -4.5 }, { x: 17.2, y: 0 }, { x: 46.2, y: 0 }, { x: 46.2, y: 30 }, { x: 41.2, y: 30 }, { x: 41.2, y: 32 }, { x: 23.2, y: 32 }, { x: 23.2, y: 30 }, { x: 0, y: 30 }, { x: 0, y: -4.5 }];
  const result = calculation([area(vertices)]).areas[0];
  assert.equal(result.status, "ready");
  assert.deepEqual(result.sections.map(section => section.label), ["A", "B", "C"]);
  assert.deepEqual(result.sections.map(section => Math.round(section.calculated_area_sqft * 100) / 100), [77.4, 1386, 36]);
  assert.equal(result.calculated_area_sqft, 1499.4);
  assert.equal(result.reported_area_sqft, 1499);
});

test("stepped patio remains separate from GLA", () => {
  const patio = area([{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 4.5 }, { x: 14, y: 4.5 }, { x: 14, y: 9 }, { x: 0, y: 9 }, { x: 0, y: 0 }], { classification: "patio", gla_treatment: "excluded", label: "Concrete patio" });
  const result = calculation([patio]);
  assert.equal(result.areas[0].calculated_area_sqft, 135);
  assert.equal(result.areas[0].sections.length, 2);
  assert.equal(result.summary.net_gla_sqft, 0);
  assert.equal(result.summary.by_classification.patio, 135);
});

test("angled corners expose triangle and trapezoid formulas with precise offsets", () => {
  const result = calculation([area([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 8, y: 3 }, { x: 5, y: 6 }, { x: 0, y: 0 }])]).areas[0];
  assert.equal(result.status, "ready");
  assert.ok(result.sections.some(section => section.shape === "trapezoid"));
  assert.ok(result.sections.some(section => section.shape === "triangle"));
  assert.ok(result.angled_walls.length >= 2);
  const wall = result.angled_walls[0];
  assert.equal(wall.horizontal_feet, -2);
  assert.equal(wall.vertical_feet, 3);
  assert.ok(Math.abs(wall.length_feet - Math.sqrt(13)) < 1e-12);
  assert.ok(Math.abs(result.section_sum_sqft - result.calculated_area_sqft) < 0.011);
});

test("garage cutout is counted once as a deduction with separate level totals", () => {
  const parent = area(rectangle(25, 15));
  const garage = area(rectangle(10, 10), { id: "22222222-2222-4222-8222-222222222222", label: "Garage", classification: "garage", gla_treatment: "deduction", parent_area_id: ID, position: 2 });
  const upstairs = area(rectangle(20, 12), { id: "33333333-3333-4333-8333-333333333333", level_label: "Level 2", position: 3 });
  const result = calculation([parent, garage, upstairs]);
  assert.equal(result.summary.gross_included_sqft, 615);
  assert.equal(result.summary.deduction_sqft, 100);
  assert.equal(result.summary.net_gla_sqft, 515);
  assert.equal(result.summary.by_classification.garage, 100);
  assert.deepEqual(result.summary.levels.map(level => level.net_gla_sqft), [275, 240]);
  assert.equal(result.areas[1].parent_area_id, ID);
});

test("per-outline whole-square-foot rounding is retained, not replaced by rounding a grand total", () => {
  const result = calculation([area(rectangle(10.04, 10)), area(rectangle(10.04, 10), { id: "second", position: 2 })]);
  assert.equal(result.summary.net_calculated_sqft, 200.8);
  assert.equal(result.summary.net_gla_sqft, 200);
});

test("a garage deduction follows its linked parent floor, not a mistyped cutout level label", () => {
  const result = calculation([area(rectangle(25, 15)), area(rectangle(10, 10), {
    id: "garage", label: "Garage", level_label: "Different label", classification: "garage", gla_treatment: "deduction", parent_area_id: ID,
  })]);
  assert.equal(result.summary.levels.length, 1);
  assert.equal(result.summary.levels[0].level_label, "Level 1");
  assert.equal(result.summary.levels[0].net_gla_sqft, 275);
  assert.equal(result.areas[1].level_label, "Different label");
});

test("open and crossing outlines remain pending rather than inventing area", () => {
  for (const vertices of [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }]]) {
    const result = calculation([area(vertices)]);
    assert.equal(result.areas[0].status, "pending");
    assert.equal(result.areas[0].calculated_area_sqft, null);
    assert.deepEqual(result.areas[0].sections, []);
    assert.equal(result.summary.all_breakdowns_ready, false);
  }
});

test("bounded section complexity retains the authoritative area without claiming a reconciled breakdown", () => {
  const vertices = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  for (let index = 1; index <= 280; index++) vertices.push({ x: 20 + (index % 2), y: index });
  vertices.push({ x: 0, y: 280 }, { x: 0, y: 0 });
  const result = calculation([area(vertices)]);
  assert.equal(result.areas[0].status, "unavailable");
  assert.ok(result.areas[0].reported_area_sqft > 0);
  assert.equal(result.summary.net_gla_sqft, result.areas[0].reported_area_sqft);
  assert.equal(result.areas[0].sections.length, 0);
});

test("response-only derivation preserves retained documents, review status, revision and request hashes", () => {
  const document = normalizeManualSketchDocument({ areas: [area(rectangle(25, 15))], rooms: [], review_status: "appraiser_confirmed" });
  const snapshot = JSON.stringify(document);
  const response = sketchResponse({ id: "sketch", revision: 7, document, summary: document.summary, review_status: "appraiser_confirmed" });
  assert.equal(response.document, document);
  assert.equal(JSON.stringify(document), snapshot);
  assert.equal(document.calculation_breakdown, undefined);
  assert.equal(document.areas[0].calculation.breakdown, undefined);
  assert.equal(response.revision, 7);
  assert.equal(response.review_status, "appraiser_confirmed");
  assert.equal(response.calculation_breakdown.summary.net_gla_sqft, 375);
});

test("desktop assignment details include the same breakdown in only the matching file", () => {
  const document = normalizeManualSketchDocument({ areas: [area(rectangle(25, 15))], rooms: [] });
  const indexed = indexAssignmentFileDetails({ mobileSketchRows: [{ assignment_file_id: 12, id: "sketch", revision: 2, document, summary: document.summary }] });
  assert.equal(indexed.sketchesByFile.get(12).calculation_breakdown.summary.net_gla_sqft, 375);
  assert.equal(indexed.sketchesByFile.has(13), false);
  assert.equal(indexed.sketchesByFile.get(12).document, document);
});

test("decomposition reconciles independent shoelace areas for deterministic varied polygons", () => {
  let seed = 14731;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let trial = 0; trial < 100; trial++) {
    const count = 5 + trial % 20;
    const vertices = Array.from({ length: count }, (_, index) => {
      const angle = index * 2 * Math.PI / count;
      const radius = 10 + random() * 25;
      return { x: 1000 + Math.cos(angle) * radius, y: -500 + Math.sin(angle) * radius };
    });
    vertices.push({ ...vertices[0] });
    const result = calculation([area(vertices)]).areas[0];
    assert.equal(result.status, "ready", `Trial ${trial}`);
    const signedDouble = vertices.slice(0, -1).reduce((sum, point, index) => sum + point.x * vertices[index + 1].y - vertices[index + 1].x * point.y, 0);
    assert.ok(Math.abs(result.section_sum_sqft - Math.abs(signedDouble) / 2) < 1e-6);
    assert.ok(result.sections.every(section => section.calculated_area_sqft > 0));
    const reversed = calculation([area([...vertices].reverse())]).areas[0];
    assert.equal(reversed.calculated_area_sqft, result.calculated_area_sqft);
    assert.ok(Math.abs(reversed.section_sum_sqft - result.section_sum_sqft) < 1e-7);
  }
});

test("PDF calculation pages paginate complete row formulas and retain the final section and summary", async () => {
  const vertices = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  for (let index = 1; index <= 40; index++) vertices.push({ x: 20 + (index % 2), y: index });
  vertices.push({ x: 0, y: 40 }, { x: 0, y: 0 });
  const document = normalizeManualSketchDocument({ areas: [area(vertices)], rooms: [] });
  const snapshot = JSON.stringify(document);
  const pdf = await renderSketchPdf({ revision: 7, document }, { fileNumber: "CALC-007", propertyLabel: "Synthetic property" });
  const extracted = await extractText(new Uint8Array(pdf), { mergePages: true });
  assert.ok(extracted.totalPages > 3);
  assert.match(extracted.text, /continued/);
  assert.match(extracted.text, /AN trapezoid/);
  assert.match(extracted.text, /Net reported GLA/);
  assert.match(extracted.text, /820/);
  assert.equal(JSON.stringify(document), snapshot);
});
