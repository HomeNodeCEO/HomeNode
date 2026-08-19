import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderCustomAppraisalReportPdf } from "../src/services/customAppraisalReportPdf.js";
import { customAppraisalReportFixture } from "../test/fixtures/customAppraisalReportFixture.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, "../..");
const outputDirectory = path.join(repositoryDirectory, "output", "pdf");
const outputPath = path.join(outputDirectory, "custom-appraisal-report-sample.pdf");
const { snapshot, property } = customAppraisalReportFixture();
const content = await renderCustomAppraisalReportPdf({
  snapshot,
  property,
  checksum: "a".repeat(64),
});
await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(outputPath, content);
console.log(JSON.stringify({ output: outputPath, bytes: content.length }));
