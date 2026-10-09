import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeManualSketchDocument } from "../src/modules/mobile/sketches.js";
import { renderSketchPdf } from "../src/modules/mobile/sketchArtifacts.js";

const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../output/pdf");
const outputPath = resolve(outputDirectory, "HomeNode-sketch-calculations-sample.pdf");
const rectangle = (width, height) => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }, { x: 0, y: 0 }];
const area = (id, label, vertices, position, update = {}) => ({ id, label, vertices, position, level_label: "Level 1", classification: "above_grade_finished", gla_treatment: "included", ...update });
const parentId = "11111111-1111-4111-8111-111111111111";
const document = normalizeManualSketchDocument({
  measurement_standard: "ansi_z765_2021",
  measurement_method: "exterior",
  review_status: "draft",
  areas: [
    area(parentId, "First floor", [{ x: 0, y: -4.5 }, { x: 17.2, y: -4.5 }, { x: 17.2, y: 0 }, { x: 46.2, y: 0 }, { x: 46.2, y: 30 }, { x: 41.2, y: 30 }, { x: 41.2, y: 32 }, { x: 23.2, y: 32 }, { x: 23.2, y: 30 }, { x: 0, y: 30 }, { x: 0, y: -4.5 }], 1),
    area("22222222-2222-4222-8222-222222222222", "Garage cutout", rectangle(10, 10), 2, { classification: "garage", gla_treatment: "deduction", parent_area_id: parentId }),
    area("33333333-3333-4333-8333-333333333333", "Second floor", rectangle(20.8, 7.5), 3, { level_label: "Level 2" }),
    area("44444444-4444-4444-8444-444444444444", "Concrete patio", [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 4.5 }, { x: 14, y: 4.5 }, { x: 14, y: 9 }, { x: 0, y: 9 }, { x: 0, y: 0 }], 4, { classification: "patio", gla_treatment: "excluded" }),
    area("55555555-5555-4555-8555-555555555555", "Angled pavilion", [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 17, y: 15 }, { x: 5, y: 15 }, { x: 0, y: 10 }, { x: 0, y: 0 }], 5, { classification: "outbuilding", gla_treatment: "excluded" }),
  ],
  rooms: [],
});
const pdf = await renderSketchPdf({ revision: 3, updated_at: "2026-10-07T12:00:00.000Z", document }, {
  fileNumber: "SAMPLE-003",
  propertyLabel: "Synthetic property - calculation exhibit demonstration",
});
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, pdf);
console.log(outputPath);
