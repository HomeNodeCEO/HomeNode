import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { sketchCalculationBreakdown } from "../src/sketch/calculations";
import { appendMeasuredWall, closeSketchOutline, emptySketchDraft, toSketchApiDocument } from "../src/sketch/model";

function rectangle(width: number, height: number) {
  let vertices = appendMeasuredWall([], width, 0);
  vertices = appendMeasuredWall(vertices, height, 90);
  vertices = appendMeasuredWall(vertices, width, 180);
  return closeSketchOutline(vertices);
}

test("offline mobile calculations are derived locally and leave the queued document unchanged", () => {
  const draft = emptySketchDraft("11111111-1111-4111-8111-111111111111");
  const closed = { ...draft, areas: [{ ...draft.areas[0]!, vertices: rectangle(25, 15) }] };
  const before = JSON.stringify(toSketchApiDocument(closed));
  const result = sketchCalculationBreakdown(closed);
  assert.equal(result.summary.net_gla_sqft, 375);
  assert.equal(result.areas[0]!.sections[0]!.formula, "25 x 15");
  assert.equal(JSON.stringify(toSketchApiDocument(closed)), before);
  assert.ok(!before.includes("calculation_breakdown"));
});

test("calculations regenerate after durable draft serialization and wall edits", () => {
  const initial = emptySketchDraft("11111111-1111-4111-8111-111111111111");
  const saved = { ...initial, areas: [{ ...initial.areas[0]!, vertices: rectangle(25, 15) }] };
  const restored = JSON.parse(JSON.stringify(saved));
  assert.deepEqual(sketchCalculationBreakdown(restored), sketchCalculationBreakdown(saved));
  restored.areas[0].vertices = rectangle(30, 15);
  assert.equal(sketchCalculationBreakdown(restored).summary.net_gla_sqft, 450);
  assert.equal(sketchCalculationBreakdown(saved).summary.net_gla_sqft, 375);
});

test("garage deductions and excluded patios keep the existing mobile area treatment", () => {
  const draft = emptySketchDraft("11111111-1111-4111-8111-111111111111");
  const parent = { ...draft.areas[0]!, vertices: rectangle(25, 15) };
  const result = sketchCalculationBreakdown({ ...draft, areas: [parent,
    { ...parent, id: "garage", label: "Garage", vertices: rectangle(10, 10), classification: "garage", glaTreatment: "deduction", parentAreaId: parent.id, position: 2 },
    { ...parent, id: "patio", label: "Patio", vertices: rectangle(10, 5), classification: "patio", glaTreatment: "excluded", position: 3 },
  ] });
  assert.equal(result.summary.net_gla_sqft, 275);
  assert.equal(result.summary.by_classification.patio, 50);
  assert.equal(result.areas[1]!.parent_area_id, parent.id);
});

test("pending open outlines do not gain an invented calculation", () => {
  const draft = emptySketchDraft("11111111-1111-4111-8111-111111111111");
  assert.equal(sketchCalculationBreakdown(draft).areas[0]!.status, "pending");
  assert.equal(sketchCalculationBreakdown(draft).summary.all_breakdowns_ready, false);
});

test("the calculation view uses local geometry, not another API poller or upload queue", () => {
  const panel = readFileSync(new URL("../src/sketch/SketchCalculationsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /sketchCalculationBreakdown\(draft\)/);
  assert.match(panel, /presentationStyle="pageSheet"/);
  assert.match(panel, /onRequestClose/);
  assert.doesNotMatch(panel, /fetch\(|setInterval\(|queueSketchDraft|saveInspectionSketch/);
  const editor = readFileSync(new URL("../src/sketch/SketchEditorPanel.tsx", import.meta.url), "utf8");
  assert.match(editor, /<SketchCalculationsPanel draft=\{draft\}/);
});
