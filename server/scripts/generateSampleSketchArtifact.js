import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeManualSketchDocument } from "../src/modules/mobile/sketches.js";
import { renderSketchPdf } from "../src/modules/mobile/sketchArtifacts.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDirectory = resolve(repositoryRoot, "output", "pdf");
const outputPath = resolve(outputDirectory, "HomeNode-manual-sketch-sample.pdf");

const sketch = {
  revision: 7,
  updated_at: "2026-08-18T12:00:00.000Z",
  document: normalizeManualSketchDocument({
    measurement_standard: "ansi_z765_2021",
    measurement_method: "exterior",
    review_status: "appraiser_confirmed",
    review_notes: "Sample exhibit for Phase 7 renderer verification.",
    areas: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "Main Dwelling",
        level_label: "Level 1",
        classification: "above_grade_finished",
        position: 1,
        vertices: [
          { x: 0, y: 0 },
          { x: 42, y: 0 },
          { x: 42, y: 18 },
          { x: 30, y: 18 },
          { x: 30, y: 32 },
          { x: 0, y: 32 },
          { x: 0, y: 0 },
        ],
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        label: "Attached Garage",
        level_label: "Level 1",
        classification: "garage",
        position: 2,
        vertices: [
          { x: 42, y: 0 },
          { x: 62, y: 0 },
          { x: 62, y: 20 },
          { x: 42, y: 20 },
          { x: 42, y: 0 },
        ],
      },
    ],
    rooms: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        area_id: "11111111-1111-4111-8111-111111111111",
        label: "Living Room",
        room_type: "living_room",
        anchor: { x: 12, y: 10 },
        position: 1,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        area_id: "11111111-1111-4111-8111-111111111111",
        label: "Kitchen",
        room_type: "kitchen",
        anchor: { x: 33, y: 9 },
        position: 2,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        area_id: "11111111-1111-4111-8111-111111111111",
        label: "Bedroom 1",
        room_type: "bedroom",
        anchor: { x: 11, y: 25 },
        position: 3,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        area_id: "33333333-3333-4333-8333-333333333333",
        label: "Garage",
        room_type: "garage",
        anchor: { x: 52, y: 10 },
        position: 4,
      },
    ],
  }),
};

await mkdir(outputDirectory, { recursive: true });
const pdf = await renderSketchPdf(sketch, {
  fileNumber: "CA-2026-001",
  propertyLabel: "100 Main Street, Dallas, TX 75201",
});
await writeFile(outputPath, pdf);
console.log(outputPath);
