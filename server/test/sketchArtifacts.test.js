import assert from "node:assert/strict";
import test from "node:test";

import { normalizeManualSketchDocument } from "../src/modules/mobile/sketches.js";
import { renderSketchPdf, renderSketchSvg } from "../src/modules/mobile/sketchArtifacts.js";

function fixture() {
  return {
    revision: 4,
    updated_at: "2026-08-18T12:00:00.000Z",
    document: normalizeManualSketchDocument({
      measurement_standard: "ansi_z765_2021",
      measurement_method: "exterior",
      review_status: "draft",
      review_notes: "Verify the rear patio classification.",
      areas: [{
        id: "11111111-1111-4111-8111-111111111111",
        label: "Main Level",
        level_label: "Level 1",
        classification: "above_grade_finished",
        position: 1,
        vertices: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 30 },
          { x: 0, y: 30 },
          { x: 0, y: 0 },
        ],
      }],
      rooms: [{
        id: "22222222-2222-4222-8222-222222222222",
        area_id: "11111111-1111-4111-8111-111111111111",
        label: "Living & Dining",
        room_type: "living_room",
        anchor: { x: 20, y: 15 },
        position: 1,
      }],
    }),
  };
}

test("sketch SVG is deterministic, escaped, and dimensioned", () => {
  const sketch = fixture();
  const options = {
    fileNumber: "CA-2026-001",
    propertyLabel: "100 Main & Oak, Dallas, TX",
  };
  const first = renderSketchSvg(sketch, options);
  const second = renderSketchSvg(sketch, options);
  assert.equal(first, second);
  assert.match(first, /CA-2026-001 - Measured Sketch/);
  assert.match(first, /100 Main &amp; Oak/);
  assert.match(first, /Living &amp; Dining/);
  assert.match(first, /40\.0 ft/);
  assert.match(first, /1,200 sf/);
  assert.doesNotMatch(first, /<script/i);
});

test("sketch PDF is a report-ready letter exhibit", async () => {
  const pdf = await renderSketchPdf(fixture(), {
    fileNumber: "CA-2026-001",
    propertyLabel: "100 Main Street, Dallas, TX 75201",
  });
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 2_000);
  assert.equal((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
});
